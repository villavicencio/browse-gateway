/**
 * The ordered search-provider router (VIL-123), on a deterministic clock.
 *
 * The load-bearing property is the DEADLINE INVARIANT: no provider holds the request past its own
 * budget, no attempt runs past the total deadline, and none starts with less than MIN_ATTEMPT_MS.
 * Every timing assertion below is exact because time only moves when the FakeClock fires a timer.
 *
 * Provider B in these tests is a deterministic fake by design: the second real provider planned for
 * this ticket (Google Custom Search JSON API) is closed to new customers and discontinued 2027-01-01,
 * so the router ships with fakes proving the fallback and a real second adapter is a follow-up.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSearchRouter, buildSearch, SearchAttemptsError, SearchProviderError, MIN_ATTEMPT_MS } from "../dist/search/index.js";
import { SecretStore } from "../dist/security/index.js";
import { FakeClock } from "./helpers/fake-clock.mjs";
import { DEFAULT_RESULTS, fakeSearchProvider } from "./helpers/fake-search-provider.mjs";

const REQ = { query: "a private query string", count: 10, safeSearch: "moderate" };
const PER = 8_000;
const TOTAL = 20_000;

/**
 * A provider that plays a script, one step per call (the last step repeats). Steps:
 *   { ok: true | results }               answer
 *   { fail: class, status?, retryAfterMs? }  throw a typed failure
 *   { stall: "signal" }                  never answer; reject only when ctx.signal aborts
 *   { stall: "ignore" }                  never settle at all — ignores deadline AND signal
 *   { delayMs }                          combined with ok/fail: take that long first (on the fake clock)
 */
function scripted(name, clock, steps) {
  const calls = [];
  let i = 0;
  return {
    name,
    calls,
    search(req, ctx) {
      const step = steps[Math.min(i++, steps.length - 1)];
      const call = { at: clock.now(), deadline: ctx.deadline, abortedAt: undefined };
      ctx.signal.addEventListener("abort", () => (call.abortedAt = clock.now()), { once: true });
      calls.push(call);
      return play(step, ctx, clock);
    },
  };
}

async function play(step, ctx, clock) {
  if (step.delayMs) await new Promise((r) => clock.setTimeout(r, step.delayMs));
  if (step.ok) return step.ok === true ? DEFAULT_RESULTS : step.ok;
  if (step.fail) {
    throw new SearchProviderError(step.fail, `scripted ${step.fail}`, {
      httpStatus: step.status ?? null,
      ...(step.retryAfterMs !== undefined ? { retryAfterMs: step.retryAfterMs } : {}),
    });
  }
  if (step.stall === "signal") {
    return new Promise((_, reject) =>
      ctx.signal.addEventListener("abort", () => reject(new SearchProviderError("timeout", "aborted by the router")), { once: true }),
    );
  }
  if (step.stall === "ignore") return new Promise(() => {});
  throw new Error("bad step");
}

function router(clock, providers, extra = {}) {
  return createSearchRouter({ providers, providerTimeoutMs: PER, totalTimeoutMs: TOTAL, clock, ...extra });
}

async function failureOf(clock, promise) {
  try {
    await clock.run(promise);
  } catch (err) {
    assert.ok(err instanceof SearchAttemptsError, `expected SearchAttemptsError, got ${err}`);
    return err;
  }
  assert.fail("expected the search to fail");
}

const summary = (attempts) =>
  attempts.map((a) => `${a.provider}:${a.skipped ? "skipped" : a.outcome === "failed" ? a.failureClass : a.outcome}:${a.durationMs}`);

// --- Fallback ---------------------------------------------------------------------------------------

test("A returns a classified 429, B succeeds → B's results, attempts A then B in order", async () => {
  const clock = new FakeClock();
  const a = scripted("a", clock, [{ fail: "rate-limited", status: 429 }]);
  const b = scripted("b", clock, [{ ok: true }]);
  const res = await clock.run(router(clock, [a, b]).search(REQ));
  assert.equal(res.provider, "b");
  assert.deepEqual(res.results, DEFAULT_RESULTS);
  assert.deepEqual(summary(res.attempts), ["a:rate-limited:0", "b:ok:0"]);
  assert.equal(res.attempts[0].httpStatus, 429);
});

