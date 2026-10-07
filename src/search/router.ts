/**
 * The ordered search-provider router (VIL-123).
 *
 * VIL-122 ran exactly one provider. This module is the one code path for any number of them: a
 * single-provider deployment is a one-provider router, not a separate branch that could drift.
 *
 * THE INVARIANT: no provider can hold the request past its own budget, and no attempt can run past
 * the total deadline. Each attempt's deadline is `min(now + providerTimeoutMs, totalDeadline)`, and
 * the router enforces it THREE ways rather than trusting the adapter:
 *   1. `ctx.deadline` tells a well-behaved adapter when to stop;
 *   2. `ctx.signal` is ABORTED by a router-owned timer at that deadline (the VIL-122 controller was
 *      never aborted, so an adapter that honoured only the signal had no bound at all);
 *   3. the router stops WAITING at that deadline whatever the adapter does — a provider that ignores
 *      both is abandoned, its eventual settlement swallowed, and the next provider gets the rest.
 * An attempt never starts with less than {@link MIN_ATTEMPT_MS} left: a provider handed 20 ms is not
 * being given a chance, it is being given a guaranteed timeout and a spent quota unit.
 *
 * Routing is driven by the typed failure class, never by retrying a provider until the clock runs
 * out. Policy per class is in {@link classPolicy}.
 */
import { SearchProviderError } from "./types.js";
import type { SearchAttempt, SearchFailureClass, SearchFn, SearchProvider, SearchRequest, SearchResponse, SearchResult } from "./types.js";

/** The smallest slice of time worth starting an attempt with. */
export const MIN_ATTEMPT_MS = 500;

export const DEFAULT_SEARCH_BREAKER_THRESHOLD = 2;
export const DEFAULT_SEARCH_BREAKER_COOLDOWN_MS = 300_000;

/** Timer seam. Injected so every deadline, retry wait and cooldown is testable on a fake clock. */
export interface RouterClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: RouterClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface SearchRouterOptions {
  providers: SearchProvider[];
  providerTimeoutMs: number;
  totalTimeoutMs: number;
  /** Consecutive counted failures that open a provider's breaker. */
  breakerThreshold?: number;
  /** How long an open breaker skips its provider before allowing one half-open probe. */
  breakerCooldownMs?: number;
  /** Whether an `empty-results` answer moves on to the next provider (default true). */
  emptyResultsFallback?: boolean;
  clock?: RouterClock;
  /** One structured line per search. Never carries the query (no raw query logging). */
  log?: (line: string) => void;
}

/** Per-provider counters. In-memory and process-local; surfacing them on `/health` is VIL-130's. */
export interface ProviderMetrics {
  attempts: number;
  ok: number;
  empty: number;
  failed: Partial<Record<SearchFailureClass, number>>;
  /** Attempts the breaker refused (no request sent). */
  skipped: number;
  /** Same-provider retries made because a `Retry-After` fit the budget. */
  retries: number;
  breakerOpened: number;
  durationMs: { count: number; sum: number; max: number };
}

export interface RouterMetrics {
  searches: number;
  /** Successful searches answered by a provider other than the first one attempted. */
  fallbackFulfilled: number;
  /** Searches that ended `total-deadline-exhausted`. */
  deadlineExhausted: number;
  providers: Record<string, ProviderMetrics>;
}

export interface SearchRouter {
  search: SearchFn;
  metrics(): RouterMetrics;
}

type BreakerState = { state: "closed"; failures: number } | { state: "open"; until: number } | { state: "half-open"; probing: boolean };

/**
 * What the router does with each failure class.
 *
 * - `trip`: open the breaker NOW. Auth and quota failures will fail identically on the next call, so
 *   counting up to a threshold just spends requests to learn what the first one said.
 * - `count`: one consecutive failure toward the threshold.
 * - `none`: says nothing about the provider's health. `unsupported-query` is the CALLER's query
 *   (another provider may have different limits, so it still moves on); `empty-results` is a working
 *   provider with no answer (VIL-123 evidence: a provider that returned an empty shell for one query
 *   succeeded on others in the same session, so it must not be excluded from future work).
 */
