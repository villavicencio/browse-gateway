/**
 * Brave Search API adapter (VIL-122) — the first sanctioned provider behind {@link SearchProvider}.
 *
 * Shape follows the outbound-API precedent in `verbs/captcha-solver.ts`: an injected `fetch`, an
 * injected clock, a hard AbortController deadline that stays live THROUGH the body read (a service
 * that returns headers then stalls the body must not outlive the deadline), typed failures only,
 * and an API key that never appears in a message. The key rides the `X-Subscription-Token` header,
 * so no error path here may echo the request, its URL, or its headers.
 *
 * Endpoint, auth header, parameter names, and limits are transcribed from the vendor's own
 * documentation (Brave Web Search "Get started" + API reference, fetched 2026-08-28) — not from
 * memory. The one thing the docs would NOT reveal is recorded at {@link publishedAt} below.
 */
import { SearchProviderError } from "./types.js";
import type { SearchProvider, SearchRequest, SearchResult } from "./types.js";

/** Documented default base for the Web Search endpoint. Overridable via `BGW_BRAVE_SEARCH_API_URL`. */
export const BRAVE_DEFAULT_API_URL = "https://api.search.brave.com/res/v1/web/search";

/** Documented request limits: "Maximum of 400 characters and 50 words in the query." */
export const BRAVE_MAX_QUERY_CHARS = 400;
export const BRAVE_MAX_QUERY_WORDS = 50;
/** Documented result ceiling: "The maximum is 20." */
export const BRAVE_MAX_COUNT = 20;

/** Default cap on the response body we will read before giving up (1 MiB). A SERP page of 20 results
 *  is orders of magnitude smaller; anything past this is not a response we should be parsing. */
const DEFAULT_MAX_BODY_BYTES = 1_000_000;

export interface BraveSearchProviderConfig {
  apiKey: string;
  /** Full endpoint URL. Validated as https + non-private at BOOT (see `config.ts`), not here. */
  apiUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  maxBodyBytes?: number;
}

/** Parse a `Retry-After` header. Only the delta-seconds form is honoured — the HTTP-date form is
 *  legal but needs a trusted clock to interpret and we have no reason to trust the skew. Returns
 *  `undefined` when absent, non-numeric, or negative. */
export function parseRetryAfterMs(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return seconds * 1000;
}

/**
 * Map a provider HTTP status to a failure class.
 *
 * `400`/`422` are REQUEST rejections, so they map to `unsupported-query` and not
 * `malformed-response`: the latter means "the provider sent bytes we could not parse", which is a
 * provider fault, and telling a caller the provider is broken when their own query was rejected
 * sends them to retry instead of to rephrase. `404` on a fixed, documented endpoint means the
 * configured base URL is wrong — a deployment fault the caller cannot fix, reported as
 * `provider-unavailable` rather than pretending the query was at fault.
 */
export function braveStatusToFailureClass(status: number): SearchProviderError["code"] {
  // A redirect is never followed (see the fetch call), so a 3xx arrives here as a response. The
  // configured endpoint is not the API it claims to be — a deployment fault, like a 404.
  if (status >= 300 && status < 400) return "provider-unavailable";
  if (status === 401 || status === 403) return "authentication-failed";
  if (status === 402) return "quota-exhausted";
  if (status === 429) return "rate-limited";
  if (status === 400 || status === 422) return "unsupported-query";
  if (status >= 500) return "provider-unavailable";
  if (status === 404) return "provider-unavailable";
  return "malformed-response";
}

/** Host + path, for display. Derived from the destination URL — never taken from the provider, so a
 *  provider cannot make a result's displayed origin disagree with where the link actually goes. */
function toDisplayUrl(u: URL): string {
  return u.pathname === "/" ? u.host : `${u.host}${u.pathname}`;
}

export class BraveSearchProvider implements SearchProvider {
  readonly name = "brave";
  readonly #apiKey: string;
  readonly #apiUrl: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #maxBodyBytes: number;

