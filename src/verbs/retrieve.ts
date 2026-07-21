/**
 * `retrieve(url) -> clean markdown` (R10, R11) — the v1 outcome verb. Mechanics (stealth,
 * allowlist, proxy escalation, CAPTCHA) stay hidden from the caller, who just gets content.
 *
 * Flow: render direct through an authenticated session -> optional CAPTCHA solve ->
 * scoped proxy re-render on a CF managed challenge OR a hard IP/WAF-reputation block, from a
 * datacenter IP (R7), retried across fresh rotating exits -> extract readable markdown. Proxy
 * creds come from the U4 SecretStore; the CAPTCHA solver is injected (R8).
 */
import { randomBytes } from "node:crypto";
import {
  isVisiblyBlocked,
  isHardBlock,
  isCloudflareVisible,
  isPerimeterXVisible,
  isPerimeterXChallenge,
  hasCloudflareHint,
  hasPerimeterXHint,
  hasDataDomeHint,
  hasPerimeterXChallengeCopy,
  hasEmptyStateMarker,
  hasUnsupportedBrowserPhrase,
  hasFrameworkRoot,
  activeCaptchaKind,
  MIN_CONTENT_LENGTH,
} from "../browser/index.js";
import type { ProxyConfig, RenderOptions, RenderResult } from "../browser/index.js";
import { redactFailureDiagnostics, sanitizeUrlForError, assembleTiming } from "../observability/index.js";
import type { FailureDiagnostics, WafVendor, FailureClass, Timing } from "../observability/index.js";
export type { WafVendor, FailureClass, Timing } from "../observability/index.js";
import type { Gateway } from "../gateway/index.js";
import { isHttpUrl } from "../security/index.js";
import type { SecretStore } from "../security/index.js";
import { extractMarkdown } from "./extract.js";
import { shouldEscalateToProxy } from "./escalation.js";
import type { EscalationContext } from "./escalation.js";
import { detectCaptcha } from "./captcha.js";
import type { CaptchaSolver, CaptchaKind } from "./captcha.js";

/**
 * Proxy-escalation retries (R7). A rotating residential proxy assigns a fresh exit IP per
 * session/connection, and a fraction of exits are dead or slow (verified 2026-06-01: ~83% good
 * per fresh session; dead exits fail fast with `net::ERR_EMPTY_RESPONSE`, good-but-slow exits up
 * to ~17s). Each retry re-acquires a fresh proxied SESSION — and therefore a fresh exit — so we
 * retry the whole session (never just a new page on the same context, which reuses the same bad
 * exit) until a real page lands or attempts run out. `PROXY_NAV_TIMEOUT_MS` bounds a hung exit
 * with margin over the slowest good exit observed, so a retry past a dead exit stays fast.
 */
export const PROXY_MAX_ATTEMPTS = 3;
export const PROXY_NAV_TIMEOUT_MS = 25_000;

/**
 * Clearance budget for PROXIED attempts (both verbs). A CF interstitial on a held residential exit
 * was measured clearing at ~22s (probe, 2026-06-09) — over both defaults (render 20s, drive 15s), so
 * escalated attempts were timing out mid-challenge even on a healthy exit. A page that renders real
 * content returns as soon as it clears (the poll exits on cleared content, not at the deadline); a
 * still-blocked, thin, or dead exit consumes the budget — so the worst case is PROXY_MAX_ATTEMPTS x
 * (nav timeout + this) ≈ 210s, bounded under the 5-min drive idle-reaper TTL.
 */
export const PROXY_CLEARANCE_TIMEOUT_MS = 45_000;

export interface RetrieveOptions {
  token: string;
  url: string;
  /** Escalation context. Defaults: not on a datacenter IP (so escalation stays off). */
  escalation?: Partial<EscalationContext>;
  /** Injected CAPTCHA solver; omitted = no solving (a detected CAPTCHA is left to fail). */
  solver?: CaptchaSolver;
  clearanceTimeoutMs?: number;
  /**
   * Sticky-session suffix template for proxied attempts (deployment config,
   * `BGW_PROXY_STICKY_SUFFIX`; the provider-specific syntax lives only in the deployment env — see
   * {@link mintStickyProxy}). Absent = rotating exits (prior behavior), which cannot clear a CF
   * interstitial: the challenge binds to one IP and per-request rotation moves it mid-handshake.
   */
  stickySuffix?: string;
  /** Force residential from the FIRST render (skip the direct attempt) for a known-hostile host
   *  (issue #21). The MCP layer resolves this from the {forceProxy} option + BGW_FORCE_PROXY_HOSTS. */
  forceProxy?: boolean;
}

/**
 * Why the final render counts as blocked — a diagnostic surfaced to the caller so a failure says
 * WHY instead of a silent "blocked": `nav-failed` (no response — off-allowlist/unreachable),
 * `captcha` (an interactive CAPTCHA widget — needs a solver, not wired in v1), `cf-challenge`
 * (a Cloudflare managed challenge), `perimeterx-challenge` (a PerimeterX/HUMAN "Press & Hold"
 * behavioral interstitial — classified for diagnostics, NOT solved by the token CAPTCHA tier),
 * `datadome-challenge` (a DataDome/HUMAN block — classified for diagnostics via the persistent DataDome
 * markers; behavioral, NOT solved by the token CAPTCHA tier, and NOT escalated — see escalation.ts),
 * `hard-block` (4xx/5xx + thin body — IP/WAF reputation), `blocked` (some other visible block
 * phrase). `null` when not blocked.
 */
export type BlockReason =
  | "nav-failed"
  | "captcha"
  | "cf-challenge"
  | "perimeterx-challenge"
  | "datadome-challenge"
  | "hard-block"
  | "blocked";

/**
 * The single retrieve-FAILURE predicate, shared by {@link retrieve} (to attach + redact the
 * failure-diagnostics envelope, #39) and the MCP surface (`server.ts`, to fail the tool call) so the
 * two can never disagree — a page the MCP layer errors on must always carry evidence. A retrieve failed
 * when it was `blocked`, produced empty/whitespace `markdown` (empty extraction — the status-200 +
 * blank-body case that `blocked` alone misses), OR the navigation never landed (null status + thin
 * body — an off-allowlist/unreachable target whose thin error page must not be handed back as content).
 */
