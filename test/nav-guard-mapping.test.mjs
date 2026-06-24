/**
 * Unit tests for the CDP→NavigationRequest mapping used by the network-layer navigation guard
 * (src/browser/patchright-core.ts). This is the highest-risk part of the CDP-Fetch rewrite that
 * replaced context.route: CDP `Fetch.requestPaused` has no `isNavigationRequest` boolean and emits
 * TitleCase `resourceType`, so the guard derives both. The policy nav-clamp / origination boundary
 * branch on `isNavigationRequest`, so a wrong derivation is an R4 no-exfil regression — hence a pure,
 * browser-free assertion of the mapping here, alongside the real-browser wiring proof in
 * scripts/validate-redirect-guard.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cdpRequestToNavigation, decideRequest } from "../dist/browser/patchright-core.js";

const evt = (resourceType, url, requestId = "req-1") => ({ requestId, request: { url }, resourceType });

test("Document → navigation request, resourceType lowercased, host parsed", () => {
  const nav = cdpRequestToNavigation("Document", "https://Accounts.Example.com/login?x=1");
  assert.equal(nav.isNavigationRequest, true);
  assert.equal(nav.resourceType, "document");
  assert.equal(nav.host, "accounts.example.com");
  assert.equal(nav.url, "https://Accounts.Example.com/login?x=1");
});

test("subresource types (XHR/Stylesheet/Image/Fetch) are NOT navigation requests, lowercased", () => {
  for (const [cdp, expected] of [
    ["XHR", "xhr"],
    ["Stylesheet", "stylesheet"],
    ["Image", "image"],
    ["Fetch", "fetch"],
    ["Script", "script"],
  ]) {
    const nav = cdpRequestToNavigation(cdp, "https://cdn.example.com/a");
    assert.equal(nav.isNavigationRequest, false, `${cdp} must not be a navigation request`);
    assert.equal(nav.resourceType, expected);
  }
});

test("only the exact CDP 'Document' literal maps to a navigation (case-sensitive guard input)", () => {
  // CDP emits exactly "Document"; defend against a mis-cased value silently disabling the nav clamp.
  assert.equal(cdpRequestToNavigation("document", "https://e.com/").isNavigationRequest, false);
  assert.equal(cdpRequestToNavigation("Document", "https://e.com/").isNavigationRequest, true);
});

test("unparseable URL yields an empty host (fail-safe — empty host is always denied by policy)", () => {
  const nav = cdpRequestToNavigation("Document", "not a url");
  assert.equal(nav.host, "");
  assert.equal(nav.isNavigationRequest, true);
  assert.equal(nav.url, "not a url");
});

test("non-string resourceType is tolerated → empty resourceType, not a navigation", () => {
  const nav = cdpRequestToNavigation(undefined, "https://e.com/");
  assert.equal(nav.resourceType, "");
  assert.equal(nav.isNavigationRequest, false);
});

// --- decideRequest: the fail-closed decision routing the CDP handler runs per paused request ------

test("decideRequest: no guard installed → block (fail-closed, never fail-open per request)", () => {
  assert.equal(decideRequest(undefined, evt("Document", "https://e.com/")), "block");
});

test("decideRequest: passes the mapped NavigationRequest to the guard and returns its verdict", () => {
  let seen;
  const allow = (nav) => {
    seen = nav;
    return "allow";
  };
  assert.equal(decideRequest(allow, evt("Document", "https://Owner.com/p")), "allow");
  assert.deepEqual(seen, {
    url: "https://Owner.com/p",
    host: "owner.com",
    resourceType: "document",
    isNavigationRequest: true,
  });
});

test("decideRequest: a guard returning 'block' is honored", () => {
  assert.equal(decideRequest(() => "block", evt("XHR", "https://e.com/x")), "block");
});

test("decideRequest: a throwing guard → block, and onError is invoked with the throw", () => {
  let captured;
  const boom = () => {
    throw new Error("guard exploded");
  };
  const decision = decideRequest(boom, evt("Document", "https://e.com/"), (err) => {
    captured = err;
  });
  assert.equal(decision, "block");
  assert.ok(captured instanceof Error);
  assert.match(captured.message, /guard exploded/);
});

test("decideRequest: a missing request.url is tolerated (empty host → guard blocks empty host)", () => {
  let seen;
  decideRequest((nav) => {
    seen = nav;
    return "block";
  }, { requestId: "r", request: {}, resourceType: "Document" });
  assert.equal(seen.url, "");
  assert.equal(seen.host, "");
});
