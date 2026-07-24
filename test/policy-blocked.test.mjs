/**
 * R2 (#80) — self-inflicted policy blocks. A MAIN-FRAME navigation the gateway's OWN nav guard aborts
 * (net::ERR_BLOCKED_BY_CLIENT) classifies as `policy-blocked`, carries the guard's reason (threaded via the
 * decision-safe out-param), and NEVER enters exit re-roll / burned-exit escalation. These cover the pure,
 * unit-testable seams; the real top-frame detection (a main-frame self-block vs a benign subresource block)
 * is proven in-container by scripts/validate-owner-host.mjs's off-allowlist leg / validate-policy-block.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFailure, isDeadExit, resolveFailureReason, retrieve, navFailed } from "../dist/verbs/index.js";
import { buildFailureDiagnostics, redactFailureDiagnostics, failureOf } from "../dist/observability/index.js";
import { PolicyEngine, ConsumerRegistry, Allowlist } from "../dist/policy/index.js";
import { DEFAULT_CALL_TIMEOUTS } from "../dist/gateway/index.js";
import { SecretStore } from "../dist/security/index.js";
import { GatewayDriveController } from "../dist/mcp/drive-controller.js";

// --- classifyFailure: policy-blocked is the TOP-precedence class ---
test("classifyFailure: policyBlocked → policy-blocked, outranking every site/exit signal", () => {
  assert.equal(classifyFailure({ title: "", text: "", status: null, policyBlocked: true }), "policy-blocked");
  // outranks a hard-block (4xx + thin)
  assert.equal(classifyFailure({ title: "403 Forbidden", text: "Forbidden", status: 403, policyBlocked: true }), "policy-blocked");
  // outranks a chrome-error nav-failed
  assert.equal(
    classifyFailure({ title: "", text: "", status: null, finalUrl: "chrome-error://chromewebdata/", policyBlocked: true }),
    "policy-blocked",
  );
  // outranks a visible CF challenge
  assert.equal(classifyFailure({ title: "Just a moment...", text: "", status: 403, cfHint: true, policyBlocked: true }), "policy-blocked");
  // NON-REGRESSION: without the flag, the same null-status signal is nav-failed (baseline unchanged)
  assert.equal(classifyFailure({ title: "", text: "", status: null }), "nav-failed");
});

// --- isDeadExit: a self-block is NEVER a dead exit (no burned-exit re-roll) ---
test("isDeadExit: policyBlocked excludes a self-block from the dead-exit / burned-exit gate", () => {
  // baseline: null status + no receipt = a dead exit
  assert.equal(isDeadExit(false, null, undefined), true);
  assert.equal(isDeadExit(undefined, null, undefined), true);
  assert.equal(isDeadExit(false, null, "chrome-error://chromewebdata/"), true);
  // with policyBlocked → NOT a dead exit (our own guard aborted before the site; a fresh exit can't help)
  assert.equal(isDeadExit(false, null, undefined, true), false);
  assert.equal(isDeadExit(undefined, null, "chrome-error://chromewebdata/", true), false);
  // policyBlocked=false is the baseline (non-regression)
  assert.equal(isDeadExit(false, null, undefined, false), true);
});

// --- guard decision-safe out-param: a block WRITES out.reason; the decision is IDENTICAL with/without out ---
function policyOf(allow) {
  const policy = new PolicyEngine({ registry: new ConsumerRegistry([{ id: "atlas", token: "tok", allow }]) });
  return { policy, consumer: policy.authenticate("tok") };
}
const navReq = (host) => ({ url: `https://${host}/x`, host, resourceType: "document", isNavigationRequest: true });
const subReq = (host) => ({ url: `https://${host}/a.js`, host, resourceType: "script", isNavigationRequest: false });

test("guardFor: an off-allowlist nav blocks AND threads the reason via out; the decision never depends on out", () => {
  const { policy, consumer } = policyOf(["good.com"]);
  const guard = policy.guardFor(consumer);
  // decision IDENTICAL whether or not `out` is passed (out is write-only, never read into the decision)
  assert.equal(guard(navReq("evil.com")), "block");
  const out = {};
  assert.equal(guard(navReq("evil.com"), out), "block");
  assert.equal(out.reason, "host not in consumer allowlist");
  // an ALLOWED nav writes no reason
  const outOk = {};
  assert.equal(guard(navReq("good.com"), outOk), "allow");
  assert.equal(outOk.reason, undefined);
  // a blocked SUBRESOURCE also threads its reason (the capture layer top-frame-scopes what it promotes)
  const outSub = {};
  assert.equal(guard(subReq("evil.com"), outSub), "block");
  assert.equal(outSub.reason, "host not in consumer allowlist");
});

test("guardForCredentialHost: an off-OWNER nav blocks with the credential-scope reason via out", () => {
  const { policy, consumer } = policyOf(["good.com", "sibling.com"]);
  const guard = policy.guardForCredentialHost(consumer, "good.com");
  const out = {};
  assert.equal(guard(navReq("sibling.com"), out), "block"); // in the allowlist but NOT the owner host
  assert.equal(out.reason, "credential scope: navigation is not the credential owner host");
  const outOwner = {};
  assert.equal(guard(navReq("good.com"), outOwner), "allow");
  assert.equal(outOwner.reason, undefined);
  // scheme block still threads its reason
  const outScheme = {};
  assert.equal(guard({ url: "file:///etc/passwd", host: "", resourceType: "document", isNavigationRequest: true }, outScheme), "block");
  assert.equal(outScheme.reason, "scheme not allowed (only http/https)");
});

// --- envelope: selfBlockedNav carries host+reason; redaction scrubs the host, keeps the closed-vocab reason ---
test("buildFailureDiagnostics + redact: selfBlockedNav carries host+reason; host scrubbed, reason kept", () => {
  const diag = buildFailureDiagnostics({
    finalUrl: "https://evil.com/x",
    status: null,
    selfBlockedNav: { host: "evil.com", reason: "host not in consumer allowlist" },
  });
  assert.deepEqual(diag.selfBlockedNav, { host: "evil.com", reason: "host not in consumer allowlist" });

  // a secret that happens to appear in the host is scrubbed; the closed-vocab reason passes through untouched
  const secrets = { redactableValues: () => ["s3cr3tvalue"] };
  const red = redactFailureDiagnostics(
    buildFailureDiagnostics({
      status: null,
      selfBlockedNav: { host: "s3cr3tvalue.evil.com", reason: "credential scope: navigation is not the credential owner host" },
    }),
    secrets,
  );
  assert.ok(!red.selfBlockedNav.host.includes("s3cr3tvalue"), "a secret embedded in the host is redacted");
  assert.equal(
    red.selfBlockedNav.reason,
    "credential scope: navigation is not the credential owner host",
    "a hardcoded guard reason passes redaction unchanged (redactSecrets is a no-op on it)",
  );
  // R9 defense-in-depth: a secret in a hypothetical FREE-TEXT reason (the type permits any string) is scrubbed
  const red2 = redactFailureDiagnostics(
    buildFailureDiagnostics({ status: null, selfBlockedNav: { host: "off.example", reason: "blocked (token=s3cr3tvalue)" } }),
    secrets,
  );
  assert.ok(!red2.selfBlockedNav.reason.includes("s3cr3tvalue"), "a secret embedded in the reason is redacted (not trusted as closed-vocab)");
});

// --- P2: resolveFailureReason surfaces `policy-blocked` so the reason AGREES with the class ---
test("resolveFailureReason: policyBlocked → policy-blocked reason (not nav-failed), so the class is visible", () => {
  assert.equal(resolveFailureReason({ title: "", text: "", status: null, policyBlocked: true }), "policy-blocked");
  // outranks the chrome-error nav-failed override
  assert.equal(resolveFailureReason({ title: "", text: "", status: null, finalUrl: "chrome-error://x", policyBlocked: true }), "policy-blocked");
  // NON-REGRESSION: without the flag the null-status signal is still nav-failed
  assert.equal(resolveFailureReason({ title: "", text: "", status: null }), "nav-failed");
});

// --- P1: a policy block TERMINATES the escalation loop immediately (no wasted exit re-rolls) ---
const PROXY = () => ({ BGW_PROXY_URL: "http://proxy:8080", BGW_PROXY_PASSWORD: "pwd" });
const CF_BLOCK = { url: "u", status: 403, title: "Just a moment...", text: "Enable JavaScript and cookies to continue", html: "<div id='challenge-platform' class='cf-chl-opt'></div>", clearanceWaitedMs: 0, diagnostics: { finalUrl: "u", status: 403 } };
const DEAD = { url: "u", status: null, title: "", text: "", html: "", clearanceWaitedMs: 0, diagnostics: { finalUrl: "u", status: null } };
const HARD_403 = { url: "u", status: 403, title: "", text: "Forbidden", html: "Forbidden", clearanceWaitedMs: 0, responseReceived: true, diagnostics: { finalUrl: "u", status: 403 } };
const POLICY_BLOCKED = {
  url: "u", status: null, title: "", text: "", html: "", clearanceWaitedMs: 0,
  policyBlocked: { host: "off.example", reason: "host not in consumer allowlist" },
  diagnostics: { finalUrl: "u", status: null, selfBlockedNav: { host: "off.example", reason: "host not in consumer allowlist" } },
};
/** withConsumerSession returns results[call] — call 0 is the direct render, 1.. are proxied attempts. */
function makeRenderSeq(results) {
  let i = 0;
  return {
    async withConsumerSession(_token, fn) {
      const result = results[Math.min(i, results.length - 1)];
      i += 1;
      return fn({ core: { async render() { return result; }, async setNavigationGuard() {}, async close() {} } }, { id: "agent-1" });
    },
  };
}