test("order is honoured: [b, a] tries b first", async () => {
  const clock = new FakeClock();
  const a = scripted("a", clock, [{ ok: true }]);
  const b = scripted("b", clock, [{ ok: true }]);
  const res = await clock.run(router(clock, [b, a]).search(REQ));
  assert.equal(res.provider, "b");
  assert.equal(a.calls.length, 0, "the second provider must not be called when the first answers");
});

test("a provider rejecting the QUERY (unsupported-query) hands over to the next, which may have other limits", async () => {
  const clock = new FakeClock();
  const a = scripted("a", clock, [{ fail: "unsupported-query", status: 422 }]);
  const b = scripted("b", clock, [{ ok: true }]);
  const res = await clock.run(router(clock, [a, b]).search(REQ));
  assert.equal(res.provider, "b");
});

// --- The deadline invariant -------------------------------------------------------------------------

test("A stalls ignoring everything → abandoned at its own budget; B gets the REMAINING total", async () => {
  const clock = new FakeClock();
  const t0 = clock.now();
  const a = scripted("a", clock, [{ stall: "ignore" }]);
  const b = scripted("b", clock, [{ ok: true }]);
  const res = await clock.run(router(clock, [a, b]).search(REQ));
  assert.equal(res.provider, "b");
  assert.deepEqual(summary(res.attempts), [`a:timeout:${PER}`, "b:ok:0"]);
  assert.equal(b.calls[0].at, t0 + PER, "B must start the moment A's budget ends");
  assert.equal(b.calls[0].deadline, t0 + PER + PER, "B's deadline = its own budget (still inside the total)");
});

test("the router ABORTS ctx.signal at the attempt deadline (a signal-only provider is bounded)", async () => {
  // Carried over from #147: VIL-122 created an AbortController and never aborted it.
  const clock = new FakeClock();
  const t0 = clock.now();
  const a = scripted("a", clock, [{ stall: "signal" }]);
  const b = scripted("b", clock, [{ ok: true }]);
  await clock.run(router(clock, [a, b]).search(REQ));
  assert.equal(a.calls[0].abortedAt, t0 + PER, "the provider's signal must fire exactly at its deadline");
});

test("three providers each consuming their whole budget: the total deadline holds, outcome is distinct", async () => {
  const clock = new FakeClock();
  const t0 = clock.now();
  const ps = ["a", "b", "c"].map((n) => scripted(n, clock, [{ stall: "ignore" }]));
  const err = await failureOf(clock, router(clock, ps).search(REQ));
  assert.equal(err.failure.code, "total-deadline-exhausted");
  // a: 8 s, b: 8 s, c: clamped to the 4 s that remain — never its full 8 s.
  assert.deepEqual(summary(err.attempts), [`a:timeout:${PER}`, `b:timeout:${PER}`, "c:timeout:4000"]);
  assert.equal(ps[2].calls[0].deadline, t0 + TOTAL, "the last attempt's deadline is clamped to the total");
  assert.equal(clock.now() - t0, TOTAL, "the search ended exactly at the total deadline");
});

test("no attempt starts with less than MIN_ATTEMPT_MS left; the unstarted provider is not called", async () => {
  const clock = new FakeClock();
  const per = (TOTAL - MIN_ATTEMPT_MS + 100) / 2; // leaves MIN_ATTEMPT_MS - 100 for the third
  const ps = ["a", "b", "c"].map((n) => scripted(n, clock, [{ stall: "ignore" }]));
  const err = await failureOf(clock, createSearchRouter({ providers: ps, providerTimeoutMs: per, totalTimeoutMs: TOTAL, clock }).search(REQ));
  assert.equal(err.failure.code, "total-deadline-exhausted");
  assert.equal(err.attempts.length, 2);
  assert.equal(ps[2].calls.length, 0);
});

