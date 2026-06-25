/**
 * Fresh-exit warm-open (durable fix for exit-reputation-gated hosts). A host on
 * BGW_WARM_FRESH_EXIT_HOSTS replays its stored login through a FRESH residential exit instead of
 * re-pinning the captured (decaying/burned) one. The relaxation of R3's re-pin is gated by the SAME
 * structural verifier as the re-pin (no fail-open), and the restored state is byte-identical to the
 * pinned path (R4/seal untouched — only the exit policy differs).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWarmOverride } from "../dist/mcp/vault-login.js";
import { GatewayDriveController } from "../dist/mcp/drive-controller.js";
import { hostForcesProxy } from "../dist/verbs/index.js";
import { SecretStore } from "../dist/security/index.js";
import { Allowlist } from "../dist/policy/index.js";

const SUFFIX = "_country-us_session-{id}_lifetime-30m";
const HOST = "www.totalwine.com";
const SESSION = {
  cookies: [{ name: "sid", value: "x".repeat(40), domain: "totalwine.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }],
  origins: [{ origin: "https://www.totalwine.com", localStorage: [{ name: "k", value: "v" }] }],
};
const entryWith = (stickyExitId) => ({ session: SESSION, creds: { username: "u", password: "p".repeat(20) }, ...(stickyExitId ? { stickyExitId } : {}), updatedAt: 1 });
const vaultOf = (entry) => ({ get: () => entry, has: () => !!entry, put() {}, remove: () => false });
const proxySecrets = (env = {}) => new SecretStore(() => ({ BGW_PROXY_URL: "http://proxy.test:8080", BGW_PROXY_USERNAME: "puser", BGW_PROXY_PASSWORD: "ppass", ...env }));
const noProxy = () => new SecretStore(() => ({}));
const warm = (vault, secrets, over) => buildWarmOverride(vault, secrets, { consumerId: "atlas", host: HOST, onDatacenterIp: true, stickySuffix: SUFFIX, ...over });

// --- buildWarmOverride: fresh-exit mints a FRESH exit, ignoring the bound captured id ---
test("freshExit mints a fresh held exit and IGNORES the bound captured stickyExitId", () => {
  const ov = warm(vaultOf(entryWith("deadbeef")), proxySecrets(), { freshExit: true });
  assert.ok(ov?.proxy?.password, "fresh override carries a proxy");
  const m = ov.proxy.password.match(/_session-([0-9a-f]{8})_lifetime-30m$/);
  assert.ok(m, "minted an 8-hex sticky session id");
  assert.notEqual(m[1], "deadbeef", "the fresh id is NOT the bound captured exit");
  assert.equal(ov.proxy.password, "ppass" + SUFFIX.replaceAll("{id}", m[1]), "structural: base password + suffix-with-fresh-id");
  assert.equal(ov.restoreState?.ownerHost, HOST, "cookies restored, clamped to the owner host");
});

// --- buildWarmOverride: fresh-exit FAILS CLOSED (the cases a naive ===undefined check would MISS) ---
test("freshExit FAILS CLOSED — never a rotating/unverified exit, never a direct downgrade", () => {
  const cases = [
    ["no residential proxy", noProxy(), { freshExit: true }],
    ["not on a datacenter IP", proxySecrets(), { freshExit: true, onDatacenterIp: false }],
    ["sticky suffix absent", proxySecrets(), { freshExit: true, stickySuffix: undefined }],
    ["sticky suffix has no {id}", proxySecrets(), { freshExit: true, stickySuffix: "_session-static" }],
  ];
  for (const [label, secrets, over] of cases) {
    assert.throws(() => warm(vaultOf(entryWith("deadbeef")), secrets, over), /fresh-exit/, `must fail closed: ${label}`);
  }
});

// --- non-regression: freshExit=false is the current pinned/direct behavior, and restoreState is identical ---
test("freshExit=false is unchanged (re-pins a bound entry, direct for an unbound one); restoreState byte-identical", () => {
  const pinned = warm(vaultOf(entryWith("deadbeef")), proxySecrets(), { freshExit: false });
  assert.equal(pinned.proxy.password, "ppass" + SUFFIX.replaceAll("{id}", "deadbeef"), "re-pins the captured exit (R3 unchanged)");

  const direct = warm(vaultOf(entryWith(undefined)), proxySecrets(), { freshExit: false });
  assert.equal(direct.proxy, undefined, "unbound entry replays direct (no proxy) — unchanged");
  assert.ok(direct.restoreState, "direct still restores cookies");

  const fresh = warm(vaultOf(entryWith("deadbeef")), proxySecrets(), { freshExit: true });
  assert.deepEqual(fresh.restoreState, pinned.restoreState, "R4/seal: restoreState byte-identical across fresh/pinned — only the exit policy differs");
});

// --- controller error semantics: fresh-exit block = "retry for a clean exit", pinned block = "re-capture" ---
function blockedGateway() {
  let n = 1;
  const open = new Map();
  const blocked = { url: `https://${HOST}/account`, title: "Access Denied", tree: "blocked", status: 403 };
  const core = { async navigate() { return blocked; } };
  return {
    sessions: { get: (h) => open.get(h) },
    async openConsumerSession() { const id = "h" + n++; open.set(id, { core }); return id; },
    async useConsumerSession(_t, h, fn) { const s = open.get(h); if (!s) throw new Error("no session"); return fn(s); },
    async closeConsumerSession(_t, h) { open.delete(h); },
  };
}
const ctl = (freshExitHosts, stickyExitId = "deadbeef") =>
  new GatewayDriveController(blockedGateway(), proxySecrets(), "tok", {
    onDatacenterIp: true, stickySuffix: SUFFIX, freshExitHosts,
    vault: vaultOf(entryWith(stickyExitId)), consumerId: "atlas", allowlist: new Allowlist(["*"]),
  });

test("controller: fresh-exit host warm block → retry-for-fresh-exit error (NOT re-capture)", async () => {
  await assert.rejects(() => ctl(["totalwine.com"]).navigate(`https://${HOST}/account`), /retry navigate to draw a clean exit/);
});

test("controller: non-fresh host warm block → stale re-capture error (R3 path unchanged)", async () => {
  await assert.rejects(() => ctl([]).navigate(`https://${HOST}/account`), /re-capture this credential/);
});

// --- trailing-dot FQDN must NOT bypass the fresh-exit policy (the vault lookup + allowlist canonicalize,
//     so the policy match must too — else caller URL spelling reuses the stale captured/direct exit) ---
test("hostForcesProxy canonicalizes — a trailing-dot FQDN cannot bypass the policy match", () => {
  assert.equal(hostForcesProxy("www.totalwine.com.", ["totalwine.com"]), true, "trailing-dot host still matches");
  assert.equal(hostForcesProxy("WWW.TotalWine.COM", ["totalwine.com"]), true, "case-insensitive");
  assert.equal(hostForcesProxy("www.nottotalwine.com", ["totalwine.com"]), false, "non-subdomain does not match");
});

test("controller: a trailing-dot URL on a fresh-exit host still takes the FRESH path (bypass closed)", async () => {
  // Before the fix this fell through to the pinned re-pin / direct (→ stale 're-capture' error); now the
  // canonicalized match keeps it on the fresh path (→ 'retry navigate to draw a clean exit').
  await assert.rejects(() => ctl(["totalwine.com"]).navigate(`https://${HOST}./account`), /retry navigate to draw a clean exit/);
});

// --- reopen-after-reap on a fresh-exit host re-warms with a NEW fresh exit and keeps the fresh error ---
test("reopen-after-reap (fresh-exit host): re-warms fresh, block yields the fresh-exit retry error", async () => {
  let use = 0, n = 1, reaped = false;
  const open = new Map();
  const ok = { url: `https://${HOST}/account`, title: "ok", tree: "real content ".repeat(12), status: 200 };
  const blocked = { url: `https://${HOST}/account`, title: "Access Denied", tree: "blocked", status: 403 };
  const core = { async navigate() { return reaped ? blocked : ok; } };
  const gateway = {
    sessions: { get: (h) => open.get(h) },
    async openConsumerSession() { const id = "h" + n++; open.set(id, { core }); return id; },
    async useConsumerSession(_t, h, fn) {
      use++;
      if (use === 2) { open.delete(h); reaped = true; throw new Error("session reaped"); } // idle reap mid-flow
      const s = open.get(h); if (!s) throw new Error("no session"); return fn(s);
    },
    async closeConsumerSession(_t, h) { open.delete(h); },
  };
  const c = new GatewayDriveController(gateway, proxySecrets(), "tok", {
    onDatacenterIp: true, stickySuffix: SUFFIX, freshExitHosts: ["totalwine.com"],
    vault: vaultOf(entryWith("deadbeef")), consumerId: "atlas", allowlist: new Allowlist(["*"]),
  });
  const first = await c.navigate(`https://${HOST}/account`); // warm-opens fresh, pins
  assert.equal(first.status, 200, "first fresh-exit warm navigate lands");
  await assert.rejects(() => c.navigate(`https://${HOST}/account`), /session reaped|reaped/); // reap detected
  await assert.rejects(() => c.navigate(`https://${HOST}/account`), /retry navigate to draw a clean exit/); // reopen re-warms fresh, blocks → fresh error
});
