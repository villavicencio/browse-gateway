/**
 * Patchright + real-Chrome browser core, headful under Xvfb — the spike-proven stealth
 * config and U1's shipping vehicle (see `steel-rejected-u1-vehicle`).
 */
import { chromium } from "patchright";
import { assertLocalCdpOnly } from "../security/cdp.js";
import { hostFromUrl, hostMatchesAnySuffix } from "../security/url.js";
import { SecretStore, redactSecrets } from "../security/secrets.js";
import { buildWindowsUaOverride, buildNativeUaOverride, READ_LIVE_UA_JS, type LiveUserAgent } from "./os-presentation.js";
import { isCleared, isVisiblyBlocked, hasCloudflareHint, hasPerimeterXHint, MIN_CONTENT_LENGTH, type PageSignal } from "./detect.js";
import {
  DETECT_LIVE_CAPTCHA_JS,
  injectTokenJs,
  awaitSolvableCaptcha,
  CAPTCHA_SOLVE_ERROR_CODES,
  type CaptchaSolver,
  type LiveCaptcha,
} from "./captcha.js";
import {
  buildLaunchOptions,
  buildLocalStorageSeedScript,
  resolveCoreOptions,
  type ResolvedCoreOptions,
} from "./launch-options.js";
import type {
  BrowserCore,
  BrowserCoreOptions,
  DriveTarget,
  FieldState,
  NavigationDecision,
  NavigationGuard,
  NavigationRequest,
  PageSnapshot,
  RenderOptions,
  RenderResult,
  RestoreState,
  StorageState,
  WaitCondition,
} from "./types.js";

type PatchrightContext = Awaited<
  ReturnType<typeof chromium.launchPersistentContext>
>;
type PatchrightPage = Awaited<ReturnType<PatchrightContext["newPage"]>>;
type PatchrightLocator = ReturnType<PatchrightPage["locator"]>;
type PatchrightBrowser = NonNullable<ReturnType<PatchrightContext["browser"]>>;
/** Browser-level CDP session type, derived so we don't depend on a named patchright export. */
type CDPSession = Awaited<ReturnType<PatchrightBrowser["newBrowserCDPSession"]>>;

/** The subset of the CDP `Fetch.requestPaused` event the navigation guard reads. */
interface FetchRequestPaused {
  requestId: string;
  request: { url: string };
  resourceType: string;
}

/**
 * Map a paused CDP Fetch request onto the {@link NavigationRequest} the guard consumes. Pure and
 * exported so the highest-risk part of the CDP rewrite is unit-testable without a browser: CDP
 * emits TitleCase `resourceType` ("Document"/"XHR") which we lowercase to preserve the prior
 * Playwright-shaped value the audit log records, and CDP has no `isNavigationRequest` field so a
 * top-level/subframe document load (`resourceType === "Document"`) is treated as the navigation.
 */
export function cdpRequestToNavigation(resourceType: string, url: string): NavigationRequest {
  return {
    url,
    host: hostFromUrl(url),
    resourceType: typeof resourceType === "string" ? resourceType.toLowerCase() : "",
    // Speculative Document loads (prefetch/prerender) over-classify as navigation here (CDP gives no
    // loaderId in this subset); that only ever OVER-applies the owner-host clamp (fail-safe), never
    // exempts a real navigation from it.
    isNavigationRequest: resourceType === "Document",
  };
}

/**
 * Decide a paused request, fail-closed. Pure + exported so the decision branches (no guard → block;
 * guard throws → block; otherwise the guard's verdict) are unit-tested without a browser — the
 * second-highest-risk part of the rewrite after {@link cdpRequestToNavigation}. `onError` lets the
 * caller surface a throwing guard (which is otherwise silent because the throw happens before the
 * guard's own audit record runs).
 */
export function decideRequest(
  guard: NavigationGuard | undefined,
  event: FetchRequestPaused,
  onError?: (err: unknown) => void,
): NavigationDecision {
  if (!guard) return "block";
  try {
    return guard(cdpRequestToNavigation(event.resourceType, event.request?.url ?? ""));
  } catch (err) {
    onError?.(err);
    return "block";
  }
}

/**
 * A short, secret-free reason for a diagnostic line (R9). Order matters: scrub KNOWN secrets from the
 * FULL message first (via the injected redactor — catches a bare proxy password anywhere, incl. past
 * char 80), THEN strip any residual URL (a target/exit URL is not a stored secret but must not be
 * logged), THEN truncate. Without a redactor (tests/smoke) it degrades to URL-strip + truncate.
 */
export function errCode(err: unknown, redact?: (s: string) => string): string {
  const raw = err instanceof Error ? err.message : String(err);
  const scrubbed = redact ? redact(raw) : raw;
  return scrubbed.replace(/https?:\/\/\S+/gi, "<url>").slice(0, 80);
}

/**
 * The redactor a launch uses for its own stderr diagnostics ({@link errCode}), built from the UNION of
 * the caller's secret VALUES (`opts.secrets`) and the launch's own proxy credentials, scrubbed in ONE
 * longest-first pass — so no secret can fragment another (the flaw of composing two opaque redactors).
 * For a SECRET-BEARING launch (proxy/solver) that supplied no `opts.secrets`, it CENTRALIZES injection
 * by defaulting to the process-env {@link SecretStore} (which loads the SAME BGW_PROXY_* / BGW_CAPTCHA_*
 * the launch's creds come from) — so a proxied/solver core is NEVER launched without a way to scrub its
 * diagnostics (R9, audit #3; the earlier gap where a validator/tool built a proxied Gateway from bare
 * `loadConfig()` and leaked a bare password). A plain direct launch with no secrets needs none.
 * Exported for tests.
 */
