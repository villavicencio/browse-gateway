/**
 * #43 — env-overridable per-call time bounds. Pure env parsing (loadCallTimeouts): each BGW_*_MS override
 * with a strict decimal-integer parse and a safe default, so behavior is unchanged when unset.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCallTimeouts, DEFAULT_CALL_TIMEOUTS } from "../dist/gateway/index.js";
import { deadlineBoundedTimeout } from "../dist/browser/index.js";

test("#43 loadCallTimeouts: an empty env yields exactly the shipped defaults", () => {
  assert.deepEqual(loadCallTimeouts({}), DEFAULT_CALL_TIMEOUTS);
});

test("#43 loadCallTimeouts: each BGW_*_MS override is applied", () => {
  const t = loadCallTimeouts({
    BGW_CALL_BUDGET_MS: "45000",
    BGW_CLEARANCE_TIMEOUT_MS: "10000",
    BGW_PROXY_CLEARANCE_TIMEOUT_MS: "30000",
    BGW_PROXY_NAV_TIMEOUT_MS: "15000",
    BGW_PROXY_MAX_ATTEMPTS: "2",
    BGW_CAPTCHA_SOLVE_TIMEOUT_MS: "60000",
  });
  assert.deepEqual(t, {
    callBudgetMs: 45000,
    clearanceTimeoutMs: 10000,
    proxyClearanceTimeoutMs: 30000,
    proxyNavTimeoutMs: 15000,
    proxyMaxAttempts: 2,
    captchaSolveTimeoutMs: 60000,
  });
});

test("#43 loadCallTimeouts: a malformed/zero/negative override falls back to the default (strict parse)", () => {
  // positiveIntOr rejects non-decimal, zero, negative, hex/float/exponent — no silent bad bound.
  for (const bad of ["0", "-5", "9.5", "1e3", "0x10", "abc", " ", "12x"]) {
    assert.equal(loadCallTimeouts({ BGW_CALL_BUDGET_MS: bad }).callBudgetMs, DEFAULT_CALL_TIMEOUTS.callBudgetMs, `"${bad}" → default`);
  }
  // A valid override alongside a bad one: the valid one applies, the bad one defaults.
  const t = loadCallTimeouts({ BGW_PROXY_MAX_ATTEMPTS: "5", BGW_PROXY_NAV_TIMEOUT_MS: "nope" });
  assert.equal(t.proxyMaxAttempts, 5);
  assert.equal(t.proxyNavTimeoutMs, DEFAULT_CALL_TIMEOUTS.proxyNavTimeoutMs);
});

test("#43 deadlineBoundedTimeout: clamps a stage to the remaining time until the shared deadline (codex r5)", () => {
  // Unbudgeted (no deadline) → raw timeout unchanged.
  assert.equal(deadlineBoundedTimeout(25000, undefined, 1000, 1), 25000);
  // Plenty of time left → the raw timeout wins (it's the smaller bound).
  assert.equal(deadlineBoundedTimeout(25000, 100000, 1000, 1), 25000); // 99000 left, cap 25000
  // Near the deadline → clamped to the remainder (this is the fix: nav+clearance can't each take the full budget).
  assert.equal(deadlineBoundedTimeout(45000, 5000, 4000, 0), 1000); // only 1000ms left
  // Past the deadline → the floor (nav floors at 1 to avoid Playwright's 0=infinite; clearance floors at 0).
  assert.equal(deadlineBoundedTimeout(45000, 5000, 6000, 1), 1);
  assert.equal(deadlineBoundedTimeout(45000, 5000, 6000, 0), 0);
});