test("a per-provider budget larger than the total cannot monopolize it", async () => {
  const clock = new FakeClock();
  const t0 = clock.now();
  const a = scripted("a", clock, [{ stall: "ignore" }]);
  const err = await failureOf(clock, createSearchRouter({ providers: [a], providerTimeoutMs: 60_000, totalTimeoutMs: 5_000, clock }).search(REQ));
  assert.equal(err.failure.code, "total-deadline-exhausted");
  assert.equal(clock.now() - t0, 5_000);
});

test("total-deadline exhaustion is reported as such, not as whichever provider failed last", async () => {
  const clock = new FakeClock();
  const a = scripted("a", clock, [{ fail: "provider-unavailable", status: 503, delayMs: PER - 1 }]);
  const b = scripted("b", clock, [{ fail: "malformed-response", status: 200, delayMs: PER - 1 }]);
  const c = scripted("c", clock, [{ stall: "ignore" }]);
  const err = await failureOf(clock, router(clock, [a, b, c]).search(REQ));
  assert.equal(err.failure.code, "total-deadline-exhausted");
  assert.equal(err.attempts.length, 3);
});

test("a single provider timing out on its OWN budget is a timeout, not a total-deadline exhaustion", async () => {
  // Today's prod shape (Brave only, 8 s of a 20 s total): the class must stay what VIL-122 reported.
  const clock = new FakeClock();
  const a = scripted("a", clock, [{ stall: "ignore" }]);
  const err = await failureOf(clock, router(clock, [a]).search(REQ));
  assert.equal(err.failure.code, "timeout");
});

// --- Retry-After ------------------------------------------------------------------------------------

test("Retry-After that fits the provider budget → one retry on the same provider after exactly that wait", async () => {
  const clock = new FakeClock();
  const t0 = clock.now();
  const a = scripted("a", clock, [{ fail: "rate-limited", status: 429, retryAfterMs: 2_000 }, { ok: true }]);
  const b = scripted("b", clock, [{ ok: true }]);
  const r = router(clock, [a, b]);
  const res = await clock.run(r.search(REQ));
  assert.equal(res.provider, "a");
  assert.deepEqual(summary(res.attempts), ["a:rate-limited:0", "a:ok:0"]);
  assert.equal(a.calls[1].at, t0 + 2_000);
  assert.equal(a.calls[1].deadline, t0 + PER, "the retry spends the SAME provider budget, not a fresh one");
  assert.equal(b.calls.length, 0);
  assert.equal(r.metrics().providers.a.retries, 1);
});

test("Retry-After too long for the provider budget → move on immediately, no sleep", async () => {
  const clock = new FakeClock();
  const t0 = clock.now();
  const a = scripted("a", clock, [{ fail: "rate-limited", status: 429, retryAfterMs: PER - MIN_ATTEMPT_MS + 1 }]);
  const b = scripted("b", clock, [{ ok: true }]);
  const res = await clock.run(router(clock, [a, b]).search(REQ));
  assert.equal(res.provider, "b");
  assert.equal(b.calls[0].at, t0, "no time may be spent waiting on a Retry-After that cannot be used");
});

test("Retry-After that fits the provider budget but not the TOTAL → no retry", async () => {
  const clock = new FakeClock();
  const a = scripted("a", clock, [{ fail: "rate-limited", status: 429, retryAfterMs: 3_000 }, { ok: true }]);
  const err = await failureOf(clock, createSearchRouter({ providers: [a], providerTimeoutMs: 10_000, totalTimeoutMs: 3_200, clock }).search(REQ));
  assert.equal(err.failure.code, "rate-limited");
  assert.equal(err.failure.retryAfterMs, 3_000, "the advisory still reaches the caller");
  assert.equal(a.calls.length, 1);
});

test("a retry is made at most once per provider per search", async () => {
  const clock = new FakeClock();
  const a = scripted("a", clock, [{ fail: "rate-limited", status: 429, retryAfterMs: 1_000 }]);
  const err = await failureOf(clock, router(clock, [a]).search(REQ));
  assert.equal(a.calls.length, 2);
  assert.equal(err.failure.code, "rate-limited");
});

