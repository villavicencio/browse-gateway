/**
 * Search domain vocabulary (VIL-122). Search is a FIRST-CLASS verb, not a URL handed to `retrieve`:
 * a client that manufactures a SERP URL gets destination-page retry/timeout/proxy/extraction
 * semantics applied to a discovery problem, and inherits the provider's markup as its contract.
 *
 * Everything here is provider-agnostic on purpose. A provider adapter maps its own wire shape INTO
 * these types and its own errors into {@link SearchFailureClass}; nothing provider-specific may
 * cross this boundary (a test asserts the normalized key set exactly).
 *
 * Failure taxonomy: DELIBERATELY separate from the destination-retrieval `FailureClass`
 * (`observability/failure-diagnostics.ts`). A search-host failure must never be attributed to a
 * destination result URL — "the search API rate-limited us" and "the page you asked for
 * rate-limited us" are different facts with different next moves, and collapsing them into one
 * enum is how a caller ends up retrying the wrong thing.
 */

/** SafeSearch posture, spelled as the sanctioned providers spell it. */
export type SearchSafe = "off" | "moderate" | "strict";

/** A normalized search request. Provider-neutral: no engine, no key, no endpoint. */
export interface SearchRequest {
  /** The user's query. Provider limits are enforced by the adapter, not assumed here. */
  query: string;
  /** How many results to return. Clamped by the adapter to what the provider supports. */
  count: number;
  /** 2-letter country code for result targeting (e.g. `US`). */
  country?: string;
  /** 2-letter content-language code (e.g. `en`). */
  language?: string;
  safeSearch: SearchSafe;
}

/** One normalized result. `publishedAt` is `null` whenever the provider does not give a date we can
 *  trust — never a manufactured value (see `brave.ts` on the unconfirmed date field). */
export interface SearchResult {
  /**
   * 1-based position in THIS list, preserving the provider's relative order.
   *
   * Dense on purpose, and this is the half of the contract that was wrong before: entries the
   * adapter cannot hand to `retrieve` (a non-http scheme, an unparseable URL) are dropped, so a
   * rank that mirrored the provider's raw index would carry holes. A caller iterating results wants
   * 1..N; the dropped entries were not results it could have used.
   */
  rank: number;
  title: string;
  /** Absolute destination URL — the thing a caller hands to `retrieve`. */
  url: string;
  /** Host + path, for display. Derived here, never taken from the provider. */
  displayUrl: string;
  snippet: string;
  /** ISO-8601 timestamp, or `null` when the provider reports no trustworthy date. */
  publishedAt: string | null;
}

/**
 * The closed search-failure vocabulary. Exported as an array so a test can assert every member has
 * a caller-facing hint (a class with no advice is a class the caller cannot act on).
 *
 * `captcha`, `challenge-interstitial` and `total-deadline-exhausted` are declared here but are not
 * produced by the single-provider path in this change: the first two belong to the browser-SERP
 * fallback and the third to the multi-provider router (both are the sibling ticket's scope). They
 * live in the vocabulary now so the enum is stable across that change rather than widening the
 * public contract twice.
 */
export const SEARCH_FAILURE_CLASSES = [
  "rate-limited",
  "quota-exhausted",
  "authentication-failed",
  "provider-unavailable",
  "timeout",
  "network-error",
  "malformed-response",
  "empty-results",
  "unsupported-query",
  "policy-restricted",
  "captcha",
  "challenge-interstitial",
  "total-deadline-exhausted",
] as const;

export type SearchFailureClass = (typeof SEARCH_FAILURE_CLASSES)[number];

/**
 * One provider attempt, in order. The single-provider path reports exactly one; the router will
 * report the ordered fallback chain.
 *
 * `outcome` is the PROVIDER's verdict, which is not the same as the verb's: `empty` means the
 * provider answered correctly and had nothing, which is a successful search that found nothing. It
 * is spelled as its own state rather than as `failed` + `empty-results` so a caller never has to
 * read a working provider as a broken one, and rather than as plain `ok` so "found nothing" stays
 * machine-readable (and stays a signal the router can act on).
 */
export interface SearchAttempt {
  provider: string;
  outcome: "ok" | "empty" | "failed";
  /** Present only when `outcome === "failed"`. */
  failureClass?: SearchFailureClass;
  /** The provider's HTTP status when there was one; `null` for a transport/abort failure. */
  httpStatus?: number | null;
  durationMs: number;
  /** Honoured `Retry-After`, in ms, when the provider sent a parseable one. */
  retryAfterMs?: number;
}

/** The normalized response. This exact key set is the public contract — a test pins it. */
export interface SearchResponse {
  query: string;
  /** Which provider actually fulfilled the request. */
  provider: string;
  results: SearchResult[];
  attempts: SearchAttempt[];
  /** ISO-8601 instant the results were retrieved — a freshness anchor for the caller. */
  retrievedAt: string;
  durationMs: number;
}

/**
 * A typed provider failure. Carries only the failure SHAPE — never the request, the URL, or the
 * headers, because the API key rides a header (R9, and the captcha-solver precedent).
 */
export class SearchProviderError extends Error {
  readonly code: SearchFailureClass;
  readonly httpStatus: number | null;
  readonly retryAfterMs?: number;

  constructor(code: SearchFailureClass, message: string, opts: { httpStatus?: number | null; retryAfterMs?: number } = {}) {
    super(message);
    this.name = "SearchProviderError";
    this.code = code;
    this.httpStatus = opts.httpStatus ?? null;
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
  }
}

/**
 * The stable internal provider seam. One method: a bounded search that either returns normalized
 * results or throws a {@link SearchProviderError}. `health()`/`classify()` from the ticket's sketch
 * are deliberately NOT here — nothing in this change consumes them, and an unused method on a seam
 * is a contract you have to keep without a caller to keep it honest. The router ticket adds what it
 * actually uses.
 */
export interface SearchProvider {
  readonly name: string;
  /**
   * @param ctx.deadline absolute epoch-ms deadline; the adapter must not outlive it.
   * @param ctx.signal aborts the in-flight request (composed with the adapter's own deadline).
   */
  search(req: SearchRequest, ctx: { deadline: number; signal: AbortSignal }): Promise<SearchResult[]>;
}

/** The verb the MCP layer calls. Injected, so the tool is testable without a provider or network. */
export type SearchFn = (req: SearchRequest) => Promise<SearchResponse>;
