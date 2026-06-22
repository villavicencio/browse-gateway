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

import type { CaptchaSolver } from "./captcha.js";

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
  /**
   * Injected CAPTCHA solver for the interactive drive path: when set, the core auto-solves a
   * detected, blocking interactive CAPTCHA (reCAPTCHA/Turnstile/hCaptcha) during its post-action
   * settle. Absent = a detected CAPTCHA is left to fail. Not a launch option (a runtime dependency),
   * so it is NOT mapped into the Chrome launch args. The stateless `render()` path does not use it
   * (CF managed challenges are cleared by residential escalation, not a solver).
   */
  solver?: CaptchaSolver;
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
  /**
   * Body-text length above which the page counts as "cleared" and polling stops. Defaults to
   * the strong-content bar (the kill-gate's confidence threshold). The `retrieve` verb passes
   * `0` so a legitimately short page returns immediately instead of polling to the full
   * clearance timeout.
   */
  clearedTextLength?: number;
}

/**
 * A ref-annotated accessibility snapshot of the active page — Patchright's
 * `ariaSnapshot({ mode: "ai" })`, which emits a YAML-ish tree with `[ref=eN]` markers. The
 * `drive` verbs reference those refs (resolved via the `aria-ref=<ref>` selector engine), so the
 * consumer never needs raw selectors or CDP. Mirrors the Playwright-MCP snapshot/ref model.
 */
export interface PageSnapshot {
  url: string;
  title: string;
  /**
   * HTTP status of the navigation that produced this page, or `null` when the navigation failed
   * (dead proxy exit, timeout, off-allowlist block). Present on `navigate()`; absent on a pure
   * `snapshot()`. The drive layer keys exit-health on this.
   */
  status?: number | null;
  /** Accessibility tree text with `[ref=eN]` annotations the drive verbs target. */
  tree: string;
  /**
   * Scrubbed Cloudflare-hint flag: `true` when the page's HTML carried a CF challenge marker
   * (`challenge-platform` etc.). The HTML half of retrieve's CF detection, surfaced as a boolean so
   * no page content is carried. Set on `navigate()`; absent on a pure `snapshot()`. Lets drive's
   * escalation recognize a CF interstitial that shows no visible CF phrase, matching retrieve.
   */
  cfHint?: boolean;
  /**
   * Scrubbed PerimeterX-hint flag: `true` when the page's HTML carried a PerimeterX/HUMAN marker
   * (`_pxhd`, `perimeterx`, `px-captcha` etc.). The PX sibling of {@link cfHint}, surfaced as a
   * boolean so the drive layer can classify a PerimeterX block without carrying page content.
   */
  pxHint?: boolean;
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

/**
 * How a `drive` verb identifies an element: a `ref` from a {@link PageSnapshot} (the primary
 * path) or a raw `selector` as an escape hatch. `element` is a human-readable description
 * carried for audit/logging only (mirrors Playwright-MCP's `target` + `element` split).
 */
export interface DriveTarget {
  /** A `ref` id from a snapshot (e.g. `"e4"`) OR a unique selector (e.g. `"#submit"`). */
  target: string;
  /** Human-readable description of the element, for audit/logging only. */
  element?: string;
}

/** Condition for {@link BrowserCore.waitFor}: text to appear, or a fixed delay. */
export interface WaitCondition {
  text?: string;
  timeMs?: number;
}

export interface BrowserCore {
  /** Identifies the concrete vehicle, e.g. `"patchright"`. */
  readonly kind: string;
  /** Navigate to `url`, wait for clearance, and return a DOM snapshot (stateless `retrieve` path). */
  render(url: string, opts?: RenderOptions): Promise<RenderResult>;
  /**
   * Install a guard consulted for every request via network-layer interception. Replaces
   * any previously installed guard without leaving an unguarded window. A core with NO guard
   * installed performs no interception and therefore allows every request (fail-open) — only
   * the kill-gate harness drives a core this way. Every consumer surface MUST go through the
   * gateway's authenticated path, which installs a guard before any navigation.
   */
  setNavigationGuard(guard: NavigationGuard): Promise<void>;
  /** Tear down the browser and release all processes. */
  close(): Promise<void>;

  // --- Interactive `drive` surface (stateful path) -------------------------------------------
  // These act on a single persistent "active page" within the core's guarded context, so every
  // request a click/navigation triggers still passes the installed navigation guard — the
  // consumer drives high-level verbs only, never raw CDP, and so cannot remove the guard.

  /** Open (or reuse) the active page, navigate to `url`, and return a ref-annotated snapshot. */
  navigate(url: string, opts?: RenderOptions): Promise<PageSnapshot>;
  /** Capture a ref-annotated accessibility snapshot of the active page. */
  snapshot(): Promise<PageSnapshot>;
  /** Click the element identified by `target` (a snapshot ref or a selector). */
  click(target: DriveTarget): Promise<void>;
  /** Fill `text` into the element; `submit` presses Enter afterward. */
  type(target: DriveTarget, text: string, opts?: { submit?: boolean }): Promise<void>;
  /** Select option(s) by value/label on a `<select>`-like element. */
  selectOption(target: DriveTarget, values: string[]): Promise<void>;
  /** Press a key (e.g. `"Enter"`, `"Escape"`, `"ArrowDown"`) on the active page. */
  pressKey(key: string): Promise<void>;
  /** Wait for `text` to appear, or for a fixed delay. */
  waitFor(condition: WaitCondition): Promise<void>;
  /** PNG screenshot of the active page, base64-encoded (for MCP image content). */
  screenshot(): Promise<string>;
  /** Close the active page (ends the drive interaction; the context/core stays alive). */
  closeActivePage(): Promise<void>;
}
