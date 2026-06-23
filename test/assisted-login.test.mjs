/**
 * Unit tests for the assisted-login orchestration (U6 — credential vault Phase 2).
 *
 * The bug-prone logic — polling an async-rendered field, the credential→2FA ordering, judging
 * success on the settled DOM, filling only an empty field — is exercised here against a scripted
 * fake LoginDriver, with zero browser. The live path (a real Chrome driving a fixture login form) is
 * proven by scripts/validate-assisted-login.mjs, matching the repo's pure-logic-here / browser-there
 * split.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { assistedLogin, generateTotp } from "../dist/verbs/index.js";

const SEED = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"; // 160-bit
const AT = 1700000000; // pin TOTP time → generateTotp(SEED, AT) === "406058"

const SEL = { user: "#user", pass: "#pass", submit: "#submit", totp: "#totp", dash: "#dash" };

const RECIPE = {
  loginUrl: "https://target.example/login",
  usernameField: SEL.user,
  passwordField: SEL.pass,
  submit: SEL.submit,
  successText: "AUTHENTICATED DASHBOARD",
};

const CAPTURED = {
  cookies: [{ name: "sid", value: "ok", domain: "target.example", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }],
  origins: [],
};

/**
 * A scripted fake of the login flow. Phases: form → (credential submit) → dashboard | twofa | error;
 * twofa → (code submit) → dashboard | error. Fields can render after N polls; values can be
 * pre-filled. Records every fill/submit/capture/wait for assertions.
 */
function makeFakeDriver(cfg = {}) {
  const {
    usernameDelay = 0,
    passwordDelay = 0,
    totpDelay = 0,
    successDelay = 0, // polls (waits) after submit before the dashboard "renders" — models an SPA/fetch login
    prefilled = {},
    requires2fa = false,
    acceptCreds = true,
    acceptCode = () => true,
    captured = CAPTURED,
  } = cfg;

  let phase = "form";
  let dashReadyAt = Infinity; // wait-count at which a "dashboard" phase actually shows the success DOM
  const polls = { [SEL.user]: 0, [SEL.pass]: 0, [SEL.totp]: 0 };
  const values = { [SEL.user]: prefilled.username ?? "", [SEL.pass]: prefilled.password ?? "", [SEL.totp]: "" };
  const log = { navigations: [], fills: [], submits: [], captures: 0, waits: 0, waitedMs: 0 };
  const dashReady = () => phase === "dashboard" && log.waits >= dashReadyAt;

  const present = (target) => {
    if (phase === "form") {
      if (target === SEL.user) return polls[SEL.user]++ >= usernameDelay;
      if (target === SEL.pass) return polls[SEL.pass]++ >= passwordDelay;
      return false;
    }
    if (phase === "twofa") return target === SEL.totp ? polls[SEL.totp]++ >= totpDelay : false;
    return false;
  };

  const driver = {
    async navigate(url) {
      log.navigations.push(url);
      phase = "form";
    },
    async readField(target) {
      const p = present(target);
      return { present: p, value: p ? values[target] ?? "" : "" };
    },
    async fill(target, text) {
      values[target] = text;
      log.fills.push({ target, text });
    },
    async submit(target) {
      log.submits.push(target);
      if (phase === "form") phase = !acceptCreds ? "error" : requires2fa ? "twofa" : "dashboard";
      else if (phase === "twofa") phase = acceptCode(values[SEL.totp]) ? "dashboard" : "error";
      if (phase === "dashboard") dashReadyAt = log.waits + successDelay; // success DOM appears after N polls
    },
    async settledText() {
      if (phase === "dashboard") return dashReady() ? "AUTHENTICATED DASHBOARD" : "Signing in…";
      return phase === "twofa" ? "Enter your 2FA code" : phase === "error" ? "Invalid credentials" : "Sign in";
    },
    async hasElement(target) {
      return target === SEL.dash && dashReady();
    },
    async captureState() {
      log.captures++;
      return captured;
    },
    async wait(ms) {
      log.waits++;
      log.waitedMs += ms; // sum the REQUESTED sleep so a test can assert the timeout upper bound
    },
  };
  return { driver, log };
}

const FAST = { fieldTimeoutMs: 200, pollIntervalMs: 10, totpAtSeconds: AT };

