/**
 * Composition test for the server-redirect fix: feeds a CDP-shaped redirect chain through
 * cdpRequestToNavigation (the core's per-hop mapping) into the REAL policy guard, the same two-step
 * #onRequestPaused performs on every hop. The core's per-hop re-fire is proven live in
 * scripts/validate-redirect-guard.mjs (which must use a synthetic guard — the egress filter denies
 * loopback); this test closes the other half browser-free: that the guard the core re-fires per hop
 * actually DENIES a same-parent-sibling redirect target (R4 no-exfil) and an internal/egress-denied
 * redirect target (SSRF-via-redirect), and still allows a sibling SUBRESOURCE (nav-only clamp).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PolicyEngine, ConsumerRegistry, InMemoryAuditSink } from "../dist/policy/index.js";
import { cdpRequestToNavigation } from "../dist/browser/patchright-core.js";

// A credentialed session whose stored credential is owned by accounts.ex.com, on a consumer whose
// allowlist is the whole *.ex.com family — so the OWNER-HOST CLAMP (not the allowlist) is what must
// stop a redirect to a sibling.
const OWNER = "accounts.ex.com";
const mkGuard = () => {
  const audit = new InMemoryAuditSink();
  const policy = new PolicyEngine({
    registry: new ConsumerRegistry([{ id: "atlas", token: "tok", allow: ["ex.com", "*.ex.com"] }]),
    audit,
  });
  return { guard: policy.guardForCredentialHost(policy.authenticate("tok"), OWNER), audit };
};

// Model a CDP redirect hop exactly as #onRequestPaused sees it: TitleCase "Document" resourceType.
const hop = (host) => cdpRequestToNavigation("Document", `https://${host}/path`);

test("redirect chain: owner hops allow, the cross-sibling hop is blocked by the owner clamp", () => {
  const { guard, audit } = mkGuard();
  // owner -> owner -> evil.ex.com (a same-parent sibling, inside *.ex.com but NOT the owner host)
  assert.equal(guard(hop("accounts.ex.com")), "allow");
  assert.equal(guard(hop("accounts.ex.com")), "allow");
  assert.equal(guard(hop("evil.ex.com")), "block", "the redirected sibling hop must be denied");
  const blocked = audit.records.find((r) => r.host === "evil.ex.com" && r.decision === "block");
  assert.ok(blocked, "the blocked sibling hop is audited");
  assert.match(blocked.reason, /credential|owner|scope/i);
});

test("a redirect hop to an internal/egress-denied host is blocked at that hop", () => {
  for (const internal of ["169.254.169.254", "10.0.0.1", "127.0.0.1"]) {
    const { guard } = mkGuard();
    assert.equal(guard(hop(internal)), "block", `${internal} (egress-denied) must be blocked`);
  }
});

test("a sibling SUBRESOURCE is NOT owner-clamped (nav-only clamp; subresource keeps the allowlist)", () => {
  const { guard } = mkGuard();
  // An Image to a sibling maps to isNavigationRequest=false, so it is allowed under *.ex.com.
  assert.equal(guard(cdpRequestToNavigation("Image", "https://cdn.ex.com/a.png")), "allow");
  // The same sibling as a top-level navigation (Document) is clamped out.
  assert.equal(guard(cdpRequestToNavigation("Document", "https://cdn.ex.com/")), "block");
});