function classPolicy(code: SearchFailureClass): "trip" | "count" | "none" {
  if (code === "authentication-failed" || code === "quota-exhausted") return "trip";
  if (code === "unsupported-query" || code === "empty-results" || code === "policy-restricted") return "none";
  return "count";
}

/** Which class an all-failed search reports when the total deadline did not end it. Operator-actionable
 *  classes first: a dead credential behind a working fallback is the fact the caller cannot see. */
const FINAL_CLASS_PRIORITY: readonly SearchFailureClass[] = ["authentication-failed", "quota-exhausted", "rate-limited"];

export function createSearchRouter(opts: SearchRouterOptions): SearchRouter {
  const providers = [...opts.providers];
  if (providers.length === 0) throw new Error("the search router requires at least one provider");
  const names = new Set<string>();
  for (const p of providers) {
    // Breaker state and metrics are keyed by name; two providers sharing one would corrupt both.
    if (names.has(p.name)) throw new Error(`search provider '${p.name}' is configured twice`);
    names.add(p.name);
  }
  const clock = opts.clock ?? realClock;
  const threshold = Math.max(1, opts.breakerThreshold ?? DEFAULT_SEARCH_BREAKER_THRESHOLD);
  const cooldownMs = Math.max(0, opts.breakerCooldownMs ?? DEFAULT_SEARCH_BREAKER_COOLDOWN_MS);
  const emptyFallback = opts.emptyResultsFallback ?? true;
  // A per-provider budget larger than the total promises a bound the router would then blow through.
  const providerBudgetMs = Math.min(opts.providerTimeoutMs, opts.totalTimeoutMs);

  const breakers = new Map<string, BreakerState>(providers.map((p) => [p.name, { state: "closed", failures: 0 }]));
  const metrics: RouterMetrics = { searches: 0, fallbackFulfilled: 0, deadlineExhausted: 0, providers: {} };
  for (const p of providers) metrics.providers[p.name] = emptyProviderMetrics();

  /** May this provider be called now? Moves open → half-open once the cooldown has elapsed, and
   *  admits exactly one probe while half-open. */
  function admit(name: string, now: number): boolean {
    const b = breakers.get(name)!;
    if (b.state === "closed") return true;
    if (b.state === "open") {
      if (now < b.until) return false;
      breakers.set(name, { state: "half-open", probing: true });
      return true;
    }
    if (b.probing) return false;
    b.probing = true;
    return true;
  }

  function recordSuccess(name: string): void {
    breakers.set(name, { state: "closed", failures: 0 });
  }

  function recordFailure(name: string, code: SearchFailureClass, now: number): void {
    const policy = classPolicy(code);
    const b = breakers.get(name)!;
    if (policy === "none") {
      // Not a health signal — but a half-open probe that ended this way still answered, so it closes.
      if (b.state === "half-open") recordSuccess(name);
      return;
    }
    const open = () => {
      breakers.set(name, { state: "open", until: now + cooldownMs });
      metrics.providers[name]!.breakerOpened++;
    };
    if (b.state === "half-open" || policy === "trip") return open();
    if (b.state === "closed") {
      b.failures++;
      if (b.failures >= threshold) open();
    }
  }

  const search: SearchFn = async (req: SearchRequest): Promise<SearchResponse> => {
    const started = clock.now();
    const totalDeadline = started + opts.totalTimeoutMs;
    const attempts: SearchAttempt[] = [];
    const failures: SearchProviderError[] = [];
    let deadlineCut = false;
    let emptyFrom: string | undefined;
    metrics.searches++;

    // The breaker never skips the LAST provider still available. Skipping it would turn a transient
    // blip into a guaranteed failure for the whole cooldown with nothing to fall back to — on a
    // one-provider deployment, five minutes of refusing every search after two timeouts. When every
    // remaining provider is open, the last one is tried anyway; its result still feeds the breaker.
    const lastIndex = providers.length - 1;

    for (let i = 0; i < providers.length; i++) {
      const provider = providers[i]!;
      const pm = metrics.providers[provider.name]!;
      const now = clock.now();

      if (totalDeadline - now < MIN_ATTEMPT_MS) {
        deadlineCut = true;
        break;
      }

      const anyLaterAdmissible = providers.slice(i + 1).some((p) => isAdmissible(p.name, now));
      if (!admit(provider.name, now)) {
        if (i < lastIndex && anyLaterAdmissible) {
          pm.skipped++;
          attempts.push({ provider: provider.name, outcome: "failed", failureClass: "provider-unavailable", httpStatus: null, durationMs: 0, skipped: true });
          continue;
        }
        // Last resort: call it even though its breaker is open.
      }

      const providerDeadline = Math.min(now + providerBudgetMs, totalDeadline);
      let retried = false;
      for (;;) {
        const attemptStart = clock.now();
        const outcome = await runAttempt(provider, req, providerDeadline, clock);
        const end = clock.now();
        const durationMs = end - attemptStart;
        pm.attempts++;
        pm.durationMs.count++;
        pm.durationMs.sum += durationMs;
        pm.durationMs.max = Math.max(pm.durationMs.max, durationMs);

        if (outcome.kind === "ok") {
          pm.ok++;
          recordSuccess(provider.name);
          attempts.push({ provider: provider.name, outcome: "ok", durationMs });
          const firstAttempted = attempts.find((a) => !a.skipped)?.provider;
          const res = response(req, provider.name, outcome.results, attempts, started, clock.now());
          if (firstAttempted !== provider.name) metrics.fallbackFulfilled++;
          logLine(opts.log, res.provider, "ok", attempts, res.durationMs);
          return res;
        }

        const err = outcome.error;
        if (err.code === "empty-results") {
          pm.empty++;
          recordFailure(provider.name, err.code, end);
          attempts.push({ provider: provider.name, outcome: "empty", httpStatus: err.httpStatus, durationMs });
          emptyFrom ??= provider.name;
          break;
        }

        pm.failed[err.code] = (pm.failed[err.code] ?? 0) + 1;
        const attempt: SearchAttempt = { provider: provider.name, outcome: "failed", failureClass: err.code, httpStatus: err.httpStatus, durationMs };
        if (err.retryAfterMs !== undefined) attempt.retryAfterMs = err.retryAfterMs;
        attempts.push(attempt);
        failures.push(err);
        if (outcome.timedOut && providerDeadline === totalDeadline) deadlineCut = true;

        // Honour Retry-After once, and only when the wait AND a worthwhile attempt both fit inside
        // this provider's budget (which is already clamped to the total deadline). Never sleep past
        // either — a wait that cannot be followed by a real attempt is just a slower failure.
        if (
          err.code === "rate-limited" &&
          !retried &&
          err.retryAfterMs !== undefined &&
          clock.now() + err.retryAfterMs + MIN_ATTEMPT_MS <= providerDeadline
        ) {
          retried = true;
          pm.retries++;
          await sleep(clock, err.retryAfterMs);
          continue;
        }
        recordFailure(provider.name, err.code, clock.now());
        break;
      }

      if (emptyFrom !== undefined && !emptyFallback) break;
    }

    const ended = clock.now();
    if (emptyFrom !== undefined) {
      // At least one provider answered "nothing matched" and none answered with results: that is a
      // real answer to a discovery question, so it is a success with zero results.
      const res = response(req, emptyFrom, [], attempts, started, ended);
      logLine(opts.log, emptyFrom, "empty", attempts, res.durationMs);
      return res;
    }

    let failure: SearchProviderError;
    if (deadlineCut) {
      metrics.deadlineExhausted++;
      failure = new SearchProviderError("total-deadline-exhausted", `the total search deadline of ${opts.totalTimeoutMs} ms ran out before any provider answered`);
    } else if (failures.length === 0) {
      // Every provider was skipped by its breaker (only possible when the last one was admitted and
      // then skipped by a concurrent probe). Nothing was sent.
      failure = new SearchProviderError("provider-unavailable", "every configured search provider is cooling down after recent failures");
    } else {
      failure =
        FINAL_CLASS_PRIORITY.map((c) => failures.find((f) => f.code === c)).find((f) => f !== undefined) ?? failures[0]!;
    }
    logLine(opts.log, "none", `failed:${failure.code}`, attempts, ended - started);
    throw new SearchAttemptsError(failure, attempts);
  };

  /** Like {@link admit}, but without claiming the half-open probe — used only to decide whether a
   *  later provider could take over from a skipped one. */
  function isAdmissible(name: string, now: number): boolean {
    const b = breakers.get(name)!;
    if (b.state === "closed") return true;
    if (b.state === "open") return now >= b.until;
    return !b.probing;
  }

  return {
    search,
    metrics: () => structuredClone(metrics),
  };
}

