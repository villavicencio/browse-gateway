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
import { cdpRequestToNavigation, decideRequest, errCode } from "../dist/browser/patchright-core.js";
import { SecretStore, redactSecrets } from "../dist/security/index.js";

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

// --- errCode: browser-core stderr diagnostics stay secret-free (audit #3) --------------------------

test("errCode: with a redactor, a BARE secret (not in URL form) is scrubbed from a diagnostic", () => {
  const secret = "sup3r-secret-proxy-pass";
  const secrets = new SecretStore(() => ({ BGW_PROXY_PASSWORD: secret }));
  const redact = (s) => redactSecrets(s, secrets);
  // A driver error carrying the password BARE (not embedded in a URL the URL-strip would catch).
  const out = errCode(new Error(`net::ERR_TUNNEL: auth ${secret} rejected`), redact);
  assert.ok(!out.includes(secret), "the bare secret is redacted by the injected redactor");
});

test("errCode: strips a URL, scrubs a secret past char 80, and truncates to 80", () => {
  const secret = "another-long-secret-value";
  const secrets = new SecretStore(() => ({ BGW_PROXY_PASSWORD: secret }));
  const redact = (s) => redactSecrets(s, secrets);
  // Secret placed PAST char 80 — redaction runs on the full message BEFORE truncation, so it's caught.
  const msg = `${"x".repeat(90)} via http://u:${secret}@proxy.internal:8080 pw=${secret}`;
  const out = errCode(new Error(msg), redact);
  assert.ok(!out.includes(secret), "a secret beyond the 80-char cutoff is still redacted (redact-before-truncate)");
  assert.ok(!out.includes("proxy.internal"), "the URL is stripped");
  assert.ok(out.length <= 80, "output is truncated to 80 chars");
});

test("errCode: without a redactor, URL-strip + truncate still apply (degraded but safe default)", () => {
  const out = errCode(new Error("boom via https://exit.example:8080/path more text here"));
  assert.ok(out.includes("<url>"), "the URL is stripped even without a redactor");
  assert.ok(!out.includes("exit.example"), "no target URL survives");
  assert.ok(out.length <= 80);
});

test("errCode: a solver error CODE carrying a secret is redacted (captcha diagnostic sink, audit #3)", () => {
  const secret = "leaked-solver-code-secret";
  const secrets = new SecretStore(() => ({ BGW_CAPTCHA_API_KEY: secret }));
  const redact = (s) => redactSecrets(s, secrets);
  // The captcha-solve-failed sink now routes error.code through errCode(code, this.#redact).
  const out = errCode(`vendor-fail:${secret}`, redact);
  assert.ok(!out.includes(secret), "a secret embedded in a solver error code is redacted");
});

// --- resolveCoreRedactor: a secret-bearing launch ALWAYS gets a stderr redactor (audit #3) ----------

test("resolveCoreRedactor: scrubs the caller store's secrets (store passed, not an opaque fn)", async () => {
  const { resolveCoreRedactor } = await import("../dist/browser/patchright-core.js");
  const { SecretStore } = await import("../dist/security/index.js");
  const secrets = new SecretStore(() => ({ BGW_PROXY_PASSWORD: "caller-known-secret-value" }));
  const r = resolveCoreRedactor({ proxy: { server: "http://p:8080" }, secrets });
  assert.ok(!r("driver echoed caller-known-secret-value").includes("caller-known-secret-value"), "a caller secret is scrubbed");
});

test("resolveCoreRedactor: unions caller secrets + option creds; validates option creds", async () => {
  const { resolveCoreRedactor } = await import("../dist/browser/patchright-core.js");
  const { SecretStore } = await import("../dist/security/index.js");
  // The caller store does NOT know the per-session override password (SessionManager merges it in).
  const secrets = new SecretStore(() => ({ BGW_CAPTCHA_API_KEY: "caller-known-secret" }));
  const r = resolveCoreRedactor({ proxy: { server: "http://p:8080", password: "override-only-long-secret" }, secrets });
  const out = r("driver echoed override-only-long-secret and caller-known-secret");
  assert.ok(!out.includes("override-only-long-secret"), "the option override password is scrubbed (unioned in)");
  assert.ok(!out.includes("caller-known-secret"), "the caller secret is scrubbed too");
  // An unredactable option cred fails closed even WITH a caller store.
  assert.throws(() => resolveCoreRedactor({ proxy: { server: "http://p:8080", password: "ab" }, secrets }), /too short/);
});