test("happy path (no 2FA): fills creds, submits, judges success, captures state", async () => {
  const { driver, log } = makeFakeDriver();
  const res = await assistedLogin(driver, RECIPE, { username: "me@x.com", password: "pw" }, FAST);
  assert.deepEqual(res.state, CAPTURED);
  assert.deepEqual(log.fills.map((f) => f.target), [SEL.user, SEL.pass]);
  assert.deepEqual(log.submits, [SEL.submit]);
  assert.equal(log.captures, 1);
});

test("skipInitialNavigate: the primitive does not navigate (the caller already landed the page)", async () => {
  const { driver, log } = makeFakeDriver(); // phase starts at "form" → fields present without a navigate
  const res = await assistedLogin(driver, RECIPE, { username: "u", password: "p" }, { ...FAST, skipInitialNavigate: true });
  assert.deepEqual(res.state, CAPTURED);
  assert.equal(log.navigations.length, 0, "no navigate when the caller already landed the login page");
  assert.deepEqual(log.fills.map((f) => f.target), [SEL.user, SEL.pass], "still fills + submits");
  assert.deepEqual(log.submits, [SEL.submit]);
});

test("async-rendered fields are polled into existence, then filled", async () => {
  const { driver, log } = makeFakeDriver({ usernameDelay: 3, passwordDelay: 2 });
  await assistedLogin(driver, RECIPE, { username: "u", password: "p" }, FAST);
  assert.equal(log.fills.find((f) => f.target === SEL.user)?.text, "u");
  assert.ok(log.waits > 0, "polled (waited) before the fields rendered");
});

test("SPA login: success rendered asynchronously after submit is polled, not failed (PR #30 P1)", async () => {
  // The dashboard DOM appears only after several polls post-submit (fetch/client render) — a one-shot
  // judge would throw "did not reach". The bounded success poll must wait it out.
  const { driver, log } = makeFakeDriver({ successDelay: 4 });
  const res = await assistedLogin(driver, RECIPE, { username: "u", password: "p" }, FAST);
  assert.deepEqual(res.state, CAPTURED);
  assert.ok(log.waits >= 4, "polled the success condition while the SPA rendered");
  assert.equal(log.captures, 1);
});

test("SPA 2FA: dashboard rendered asynchronously after the code submit is polled, not failed", async () => {
  const recipe = { ...RECIPE, totpField: SEL.totp };
  const { driver } = makeFakeDriver({ requires2fa: true, successDelay: 3 });
  const res = await assistedLogin(driver, recipe, { username: "u", password: "p", totpSeed: SEED }, FAST);
  assert.deepEqual(res.state, CAPTURED);
});

test("the configured timeout is a true upper bound — final sleep clamped to remaining (PR #30 P2 round 2)", async () => {
  // timeout 1ms < interval 25ms: the one sleep must be clamped to 1ms, not the full 25ms (the
  // overshoot the clamp removes; the real core would otherwise block up to its 60s wait cap).
  const TIGHT = { fieldTimeoutMs: 1, pollIntervalMs: 25 };

  // settleAfterSubmit loop: wrong creds → polls to timeout.
  const a = makeFakeDriver({ acceptCreds: false });
  await assert.rejects(() => assistedLogin(a.driver, RECIPE, { username: "u", password: "p" }, TIGHT));
  assert.ok(a.log.waitedMs <= 1, `settle loop waited ${a.log.waitedMs}ms, must not exceed the 1ms timeout`);

  // pollField loop: username never renders.
  const b = makeFakeDriver({ usernameDelay: 9999 });
  await assert.rejects(() => assistedLogin(b.driver, RECIPE, { username: "u", password: "p" }, TIGHT));
  assert.ok(b.log.waitedMs <= 1, `field poll waited ${b.log.waitedMs}ms, must not exceed the 1ms timeout`);

  // pollSuccess loop (post-2FA): code submitted, dashboard never renders → polls to timeout.
  const recipe = { ...RECIPE, totpField: SEL.totp };
  const c = makeFakeDriver({ requires2fa: true, acceptCode: () => false });
  await assert.rejects(() => assistedLogin(c.driver, recipe, { username: "u", password: "p", totpSeed: SEED }, TIGHT));
  assert.ok(c.log.waitedMs <= 1, `success poll waited ${c.log.waitedMs}ms, must not exceed the 1ms timeout`);
});

