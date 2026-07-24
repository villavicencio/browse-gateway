/**
 * R2 (#80) — self-inflicted policy blocks. A MAIN-FRAME navigation the gateway's OWN nav guard aborts
 * (net::ERR_BLOCKED_BY_CLIENT) classifies as `policy-blocked`, carries the guard's reason (threaded via the
 * decision-safe out-param), and NEVER enters exit re-roll / burned-exit escalation. These cover the pure,
 * unit-testable seams; the real top-frame detection (a main-frame self-block vs a benign subresource block)
 * is proven in-container by scripts/validate-owner-host.mjs's off-allowlist leg / validate-policy-block.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFailure, isDeadExit } from "../dist/verbs/index.js";
import { buildFailureDiagnostics, redactFailureDiagnostics } from "../dist/observability/index.js";
import { PolicyEngine, ConsumerRegistry } from "../dist/policy/index.js";

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
    "the closed-vocab guard reason passes redaction untouched",
  );
});