type AttemptOutcome = { kind: "ok"; results: SearchResult[] } | { kind: "failed"; error: SearchProviderError; timedOut: boolean };

/**
 * Run one provider call, bounded by `deadline` no matter what the provider does. A router-owned timer
 * settles the race at the deadline, so a provider that ignores both `ctx.deadline` and `ctx.signal` is
 * abandoned rather than awaited — and because the race settles AT the deadline, the `finally` below
 * aborts `ctx.signal` at the deadline too. That single abort is the one that matters: it fires on
 * every exit path (answer, failure, deadline), so no provider request outlives its attempt. (An extra
 * abort inside the timer was tried and measured redundant: removing it changed no test, because the
 * `finally` runs in the same turn.)
 */
async function runAttempt(provider: SearchProvider, req: SearchRequest, deadline: number, clock: RouterClock): Promise<AttemptOutcome> {
  const controller = new AbortController();
  let timer: unknown;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = clock.setTimeout(() => resolve("timeout"), Math.max(0, deadline - clock.now()));
  });
  const call = provider.search(req, { deadline, signal: controller.signal });
  // An abandoned call may still reject later; that settlement belongs to nobody.
  call.catch(() => {});
  try {
    const winner = await Promise.race([call.then((results) => ({ results })), timedOut]);
    if (winner === "timeout") {
      return { kind: "failed", error: new SearchProviderError("timeout", "search provider exceeded its budget"), timedOut: true };
    }
    return { kind: "ok", results: winner.results };
  } catch (err) {
    if (err instanceof SearchProviderError) return { kind: "failed", error: err, timedOut: err.code === "timeout" };
    // A non-typed throw from an adapter is an adapter defect, not a provider verdict. Classify it
    // conservatively. The raw message is deliberately NOT propagated: a transport error can quote the
    // request, and the request carries the API key in a header — only the failure SHAPE crosses here.
    return {
      kind: "failed",
      error: new SearchProviderError("network-error", `search failed (${err instanceof Error ? err.name : "unknown error"})`),
      timedOut: false,
    };
  } finally {
    clock.clearTimeout(timer);
    // Tear down anything the provider left in flight, on every exit path.
    controller.abort();
  }
}

