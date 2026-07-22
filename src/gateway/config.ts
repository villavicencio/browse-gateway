/**
 * Gateway configuration. Loaded once at startup; the same env vars the U1 kill-gate uses
 * (BGW_CHANNEL / BGW_NO_SANDBOX / BGW_HEADLESS) carry through to the session core, so the
 * gate and the service launch browsers identically.
 */
import type { BrowserCoreOptions } from "../browser/index.js";
import { parseHostSuffixList } from "../security/index.js";

/**
 * Per-call time bounds (issue #43), all env-overridable with safe defaults so behavior is UNCHANGED when
 * unset. Previously each was a hardcoded module constant with no deployment knob; `3 × (proxyNav +
 * proxyClearance)` could stack toward ~200s, and an unsolvable-CAPTCHA solve ran its full deadline. The
 * global `callBudgetMs` is the outer bound the escalation loop enforces regardless of the per-stage math.
 *
 * CONSUMED by the RETRIEVE path (the 3× proxy-escalation loop — the observed ~200s stacking source) and
 * the CAPTCHA solver. SCOPED-OUT (documented #43 follow-up, coordinated with #45): the DRIVE path still
 * reads the module-constant defaults. The drive path does NOT have retrieve's 3× re-roll loop — a stateful
 * session can't swap its exit mid-flow (KTD-5), so it's a single escalation attempt bounded by one nav +
 * clearance, not a stacking loop — and #45 restructures that exact drive escalation, so threading the budget
 * through it now would be immediately churned. Its env-timeout consumption lands with #45.
 */
export interface CallTimeouts {
  /** Global per-call wall-clock budget (BGW_CALL_BUDGET_MS). The retrieve escalation loop stops re-rolling
   *  and returns a decisive typed `timeout` once exceeded, and each attempt's nav + clearance are CLAMPED to
   *  the remaining budget, so the dominant "why 200s" stacking (`attempts × (nav + clearance)`) is bounded.
   *  SCOPED (documented #43 follow-up): this is not yet a HARD whole-operation ceiling — a session's launch /
   *  guard-install / snapshot / teardown overhead and the direct attempt's own navigation happen inside
   *  `withConsumerSession` / the core, outside these stage timeouts. Bounding those (and a hung launch — see
   *  #54) needs a core-level deadline / cooperative cancellation (AbortSignal threaded gateway→core→browser),
   *  a larger change than #43's stage-clamping. The env-overridable per-stage timeouts below are the complete,
   *  direct lever for tightening each stage today. */
  callBudgetMs: number;
  /** Direct-attempt clearance budget (BGW_CLEARANCE_TIMEOUT_MS). */
  clearanceTimeoutMs: number;
  /** Proxied-attempt clearance budget (BGW_PROXY_CLEARANCE_TIMEOUT_MS) — raised: an interstitial clears
   *  slower on a held residential exit. */
  proxyClearanceTimeoutMs: number;
  /** Per-proxied-attempt navigation timeout (BGW_PROXY_NAV_TIMEOUT_MS) — bounds a hung exit. */
  proxyNavTimeoutMs: number;
  /** Max proxied re-roll attempts (BGW_PROXY_MAX_ATTEMPTS). */
  proxyMaxAttempts: number;
  /** CAPTCHA solve deadline (BGW_CAPTCHA_SOLVE_TIMEOUT_MS). */
  captchaSolveTimeoutMs: number;
}

/** The shipped defaults for {@link CallTimeouts} — the values that were hardcoded before #43. */
export const DEFAULT_CALL_TIMEOUTS: CallTimeouts = {
  callBudgetMs: 90_000,
  clearanceTimeoutMs: 20_000,
  proxyClearanceTimeoutMs: 45_000,
  proxyNavTimeoutMs: 25_000,
  proxyMaxAttempts: 3,
  captchaSolveTimeoutMs: 120_000,
};

export interface GatewayConfig {
  /** Max concurrent browser sessions. Kept low by default — headful Chrome is heavy. */
  maxSessions: number;
  /** Max concurrent consumer-bound (drive) sessions a single consumer may hold. Default 1. */
  perConsumerMax: number;
  /** Browser-core options applied to every session (channel, sandbox, headless). */
  core: BrowserCoreOptions;
  /** Env-overridable per-call time bounds (issue #43). */
  timeouts: CallTimeouts;
}