  constructor(cfg: BraveSearchProviderConfig) {
    this.#apiKey = cfg.apiKey;
    this.#apiUrl = cfg.apiUrl ?? BRAVE_DEFAULT_API_URL;
    this.#fetch = cfg.fetchImpl ?? fetch;
    this.#now = cfg.now ?? Date.now;
    this.#maxBodyBytes = cfg.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  }

  async search(req: SearchRequest, ctx: { deadline: number; signal: AbortSignal }): Promise<SearchResult[]> {
    // Refuse locally what the provider documents it will reject — spending a request (and a quota
    // unit) to be told the query is too long is pure waste, and the local refusal carries the same
    // class the remote one would.
    const query = req.query.trim();
    if (query.length === 0) {
      throw new SearchProviderError("unsupported-query", "query is empty");
    }
    if (query.length > BRAVE_MAX_QUERY_CHARS) {
      throw new SearchProviderError("unsupported-query", `query exceeds the provider limit of ${BRAVE_MAX_QUERY_CHARS} characters`);
    }
    const words = query.split(/\s+/).filter(Boolean).length;
    if (words > BRAVE_MAX_QUERY_WORDS) {
      throw new SearchProviderError("unsupported-query", `query exceeds the provider limit of ${BRAVE_MAX_QUERY_WORDS} words`);
    }

    const url = new URL(this.#apiUrl);
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(Math.min(Math.max(1, req.count), BRAVE_MAX_COUNT)));
    url.searchParams.set("safesearch", req.safeSearch);
    if (req.country) url.searchParams.set("country", req.country);
    if (req.language) url.searchParams.set("search_lang", req.language);
    // Documented default is `true`, which injects highlighting markers into the snippet text. The
    // normalized `snippet` is meant to be plain prose a caller can read or feed onward, so turn it off.
    url.searchParams.set("text_decorations", "false");

    const body = await this.#get(url, ctx);
    return this.#normalize(body);
  }

  /**
   * GET the endpoint, hard-bounded by `ctx.deadline`, reading at most `maxBodyBytes` of body. The
   * abort stays armed until the body read completes (captcha-solver `#post` learned this the hard
   * way: clearing it at fetch()-resolve leaves a stalled body unbounded). Never surfaces the URL or
   * headers — the key is in a header.
   */
  async #get(url: URL, ctx: { deadline: number; signal: AbortSignal }): Promise<unknown> {
    const remaining = ctx.deadline - this.#now();
    if (remaining <= 0) throw new SearchProviderError("timeout", "search deadline exhausted before the request started");

    const controller = new AbortController();
    const abortForDeadline = () => controller.abort();
    const timer = setTimeout(abortForDeadline, remaining);
    // Compose with the caller's signal so an outer cancellation (a total-deadline abort from the
    // router, a closed connection) tears this request down too, not just our own timer.
    if (ctx.signal.aborted) {
      clearTimeout(timer);
      throw new SearchProviderError("timeout", "search deadline exhausted before the request started");
    }
    ctx.signal.addEventListener("abort", abortForDeadline, { once: true });

    try {
      let resp: Response;
      try {
        resp = await this.#fetch(url, {
          method: "GET",
          headers: {
            accept: "application/json",
            "accept-encoding": "gzip",
            "x-subscription-token": this.#apiKey,
          },
          signal: controller.signal,
          // NEVER follow a redirect. Measured on Node 24: `fetch` strips `Authorization` when a
          // redirect crosses origins but forwards a CUSTOM header verbatim — so the default
          // `redirect: "follow"` would hand `x-subscription-token` to whatever host the endpoint
          // points at, and would reach it WITHOUT the https-only and private-address checks that
          // `searchEndpointError` applied to the configured URL at boot. One 302 would defeat both
          // guarantees at once. The endpoint is deployment config naming a documented API; if it
          // redirects, that is a misconfiguration or an attack, and both deserve a refusal.
          redirect: "manual",
        });
      } catch (err) {
        if (controller.signal.aborted) throw new SearchProviderError("timeout", "search exceeded its deadline");
        // Report only the failure SHAPE — never the request (it carries the key in a header).
        throw new SearchProviderError("network-error", `search request failed (${err instanceof Error ? err.name : "network error"})`);
      }

