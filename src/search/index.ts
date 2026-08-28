/**
 * Search (VIL-122) — a provider-agnostic `search` verb. Discovery is its own operation with its own
 * retry/timeout/failure semantics; it is not a SERP URL handed to `retrieve`.
 */
export { SearchProviderError, SEARCH_FAILURE_CLASSES } from "./types.js";
export type {
  SearchSafe,
  SearchRequest,
  SearchResult,
  SearchFailureClass,
  SearchAttempt,
  SearchResponse,
  SearchProvider,
  SearchFn,
} from "./types.js";
export {
  BraveSearchProvider,
  BRAVE_DEFAULT_API_URL,
  BRAVE_MAX_QUERY_CHARS,
  BRAVE_MAX_QUERY_WORDS,
  BRAVE_MAX_COUNT,
  braveStatusToFailureClass,
  parseRetryAfterMs,
} from "./brave.js";
export type { BraveSearchProviderConfig } from "./brave.js";
export {
  buildSearch,
  makeSearchFn,
  loadSearchSettings,
  searchEndpointError,
  SearchAttemptsError,
  redactedSearchFn,
  KNOWN_SEARCH_PROVIDERS,
  DEFAULT_SEARCH_PROVIDER_TIMEOUT_MS,
  DEFAULT_SEARCH_TOTAL_TIMEOUT_MS,
} from "./config.js";
export type { SearchSettings, BuildSearchOptions, BuiltSearch } from "./config.js";