export function resolveCoreRedactor(opts: BrowserCoreOptions): ((s: string) => string) | undefined {
  // OPTION-supplied proxy credentials are a first-class credential source that can DIFFER from what the
  // caller's secret set knows — a per-session proxy override merged in by SessionManager.acquire (a
  // gateway override, a minted sticky password). Validate them (guarded → an unredactable <3/marker one
  // fails CLOSED here; real proxy creds are env-derived and ≥3 so this never trips in practice), then
  // UNION them with the caller's secret VALUES and scrub in ONE redactSecrets pass. A single pass orders
  // longest-first, so no secret can fragment another (neither a base secret inside a cred, nor a cred
  // inside a caller-only secret) — the flaw any sequential composition of two opaque redactors has.
  const optionCreds = [opts.proxy?.username, opts.proxy?.password].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  let validatedOptionCreds: readonly string[] = [];
  if (optionCreds.length) {
    const tmp = new SecretStore(() => ({}));
    tmp.addRedactableCredential(optionCreds); // validate: fail closed on an unredactable option cred
    validatedOptionCreds = tmp.redactableValues();
  }
  // Caller's secret values, or — for a secret-bearing launch that supplied no store — the process-env
  // store (the same BGW_PROXY_* / BGW_CAPTCHA_* the launch uses).
  const callerStore = opts.secrets ?? (opts.proxy || opts.solver ? new SecretStore() : undefined);
  if (!callerStore && !validatedOptionCreds.length) return undefined;
  const values = [...(callerStore?.redactableValues() ?? []), ...validatedOptionCreds];
  if (!values.length) return undefined;
  return (s: string) => redactSecrets(s, { redactableValues: () => values });
}

const DEFAULT_CLEARANCE_TIMEOUT_MS = 20_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
/** Per-action timeout for interactive drive verbs (click/type/select/wait). */
const DEFAULT_ACTION_TIMEOUT_MS = 10_000;
/**
 * Hard ceiling on a `waitFor({ timeMs })` delay. Kept well under the idle-reaper TTL so a single
 * wait can't hold the session open past the point where the reaper would close it under the caller.
 */
const MAX_WAIT_MS = 60_000;
/**
 * How long `navigate()` polls a visible anti-bot interstitial waiting for it to auto-solve before
 * snapshotting. The poll runs ONLY while a block phrase is showing, so a clean (or dead/blank) page
 * incurs no wait — only an actual challenge costs latency. Mirrors render()'s clearance loop with a
 * drive-tuned budget; overridable per call via `RenderOptions.clearanceTimeoutMs`.
 */
const DEFAULT_DRIVE_CLEARANCE_TIMEOUT_MS = 15_000;
// Interactive-CAPTCHA widgets inject their response field from an async script that runs AFTER
// navigate() resolves (waitUntil "domcontentloaded"). Poll up to this long for the field to render
// before concluding there's nothing to solve — otherwise a one-shot detect always loses the race.
const CAPTCHA_RENDER_POLL_MS = 250;
const CAPTCHA_RENDER_TIMEOUT_MS = 2_000;

/**
 * A snapshot ref looks like `e4` (top frame) or a frame-prefixed `f1e2`; anything else is a raw
 * selector. Drive verbs reference snapshot refs by default; a selector is the escape hatch.
 */
const REF_PATTERN = /^[a-z]?\d*e\d+$/i;

/** Visible body text — the post-inject advancement signal (catches same-page/AJAX callback updates). */
const BODY_TEXT_JS = "document.body ? document.body.innerText : ''";

/** Resolve a {@link DriveTarget}'s `target` to a Playwright selector: a ref -> `aria-ref=`, else passthrough. */
export function targetToSelector(target: string): string {
  const t = target.trim();
  return REF_PATTERN.test(t) ? `aria-ref=${t}` : t;
}

/** Title + visible text only — the cheap signal the clearance poll needs each iteration. */
async function pollSignal(page: PatchrightPage): Promise<Pick<PageSignal, "title" | "text">> {
  const title = await page.title().catch(() => "");
  const text = String(
    await page
      .evaluate("document.body ? document.body.innerText : ''")
      .catch(() => ""),
  );
  return { title, text };
}

/**
 * Concatenated HTML of every child frame. `page.content()` serializes only the TOP document, so a
 * challenge rendered inside a child frame (PerimeterX's `px-captcha-modal`) is invisible to it.
 * Playwright reads a child frame's document even cross-origin (verified), so the press-&-hold copy is
 * recoverable here. Each frame is fetched best-effort — a detached/navigating frame yields "".
 */
async function captureChildFrameHtml(page: PatchrightPage): Promise<string> {
  const children = page.frames().filter((f) => f !== page.mainFrame());
  if (children.length === 0) return "";
  const parts = await Promise.all(children.map((f) => f.content().catch(() => "")));
  return parts.join("\n");
}

/**
 * Restore captured session state into a freshly-launched context (KTD-3/4). Cookies go straight
 * into the jar via `addCookies` (the storageState cookie shape is exactly what `addCookies` takes,
 * so `expires`-in-seconds and the `sameSite` enum round-trip with no translation). localStorage
 * can't be set on the context directly — `launchPersistentContext` has no `storageState` option —
 * so it is seeded by an origin-guarded, idempotent init script (see `buildLocalStorageSeedScript`).
 * Best-effort and additive: an empty blob is a no-op (an ordinary cold session).
 */
async function applyRestoreState(
  context: PatchrightContext,
  state: StorageState,
): Promise<void> {
  if (state.cookies?.length) {
    await context.addCookies(state.cookies);
  }
  const origins = (state.origins ?? []).filter((o) => o.localStorage?.length);
  if (origins.length) {
    await context.addInitScript({ content: buildLocalStorageSeedScript(origins) });
  }
}

/**
 * Restore `state` into a freshly-launched `context`, closing the context if restoration fails.
 *
 * The context is already a running Chrome by the time we seed it, and `addCookies` can REJECT on a
 * malformed or legacy-shaped persisted cookie (one missing `domain`/`url`, say). Letting that reject
 * propagate out of `launch()` would leave the browser process orphaned — and because every vault
 * session that hits the same bad blob repeats the failure, the leaked processes accumulate until the
 * capped browser pool is exhausted. So on any restore failure we close the context (best-effort) and
 * rethrow the ORIGINAL error, so the caller sees the real cause, not a teardown error. A `null`/absent
 * `state` is a no-op (the ordinary cold session). Exported for unit coverage of the close-on-failure
 * path without launching a real browser.
 */