export function isRetrieveFailure(r: { blocked: boolean; markdown: string; status: number | null }): boolean {
  const navFailed = r.status === null && r.markdown.length < MIN_CONTENT_LENGTH;
  return r.blocked || r.markdown.trim().length === 0 || navFailed;
}

export interface RetrieveResult {
  url: string;
  status: number | null;
  title: string;
  markdown: string;
  /** Readability found no article and we degraded to a direct conversion. */
  degraded: boolean;
  /** The final rendered page still looked blocked/challenged. */
  blocked: boolean;
  /** Why it was blocked (diagnostic); `null` when not blocked. See {@link BlockReason}. */
  reason: BlockReason | null;
  /** The residential proxy was engaged (scoped escalation fired). */
  proxyUsed: boolean;
  /** A CAPTCHA was detected and handed to the solver. */
  captchaSolved: boolean;
  /** Structured proxy-escalation diagnostics when escalation ran (issue #21); absent otherwise. */
  proxyDiagnostic?: EscalationDiagnostics;
  /**
   * Failure-evidence envelope (issue #39): finalUrl (post-redirect) / title / status / redirect chain /
   * bounded console + network / optional screenshot — surfaced ONLY on a blocked/failed retrieve, and
   * REDACTED (secret set scrubbed + cookie/authorization stripped) before it reaches here. Absent on a
   * successful retrieve, so the success shape is unchanged. Distinct from {@link proxyDiagnostic} (the
   * proxy-escalation tally) — this is the page-evidence bundle the site-compat epic (#38) reports through.
   */
  diagnostics?: FailureDiagnostics;
  /**
   * Per-stage {@link Timing} (issue #42) — the wall-clock breakdown for the WHOLE retrieve call: `totalMs`
   * (this call, start to finish) plus the final surfaced render's core stages (domContentLoaded /
   * clearancePoll / snapshot). ALWAYS present (success and failure) — the measurement half of "why did it
   * take 200s". Per proxied-attempt durations ride {@link EscalationDiagnostics.attemptMs}. On a failed
   * retrieve the SAME Timing is folded into {@link diagnostics}, so the two can never disagree.
   */
  timing: Timing;
}

/**
 * The reduced signal surface block classification reads: title + visible text + final status + the
 * HTML-derived vendor hints carried as booleans. retrieve passes hints computed from the full render
 * HTML; drive passes the booleans its {@link PageSnapshot} already carries (cfHint/pxHint) — so both
 * paths classify a block identically on one shared surface (the drive↔retrieve detection-parity
 * invariant).
 */
export interface BlockSignal {
  title: string;
  text: string;
  status: number | null;
  cfHint?: boolean;
  pxHint?: boolean;
  /** DataDome HTML marker (`datadome`/`captcha-delivery`/`dd_cookie`) is present — the DataDome sibling
   * of {@link cfHint}. Attribution only (issue #40): like cfHint/pxHint it PERSISTS after a clear, so it
   * re-labels an ALREADY-blocked page's reason to `datadome-challenge` but is never itself a `blocked`
   * input. retrieve computes it from the render HTML; drive carries it on its {@link PageSnapshot}. */
  ddHint?: boolean;
  /** The ACTIVE interactive-CAPTCHA widget kind ({@link CaptchaKind}), set ONLY when a real widget
   * (a `data-sitekey` container) is present — NOT a merely-loaded captcha library (issue #40, codex r3).
   * {@link resolveBlockReason} promotes an otherwise-generic block (`hard-block`/`blocked`) to `captcha`
   * on this, so a specific WAF vendor still wins and a preloaded library can't mislabel a WAF block. */
  captchaKind?: CaptchaKind;
  /** PerimeterX challenge COPY ("Press & Hold") is present in the page source — the iframe-served
   * challenge whose phrase reaches the HTML but not the innerText `text`. retrieve computes it from
   * the render HTML (drive's snapshot carries no HTML, so it leaves this unset and relies on
   * pxHint+thin). Absent on a cleared page, so it never false-positives a success. */
  pxCopy?: boolean;
}

/**
 * Classify WHY a page is blocked, most-actionable-first, or `null` when it is not blocked. The
 * single source of truth for vendor/hard-block attribution shared by retrieve and drive.
 * Interactive-CAPTCHA-widget detection is NOT covered here (it needs raw HTML + sitekey — that stays
 * in retrieve's {@link detectCaptcha}).
 */
export function classifyBlock(sig: BlockSignal): BlockReason | null {
  // PerimeterX press-&-hold, served either as a thin iframe (no content) or — the case that slipped
  // #24 — a boundary-length 200 whose challenge copy is in the source but not the innerText. Both
  // gated by pxHint so a non-PX page can't false-positive.
  const pxChallenge =
    isPerimeterXChallenge(sig, sig.pxHint === true) || (sig.pxHint === true && sig.pxCopy === true);
  const blocked =
    sig.status === null || isVisiblyBlocked(sig) || pxChallenge || isHardBlock(sig, sig.status);
  if (!blocked) return null;
  if (sig.status === null) return "nav-failed";
  if (isCloudflareVisible(sig) || sig.cfHint === true) return "cf-challenge";
  if (isPerimeterXVisible(sig) || sig.pxHint === true) return "perimeterx-challenge";
  // DataDome: re-label an already-blocked page carrying a DataDome marker (issue #40) so it stops
  // falling through to a generic `hard-block`/`blocked`. Mirrors the cfHint branch exactly — a
  // persistent-marker attribution gated by the outer `!blocked` guard, so a cleared DataDome page
  // (200, fat content) is never reached. Placed AFTER cf/px (which also have a visible-phrase arm) so
  // a page tripping overlapping markers attributes to the same vendor `reason` reports first.
  if (sig.ddHint === true) return "datadome-challenge";
  if (isHardBlock(sig, sig.status)) return "hard-block";
  return "blocked";
}

/**
 * The block reason a caller sees, resolving an interactive CAPTCHA against the WAF classification on ONE
 * shared surface so retrieve and drive (and the escalation-diagnostics reason) can't drift (the
 * detection-parity invariant). {@link classifyBlock} is authoritative for a SPECIFIC vendor
 * (cf/px/datadome) or a failed nav; the signal's `captchaKind` attributes `captcha` ONLY when the block
 * is otherwise GENERIC (`hard-block`/`blocked`). Two correctness rules (codex #40 r2/r3): (1) a real WAF
 * vendor wins, so a page that merely preloads a captcha library can't override it; (2) `captchaKind` is
 * set only for an ACTIVE widget (a `data-sitekey` container — see {@link BlockSignal.captchaKind}), not a
 * loaded library, so a generic/unknown block isn't mislabeled as a CAPTCHA it just happens to ship.
 */
