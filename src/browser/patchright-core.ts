/**
 * Patchright + real-Chrome browser core, headful under Xvfb — the spike-proven stealth
 * config and U1's shipping vehicle (see `steel-rejected-u1-vehicle`).
 */
import { chromium } from "patchright";
import { assertLocalCdpOnly } from "../security/cdp.js";
import { buildFailureDiagnostics, assembleTiming, FAILURE_DIAGNOSTICS_CAP } from "../observability/index.js";
import { hostFromUrl, hostMatchesAnySuffix } from "../security/url.js";
import { SecretStore, redactSecrets } from "../security/secrets.js";
import { buildWindowsUaOverride, buildNativeUaOverride, READ_LIVE_UA_JS, type LiveUserAgent } from "./os-presentation.js";
import { isCleared, isVisiblyBlocked, hasCloudflareHint, hasPerimeterXHint, hasDataDomeHint, MIN_CONTENT_LENGTH, type PageSignal } from "./detect.js";
import {
  DETECT_LIVE_CAPTCHA_JS,
  injectTokenJs,
  awaitSolvableCaptcha,
  activeCaptchaKind,
  isSolvableCaptchaKind,
  resolveCaptchaSolveReason,
  preAttemptSolveReason,
  firstSiteKey,
  CAPTCHA_SOLVE_ERROR_CODES,
  type CaptchaSolver,
  type CaptchaSolveReason,
  type CaptchaKind,
  type LiveCaptcha,
} from "./captcha.js";
import {
  buildLaunchOptions,
  buildLocalStorageSeedScript,
  resolveCoreOptions,
  type ResolvedCoreOptions,
} from "./launch-options.js";
import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
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

/**
 * Reach the launched Chromium OS process handle ONCE at launch, for the issue #50 force-kill primitive.
 *
 * patchright/Playwright expose no public child-process handle for a persistent context, so we cross the
 * in-process client↔server bridge that patchright itself uses (`_connection.toImpl`, wired because
 * patchright runs client and server in the same Node process): the client context resolves to the
 * server-side CRBrowserContext, whose `_browser.options.browserProcess.process` IS the Node
 * {@link ChildProcess} Chromium was spawned as. That handle gives us the leader PID (for a SIGKILL of
 * the process group) and an authoritative `'exit'` event (for death confirmation) with no live CDP
 * dependency, so it works even when the browser is CDP-wedged.
 *
 * Every link is feature-detected and the whole reach is try-wrapped: a future patchright that renames an
 * internal returns `undefined` here (force-kill degrades to unavailable — {@link PatchrightBrowserCore.forceKillAvailable}),
 * it NEVER throws at launch. The in-container gate asserts this succeeds on the shipping `channel:"chrome"`
 * build so a patchright bump that breaks it fails CI before deploy, not silently in prod.
 */
/** Death-confirmation deadline for the launch-time restore-failure cleanup force-kill (issue #50). Kept
 *  local to the core (the gateway's KILL_CONFIRM_MS is the teardown-path budget; this is the launch path). */
const LAUNCH_CLEANUP_KILL_CONFIRM_MS = 5_000;

/** True once a ChildProcess has terminated by EITHER a normal exit (`exitCode` set) or a signal
 *  (`signalCode` set — a SIGKILL'd child keeps `exitCode === null`). The authoritative "process is gone,
 *  do not re-signal its pid" predicate for the force-kill path (issue #50). `undefined` child → not known
 *  terminated (there's nothing to gate on). Never uses `child.killed` (that means "signal sent", not reaped). */
function childTerminated(child: ChildProcess | undefined): boolean {
  return child !== undefined && (child.exitCode !== null || child.signalCode !== null);
}

/**
 * Whether the force-kill path can run SAFELY for a core (issue #50). Requires the captured Chromium PID.
 * On **Linux** it ALSO requires the `/proc` start-time generation marker: without it, the reuse-safe
 * group check ({@link PatchrightBrowserCore.#ourGroupGone}) can't tell our group from a recycled pgid, so
 * force-kill would silently regress to the r5 cross-session-kill risk (real under `pids_limit=512`). A
 * missing marker therefore reports UNAVAILABLE (health-visible degrade) instead of running unsafe (codex
 * #50 r6). On non-Linux (macOS CLI) /proc is absent by design and the pid space is huge, so only the pid
 * is required. A `false` result degrades force-kill loudly (a launch-time stderr line) and is exposed via
 * the {@link PatchrightBrowserCore.forceKillAvailable} getter as the primitive for an operational health
 * surface (external wiring tracked as a follow-up). Exported pure for unit coverage. */
export function computeForceKillAvailable(
  pid: number | undefined,
  startTime: string | undefined,
  platform: NodeJS.Platform,
): boolean {
  if (pid === undefined) return false;
  if (platform === "linux") return startTime !== undefined;
  return true;
}

/**
 * Read `pid`'s process-group id and start-time from `/proc/<pid>/stat` (Linux). The start-time (field 22,
 * jiffies since boot) is a stable per-process GENERATION marker: it lets the force-kill path tell OUR
 * Chromium leader from an unrelated process that later reused the same pid — load-bearing under the
 * container's small pid space (`pids_limit=512`), where a freed pgid can be recycled as a new group
 * leader (issue #50 r5). Fields are parsed after the last ')' so a comm with spaces/parens can't shift
 * offsets. Returns `undefined` when /proc is unavailable (e.g. macOS CLI) or the pid is gone.
 */
function readProcStat(pid: number): { pgrp: number; startTime: string } | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const after = stat.slice(stat.lastIndexOf(")") + 2).split(" "); // [state, ppid, pgrp, ... starttime@idx19]
    const pgrp = after[2];
    const startTime = after[19];
    if (pgrp === undefined || startTime === undefined) return undefined;
    return { pgrp: Number(pgrp), startTime };
  } catch {
    return undefined;
  }
}