test("retrieve: a policy block mid-escalation TERMINATES the loop (no re-roll) and surfaces policy-blocked", async () => {
  // direct CF-block → escalate; the FIRST proxied attempt hits a policy block (an off-allowlist redirect hop).
  // The loop must STOP there — a fresh exit can't reach an off-allowlist target.
  const gateway = makeRenderSeq([CF_BLOCK, POLICY_BLOCKED, DEAD, DEAD]);
  const r = await retrieve(gateway, new SecretStore(PROXY), { token: "t", url: "https://hard.example/", escalation: { onDatacenterIp: true } });
  assert.equal(r.proxyDiagnostic.attempts, 1, "the loop TERMINATED on the policy block — no wasted re-rolls");
  assert.equal(r.diagnostics.failureClass, "policy-blocked", "classified policy-blocked (not nav-failed / burned-exit)");
  assert.equal(r.reason, "policy-blocked", "the surfaced reason AGREES with the class (P2 — not nav-failed)");
  assert.equal(r.proxyDiagnostic.burnedExit, undefined, "a policy block is never an all-exits-dead burn");
});

test("retrieve: a FORCED-proxy policy block terminates at the FIRST attempt (no re-roll)", async () => {
  const gateway = makeRenderSeq([POLICY_BLOCKED, DEAD, DEAD]); // forced → no direct render; 1st proxied = policy block
  const r = await retrieve(gateway, new SecretStore(PROXY), { token: "t", url: "https://off.example/", forceProxy: true, escalation: { onDatacenterIp: true } });
  assert.equal(r.proxyDiagnostic.attempts, 1, "forced policy block terminates immediately (not proxyMaxAttempts)");
  assert.notEqual(r.proxyDiagnostic.attempts, DEFAULT_CALL_TIMEOUTS.proxyMaxAttempts, "did NOT exhaust every exit");
  assert.equal(r.diagnostics.failureClass, "policy-blocked");
  assert.equal(r.reason, "policy-blocked");
});