export async function restoreOrClose(
  context: PatchrightContext,
  restore?: RestoreState,
): Promise<void> {
  if (!restore) return;
  try {
    // The core injects the bound `.state`; the `.ownerHost` is the gateway's navigation-clamp scope
    // (the core is a dumb injector — host-scoping the cookies is the vault layer's job upstream).
    await applyRestoreState(context, restore.state);
  } catch (err) {
    await context.close().catch(() => {});
    throw err;
  }
}

/** Capture the title/text/html a page currently renders, tolerant of mid-navigation races. */
async function snapshot(page: PatchrightPage): Promise<PageSignal> {
  const { title, text } = await pollSignal(page);
  const html = String(await page.content().catch(() => ""));
  // Only walk child frames when the top doc carries a PX marker (the px-captcha-modal element is in
  // the top document even while its challenge body is in the frame) — so an ordinary page with ad
  // iframes never pays the cost, and an iframe-served press-&-hold is still detectable.
  const frameHtml = hasPerimeterXHint(html) ? await captureChildFrameHtml(page) : "";
  return { title, text, html, frameHtml };
}

export class PatchrightBrowserCore implements BrowserCore {
  readonly kind = "patchright";
  readonly #context: PatchrightContext;
  readonly #resolved: ResolvedCoreOptions;
  /** Injected solver for the drive path; absent = a detected CAPTCHA is left to fail. */
  readonly #solver?: CaptchaSolver;
  /**
   * Canonical host-suffixes whose navigations present as Windows Chrome instead of Linux (the
   * opt-in OS-presentation fix for PerimeterX-class scorers that 403 Linux Chrome — see
   * os-presentation.ts). Empty = every navigation keeps the native Linux identity.
   */
  readonly #windowsUaHosts: readonly string[];
  /**
   * Secret redactor (R9), injected from the gateway's SecretStore. The browser core's own stderr
   * diagnostics ({@link errCode}) URL-strip by construction, but a bare secret (a proxy password not
   * in URL form) would otherwise survive — this scrubs the KNOWN secret set from a diagnostic line
   * before it is written. Absent (tests / smoke) = URL-strip only, the prior behavior.
   */
  readonly #redact?: (s: string) => string;
  /**
   * The drive active page's current OS-presentation mode. Tracked so a REUSED active page actively
   * RESTORES the native identity when it navigates from a listed host to a non-listed one — the
   * Windows override must never bleed past the opt-in boundary onto an unrelated host (it is a CDP
   * target-scoped override that otherwise persists). Reset to "native" whenever a fresh active page opens.
   */
  #osMode: "native" | "windows" = "native";
  /** Live UA/client-hint values read once from the active page before its first OS override, so the
   *  Windows override preserves the real brands/fullVersionList and a restore re-applies the true native
   *  identity. Reset with the active page. */
  #liveUach?: LiveUserAgent;
  /** The active page's reusable CDP session for the OS-presentation override (apply + restore go through
   *  the SAME live session, so the override is unambiguous). Detached + reset with the active page. */
  #osCdpSession?: CDPSession;
  /**
   * The currently-installed navigation guard. The single persistent CDP `Fetch.requestPaused`
   * listener reads this on every request, so swapping guards is an atomic reassignment — no
   * unguarded window, no Fetch re-enable. Absent until the first setNavigationGuard().
   */
  #activeGuard?: NavigationGuard;
  /**
   * Browser-level CDP session that owns request interception, installed lazily on the first
   * setNavigationGuard(). One session with auto-attach (flatten) covers every present + future
   * page/popup/frame, and re-pauses each server-redirect hop so the guard re-decides it. Undefined
   * = no guard ever installed = no interception = fail-open (only the kill-gate drives a core so).
   */
  #cdpGuardSession?: CDPSession;
  /**
   * Single-flight latch for the lazy first install. A second setNavigationGuard() that arrives while
   * the first install's CDP round-trips are still in flight awaits this instead of opening a SECOND
   * browser session + Fetch.enable (which would be the double-consumer / InterceptionId collision the
   * whole design avoids). Cleared once the install settles.
   */
  #cdpInstall?: Promise<void>;
  /**
   * Set while close() tears the session down. `Fetch.disable` releases any still-paused request by
   * CONTINUING it (allow), so during teardown #onRequestPaused fail-closes instead — a redirect hop
   * paused at the close instant must not be auto-allowed past the guard.
   */
  #closing = false;
  /** The single persistent page the interactive `drive` verbs act on (absent until navigate()). */
  #activePage?: PatchrightPage;
  /**
   * HTTP status of the active page's last main-frame navigation, kept current by a response listener
   * so it reflects click/submit-triggered navigations too — not just navigate(). Lets a post-action
   * snapshot carry a status, so a bare reputation block (4xx + thin) reached by an action is
   * detectable, not only a visible challenge phrase. `undefined` until the first navigation.
   */
  #lastDocStatus?: number | null;

  private constructor(
    context: PatchrightContext,
    resolved: ResolvedCoreOptions,
    solver?: CaptchaSolver,
    windowsUaHosts: readonly string[] = [],
    redact?: (s: string) => string,
  ) {
    this.#context = context;
    this.#resolved = resolved;
    this.#solver = solver;
    this.#windowsUaHosts = windowsUaHosts;
    this.#redact = redact;
  }

  static async launch(
    opts: BrowserCoreOptions = {},
  ): Promise<PatchrightBrowserCore> {
    // R9 (audit #3): a secret-bearing launch (proxy creds / solver key) always gets a redactor for its
    // stderr diagnostics — the caller's, or a centralized process-env default — so a bare secret can
    // never reach deployment/validation logs even if the caller didn't wire one. See resolveCoreRedactor.
    const redact = resolveCoreRedactor(opts);
    const resolved = resolveCoreOptions(opts);
    const launchOptions = buildLaunchOptions(resolved);
    // R13/R17: never expose CDP off-localhost. Patchright drives Chromium over a pipe, so
    // this is a regression guard against a future change adding a public debugging address.
    assertLocalCdpOnly(launchOptions.args ?? []);
    const context = await chromium.launchPersistentContext(
      resolved.userDataDir,
      launchOptions,
    );
    // Seed any captured session state BEFORE the first navigation, so a vault session is logged-in
    // from its first goto. This runs against the live context (not a launch arg), like the solver.
    // It registers cookies + an init script only — no network request — so it predates and is
    // independent of the navigation guard the gateway installs next. restoreOrClose owns the
    // close-on-failure invariant so a bad blob can't orphan the just-launched Chrome.
    await restoreOrClose(context, opts.restoreState);
    // The solver + windowsUaHosts + redactor are runtime dependencies (not launch args) — pass through.
    return new PatchrightBrowserCore(context, resolved, opts.solver, opts.windowsUaHosts ?? [], redact);
  }

