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
  liveCaptchaPendingRender,
  awaitSolvableCaptcha,
  injectTokenJs,
  DETECT_LIVE_CAPTCHA_JS,
  isSolvableCaptchaKind,
  resolveCaptchaSolveReason,
  preAttemptSolveReason,
  CAPTCHA_SOLVE_ERROR_CODES,
} from "../dist/browser/index.js";

const URL = "https://site.example/login";

test("liveCaptchaToChallenge: nothing to solve → null", () => {
  assert.equal(liveCaptchaToChallenge(null, URL), null);
  // already solved (response field filled, respLen > 0)
  assert.equal(liveCaptchaToChallenge({ kind: "recaptcha", siteKey: "k", respLen: 14 }, URL), null);
  // not rendered yet (response field absent, respLen -1) — solvable only once it renders empty
  assert.equal(liveCaptchaToChallenge({ kind: "recaptcha", siteKey: "k", respLen: -1 }, URL), null);
  // no sitekey to solve against
  assert.equal(liveCaptchaToChallenge({ kind: "recaptcha", siteKey: "", respLen: 0 }, URL), null);
});

test("liveCaptchaToChallenge: rendered, unsolved widget (respLen 0) → a challenge carrying kind/url/siteKey", () => {
  const challenge = liveCaptchaToChallenge({ kind: "recaptcha", siteKey: "sk-7", respLen: 0 }, URL);
  assert.deepEqual(challenge, { kind: "recaptcha", url: URL, siteKey: "sk-7" });
});

test("liveCaptchaPendingRender: container present but field absent (respLen -1) → true (wait, don't skip)", () => {
  assert.equal(liveCaptchaPendingRender({ kind: "recaptcha", siteKey: "k", respLen: -1 }), true);
});

test("liveCaptchaPendingRender: empty/filled field, no sitekey, or no widget → false (nothing to wait for)", () => {
  assert.equal(liveCaptchaPendingRender({ kind: "recaptcha", siteKey: "k", respLen: 0 }), false); // solvable now
  assert.equal(liveCaptchaPendingRender({ kind: "recaptcha", siteKey: "k", respLen: 9 }), false); // already solved
  assert.equal(liveCaptchaPendingRender({ kind: "recaptcha", siteKey: "", respLen: -1 }), false); // no sitekey
  assert.equal(liveCaptchaPendingRender(null), false);
});

test("awaitSolvableCaptcha: solves a widget that renders its response field LATE (the navigate-at-DCL race)", async () => {
  // Container present immediately (sitekey known) but the response field is injected by an async
  // script: respLen -1 (absent) on the first two reads, then 0 (rendered, empty). The gate must WAIT
  // across the un-rendered reads, not skip on the first miss — that was the prod render-race bug.
  const reads = [
    { kind: "recaptcha", siteKey: "sk-late", respLen: -1 },
    { kind: "recaptcha", siteKey: "sk-late", respLen: -1 },
    { kind: "recaptcha", siteKey: "sk-late", respLen: 0 },
  ];
  let i = 0;
  let waits = 0;
  const challenge = await awaitSolvableCaptcha(
    async () => reads[Math.min(i++, reads.length - 1)],
    () => URL,
    async () => { waits++; },
    { pollMs: 5, timeoutMs: 1000 },
  );
  assert.deepEqual(challenge, { kind: "recaptcha", url: URL, siteKey: "sk-late" });
  assert.equal(waits, 2); // waited across the two un-rendered reads, then solved on the third
});

test("awaitSolvableCaptcha: no widget → null immediately, no waiting", async () => {
  let waits = 0;
  const challenge = await awaitSolvableCaptcha(
    async () => null,
    () => URL,
    async () => { waits++; },
    { pollMs: 5, timeoutMs: 1000 },
  );
  assert.equal(challenge, null);
  assert.equal(waits, 0);
});

test("awaitSolvableCaptcha: already-solved widget (filled field) → null immediately, no speculative solve", async () => {
  let waits = 0;
  const challenge = await awaitSolvableCaptcha(
    async () => ({ kind: "turnstile", siteKey: "k", respLen: 22 }),
    () => URL,
    async () => { waits++; },
    { pollMs: 5, timeoutMs: 1000 },
  );
  assert.equal(challenge, null);
  assert.equal(waits, 0);
});