export function resolveBlockReason(sig: BlockSignal): BlockReason | null {
  const reason = classifyBlock(sig);
  if (sig.captchaKind && sig.captchaKind !== "unknown" && (reason === "hard-block" || reason === "blocked")) {
    return "captcha";
  }
  return reason;
}

/**
 * Project a {@link BlockReason} (+ the CAPTCHA kind, when the block is an interactive widget) onto a
 * {@link WafVendor}, or `undefined` when no vendor is attributable (a generic/hard block or a failed nav).
 * Deriving vendor FROM the reason — rather than a second parallel classifier — makes the surfaced vendor
 * and reason STRUCTURALLY unable to disagree: {@link classifyBlock} stays the single source of truth for
 * vendor attribution. `undefined` (absence) is the sole empty state, which keeps the #39 nav-failed gate
 * green (a failed nav has no vendor) and avoids a `none`/`unknown` sentinel.
 */
export function wafVendorFromReason(
  reason: BlockReason | null,
  captchaKind?: CaptchaKind,
): WafVendor | undefined {
  switch (reason) {
    case "cf-challenge":
      return "cloudflare";
    case "perimeterx-challenge":
      return "perimeterx";
    case "datadome-challenge":
      return "datadome";
    case "captcha":
      // The specific interactive widget kind (detectCaptcha only ever yields recaptcha/hcaptcha/turnstile);
      // an `unknown`/absent kind leaves the vendor unattributed rather than mislabeling it.
      return captchaKind && captchaKind !== "unknown" ? captchaKind : undefined;
    default:
      // nav-failed / hard-block / blocked / null → no attributable vendor.
      return undefined;
  }
}

/**
 * The signal surface the FAILURE classifier ({@link classifyFailure}) reads: a {@link BlockSignal} (which
 * the block layer classifies) PLUS two RETRIEVE-ONLY content signals it needs to separate the reason===null
 * 200-states. Kept as a supertype rather than widening {@link BlockSignal} (whose contract is
 * block-classification inputs only, so classifyBlock never sees fields it must ignore, issue #41). Both
 * added fields are DIAGNOSTIC sub-classifiers of an already-thin, already-failed, non-blocked page — NEVER
 * a `blocked` input.
 */
export interface FailureSignal extends BlockSignal {
  /** An SPA framework mount root is present in the HTML (`hasFrameworkRoot`). True on a hydrated page too,
   *  so it only means "unhydrated shell" WHEN the page is also thin. Retrieve-only (computed from
   *  render.html); the drive path never reaches the content arm that reads it. */
  frameworkRoot?: boolean;
  /** A GENUINE (non-guard) subresource request failed during the render — {@link genuineNetworkFailure},
   *  which excludes the allowlist guard's own `ERR_BLOCKED_BY_CLIENT` aborts. Retrieve-only. */
  networkFailed?: boolean;
  /** The final (post-redirect / post-client-nav) URL, so {@link classifyFailure} can recognize a dead nav
   *  that reached a `chrome-error://` page while inheriting a STALE non-null status (which defeats the
   *  status===null nav-failed test). retrieve passes render.diagnostics.finalUrl; drive the snapshot url. */
  finalUrl?: string;
}

/** True when a URL is a Chrome error page (`chrome-error://…`) — a dead nav (reset socket / unreachable
 *  host / off-allowlist abort) that produced no real document but can carry a stale status from a prior
 *  page. The classifier attributes it to `nav-failed` regardless of that stale status (codex #41 r1/r2). */
export function isChromeErrorUrl(url: string | undefined): boolean {
  return url !== undefined && url.startsWith("chrome-error://");
}

/**
 * The block {@link BlockReason} for a FAILED signal, accounting for a dead nav that {@link resolveBlockReason}
 * (which reads only title/text/status/hints) can't see: a `chrome-error://` final URL is `nav-failed` even
 * when the render inherited a stale non-null status (codex #41 r4/r5). The SINGLE reason derivation shared by
 * retrieve's surfaced `reason`, the escalation-diagnostics reason, and (via the same chrome-error check)
 * {@link classifyFailure}, so all three name ONE reason and the #40 r3 one-reason invariant holds. A
 * null-status nav is already `nav-failed` inside resolveBlockReason, so only the stale-status chrome-error
 * case needs the override here.
 */
export function resolveFailureReason(sig: FailureSignal): BlockReason | null {
  return isChromeErrorUrl(sig.finalUrl) ? "nav-failed" : resolveBlockReason(sig);
}

/**
 * Error codes on a `requestfailed` evidence line that are BENIGN — not evidence of a broken load, so they
 * must not set `networkFailed` and mislabel an empty page as `hydration-failed` (issue #41):
 *   - `ERR_BLOCKED_BY_CLIENT` — the gateway's OWN allowlist guard aborting an off-allowlist subresource
 *     (`Fetch.failRequest{BlockedByClient}`). Ubiquitous on real pages (analytics/ads/fonts off-allowlist),
 *     and the gateway is the ONLY client-blocker, so this exact code is always guard noise.
 *   - `ERR_ABORTED` — a CANCELLED request, the normal SPA pattern (navigating away or an AbortController
 *     cancelling an in-flight fetch fires `requestfailed` with this code). Predominantly benign and
 *     unrelated to hydration (codex #41 r6), so counting it over-fires `hydration-failed`.
 * What remains as GENUINE (a broken load): ERR_FAILED / ERR_CONNECTION_* / ERR_TIMED_OUT /
 * ERR_NAME_NOT_RESOLVED, etc.
 */
const BENIGN_NETWORK_ERRORS = /ERR_BLOCKED_BY_CLIENT|ERR_ABORTED/i;

/**
 * Whether the render saw a GENUINE network failure — a data/asset request that failed for a reason that
 * actually implies a broken load, not the gateway's own guard aborts or a benign SPA cancellation (issue
 * #41). Filters {@link BENIGN_NETWORK_ERRORS}; without it a raw `networkFailures.length > 0` is near-always
 * TRUE on real pages and would collapse the `hydration-failed` vs `empty-shell` distinction. Tests the
 * TRAILING error field only (each evidence line is `METHOD URL errText`, so a URL that merely CONTAINS
 * `ERR_ABORTED` must not mask a real trailing `net::ERR_FAILED` — codex #41 r7). A DIAGNOSTIC discriminator,
 * best-effort by nature.
 */
