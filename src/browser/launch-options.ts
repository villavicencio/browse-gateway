/**
 * Pure mapping from the vehicle-agnostic `BrowserCoreOptions` to the concrete launch
 * options Patchright's `launchPersistentContext` expects. Kept separate from the core so
 * the stealth-critical launch config can be unit-tested without starting a browser.
 */
import type { BrowserCoreOptions, ProxyConfig, StorageStateOrigin } from "./types.js";

/** Resolved options with every default applied — no `undefined` fields (proxy stays optional). */
export interface ResolvedCoreOptions {
  headless: boolean;
  channel: string;
  noSandbox: boolean;
  userDataDir: string;
  navigationTimeoutMs: number;
  /**
   * Hard ceiling on the capture-settlement barrier a VERB runs at its own cutoff, and on the bounded
   * drain of unattributed-download disposal at teardown. It is NOT a drain of operation-internal
   * staging: staging belongs to the artifact operation, and core close/kill invalidate it
   * synchronously and non-queued instead of waiting on it (Amendment 1 §6 rules 6-7).
   *
   * A runtime option, never a launch arg. Site-neutral by construction: one bound for every host.
   */
  captureSettleTimeoutMs: number;
  proxy?: ProxyConfig;
}

export const DEFAULT_CORE_OPTIONS: ResolvedCoreOptions = {
  headless: false, // headful — Xvfb provides the display; strict headless fails the targets.
  channel: "chrome", // real Google Chrome, the validated path.
  noSandbox: false,
  userDataDir: "", // ephemeral persistent context, matching the spike.
  navigationTimeoutMs: 45_000,
  captureSettleTimeoutMs: 5_000, // normative: BGW_ARTIFACT_SETTLE_TIMEOUT_MS default (Amendment 1 §6)
};

/**
 * The capture-settlement bound must be a finite positive integer. A zero/negative value would expire
 * before any capture could settle (turning every attachment into a settle-timeout), and a non-finite
 * one would never expire (wedging teardown behind a hung copy) — so both fail closed at resolution
 * rather than misbehaving at runtime.
 */
function validSettleTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CORE_OPTIONS.captureSettleTimeoutMs;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error("captureSettleTimeoutMs must be a finite positive integer");
  }
  return value;
}

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
    captureSettleTimeoutMs: validSettleTimeout(opts.captureSettleTimeoutMs),
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

/**
 * Force a software (SwiftShader) WebGL backend so the browser actually HAS WebGL.
 *
 * Under Xvfb with no GPU, Chrome 149 produces NO WebGL context at all (`getContext('webgl')`
 * returns null) — a real desktop browser always has WebGL, so "WebGL absent" is a strong
 * anti-bot tell (measured: it was the top divergence between the prod VPS and a desktop, and
 * the likely interactive-Turnstile trigger). Chrome gates the software fallback behind
 * `--enable-unsafe-swiftshader`; `--use-gl=angle --use-angle=swiftshader` pins the backend
 * explicitly rather than relying on the default GL picker. Verified in-container: this turns
 * `webgl: null` into a valid `ANGLE (… SwiftShader driver)` context.
 *
 * Applied unconditionally (like the WebRTC policy) — the production surface is the GPU-less
 * Xvfb container, and forcing it everywhere keeps local dev a faithful fingerprint mirror of
 * prod. A host with a REAL GPU should drop these (real hardware WebGL is the better signal).
 *
 * NOTE: the SwiftShader renderer string was once suspected as the prime PerimeterX tell and a
 * renderer-spoof was floated here as a follow-up — but a 2026-06-26 same-exit A/B EXONERATED it
 * (Mac with these exact SwiftShader args clears PX; a renderer-string spoof did not change the
 * container's verdict). The actual PX-403 tell on Total Wine was the OS identity (`Linux x86_64`),
 * fixed by the opt-in Windows OS-presentation override — see `os-presentation.ts`. Leave WebGL as-is.
 */
export const WEBGL_SWIFTSHADER_ARGS = [
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
];

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
  launch.args = [WEBRTC_IP_HANDLING_ARG, ...WEBGL_SWIFTSHADER_ARGS];
  if (resolved.noSandbox) launch.args.push("--no-sandbox");
  if (resolved.proxy) launch.proxy = resolved.proxy;
  return launch;
}

/**
 * Build the page init script that restores captured localStorage into a cold session (KTD-4).
 *
 * `launchPersistentContext` has no `storageState` option (the persistent profile *is* the storage;
 * Playwright issue #14949), so localStorage is seeded via an `addInitScript` that runs before every
 * page's own scripts. That places two hard requirements on this script, both encoded here:
 *
 *  - **Origin-guarded.** The script fires on *every* navigation in the context, across all origins.
 *    It must write origin X's localStorage only while the document IS origin X — never leak a
 *    captured value onto a different origin. We compare `window.location.origin` per entry.
 *  - **Idempotent / non-clobbering.** The same script re-runs on every navigation, and the page may
 *    have updated a key since the first seed. Seeding only when the key is **absent**
 *    (`getItem(name) === null`) makes re-runs no-ops and never overwrites a live page value.
 *
 * Values are embedded as a JSON literal (safe inside a JS expression); U+2028/U+2029 are escaped
 * defensively (valid in JSON, historically illegal in JS string literals pre-ES2019). The whole
 * body is wrapped in try/catch because `localStorage` access throws on an opaque/sandboxed origin.
 */
export function buildLocalStorageSeedScript(
  origins: StorageStateOrigin[],
): string {
  const json = JSON.stringify(origins).replace(
    /[\u2028\u2029]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16),
  );
  return `(() => {
  try {
    const seed = ${json};
    const here = window.location.origin;
    for (const o of seed) {
      if (o.origin !== here) continue; // origin-guard: never seed another origin's store
      for (const e of (o.localStorage || [])) {
        // seed-if-absent: idempotent across the every-navigation re-fire; never clobbers a
        // value the page itself has since written.
        if (window.localStorage.getItem(e.name) === null) {
          window.localStorage.setItem(e.name, e.value);
        }
      }
    }
  } catch (_e) { /* localStorage unavailable (opaque/sandboxed origin) — best-effort. */ }
})();`;
}