test("retrieve: a policy block on the FINAL attempt wins over an EARLIER live site block (mixed exhaustion)", async () => {
  // direct CF → escalate; proxied 1 = a LIVE hard-block (sets lastLiveRender); proxied 2 = a policy block
  // (a redirect hop off-allowlist) → loop breaks. The post-loop mixed-exhaustion swap must NOT replace the
  // policy-blocked final render with the earlier live block (which would hide the class + mis-advise a fresh
  // exit for an off-allowlist target). policy-blocked is the top-precedence, decisive verdict.
  const gateway = makeRenderSeq([CF_BLOCK, HARD_403, POLICY_BLOCKED, DEAD]);
  const r = await retrieve(gateway, new SecretStore(PROXY), { token: "t", url: "https://hard.example/", escalation: { onDatacenterIp: true } });
  assert.equal(r.diagnostics.failureClass, "policy-blocked", "policy-blocked wins over the earlier hard-block (not swapped away)");
  assert.equal(r.reason, "policy-blocked", "the surfaced reason stays policy-blocked, not hard-block");
  assert.equal(r.proxyDiagnostic.burnedExit, undefined, "not a burn");
});

test("drive: a FORCED-proxy policy block terminates the escalation loop with a policy headline (not burned-exit)", async () => {
  // Covers the DRIVE escalation-loop policy-block handling (#openHealthyAndNavigate: loop break, sawLiveResponse
  // guard, burnedExit exclusion, policy headline) — reachable only via forceProxy.
  let n = 1;
  const open = new Map();
  const events = [];
  const core = { async navigate(url) { return policyBlockedSnap(url); }, async snapshot() { return { url: "https://off.example/", title: "", tree: "", status: null }; } };
  const gateway = {
    sessions: { get: (h) => open.get(h) },
    async openConsumerSession() { const id = "h" + n++; open.set(id, { core }); events.push(["open", id]); return id; },
    async useConsumerSession(_t, h, fn) { const s = open.get(h); if (!s) throw new Error("no session"); return fn(s); },
    async closeConsumerSession(_t, h) { open.delete(h); events.push(["close", h]); },
  };
  const c = new GatewayDriveController(gateway, new SecretStore(PROXY), "tok", { onDatacenterIp: true, stickySuffix: "_s-{id}" });
  const err = await c.navigate("https://off.example/", { forceProxy: true }).then(() => null, (e) => e);
  assert.ok(err instanceof Error, "the forced-proxy policy block rejects");
  assert.match(err.message, /blocked by gateway policy/i, "policy-attributed escalation headline");
  assert.doesNotMatch(err.message, /burned exit|could not land a working proxied exit/i, "not a burned-exit / exit-hunting message");
  assert.equal(failureOf(err)?.failureClass, "policy-blocked", "classified policy-blocked, not burned-exit/nav-failed");
  assert.equal(events.filter((e) => e[0] === "open").length, 1, "terminated on the FIRST proxied policy block (no re-roll)");
});

