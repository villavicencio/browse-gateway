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

/**
 * A single cookie in a captured {@link StorageState} — the Playwright `storageState()` cookie
 * shape, carried verbatim so capture/restore round-trips through `context.addCookies` with no
 * field translation. `expires` is Unix time in **seconds** (`-1` for a session cookie, not an
 * absolute expiry); `sameSite` is the `Strict`/`Lax`/`None` enum (KTD-4).
 */
export interface StorageStateCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Unix expiry in SECONDS; `-1` for a session cookie. */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

/** Per-origin localStorage captured in a {@link StorageState}. `sessionStorage` is not included by
 * `storageState()` and is out of scope (KTD-4). */
export interface StorageStateOrigin {
  origin: string;
  localStorage: Array<{ name: string; value: string }>;
}

/**
 * A serializable browser session snapshot — cookies + per-origin localStorage — matching
 * Playwright's `BrowserContext.storageState()` return shape. The vault persists this as an opaque
 * encrypted blob (U4) and replays it into a cold session (KTD-3): cookies via `addCookies`,
 * localStorage via an origin-guarded init script (KTD-4). Capture/replay should stay on the same
 * Chrome major so partitioned-cookie (CHIPS) parity holds.
 */
export interface StorageState {
  cookies: StorageStateCookie[];
  origins: StorageStateOrigin[];
}

/**
 * A warm-restore value bound atomically to its OWNER HOST — the single authoritative host the restored
 * `state` belongs to. Carrying the owner WITH the state (rather than as a separate parameter alongside
 * it) is a safety invariant: the gateway clamps the credentialed session's navigation to exactly this
 * `ownerHost` (R4 no-exfil), so the host the cookies were scoped to and the host the session may
 * navigate can never diverge or be omitted by a caller.
 *
 * It is also SEALED: a valid RestoreState can only be produced by {@link sealRestoreState} (which the
 * vault's `buildWarmOverride` calls, deriving `ownerHost` from the vault LOOKUP — never a caller input).
 * The gateway refuses a credentialed open whose `restoreState` is not sealed ({@link isSealedRestore}),
 * so a freely hand-constructed `{ state, ownerHost }` literal — which could pair a jar with a forged
 * owner — can't reach a guarded session.
 */
export interface RestoreState {
  state: StorageState;
  /** The authoritative owner host the `state` belongs to; the gateway clamps navigation to it. */
  ownerHost: string;
}

/** Module-private seal: a non-enumerable brand, so it survives object-spread but is invisible to
 *  `deepEqual`/`JSON.stringify`, and cannot be set by code that doesn't hold this symbol. */
const SEALED_RESTORE = Symbol("bgw.sealed-restore");

/**
 * Mint a sealed {@link RestoreState}. The ONLY way to produce one the gateway will accept for a
 * credentialed session — the vault layer calls it with an `ownerHost` derived from a successful vault
 * lookup, so the seal certifies "this came through the vault producer," not a hand-built literal.
 */
export function sealRestoreState(state: StorageState, ownerHost: string): RestoreState {
  const restore: RestoreState = { state, ownerHost };
  Object.defineProperty(restore, SEALED_RESTORE, { value: true, enumerable: false });
  return restore;
}

/** True only for a {@link RestoreState} minted by {@link sealRestoreState}. */
export function isSealedRestore(value: RestoreState | undefined): boolean {
  return !!value && (value as unknown as Record<symbol, unknown>)[SEALED_RESTORE] === true;
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
   * Session state to restore into a cold session at launch (KTD-3/4): cookies are injected via
   * `addCookies` and per-origin localStorage via an origin-guarded init script, so the first
   * navigation is already logged-in. Applied AFTER `launchPersistentContext`, like the runtime
   * `solver` (it is not a launch arg). A vault session pairs this with a clean ephemeral
   * `userDataDir` (`""`) so the throwaway profile can't shadow the seeded state. The core injects
   * the `.state`; the bound `.ownerHost` is the authoritative host the gateway clamps the session's
   * navigation to (R4 no-exfil — owner travels with the state, never a separate caller param).
   * Absent = a cold, stateless session (the default).
   */
  restoreState?: RestoreState;
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
  /** Concatenated HTML of child frames (the px-captcha-modal et al.), captured by the core only when
   * a PX marker is present — so an iframe-served press-&-hold is detectable, since `html`
   * (page.content()) is top-document only. Absent on an ordinary render. */
  frameHtml?: string;
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

/**
 * Tri-state result of {@link BrowserCore.readField}: whether the element exists yet, and its current
 * input value when it does. The assisted-login flow (U6) reads it as absent / present-empty /
 * present-filled — so it can poll an async-rendered field into existence, fill only an empty one
 * (a pre-filled "remember me" field is left alone), and never type into a field that isn't there.
 */
export interface FieldState {
  /** True when at least one element matches the target (the field has rendered). */
  present: boolean;
  /** The field's current value when present and input-like; `""` for an absent or non-input target. */
  value: string;
}

export interface BrowserCore {
  /** Identifies the concrete vehicle, e.g. `"patchright"`. */
  readonly kind: string;
  /** Navigate to `url`, wait for clearance, and return a DOM snapshot (stateless `retrieve` path). */
  render(url: string, opts?: RenderOptions): Promise<RenderResult>;
  /**
   * Serialize the context's current session state (cookies + per-origin localStorage) for the vault
   * to persist (KTD-3). The counterpart to {@link BrowserCoreOptions.restoreState}; the captured
   * blob replays into a later cold session as logged-in. `sessionStorage` is not included (KTD-4).
   */
  captureStorageState(): Promise<StorageState>;
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
  /**
   * Read a field's tri-state {@link FieldState} (present? + current value) without acting on it.
   * The assisted-login flow's source of truth for polling an async-rendered login/2FA field and for
   * filling only an empty one. Never throws on an absent or non-input target — returns
   * `{ present: false, value: "" }` / `{ present: true, value: "" }`.
   */
  readField(target: DriveTarget): Promise<FieldState>;
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
