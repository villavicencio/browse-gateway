/**
 * Vehicle-agnostic browser-core contract.
 *
 * U1 ships a single implementation (Patchright + real Chrome, headful under Xvfb —
 * the spike-proven config; see the private plan's U1 and the `steel-rejected-u1-vehicle`
 * decision). The interface stays vehicle-neutral so a later session/viewer layer
 * (e.g. a fixed Steel, or another driver) can implement the same `BrowserCore` without
 * disturbing the units built on top of it.
 */

/** Which anti-bot family a target exercises — used to gate per-category in the kill-gate. */
export type Category = "cloudflare" | "datadome";

/** Upstream proxy for a session (Playwright-shaped). Used by R7 scoped escalation. */
export interface ProxyConfig {
  server: string;
  username?: string;
  password?: string;
}

export interface BrowserCoreOptions {
  /**
   * Strict headless. Defaults to `false` (headful) because the spike proved strict
   * headless fails the anti-bot challenges this gateway exists to clear. `true` is used
   * only for the negative-control test that confirms Xvfb is doing the work.
   */
  headless?: boolean;
  /**
   * Browser channel. `"chrome"` launches the system-installed real Google Chrome
   * (the validated path). `""` uses Patchright's patched Chromium.
   */
  channel?: string;
  /** Pass `--no-sandbox`. Required when running as root inside a container. */
  noSandbox?: boolean;
  /**
   * Persistent-context user-data dir. `""` (default) is an ephemeral persistent context,
   * matching the spike.
   */
  userDataDir?: string;
  /** Navigation timeout for `page.goto`, in ms. */
  navigationTimeoutMs?: number;
  /** Upstream proxy for this session. Absent = direct connection. */
  proxy?: ProxyConfig;
}

/** A point-in-time snapshot of a rendered page. */
export interface RenderResult {
  url: string;
  /** HTTP status of the main navigation response, or `null` if none was captured. */
  status: number | null;
  title: string;
  text: string;
  html: string;
  /** Wall-clock ms spent waiting for the page to clear (challenge auto-solve). */
  clearanceWaitedMs: number;
}

export interface RenderOptions {
  /**
   * Max time to poll for challenge clearance after navigation, in ms. Anti-bot
   * interstitials (notably Cloudflare) clear client-side on a variable delay, so the
   * core polls until the page looks cleared rather than waiting a fixed interval.
   */
  clearanceTimeoutMs?: number;
  /** Poll interval while waiting for clearance, in ms. */
  pollIntervalMs?: number;
}

export type NavigationDecision = "allow" | "block";

/** The fields the navigation guard sees for each intercepted request. */
export interface NavigationRequest {
  url: string;
  /** Lowercased URL hostname, or `""` if the URL can't be parsed. */
  host: string;
  resourceType: string;
  isNavigationRequest: boolean;
}

/**
 * Consulted for every request the browser makes. Returning `"block"` aborts the request at
 * the network layer. Installed below the verb layer (via Fetch interception) so it can't be
 * bypassed by a raw CDP `Page.navigate` — the U3 allowlist guarantee.
 */
export type NavigationGuard = (req: NavigationRequest) => NavigationDecision;

export interface BrowserCore {
  /** Identifies the concrete vehicle, e.g. `"patchright"`. */
  readonly kind: string;
  /** Navigate to `url`, wait for clearance, and return a DOM snapshot. */
  render(url: string, opts?: RenderOptions): Promise<RenderResult>;
  /**
   * Install a guard consulted for every request via network-layer interception. Replaces
   * any previously installed guard. Calling with no guard is the caller's choice; an
   * un-guarded core allows everything (the gateway always installs one for a consumer).
   */
  setNavigationGuard(guard: NavigationGuard): Promise<void>;
  /** Tear down the browser and release all processes. */
  close(): Promise<void>;
}