// --- Policy for auth / quota ------------------------------------------------------------------------

for (const code of ["authentication-failed", "quota-exhausted"]) {
  test(`${code}: never retried, breaker opens at once, the next search skips the provider`, async () => {
    const clock = new FakeClock();
    const a = scripted("a", clock, [{ fail: code, status: code === "quota-exhausted" ? 402 : 401, retryAfterMs: 1_000 }]);
    const b = scripted("b", clock, [{ ok: true }]);
    const r = router(clock, [a, b]);
    const first = await clock.run(r.search(REQ));
    assert.equal(first.provider, "b");
    assert.equal(a.calls.length, 1, `${code} must not be retried even with a Retry-After`);
    const second = await clock.run(r.search(REQ));
    assert.deepEqual(summary(second.attempts), ["a:skipped:0", "b:ok:0"]);
    assert.equal(second.attempts[0].skipped, true);
    assert.equal(a.calls.length, 1, "a skipped provider receives no request");
  });
}

test("when every provider fails, an operator-actionable class outranks the one that happened to be last", async () => {
  const clock = new FakeClock();
  const a = scripted("a", clock, [{ fail: "authentication-failed", status: 401 }]);
  const b = scripted("b", clock, [{ fail: "network-error" }]);
  const err = await failureOf(clock, router(clock, [a, b]).search(REQ));
  assert.equal(err.failure.code, "authentication-failed");
  assert.deepEqual(summary(err.attempts), ["a:authentication-failed:0", "b:network-error:0"]);
});

// --- Empty results ----------------------------------------------------------------------------------

test("every provider empty → a SUCCESS with zero results; provider = the first that answered", async () => {
  const clock = new FakeClock();
  const ps = ["a", "b", "c"].map((n) => scripted(n, clock, [{ fail: "empty-results", status: 200 }]));
  const res = await clock.run(router(clock, ps).search(REQ));
  assert.deepEqual(res.results, []);
  assert.equal(res.provider, "a");
  assert.deepEqual(summary(res.attempts), ["a:empty:0", "b:empty:0", "c:empty:0"]);
});

test("empty then failure → still a zero-result success (one provider DID answer)", async () => {
  const clock = new FakeClock();
  const a = scripted("a", clock, [{ fail: "empty-results", status: 200 }]);
  const b = scripted("b", clock, [{ fail: "provider-unavailable", status: 503 }]);
  const res = await clock.run(router(clock, [a, b]).search(REQ));
  assert.deepEqual(res.results, []);
  assert.equal(res.provider, "a");
});

test("empty then results → the results win", async () => {
  const clock = new FakeClock();
  const a = scripted("a", clock, [{ fail: "empty-results", status: 200 }]);
  const b = scripted("b", clock, [{ ok: true }]);
  const res = await clock.run(router(clock, [a, b]).search(REQ));
  assert.equal(res.provider, "b");
});

test("emptyResultsFallback=false stops at the first empty answer", async () => {
  const clock = new FakeClock();
  const a = scripted("a", clock, [{ fail: "empty-results", status: 200 }]);
  const b = scripted("b", clock, [{ ok: true }]);
  const res = await clock.run(router(clock, [a, b], { emptyResultsFallback: false }).search(REQ));
  assert.equal(res.provider, "a");
  assert.equal(b.calls.length, 0);
});

test("empty answers never open the breaker (a provider empty on one query works on others)", async () => {
  const clock = new FakeClock();
  const a = scripted("a", clock, [{ fail: "empty-results", status: 200 }]);
  const b = scripted("b", clock, [{ ok: true }]);
  const r = router(clock, [a, b]);
  for (let i = 0; i < 5; i++) await clock.run(r.search(REQ));
  assert.equal(a.calls.length, 5);
  assert.equal(r.metrics().providers.a.breakerOpened, 0);
});

// --- Circuit breaker --------------------------------------------------------------------------------