      if (!resp.ok) {
        const code = braveStatusToFailureClass(resp.status);
        const retryAfterMs = code === "rate-limited" ? parseRetryAfterMs(resp.headers.get("retry-after")) : undefined;
        // Parse nothing — an error body may carry an echoed query or vendor detail we have no use
        // for — but CANCEL it. Throwing with the body unread leaves the underlying request alive
        // with the deadline timer already cleared, so a run of 429/5xx responses would pin
        // connections and quietly defeat the bound this method advertises.
        void resp.body?.cancel().catch(() => {});
        throw new SearchProviderError(code, `search provider returned HTTP ${resp.status}`, {
          httpStatus: resp.status,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        });
      }

      const text = await this.#readCapped(resp, controller);
      try {
        return JSON.parse(text) as unknown;
      } catch {
        if (controller.signal.aborted) throw new SearchProviderError("timeout", "search exceeded its deadline");
        throw new SearchProviderError("malformed-response", "search provider returned a body that is not valid JSON", {
          httpStatus: resp.status,
        });
      }
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", abortForDeadline);
      // Catch-all teardown: by here the body has either been fully read, been cancelled, or is
      // being abandoned on a throw. Aborting is a no-op in the first two cases and the thing that
      // releases the request in the third, so no exit path — including one added later — can leave
      // an in-flight request behind after the deadline timer is gone.
      controller.abort();
    }
  }

  /**
   * Read the body as text, refusing past `maxBodyBytes`. Streamed rather than `resp.text()` so an
   * oversized body is abandoned at the cap instead of being buffered in full first — the cap is a
   * memory bound, and a cap you enforce only after materializing the string is not a bound at all.
   */
  async #readCapped(resp: Response, controller: AbortController): Promise<string> {
    const stream = resp.body;
    if (!stream) return "";
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > this.#maxBodyBytes) {
          throw new SearchProviderError("malformed-response", `search provider response exceeded ${this.#maxBodyBytes} bytes`, {
            httpStatus: resp.status,
          });
        }
        chunks.push(value);
      }
    } catch (err) {
      if (err instanceof SearchProviderError) throw err;
      if (controller.signal.aborted) throw new SearchProviderError("timeout", "search exceeded its deadline");
      throw new SearchProviderError("network-error", `reading the search response failed (${err instanceof Error ? err.name : "stream error"})`);
    } finally {
      // Release the body either way; a cancel on an already-completed stream is a no-op.
      await reader.cancel().catch(() => {});
    }
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(joined);
  }

  /**
   * Project the documented `web.results[]` shape into {@link SearchResult}.
   *
   * publishedAt: ALWAYS `null` for this provider. The per-result schema on the API reference sits
   * behind a collapsed accordion that neither the browser tier nor a plain fetch would expand, so
   * the only per-result fields confirmed from the vendor's own JSON examples are `title`, `url`,
   * `description` and `extra_snippets`. No date/age field name was confirmed, and inventing one
   * would produce a field that is silently always absent — worse than an honest `null`. Resolve by
   * inspecting a live response once a key exists.
   */
  #normalize(body: unknown): SearchResult[] {
    if (typeof body !== "object" || body === null) {
      throw new SearchProviderError("malformed-response", "search provider returned a non-object body");
    }
    const web = (body as { web?: unknown }).web;
    if (web === undefined) {
      // No `web` key at all: either a filtered response shape we did not ask for, or an error body
      // served with a 200. Either way we cannot answer the caller's question.
      throw new SearchProviderError("malformed-response", "search provider response carried no web results section");
    }
    if (typeof web !== "object" || web === null) {
      throw new SearchProviderError("malformed-response", "search provider returned a malformed web results section");
    }
    const raw = (web as { results?: unknown }).results;
    if (!Array.isArray(raw)) {
      throw new SearchProviderError("malformed-response", "search provider returned a malformed web results list");
    }

    const results: SearchResult[] = [];
    for (const entry of raw) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as { title?: unknown; url?: unknown; description?: unknown };
      if (typeof e.url !== "string" || typeof e.title !== "string") continue;
      let parsed: URL;
      try {
        parsed = new URL(e.url);
      } catch {
        continue; // a result we cannot hand to `retrieve` is not a result
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      results.push({
        rank: results.length + 1,
        title: e.title,
        url: parsed.toString(),
        displayUrl: toDisplayUrl(parsed),
        snippet: typeof e.description === "string" ? e.description : "",
        publishedAt: null,
      });
    }

    if (results.length === 0) {
      throw new SearchProviderError("empty-results", "search returned no usable results");
    }
    return results;
  }
}