export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
  maxSessions: 2,
  perConsumerMax: 1,
  core: {}, // browser-core defaults: headful, real Chrome channel
  timeouts: DEFAULT_CALL_TIMEOUTS,
};

function positiveIntOr(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  // Require a plain decimal integer. Bare Number() would accept hex/exponent/float
  // ("1e3" -> 1000, "0x10" -> 16) and silently blow the resource cap past its intent.
  if (!/^\d+$/.test(value.trim())) return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Validate that the global session pool is large enough to serve `consumerCount` consumers without
 * starving a concurrent `retrieve`. Held drive sessions share the global pool, so the floor is
 * `consumerCount * perConsumerMax` (every consumer at its drive cap) PLUS 1 transient retrieve slot.
 * Returns an error message when `maxSessions` is below that floor, else null. Pure, so the shared
 * HTTP launcher's fail-closed boot check is unit-testable without standing up a gateway.
 *
 * The `+1` is a deadlock-prevention floor, NOT headroom for concurrent retrieves across consumers —
 * N simultaneous retrieves still need a larger cap (tuned vs host headroom in U7).
 */
export function poolSizingError(
  consumerCount: number,
  perConsumerMax: number,
  maxSessions: number,
): string | null {
  const required = consumerCount * perConsumerMax + 1;
  if (maxSessions < required) {
    return (
      `BGW_MAX_SESSIONS=${maxSessions} is too low for ${consumerCount} consumer(s): need >= ` +
      `${required} (= ${consumerCount} × perConsumerMax ${perConsumerMax} + 1 retrieve headroom)`
    );
  }
  return null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const core: BrowserCoreOptions = {};
  if (env.BGW_CHANNEL !== undefined) core.channel = env.BGW_CHANNEL;
  if (env.BGW_NO_SANDBOX === "1") core.noSandbox = true;
  if (env.BGW_HEADLESS === "1") core.headless = true;
  // Opt-in per-host OS presentation: hosts on BGW_WINDOWS_UA_HOSTS present as Windows Chrome instead of
  // Linux (PerimeterX-class scorers 403 Linux Chrome — measured on Total Wine). Empty list = no-op.
  const windowsUaHosts = parseHostSuffixList(env.BGW_WINDOWS_UA_HOSTS);
  if (windowsUaHosts.length) core.windowsUaHosts = windowsUaHosts;

  return {
    maxSessions: positiveIntOr(env.BGW_MAX_SESSIONS, DEFAULT_GATEWAY_CONFIG.maxSessions),
    perConsumerMax: positiveIntOr(env.BGW_PER_CONSUMER_MAX, DEFAULT_GATEWAY_CONFIG.perConsumerMax),
    core,
    timeouts: loadCallTimeouts(env),
  };
}

/** Read the env-overridable per-call time bounds (issue #43); each falls back to its shipped default via the
 *  strict {@link positiveIntOr} parse (rejects hex/float/exponent), so behavior is unchanged when unset. */
export function loadCallTimeouts(env: NodeJS.ProcessEnv = process.env): CallTimeouts {
  const d = DEFAULT_CALL_TIMEOUTS;
  return {
    callBudgetMs: positiveIntOr(env.BGW_CALL_BUDGET_MS, d.callBudgetMs),
    clearanceTimeoutMs: positiveIntOr(env.BGW_CLEARANCE_TIMEOUT_MS, d.clearanceTimeoutMs),
    proxyClearanceTimeoutMs: positiveIntOr(env.BGW_PROXY_CLEARANCE_TIMEOUT_MS, d.proxyClearanceTimeoutMs),
    proxyNavTimeoutMs: positiveIntOr(env.BGW_PROXY_NAV_TIMEOUT_MS, d.proxyNavTimeoutMs),
    proxyMaxAttempts: positiveIntOr(env.BGW_PROXY_MAX_ATTEMPTS, d.proxyMaxAttempts),
    captchaSolveTimeoutMs: positiveIntOr(env.BGW_CAPTCHA_SOLVE_TIMEOUT_MS, d.captchaSolveTimeoutMs),
  };
}
