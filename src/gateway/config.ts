/**
 * Gateway configuration. Loaded once at startup; the same env vars the U1 kill-gate uses
 * (BGW_CHANNEL / BGW_NO_SANDBOX / BGW_HEADLESS) carry through to the session core, so the
 * gate and the service launch browsers identically.
 */
import type { BrowserCoreOptions } from "../browser/index.js";
import { parseHostSuffixList } from "../security/index.js";

export interface GatewayConfig {
  /** Max concurrent browser sessions. Kept low by default — headful Chrome is heavy. */
  maxSessions: number;
  /** Max concurrent consumer-bound (drive) sessions a single consumer may hold. Default 1. */
  perConsumerMax: number;
  /** Browser-core options applied to every session (channel, sandbox, headless). */
  core: BrowserCoreOptions;
}

export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
  maxSessions: 2,
  perConsumerMax: 1,
  core: {}, // browser-core defaults: headful, real Chrome channel
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
  };
}