test("breaker: threshold failures open it; inside cooldown the provider is skipped; after it, ONE half-open probe; success closes", async () => {
  const clock = new FakeClock();
  const a = scripted("a", clock, [{ fail: "network-error" }, { fail: "network-error" }, { ok: true }]);
  const b = scripted("b", clock, [{ ok: true }]);
  const r = router(clock, [a, b], { breakerThreshold: 2, breakerCooldownMs: 60_000 });

  await clock.run(r.search(REQ)); // a fails (1)
  await clock.run(r.search(REQ)); // a fails (2) → open
  assert.equal(r.metrics().providers.a.breakerOpened, 1);

  const skipped = await clock.run(r.search(REQ));
  assert.deepEqual(summary(skipped.attempts), ["a:skipped:0", "b:ok:0"]);
  assert.equal(a.calls.length, 2);

  await clock.advance(59_999);
  const stillSkipped = await clock.run(r.search(REQ));
  assert.equal(stillSkipped.attempts[0].skipped, true, "one ms before the cooldown ends, still open");

  await clock.advance(1);
  const probe = await clock.run(r.search(REQ));
  assert.equal(probe.provider, "a", "the half-open probe is let through and succeeds");
  const after = await clock.run(r.search(REQ));
  assert.equal(after.provider, "a", "a successful probe closes the breaker");
  assert.equal(a.calls.length, 4);
});

test("breaker: a failed half-open probe re-opens it for a fresh cooldown", async () => {
  const clock = new FakeClock();
  const a = scripted("a", clock, [{ fail: "provider-unavailable", status: 503 }]);
  const b = scripted("b", clock, [{ ok: true }]);
  const r = router(clock, [a, b], { breakerThreshold: 1, breakerCooldownMs: 10_000 });
  await clock.run(r.search(REQ)); // open
  await clock.advance(10_000);
  const probe = await clock.run(r.search(REQ));
  assert.deepEqual(summary(probe.attempts), ["a:provider-unavailable:0", "b:ok:0"]);
  const next = await clock.run(r.search(REQ));
  assert.equal(next.attempts[0].skipped, true, "a failed probe re-opens the breaker");
  assert.equal(r.metrics().providers.a.breakerOpened, 2);
});

test("breaker: only ONE half-open probe is in flight; a concurrent search skips the provider", async () => {
  const clock = new FakeClock();
  const a = scripted("a", clock, [{ fail: "network-error" }, { ok: true, delayMs: 1_000 }]);
  const b = scripted("b", clock, [{ ok: true }]);
  const r = router(clock, [a, b], { breakerThreshold: 1, breakerCooldownMs: 5_000 });
  await clock.run(r.search(REQ)); // open
  await clock.advance(5_000);
  const probing = r.search(REQ); // takes the probe; a answers after 1 s
  await clock.flush();
  const concurrent = await clock.run(r.search(REQ));
  assert.deepEqual(summary(concurrent.attempts), ["a:skipped:0", "b:ok:0"]);
  const probed = await clock.run(probing);
  assert.equal(probed.provider, "a");
});

test("breaker: the LAST available provider is never skipped (one-provider deployments stay usable)", async () => {
  const clock = new FakeClock();
  const a = scripted("a", clock, [{ fail: "network-error" }, { fail: "network-error" }, { ok: true }]);
  const r = router(clock, [a], { breakerThreshold: 2, breakerCooldownMs: 300_000 });
  await failureOf(clock, r.search(REQ));
  await failureOf(clock, r.search(REQ)); // breaker now open
  const res = await clock.run(r.search(REQ));
  assert.equal(res.provider, "a", "an open breaker on the only provider must not refuse the search");
  assert.equal(res.attempts[0].skipped, undefined);
});

// --- Diagnostics, metrics, logging ------------------------------------------------------------------

