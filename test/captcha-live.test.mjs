/**
 * Phase-2 pure logic: the "never speculatively solve" gate (liveCaptchaToChallenge) and the
 * token-injection script builder (injectTokenJs). The live DOM read + the actual core auto-solve
 * (PatchrightBrowserCore #trySolveCaptcha) are exercised in-browser by the spike/validate scripts,
 * not here — the same split as the rest of browser-core (pure logic unit-tested; real browser via
 * validate-*).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  liveCaptchaToChallenge,
  injectTokenJs,
  DETECT_LIVE_CAPTCHA_JS,
} from "../dist/browser/index.js";

const URL = "https://site.example/login";

test("liveCaptchaToChallenge: nothing to solve → null", () => {
  assert.equal(liveCaptchaToChallenge(null, URL), null);
  // already solved (response field non-empty)
  assert.equal(liveCaptchaToChallenge({ kind: "recaptcha", siteKey: "k", responseEmpty: false }, URL), null);
  // no sitekey to solve against
  assert.equal(liveCaptchaToChallenge({ kind: "recaptcha", siteKey: "", responseEmpty: true }, URL), null);
});

test("liveCaptchaToChallenge: rendered, unsolved widget → a challenge carrying kind/url/siteKey", () => {
  const challenge = liveCaptchaToChallenge({ kind: "recaptcha", siteKey: "sk-7", responseEmpty: true }, URL);
  assert.deepEqual(challenge, { kind: "recaptcha", url: URL, siteKey: "sk-7" });
});

test("injectTokenJs: reCAPTCHA sets the response field + best-effort callback", () => {
  const js = injectTokenJs("recaptcha", "TOKEN-1");
  assert.match(js, /g-recaptcha-response/);
  assert.match(js, /___grecaptcha_cfg/); // callback traversal for callback-only integrations
  assert.match(js, /"TOKEN-1"/); // token is embedded as a JSON string literal
});

test("injectTokenJs: Turnstile + hCaptcha target their own response fields", () => {
  assert.match(injectTokenJs("turnstile", "TS"), /cf-turnstile-response/);
  const hc = injectTokenJs("hcaptcha", "HC");
  assert.match(hc, /h-captcha-response/);
});

test("injectTokenJs: token is JSON-encoded so quotes/backslashes can't break out of the script", () => {
  const nasty = 'a"b\\c</script>';
  const js = injectTokenJs("recaptcha", nasty);
  // The raw value must not appear unescaped; the JSON-encoded form must.
  assert.ok(js.includes(JSON.stringify(nasty)));
  assert.ok(!js.includes('= a"b\\c'));
});

test("DETECT_LIVE_CAPTCHA_JS: an evaluatable script covering the three response fields", () => {
  assert.equal(typeof DETECT_LIVE_CAPTCHA_JS, "string");
  for (const f of ["g-recaptcha-response", "cf-turnstile-response", "h-captcha-response", "data-sitekey"]) {
    assert.match(DETECT_LIVE_CAPTCHA_JS, new RegExp(f));
  }
});