test("awaitSolvableCaptcha: a container that never renders its field → null after the render budget", async () => {
  let waits = 0;
  const challenge = await awaitSolvableCaptcha(
    async () => ({ kind: "recaptcha", siteKey: "k", respLen: -1 }), // perpetually un-rendered
    () => URL,
    async () => { waits++; },
    { pollMs: 100, timeoutMs: 300 },
  );
  assert.equal(challenge, null);
  assert.ok(waits >= 3, `expected ~3 polls before giving up, got ${waits}`);
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

// --- #44: solver eligibility + solve-reason (pure derivation, unit-tested off the real core) ---------

test("#44 isSolvableCaptchaKind: recaptcha/turnstile/hcaptcha are solvable; unknown is not", () => {
  for (const k of ["recaptcha", "turnstile", "hcaptcha"]) {
    assert.equal(isSolvableCaptchaKind(k), true, `${k} is solvable (the solver maps it to a task type)`);
  }
  assert.equal(isSolvableCaptchaKind("unknown"), false);
});

test("#44 resolveCaptchaSolveReason: no CAPTCHA detected → undefined", () => {
  assert.equal(resolveCaptchaSolveReason({ captchaKind: undefined, solverPresent: true }), undefined);
  assert.equal(resolveCaptchaSolveReason({ captchaKind: undefined, solverPresent: false, attemptReason: "timeout" }), undefined);
});

test("#44 resolveCaptchaSolveReason: an actual attempt failure code wins for EVERY code + `error`", () => {
  // AC: each CAPTCHA_SOLVE_ERROR_CODES value is threaded out distinctly (was stderr-only), plus the
  // allowlist-collapsed `error` for an unrecognized code from a custom solver.
  for (const code of [...CAPTCHA_SOLVE_ERROR_CODES, "error"]) {
    // attemptReason wins over the pre-attempt why-not regardless of solver presence / kind solvability.
    assert.equal(resolveCaptchaSolveReason({ captchaKind: "recaptcha", solverPresent: true, attemptReason: code }), code);
    assert.equal(resolveCaptchaSolveReason({ captchaKind: "hcaptcha", solverPresent: false, attemptReason: code }), code);
  }
});

test("#44 resolveCaptchaSolveReason: pre-attempt why-not when no attempt was made", () => {
  // No solver wired → not-configured (whatever the kind).
  assert.equal(resolveCaptchaSolveReason({ captchaKind: "recaptcha", solverPresent: false }), "not-configured");
  assert.equal(resolveCaptchaSolveReason({ captchaKind: "turnstile", solverPresent: false }), "not-configured");
  // Solver wired but the kind isn't solvable (only `unknown` is unsolvable) → unsupported-kind.
  assert.equal(resolveCaptchaSolveReason({ captchaKind: "unknown", solverPresent: true }), "unsupported-kind");
  // Solver wired and the kind IS solvable, no attempt failure → undefined (a solve may have succeeded).
  for (const k of ["recaptcha", "turnstile", "hcaptcha"]) {
    assert.equal(resolveCaptchaSolveReason({ captchaKind: k, solverPresent: true }), undefined, `${k} solvable, no failure → undefined`);
  }
});

test("#44 preAttemptSolveReason: a detected-but-unattemptable widget reports WHY (codex r2)", () => {
  // No live widget / already-solved / solvable-now → not a pre-attempt failure.
  assert.equal(preAttemptSolveReason(null), undefined);
  assert.equal(preAttemptSolveReason({ kind: "recaptcha", siteKey: "k", respLen: 5 }), undefined, "already solved");
  assert.equal(preAttemptSolveReason({ kind: "recaptcha", siteKey: "k", respLen: 0 }), undefined, "solvable-now (race)");
  // No sitekey to solve against → missing-sitekey (whatever the render state).
  assert.equal(preAttemptSolveReason({ kind: "hcaptcha", siteKey: "", respLen: -1 }), "missing-sitekey");
  assert.equal(preAttemptSolveReason({ kind: "hcaptcha", siteKey: "", respLen: 0 }), "missing-sitekey");
  // Sitekey present but the response field never rendered within the budget → timeout.
  assert.equal(preAttemptSolveReason({ kind: "turnstile", siteKey: "0x4", respLen: -1 }), "timeout");
});