export function genuineNetworkFailure(networkFailures: readonly string[] | undefined): boolean {
  return (networkFailures ?? []).some((line) => {
    const errField = line.trim().split(/\s+/).pop() ?? "";
    return !BENIGN_NETWORK_ERRORS.test(errField);
  });
}

/**
 * Classify WHY a call FAILED into a {@link FailureClass} (issue #41) — a classifier LAYERED on top of the
 * block classifier: the block/nav layer ({@link resolveBlockReason}) is authoritative for WHO blocked, and
 * the reason===null arm sub-classifies a 2xx/3xx page that produced no extractable content into the
 * hard-to-distinguish 200-states. Called ONLY on an already-FAILED call (retrieve's empty-markdown/blocked
 * gate, or a thrown drive failure), so it never returns `ok`/`burned-exit`/`timeout` (those are reserved).
 *
 * Precedence (most-actionable first): the block/nav classes come straight off resolveBlockReason. In the
 * reason===null arm, `unsupported-browser` is checked BEFORE the thin gate (a definitive interstitial phrase
 * is meaningful even on a fat wrapper); then a fat-innerText-but-unextractable page is `empty-shell`; then,
 * THIN-only, an explicit empty-state marker is `real-zero-results`, a framework root + a genuine failed data
 * call is `hydration-failed`, and the remaining thin page is `empty-shell` (the formalized `empty-content`).
 * NOTE: neither a persistent DataDome/PX marker NOR a thin active-captcha widget is used to attribute a
 * vendor here (codex #41 r3). The persistent markers survive a cleared challenge (re-opening the #40
 * false-positive), and attributing a captcha/vendor on a page the block classifier reports NOT blocked
 * (reason===null) makes the envelope disagree with the proxy diagnostic's reason. Both a captcha shell and a
 * DataDome captcha-delivery shell are surfaced as `empty-shell`; attributing their vendor consistently needs
 * a rendered-evidence challenge-shell detector that folds into the block DECISION — a deferred follow-up.
 */
export function classifyFailure(sig: FailureSignal): FailureClass {
  // A dead nav that reached a chrome-error:// page can inherit a STALE non-null status from a prior
  // document, defeating resolveBlockReason's status===null nav-failed test — attribute it up front from the
  // final URL (codex #41 r1/r2). retrieve derives finalUrl from render.diagnostics.finalUrl, drive from the
  // snapshot url, so both paths agree here rather than at each seam.
  if (isChromeErrorUrl(sig.finalUrl)) return "nav-failed";
  const reason = resolveBlockReason(sig);
  if (reason === "nav-failed") return "nav-failed";
  if (reason === "captcha") return "captcha";
  if (reason === "cf-challenge" || reason === "perimeterx-challenge" || reason === "datadome-challenge") {
    return "anti-bot-block";
  }
  if (reason === "hard-block") return "hard-block";
  if (reason === "blocked") return "anti-bot-block"; // a generic visible block phrase, no attributable vendor
  // reason === null: a 2xx/3xx page, no visible block phrase, not a hard block, that still yielded no
  // extractable content (retrieve's empty-markdown arm). Sub-classify the 200-state.
  if (hasUnsupportedBrowserPhrase(sig)) return "unsupported-browser"; // definitive; meaningful even when fat
  const thin = sig.text.trim().length < MIN_CONTENT_LENGTH;
  if (!thin) return "empty-shell"; // fat innerText but unextractable — no more specific label fits
  if (hasEmptyStateMarker(sig)) return "real-zero-results"; // a genuine thin "no results" state
  if (sig.frameworkRoot && sig.networkFailed) return "hydration-failed"; // shell present + a genuine failed load
  // A thin ACTIVE-captcha shell is DELIBERATELY left as empty-shell here, NOT promoted to `captcha` (codex
  // #41 r3): attributing captcha/a widget vendor while the block classifier still reports the page NOT
  // blocked (reason===null) makes the envelope disagree with the proxy diagnostic's reason (null) — the #40
  // r3 "one reason" invariant. Doing it CONSISTENTLY needs the block DECISION to promote a thin widget shell,
  // which #40 declined (a fat page with an incidental widget would false-positive). So `wafVendorFromFailure`'s
  // `captcha` case only fires for a block-decision captcha (hard-block/blocked + active widget), where every
  // field agrees; a rendered-evidence challenge-shell detector (also the DataDome captcha-delivery case) is a
  // deferred follow-up. #41 delivers the empty-shell CLASS for these shells; their vendor is not attributed.
  return "empty-shell"; // the formalized empty-content (an unhydrated shell or a genuinely empty page)
}

/**
 * Project a {@link FailureClass} onto a {@link WafVendor} (issue #41) — vendor stays a PROJECTION of the
 * classification, never a parallel classifier (the #40 doctrine), so vendor and class can't disagree. For
 * `captcha` the vendor is the active widget kind; for `anti-bot-block` it is whatever
 * {@link wafVendorFromReason} attributes off the (necessarily non-null) block reason — anti-bot-block is
 * only produced from a real block reason (cf/px/datadome/blocked), so a persistent-marker guess is never
 * needed (deliberately: that would re-open the #40 false-positive). Every other class → no vendor.
 */
export function wafVendorFromFailure(fc: FailureClass, sig: FailureSignal): WafVendor | undefined {
  switch (fc) {
    case "captcha":
      return sig.captchaKind && sig.captchaKind !== "unknown" ? sig.captchaKind : undefined;
    case "anti-bot-block":
      return wafVendorFromReason(resolveBlockReason(sig), sig.captchaKind);
    default:
      return undefined;
  }
}

/**
 * Structured diagnostics for a proxy-escalation outcome — caller-visible (issue #21) so a failure
 * says WHY (was the proxy applied? which exit? what blocked it?) instead of an opaque "last
 * status=403". Secrets-free BY CONSTRUCTION: no credentials, no proxy host — only booleans, a count,
 * a status, a {@link BlockReason}, and (opt-in, U4) an ASN/org verdict.
 */