function sleep(clock: RouterClock, ms: number): Promise<void> {
  return new Promise((resolve) => {
    clock.setTimeout(resolve, ms);
  });
}

function emptyProviderMetrics(): ProviderMetrics {
  return { attempts: 0, ok: 0, empty: 0, failed: {}, skipped: 0, retries: 0, breakerOpened: 0, durationMs: { count: 0, sum: 0, max: 0 } };
}

function response(req: SearchRequest, provider: string, results: SearchResult[], attempts: SearchAttempt[], started: number, ended: number): SearchResponse {
  return {
    query: req.query,
    provider,
    results,
    attempts,
    retrievedAt: new Date(ended).toISOString(),
    durationMs: ended - started,
  };
}

/** One line per search: who answered, how, and the attempt chain. The query is never logged. */
function logLine(log: ((line: string) => void) | undefined, provider: string, outcome: string, attempts: SearchAttempt[], durationMs: number): void {
  if (!log) return;
  const chain = attempts
    .map((a) => `${a.provider}:${a.skipped ? "skipped" : a.outcome === "failed" ? a.failureClass : a.outcome}:${a.durationMs}ms`)
    .join(",");
  log(`search: outcome=${outcome} provider=${provider} attempts=[${chain}] durationMs=${durationMs}`);
}

/**
 * A failed search, carrying the ordered attempt record alongside the typed cause. The MCP layer
 * renders both, so a caller sees WHICH providers failed and HOW, not just a class.
 */
export class SearchAttemptsError extends Error {
  readonly failure: SearchProviderError;
  readonly attempts: SearchAttempt[];
  constructor(failure: SearchProviderError, attempts: SearchAttempt[]) {
    super(failure.message);
    this.name = "SearchAttemptsError";
    this.failure = failure;
    this.attempts = attempts;
  }
}
