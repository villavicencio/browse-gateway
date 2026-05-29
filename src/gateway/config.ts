/**
 * Gateway configuration. Loaded once at startup; the same env vars the U1 kill-gate uses
 * (BGW_CHANNEL / BGW_NO_SANDBOX / BGW_HEADLESS) carry through to the session core, so the
 * gate and the service launch browsers identically.
 */
import type { BrowserCoreOptions } from "../browser/index.js";

export interface GatewayConfig {
  /** Max concurrent browser sessions. Kept low by default — headful Chrome is heavy. */
  maxSessions: number;
  /** Browser-core options applied to every session (channel, sandbox, headless). */
  core: BrowserCoreOptions;
}

export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
  maxSessions: 2,
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const core: BrowserCoreOptions = {};
  if (env.BGW_CHANNEL !== undefined) core.channel = env.BGW_CHANNEL;
  if (env.BGW_NO_SANDBOX === "1") core.noSandbox = true;
  if (env.BGW_HEADLESS === "1") core.headless = true;

  return {
    maxSessions: positiveIntOr(env.BGW_MAX_SESSIONS, DEFAULT_GATEWAY_CONFIG.maxSessions),
    core,
  };
}
