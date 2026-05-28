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
 * Visible challenge/block phrases — matched against page TITLE + visible TEXT only.
 * These appear on an actual interstitial/block page and disappear once it clears.
 */
export const BLOCK_PHRASES: readonly RegExp[] = [
  // Cloudflare interstitial / block
  /just a moment/i,
  /enable javascript and cookies/i,
  /verifying you are human/i,
  /checking your browser/i,
  /attention required/i,
  // Generic / DataDome / WAF block + captcha
  /access denied/i,
  /you have been blocked/i,
  /unusual (?:traffic|activity)/i,
  /please verify you are a human/i,
  /confirm you are (?:a )?human/i,
];

/**
 * Vendor protection scripts/cookies/hosts that persist in page HTML even AFTER a challenge
 * clears. DIAGNOSTIC ONLY — never used to decide "blocked" (that's what caused false
 * positives). Surfaced for logging/observability and future vendor attribution.
 */
export const VENDOR_SCRIPT_HINTS: readonly RegExp[] = [
  /cf-chl/i,
  /challenge-platform/i,
  /cf_chl_opt/i,
  /geo\.captcha-delivery\.com/i,
  /captcha-delivery/i,
  /datadome/i,
  /dd_?cookie/i,
];

/** The page fields detection inspects. */
export interface PageSignal {
  title: string;
  text: string;
  html: string;
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
export function matchedBlockPhrases(signal: PageSignal): string[] {
  const haystack = `${signal.title}\n${signal.text}`;
  return BLOCK_PHRASES.filter((re) => re.test(haystack)).map(String);
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
 * A page has "cleared" when no block phrase is visible and real content is present.
 * Used to poll an interstitial until its client-side challenge auto-solves.
 */
export function isCleared(signal: PageSignal): boolean {
  return (
    matchedBlockPhrases(signal).length === 0 &&
    signal.text.length > STRONG_CONTENT_LENGTH
  );
}