function captureBrowserProcess(
  context: PatchrightContext,
): { pid: number; child: ChildProcess } | undefined {
  try {
    const conn = (context as unknown as { _connection?: { toImpl?: (o: unknown) => unknown } })._connection;
    const impl = conn?.toImpl?.(context) as
      | { _browser?: { options?: { browserProcess?: { process?: ChildProcess } } } }
      | undefined;
    const child = impl?._browser?.options?.browserProcess?.process;
    if (child && typeof child.pid === "number") return { pid: child.pid, child };
  } catch {
    // Any shape change in the internal reach → degrade (return undefined), never throw at launch.
  }
  return undefined;
}

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
 * Opt-in flag for the failure screenshot (issue #39): when `BGW_CAPTURE_FAILURE_SCREENSHOT=1`, the core
 * captures a size-capped base64 PNG into the diagnostics envelope on render()/snapshot(). Default OFF —
 * a screenshot is expensive and carries rendered page content, so it is a deliberate debug opt-in.
 */
const FAILURE_SCREENSHOT_ENV = "BGW_CAPTURE_FAILURE_SCREENSHOT";
/** Size cap on the base64 screenshot carried in an envelope (~1.5 MB decoded). Over-cap → omitted, never
 *  truncated (a truncated base64 is invalid). Bounds the envelope so it can't balloon a caller payload. */
const MAX_SCREENSHOT_B64_LEN = 2_000_000;

/**
 * A snapshot ref looks like `e4` (top frame) or a frame-prefixed `f1e2`; anything else is a raw
 * selector. Drive verbs reference snapshot refs by default; a selector is the escape hatch.
 */
const REF_PATTERN = /^[a-z]?\d*e\d+$/i;

/** Visible body text — the post-inject advancement signal (catches same-page/AJAX callback updates). */
const BODY_TEXT_JS = "document.body ? document.body.innerText : ''";

/**
 * Whether a captured request marks the START of a NEW top-level navigation, so the per-navigation
 * evidence buffers (console / network / redirect — issue #39) reset. True only for a main-frame
 * navigation request that is NOT itself a redirect hop of an in-flight navigation: a redirect hop
 * CONTINUES the same navigation, so it must append to the redirect chain, not wipe it. Pure + exported
 * so the reset decision is unit-testable without a browser.
 */
export function isTopLevelNavStart(
  isNavigationRequest: boolean,
  isMainFrame: boolean,
  isRedirectHop: boolean,
): boolean {
  return isNavigationRequest && isMainFrame && !isRedirectHop;
}

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
  teardown?: () => Promise<void>,
): Promise<void> {
  if (!restore) return;
  try {
    // The core injects the bound `.state`; the `.ownerHost` is the gateway's navigation-clamp scope
    // (the core is a dumb injector — host-scoping the cookies is the vault layer's job upstream).
    await applyRestoreState(context, restore.state);
  } catch (err) {
    // On restore failure, tear the just-launched browser down. When the caller supplies a CONFIRMABLE
    // teardown (launch() passes graceful-close→force-kill-confirm — issue #50), use it so a wedged close
    // can't orphan a live browser; direct callers/tests fall back to the legacy best-effort close.
    if (teardown) await teardown().catch(() => {});
    else await context.close().catch(() => {});
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

/** Result of {@link PatchrightBrowserCore.#trySolveCaptcha}: whether the caller must replay the triggering
 *  action, plus the #42 solve wall-clock (present only when a solve was actually attempted) and — issue #44
 *  — the solver's typed error code when an attempted solve FAILED (previously written to stderr and
 *  discarded); absent when a solve succeeded or none was attempted. */
interface SolveResult {
  replay: boolean;
  captchaSolveMs?: number;
  solveReason?: CaptchaSolveReason;
}

/** Result of {@link PatchrightBrowserCore.#settle}: the replay signal (as before) plus the #42 stage
 *  wall-clocks — the action-nav DCL wait, the clearance-poll loop, and (bubbled-up) the captcha solve —
 *  so navigate() and the action path can build the per-op timing breakdown. `domContentLoadedMs` is a
 *  ~0ms no-op for navigate() (its goto already reached DCL) and is meaningful only for an ACTION that
 *  triggered an implicit navigation (a form submit). */
interface SettleResult {
  replay: boolean;
  domContentLoadedMs: number;
  clearancePollMs: number;
  captchaSolveMs?: number;
}

/**
 * Clamp a stage timeout to a shared per-call deadline (issue #43): the smaller of the raw timeout and the
 * time left until `deadlineMs` (an absolute `performance.now()` value), floored at `floorMs`. render() applies
 * it to the goto (floor 1 — Playwright treats a 0 timeout as INFINITE) and the clearance poll (floor 0 —
 * clearance is a while-loop, so 0 just skips the wait). Pure, so the budget arithmetic is unit-tested off the
 * real browser. Passing `deadlineMs === undefined` returns the raw timeout unchanged (unbudgeted render).
 */
export function deadlineBoundedTimeout(rawTimeoutMs: number, deadlineMs: number | undefined, now: number, floorMs: number): number {
  if (deadlineMs === undefined) return rawTimeoutMs;
  return Math.max(floorMs, Math.min(rawTimeoutMs, deadlineMs - now));
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
  /**
   * The launched Chromium's leader PID and Node ChildProcess handle, captured once at launch for the
   * issue #50 force-kill primitive. `undefined` when capture failed (a patchright internal changed shape)
   * — then {@link forceKillAvailable} is false and {@link kill} rejects (teardown degrades to
   * graceful-close-only). Never used for anything but SIGKILL + death-confirmation.
   */
  readonly #pid?: number;
  readonly #child?: ChildProcess;
  /** The leader's `/proc` start-time, captured at launch — a per-process GENERATION marker so the
   *  force-kill path never mistakes a RECYCLED pid/pgid for our browser (issue #50 r5). `undefined` when
   *  /proc is unavailable (macOS CLI) — the reuse check is then skipped (huge pid space → negligible). */
  readonly #leaderStartTime?: string;
  /** The single persistent page the interactive `drive` verbs act on (absent until navigate()). */
  #activePage?: PatchrightPage;
  /**
   * HTTP status of the active page's last main-frame navigation, kept current by a response listener
   * so it reflects click/submit-triggered navigations too — not just navigate(). Lets a post-action
   * snapshot carry a status, so a bare reputation block (4xx + thin) reached by an action is
   * detectable, not only a visible challenge phrase. `undefined` until the first navigation.
   */
  #lastDocStatus?: number | null;
  /**
   * Failure-evidence ring buffers (issue #39), each capped at {@link FAILURE_DIAGNOSTICS_CAP} so an
   * abusive page can never grow them unbounded (oldest dropped). `#redirectChain` accumulates each
   * main-document hop URL from the CDP Fetch interceptor (so it captures server 3xx hops); the console
   * and network buffers are filled by per-page listeners installed in render()'s page and the drive
   * active page. Reset at the start of each render()/navigate() so an envelope reflects the current
   * navigation, not a prior one.
   */
  #redirectChain: string[] = [];
  #consoleErrors: string[] = [];
  #networkFailures: string[] = [];
  /**
   * #42: the last drive ACTION's settle stages (clearance-poll + captcha-solve wall-clock), stashed by
   * {@link #act}/{@link pressKey} and consumed ONCE by the next {@link #snapshotOf}. A drive action verb
   * returns void and its snapshot is a SEPARATE core call, so this bridges the settle timing across that
   * boundary — otherwise a click that spent 30s in clearance would surface only snapshot-stage timing.
   * Cleared on read (consume-once), so a later bare `snapshot()` never inherits a stale action's stages;
   * `navigate()` builds its own timing and ignores this, so it can never leak into a nav snapshot.
   */
  #pendingActionTiming?: { clearancePollMs: number; captchaSolveMs?: number; domContentLoadedMs?: number };
  /**
   * #44: the typed error code from the last ATTEMPTED captcha solve that FAILED (vendor-error / timeout /
   * budget-exhausted / missing-sitekey), stashed by {@link #trySolveCaptcha} and consumed ONCE by the next
   * {@link #snapshotOf} — the same cross-call bridge as {@link #pendingActionTiming} (the solve runs inside
   * {@link #settle}, but the snapshot is a separate core call). Cleared on read, so a later snapshot never
   * inherits a stale attempt's reason; a pre-attempt why-not (`not-configured` / `unsupported-kind`) is
   * derived in #snapshotOf instead when no attempt was made.
   *
   * The attempted widget's IDENTITY rides with the reason (codex #44 r5/r6/r7): the page can navigate/rotate
   * its CAPTCHA while a solve is pending, so #snapshotOf adopts the reason only when the stashed identity
   * still matches the FINAL snapshot's widget — kind always, plus siteKey + url when known (the solve-failure
   * path, which has a full challenge identity; the give-up path carries only the kind of the current widget).
   * Otherwise it would report challenge A's failure against challenge B (even a same-kind one at a new key).
   *
   * SCOPED RESIDUAL (documented, best-effort DIAGNOSTIC — never gates behavior, the #40/#41/#42 line; codex
   * #44 r8): the reason↔widget binding across a rotation is not airtight. DOM reads are inherently async, so
   * a same-kind rotation in a sub-read window can still slip an old reason onto a new widget; the snapshot's
   * siteKey comes from {@link firstSiteKey} (the first raw `data-sitekey`), which on a MULTI-WIDGET page can
   * differ from the active widget's key; and the give-up path is kind-only (a full compare would false-drop a
   * legitimate `missing-sitekey`, siteKey=""). All cases mislead a READER of an exotic SPA/multi-widget
   * failure envelope, nothing more — the value is a diagnostic, consumed by no control path.
   */
  #pendingSolveOutcome?: { reason: CaptchaSolveReason; kind: CaptchaKind; siteKey?: string; url?: string };

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
    const captured = captureBrowserProcess(context);
    this.#pid = captured?.pid;
    this.#child = captured?.child;
    this.#leaderStartTime = captured ? readProcStat(captured.pid)?.startTime : undefined;
    if (!captured) {
      // Loud, distinctive, non-fatal (issue #50): the gateway is uptime-critical, so a patchright internal
      // rename must degrade force-kill, not down the whole process. The in-container capture gate is the
      // real tripwire; `forceKillAvailable` is surfaced to health so a degraded process is observable.
      process.stderr.write(
        "[browse-gateway] force-kill UNAVAILABLE: could not capture the Chromium PID at launch " +
          "(patchright internal shape changed); a wedged close will fall back to graceful-close-only\n",
      );
    } else if (!this.forceKillAvailable) {
      // PID captured but the Linux generation marker was not (a transient /proc read failure). Force-kill
      // is degraded rather than run reuse-UNSAFE (codex #50 r6) — logged loudly and exposed via the
      // forceKillAvailable getter (an operational health surface consuming it is tracked as a follow-up).
      process.stderr.write(
        "[browse-gateway] force-kill DEGRADED: captured the Chromium PID but not its /proc generation " +
          "marker; force-kill disabled to stay reuse-safe — a wedged close will fall back to graceful-close-only\n",
      );
    }
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
    // Construct the core NOW — BEFORE restore — so the Chromium PID is captured and a restore failure can
    // force-kill-CONFIRM the just-launched browser rather than best-effort-closing it (which could orphan a
    // live browser on a wedged close — codex #50 r4). The solver + windowsUaHosts + redactor are runtime
    // dependencies (not launch args) — pass through.
    const core = new PatchrightBrowserCore(context, resolved, opts.solver, opts.windowsUaHosts ?? [], redact);
    await restoreOrClose(context, opts.restoreState, () => core.#teardownDiscarded(redact));
    return core;
  }

  /**
   * BOUNDED confirmable teardown of a just-launched-then-DISCARDED browser (issue #50 r5) — used when a
   * restore blob is malformed. There is no session state to preserve, so we FORCE-KILL directly (bounded
   * by kill()'s own confirm deadline) rather than `await core.close()`, which on a wedged close would hang
   * launch() forever. Best-effort: the ORIGINAL restore error is what the caller surfaces. When force-kill
   * is unavailable (no PID), the graceful close is bounded by a timer so it still can't hang (patchright
   * force-kills at its own internal 30s). RESIDUAL: an unconfirmed force-kill here leaves a best-effort-
   * SIGKILL'd browser the launch layer can't hand to the manager's `#unconfirmed` set (launch() throws, no
   * core is returned) — prod's container namespace reaps it; routing it into manager accounting would need
   * a launch-contract change (tracked). Loudly logged either way.
   */
  async #teardownDiscarded(redact?: (s: string) => string): Promise<void> {
    if (this.forceKillAvailable) {
      await this.kill(LAUNCH_CLEANUP_KILL_CONFIRM_MS).catch((err) => {
        process.stderr.write(`[browse-gateway] restore-cleanup: force-kill unconfirmed (${errCode(err, redact)})\n`);
      });
      return;
    }
    await Promise.race([
      this.close().catch(() => {}),
      new Promise<void>((r) => {
        setTimeout(r, LAUNCH_CLEANUP_KILL_CONFIRM_MS).unref?.();
      }),
    ]);
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
    // #42 per-stage timing: WALL-CLOCK (performance.now) diffs only. t0 bounds the whole render body —
    // read INSIDE the return expression (before the finally closes the page), so page.close() time is
    // excluded from totalMs (it isn't part of the caller-visible retrieve latency).
    const t0 = performance.now();
    // Fresh per-call page ⇒ a fresh navigation: clear the evidence buffers and attach the console /
    // pageerror / requestfailed collectors so this render's failure envelope reflects only this page.
    this.#resetEvidence();
    const page = await this.#context.newPage();
    this.#attachEvidenceListeners(page);
    try {
      // Present as Windows for opt-in hosts BEFORE the first navigation (fresh per-call page). Inside the
      // try so the finally still closes the page if it throws; fail-closed — a listed host that can't get
      // the Windows identity errors out rather than rendering as Linux. Non-listed host = no-op (native).
      if (this.#shouldPresentWindows(url)) await this.#applyWindowsToFreshPage(page);
      let status: number | null = null;
      // domContentLoadedMs = goto wall-clock (waitUntil:"domcontentloaded" resolves AT DCL). Measured around
      // the try so a goto that THROWS (timeout / challenge abort) still records its time-to-abort.
      const goto0 = performance.now();
      // #43 (codex r5): when a shared per-call deadline is passed, clamp the goto timeout to what remains of
      // it, so navigation + the clearance poll below share ONE budget instead of each independently consuming
      // the full `remaining` (which let a 20s allowance run ~40s). Gated on the option, so unbudgeted renders
      // (the kill-gate, drive) are unchanged. max(1) avoids a 0 timeout — Playwright treats 0 as infinite.
      const navTimeout = deadlineBoundedTimeout(this.#resolved.navigationTimeoutMs, opts.budgetDeadlineMs, performance.now(), 1);
      try {
        const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: navTimeout });
        status = resp ? resp.status() : null;
      } catch {
        // Navigation may time out or be aborted by a challenge; assess whatever rendered.
      }
      const domContentLoadedMs = performance.now() - goto0;

      // Poll until the challenge clears (markers gone + content) or we time out. Challenges —
      // Cloudflare especially — solve client-side on a variable delay, so a fixed wait
      // under-counts clearance; this loop is the fix for that flakiness. Each poll fetches
      // only title+text (cheap); the full HTML is serialized once at the end.
      // #42: clearancePollMs is the WALL-CLOCK of this loop (each pollSignal round-trip costs real time in
      // the capped container), distinct from `waited` (the sleep-interval counter the kill-gate reads).
      const poll0 = performance.now();
      // #43 (codex r5): the clearance poll gets whatever remains of the shared per-call deadline AFTER the
      // goto (subtract actual navigation time), so nav + clearance can't each spend the full budget. Unbudgeted
      // renders keep the raw clearanceTimeoutMs.
      let signal = await pollSignal(page);
      let waited = 0;
      // #43 (codex r6/r7): bound the poll by WALL-CLOCK, not just the synthetic `waited` counter. Each sleep is
      // the smaller of the poll interval, the remaining STAGE budget (clearanceTimeoutMs − waited — so a small
      // BGW_CLEARANCE_TIMEOUT_MS isn't overshot by ~a poll interval), and the remaining GLOBAL budget; `waited`
      // accrues the ACTUAL sleep. After sleeping, skip the next pollSignal if the deadline passed — its
      // title()/evaluate() CDP calls are themselves unbounded. RESIDUAL (documented): pollSignal / snapshot /
      // extraction each still run their OWN (bounded-but-nonzero) duration past the deadline; a hard ceiling
      // that cancels an in-flight CDP call needs a top-level Promise.race / AbortSignal (the whole-op follow-up).
      while (!isCleared(signal, opts.clearedTextLength) && waited < clearanceTimeoutMs) {
        const budgetLeft = opts.budgetDeadlineMs !== undefined ? opts.budgetDeadlineMs - performance.now() : Infinity;
        const sleepMs = Math.min(pollIntervalMs, clearanceTimeoutMs - waited, budgetLeft);
        if (sleepMs <= 0) break;
        await page.waitForTimeout(sleepMs);
        waited += sleepMs;
        if (opts.budgetDeadlineMs !== undefined && performance.now() >= opts.budgetDeadlineMs) break;
        signal = await pollSignal(page);
      }
      const clearancePollMs = performance.now() - poll0;
      // Assemble the failure-evidence envelope (issue #39). finalUrl is page.url() AFTER redirects — the
      // real landed URL (render's own `url` is the requested arg, the bug this fixes). RAW here; the
      // retrieve surfacing layer redacts before it reaches a caller. Screenshot is opt-in + size-capped.
      // #42: snapshotMs spans BOTH the aria/content extraction AND the opt-in screenshot capture (which can
      // consume its own timeout when enabled), so a capture-on run doesn't leave that time unattributed.
      const snap0 = performance.now();
      const final = await snapshot(page);
      const screenshotRef = await this.#maybeCaptureScreenshot(page);
      const snapshotMs = performance.now() - snap0;
      const diagnostics = buildFailureDiagnostics({
        finalUrl: page.url(),
        title: final.title,
        status,
        redirectChain: this.#redirectChain,
        consoleErrors: this.#consoleErrors,
        networkFailures: this.#networkFailures,
        ...(screenshotRef !== undefined ? { screenshotRef } : {}),
      });
      // #42: clearanceWaitedMs (the sleep-interval counter) stays a first-class field for the stealth
      // kill-gate; timing.clearancePollMs is the accurate wall-clock (>= clearanceWaitedMs). The retrieve
      // verb overwrites totalMs with the whole-call wall-clock and folds this Timing into the failure envelope.
      // SCOPED: this totalMs is the render BODY wall-clock and excludes the finally's awaited page.close()
      // (computed in the return expression, before finally runs). The retrieve whole-call totalMs — which is
      // what callers surface — DOES include that close (its t0 spans withConsumerSession); only a direct
      // BrowserCore.render() caller reading this intermediate value sees the body-only total.
      const timing = assembleTiming({
        totalMs: performance.now() - t0,
        domContentLoadedMs,
        clearancePollMs,
        snapshotMs,
      });
      return { url, status, ...final, clearanceWaitedMs: waited, diagnostics, timing };
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
    // (Redirect-chain capture moved to the page "request" listener in #attachEvidenceListeners — it is
    // MAIN-FRAME-scoped and fires the per-navigation evidence reset, which the CDP layer can't see here.)
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
    // #42 per-stage timing: t0 bounds this core navigate() (goto + settle + snapshot). The drive
    // CONTROLLER overwrites totalMs with the whole-verb wall-clock (incl. escalation retries).
    const t0 = performance.now();
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
    // A new navigation begins here: clear the evidence buffers so this nav's failure envelope reflects
    // only this goto onward (the active page's console/requestfailed listeners persist across navs).
    this.#resetEvidence();
    // domContentLoadedMs = goto wall-clock (measured around the try so an aborted nav still records its
    // time-to-abort). Deliberately do NOT bind the goto response — status stays on #lastDocStatus (a CF
    // 403→200 reload makes goto's first response the wrong one; see the #lastDocStatus note above).
    const goto0 = performance.now();
    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        // #45: bound the goto by the shared per-call deadline too (parity with render()), so a proxied drive
        // attempt that starts near the budget can't run its full nav timeout past it. Floor 1ms — an already-
        // passed deadline still makes a bounded (fast-failing) attempt, never a zero/negative timeout. No
        // deadline passed (the action path, a budget-less caller) → the raw navigationTimeoutMs, unchanged.
        timeout: deadlineBoundedTimeout(this.#resolved.navigationTimeoutMs, opts.budgetDeadlineMs, performance.now(), 1),
      });
    } catch {
      // A challenge/redirect/dead-exit may abort the navigation; settle on whatever rendered. With no
      // main-frame response the listener leaves status null, so the drive layer treats it as a failed nav.
    }
    const domContentLoadedMs = performance.now() - goto0;
    // Give a client-side challenge (Cloudflare et al.) time to auto-solve, like render() does, and —
    // once it clears via a full reload — wait for the real document to land content rather than the
    // blank inter-navigation moment. A page still blocked after the budget is surfaced by navFailed.
    // #settle returns its clearance-poll + captcha-solve wall-clock for the #42 timing breakdown.
    const settled = await this.#settle(page, clearanceTimeoutMs, pollIntervalMs, opts.budgetDeadlineMs);
    // #58: the CF/PX/DataDome vendor hints + the interactive-CAPTCHA widget KIND are now computed inside
    // #snapshotOf (on EVERY snapshot), so `base` already carries cfHint/pxHint/ddHint/captchaKind — the
    // navigate path no longer computes them (nor a second page.content()) here. They let drive's escalation
    // recognize a CF interstitial with no visible CF phrase AND let the failure envelope attribute the
    // mitigation vendor, at parity with retrieve.
    const base = await this.#snapshotOf(page);
    // #42: assemble the per-nav Timing — the whole core-navigate wall-clock plus the goto / clearance /
    // captcha-solve / snapshot stages — as a FIRST-CLASS field (independent of the failure-only envelope;
    // the drive #failure seam folds it in on a block). Overrides #snapshotOf's snapshot-only timing.
    // domContentLoadedMs = the goto wall-clock PLUS #settle's own waitForLoadState wait: for a clean nav the
    // latter is a ~0 no-op (no double-count), but when the goto ABORTS/times-out before DCL, #settle spends
    // the real residual wait there — so summing keeps the nav stage accurate instead of dropping that time.
    const timing = assembleTiming({
      totalMs: performance.now() - t0,
      domContentLoadedMs: domContentLoadedMs + settled.domContentLoadedMs,
      clearancePollMs: settled.clearancePollMs,
      ...(settled.captchaSolveMs !== undefined ? { captchaSolveMs: settled.captchaSolveMs } : {}),
      ...(base.timing?.snapshotMs !== undefined ? { snapshotMs: base.timing.snapshotMs } : {}),
    });
    return { ...base, timing };
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
    const s1 = await this.#settle(page);
    let clearancePollMs = s1.clearancePollMs;
    let captchaSolveMs = s1.captchaSolveMs;
    let domContentLoadedMs = s1.domContentLoadedMs;
    if (s1.replay) {
      await page.keyboard.press(key).catch(() => {});
      const s2 = await this.#settle(page);
      clearancePollMs += s2.clearancePollMs; // #42: sum the poll across both settles
      if (s2.captchaSolveMs !== undefined) captchaSolveMs = (captchaSolveMs ?? 0) + s2.captchaSolveMs; // sum the solve
      domContentLoadedMs += s2.domContentLoadedMs; // sum the nav-to-DCL wait across both settles
    }
    // #42: stash so the controller's post-action snapshot() attributes this key press's clearance/solve/nav time.
    this.#pendingActionTiming = {
      clearancePollMs,
      ...(captchaSolveMs !== undefined ? { captchaSolveMs } : {}),
      ...(domContentLoadedMs >= 1 ? { domContentLoadedMs } : {}),
    };
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

  /** Push a line into a bounded evidence buffer, dropping the oldest once it exceeds the cap — so a page
   *  that logs thousands of console errors / failed requests can never grow the buffer unbounded. */
  #pushEvidence(buf: string[], line: string): void {
    buf.push(line);
    if (buf.length > FAILURE_DIAGNOSTICS_CAP) buf.shift();
  }

  /** Clear the per-navigation evidence buffers. Called at the start of each render()/navigate() and when
   *  a fresh active page opens, so an envelope reflects the CURRENT navigation, not a stale prior one. */
  #resetEvidence(): void {
    this.#redirectChain = [];
    this.#consoleErrors = [];
    this.#networkFailures = [];
  }

  /**
   * Install console / pageerror / requestfailed collectors on `page`, feeding the bounded evidence
   * buffers (issue #39). Best-effort per event — a detached/racing message can throw on access, so each
   * handler is wrapped. Only error/warning console messages are kept (info/log/debug are noise). Used on
   * BOTH render()'s per-call page and the drive active page, so the two paths capture the same evidence.
   */
  #attachEvidenceListeners(page: PatchrightPage): void {
    // Scope the evidence to the CURRENT top-level navigation. A main-frame navigation request resets the
    // buffers at its START (its first hop — `redirectedFrom() === null`) and appends each hop (incl.
    // server 3xx redirects) to the chain; a redirect hop continues the SAME nav and does NOT reset. This
    // fires for a click/type-submit/select/key-triggered navigation too — not only the navigate() method —
    // so a later blocked snapshot never mixes the prior page's console/network evidence (the 50-cap can't
    // evict the relevant lines with stale ones). A subframe request is ignored (not a top-level nav).
    page.on("request", (req) => {
      try {
        const isNav = req.isNavigationRequest();
        const isMain = req.frame() === page.mainFrame();
        if (!isNav || !isMain) return;
        if (isTopLevelNavStart(isNav, isMain, req.redirectedFrom() !== null)) this.#resetEvidence();
        this.#pushEvidence(this.#redirectChain, req.url());
      } catch {
        // a detached/superseded request can throw on access — ignore
      }
    });
    page.on("console", (msg) => {
      try {
        const type = msg.type();
        if (type === "error" || type === "warning") {
          this.#pushEvidence(this.#consoleErrors, `${type}: ${msg.text()}`);
        }
      } catch {
        // a message from a detached/navigating frame can throw on access — ignore
      }
    });
    page.on("pageerror", (err) => {
      try {
        this.#pushEvidence(this.#consoleErrors, `pageerror: ${err instanceof Error ? err.message : String(err)}`);
      } catch {
        // ignore
      }
    });
    page.on("requestfailed", (req) => {
      try {
        const errText = req.failure()?.errorText ?? "failed";
        this.#pushEvidence(this.#networkFailures, `${req.method()} ${req.url()} ${errText}`);
      } catch {
        // ignore
      }
    });
  }

  /**
   * Opt-in, size-capped failure screenshot for the diagnostics envelope (issue #39). Returns a base64
   * PNG only when `BGW_CAPTURE_FAILURE_SCREENSHOT=1` AND the encoding is under {@link
   * MAX_SCREENSHOT_B64_LEN}; otherwise undefined (default OFF, or over-cap → omitted, never truncated).
   * Best-effort: any capture failure yields undefined so it can never break a render/snapshot.
   */
  async #maybeCaptureScreenshot(page: PatchrightPage): Promise<string | undefined> {
    if (process.env[FAILURE_SCREENSHOT_ENV] !== "1") return undefined;
    try {
      const buf = await page.screenshot({ timeout: DEFAULT_ACTION_TIMEOUT_MS });
      const b64 = buf.toString("base64");
      return b64.length <= MAX_SCREENSHOT_B64_LEN ? b64 : undefined;
    } catch {
      return undefined;
    }
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
      // A fresh active page ⇒ fresh evidence: clear the buffers and install the console / pageerror /
      // requestfailed collectors that feed the drive path's failure envelope (issue #39).
      this.#resetEvidence();
      this.#attachEvidenceListeners(page);
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
    const s1 = await this.#settle(page);
    let clearancePollMs = s1.clearancePollMs;
    let captchaSolveMs = s1.captchaSolveMs;
    let domContentLoadedMs = s1.domContentLoadedMs;
    if (s1.replay) {
      // A CAPTCHA that appeared only on this action (e.g. a submit gated on reCAPTCHA) was rejected
      // before a token existed; the solve injected one but did not re-submit. Replay the action ONCE
      // so it completes with the token in place. Best-effort: a now-missing element just no-ops, and
      // the following settle won't re-solve (the response field is filled). (AE3/R8: continue, don't fail.)
      await fn(loc).catch(() => {});
      const s2 = await this.#settle(page);
      clearancePollMs += s2.clearancePollMs; // #42: sum the poll across both settles
      // Sum the solve too (a replay can hit a second / reset widget) — don't drop the second deadline.
      if (s2.captchaSolveMs !== undefined) captchaSolveMs = (captchaSolveMs ?? 0) + s2.captchaSolveMs;
      domContentLoadedMs += s2.domContentLoadedMs; // sum the nav-to-DCL wait across both settles
    }
    // #42: stash so the controller's post-action snapshot() attributes this action's clearance/solve/nav time.
    // domContentLoadedMs captures a DEFERRED navigation's DCL wait (a JS handler that navigates after the
    // click resolves); a SYNCHRONOUS form-submit nav is auto-waited inside the locator action (fn) itself, so
    // its time lands in the verb totalMs, not here (a Patchright locator-auto-wait limitation). Included only
    // when >= 1ms — a non-navigating click's ~0ms waitForLoadState no-op is omitted, per the Timing contract.
    this.#pendingActionTiming = {
      clearancePollMs,
      ...(captchaSolveMs !== undefined ? { captchaSolveMs } : {}),
      ...(domContentLoadedMs >= 1 ? { domContentLoadedMs } : {}),
    };
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
    // #45: the shared per-call deadline (absolute performance.now()). When set, the clearance poll below
    // breaks at it (parity with render's deadline-bounded poll). Undefined for the action path / a
    // budget-less caller → Infinity budget, poll behavior unchanged.
    budgetDeadlineMs?: number,
  ): Promise<SettleResult> {
    // Let any navigation the prior action triggered reach domcontentloaded, so its response status is
    // captured and the snapshot reflects the landed page (resolves immediately if nothing navigated).
    // #42: measure this wait — for an ACTION that submitted a form it IS the nav-to-DCL time (the dominant
    // stage on a slow submit); for navigate() it is a ~0ms no-op (its goto already reached DCL, and it uses
    // its own goto-based domContentLoadedMs instead).
    const dcl0 = performance.now();
    // #45 (codex r2): bound the DCL wait by the remaining per-call budget when one is set, so a pending DCL
    // can't burn its full default past the deadline. No deadline (the action path) → the default wait, unchanged.
    await page
      .waitForLoadState("domcontentloaded", budgetDeadlineMs !== undefined ? { timeout: Math.max(1, budgetDeadlineMs - performance.now()) } : {})
      .catch(() => {});
    const domContentLoadedMs = performance.now() - dcl0;
    // #42: clearancePollMs is the WALL-CLOCK of the poll loop, not the sleep-interval counter — each
    // pollSignal round-trip (title + innerText evaluate) costs real time in the capped container, so a
    // "15s" loop can take materially longer. The wall-clock is the accurate "time spent clearing".
    const poll0 = performance.now();
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
      // #45: when a per-call deadline is set, clamp this sleep to the remaining GLOBAL budget so a small
      // budget breaks the drive clearance poll early (parity with render's deadline-bounded poll). No deadline
      // (the action path / a budget-less caller) → budgetLeft is Infinity, so the sleep is exactly the poll
      // interval — BYTE-IDENTICAL to the prior behavior (the action path clearance timing is unchanged).
      const budgetLeft = budgetDeadlineMs !== undefined ? budgetDeadlineMs - performance.now() : Infinity;
      const sleepMs = Math.min(pollIntervalMs, budgetLeft);
      if (sleepMs <= 0) break;
      await page.waitForTimeout(sleepMs);
      waited += sleepMs;
      if (budgetDeadlineMs !== undefined && performance.now() >= budgetDeadlineMs) break;
      signal = await pollSignal(page);
    }
    const clearancePollMs = performance.now() - poll0;
    // #45 (codex r2): do NOT START a CAPTCHA solve once the per-call budget is spent — the solver runs its own
    // (up-to-~budget) timeout, which would let a budgeted drive call run ~2× its budget. Past the deadline,
    // leave the page challenged (the caller's navFailed path surfaces it) rather than beginning a fresh solve.
    // No deadline (the action path / a budget-less caller) → always attempt, unchanged.
    if (budgetDeadlineMs !== undefined && performance.now() >= budgetDeadlineMs) {
      return { replay: false, domContentLoadedMs, clearancePollMs };
    }
    // After client-side challenges settle, an INTERACTIVE captcha (reCAPTCHA/Turnstile/hCaptcha)
    // may still be blocking the flow. Auto-solve it transparently when a solver is configured. `replay`
    // is true when the caller should replay the triggering action to complete a submit-gated flow.
    // #42: the solve wall-clock bubbles up from #trySolveCaptcha.
    const solve = await this.#trySolveCaptcha(page, budgetDeadlineMs);
    return {
      replay: solve.replay,
      domContentLoadedMs,
      clearancePollMs,
      ...(solve.captchaSolveMs !== undefined ? { captchaSolveMs: solve.captchaSolveMs } : {}),
    };
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
   * Returns `replay: true` when a token was injected but the page did NOT advance on its own — i.e. the
   * caller should REPLAY the triggering action to complete the flow. This is the mid-flow case: a form
   * whose submit was rejected for lack of a token, where injecting the token alone re-submits nothing.
   * When the widget's own `data-callback` advances the page (URL changes during the post-inject wait),
   * this returns `replay: false` so the caller does NOT replay — avoiding a double-submit. No solve / no
   * token / stale page all return `replay: false`. #42: `captchaSolveMs` (the solver wall-clock) is set
   * whenever a solve was ATTEMPTED (a widget was found), including a solve that errored — so the drive
   * timing breakdown attributes the seconds a solve spent even when it ultimately failed.
   */
  async #trySolveCaptcha(page: PatchrightPage, budgetDeadlineMs?: number): Promise<SolveResult> {
    if (!this.#solver) return { replay: false };
    // #45 (codex r4): the remaining per-call budget bounds BOTH the widget-render poll AND the solve, so a
    // CAPTCHA reached JUST BEFORE the deadline can't run its full render-timeout + solver-timeout past it
    // (the earlier #settle guard only skips a solve already PAST the deadline). No deadline → the full budgets.
    const renderTimeoutMs =
      budgetDeadlineMs !== undefined ? Math.min(CAPTCHA_RENDER_TIMEOUT_MS, Math.max(0, budgetDeadlineMs - performance.now())) : CAPTCHA_RENDER_TIMEOUT_MS;
    // Resolve the widget, polling out its render race: navigate() resolves at domcontentloaded, but
    // the response field is injected by a later async script, so a one-shot detect sees the container
    // with no field yet and would skip forever (the next detect pass re-navigates and re-races).
    const challenge = await awaitSolvableCaptcha(
      async () => (await page.evaluate(DETECT_LIVE_CAPTCHA_JS).catch(() => null)) as LiveCaptcha | null,
      () => page.url(),
      (ms) => page.waitForTimeout(ms).catch(() => {}),
      { pollMs: CAPTCHA_RENDER_POLL_MS, timeoutMs: renderTimeoutMs },
    );
    if (!challenge) {
      // #44 (codex r2): a supported widget was detected but never became attemptable — preserve WHY (no
      // sitekey / the response field never rendered within the budget) instead of dropping it, so the
      // envelope's why-not isn't silently omitted while solverEligible stays true. One final live read
      // classifies it; an already-solved / solvable-now / absent widget yields undefined (no failure).
      const live = (await page.evaluate(DETECT_LIVE_CAPTCHA_JS).catch(() => null)) as LiveCaptcha | null;
      const reason = preAttemptSolveReason(live);
      // Kind-only identity here (not full): this reason is read from the CURRENT widget synchronously (no
      // pending async solve to outlive a rotation), and a `missing-sitekey` outcome carries siteKey="" — for
      // which a full siteKey compare in #snapshotOf would false-DROP a legitimate no-key reason. See the
      // documented reason-attribution residual on the #pendingSolveOutcome field (codex #44 r8).
      if (reason && live) this.#pendingSolveOutcome = { reason, kind: live.kind };
      return { replay: false, ...(reason ? { solveReason: reason } : {}) };
    }
    // #42: measure the solver wall-clock from here (a widget IS present, so a solve is being attempted).
    const solve0 = performance.now();
    let token: string;
    try {
      token = await this.#solver.solve(challenge, budgetDeadlineMs); // #45 (codex r4): cap by the remaining call budget
    } catch (err) {
      // Vendor error / timeout / budget: leave the page challenged rather than throw under the verb,
      // but emit a diagnostic so a left-challenged drive page has a WHY (parity with retrieve's
      // block-reason). ALLOWLIST the code: the built-in solver uses fixed typed codes, but an
      // injected/alternate solver places no restriction on `code`, so anything unrecognized becomes a
      // generic "error" (never echoed) — then still route through errCode (redact + URL-strip +
      // truncate) as belt-and-suspenders. This fifth stderr sink can't leak a secret/URL (R9, audit #3).
      const raw = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "error";
      const code: CaptchaSolveReason = (CAPTCHA_SOLVE_ERROR_CODES as readonly string[]).includes(raw)
        ? (raw as CaptchaSolveReason)
        : "error";
      process.stderr.write(`[browse-gateway] captcha solve failed (${errCode(code, this.#redact)}); page left challenged\n`);
      // #44: surface the typed code instead of DISCARDING it to stderr only. It's a closed-vocabulary,
      // secret-free marker (never the API key; a sitekey is public) — returned so #settle can bubble it, and
      // stashed for the next #snapshotOf. `error` covers an unrecognized code (already allowlist-collapsed).
      // Attribute the failure ONLY if the page still shows the SAME challenge we attempted (codex r5/r6): a
      // pending solve can outlive a rotation to a DIFFERENT widget — even a same-kind one at a new siteKey/URL
      // — so revalidate the FULL identity (kind + siteKey + url) here, exactly as the successful-token branch
      // below does, before stashing. #snapshotOf then re-checks the kind against the final HTML as a second
      // guard (a rotation between this read and the snapshot).
      const after = (await page.evaluate(DETECT_LIVE_CAPTCHA_JS).catch(() => null)) as LiveCaptcha | null;
      if (after && after.kind === challenge.kind && after.siteKey === challenge.siteKey && page.url() === challenge.url) {
        // Carry the FULL identity (codex r7) so #snapshotOf can re-reject a same-kind rotation that happens
        // in the gap between this read and the snapshot's HTML capture.
        this.#pendingSolveOutcome = { reason: code, kind: challenge.kind, ...(challenge.siteKey ? { siteKey: challenge.siteKey } : {}), url: challenge.url };
      }
      return { replay: false, captchaSolveMs: performance.now() - solve0, solveReason: code };
    }
    const captchaSolveMs = performance.now() - solve0;
    if (!token) return { replay: false, captchaSolveMs };
    // The solve can run up to the solver's deadline; if the page navigated or the widget changed in
    // the meantime, the token is bound to a now-stale (url, siteKey). Re-verify before injecting, so a
    // token minted for the old page isn't written into a different one.
    const after = (await page.evaluate(DETECT_LIVE_CAPTCHA_JS).catch(() => null)) as LiveCaptcha | null;
    if (!after || after.siteKey !== challenge.siteKey || page.url() !== challenge.url) return { replay: false, captchaSolveMs };
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
    if (page.url() !== challenge.url) return { replay: false, captchaSolveMs };
    const afterText = await page.evaluate(BODY_TEXT_JS).catch(() => null);
    return { replay: afterText !== null && afterText === beforeText, captchaSolveMs }; // unchanged ⇒ stalled ⇒ replay
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
    // #42: t0 bounds the aria/title/screenshot extraction — the snapshotMs stage, and a bare snapshot()
    // verb's whole cost (its totalMs). navigate() and the drive controller override totalMs with the wider
    // nav/verb wall-clock.
    const t0 = performance.now();
    const root = page.locator("html");
    const aria = root.ariaSnapshot as unknown as (
      opts: Record<string, unknown>,
    ) => Promise<string>;
    const tree = String(await aria.call(root, { mode: "ai" }).catch(() => ""));
    const title = await page.title().catch(() => "");
    const status = this.#lastDocStatus ?? null;
    const finalUrl = page.url();
    // #58: compute the CF/PX/DataDome vendor-hint booleans + the active-CAPTCHA widget KIND on EVERY
    // snapshot — not just navigate() — so a drive ACTION-failure envelope (built from a bare snapshot() via
    // #actAndSnap → #failure) attributes the mitigation vendor at parity with the navigate path and
    // retrieve. `page.content()` serializes the TOP document (the same HTML source navigate() used; a bare
    // reCAPTCHA/hCaptcha/Turnstile page carries its widget class there). This adds ONE DOM serialization per
    // action snapshot — the accepted #58 tradeoff (previously only navigate() paid it). activeCaptchaKind
    // binds the kind to an ACTIVE widget container, so it can't mislabel a WAF block's vendor (codex #40 r3/r4).
    const html = String(await page.content().catch(() => ""));
    const captchaKind = activeCaptchaKind(html);
    // #44: solver eligibility (a pure KIND property) + why a solve wasn't completed. captchaSolveReason
    // prefers the stashed code from an ACTUAL failed attempt (#trySolveCaptcha ran in this op's #settle);
    // else a pre-attempt why-not derived from the kind — `not-configured` (no solver wired) or
    // `unsupported-kind` (the widget kind isn't solvable). Consume-once: clear the stash so a later bare
    // snapshot() can't inherit a stale attempt's reason. Both are set only when a CAPTCHA is present.
    // The stashed reason is adopted ONLY when its attempted IDENTITY still matches THIS final snapshot's
    // widget (codex r5/r6/r7) — a page that rotated its CAPTCHA mid-solve must not report challenge A's
    // failure on B. Kind always; plus siteKey + url when the stash carried them (the solve-failure path) so a
    // same-kind rotation to a new key/URL in the gap before this HTML capture is also rejected. Compared
    // against the captured `html` + `finalUrl` (this snapshot's moment), so the check is accurate for it.
    const solveOutcome = this.#pendingSolveOutcome;
    this.#pendingSolveOutcome = undefined;
    const identityMatches =
      solveOutcome != null &&
      solveOutcome.kind === captchaKind &&
      (solveOutcome.url === undefined || solveOutcome.url === finalUrl) &&
      (solveOutcome.siteKey === undefined || solveOutcome.siteKey === firstSiteKey(html));
    const attemptReason = identityMatches ? solveOutcome.reason : undefined;
    const solverEligible = captchaKind ? isSolvableCaptchaKind(captchaKind) : undefined;
    const captchaSolveReason = resolveCaptchaSolveReason({
      captchaKind,
      solverPresent: this.#solver != null,
      ...(attemptReason ? { attemptReason } : {}),
    });
    // Assemble the failure-evidence envelope (issue #39) into EVERY snapshot — both navigate() and a
    // post-action snapshot() — so the drive layer can attach it to a thrown failure at parity with
    // retrieve. RAW here; the drive surfacing seam redacts before it reaches a caller. Screenshot is
    // opt-in + size-capped. Timing is NOT folded here — it rides the first-class `timing` field below and
    // is folded into the envelope at the surface seam (#failure), matching the #40/#41 slot pattern.
    const screenshotRef = await this.#maybeCaptureScreenshot(page);
    const diagnostics = buildFailureDiagnostics({
      finalUrl,
      title,
      status,
      redirectChain: this.#redirectChain,
      consoleErrors: this.#consoleErrors,
      networkFailures: this.#networkFailures,
      ...(screenshotRef !== undefined ? { screenshotRef } : {}),
    });
    const snapshotMs = performance.now() - t0;
    // #42: fold in any pending drive-action settle stages (consume-once), so a post-action snapshot after a
    // click/type that triggered a challenge attributes the clearance/solve time. navigate() ignores this
    // (it builds its own timing from its local settle return) — its #snapshotOf call just clears any leftover.
    const pending = this.#pendingActionTiming;
    this.#pendingActionTiming = undefined;
    const timing = assembleTiming({ totalMs: snapshotMs, snapshotMs, ...pending });
    return {
      url: finalUrl,
      title,
      tree,
      status,
      diagnostics,
      timing,
      cfHint: hasCloudflareHint(html),
      pxHint: hasPerimeterXHint(html),
      ddHint: hasDataDomeHint(html),
      ...(captchaKind ? { captchaKind } : {}),
      ...(solverEligible !== undefined ? { solverEligible } : {}),
      ...(captchaSolveReason ? { captchaSolveReason } : {}),
    };
  }

  /**
   * Low-level access to the owned browser context. Escape hatch for the policy layer's
   * integration checks and the future v1.1 drive()/CDP-attach surfaces — not part of the
   * vehicle-agnostic `BrowserCore` contract.
   */
  get context(): PatchrightContext {
    return this.#context;
  }

  /** Whether {@link kill} can force-kill this core SAFELY — see {@link computeForceKillAvailable}. On Linux
   *  this requires the generation marker too, so a missing marker degrades LOUDLY (health-visible) rather
   *  than silently running the reuse-unsafe path (codex #50 r6). */
  get forceKillAvailable(): boolean {
    return computeForceKillAvailable(this.#pid, this.#leaderStartTime, process.platform);
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
    // Let a context.close() failure PROPAGATE (issue #50): the session manager frees a capacity slot only
    // on a CONFIRMED close, so a swallowed failure would let it treat a still-alive browser as dead and
    // admit a replacement past the cap. A failed/wedged close now surfaces so the manager escalates to
    // kill() instead of mistaking it for a dead browser. The guard-detach above stays best-effort —
    // detaching an already-gone CDP session is benign and must not block or fail the real teardown.
    await this.#context.close();
  }

  /**
   * Force-kill the browser (issue #50) and CONFIRM its whole process TREE is gone. Confirmation keys off
   * the process GROUP being empty — NOT the leader pid alone: patchright spawns Chrome detached as its own
   * group leader, and the leader dying does not imply its renderer/GPU/zygote children are gone (codex #50
   * r3). So:
   *  - if the group is ALREADY empty, there is nothing to signal (avoids re-signaling a possibly-recycled
   *    pgid) — resolve;
   *  - otherwise SIGKILL the process GROUP (`-pid`) unconditionally (reaps surviving children even when the
   *    leader already died), and SIGKILL the leader pid only while it is KNOWN-ALIVE (once terminated its
   *    pid may be recycled — `childTerminated` consults exitCode AND signalCode, since a SIGKILL'd child
   *    leaves exitCode null and sets signalCode);
   *  - then poll until the group is empty (`kill(-pid, 0)`→ESRCH), rejecting if not within `confirmMs`.
   * Group-based confirmation is reuse-safe-DIRECTION: a pgid is not recycled while any member lives, so a
   * lingering child keeps `-pid` pointing at OUR group and a "non-empty" reading only ever delays (never
   * false-frees) the confirmation. Idempotent + re-runnable so the manager's reconfirm loop can retry.
   * Rejects immediately when no PID was captured (force-kill unavailable).
   */
  async kill(confirmMs: number): Promise<void> {
    const pid = this.#pid;
    // Refuse unless force-kill is SAFELY available (a captured PID, plus the /proc generation marker on
    // Linux — codex #50 r6). Refusing here degrades a wedged teardown to a counted zombie (the caller
    // retains + reconfirms) rather than running the reuse-unsafe group signal.
    if (pid === undefined || !this.forceKillAvailable) {
      throw new Error("force-kill unavailable: no Chromium PID / generation marker captured at launch");
    }
    this.#closing = true; // fail-closed during teardown, same as close()
    if (this.#ourGroupGone(pid)) return; // our whole tree already gone (or the pgid was recycled) — no signal
    this.#sigkill(-pid); // process group: reaps renderers/GPU/zygote even if the leader already died
    if (!childTerminated(this.#child)) this.#sigkill(pid); // leader, only while its pid can't be recycled
    await this.#confirmGroupGone(pid, confirmMs);
  }

  /**
   * True when OUR browser's process group has no living member — the reuse-safe successor to a bare
   * `kill(-pid,0)` empty check (issue #50 r5). A truly-empty group ESRCHes. A NON-empty group `pid` is
   * treated as GONE when it is a RECYCLED group — the pid is present AS A GROUP LEADER (`pgrp === pid`)
   * with a start-time different from the one captured at launch — because under the container's small pid
   * space (`pids_limit=512`) a freed pgid can be recycled as an unrelated group's leader, and we must
   * never mistake that group for ours (and so never signal it on a reconfirm). A non-leader that merely
   * reused the pid sits in a DIFFERENT group, so `kill(-pid, …)` never reaches it — a lingering child
   * still keeps our group ours. When /proc is unavailable (macOS CLI) the recycle check is skipped.
   */
  #ourGroupGone(pid: number): boolean {
    try {
      process.kill(-pid, 0); // group liveness probe (signal 0): succeeds while any member lives
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // ESRCH = truly empty. EPERM = a member we can't signal — not our same-uid Chrome, so our tree is gone.
      return code === "ESRCH" || code === "EPERM";
    }
    if (this.#leaderStartTime !== undefined) {
      const stat = readProcStat(pid);
      // Recycled group: pid present, IS a group leader (pgrp === pid), DIFFERENT generation → not ours.
      if (stat && stat.pgrp === pid && stat.startTime !== this.#leaderStartTime) return true;
    }
    return false; // ours (leader alive, or a lingering child, or reuse-check unavailable) → non-empty
  }

  /** Best-effort SIGKILL. ESRCH (target already gone) is success-shaped input to the confirm step, not an
   *  error; any other errno is logged and swallowed — the confirm poll is the source of truth for death. */
  #sigkill(target: number): void {
    try {
      process.kill(target, "SIGKILL");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") {
        process.stderr.write(`[browse-gateway] SIGKILL ${target} failed (${errCode(err, this.#redact)})\n`);
      }
    }
  }

  /** Resolve once OUR browser's whole process group is gone (every captured-group member reaped; a
   *  recycled pgid counts as gone — see {@link #ourGroupGone}), reject if not within `deadlineMs`.
   *  Confirms the WHOLE tree, not just the leader. Confirm-ONLY — it never re-signals, so it can't hit a
   *  recycled group. NOT unref'd: a force-kill confirm is foreground and must keep the loop alive. */
  #confirmGroupGone(pid: number, deadlineMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (dead: boolean): void => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(deadline);
        if (dead) resolve();
        else reject(new Error(`force-kill: process group ${pid} not confirmed gone within ${deadlineMs}ms`));
      };
      const probe = (): void => {
        if (this.#ourGroupGone(pid)) finish(true);
      };
      // NOT unref'd: an in-flight force-kill confirmation is a foreground operation that must keep the
      // process alive until it settles — the browser ChildProcess handle no longer anchors the event loop
      // (we confirm by polling the process group, not the child 'exit' event), and both timers are cleared
      // the instant finish() runs, so they never linger past the bounded confirm.
      const poll = setInterval(probe, 100);
      const deadline = setTimeout(() => finish(false), deadlineMs);
      probe(); // the group may already be empty
    });
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
