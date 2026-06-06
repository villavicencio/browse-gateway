/**
 * HttpCaptchaSolver tests — the vendor-neutral createTask/getTaskResult solver behind the
 * CaptchaSolver seam. Pure unit tests with an injected fetch + clock; no network, no real service.
 * Cover the happy path per kind, typed failures (vendor error / timeout / missing inputs / budget),
 * and the R9 guarantee that the API key never leaks into an error message.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HttpCaptchaSolver,
  CaptchaSolveError,
  httpCaptchaSolverFromSecrets,
} from "../dist/verbs/index.js";
import { SecretStore } from "../dist/security/index.js";

const KEY = "secret-key-abcdef3210";
const URL_BASE = "https://solver.invalid/api";

/** Fake fetch that replays a queue of {body, ok?, status?} in call order (last entry repeats). */
function fakeFetch(queue) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const r = queue[Math.min(calls.length - 1, queue.length - 1)];
    return { ok: r.ok ?? true, status: r.status ?? 200, json: async () => r.body };
  };
  fn.calls = calls;
  return fn;
}

const solverWith = (fetchImpl, over = {}) =>
  new HttpCaptchaSolver({ apiKey: KEY, apiUrl: URL_BASE, pollMs: 1, timeoutMs: 1000, fetchImpl, ...over });

const recaptcha = { kind: "recaptcha", url: "https://site.example/login", siteKey: "sk-123" };

test("solves reCAPTCHA → returns the gRecaptchaResponse token", async () => {
  const f = fakeFetch([
    { body: { errorId: 0, taskId: "task-1" } },
    { body: { errorId: 0, status: "processing" } },
    { body: { errorId: 0, status: "ready", solution: { gRecaptchaResponse: "TOKEN-XYZ" } } },
  ]);
  const token = await solverWith(f).solve(recaptcha);
  assert.equal(token, "TOKEN-XYZ");
  // createTask carried the right task type + the key in the body (never elsewhere)
  assert.equal(f.calls[0].url, `${URL_BASE}/createTask`);
  assert.equal(f.calls[0].body.task.type, "ReCaptchaV2TaskProxyLess");
  assert.equal(f.calls[0].body.task.websiteKey, "sk-123");
  assert.equal(f.calls[0].body.clientKey, KEY);
});

test("solves Turnstile → reads the `token` solution field", async () => {
  const f = fakeFetch([
    { body: { errorId: 0, taskId: "t2" } },
    { body: { errorId: 0, status: "ready", solution: { token: "TS-TOKEN" } } },
  ]);
  const token = await solverWith(f).solve({ kind: "turnstile", url: "https://t.example/", siteKey: "0x4" });
  assert.equal(token, "TS-TOKEN");
  assert.equal(f.calls[0].body.task.type, "AntiTurnstileTaskProxyLess");
});

test("createTask error → typed vendor-error", async () => {
  const f = fakeFetch([{ body: { errorId: 1, errorCode: "ERROR_KEY", errorDescription: "bad key" } }]);
  await assert.rejects(solverWith(f).solve(recaptcha), (e) => {
    assert.ok(e instanceof CaptchaSolveError);
    assert.equal(e.code, "vendor-error");
    return true;
  });
});

test("getTaskResult error → typed vendor-error", async () => {
  const f = fakeFetch([
    { body: { errorId: 0, taskId: "t3" } },
    { body: { errorId: 1, errorCode: "ERROR_CAPTCHA_UNSOLVABLE", errorDescription: "nope" } },
  ]);
  await assert.rejects(solverWith(f).solve(recaptcha), (e) => e.code === "vendor-error");
});

test("never-ready → typed timeout, not a hang", async () => {
  const f = fakeFetch([
    { body: { errorId: 0, taskId: "t4" } },
    { body: { errorId: 0, status: "processing" } },
  ]);
  await assert.rejects(solverWith(f, { timeoutMs: 30, pollMs: 5 }).solve(recaptcha), (e) => e.code === "timeout");
});

test("missing siteKey → missing-sitekey (no fetch)", async () => {
  const f = fakeFetch([{ body: {} }]);
  await assert.rejects(solverWith(f).solve({ kind: "recaptcha", url: "https://x/" }), (e) => e.code === "missing-sitekey");
  assert.equal(f.calls.length, 0);
});

test("unknown kind → unsupported-kind", async () => {
  const f = fakeFetch([{ body: {} }]);
  await assert.rejects(solverWith(f).solve({ kind: "unknown", url: "https://x/", siteKey: "k" }), (e) => e.code === "unsupported-kind");
});

test("not configured (empty key) → not-configured", async () => {
  const f = fakeFetch([{ body: {} }]);
  const s = new HttpCaptchaSolver({ apiKey: "", apiUrl: URL_BASE, fetchImpl: f });
  await assert.rejects(s.solve(recaptcha), (e) => e.code === "not-configured");
});

test("per-window budget → second concurrent solve refused", async () => {
  const f = fakeFetch([
    { body: { errorId: 0, taskId: "t5" } },
    { body: { errorId: 0, status: "ready", solution: { gRecaptchaResponse: "OK" } } },
  ]);
  const s = solverWith(f, { budget: { maxSolves: 1, windowMs: 60_000 } });
  assert.equal(await s.solve(recaptcha), "OK");
  await assert.rejects(s.solve(recaptcha), (e) => e.code === "budget-exhausted");
});

test("transport failure does NOT leak the API key", async () => {
  const f = async () => {
    throw new Error("connect ECONNREFUSED");
  };
  await assert.rejects(solverWith(f).solve(recaptcha), (e) => {
    assert.equal(e.code, "vendor-error");
    assert.ok(!e.message.includes(KEY), "error message must not contain the API key");
    return true;
  });
});

test("factory: absent without key or url, present with both", () => {
  const withKey = new SecretStore(() => ({ BGW_CAPTCHA_API_KEY: KEY }));
  const noKey = new SecretStore(() => ({}));
  assert.equal(httpCaptchaSolverFromSecrets(noKey, URL_BASE), undefined);
  assert.equal(httpCaptchaSolverFromSecrets(withKey, undefined), undefined);
  assert.ok(httpCaptchaSolverFromSecrets(withKey, URL_BASE) instanceof HttpCaptchaSolver);
});
