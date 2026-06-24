#!/usr/bin/env node
/**
 * Real-browser, full-gateway proof of U9 — CONSUMER warm-open. The capture path (U6) and the
 * hand-built warm replay (U6d, validate-vault-login) are already gated; this proves the missing
 * piece: a consumer simply NAVIGATING to an approved host that has a stored login gets a logged-in
 * session — WITHOUT the harness ever calling `buildWarmOverride`. The trigger lives in
 * `GatewayDriveController.#firstNavigate`, so the gate drives `controller.navigate(...)` exactly as
 * the HTTP server's `buildServer` wires it (vault + consumer id + allowlist), and asserts:
 *
 *   1. Warm-open fires through the trigger: navigate(owner) lands AUTHENTICATED (the durable cookie
 *      was decrypted from the vault, restored into a real Chrome, and sent to the server). The
 *      gateway accepted the override only because it was SEALED by the vault producer.
 *   2. Credential nav-clamp is live on a warm consumer session (R4 no-exfil): from the warm session,
 *      a navigate to a DIFFERENT host (127.0.0.2) is BLOCKED by guardForCredentialHost — the owner
 *      cookie can never ride a navigation off-host.
 *   3. Warm-open is SELECTIVE + the off-host is genuinely reachable: a FRESH controller navigating to
 *      127.0.0.2 (approved, but no vault entry) opens COLD and renders ANONYMOUS — disambiguating
 *      leg 2's block as the clamp, not a network failure, and proving the gateway isn't globally
 *      credentialed.
 *
 * The off-host legs need a distinct loopback HOST (127.0.0.1 and 127.0.0.2 differ only by port → same
 * host → the host clamp can't tell them apart). 127.0.0.0/8 is all loopback on Linux (the container),
 * but a Mac binds only 127.0.0.1 — so if 127.0.0.2 won't bind, those two legs are SKIPPED with a loud
 * note (no silent truncation); leg 1 (the core warm-open proof) always runs.
 *
 * The policy egress filter normally blocks loopback (anti-SSRF); the gate injects `egress: () => false`
 * so the gateway can reach the fixture — the ONLY deviation from production policy. Vault is DORMANT in
 * prod (needs BGW_VAULT_DIR persistent volume + 0600 key); the gate uses a temp dir + random KEK.
 *
 *   npm run build && node scripts/validate-vault-warm-open.mjs   (in-container: BGW_NO_SANDBOX=1)
 */
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Gateway, loadConfig } from "../dist/gateway/index.js";
import { PolicyEngine, ConsumerRegistry, Allowlist, InMemoryAuditSink } from "../dist/policy/index.js";
import { SecretStore, VaultStore, canonicalizeHost } from "../dist/security/index.js";
import { createBrowserCore } from "../dist/browser/index.js";
import { GatewayDriveController } from "../dist/mcp/drive-controller.js";
import { importLoginToVault, getVaultEntry, buildWarmOverride } from "../dist/mcp/vault-login.js";

const TOKEN = "tok-warm-open";
const COOKIE = "sid=warm-open-3d9f1a72"; // durable session cookie (not IP-bound → survives capture)

const page = (b) => `<!doctype html><html><body>${b}</body></html>`;
const hasSid = (req) => (req.headers.cookie ?? "").includes(COOKIE);

function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/login") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Set-Cookie": `${COOKIE}; Path=/; SameSite=Lax` });
    return res.end(page("<h1>LOGIN OK</h1>"));
  }
  if (url.pathname === "/dashboard") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(page(hasSid(req) ? `<h1 id="dash">AUTHENTICATED DASHBOARD</h1>` : `<h1>ANONYMOUS — please sign in</h1>`));
  }
  res.writeHead(404);
  res.end("not found");
}