export interface EscalationDiagnostics {
  /** A residential proxy is configured in the secret store. */
  proxyConfigured: boolean;
  /** A proxied exit was actually opened/used for this navigation (vs direct-only). */
  proxyApplied: boolean;
  /** The proxied path was forced from the first request (force-proxy host/option), not reached via escalation. */
  forced: boolean;
  /** Proxied attempts made (0 when the proxy was never engaged). */
  attempts: number;
  /** HTTP status of the last (failed) navigation, or null when none was captured. */
  lastStatus: number | null;
  /** Vendor/hard-block classification of the last failed page; null when it was not blocked. */
  reason: BlockReason | null;
  /**
   * Per proxied-attempt wall-clock ms (issue #42), aligned 1:1 with {@link attempts} — one entry per
   * escalation attempt (a full session-open + navigate), so a 3× re-roll that consumed the budget is
   * legible ("why 200s"). INCLUDES session acquisition (a fresh proxied context launch per attempt),
   * which is often the dominant term. Present only when the proxy was engaged; the direct attempt is
   * NOT counted here (its cost is in the surfaced render's core stages + the whole-call totalMs).
   * Secrets-free by construction (durations only).
   */
  attemptMs?: number[];
  /** Residential-vs-datacenter exit verification (opt-in egress probe, U4); absent unless requested. */
  exitCheck?: EgressCheck;
}

/** Build {@link EscalationDiagnostics} from the escalation tally and the last failed signal. */
export function escalationDiagnostics(opts: {
  proxyConfigured: boolean;
  proxyApplied: boolean;
  forced: boolean;
  attempts: number;
  last: FailureSignal | null;
  /** Per proxied-attempt wall-clock ms (issue #42), 1:1 with `attempts`; omitted when empty. */
  attemptMs?: number[];
  exitCheck?: EscalationDiagnostics["exitCheck"];
}): EscalationDiagnostics {
  return {
    proxyConfigured: opts.proxyConfigured,
    proxyApplied: opts.proxyApplied,
    forced: opts.forced,
    attempts: opts.attempts,
    lastStatus: opts.last?.status ?? null,
    ...(opts.attemptMs && opts.attemptMs.length ? { attemptMs: opts.attemptMs } : {}),
    // resolveFailureReason (not bare classifyBlock/resolveBlockReason) so the escalation-diagnostics reason
    // matches the failure-envelope class/vendor on a bare-CAPTCHA failure AND on a stale-status chrome-error
    // dead nav — one EscalationError can't carry two reasons (codex #40 r3 / #41 r5). captcha-awareness rides
    // on the signal's captchaKind, and the chrome-error nav-failed override rides on finalUrl.
    reason: opts.last ? resolveFailureReason(opts.last) : null,
    ...(opts.exitCheck ? { exitCheck: opts.exitCheck } : {}),
  };
}

/**
 * A proxy-escalation failure carrying structured {@link EscalationDiagnostics} for the MCP caller.
 * Thrown on the drive path; the diagnostics survive to the MCP `fail()` surface because the throw is
 * outside the controller's `#run` redaction re-wrap, and the message itself carries no secret material.
 */
export class EscalationError extends Error {
  readonly diagnostics: EscalationDiagnostics;
  /**
   * The page-evidence envelope (issue #39) for this failure — a DISTINCT field from {@link diagnostics}
   * (the proxy-escalation tally), deliberately NOT overloading it. Carries finalUrl / title / status /
   * redirect chain / console + network / optional screenshot, already REDACTED by the drive layer that
   * threw. Absent when no snapshot was captured (e.g. a force-proxy request with no proxy available).
   */
  readonly failure?: FailureDiagnostics;
  constructor(message: string, diagnostics: EscalationDiagnostics, failure?: FailureDiagnostics) {
    super(message);
    this.name = "EscalationError";
    this.diagnostics = diagnostics;
    if (failure) this.failure = failure;
  }
}

/** Result of the opt-in egress-verification probe (U4): did the proxy give a residential exit? */
export interface EgressCheck {
  kind: "datacenter" | "residential" | "unknown";
  /** The exit's ASN/org string, when the probe could read it (sanitized — a public org name). */
  org?: string;
}

/**
 * ASN/org name fragments that mark a DATACENTER/hosting exit (not residential). Curated, not
 * exhaustive — an org that matches none but is present is treated as residential; an absent org is
 * unknown. Used only for the opt-in diagnostic verdict, never to gate behavior.
 */
const DATACENTER_ORG_PATTERNS: readonly RegExp[] = [
  /hetzner/i,
  /amazon|aws/i,
  /google|gcp/i,
  /microsoft|azure/i,
  /digitalocean/i,
  /linode/i,
  /vultr|choopa/i,
  /\bovh\b/i,
  /contabo/i,
  /oracle/i,
  /leaseweb/i,
  /scaleway/i,
  /m247/i,
  /cloudflare/i,
  /akamai/i,
  /fastly/i,
  /\bdata\s*cent(?:er|re)\b/i,
  /hosting/i,
  /\bcolo\b/i,
  /\bvps\b/i,
];

/**
 * Classify an exit by its ASN/org string: a known datacenter/hosting org → "datacenter"; a present
 * org with no datacenter match → "residential"; absent/empty → "unknown". Pure.
 */
export function classifyExitOrg(org: string | undefined): EgressCheck["kind"] {
  if (!org || !org.trim()) return "unknown";
  return DATACENTER_ORG_PATTERNS.some((re) => re.test(org)) ? "datacenter" : "residential";
}

/**
 * Extract the `org` field from an ip-info JSON body (e.g. ipinfo.io/json) — regex, not JSON.parse, so
 * it survives the body being wrapped in a browser JSON-viewer's HTML. Returns undefined when absent.
 */
export function parseExitOrg(body: string): string | undefined {
  return body.match(/"org"\s*:\s*"([^"]*)"/)?.[1] || undefined;
}

/** Assemble a ProxyConfig from BYO secrets, or undefined when no proxy is configured. */
export function proxyFromSecrets(secrets: SecretStore): ProxyConfig | undefined {
  const server = secrets.get("BGW_PROXY_URL");
  if (!server) return undefined;
  const username = secrets.get("BGW_PROXY_USERNAME");
  const password = secrets.get("BGW_PROXY_PASSWORD");
  return { server, ...(username ? { username } : {}), ...(password ? { password } : {}) };
}