  /**
   * Serialize the context's cookies + per-origin localStorage for the vault to persist (KTD-3).
   * Playwright's `storageState()` shape is carried verbatim — its cookie/origin fields are exactly
   * {@link StorageState} — so what comes out here replays through {@link BrowserCoreOptions.restoreState}
   * with no translation. Context-wide (cookies are not per-page); safe to call with no active page.
   */
  async captureStorageState(): Promise<StorageState> {
    const { cookies, origins } = await this.#context.storageState();
    return { cookies, origins };
  }

  /** True when `url`'s host is on the opt-in Windows-UA list (so the page should present as Windows). */
  #shouldPresentWindows(url: string): boolean {
    if (this.#windowsUaHosts.length === 0) return false;
    return hostMatchesAnySuffix(hostFromUrl(url), this.#windowsUaHosts);
  }

  /**
   * Read the live UA / high-entropy client-hint values from `page` (for an OS override that preserves the
   * real brands/fullVersionList and a faithful native restore). MUST be read from a FRESH page (about:blank)
   * before any site script runs — a loaded page can redefine `navigator` getters on the shared host object
   * and poison the baseline. THROWS on an evaluate/transport failure (fail-closed): the caller must NOT
   * fall back to a fabricated identity. `READ_LIVE_UA_JS` itself already degrades gracefully for an absent
   * `userAgentData` / blocked high-entropy (returns at least `{userAgent, platform}`), so a throw here is a
   * genuine transport failure, not a missing-field case.
   */
  async #readLiveUa(page: PatchrightPage): Promise<LiveUserAgent> {
    return (await page.evaluate(READ_LIVE_UA_JS)) as LiveUserAgent;
  }

  /**
   * Apply the Windows OS-presentation to a FRESH (stateless render) page — read the live UA-CH, build a
   * Windows override that preserves the non-OS fields, and set it via a page CDP session BEFORE the first
   * navigation so the first request carries the spoofed UA + Sec-CH-UA-Platform headers. No restore is
   * needed (the page is per-call). FAIL-CLOSED: THROWS on failure rather than rendering a Windows-required
   * host as Linux — the caller (render) runs this inside its try so the page is still closed, and the
   * error surfaces to the consumer instead of a silent OS downgrade.
   */
  async #applyWindowsToFreshPage(page: PatchrightPage): Promise<void> {
    const override = buildWindowsUaOverride(await this.#readLiveUa(page));
    const cdp = await this.#context.newCDPSession(page);
    await cdp.send("Emulation.setUserAgentOverride", override);
  }