// --- navFailed: a policy block is a nav failure even with a STALE (action-triggered) non-null status ---
test("navFailed: a policyBlocked snapshot fails even when it carries a STALE prior-page 200 status", () => {
  // An ACTION-triggered nav (click/submit) the guard aborts produces no new document response, so the
  // snapshot can inherit the previous page's 200 — which every other navFailed arm reads as healthy.
  assert.equal(navFailed({ url: "https://x/", title: "prev", tree: "content ".repeat(30), status: 200, policyBlocked: { host: "off", reason: "r" } }), true);
  // NON-REGRESSION: the same snapshot WITHOUT the marker (a real healthy 200) is not a failure.
  assert.equal(navFailed({ url: "https://x/", title: "prev", tree: "content ".repeat(30), status: 200 }), false);
});

// --- fake gateway/core with open/close tracking, for the drive session-lifecycle assertions ---
function makeTrackingGateway(navFn) {
  let n = 1;
  const open = new Map();
  const events = [];
  const okSnap = (url) => ({ url, title: "ok", tree: "real ".repeat(20), status: 200 });
  const core = { async navigate(url) { return navFn(url) ?? okSnap(url); }, async snapshot() { return okSnap("u"); } };
  const gateway = {
    sessions: { get: (h) => open.get(h) },
    async openConsumerSession() { const id = "h" + n++; open.set(id, { core }); events.push(["open", id]); return id; },
    async useConsumerSession(_t, h, fn) { const s = open.get(h); if (!s) throw new Error("no session"); return fn(s); },
    async closeConsumerSession(_t, h) { open.delete(h); events.push(["close", h]); },
  };
  return { gateway, open, events };
}
const policyBlockedSnap = (url) => ({
  url, title: "", tree: "", status: null,
  policyBlocked: { host: new URL(url).hostname, reason: "host not in consumer allowlist" },
  diagnostics: { finalUrl: url, status: null, selfBlockedNav: { host: new URL(url).hostname, reason: "host not in consumer allowlist" } },
});