/**
 * Derive a STICKY-session proxy from a base config: append `suffixTemplate` (with `{id}` replaced by
 * a fresh random token) to the password. Residential providers encode stickiness in the password, so
 * this stays provider-neutral — the literal suffix syntax is deployment config, never in source
 * (public repo). One sticky id = one held exit IP: a fresh id per ATTEMPT preserves the
 * rotate-across-retries property the reputation-403 path needs, while each attempt keeps the single
 * stable IP a CF challenge requires to complete (cf_clearance is IP-bound; per-request rotation
 * moves the IP mid-challenge, which is why rotating exits can never clear an interstitial).
 * No template or no password → the base config unchanged (prior rotating behavior).
 */
export function mintStickyProxy(
  proxy: ProxyConfig,
  suffixTemplate: string | undefined,
  // 4 bytes → 8 hex chars: IPRoyal requires the `_session-` value be PRECISELY 8 alphanumeric
  // (verified against IPRoyal's rotation docs); a 16-char id is out of spec and may be truncated/ignored.
  id: string = randomBytes(4).toString("hex"),
): ProxyConfig {
  if (!suffixTemplate || !proxy.password) return proxy;
  return { ...proxy, password: proxy.password + suffixTemplate.replaceAll("{id}", id) };
}

/**
 * Mint a fresh, STABLE sticky-exit id — 8 hex chars, the IPRoyal `_session-` quantum (see
 * {@link mintStickyProxy}). The vault stores this with an entry at capture and re-pins it on warm
 * replay (via `proxyOverrideFor(..., stickyExitId)`), so a logged-in session returns to the SAME
 * residential exit IP (R3): an IP-bound login cookie replayed from a different exit is a tell.
 */
export function newStickyExitId(): string {
  return randomBytes(4).toString("hex");
}

/**
 * Boot-time validation for `BGW_PROXY_STICKY_SUFFIX`: a non-empty template MUST contain the `{id}`
 * placeholder, or {@link mintStickyProxy}'s `replaceAll` is a no-op and every escalation attempt
 * pins the SAME sticky exit — silently collapsing the rotate-across-retries property with no runtime
 * error. Returns an error string so entrypoints fail closed at startup (matching the gateway's other
 * boot guards), or null when the suffix is absent or valid.
 */
export function stickySuffixBootError(suffix: string | undefined): string | null {
  if (!suffix) return null;
  if (!suffix.includes("{id}")) {
    return "BGW_PROXY_STICKY_SUFFIX must contain the '{id}' placeholder, else every escalation attempt pins one exit and rotation is silently lost";
  }
  return null;
}

/**
 * The literal, non-`{id}` fragments of a sticky-suffix template, for folding into the SecretStore's
 * redaction set at boot (R9 defense-in-depth). {@link mintStickyProxy} appends
 * `suffix.replaceAll("{id}", <8hex>)` to the BASE proxy password: the base is already redactable
 * (loaded from `BGW_PROXY_PASSWORD`), but the appended suffix — the residential provider's param
 * structure (geo/session/lifetime) — is not, so a driver error that echoed the full minted password
 * would leak it past `redactSecrets` (`[REDACTED]_country-us_session-<id>_lifetime-30m`). Registering
 * the fragments around `{id}` scrubs that structure; only the ephemeral per-attempt 8-hex id remains
 * (opaque, non-credential). BOUNDED on purpose: fixed config split ONCE at boot, never per-request —
 * folding every minted password would grow the redaction set for the process lifetime AND is not
 * R3-safe, since {@link import("./drive.js").proxyOverrideForPinned} byte-compares the minted password
 * to re-pin a held exit. Fragments < 3 chars are harmless: `redactSecrets` skips them, so a short
 * fragment can never blanket-redact ordinary output.
 */
export function stickySuffixRedactables(suffix: string | undefined): string[] {
  if (!suffix) return [];
  return suffix.split("{id}").filter((fragment) => fragment.length > 0);
}

/**
 * PerimeterX press-&-hold copy present in the rendered page — the top-document HTML OR a child
 * frame's HTML. The challenge renders in a cross-origin `px-captcha-modal` iframe, which
 * `page.content()` (top frame only) never serializes; the core captures the child frames as
 * `render.frameHtml` (only when a PX marker is present), so the copy is recoverable either way.
 */
function hasPxChallengeCopy(render: Pick<RenderResult, "html" | "frameHtml">): boolean {
  return hasPerimeterXChallengeCopy(render.html) || hasPerimeterXChallengeCopy(render.frameHtml ?? "");
}

