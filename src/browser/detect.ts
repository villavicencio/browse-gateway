/**
 * Pure anti-bot challenge detection — no browser, no I/O, fully unit-testable.
 *
 * Detection rule (learned the hard way during U1 — see below): a page is BLOCKED when a
 * challenge/block *phrase* appears in the visible **title or body text**, or when there's
 * too little content to be real. We deliberately do NOT match against raw HTML, because
 * vendor protection scripts (Cloudflare's `challenge-platform`, DataDome's
 * `captcha-delivery`) stay embedded in the page source even AFTER a challenge clears.
 * Matching those against HTML false-positived on fully-rendered real pages (udemy,
 * glassdoor, indeed all rendered their real homepage yet tripped `/challenge-platform/i`).
 */

/**
 * Cloudflare-specific visible interstitial phrases. The single source of truth for CF
 * signatures — the proxy-escalation gate (verbs/escalation) derives from these so it can't
 * drift from detection.
 */
export const CF_BLOCK_PHRASES: readonly RegExp[] = [
  /just a moment/i,
  /verifying you are human/i,
  /checking your browser/i,
  /attention required/i,
];

/**
 * PerimeterX (HUMAN Security) visible challenge phrases — the "Press & Hold" behavioral
 * interstitial that Total Wine and similar retail WAFs serve. Single source of truth for PX
 * visible signatures, mirroring {@link CF_BLOCK_PHRASES}. Classification/diagnostics only: the
 * press-and-hold challenge is behavioral and NOT cleared by the token-CAPTCHA solver (issue #21).
 * Deliberately NOT folded into {@link BLOCK_PHRASES}: legit "press and hold" copy on a real page must
 * not false-positive it as blocked. These phrases drive vendor ATTRIBUTION ({@link isPerimeterXVisible})
 * once a page is already known blocked. NOTE the press-&-hold widget often renders in a cross-origin
 * iframe — so the visible phrase never reaches the top-doc innerText, AND the challenge can be served
 * with a 200 (not the 403+thin hard block this once assumed). That case is caught by
 * {@link isPerimeterXChallenge} (pxHint + thin content), not the visible phrase (issue #21 follow-up,
 * gateway probe 2026-06-22).
 */
export const PX_BLOCK_PHRASES: readonly RegExp[] = [/press\s*(?:and|&)\s*hold/i, /human security/i];

/**
 * Visible challenge/block phrases — matched against page TITLE + visible TEXT only.
 * These appear on an actual interstitial/block page and disappear once it clears.
 */
export const BLOCK_PHRASES: readonly RegExp[] = [
  ...CF_BLOCK_PHRASES,
  // Cloudflare (additional) / generic / DataDome / WAF block + captcha
  /enable javascript and cookies/i,
  /access denied/i,
  /you have been blocked/i,
  /unusual (?:traffic|activity)/i,
  /please verify you are a human/i,
  /confirm you are (?:a )?human/i,
];

/** Cloudflare challenge scripts/cookies in HTML. Source of truth shared with escalation. */
export const CF_VENDOR_HINTS: readonly RegExp[] = [/cf-chl/i, /challenge-platform/i, /cf_chl_opt/i];

/** PerimeterX (HUMAN) scripts/cookies in HTML — distinctive PX markers (cookie family + CDN hosts). */
export const PX_VENDOR_HINTS: readonly RegExp[] = [
  /perimeterx/i,
  /px-captcha/i,
  /captcha\.px-cdn/i,
  /px-cloud\.net/i,
  /_pxhd/i,
  /\b_px3\b/i,
];

/** DataDome scripts/cookies/hosts in HTML — the captcha-delivery CDN + the `datadome`/`dd_cookie`
 *  cookie family. The DataDome sibling of {@link CF_VENDOR_HINTS}/{@link PX_VENDOR_HINTS}, so vendor
 *  attribution reads DataDome off one source of truth. Like the others these PERSIST after a challenge
 *  clears (see the header) — DIAGNOSTIC/attribution only, never a `blocked` input. */