// --- guardrail (c) + session preservation: a COLD pinned session's off-allowlist nav is policy-attributed,
//     NEVER "fresh exit", and PRESERVES the healthy session (our guard refused the target, not a dead exit) ---
test("drive: a COLD pinned session's off-allowlist nav → policy message, no fresh-exit advice, session PRESERVED", async () => {
  const g = makeTrackingGateway((url) => (url.includes("/off") ? policyBlockedSnap(url) : undefined));
  // Proxy configured + datacenter IP → the OLD generic message WOULD have appended "retry for a fresh exit".
  const c = new GatewayDriveController(g.gateway, new SecretStore(() => ({ BGW_PROXY_URL: "http://p:8080", BGW_PROXY_PASSWORD: "proxypass" })), "tok", { onDatacenterIp: true, stickySuffix: "_s-{id}" });
  await c.navigate("https://good.com/"); // direct 200 → pins (cold)
  const opensAfterPin = g.events.filter((e) => e[0] === "open").length;

  const err = await c.navigate("https://good.com/off").then(() => null, (e) => e); // pinned, off-allowlist → policy block
  assert.ok(err instanceof Error, "the off-allowlist nav on a pinned cold session rejects");
  assert.match(err.message, /blocked by gateway policy/i, "policy-attributed message");
  assert.doesNotMatch(err.message, /retry navigate for a fresh exit/i, "does NOT SUGGEST retrying for a fresh exit (guardrail c)");
  assert.equal(failureOf(err)?.failureClass, "policy-blocked", "the envelope classifies policy-blocked");
  // SESSION PRESERVED: our guard refused the TARGET, the exit is healthy — do NOT discard.
  assert.equal(g.open.size, 1, "the healthy session is PRESERVED (not discarded) on a policy block");
  assert.equal(g.events.filter((e) => e[0] === "close").length, 0, "no #discardSession on a policy block");
  // a follow-up navigate to an allowlisted target reuses the SAME session (no re-open)
  const back = await c.navigate("https://good.com/ok");
  assert.equal(back.status, 200, "returning to an allowlisted target succeeds");
  assert.equal(g.events.filter((e) => e[0] === "open").length, opensAfterPin, "reused the preserved session — no re-open");
});

// --- cold FIRST navigate to an off-allowlist host → policy message (no proxy-escalation implication), preserved ---
test("drive: a COLD FIRST navigate to an off-allowlist host → policy message, no proxy-escalation implication, PRESERVED", async () => {
  const g = makeTrackingGateway((url) => policyBlockedSnap(url)); // the very first navigate self-blocks
  // Proxy configured → the OLD #firstNavigate generic path would append "no residential proxy configured to
  // escalate to" ONLY when NO proxy; with a proxy it would silently imply escalation. Either way, the policy
  // branch must pre-empt the escalation/generic path.
  const c = new GatewayDriveController(g.gateway, new SecretStore(() => ({ BGW_PROXY_URL: "http://p:8080", BGW_PROXY_PASSWORD: "proxypass" })), "tok", { onDatacenterIp: true, stickySuffix: "_s-{id}" });
  const err = await c.navigate("https://off.example/deep").then(() => null, (e) => e);
  assert.ok(err instanceof Error, "the cold first-nav off-allowlist policy block rejects");
  assert.match(err.message, /blocked by gateway policy/i, "policy-attributed message");
  assert.doesNotMatch(err.message, /no residential proxy configured to escalate|could not land a working proxied exit/i, "does NOT imply a proxy exit would help");
  assert.equal(failureOf(err)?.failureClass, "policy-blocked");
  assert.equal(g.open.size, 1, "the healthy session is PRESERVED (pinned), not discarded");
  assert.equal(g.events.filter((e) => e[0] === "close").length, 0, "no #discardSession on a cold first-nav policy block");
});

