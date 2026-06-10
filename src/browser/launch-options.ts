/**
 * Pure mapping from the vehicle-agnostic `BrowserCoreOptions` to the concrete launch
 * options Patchright's `launchPersistentContext` expects. Kept separate from the core so
 * the stealth-critical launch config can be unit-tested without starting a browser.
 */
import type { BrowserCoreOptions, ProxyConfig } from "./types.js";

/** Resolved options with every default applied — no `undefined` fields (proxy stays optional). */
export interface ResolvedCoreOptions {
  headless: boolean;
  channel: string;
  noSandbox: boolean;
  userDataDir: string;
  navigationTimeoutMs: number;
  proxy?: ProxyConfig;
}

export const DEFAULT_CORE_OPTIONS: ResolvedCoreOptions = {
  headless: false, // headful — Xvfb provides the display; strict headless fails the targets.
  channel: "chrome", // real Google Chrome, the validated path.
  noSandbox: false,
  userDataDir: "", // ephemeral persistent context, matching the spike.
  navigationTimeoutMs: 45_000,
};

export function resolveCoreOptions(
  opts: BrowserCoreOptions = {},
): ResolvedCoreOptions {
  return {
    headless: opts.headless ?? DEFAULT_CORE_OPTIONS.headless,
    channel: opts.channel ?? DEFAULT_CORE_OPTIONS.channel,
    noSandbox: opts.noSandbox ?? DEFAULT_CORE_OPTIONS.noSandbox,
    userDataDir: opts.userDataDir ?? DEFAULT_CORE_OPTIONS.userDataDir,
    navigationTimeoutMs:
      opts.navigationTimeoutMs ?? DEFAULT_CORE_OPTIONS.navigationTimeoutMs,
    ...(opts.proxy ? { proxy: opts.proxy } : {}),
  };
}

/**
 * WebRTC must never gather candidates outside the proxy: during an anti-bot challenge,
 * STUN over plain UDP reveals the host's real IP alongside the proxied one — on a
 * datacenter VPS that mismatch reads as "proxy detected" and the challenge never clears.
 * `disable_non_proxied_udp` restricts ICE to proxied transports without disabling the
 * WebRTC API itself (the same behavior as common WebRTC-leak-protection settings).
 *
 * CAUTION: this switch is NOT honored by current branded Chrome (verified on 149: switch
 * on the cmdline, srflx still leaked). The load-bearing mechanism is the managed-policy
 * file `docker/policies/webrtc-ip-handling.json` baked into the image (`WebRtcIPHandling`
 * enterprise policy — verified to zero out non-proxied candidates). The switch stays as
 * belt-and-braces for Chromium variants where it may still work.
 */
export const WEBRTC_IP_HANDLING_ARG =
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp";

/** The subset of Patchright's launch options this core sets. */
export interface PatchrightLaunchOptions {
  headless: boolean;
  channel?: string;
  args?: string[];
  proxy?: ProxyConfig;
}

/**
 * Build the launch options for `chromium.launchPersistentContext(userDataDir, opts)`.
 * `channel` is omitted when empty so Patchright falls back to its patched Chromium.
 */
export function buildLaunchOptions(
  resolved: ResolvedCoreOptions,
): PatchrightLaunchOptions {
  const launch: PatchrightLaunchOptions = { headless: resolved.headless };
  if (resolved.channel) launch.channel = resolved.channel;
  launch.args = [WEBRTC_IP_HANDLING_ARG];
  if (resolved.noSandbox) launch.args.push("--no-sandbox");
  if (resolved.proxy) launch.proxy = resolved.proxy;
  return launch;
}