test("metrics after a scripted sequence match exactly", async () => {
  const clock = new FakeClock();
  const a = scripted("a", clock, [
    { fail: "rate-limited", status: 429, retryAfterMs: 1_000 },
    { ok: true, delayMs: 300 },
    { fail: "timeout", delayMs: 500 },
  ]);
  const b = scripted("b", clock, [{ ok: true, delayMs: 200 }]);
  const r = router(clock, [a, b]);
  await clock.run(r.search(REQ)); // a 429 → wait 1 s → a ok (300 ms)
  await clock.run(r.search(REQ)); // a timeout (500 ms) → b ok (200 ms)
  const m = r.metrics();
  assert.equal(m.searches, 2);
  assert.equal(m.fallbackFulfilled, 1);
  assert.equal(m.deadlineExhausted, 0);
  assert.deepEqual(m.providers.a, {
    attempts: 3,
    ok: 1,
    empty: 0,
    failed: { "rate-limited": 1, timeout: 1 },
    skipped: 0,
    retries: 1,
    breakerOpened: 0,
    durationMs: { count: 3, sum: 800, max: 500 },
  });
  assert.deepEqual(m.providers.b, {
    attempts: 1,
    ok: 1,
    empty: 0,
    failed: {},
    skipped: 0,
    retries: 0,
    breakerOpened: 0,
    durationMs: { count: 1, sum: 200, max: 200 },
  });
});

test("metrics() returns a snapshot, not the live object", async () => {
  const clock = new FakeClock();
  const r = router(clock, [scripted("a", clock, [{ ok: true }])]);
  const snap = r.metrics();
  await clock.run(r.search(REQ));
  assert.equal(snap.searches, 0);
});

test("one log line per search, carrying the attempt chain and NEVER the query", async () => {
  const clock = new FakeClock();
  const lines = [];
  const a = scripted("a", clock, [{ fail: "rate-limited", status: 429 }]);
  const b = scripted("b", clock, [{ ok: true }]);
  await clock.run(router(clock, [a, b], { log: (l) => lines.push(l) }).search(REQ));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^search: outcome=ok provider=b attempts=\[a:rate-limited:0ms,b:ok:0ms\] durationMs=0$/);
  assert.ok(!lines[0].includes("private"), "the query leaked into the log line");
});

test("an untyped adapter throw is classified network-error without echoing its message, and the chain continues", async () => {
  const clock = new FakeClock();
  const leaky = { name: "leaky", async search() { throw new Error("boom with sk-SECRET-123 inside"); } };
  const b = scripted("b", clock, [{ fail: "timeout" }]);
  const err = await failureOf(clock, router(clock, [leaky, b]).search(REQ));
  assert.equal(err.attempts[0].failureClass, "network-error");
  assert.ok(!JSON.stringify(err.attempts).includes("SECRET"));
  assert.ok(!err.message.includes("SECRET"));
});

// --- Construction -----------------------------------------------------------------------------------

test("a provider listed twice is refused (breaker state is per name)", () => {
  const p = fakeSearchProvider({ name: "x" });
  assert.throws(() => createSearchRouter({ providers: [p, p], providerTimeoutMs: PER, totalTimeoutMs: TOTAL }), /configured twice/);
  const secrets = new SecretStore(() => ({ BGW_BRAVE_SEARCH_API_KEY: "k-123456" }));
  assert.throws(
    () => buildSearch({ BGW_SEARCH_ENABLED: "1", BGW_SEARCH_PROVIDERS: "brave,brave" }, secrets),
    /more than once/,
  );
});

test("buildSearch reads the breaker and empty-result knobs from env", async () => {
  const clock = new FakeClock();
  const a = scripted("a", clock, [{ fail: "empty-results", status: 200 }]);
  const b = scripted("b", clock, [{ ok: true }]);
  const built = buildSearch({ BGW_SEARCH_ENABLED: "1", BGW_SEARCH_EMPTY_RESULTS_FALLBACK: "0" }, new SecretStore(() => ({})), {
    providers: [a, b],
    clock,
  });
  const res = await clock.run(built.fn(REQ));
  assert.equal(res.provider, "a");
  assert.equal(b.calls.length, 0);
  assert.equal(typeof built.metrics, "function");
});