  /**
   * Drive the active page's OS-presentation mode to `target`, applying or RESTORING via one reusable
   * CDP session. A no-op when already in `target` (so repeated navigations to the same listed host don't
   * re-send, and a never-listed session never touches the UA). The restore leg (windows → native) is the
   * opt-in-boundary guarantee: a reused drive page that leaves a listed host stops presenting Windows on
   * its next navigation, so the override can't bleed onto an unrelated host.
   *
   * FAIL-CLOSED: THROWS on any read/session/send failure WITHOUT mutating `#osMode`, so navigate() can
   * recover by recreating a fresh (native) page rather than proceeding to goto() with the wrong/uncertain
   * identity — a swallowed restore failure would otherwise leave the Windows override live on a non-listed
   * host (the exact bleed this guards), and a swallowed apply failure would silently downgrade a
   * Windows-required host to Linux.
   */
  async #applyOsMode(page: PatchrightPage, target: "native" | "windows"): Promise<void> {
    if (target === this.#osMode) return; // already in this mode (native start ⇒ a non-listed session is untouched)
    // Use ONLY the clean baseline captured from the fresh page in #ensureActivePage — never lazily read it
    // from the now-loaded page (which could have poisoned navigator). Absent ⇒ the eager capture failed;
    // fail closed (navigate() recovers by recreating a fresh page, which re-captures, then retries).
    if (!this.#liveUach) throw new Error("os-presentation: no clean UA baseline captured for this page");
    if (!this.#osCdpSession) this.#osCdpSession = await this.#context.newCDPSession(page);
    const override =
      target === "windows"
        ? buildWindowsUaOverride(this.#liveUach)
        : buildNativeUaOverride(this.#liveUach);
    await this.#osCdpSession.send("Emulation.setUserAgentOverride", override);
    this.#osMode = target;
  }

  async render(url: string, opts: RenderOptions = {}): Promise<RenderResult> {
    const clearanceTimeoutMs =
      opts.clearanceTimeoutMs ?? DEFAULT_CLEARANCE_TIMEOUT_MS;
    const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const page = await this.#context.newPage();
    try {
      // Present as Windows for opt-in hosts BEFORE the first navigation (fresh per-call page). Inside the
      // try so the finally still closes the page if it throws; fail-closed — a listed host that can't get
      // the Windows identity errors out rather than rendering as Linux. Non-listed host = no-op (native).
      if (this.#shouldPresentWindows(url)) await this.#applyWindowsToFreshPage(page);
      let status: number | null = null;
      try {
        const resp = await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: this.#resolved.navigationTimeoutMs,
        });
        status = resp ? resp.status() : null;
      } catch {
        // Navigation may time out or be aborted by a challenge; assess whatever rendered.
      }

      // Poll until the challenge clears (markers gone + content) or we time out. Challenges —
      // Cloudflare especially — solve client-side on a variable delay, so a fixed wait
      // under-counts clearance; this loop is the fix for that flakiness. Each poll fetches
      // only title+text (cheap); the full HTML is serialized once at the end.
      let signal = await pollSignal(page);
      let waited = 0;
      while (!isCleared(signal, opts.clearedTextLength) && waited < clearanceTimeoutMs) {
        await page.waitForTimeout(pollIntervalMs);
        waited += pollIntervalMs;
        signal = await pollSignal(page);
      }
      const final = await snapshot(page);
      return { url, status, ...final, clearanceWaitedMs: waited };
    } finally {
      await page.close().catch(() => {});
    }
  }

  async setNavigationGuard(guard: NavigationGuard): Promise<void> {
    // Atomic swap first: the persistent Fetch.requestPaused listener reads #activeGuard on every
    // request, so reassigning it replaces the guard with no unguarded window (the role the route
    // handler swap played before) and without re-enabling Fetch.
    this.#activeGuard = guard;
    if (this.#cdpGuardSession) return;
    // Single-flight the lazy first install so two concurrent setNavigationGuard() calls share ONE
    // browser session (a second install would be the double-Fetch-consumer collision we removed
    // context.route to avoid). Cleared when the install settles so a failed install can be retried.
    if (!this.#cdpInstall) {
      this.#cdpInstall = this.#installFetchGuard().finally(() => {
        this.#cdpInstall = undefined;
      });
    }
    await this.#cdpInstall;
  }

  /**
   * Install the one browser-level CDP Fetch interceptor that owns request guarding, replacing
   * context.route(). Two reasons for CDP over a route: (1) correctness — route.continue() auto-follows
   * a server 3xx chain WITHOUT re-invoking the route handler, so the guard saw only hop 0 (the
   * documented redirect bypass); a CDP Request-stage interceptor re-pauses every redirect hop, so the
   * guard re-decides each hop while Fetch.continueRequest keeps it in Chrome's NATIVE network stack
   * (TLS/HTTP fingerprint preserved — route.fetch would not). (2) No double consumer — Patchright's own
   * CRNetworkManager enables Fetch whenever a context.route is registered, so a route + a raw Fetch
   * session would collide on the InterceptionId. Target.setAutoAttach(flatten) extends the one session
   * to every present + future page, popup and frame (a per-page attach races a popup's first navigation
   * and misses it). This rides the existing CDP pipe — no debugging port — so it does not weaken
   * assertLocalCdpOnly (R13/R17). handleAuthRequests is deliberately omitted: proxy auth is answered at
   * the context/proxy layer, and enabling it here without a Fetch.authRequired handler would hang
   * auth-challenged requests.
   */
  async #installFetchGuard(): Promise<void> {
    const browser = this.#context.browser();
    if (!browser) {
      throw new Error(
        "cannot install navigation guard: context exposes no browser session for CDP interception",
      );
    }
    const cdp = await browser.newBrowserCDPSession();
    try {
      cdp.on("Fetch.requestPaused", (event) => {
        void this.#onRequestPaused(cdp, event);
      });
      await cdp.send("Fetch.enable", {
        patterns: [{ urlPattern: "*", requestStage: "Request" }],
      });
      // An already-open child target is covered once setAutoAttach completes (it flattens that
      // target's Fetch.requestPaused onto this session); current callers install the guard before any
      // page issues a request, so there is no live window.
      await cdp.send("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      });
      this.#cdpGuardSession = cdp;
    } catch (err) {
      // Partial install: detach the half-armed session so it does not leak with Fetch still enabled,
      // and leave #cdpGuardSession unset so a retry installs cleanly rather than double-enabling.
      await cdp.send("Fetch.disable").catch(() => {});
      await cdp.detach().catch(() => {});
      throw err;
    }
  }

  /**
   * The single interception handler. Runs the active guard for a paused request and continues or
   * fails it. Fail-closed: a missing or throwing guard — or teardown in progress — blocks. Each paused
   * request, including every redirect hop (CDP re-pauses them), gets exactly one continue/fail when the
   * send succeeds; a failed send is surfaced (not silently dropped) because it can leave a request
   * paused until the navigation timeout.
   */
  async #onRequestPaused(cdp: CDPSession, event: FetchRequestPaused): Promise<void> {
    const { requestId } = event;
    // During close() Fetch.disable would auto-CONTINUE a still-paused request (allow); fail it instead.
    const decision: NavigationDecision = this.#closing
      ? "block"
      : decideRequest(this.#activeGuard, event, (err) => {
          process.stderr.write(`[browse-gateway] navigation guard threw; request blocked (${errCode(err, this.#redact)})\n`);
        });
    try {
      if (decision === "allow") {
        // No url/header overrides: the request egresses unchanged via the context-level proxy and
        // Chrome's native stack.
        await cdp.send("Fetch.continueRequest", { requestId });
      } else {
        await cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
      }
    } catch (err) {
      // During teardown (close() detaches the session) a send naturally fails — expected and benign,
      // so stay quiet. Outside teardown, the target detached or a redirect superseded the request
      // (invalid InterceptionId) is usually benign too, but a genuine send failure can leave a request
      // paused until navigationTimeoutMs, so surface it (typed code only, no URL/secret).
      if (!this.#closing) {
        process.stderr.write(`[browse-gateway] fetch ${decision} send failed (${errCode(err, this.#redact)})\n`);
      }
    }
  }

  // --- Interactive `drive` surface ------------------------------------------------------------
  // All of these act on a single persistent active page inside the same guarded context, so the
  // requests they trigger pass the installed navigation guard exactly like render() does. The
  // consumer reaches these through high-level verbs only — never raw CDP — so it cannot remove
  // the guard. Element targeting uses snapshot refs (aria-ref=) per `targetToSelector`.