// --- Fix 1 (integration): an ACTION (click) that triggers a policy-blocked nav is surfaced as a failure ---
test("drive: a click that triggers a policy-blocked nav is a FAILURE, not the stale prior page returned as success", async () => {
  let n = 1;
  const open = new Map();
  // navigate pins on a real page; the click's post-action snapshot is a policy block carrying a STALE 200.
  const staleBlocked = { url: "https://good.com/", title: "prev", tree: "prev content ".repeat(20), status: 200, policyBlocked: { host: "sibling.com", reason: "credential scope: navigation is not the credential owner host" }, diagnostics: { finalUrl: "https://good.com/", status: 200, selfBlockedNav: { host: "sibling.com", reason: "credential scope: navigation is not the credential owner host" } } };
  const core = {
    async navigate() { return { url: "https://good.com/", title: "ok", tree: "form [ref=e1]", status: 200 }; },
    async click() {},
    async snapshot() { return staleBlocked; },
  };
  const gateway = {
    sessions: { get: (h) => open.get(h) },
    async openConsumerSession() { const id = "h" + n++; open.set(id, { core }); return id; },
    async useConsumerSession(_t, h, fn) { const s = open.get(h); if (!s) throw new Error("no session"); return fn(s); },
    async closeConsumerSession(_t, h) { open.delete(h); },
  };
  const c = new GatewayDriveController(gateway, new SecretStore(() => ({})), "tok");
  await c.navigate("https://good.com/"); // pins
  // Without the navFailed policyBlocked arm, navFailed(200, no visible block) is false → the click returns
  // the stale page as success. And the message must be POLICY remediation, NOT the generic "close + reopen"
  // (reopening can't reach an off-policy target).
  const err = await c.click({ target: "e1", element: "x" }).then(() => null, (e) => e);
  assert.ok(err instanceof Error, "the action-triggered policy block is surfaced, not swallowed as success");
  assert.match(err.message, /blocked by gateway policy/i, "policy-attributed remediation");
  assert.doesNotMatch(err.message, /close and reopen/i, "does NOT give the generic close+reopen advice for a policy block");
  assert.equal(failureOf(err)?.failureClass, "policy-blocked");
});

// --- warm-open policy block (a redirect hop off the owner host) PRESERVES the warmed session (its clearance),
//     surfaces a policy message, and NEVER advises re-capturing the credential ---
test("drive: a warm-open policy block PRESERVES the warmed session — no re-capture advice, no discard", async () => {
  const HOST = "owner.example";
  const SESSION = {
    cookies: [{ name: "sid", value: "x".repeat(40), domain: HOST, path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }],
    origins: [{ origin: `https://${HOST}`, localStorage: [] }],
  };
  const ENTRY = { session: SESSION, creds: { username: "u", password: "p".repeat(20) }, updatedAt: 1 };
  const vaultOf = (e) => ({ get: () => e, has: () => !!e, put() {}, remove: () => false });
  let n = 1;
  const open = new Map();
  const events = [];
  const core = { async navigate(url) { return policyBlockedSnap(url); }, async snapshot() { return { url: `https://${HOST}/`, title: "ok", tree: "x", status: 200 }; } };
  const gateway = {
    sessions: { get: (h) => open.get(h) },
    async openConsumerSession() { const id = "h" + n++; open.set(id, { core }); events.push(["open", id]); return id; },
    async useConsumerSession(_t, h, fn) { const s = open.get(h); if (!s) throw new Error("no session"); return fn(s); },
    async closeConsumerSession(_t, h) { open.delete(h); events.push(["close", h]); },
  };
  const c = new GatewayDriveController(gateway, new SecretStore(() => ({})), "tok", { onDatacenterIp: false, vault: vaultOf(ENTRY), consumerId: "atlas", allowlist: new Allowlist([HOST]) });
  const err = await c.navigate(`https://${HOST}/deep`).then(() => null, (e) => e); // warm-opens; target redirects off-owner → policy block
  assert.ok(err instanceof Error, "the warm-open policy block rejects");
  assert.match(err.message, /blocked by gateway policy/i, "policy-attributed message");
  assert.doesNotMatch(err.message, /re-capture/i, "does NOT advise re-capturing the credential (guardrail c) — the login is fine");
  assert.equal(failureOf(err)?.failureClass, "policy-blocked", "classifies policy-blocked");
  assert.equal(open.size, 1, "the WARMED session is PRESERVED (its WAF clearance survives) — not discarded");
  assert.equal(events.filter((e) => e[0] === "close").length, 0, "no #discardSession on a warm-open policy block");
});
