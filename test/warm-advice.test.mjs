/**
 * R3 (#81) — evidence-driven warm-failure advice. The operator message on a WARM (logged-in) navigation
 * failure now MATCHES the failure evidence (the attached envelope's closed-vocab failureClass/wafVendor +
 * the fresh-exit host flag) instead of being chosen by host config alone. The pure mapper is unit-tested per
 * evidence shape; a controller integration test proves the wiring (a live PerimeterX challenge on a
 * fresh-exit host now gets the behavioral advice, not the old "draw a clean exit" fresh-exit-dud message).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { warmFailureAdvice } from "../dist/observability/index.js";
import { GatewayDriveController } from "../dist/mcp/drive-controller.js";
import { SecretStore } from "../dist/security/index.js";
import { Allowlist } from "../dist/policy/index.js";

// --- the pure mapper, per evidence shape ---------------------------------------------------------

test("warmFailureAdvice: policy-blocked → fix scope/policy, NEVER re-capture or fresh-exit", () => {
  const m = warmFailureAdvice({ failureClass: "policy-blocked", freshExitHost: true });
  assert.match(m, /off the allowlist|owner-host|fix the scope\/policy/i);
  assert.doesNotMatch(m, /re-capture|draw a clean exit/i);
});

test("warmFailureAdvice: a LIVE PerimeterX behavioral challenge → fresh exit won't clear, retry re-triggers", () => {
  const m = warmFailureAdvice({ failureClass: "anti-bot-block", wafVendor: "perimeterx", freshExitHost: true });
  assert.match(m, /behavioral challenge|press-&-hold/i);
  assert.match(m, /fresh exit will not clear|re-triggers/i);
  // the behavioral branch WINS over the fresh-exit branch (freshExitHost:true above) — a fresh exit can't
  // clear an IP-independent behavioral challenge, so it must not advise "draw a clean exit".
  assert.doesNotMatch(m, /re-capture|draw a clean exit/i);
});

test("warmFailureAdvice: a fresh-exit host block (no behavioral vendor) → retry to draw a clean exit", () => {
  assert.match(warmFailureAdvice({ failureClass: "hard-block", freshExitHost: true }), /retry navigate to draw a clean exit/i);
  // a CF interstitial (cloudflare) CAN be cleared by a fresh exit — so on a fresh-exit host it stays fresh-advice
  assert.match(warmFailureAdvice({ failureClass: "anti-bot-block", wafVendor: "cloudflare", freshExitHost: true }), /draw a clean exit/i);
});

test("warmFailureAdvice: a non-fresh host / no evidence → re-capture the credential (the default)", () => {
  assert.match(warmFailureAdvice({ freshExitHost: false }), /re-capture this credential/i);
  assert.match(warmFailureAdvice({ failureClass: "hard-block", freshExitHost: false }), /re-capture this credential/i);
  // a CF block on a NON-fresh host still defaults to re-capture (the stale/re-pin contract)
  assert.match(warmFailureAdvice({ failureClass: "anti-bot-block", wafVendor: "cloudflare", freshExitHost: false }), /re-capture/i);
});

// --- controller integration: the evidence OVERRIDES host config -----------------------------------

const SUFFIX = "_country-us_session-{id}_lifetime-30m";
const HOST = "www.totalwine.com";
const SESSION = {
  cookies: [{ name: "sid", value: "x".repeat(40), domain: "totalwine.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }],
  origins: [{ origin: "https://www.totalwine.com", localStorage: [{ name: "k", value: "v" }] }],
};
const ENTRY = { session: SESSION, creds: { username: "u", password: "p".repeat(20) }, stickyExitId: "deadbeef", updatedAt: 1 };
const vaultOf = (e) => ({ get: () => e, has: () => !!e, put() {}, remove: () => false });
const proxySecrets = () => new SecretStore(() => ({ BGW_PROXY_URL: "http://proxy.test:8080", BGW_PROXY_USERNAME: "puser", BGW_PROXY_PASSWORD: "ppass" }));

function pxBlockedGateway() {
  let n = 1;
  const open = new Map();
  // A live PerimeterX block: status 403 + thin body + pxHint → #failure classifies anti-bot-block / perimeterx.
  const blocked = { url: `https://${HOST}/account`, title: "", tree: "Forbidden", status: 403, pxHint: true, diagnostics: { finalUrl: `https://${HOST}/account`, status: 403 } };
  const core = { async navigate() { return blocked; } };
  return {
    sessions: { get: (h) => open.get(h) },
    async openConsumerSession() { const id = "h" + n++; open.set(id, { core }); return id; },
    async useConsumerSession(_t, h, fn) { const s = open.get(h); if (!s) throw new Error("no session"); return fn(s); },
    async closeConsumerSession(_t, h) { open.delete(h); },
  };
}

test("controller: a FRESH-EXIT host's LIVE PerimeterX block → behavioral advice (evidence overrides host config)", async () => {
  // totalwine is a FRESH-EXIT host, so host config alone would pick the "draw a clean exit" fresh-exit-dud
  // message. R3: the attached envelope classifies anti-bot-block / perimeterx (a live behavioral challenge),
  // so the advice must instead say a fresh exit won't clear it — the finding-#4 fix.
  const c = new GatewayDriveController(pxBlockedGateway(), proxySecrets(), "tok", {
    onDatacenterIp: true,
    stickySuffix: SUFFIX,
    freshExitHosts: ["totalwine.com"],
    vault: vaultOf(ENTRY),
    consumerId: "atlas",
    allowlist: new Allowlist(["*"]),
  });
  const err = await c.navigate(`https://${HOST}/account`).then(() => null, (e) => e);
  assert.ok(err instanceof Error, "the warm PX block rejects");
  assert.match(err.message, /behavioral challenge|fresh exit will not clear|re-triggers/i, "the live-behavioral advice");
  assert.doesNotMatch(err.message, /draw a clean exit|re-capture this credential/i, "NOT the fresh-exit-dud or stale-credential advice");
});