test("resolveCoreRedactor: single-pass union scrubs whole values in BOTH overlap directions (no fragmentation)", async () => {
  const { resolveCoreRedactor } = await import("../dist/browser/patchright-core.js");
  const { SecretStore } = await import("../dist/security/index.js");
  // Direction 1: a caller secret ("pwd") is a SUBSTRING of the option minted password.
  // Direction 2: an option username ("opt-user") is a SUBSTRING of a caller-only secret.
  const secrets = new SecretStore(() => ({ BGW_PROXY_PASSWORD: "pwd", BGW_CAPTCHA_API_KEY: "prefix-opt-user-suffix-secret" }));
  const minted = "pwd_country-us_session-abcd1234_lifetime-30m";
  const r = resolveCoreRedactor({ proxy: { server: "http://p:8080", username: "opt-user", password: minted }, secrets });
  const out = r(`ERR pass=${minted} caller=prefix-opt-user-suffix-secret`);
  assert.ok(!out.includes(minted) && !out.includes("pwd_country"), "the whole minted password is scrubbed (base-substring direction)");
  assert.ok(!out.includes("prefix-opt-user-suffix-secret") && !out.includes("prefix-") && !out.includes("-suffix-secret"), "the whole caller secret is scrubbed (option-username-substring direction)");
});

test("resolveCoreRedactor: a plain direct launch (no proxy/solver) needs no redactor", async () => {
  const { resolveCoreRedactor } = await import("../dist/browser/patchright-core.js");
  assert.equal(resolveCoreRedactor({}), undefined);
  assert.equal(resolveCoreRedactor({ channel: "chrome" }), undefined);
});

test("resolveCoreRedactor: a proxy/solver launch without a redactor DEFAULTS to a scrubber (env + option creds)", async () => {
  const { resolveCoreRedactor } = await import("../dist/browser/patchright-core.js");
  const prev = process.env.BGW_PROXY_PASSWORD;
  process.env.BGW_PROXY_PASSWORD = "env-base-secret-value";
  try {
    // Option-supplied password DIFFERS from and is ABSENT in the environment (a gateway override / minted
    // sticky password) — the default must scrub it too, not only the env value.
    const r1 = resolveCoreRedactor({
      proxy: { server: "http://exit.example:8080", username: "opt-user-name", password: "override-only-proxy-secret" },
    });
    assert.equal(typeof r1, "function", "a proxy launch gets a default redactor");
    const line = r1("net::ERR auth override-only-proxy-secret + env-base-secret-value + opt-user-name failed");
    assert.ok(!line.includes("override-only-proxy-secret"), "the OPTION-supplied password is scrubbed even though it isn't in the env");
    assert.ok(!line.includes("env-base-secret-value"), "the env secret is also scrubbed");
    assert.ok(!line.includes("opt-user-name"), "the option username is scrubbed");
    const r2 = resolveCoreRedactor({ solver: { solve: async () => "t" } });
    assert.equal(typeof r2, "function", "a solver launch gets a default redactor");
    // An option-only UNREDACTABLE (<3) proxy password fails closed (guarded registration), rather than
    // being registered-but-skipped and then leaked.
    assert.throws(() => resolveCoreRedactor({ proxy: { server: "http://p:8080", password: "ab" } }), /too short/);
  } finally {
    if (prev === undefined) delete process.env.BGW_PROXY_PASSWORD;
    else process.env.BGW_PROXY_PASSWORD = prev;
  }
});

test("CAPTCHA_SOLVE_ERROR_CODES: the solve-failure sink allowlist covers known codes, excludes arbitrary ones", async () => {
  const { CAPTCHA_SOLVE_ERROR_CODES } = await import("../dist/browser/captcha.js");
  const set = new Set(CAPTCHA_SOLVE_ERROR_CODES);
  assert.ok(set.has("timeout") && set.has("vendor-error") && set.has("budget-exhausted"), "known codes are allowlisted");
  assert.ok(!set.has("a-custom-solver-code-with-a-secret"), "an arbitrary/custom code is NOT allowlisted (logged as generic 'error')");
});