  async navigate(url: string, opts: RenderOptions = {}): Promise<PageSnapshot> {
    const clearanceTimeoutMs = opts.clearanceTimeoutMs ?? DEFAULT_DRIVE_CLEARANCE_TIMEOUT_MS;
    const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    let page = await this.#ensureActivePage();
    // Drive the active page's OS presentation to match THIS host BEFORE the goto: Windows for a listed
    // host, native otherwise — actively restoring native on a listed→non-listed transition so the Windows
    // override never bleeds onto an unrelated host (opt-in boundary). No-op when already in mode.
    const wantWindows = this.#shouldPresentWindows(url);
    try {
      await this.#applyOsMode(page, wantWindows ? "windows" : "native");
    } catch (err) {
      // FAIL-CLOSED: never goto() with an uncertain OS identity. A failed windows→native restore would
      // otherwise leave the Windows override live on this non-listed host (the bleed), and a failed
      // native→windows apply would silently downgrade a Windows-required host. Drop the active page (kills
      // its possibly-overridden CDP session) and open a FRESH one — which starts native — then re-establish
      // the wanted mode on it; if THAT still fails it propagates, so the navigation fails loudly rather
      // than landing with the wrong identity.
      process.stderr.write(`[browse-gateway] OS-presentation (${wantWindows ? "windows" : "native"}) failed; recreating page fail-closed (${errCode(err, this.#redact)})\n`);
      await this.closeActivePage();
      page = await this.#ensureActivePage(); // fresh page ⇒ native identity, #osMode reset
      if (wantWindows) await this.#applyOsMode(page, "windows"); // a non-listed host is already correct (native)
    }
    // Reset the tracked status; the active-page response listener (#ensureActivePage) repopulates it
    // from THIS nav's main-frame responses — INCLUDING a post-clearance reload. We deliberately do
    // NOT freeze status at the goto's first response: a CF interstitial answers 403 then reloads to
    // 200 once the challenge auto-solves, and capturing the 403 made navFailed misread the cleared
    // page as a hard block (4xx + thin tree), so proxied escalation discarded a working exit and
    // eventually reported "could not land a working proxied exit (403)".
    this.#lastDocStatus = null;
    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: this.#resolved.navigationTimeoutMs,
      });
    } catch {
      // A challenge/redirect/dead-exit may abort the navigation; settle on whatever rendered. With no
      // main-frame response the listener leaves status null, so the drive layer treats it as a failed nav.
    }
    // Give a client-side challenge (Cloudflare et al.) time to auto-solve, like render() does, and —
    // once it clears via a full reload — wait for the real document to land content rather than the
    // blank inter-navigation moment. A page still blocked after the budget is surfaced by navFailed.
    await this.#settle(page, clearanceTimeoutMs, pollIntervalMs);
    // Carry the CF vendor-hint signal (the HTML half of retrieve's CF detection) as a scrubbed
    // boolean, so drive's escalation recognizes a CF interstitial that shows no visible CF phrase.
    const html = String(await page.content().catch(() => ""));
    return { ...(await this.#snapshotOf(page)), cfHint: hasCloudflareHint(html), pxHint: hasPerimeterXHint(html) };
  }

  async snapshot(): Promise<PageSnapshot> {
    return this.#snapshotOf(this.#requireActivePage());
  }

  async readField(target: DriveTarget): Promise<FieldState> {
    const page = this.#requireActivePage();
    const loc = page.locator(targetToSelector(target.target));
    // count() is a one-shot existence check (no auto-wait) — the assisted-login poller owns the wait,
    // so an absent field returns immediately as not-present rather than blocking on a locator timeout.
    const count = await loc.count().catch(() => 0);
    if (count === 0) return { present: false, value: "" };
    // inputValue() reads <input>/<textarea>/<select>; a non-input (or detached) target yields "" via
    // the catch rather than throwing, so "present but not input-like" reads as present + empty.
    const value = await loc
      .first()
      .inputValue({ timeout: DEFAULT_ACTION_TIMEOUT_MS })
      .catch(() => "");
    return { present: true, value };
  }

  async click(target: DriveTarget): Promise<void> {
    await this.#act("click", target, (loc) =>
      loc.click({ timeout: DEFAULT_ACTION_TIMEOUT_MS }),
    );
  }

  async type(
    target: DriveTarget,
    text: string,
    opts: { submit?: boolean } = {},
  ): Promise<void> {
    await this.#act("type", target, async (loc) => {
      await loc.fill(text, { timeout: DEFAULT_ACTION_TIMEOUT_MS });
      if (opts.submit) await loc.press("Enter");
    });
  }

  async selectOption(target: DriveTarget, values: string[]): Promise<void> {
    await this.#act("selectOption", target, (loc) =>
      loc.selectOption(values, { timeout: DEFAULT_ACTION_TIMEOUT_MS }),
    );
  }

  async pressKey(key: string): Promise<void> {
    const page = this.#requireActivePage();
    await page.keyboard.press(key);
    // A key press (Enter) can submit a form / trigger navigation — wait out any challenge it lands on.
    // If a submit-gated CAPTCHA was solved, replay the key once so the submit completes with the token.
    const replayNeeded = await this.#settle(page);
    if (replayNeeded) {
      await page.keyboard.press(key).catch(() => {});
      await this.#settle(page);
    }
  }

  async waitFor(condition: WaitCondition): Promise<void> {
    const page = this.#requireActivePage();
    if (condition.text) {
      await page
        .getByText(condition.text)
        .first()
        .waitFor({ timeout: DEFAULT_ACTION_TIMEOUT_MS });
    } else if (condition.timeMs !== undefined) {
      // Clamp the fixed delay so one wait can't outlive the idle-reaper TTL and pin the session.
      await page.waitForTimeout(Math.min(Math.max(0, condition.timeMs), MAX_WAIT_MS));
    } else {
      throw new Error("waitFor requires either text or timeMs");
    }
  }

  async screenshot(): Promise<string> {
    const buf = await this.#requireActivePage().screenshot({ timeout: DEFAULT_ACTION_TIMEOUT_MS });
    return buf.toString("base64");
  }

  async closeActivePage(): Promise<void> {
    await this.#activePage?.close().catch(() => {});
    this.#activePage = undefined;
    this.#lastDocStatus = undefined;
    this.#resetOsPresentation(); // next active page starts native again
  }

  /** Reset the active page's OS-presentation state (mode + cached live UA + CDP session). Detaches the
   *  old session best-effort; the page close also tears it down, so this just avoids carrying a stale
   *  reference onto the next active page. */
  #resetOsPresentation(): void {
    void this.#osCdpSession?.detach().catch(() => {});
    this.#osCdpSession = undefined;
    this.#liveUach = undefined;
    this.#osMode = "native";
  }

  /**
   * Open (lazily) the single active page used by the drive verbs, with a listener that tracks its
   * last main-frame navigation status — so every snapshot (including post-action) can carry a status
   * for hard-block detection, even though only navigate() returns a goto response directly.
   */
  async #ensureActivePage(): Promise<PatchrightPage> {
    if (!this.#activePage) {
      const page = await this.#context.newPage();
      this.#lastDocStatus = undefined;
      this.#resetOsPresentation(); // a fresh page starts native; its OS mode is decided on the first nav
      // Capture a CLEAN UA baseline from the fresh (about:blank) page BEFORE any site loads, so a later
      // listed-host override is built from the REAL browser identity — not from values a previously-loaded
      // (untrusted) page could have redefined on the shared navigator. Only when the feature is enabled.
      // Best-effort here (a non-listed-only session never needs it); the apply path (#applyOsMode) fails
      // closed if a listed host is later reached without a baseline.
      if (this.#windowsUaHosts.length > 0) {
        try {
          this.#liveUach = await this.#readLiveUa(page);
        } catch (err) {
          process.stderr.write(`[browse-gateway] OS-presentation baseline read failed (${errCode(err, this.#redact)})\n`);
        }
      }

      page.on("response", (resp) => {
        try {
          if (resp.request().isNavigationRequest() && resp.frame() === page.mainFrame()) {
            this.#lastDocStatus = resp.status();
          }
        } catch {
          // a superseded/aborted response can throw on access — ignore; the next nav updates status
        }
      });
      this.#activePage = page;
    }
    return this.#activePage;
  }

  /** The active page, or a clear error when the consumer acts before navigating. */
  #requireActivePage(): PatchrightPage {
    if (!this.#activePage) {
      throw new Error("no active page — call navigate() to open one before acting");
    }
    return this.#activePage;
  }

  /** Run an action against a resolved locator, mapping driver errors to a clean, labeled message. */
  async #act(
    op: string,
    target: DriveTarget,
    fn: (loc: PatchrightLocator) => Promise<unknown>,
  ): Promise<void> {
    const page = this.#requireActivePage();
    const loc = page.locator(targetToSelector(target.target));
    try {
      await fn(loc);
    } catch (err) {
      const first = (err instanceof Error ? err.message : String(err)).split("\n")[0];
      const label = target.element ? `${target.element} (${target.target})` : target.target;
      throw new Error(`drive ${op} failed for ${label}: ${first}`);
    }
    // A navigation-producing action (submit click, select with onchange) may land on a challenge —
    // wait it out so the post-action snapshot is the cleared page, not the interstitial.
    const replayNeeded = await this.#settle(page);
    if (replayNeeded) {
      // A CAPTCHA that appeared only on this action (e.g. a submit gated on reCAPTCHA) was rejected
      // before a token existed; the solve injected one but did not re-submit. Replay the action ONCE
      // so it completes with the token in place. Best-effort: a now-missing element just no-ops, and
      // the following settle won't re-solve (the response field is filled). (AE3/R8: continue, don't fail.)
      await fn(loc).catch(() => {});
      await this.#settle(page);
    }
  }

  /**
   * Poll the active page WHILE a visible anti-bot block phrase is showing, up to the clearance
   * budget, so a client-side challenge (triggered by a goto or a navigation-producing action) can
   * auto-solve before we snapshot. Runs only while a phrase is present — a clean or dead/blank page
   * returns immediately, so only an actual interstitial costs latency.
   */
  async #settle(
    page: PatchrightPage,
    clearanceTimeoutMs: number = DEFAULT_DRIVE_CLEARANCE_TIMEOUT_MS,
    pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
  ): Promise<boolean> {
    // Let any navigation the prior action triggered reach domcontentloaded, so its response status is
    // captured and the snapshot reflects the landed page (resolves immediately if nothing navigated).
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    let signal = await pollSignal(page);
    let waited = 0;
    let sawBlock = false;
    while (waited < clearanceTimeoutMs) {
      const blocked = isVisiblyBlocked(signal);
      if (blocked) sawBlock = true;
      // A never-blocked page settles the moment it isn't blocked (a clean/dead/blank page returns
      // fast — only an actual challenge costs latency). A page that WAS blocked must wait for the
      // REAL post-clearance document to land NON-THIN content (isCleared past MIN_CONTENT_LENGTH —
      // the same thinness bar navFailed's isHardBlock uses), not the blank/residual transitional
      // window a CF 403→200 reload leaves. Otherwise #settle exits on the transition, the snapshot
      // is thin, and (with the interstitial's status) navFailed misreads the cleared page as a hard
      // block. Bounded by the clearance budget, so a genuinely-thin cleared page still returns.
      const settled = sawBlock ? isCleared(signal, MIN_CONTENT_LENGTH) : !blocked;
      if (settled) break;
      await page.waitForTimeout(pollIntervalMs);
      waited += pollIntervalMs;
      signal = await pollSignal(page);
    }
    // After client-side challenges settle, an INTERACTIVE captcha (reCAPTCHA/Turnstile/hCaptcha)
    // may still be blocking the flow. Auto-solve it transparently when a solver is configured. Returns
    // true when the caller should replay the triggering action to complete a submit-gated flow.
    return this.#trySolveCaptcha(page);
  }

  /**
   * Transparent interactive-CAPTCHA solve on the drive path. Runs after the block-phrase settle.
   * Spends a solve ONLY on a genuine, blocking widget (a rendered widget whose response-token field
   * is still empty) — never speculatively. A solve/inject failure is swallowed so it can never break
   * the action: the page is simply left challenged and the post-action snapshot reports it as blocked
   * (the caller's existing navFailed path). Does NOT recurse into {@link #settle}; the response field
   * is populated on success, so a re-entry would no-op on the gate. Cost/rate limiting is the solver's
   * own budget (R8). render() (retrieve) never reaches here — its CF tier is cleared by proxy, not a solver.
   *
   * Returns `true` when a token was injected but the page did NOT advance on its own — i.e. the caller
   * should REPLAY the triggering action to complete the flow. This is the mid-flow case: a form whose
   * submit was rejected for lack of a token, where injecting the token alone re-submits nothing. When
   * the widget's own `data-callback` advances the page (URL changes during the post-inject wait), this
   * returns `false` so the caller does NOT replay — avoiding a double-submit. No solve / no token /
   * stale page all return `false`.
   */
  async #trySolveCaptcha(page: PatchrightPage): Promise<boolean> {
    if (!this.#solver) return false;
    // Resolve the widget, polling out its render race: navigate() resolves at domcontentloaded, but
    // the response field is injected by a later async script, so a one-shot detect sees the container
    // with no field yet and would skip forever (the next detect pass re-navigates and re-races).
    const challenge = await awaitSolvableCaptcha(
      async () => (await page.evaluate(DETECT_LIVE_CAPTCHA_JS).catch(() => null)) as LiveCaptcha | null,
      () => page.url(),
      (ms) => page.waitForTimeout(ms).catch(() => {}),
      { pollMs: CAPTCHA_RENDER_POLL_MS, timeoutMs: CAPTCHA_RENDER_TIMEOUT_MS },
    );
    if (!challenge) return false;
    let token: string;
    try {
      token = await this.#solver.solve(challenge);
    } catch (err) {
      // Vendor error / timeout / budget: leave the page challenged rather than throw under the verb,
      // but emit a diagnostic so a left-challenged drive page has a WHY (parity with retrieve's
      // block-reason). ALLOWLIST the code: the built-in solver uses fixed typed codes, but an
      // injected/alternate solver places no restriction on `code`, so anything unrecognized becomes a
      // generic "error" (never echoed) — then still route through errCode (redact + URL-strip +
      // truncate) as belt-and-suspenders. This fifth stderr sink can't leak a secret/URL (R9, audit #3).
      const raw = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "error";
      const code = (CAPTCHA_SOLVE_ERROR_CODES as readonly string[]).includes(raw) ? raw : "error";
      process.stderr.write(`[browse-gateway] captcha solve failed (${errCode(code, this.#redact)}); page left challenged\n`);
      return false;
    }
    if (!token) return false;
    // The solve can run up to the solver's deadline; if the page navigated or the widget changed in
    // the meantime, the token is bound to a now-stale (url, siteKey). Re-verify before injecting, so a
    // token minted for the old page isn't written into a different one.
    const after = (await page.evaluate(DETECT_LIVE_CAPTCHA_JS).catch(() => null)) as LiveCaptcha | null;
    if (!after || after.siteKey !== challenge.siteKey || page.url() !== challenge.url) return false;
    // Snapshot the visible page state before injecting, so we can tell the site's own continuation
    // (advance — do NOT replay) from a stalled submit (nothing happened — DO replay). The widget's own
    // mutations (its iframe, the hidden response textarea) don't change main-document innerText, so it
    // is a clean signal for site-driven advancement.
    const beforeText = String(await page.evaluate(BODY_TEXT_JS).catch(() => ""));
    // Inject in the page's MAIN world (a real <script>), NOT page.evaluate's isolated world: the field
    // set works either way (shared DOM), but firing the site's data-callback needs the page's own
    // `window` (e.g. grecaptcha's config), which the isolated world can't see. The script tag isn't
    // rendered, so it doesn't perturb the body-text advance signal.
    await page.addScriptTag({ content: injectTokenJs(challenge.kind, token) }).catch(() => {});
    // Give the site's own continuation (a data-callback) a moment to fire — a fixed wait, NOT a
    // re-settle (which would re-enter this method).
    await page.waitForTimeout(DEFAULT_POLL_INTERVAL_MS).catch(() => {});
    // "Advanced" = the site already moved the flow forward, by navigating (URL change) OR by an
    // in-place/AJAX update from the widget's data-callback (visible-text change). A URL-only check
    // misses same-page callbacks and would double-submit them. If nothing advanced, the triggering
    // action was rejected pre-token and the caller must replay it once.
    if (page.url() !== challenge.url) return false;
    const afterText = await page.evaluate(BODY_TEXT_JS).catch(() => null);
    return afterText !== null && afterText === beforeText; // unchanged ⇒ stalled ⇒ replay needed
  }

  /**
   * Ref-annotated accessibility snapshot via Patchright's `ariaSnapshot({ mode: "ai" })`.
   *
   * The double-cast is deliberate: Patchright's published `Locator.ariaSnapshot` type does not yet
   * expose the `{ mode: "ai" }` overload (the ref-annotated path, verified on 1.60 where the older
   * internal `_snapshotForAI` was removed), so we widen to the call shape we actually invoke. The
   * `.catch(() => "")` degrades to an empty tree if the method is missing on an older build — note
   * that this masks a Patchright-version mismatch as a blank snapshot rather than a hard error, so
   * keep the pinned version ≥ 1.60.
   */
  async #snapshotOf(page: PatchrightPage): Promise<PageSnapshot> {
    const root = page.locator("html");
    const aria = root.ariaSnapshot as unknown as (
      opts: Record<string, unknown>,
    ) => Promise<string>;
    const tree = String(await aria.call(root, { mode: "ai" }).catch(() => ""));
    const title = await page.title().catch(() => "");
    return { url: page.url(), title, tree, status: this.#lastDocStatus ?? null };
  }

  /**
   * Low-level access to the owned browser context. Escape hatch for the policy layer's
   * integration checks and the future v1.1 drive()/CDP-attach surfaces — not part of the
   * vehicle-agnostic `BrowserCore` contract.
   */
  get context(): PatchrightContext {
    return this.#context;
  }

  async close(): Promise<void> {
    // Flip fail-closed FIRST so #onRequestPaused stops allowing during teardown. Then DETACH the
    // session (not Fetch.disable): Fetch.disable releases every still-paused request by CONTINUING it
    // (auto-allow — a redirect hop paused at the close instant must not slip the guard), whereas detach
    // drops the interception and the paused requests die with the context.close() that follows. No
    // Fetch consumer outlives Chrome.
    this.#closing = true;
    if (this.#cdpGuardSession) {
      await this.#cdpGuardSession.detach().catch(() => {});
      this.#cdpGuardSession = undefined;
    }
    await this.#context.close().catch(() => {});
  }
}

/**
 * Vehicle-agnostic factory. Currently always returns the Patchright core; a future
 * session/viewer vehicle would branch here without changing callers.
 */
export function createBrowserCore(
  opts: BrowserCoreOptions = {},
): Promise<BrowserCore> {
  return PatchrightBrowserCore.launch(opts);
}