export const DD_VENDOR_HINTS: readonly RegExp[] = [
  /geo\.captcha-delivery\.com/i,
  /captcha-delivery/i,
  /datadome/i,
  // The DataDome cookie identifier as a WHOLE token — bounded so ordinary JS (`addCookie(`, which
  // contains the substring `ddCookie`) can't set ddHint and mislabel a generic block as DataDome (codex
  // #40 r6). The underscore is required (the real cookie form), not optional.
  /\bdd_cookie\b/i,
];

/**
 * Vendor protection scripts/cookies/hosts that persist in page HTML even AFTER a challenge
 * clears. DIAGNOSTIC ONLY — never used to decide "blocked" (that's what caused false
 * positives). Surfaced for logging/observability and vendor attribution (issue #40).
 */
export const VENDOR_SCRIPT_HINTS: readonly RegExp[] = [
  ...CF_VENDOR_HINTS,
  ...PX_VENDOR_HINTS,
  ...DD_VENDOR_HINTS,
];

/**
 * Empty-state markers (issue #41) — visible copy a page renders when a query/list genuinely has NO
 * results ("no results", "0 results", "nothing found"). Matched against the visible TITLE + TEXT only
 * (the detect.ts rule — never raw HTML), like {@link BLOCK_PHRASES}. Used ONLY to sub-classify an
 * ALREADY-FAILED, thin, non-blocked page (the {@link import("../verbs/retrieve.js").classifyFailure}
 * reason===null arm) into `real-zero-results` vs an unhydrated `empty-shell` — NEVER a `blocked` input, so
 * an incidental "no results" phrase can't flip a page to blocked. Phrases are bounded (no unbounded `.*`)
 * and gated thin-only at the call site, so filter/autocomplete "no results" hints on a FAT working page
 * never reach them. A genuine zero-results page that renders its copy as body TEXT extracts to non-empty
 * markdown and is returned as content (the correct outcome); this fires on the empty-markdown slice where
 * the "no results" signal is in the title / non-extractable text.
 */
export const EMPTY_STATE_PHRASES: readonly RegExp[] = [
  /\bno results?\b/i,
  /\b0 results?\b/i,
  /\bno (?:matches|matching)\b/i,
  /\bno (?:items?|products?|listings?|records?)\s+(?:found|match|to show)\b/i,
  /\bnothing (?:found|to (?:show|display))\b/i,
  /\bwe (?:could ?n[o']t|did ?n[o']t) find any\b/i,
  /\byour search .{0,40}?returned no\b/i,
  /\bthere are no .{0,30}?(?:to (?:display|show)|available|found)\b/i,
];

/**
 * Unsupported-browser interstitial phrases (issue #41) — a page that refuses to render because it does
 * not support the browser ("your browser is not supported", "please update your browser"). Visible
 * TITLE + TEXT only. Distinct from an anti-bot "enable JavaScript" block (a {@link BLOCK_PHRASES} entry,
 * classified upstream as a block) — this is a site COMPATIBILITY interstitial, not a WAF challenge.
 * Tight, interstitial-specific phrasings so an in-page "for the best experience, update your browser"
 * footer note on a real (fat) page is unlikely to match; the call site also gates on an already-failed
 * (empty-markdown) call. Diagnostic label only.
 */
export const UNSUPPORTED_BROWSER_PHRASES: readonly RegExp[] = [
  /\b(?:un|not )supported browser\b/i,
  /\bbrowser (?:is )?(?:not supported|unsupported|out of date|no longer supported)\b/i,
  /\byour browser is (?:out of date|no longer supported|not supported|too old)\b/i,
  /\bthis browser is (?:not supported|no longer supported)\b/i,
  /\b(?:please )?(?:update|upgrade) your browser\b/i,
  /\b(?:use|switch to) a (?:modern|different|supported|newer) browser\b/i,
];