/** Start the fixture on `host`; resolve {origin, close} or reject if the host can't be bound. */
function startServer(host) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on("error", reject);
    server.listen(0, host, () => {
      resolve({ origin: `http://${host}:${server.address().port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

let failures = 0;
const check = (label, ok) => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) failures++; };
const text = (snap) => `${snap.title}\n${snap.tree}`;
const FAST = { clearedTextLength: 0, clearanceTimeoutMs: 3000 };

console.log("=== browse-gateway :: U9 consumer warm-open (full gateway, real browser) ===");

const a = await startServer("127.0.0.1"); // owner host (has a vault entry)
// Off-host on a DISTINCT loopback host (not just a port) so the host clamp can distinguish it. A Mac
// binds only 127.0.0.1 → the two off-host legs SKIP loudly; the container (Linux) runs them.
let b = null;
try {
  b = await startServer("127.0.0.2");
} catch (err) {
  if (process.env.BGW_WARM_OPEN_ALLOW_PARTIAL === "1") {
    console.log(`  SKIP (allowed via BGW_WARM_OPEN_ALLOW_PARTIAL) off-host legs — 127.0.0.2 unbindable (${err.code ?? err.message})`);
  } else {
    // The off-host clamp + selectivity legs are the no-exfil proof — they must not be silently skipped.
    // Fail unless a dev explicitly opts into an owner-host-only run (e.g. macOS, which binds only 127.0.0.1).
    check("off-host coverage available (127.0.0.2 bound)", false);
    console.error(
      `        127.0.0.2 could not bind (${err.code ?? err.message}); set BGW_WARM_OPEN_ALLOW_PARTIAL=1 for ` +
        `an owner-host-only dev run (the off-host clamp/selectivity legs then SKIP).`,
    );
  }
}

const aHost = "127.0.0.1";
const allow = b ? ["127.0.0.1", "127.0.0.2"] : ["127.0.0.1"];
const vaultDir = mkdtempSync(join(tmpdir(), "bgw-warm-open-e2e-"));
const audit = new InMemoryAuditSink(); // inspect the U7 rail records (credentialed-open #6, clamp-block #4)
const policy = new PolicyEngine({
  registry: new ConsumerRegistry([{ id: "atlas", token: TOKEN, allow }]),
  audit,
  egress: () => false, // the ONLY policy deviation — reach the loopback fixture
});
const credOpens = (host) =>
  audit.records.filter((r) => r.action === "session-open" && r.decision === "open" && r.consumerId === "atlas" && r.host === host);
const config = loadConfig();
config.core.channel = process.env.BGW_CHANNEL ?? "chrome";
config.core.noSandbox = process.env.BGW_NO_SANDBOX === "1";
const gateway = Gateway.create(config, undefined, policy);
const secrets = new SecretStore(() => ({})); // direct (no proxy) for the local/in-container proof
const vault = new VaultStore({ kek: randomBytes(32), dir: vaultDir, canonicalizeHost });

try {
  // --- Seed: capture a real logged-in cookie with a throwaway browser, then store it ENCRYPTED in the
  // live vault (the same encrypt→store→decrypt→restore path warm-open replays). NOT a hand-built jar.
  {
    const cap = await createBrowserCore({ channel: config.core.channel, noSandbox: config.core.noSandbox });
    let state;
    try {
      await cap.render(`${a.origin}/login`, FAST);
      state = await cap.captureStorageState();
    } finally {
      await cap.close();
    }
    importLoginToVault(vault, { consumerId: "atlas", host: aHost, session: state, creds: { username: "u", password: "p" } });
    const entry = getVaultEntry(vault, "atlas", aHost);
    check("seed: an encrypted vault entry holds the durable session cookie", (entry?.session.cookies ?? []).some((c) => c.name === "sid"));
  }

  // --- Leg 1: the CONSUMER TRIGGER. Construct the controller EXACTLY as http-main's buildServer does,
  // then just navigate — no buildWarmOverride call anywhere in this harness.
  const c1 = new GatewayDriveController(gateway, secrets, TOKEN, {
    onDatacenterIp: false,
    vault,
    consumerId: "atlas",
    allowlist: new Allowlist(allow),
  });
  try {
    const snap = await c1.navigate(`${a.origin}/dashboard`);
    check("warm-open via navigate(): the page lands AUTHENTICATED (durable cookie restored)", /AUTHENTICATED DASHBOARD/.test(text(snap)));
    check("warm-open via navigate(): not a stale ANONYMOUS render", !/ANONYMOUS/.test(text(snap)));
    // Rail #6: EXACTLY ONE credentialed session-open audit for the warm open (no double-count, attributable).
    check("warm-open emits exactly one credentialed session-open audit (rail #6)", credOpens(aHost).length === 1);

    // --- Leg 2: the credential nav-clamp on a LIVE warm session. The warm session is clamped to the
    // owner host (127.0.0.1); a navigate to 127.0.0.2 must be refused by guardForCredentialHost.
    if (b) {
      let blocked = false;
      try {
        await c1.navigate(`${b.origin}/dashboard`); // off-owner host → guard aborts the navigation
      } catch {
        blocked = true;
      }
      check("warm session nav-clamp BLOCKS an off-owner host (R4 no-exfil, live)", blocked);
      // Rail #4: prove the block was the CLAMP (not a netfail) via its audit reason — a regression that
      // broke warm-open entirely could still throw, but only the clamp emits this credential-scope reason.
      const clampBlock = audit.records.some(
        (r) => r.action === "navigate" && r.decision === "block" && /credential scope/.test(r.reason ?? ""),
      );
      check("the off-host block was the credential clamp (audit reason), not a network failure", clampBlock);
    }
  } finally {
    await c1.close();
  }

  // --- Leg 3: selectivity + off-host reachability control. A fresh controller navigating to the
  // off-host (approved, but NO vault entry) opens COLD → renders ANONYMOUS. Proves warm-open is
  // selective AND that 127.0.0.2 is genuinely reachable (so leg 2's block was the clamp, not a netfail).
  if (b) {
    const c2 = new GatewayDriveController(gateway, secrets, TOKEN, {
      onDatacenterIp: false,
      vault,
      consumerId: "atlas",
      allowlist: new Allowlist(allow),
    });
    try {
      const snap = await c2.navigate(`${b.origin}/dashboard`);
      check("no-entry host opens COLD (selective) and is reachable → ANONYMOUS", /ANONYMOUS/.test(text(snap)) && !/AUTHENTICATED/.test(text(snap)));
    } finally {
      await c2.close();
    }
  }

  // --- Rail #1 (seal-refusal): the gateway must REFUSE a hand-built, UNSEALED restoreState — the
  // forge-resistance the whole warm path rests on. Asserted live against the real openConsumerSession
  // (it rejects before any session opens).
  {
    let refused = false;
    try {
      await gateway.openConsumerSession(TOKEN, { restoreState: { state: { cookies: [], origins: [] }, ownerHost: aHost } });
    } catch {
      refused = true;
    }
    check("gateway REFUSES an unsealed restoreState (rail #1, forge-resistance)", refused);
  }

  // --- No-exfil (R4) parent-cookie re-scope: a retained parent-domain (SSO) cookie MUST be pinned to the
  // owner host before restore, so the credential nav-clamp's subresource gap can't let it ride an allowed
  // SIBLING subresource (owner accounts.warm.example, cookie .warm.example → must NOT stay .warm.example).
  // Proven at the producer level against the REAL VaultStore; a full real-browser sibling-subresource
  // fixture needs domain-name hosts the loopback-IP harness can't express, and the pin is what makes the
  // leak impossible at the source (the cookie is never .warm.example in the restored jar to begin with).
  {
    importLoginToVault(vault, {
      consumerId: "atlas",
      host: "accounts.warm.example",
      session: { cookies: [{ name: "sso", value: "x", domain: ".warm.example", path: "/" }], origins: [] },
      creds: { username: "u", password: "p" },
    });
    const ov = buildWarmOverride(vault, secrets, { consumerId: "atlas", host: "accounts.warm.example", onDatacenterIp: false });
    const sso = ov?.restoreState?.state?.cookies?.find((c) => c.name === "sso");
    check("parent-domain (SSO) cookie re-scoped to the owner host — no sibling-subresource exfil (R4)", sso?.domain === "accounts.warm.example");
  }

  // --- BOUND (R3) warm path acceptance: the gate's trigger legs above exercise only the DIRECT replay.
  // Without a live upstream proxy we can't land a page through a re-pinned exit, but we CAN prove the
  // bound producer + the gateway's acceptance of a PROXIED sealed override end-to-end: buildWarmOverride
  // re-pins the captured exit (R3), and the REAL gateway accepts it (sealed) and emits the credentialed
  // audit clamped to the owner — not a fake that discards the override. (Owner host need not be a live
  // server: we assert acceptance + re-pin, not a navigation.)
  {
    const proxySecrets = new SecretStore(() => ({ BGW_PROXY_URL: "http://127.0.0.1:1", BGW_PROXY_PASSWORD: "pw" }));
    importLoginToVault(vault, {
      consumerId: "atlas",
      host: "bound.example",
      session: { cookies: [{ name: "sid", value: "bound", domain: "bound.example", path: "/" }], origins: [] },
      creds: { username: "u", password: "p" },
      stickyExitId: "abcd1234",
    });
    const boundOv = buildWarmOverride(vault, proxySecrets, { consumerId: "atlas", host: "bound.example", onDatacenterIp: true, stickySuffix: "_s-{id}" });
    check("bound entry → buildWarmOverride re-pins the SAME captured exit (R3)", boundOv?.proxy?.password === "pw_s-abcd1234");
    const handle = await gateway.openConsumerSession(TOKEN, boundOv); // launches with the proxy SET (never dialed — no navigate)
    try {
      check("gateway ACCEPTS the proxied sealed bound override (not a fake)", typeof handle === "string" && handle.length > 0);
      check("bound warm open emits a credentialed session-open audit clamped to the owner (rails #4/#6)", credOpens("bound.example").length === 1);
    } finally {
      await gateway.closeConsumerSession(TOKEN, handle).catch(() => {});
    }
  }

  // --- R3 fail-closed: a BOUND entry must NOT downgrade to a direct (wrong-exit) warm replay when its
  // captured residential exit can't be re-pinned (no proxy here). buildWarmOverride must THROW, not
  // return a state-only override — replaying logged-in auth from the wrong network posture risks a
  // stale/blocked session or an account-risk event.
  {
    const bareSecrets = new SecretStore(() => ({})); // no proxy configured
    importLoginToVault(vault, {
      consumerId: "atlas",
      host: "bound-fc.example",
      session: { cookies: [{ name: "sid", value: "x", domain: "bound-fc.example", path: "/" }], origins: [] },
      creds: { username: "u", password: "p" },
      stickyExitId: "abcd1234",
    });
    const tryBuild = (secrets) => {
      try { buildWarmOverride(vault, secrets, { consumerId: "atlas", host: "bound-fc.example", onDatacenterIp: true }); return false; }
      catch { return true; }
    };
    // (i) no proxy at all → can't re-pin → fail closed.
    check("bound entry FAILS CLOSED with no proxy configured (R3 — no wrong-exit replay)", tryBuild(bareSecrets));
    // (ii) proxy + datacenter but NO sticky suffix → proxyOverrideFor returns the BASE (rotating) proxy.
    // The base password here even CONTAINS the bound exit id ("abcd1234"), so a substring check would be
    // fooled — the structural pin verification must still fail closed (no incidental-substring pin).
    const noSuffixSecrets = new SecretStore(() => ({ BGW_PROXY_URL: "http://127.0.0.1:1", BGW_PROXY_PASSWORD: "base-abcd1234-x" }));
    check("bound entry FAILS CLOSED with a proxy but no sticky suffix, even if the base pw contains the exit id", tryBuild(noSuffixSecrets));
  }
} finally {
  await gateway.shutdown().catch(() => {});
  await a.close();
  if (b) await b.close();
  rmSync(vaultDir, { recursive: true, force: true });
}

const verdict = failures === 0 ? "PASS ✅" : "FAIL ❌";
const coverage = b ? "full coverage" : "leg 1 + rail checks only — off-host clamp + selectivity SKIPPED, run in-container for full U9 coverage";
console.log(`\n=== VAULT-WARM-OPEN GATE: ${verdict} (${failures} failure(s); ${coverage}) ===`);
process.exit(failures === 0 ? 0 : 1);
