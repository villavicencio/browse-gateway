/**
 * R3 (#81) — evidence-driven warm-failure advice. The operator message on a WARM (logged-in) navigation
 * failure now MATCHES the failure evidence (the attached envelope's closed-vocab failureClass + derived
 * booleans: a LIVE behavioral challenge, a genuine transport failure, the fresh-exit host flag) instead of
 * being chosen by host config alone. The pure mapper is unit-tested per evidence shape; a controller
 * integration test proves the wiring.
 *
 * Post-#78 follow-ups fixed here:
 *  - F1 behavioral gating: the behavioral branch keys on a LIVE press-&-hold (pxHint && pxCopy →
 *    behavioralChallenge), NOT vendor attribution (`wafVendor === perimeterx`) — which PERSISTS on a
 *    burned-exit 403 a fresh exit would clear. A pxHint-only IP-reputation block now correctly gets
 *    fresh-exit / stale advice, not the "a fresh exit won't clear it" behavioral message.
 *  - F4 transport failures: a nav-failed WITH a genuine network failure (conn reset / unreachable) on a
 *    non-fresh host is advised to retry the transport, not to re-capture the credential.
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

test("warmFailureAdvice: a LIVE behavioral challenge (pxHint && pxCopy) → fresh exit won't clear, retry re-triggers", () => {
  const m = warmFailureAdvice({ behavioralChallenge: true, failureClass: "anti-bot-block", freshExitHost: true });
  assert.match(m, /behavioral challenge|press-&-hold/i);
  assert.match(m, /fresh exit will not clear|re-triggers/i);
  // the behavioral branch WINS over the fresh-exit branch (freshExitHost:true above) — a fresh exit can't
  // clear an IP-independent behavioral challenge, so it must not advise "draw a clean exit".
  assert.doesNotMatch(m, /re-capture|draw a clean exit/i);
});

test("warmFailureAdvice: F1 fix — a pxHint-ONLY 403 (no pxCopy, no behavioralChallenge) is NOT behavioral", () => {
  // The mis-diagnosis this fixes: a burned/reputation-blocked exit hitting a PX-protected host serves a thin
  // 403 whose pxHint marker PERSISTS but has NO press-&-hold copy (pxCopy false → behavioralChallenge false).
  // The old vendor-gated branch told a fresh-exit host "a fresh exit won't clear it" — but a fresh exit WOULD.
  const freshHost = warmFailureAdvice({ failureClass: "anti-bot-block", freshExitHost: true });
  assert.match(freshHost, /draw a clean exit/i, "a fresh-exit host correctly gets fresh-exit advice");
  assert.doesNotMatch(freshHost, /behavioral challenge|fresh exit will not clear/i, "NOT the behavioral message");
  const staleHost = warmFailureAdvice({ failureClass: "anti-bot-block", freshExitHost: false });
  assert.match(staleHost, /re-capture this credential/i, "a non-fresh host falls to the stale default");
});

test("warmFailureAdvice: a fresh-exit host block (no live behavioral) → retry to draw a clean exit", () => {
  assert.match(warmFailureAdvice({ failureClass: "hard-block", freshExitHost: true }), /retry navigate to draw a clean exit/i);
  // a CF interstitial CAN be cleared by a fresh exit — so on a fresh-exit host it stays fresh-advice
  assert.match(warmFailureAdvice({ failureClass: "anti-bot-block", freshExitHost: true }), /draw a clean exit/i);
});

test("warmFailureAdvice: a non-fresh host / no evidence → re-capture the credential (the default)", () => {
  assert.match(warmFailureAdvice({ freshExitHost: false }), /re-capture this credential/i);
  assert.match(warmFailureAdvice({ failureClass: "hard-block", freshExitHost: false }), /re-capture this credential/i);
  // a CF block on a NON-fresh host still defaults to re-capture (the stale/re-pin contract)
  assert.match(warmFailureAdvice({ failureClass: "anti-bot-block", freshExitHost: false }), /re-capture/i);
});

// --- F4: transport failures ----------------------------------------------------------------------

test("warmFailureAdvice: F4 — nav-failed + genuine network failure on a non-fresh host → retry the transport", () => {
  const m = warmFailureAdvice({ failureClass: "nav-failed", genuineNetworkFailure: true, freshExitHost: false });
  assert.match(m, /transport|connection reset|unreachable/i);
  assert.match(m, /retry navigate/i);
  // NOT the stale-credential default — a conn reset is not a logged-out replay.
  assert.doesNotMatch(m, /re-capture this credential/i);
});

test("warmFailureAdvice: F4 negative — nav-failed with NO network failure still defaults to re-capture", () => {
  // A dead-nav with no genuine subresource failure is indistinguishable from a stale replay here → default.
  assert.match(warmFailureAdvice({ failureClass: "nav-failed", genuineNetworkFailure: false, freshExitHost: false }), /re-capture this credential/i);
});

test("warmFailureAdvice: F4 guard — a hard-block with an incidental network failure is NOT transport advice", () => {
  // genuineNetworkFailure can be true on a real block (a failed subresource); the AND-gate on nav-failed keeps
  // a hard-block on a non-fresh host at the re-capture default, never flipping it to transport advice.
  assert.match(warmFailureAdvice({ failureClass: "hard-block", genuineNetworkFailure: true, freshExitHost: false }), /re-capture this credential/i);
});

test("warmFailureAdvice: F4 precedence — fresh-exit wins over the transport branch", () => {
  // On a fresh-exit host a nav-failed is the burned-exit story (both say retry); the fresh-exit branch (3)
  // precedes the transport branch (4), so the fresh-exit message stands.
  assert.match(warmFailureAdvice({ failureClass: "nav-failed", genuineNetworkFailure: true, freshExitHost: true }), /draw a clean exit/i);
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

// A gateway whose warm navigate always returns the given blocked snapshot (403 + thin body).
function blockedGateway(snapExtra) {
  let n = 1;
  const open = new Map();
  const blocked = { url: `https://${HOST}/account`, title: "", tree: "Forbidden", status: 403, diagnostics: { finalUrl: `https://${HOST}/account`, status: 403 }, ...snapExtra };
  const core = { async navigate() { return blocked; } };
  return {
    sessions: { get: (h) => open.get(h) },
    async openConsumerSession() { const id = "h" + n++; open.set(id, { core }); return id; },
    async useConsumerSession(_t, h, fn) { const s = open.get(h); if (!s) throw new Error("no session"); return fn(s); },
    async closeConsumerSession(_t, h) { open.delete(h); },
  };
}

const controllerFor = (gateway, freshExitHosts) => new GatewayDriveController(gateway, proxySecrets(), "tok", {
  onDatacenterIp: true,
  stickySuffix: SUFFIX,
  freshExitHosts,
  vault: vaultOf(ENTRY),
  consumerId: "atlas",
  allowlist: new Allowlist(["*"]),
});

test("controller: a FRESH-EXIT host's LIVE PerimeterX press-&-hold (pxHint && pxCopy) → behavioral advice", async () => {
  // totalwine is a FRESH-EXIT host, so host config alone would pick the "draw a clean exit" fresh-exit-dud
  // message. The snapshot carries pxHint AND pxCopy (a live press-&-hold), so the advice must instead say a
  // fresh exit won't clear it — evidence overrides host config.
  const c = controllerFor(blockedGateway({ pxHint: true, pxCopy: true }), ["totalwine.com"]);
  const err = await c.navigate(`https://${HOST}/account`).then(() => null, (e) => e);
  assert.ok(err instanceof Error, "the warm PX block rejects");
  assert.match(err.message, /behavioral challenge|fresh exit will not clear|re-triggers/i, "the live-behavioral advice");
  assert.doesNotMatch(err.message, /draw a clean exit|re-capture this credential/i, "NOT the fresh-exit-dud or stale-credential advice");
});

test("controller: F1 fix — a FRESH-EXIT host's pxHint-ONLY 403 (no pxCopy) → fresh-exit advice, NOT behavioral", async () => {
  // The mis-diagnosis fix, end-to-end: a reputation-blocked 403 whose pxHint marker persists but carries NO
  // press-&-hold copy (pxCopy absent) must NOT be told a fresh exit won't clear it — on a fresh-exit host a
  // fresh exit is exactly the right retry.
  const c = controllerFor(blockedGateway({ pxHint: true }), ["totalwine.com"]);
  const err = await c.navigate(`https://${HOST}/account`).then(() => null, (e) => e);
  assert.ok(err instanceof Error, "the warm block rejects");
  assert.match(err.message, /draw a clean exit/i, "the fresh-exit advice (a fresh exit would clear a reputation 403)");
  assert.doesNotMatch(err.message, /behavioral challenge|fresh exit will not clear|re-capture this credential/i, "NOT behavioral or stale");
});

test("controller: F4 — a warm transport failure (conn reset) on a NON-fresh host → retry the transport", async () => {
  // A null-status nav with a genuine ERR_CONNECTION_RESET subresource failure classifies nav-failed; on a
  // non-fresh host the evidence-driven advice must say retry the transport, not re-capture the credential.
  const transport = blockedGateway({
    status: null,
    tree: "",
    diagnostics: { finalUrl: `https://${HOST}/account`, status: null, networkFailures: [`GET https://${HOST}/account net::ERR_CONNECTION_RESET`] },
  });
  const c = controllerFor(transport, []); // no fresh-exit hosts → totalwine is non-fresh
  const err = await c.navigate(`https://${HOST}/account`).then(() => null, (e) => e);
  assert.ok(err instanceof Error, "the warm transport failure rejects");
  assert.match(err.message, /transport|connection reset|unreachable/i, "the transport advice");
  assert.doesNotMatch(err.message, /re-capture this credential/i, "NOT the stale-credential default");
});