/**
 * SPA framework mount-root markers (issue #41) — the empty `<div id="root">` / `id="app"` / `id="__next"`
 * an SPA hydrates INTO. The ONE raw-HTML detector in this module, deliberately exempt from the "never
 * match HTML" rule because it is NEVER a `blocked`/challenge input (it is TRUE on a fully-hydrated page
 * too, since the root is always present): it only sub-classifies an ALREADY-thin, already-failed,
 * non-blocked page — combined with thin content it means "shell present, no content rendered", and with a
 * genuine failed data call it means `hydration-failed` vs a quiet `empty-shell`. Matched as a whole
 * id/attribute TOKEN so `id="root"` matches but `id="rootLayout"` does not.
 */
export const FRAMEWORK_ROOT_HINTS: readonly RegExp[] = [
  // A REAL `id=`/`ng-version=`/`data-reactroot` attribute. The `(?<=\s)` guard requires a whitespace
  // attribute delimiter — in serialized HTML (page.content()) every attribute name is whitespace-separated —
  // so it rejects both a hyphen/word prefix (`data-id="root"`, `aria-id="app"`, `data-ng-version`, codex #41
  // r7) AND the same token quoted INSIDE another attribute's value (`<p title="id='root'">`, codex #41 r8).
  // The id value is a whole quoted token, so `id="rootLayout"` does not match `root`. This is robust-BEST-
  // EFFORT at the regex altitude (the #40 doctrine): a token preceded by a space INSIDE an attribute value
  // (`title=" id='root' "`) is an accepted residual — true element-attribute verification is a DOM-parse
  // concern the whole HTML-string detection layer forgoes, and this only sub-classifies a thin FAILED page
  // (empty-shell vs hydration-failed), a diagnostic label that never gates behavior.
  /(?<=\s)id\s*=\s*["'](?:root|app|__next|__nuxt|___gatsby|svelte|q-app)["']/i,
  /(?<=\s)id\s*=\s*["']gatsby-focus-wrapper["']/i,
  /(?<=\s)data-reactroot(?![-\w])/i,
  /(?<=\s)ng-version\s*=/i,
];

/**
 * Contexts whose contents are NOT live rendered DOM — a comment, a `<script>`/`<style>`/`<noscript>` body,
 * or an inert `<template>` fragment — where dormant markup (a commented-out `<div id="root">`, a widget
 * example in a docs `<template>`) can appear without being a real placed element. {@link stripInertHtml}
 * blanks these before an HTML-marker match, so a raw-HTML detector isn't fooled by dormant text. The single
 * source of truth for this: the CAPTCHA layer's {@link import("./captcha.js").activeCaptchaKind} reuses it
 * (issue #40 r6), and the #41 framework-root detector uses it too. This is the regex module's bounded
 * approximation of "a live element"; true active-element verification is a DOM-parse concern the whole
 * HTML-string detection layer deliberately forgoes.
 */
export const INERT_HTML_CONTEXTS: readonly RegExp[] = [
  /<!--[\s\S]*?-->/g,
  /<script\b[^>]*>[\s\S]*?<\/script>/gi,
  /<style\b[^>]*>[\s\S]*?<\/style>/gi,
  /<template\b[^>]*>[\s\S]*?<\/template>/gi,
  /<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi,
];

/** Blank out {@link INERT_HTML_CONTEXTS} (comments, script/style/template/noscript bodies) so a raw-HTML
 *  marker match sees only live markup — the shared inert-context strip for the HTML-string detectors. */
export function stripInertHtml(html: string): string {
  return INERT_HTML_CONTEXTS.reduce((s, re) => s.replace(re, " "), html);
}

/** The page fields detection inspects. */
export interface PageSignal {
  title: string;
  text: string;
  html: string;
  /** Concatenated HTML of child frames (e.g. the PerimeterX `px-captcha-modal`). The top-document
   * `html` comes from `page.content()`, which serializes ONLY the top frame — a challenge rendered
   * inside a child frame's document is otherwise invisible to detection. The core populates this only
   * when a PX marker is present in the top doc; absent (`undefined`) on an ordinary render. */
  frameHtml?: string;
}

/** Minimum body-text length to treat a page as "real content" (vs a near-empty block). */
export const MIN_CONTENT_LENGTH = 200;
/** Body-text length above which we are confident real content rendered. */
export const STRONG_CONTENT_LENGTH = 800;

export type Verdict = "GO" | "NO-GO" | "INCONCLUSIVE";

export interface Assessment {
  verdict: Verdict;
  /** True when a block phrase is visible or there's too little content to be real. */
  blocked: boolean;
  /** Block phrases that matched the title/text, for logging. */
  markers: string[];
  /** Vendor scripts seen in HTML (diagnostic; does not affect `blocked`). */
  vendorHints: string[];
  textLength: number;
}

/** Block phrases present in the visible title or body text. */
export function matchedBlockPhrases(signal: Pick<PageSignal, "title" | "text">): string[] {
  const haystack = `${signal.title}\n${signal.text}`;
  return BLOCK_PHRASES.filter((re) => re.test(haystack)).map(String);
}

/**
 * True when a visible anti-bot block/challenge phrase is present. This is the signal the
 * `retrieve` verb reports as `blocked` — distinct from merely thin content, which the
 * kill-gate verdict still treats as NO-GO but is NOT a block (a legitimately short page
 * must not be reported as blocked).
 */
export function isVisiblyBlocked(signal: Pick<PageSignal, "title" | "text">): boolean {
  return matchedBlockPhrases(signal).length > 0;
}

/**
 * True when a *Cloudflare-specific* visible challenge phrase is present (title + visible text) — the
 * CF subset of {@link isVisiblyBlocked}. This is the visible-marker half of retrieve's proxy-
 * escalation gate (`isCloudflareBlock`), so the residential proxy is engaged for CF challenges (and
 * hard blocks) but NOT for generic WAF "access denied" pages — keeping drive's escalation scope
 * identical to retrieve's.
 */
export function isCloudflareVisible(signal: Pick<PageSignal, "title" | "text">): boolean {
  const haystack = `${signal.title}\n${signal.text}`;
  return CF_BLOCK_PHRASES.some((re) => re.test(haystack));
}

/**
 * True when the page HTML carries a Cloudflare challenge script/cookie hint (`challenge-platform`,
 * `cf-chl`, `cf_chl_opt`) — the HTML half of {@link isCloudflareBlock}'s CF detection. Surfaced as a
 * scrubbed boolean so a drive {@link PageSnapshot} can carry the CF signal without the raw HTML, and
 * its escalation can match retrieve on a CF interstitial that shows no visible CF phrase.
 */
export function hasCloudflareHint(html: string): boolean {
  return CF_VENDOR_HINTS.some((re) => re.test(html));
}

/**
 * True when a *PerimeterX-specific* visible challenge phrase ("Press & Hold", HUMAN Security) is
 * present (title + visible text) — the PX sibling of {@link isCloudflareVisible}. Classification
 * only: PX press-and-hold is behavioral and not cleared by the token-CAPTCHA solver.
 */
export function isPerimeterXVisible(signal: Pick<PageSignal, "title" | "text">): boolean {
  const haystack = `${signal.title}\n${signal.text}`;
  return PX_BLOCK_PHRASES.some((re) => re.test(haystack));
}

/**
 * True when the page HTML carries a PerimeterX script/cookie marker — the HTML sibling of
 * {@link hasCloudflareHint}, surfaced as a scrubbed boolean (`pxHint`) so a drive
 * {@link PageSnapshot} can carry the PX signal without raw HTML.
 */
export function hasPerimeterXHint(html: string): boolean {
  return PX_VENDOR_HINTS.some((re) => re.test(html));
}

/**
 * True when the page HTML carries a DataDome script/cookie marker (`captcha-delivery`, `datadome`,
 * `dd_cookie`) — the DataDome sibling of {@link hasCloudflareHint}/{@link hasPerimeterXHint}, surfaced
 * as a scrubbed boolean (`ddHint`) so a drive {@link PageSnapshot} can carry the DataDome signal without
 * raw HTML. Attribution only (issue #40): like the CF/PX hints these markers PERSIST after a challenge
 * clears, so this is never a `blocked` input — it only labels an already-blocked page's vendor.
 */
export function hasDataDomeHint(html: string): boolean {
  return DD_VENDOR_HINTS.some((re) => re.test(html));
}

/**
 * True when a genuine empty-state marker ({@link EMPTY_STATE_PHRASES}) is present in the visible title or
 * text (issue #41) — the discriminator between a `real-zero-results` page and an unhydrated `empty-shell`.
 * Text-only (never HTML); the caller gates it thin-only so a filter/autocomplete "no results" hint on a
 * fat working page can't reach it, and it is NEVER a `blocked` input.
 */
export function hasEmptyStateMarker(signal: Pick<PageSignal, "title" | "text">): boolean {
  const haystack = `${signal.title}\n${signal.text}`;
  return EMPTY_STATE_PHRASES.some((re) => re.test(haystack));
}

/**
 * True when an unsupported-browser interstitial phrase ({@link UNSUPPORTED_BROWSER_PHRASES}) is present in
 * the visible title or text (issue #41). Text-only. Distinct from an anti-bot block (classified upstream);
 * a diagnostic label for a site COMPATIBILITY interstitial, never a `blocked` input.
 */
export function hasUnsupportedBrowserPhrase(signal: Pick<PageSignal, "title" | "text">): boolean {
  const haystack = `${signal.title}\n${signal.text}`;
  return UNSUPPORTED_BROWSER_PHRASES.some((re) => re.test(haystack));
}

/**
 * True when the HTML carries an SPA framework mount-root marker ({@link FRAMEWORK_ROOT_HINTS}) — issue #41.
 * The ONE raw-HTML detector here; safe because it is NEVER a `blocked` input (true on a hydrated page too),
 * only a sub-classifier of an already-thin, already-failed, non-blocked page: thin + framework-root means
 * "shell present, no content", and + a genuine failed data call means `hydration-failed`.
 */
export function hasFrameworkRoot(html: string): boolean {
  // Strip inert contexts first (codex #41 r2): an `id="root"` inside a comment / `<script>` string /
  // `<template>` is dormant markup, not a live SPA mount — matching it would misclassify the page as
  // hydration-failed. Same discipline as activeCaptchaKind (issue #40 r6).
  return FRAMEWORK_ROOT_HINTS.some((re) => re.test(stripInertHtml(html)));
}

/**
 * The THIN-content arm of PerimeterX detection: a challenge that leaves the top document empty. PX
 * renders its "Press & Hold" widget in a `px-captcha-modal` (cross-origin) iframe, so when the top
 * frame is just the modal shell, its innerText (`text`) stays thin and the visible-phrase detectors
 * ({@link isPerimeterXVisible}/{@link isVisiblyBlocked}) see nothing — and the challenge is commonly a
 * 200, so {@link isHardBlock} (needs 4xx/5xx + thin) misses it too. `pxHint` ({@link hasPerimeterXHint})
 * confirms PX is present, but PERSISTS on a cleared page, so `pxHint` alone false-positives every
 * success; the discriminator is content. A PX challenge whose top frame instead stays FAT (page chrome
 * around the modal) is caught by {@link hasPerimeterXChallengeCopy} on the captured frame HTML, not
 * here. (Total Wine, gateway probe 2026-06-22 — issue #21/#24 follow-up.)
 */
export function isPerimeterXChallenge(signal: Pick<PageSignal, "text">, pxHint: boolean): boolean {
  return pxHint && signal.text.trim().length < MIN_CONTENT_LENGTH;
}

/**
 * True when a page-source string carries a PerimeterX *challenge copy* phrase ({@link PX_BLOCK_PHRASES}:
 * "Press & Hold" / "HUMAN Security") — the block-page body text, the source sibling of
 * {@link isPerimeterXVisible}. Callers pass the top-document HTML AND the child-frame HTML the core
 * captured (`frameHtml`): the press-&-hold widget renders in a `px-captcha-modal` iframe, whose
 * document `page.content()` (top frame only) never serializes, so a fat-top-frame challenge would be
 * invisible without the frame HTML — that is the boundary-length 200 that slipped {@link isVisiblyBlocked}
 * and {@link isPerimeterXChallenge}'s thin-content test (gateway probe 2026-06-22). UNLIKE
 * {@link hasPerimeterXHint} (vendor markers that PERSIST after a clear), this copy is ABSENT on a
 * cleared page — verified: a cleared Total Wine product page keeps the px-captcha modal id but no
 * press-&-hold copy — so it is safe to read as a block signal. Pair with `pxHint` so an incidental
 * "press and hold" on a non-PX page can't false-positive.
 */
export function hasPerimeterXChallengeCopy(html: string): boolean {
  // Decode the one entity that defeats a literal match: a "&" in text serializes as "&amp;" in
  // outerHTML, so "Press & Hold" becomes "Press &amp; Hold" — and /press\s*&\s*hold/ won't span the
  // "amp;". Cheap targeted decode so the match works on raw render HTML (not just decoded markdown).
  const decoded = html.replace(/&amp;/gi, "&");
  return PX_BLOCK_PHRASES.some((re) => re.test(decoded));
}

/**
 * A "hard block" — a server error status with no real content rendered. This is the
 * IP/WAF-reputation block (F1, 2026-06-01): hammering one CF target from the prod datacenter
 * IP returns a bare `403 Forbidden` (body ~9 chars) that the stealth core CANNOT clear, because
 * it is the IP's reputation that is blocked, not a client-side challenge. Only a clean
 * (residential) IP recovers it — so this is the second escalation trigger alongside a CF
 * managed challenge.
 *
 * Keyed on a 4xx/5xx status AND a thin body, NOT status alone: detection runs on the final DOM,
 * and a real page can return an error status yet render full content (g2.com returns 403 on the
 * bare homepage, udemy/glassdoor similar) — those have real content and are NOT hard-blocked.
 * It is also distinct from a thin *200* (a legitimately short page), which must never be
 * reported as blocked.
 */
export function isHardBlock(signal: Pick<PageSignal, "text">, status: number | null): boolean {
  return status !== null && status >= 400 && signal.text.trim().length < MIN_CONTENT_LENGTH;
}

/**
 * VIL-121: document statuses a FRESH EXIT CANNOT CHANGE. Rotating to a clean residential IP is the
 * remedy for an IP/WAF *reputation* verdict — the site would serve the page to a different client.
 * These three are not that:
 *   - `404` / `410` — the resource is missing or gone. It is missing from every exit; re-rolling asks
 *     the same question from a new IP and pays a full residential session for the same answer.
 *   - `429` — the target is rate-limiting this client and telling us to slow down. A fresh exit is
 *     either the same answer (limit keyed on account/key/fingerprint) or evasion of a limit the site
 *     asked us to respect. Neither is a retry we should spend an exit on.
 * DELIBERATELY NOT here: `401`/`403`/`5xx` with a thin body. Those stay exit-clearable reputation
 * blocks — a clean IP genuinely recovers them (F1, 2026-06-01), which is the whole reason the
 * escalation ladder exists.
 */
export const UNCLEARABLE_STATUSES: ReadonlySet<number> = new Set([404, 410, 429]);

/** True when `status` is one {@link UNCLEARABLE_STATUSES} names. `null` (a failed nav) is NOT one —
 *  a dead nav says nothing about the resource, and the retry path for it is unchanged. */
export function isUnclearableStatus(status: number | null): boolean {
  return status !== null && UNCLEARABLE_STATUSES.has(status);
}

/**
 * {@link isHardBlock} AND the status is one a clean exit could actually clear — the ESCALATION
 * predicate (VIL-121). The page is still a failure either way: `navFailed` / the `blocked` decision
 * keep reading bare `isHardBlock`, so a thin 404 is reported blocked exactly as before. This narrower
 * predicate governs only "is a residential exit worth spending here", so the two cannot drift into
 * "not blocked" territory by accident.
 */
export function isExitClearableHardBlock(
  signal: Pick<PageSignal, "text">,
  status: number | null,
): boolean {
  return isHardBlock(signal, status) && !isUnclearableStatus(status);
}

/**
 * VIL-121 RE-ROLL RULE, shared by every proxied retry loop (retrieve's escalation loop and the drive
 * controller's open-and-navigate loop) so they cannot drift: **this attempt's render ends the re-roll**.
 *
 * True when the status is one no fresh exit can change — EXCEPT when a LIVE challenge is on the page,
 * which a clean residential exit genuinely does clear (screenshot-proven), so it keeps its full attempt
 * budget even when served on one of those statuses. That exception is why the escalation gate can admit
 * a managed challenge on a 429 without the loop immediately truncating it to one attempt.
 *
 * **Liveness is the whole point, and it must NOT be read off the block reason.** The vendor markers
 * (`cfHint`/`pxHint`/`ddHint`) PERSIST after a challenge clears, so `classifyBlock` labels an ordinary
 * thin 404 from ANY Cloudflare-fronted origin `cf-challenge` — reason-gating here would therefore make
 * every such 404 re-roll every exit, which is precisely the burn this ticket exists to stop. The visible
 * CF phrase is absent on a cleared or ordinary page, so it separates a live challenge from a residual
 * marker. This mirrors the `pxCopy`-vs-`pxHint` precedent already relied on for warm-failure advice.
 */
export function isTerminalUnclearableRender(
  signal: Pick<PageSignal, "title" | "text">,
  status: number | null,
): boolean {
  return isUnclearableStatus(status) && !isCloudflareVisible(signal);
}

/** Vendor protection scripts present in the HTML (diagnostic only). */
export function vendorHints(signal: PageSignal): string[] {
  return VENDOR_SCRIPT_HINTS.filter((re) => re.test(signal.html)).map(String);
}

/**
 * Classify a page snapshot. The verdict is taken on the *final rendered DOM*, not the
 * initial HTTP status: challenges commonly return 403 then solve client-side, and some
 * real pages (e.g. g2.com) return 403 on the bare homepage yet render full content.
 */
export function assess(signal: PageSignal): Assessment {
  const markers = matchedBlockPhrases(signal);
  const textLength = signal.text.length;
  const blocked = markers.length > 0 || textLength < MIN_CONTENT_LENGTH;
  const verdict: Verdict = blocked
    ? "NO-GO"
    : textLength > STRONG_CONTENT_LENGTH
      ? "GO"
      : "INCONCLUSIVE";
  return { verdict, blocked, markers, vendorHints: vendorHints(signal), textLength };
}

/**
 * A page has "cleared" when no block phrase is visible and enough real content is present.
 * Used to poll an interstitial until its client-side challenge auto-solves.
 *
 * `minTextLength` defaults to STRONG_CONTENT_LENGTH — the kill-gate's confidence bar, so the
 * gate's clearance behavior is unchanged. The `retrieve` path passes a low value (`0`) so a
 * legitimately short page clears as soon as content renders instead of polling to the full
 * clearance timeout.
 */
export function isCleared(
  signal: Pick<PageSignal, "title" | "text">,
  minTextLength: number = STRONG_CONTENT_LENGTH,
): boolean {
  return matchedBlockPhrases(signal).length === 0 && signal.text.trim().length > minTextLength;
}