test("invalid poll options are rejected up front, not spun on (PR #30 P2)", async () => {
  const { driver } = makeFakeDriver();
  const creds = { username: "u", password: "p" };
  for (const bad of [0, -5, Infinity, NaN]) {
    await assert.rejects(
      () => assistedLogin(driver, RECIPE, creds, { pollIntervalMs: bad }),
      /pollIntervalMs must be a finite, positive number/,
      `pollIntervalMs=${bad} must be rejected`,
    );
  }
  for (const bad of [-1, Infinity, NaN]) {
    await assert.rejects(
      () => assistedLogin(driver, RECIPE, creds, { fieldTimeoutMs: bad }),
      /fieldTimeoutMs must be a finite, non-negative number/,
      `fieldTimeoutMs=${bad} must be rejected`,
    );
  }
});

test("2FA path: a generated TOTP code is filled and submitted, then success", async () => {
  const recipe = { ...RECIPE, totpField: SEL.totp };
  const code = generateTotp(SEED, AT); // "406058"
  const { driver, log } = makeFakeDriver({ requires2fa: true, acceptCode: (c) => c === code });
  const res = await assistedLogin(driver, recipe, { username: "u", password: "p", totpSeed: SEED }, FAST);
  assert.deepEqual(res.state, CAPTURED);
  const totpFill = log.fills.find((f) => f.target === SEL.totp);
  assert.equal(totpFill?.text, code);
  assert.deepEqual(log.submits, [SEL.submit, SEL.submit]); // creds + 2FA
  assert.equal(log.captures, 1);
});

test("2FA prompted but no seed configured → clear throw, no capture", async () => {
  const recipe = { ...RECIPE, totpField: SEL.totp };
  const { driver, log } = makeFakeDriver({ requires2fa: true });
  await assert.rejects(
    () => assistedLogin(driver, recipe, { username: "u", password: "p" }, FAST),
    /2FA code but no TOTP seed/,
  );
  assert.equal(log.captures, 0, "never captures a half-authenticated state");
});

test("recipe declares a 2FA field but the target does not prompt → no 2FA wait, success", async () => {
  // requires2fa:false → credential submit reaches the dashboard; the success judge passes immediately
  // so the 2FA field is never polled (the no-2FA target pays no 2FA cost).
  const recipe = { ...RECIPE, totpField: SEL.totp };
  const { driver, log } = makeFakeDriver({ requires2fa: false });
  await assistedLogin(driver, recipe, { username: "u", password: "p", totpSeed: SEED }, FAST);
  assert.ok(!log.fills.some((f) => f.target === SEL.totp), "no TOTP fill");
  assert.deepEqual(log.submits, [SEL.submit]); // only the credential submit
});

test("wrong credentials → judged failed on the settled DOM, throws, no capture", async () => {
  const { driver, log } = makeFakeDriver({ acceptCreds: false });
  await assert.rejects(
    () => assistedLogin(driver, RECIPE, { username: "u", password: "bad" }, FAST),
    /did not reach the authenticated page/,
  );
  assert.equal(log.captures, 0);
});

test("a field that never renders within the window → clear throw", async () => {
  const { driver } = makeFakeDriver({ usernameDelay: 9999 });
  await assert.rejects(
    () => assistedLogin(driver, RECIPE, { username: "u", password: "p" }, FAST),
    /username field never rendered/,
  );
});

test("a pre-filled field (browser-remembered) is left intact, not re-typed", async () => {
  const { driver, log } = makeFakeDriver({ prefilled: { username: "remembered@x.com" } });
  await assistedLogin(driver, RECIPE, { username: "typed@x.com", password: "p" }, FAST);
  assert.ok(!log.fills.some((f) => f.target === SEL.user), "username already filled → not overwritten");
  assert.ok(log.fills.some((f) => f.target === SEL.pass), "empty password still filled");
});

test("successSelector judges success when the authenticated element is present", async () => {
  const recipe = { loginUrl: RECIPE.loginUrl, usernameField: SEL.user, passwordField: SEL.pass, submit: SEL.submit, successSelector: SEL.dash };
  const { driver } = makeFakeDriver();
  const res = await assistedLogin(driver, recipe, { username: "u", password: "p" }, FAST);
  assert.deepEqual(res.state, CAPTURED);
});

test("a recipe with no success condition is rejected up front", async () => {
  const recipe = { loginUrl: RECIPE.loginUrl, usernameField: SEL.user, passwordField: SEL.pass, submit: SEL.submit };
  const { driver } = makeFakeDriver();
  await assert.rejects(() => assistedLogin(driver, recipe, { username: "u", password: "p" }, FAST), /success condition/);
});