export async function retrieve(
  gateway: Gateway,
  secrets: SecretStore,
  opts: RetrieveOptions,
): Promise<RetrieveResult> {
  const { token, url } = opts;
  // #42 per-stage timing: t0 bounds the WHOLE retrieve call (every render attempt + extraction). The
  // surfaced core stages come from the final render; attemptMs breaks down the proxied retry loop.
  const t0 = performance.now();
  // Scheme allowlist (R14-adjacent): only http(s). Rejects file:/data:/blob:/ftp:/view-source:
  // before any navigation, so a non-http target can't read local files or bypass the
  // host-based guard (whose host is empty for those schemes).
  if (!isHttpUrl(url)) {
    // Structural sanitize at the source (issue #39 r5): the KNOWN requested url is never interpolated
    // raw — sanitizeUrl (new URL) collapses a non-http scheme to `scheme:<redacted>`, spelling-proof.
    throw new Error(`unsupported URL scheme: only http(s) is allowed (${sanitizeUrlForError(url)})`);
  }
  // clearedTextLength: a page returns as soon as real content (>= MIN_CONTENT_LENGTH) renders
  // instead of polling to the full clearance timeout (the kill-gate keeps the strong-content
  // bar). MIN, not 0, so a CF page mid-reload — challenge phrase gone but content not yet
  // painted — isn't mistaken for cleared.
  const renderOpts: RenderOptions = { clearedTextLength: MIN_CONTENT_LENGTH };
  if (opts.clearanceTimeoutMs !== undefined) renderOpts.clearanceTimeoutMs = opts.clearanceTimeoutMs;
  const proxy = proxyFromSecrets(secrets);
  const escalation: EscalationContext = {
    onDatacenterIp: opts.escalation?.onDatacenterIp ?? false,
    proxyAvailable: opts.escalation?.proxyAvailable ?? Boolean(proxy),
  };

  let captchaSolved = false;
  let proxyUsed = false;
  let proxyAttempts = 0;
  // #42: per proxied-attempt wall-clock (one entry per escalation attempt, incl. its session-open),
  // surfaced on the proxyDiagnostic aligned 1:1 with `proxyAttempts`. The direct attempt is not counted.
  const attemptMs: number[] = [];

  // force-proxy (issue #21): skip the direct attempt and go residential from the FIRST render for a
  // known-hostile host. Only honored when a proxy is available (configured + datacenter IP); else it
  // degrades to direct — retrieve is best-effort (the interactive drive path fails loud instead).
  const forced = (opts.forceProxy ?? false) && Boolean(proxy) && escalation.onDatacenterIp;
  const proxiedRenderOpts: RenderOptions = {
    ...renderOpts,
    clearanceTimeoutMs: opts.clearanceTimeoutMs ?? PROXY_CLEARANCE_TIMEOUT_MS,
  };

  // 1) Direct render through an authenticated, allowlist-guarded session — skipped when forcing proxy.
  let render: RenderResult | undefined;
  if (!forced) {
    render = await gateway.withConsumerSession(token, (s) => s.core.render(url, renderOpts));
  }

  // 2) CAPTCHA hook (retrieve path) — detect a widget for the block-reason diagnostic. Full
  //    solve→inject→resume now lives in the browser core's DRIVE path (`#trySolveCaptcha`), which
  //    owns the live page; the stateless render path here has no page to inject into, so a solved
  //    token can't be applied. NO production caller wires `opts.solver` into retrieve — and it should
  //    stay that way: wiring one here would spend (and bill) a solve with no effect on the page.
  //    `captchaSolved` therefore stays false in production. (Removing `opts.solver` + `captchaSolved`
  //    outright is a follow-up — it changes retrieve's result contract + the mcp surface.)
  if (render && opts.solver) {
    const captcha = detectCaptcha(render, url);
    if (captcha) {
      await opts.solver.solve(captcha);
      captchaSolved = true;
    }
  }

  // 3) Scoped proxy escalation — a CF managed challenge OR a hard IP/WAF-reputation block
  //    (4xx/5xx + thin body), from a datacenter IP. The proxy's clean residential IP is what
  //    clears a reputation block; the local datacenter IP cannot (F1, 2026-06-01). Each attempt
  //    mints a fresh STICKY session (when configured) => a fresh exit per retry that is then HELD
  //    for the whole attempt — a CF challenge needs one stable IP to complete, while the retry
  //    still rotates past dead/slow/dirty exits (see PROXY_MAX_ATTEMPTS note above). The clearance
  //    budget is raised on proxied attempts: an interstitial clears in ~22s on a held exit, over
  //    the 20s default (probe, 2026-06-09).
  if (proxy && (forced || (render !== undefined && shouldEscalateToProxy(render, render.status, escalation)))) {
    proxyUsed = true;
    for (let attempt = 1; attempt <= PROXY_MAX_ATTEMPTS; attempt++) {
      proxyAttempts = attempt;
      // #42: wall-clock this whole attempt (fresh proxied session-open + render) so a re-roll is legible.
      const attempt0 = performance.now();
      render = await gateway.withConsumerSession(
        token,
        (s) => s.core.render(url, proxiedRenderOpts),
        { proxy: mintStickyProxy(proxy, opts.stickySuffix), navigationTimeoutMs: PROXY_NAV_TIMEOUT_MS },
      );
      attemptMs.push(performance.now() - attempt0);
      // A fresh exit landed a real page -> done. Retry on a failed nav (null status), a dead exit that
      // reached a `chrome-error://` page while carrying a STALE 200 (else the loop would treat that dead
      // exit as healthy and break without trying later exits — defeating PROXY_MAX_ATTEMPTS, codex #41 r5),
      // a still-blocked result (proxy error page), or a PerimeterX press-&-hold (a 200 challenge whose
      // phrase reaches the HTML/iframe but not innerText — thin OR copy-in-source; #21/#24 follow-up);
      // a thin-but-OK 200 is not retried.
      const pxHintR = hasPerimeterXHint(render.html);
      if (
        render.status !== null &&
        !isChromeErrorUrl(render.diagnostics?.finalUrl) &&
        !isVisiblyBlocked(render) &&
        !isPerimeterXChallenge(render, pxHintR) &&
        !(pxHintR && hasPxChallengeCopy(render)) &&
        !isHardBlock(render, render.status)
      ) {
        break;
      }
    }
  }

  // render is assigned by here: non-forced did a direct render; forced implies a proxy so it ran >=1
  // proxied attempt. This guard satisfies the type-checker and the impossible forced-without-proxy case.
  if (render === undefined) {
    render = await gateway.withConsumerSession(token, (s) => s.core.render(url, renderOpts));
  }
  const extraction = extractMarkdown(render.html, url);
  const cfHint = hasCloudflareHint(render.html);
  const pxHint = hasPerimeterXHint(render.html);
  // ddHint: a DataDome marker in the render HTML (issue #40). Attribution only — like cfHint/pxHint it
  // persists after a clear, so it re-labels an already-blocked page's `reason` to `datadome-challenge`
  // but is NOT a `blocked` input (a cleared DataDome page still returns content).
  const ddHint = hasDataDomeHint(render.html);
  // pxCopy: the press-&-hold challenge copy is in the page SOURCE but not the top-doc innerText
  // `render.text` — the widget is in a cross-origin px-captcha-modal iframe. We look at BOTH the
  // top-document HTML and the child-frame HTML the core captured (`render.frameHtml`), because
  // page.content() serializes only the top frame. This is the boundary-length 200 case #24's
  // thin-content test missed. Absent on a cleared page.
  const pxCopy = hasPxChallengeCopy(render);
  // The ACTIVE interactive-CAPTCHA widget kind (if any), for the block `reason` and the surfaced vendor
  // (issue #40). Keyed on the widget CONTAINER class (activeCaptchaKind), not a loaded library or a global
  // sitekey — so a preloaded API script can't relabel a WAF block, and a co-present unrelated library
  // can't cross-label the kind (codex r3/r4). Carried on the classification signal.
  const captchaKind = activeCaptchaKind(render.html);
  // A DEAD nav: no response captured (status null) OR the render ended on a `chrome-error://` page — a reset
  // socket / unreachable host that produced no real document, which can inherit a STALE non-null status from
  // a prior in-page navigation (codex #41 r4). A chrome-error final URL is UNAMBIGUOUS (a real page never has
  // one), unlike an HTML phrase, so folding it into the failure decision is SAFE — otherwise the browser's
  // error DOM extracts to non-empty markdown and is handed back to the caller as page content.
  const deadNav = render.status === null || isChromeErrorUrl(render.diagnostics?.finalUrl);
  // Blocked = a dead nav, a visible anti-bot phrase, a PerimeterX press-&-hold (pxHint + EITHER thin content
  // OR the challenge copy in source — a 200 challenge whose phrase renders in a cross-origin iframe, never
  // reaching render.text; #21/#24 follow-up), or a hard block (4xx/5xx + thin body) on the FINAL render — so
  // a reputation 403, an exhausted proxy retry where every exit was dead, or a client-side crash to a Chrome
  // error page is reported as blocked instead of returning the error/empty/challenge body as content (F1
  // finding #2). A thin *200* with no PX marker is still NOT blocked, so a legitimately short page isn't flagged.
  const blocked =
    deadNav ||
    isVisiblyBlocked(render) ||
    isPerimeterXChallenge(render, pxHint) ||
    (pxHint && pxCopy) ||
    isHardBlock(render, render.status);
  // SPA framework mount root present + a GENUINE (non-guard) failed subresource load — the two
  // retrieve-only content signals that separate the reason===null 200-states (issue #41: empty-shell vs
  // hydration-failed). frameworkRoot is NEVER a `blocked` input (true on a hydrated page too); networkFailed
  // excludes the allowlist guard's own ERR_BLOCKED_BY_CLIENT aborts so it isn't near-always-true.
  const frameworkRoot = hasFrameworkRoot(render.html);
  const networkFailed = genuineNetworkFailure(render.diagnostics?.networkFailures);
  // The single classification signal shared by the block reason, the failure class, and the escalation
  // diagnostics, so they can't drift (the detection-parity invariant, extended for #41 with the two
  // content signals; resolveBlockReason/classifyBlock read only the BlockSignal subset and ignore them).
  const signal: FailureSignal = {
    title: render.title,
    text: render.text,
    status: render.status,
    cfHint,
    pxHint,
    ddHint,
    pxCopy,
    captchaKind,
    frameworkRoot,
    networkFailed,
    // The post-redirect / post-client-nav landed URL — lets classifyFailure catch a dead nav that reached a
    // chrome-error page while the (fresh-page) status stayed at the initial 200 (codex #41 r2).
    ...(render.diagnostics?.finalUrl !== undefined ? { finalUrl: render.diagnostics.finalUrl } : {}),
  };
  // Diagnostic reason for the block: nav-failed (off-allowlist/unreachable) first, then the shared
  // resolveBlockReason — a SPECIFIC WAF vendor (cf/px/datadome) wins, and an interactive CAPTCHA
  // attributes only when the block is otherwise generic (so a WAF page that merely preloads a captcha
  // library isn't mislabeled; codex #40 r2). Surfaced so a caller sees WHY a page failed rather than a
  // silent "blocked". `null` when the page is not blocked.
  const reason: BlockReason | null = blocked ? resolveFailureReason(signal) : null;
  // Surface escalation diagnostics whenever the proxy was engaged (success or failure): on a block
  // the reason says WHY; on success it shows the proxy was applied and at which attempt it landed.
  const proxyDiagnostic = proxyUsed
    ? escalationDiagnostics({
        proxyConfigured: Boolean(proxy),
        proxyApplied: true,
        forced,
        attempts: proxyAttempts,
        last: signal,
        attemptMs, // #42: per-attempt durations, 1:1 with attempts
      })
    : undefined;
  // Failure-evidence envelope (issue #39): surface it on ANY retrieve failure (blocked, empty-content,
  // or a failed nav — the SHARED {@link isRetrieveFailure} predicate the MCP layer also fails on, so an
  // errored result always carries evidence), and REDACT it (URL params stripped + secret set scrubbed +
  // cookie/authorization stripped) before it leaves this seam. The core built the RAW envelope on
  // `render.diagnostics` (finalUrl = the post-redirect page.url(), the retrieve URL-bug fix). A successful
  // retrieve carries no envelope, so its shape is unchanged.
  const failed = isRetrieveFailure({ blocked, markdown: extraction.markdown, status: render.status });
  // Failure CLASS (issue #41) + mitigation/CAPTCHA vendor (issue #40), both a PROJECTION of the same
  // classification (never a parallel classifier), so class and vendor can't disagree. classifyFailure
  // layers on resolveBlockReason: the block/nav classes come off it, and its reason===null arm
  // sub-classifies the 200-states (empty-shell / hydration-failed / real-zero-results / unsupported-browser)
  // — formalizing the old MCP-layer `empty-content` fallback into the typed enum. Computed only on a
  // FAILURE, so the success shape is unchanged; attached at THIS redaction seam (like wafVendor), not via
  // buildFailureDiagnostics. Both are closed vocabularies → pass redactFailureDiagnostics untouched.
  const failureClass: FailureClass | undefined = failed ? classifyFailure(signal) : undefined;
  const wafVendor = failureClass ? wafVendorFromFailure(failureClass, signal) : undefined;
  // #42: assemble ONE Timing — the whole-call totalMs over the final render's core stages — and use it for
  // BOTH the result field and (on a failure) the folded envelope, so they can never disagree (single
  // derivation). render.timing carries the surfaced render's domContentLoaded/clearancePoll/snapshot; its
  // own core totalMs is overwritten by the whole-call wall-clock here.
  const timing: Timing = assembleTiming({ ...(render.timing ?? {}), totalMs: performance.now() - t0 });
  const diagnostics =
    failed && render.diagnostics
      ? redactFailureDiagnostics(
          { ...render.diagnostics, ...(failureClass ? { failureClass } : {}), ...(wafVendor ? { wafVendor } : {}), timing },
          secrets,
        )
      : undefined;
  return {
    url,
    status: render.status,
    title: extraction.title || render.title,
    markdown: extraction.markdown,
    degraded: extraction.degraded,
    blocked,
    reason,
    proxyUsed,
    captchaSolved,
    timing,
    ...(proxyDiagnostic ? { proxyDiagnostic } : {}),
    ...(diagnostics ? { diagnostics } : {}),
  };
}
