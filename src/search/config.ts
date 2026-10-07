/**
 * Search enablement, provider construction, and the fail-closed boot guards (VIL-122).
 *
 * The whole feature is OFF unless `BGW_SEARCH_ENABLED=1`. Disabled is byte-identical to not having
 * shipped it: `buildSearch` returns `undefined`, the runtime carries no `search`, and the MCP layer
 * never registers the tool. That invariant is what makes merging this without any provider key safe.
 *
 * Every guard here THROWS, and it is called from `buildGatewayRuntime` — i.e. at boot, where a
 * deploy can see it. Per the project rule, anything that must fail a deploy has to be observable at
 * boot; a misconfigured provider must not become a per-session 500 that no deploy check reaches.
 */
import { positiveIntOr } from "../gateway/index.js";
import { isBlockedEgressHost, redactSecrets } from "../security/index.js";
import type { SecretStore } from "../security/index.js";
import { BraveSearchProvider, BRAVE_DEFAULT_API_URL } from "./brave.js";
import { createSearchRouter, DEFAULT_SEARCH_BREAKER_COOLDOWN_MS, DEFAULT_SEARCH_BREAKER_THRESHOLD, SearchAttemptsError } from "./router.js";
import type { RouterClock, RouterMetrics } from "./router.js";
import { SearchProviderError } from "./types.js";
import type { SearchFn, SearchProvider, SearchResponse } from "./types.js";

/** Provider names this build knows how to construct. An unlisted name is a boot failure, never a
 *  silent fallback to the default — a typo in `BGW_SEARCH_PROVIDERS` must not quietly ship a
 *  different provider than the operator configured. */
export const KNOWN_SEARCH_PROVIDERS = ["brave"] as const;

export const DEFAULT_SEARCH_PROVIDER_TIMEOUT_MS = 8_000;
export const DEFAULT_SEARCH_TOTAL_TIMEOUT_MS = 20_000;

export interface SearchSettings {
  enabled: boolean;
  providers: string[];
  providerTimeoutMs: number;
  totalTimeoutMs: number;
  breakerThreshold: number;
  breakerCooldownMs: number;
  /** Move on to the next provider when one answers "nothing matched" (default on). */
  emptyResultsFallback: boolean;
  braveApiUrl: string;
}

/** Read the search knobs from env. Pure — no validation, no secrets, no construction. */
export function loadSearchSettings(env: NodeJS.ProcessEnv): SearchSettings {
  const providers = (env.BGW_SEARCH_PROVIDERS ?? "brave")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return {
    enabled: env.BGW_SEARCH_ENABLED === "1",
    providers,
    providerTimeoutMs: positiveIntOr(env.BGW_SEARCH_PROVIDER_TIMEOUT_MS, DEFAULT_SEARCH_PROVIDER_TIMEOUT_MS),
    totalTimeoutMs: positiveIntOr(env.BGW_SEARCH_TOTAL_TIMEOUT_MS, DEFAULT_SEARCH_TOTAL_TIMEOUT_MS),
    breakerThreshold: positiveIntOr(env.BGW_SEARCH_BREAKER_THRESHOLD, DEFAULT_SEARCH_BREAKER_THRESHOLD),
    breakerCooldownMs: positiveIntOr(env.BGW_SEARCH_BREAKER_COOLDOWN_MS, DEFAULT_SEARCH_BREAKER_COOLDOWN_MS),
    emptyResultsFallback: env.BGW_SEARCH_EMPTY_RESULTS_FALLBACK !== "0",
    braveApiUrl: env.BGW_BRAVE_SEARCH_API_URL || BRAVE_DEFAULT_API_URL,
  };
}

/**
 * Validate a configured provider endpoint. Returns an error message, or null.
 *
 * This is the documented answer to "does the provider API path go through the policy layer?" — it
 * does, at BOOT rather than per call. The navigation allowlist governs consumer-directed navigation
 * (a consumer names a URL); a provider endpoint is deployment configuration that no consumer can
 * influence, so there is nothing to authorize per request. What must not happen is a deployment
 * pointing the adapter at a private/metadata address and turning a search call into an SSRF
 * primitive — so the same `isBlockedEgressHost` filter the policy engine uses is applied to the
 * configured URL once, at boot, and a bad one refuses the boot instead of failing a session.
 */
export function searchEndpointError(rawUrl: string, envVar: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return `${envVar} is not a valid URL`;
  }
  if (parsed.protocol !== "https:") {
    return `${envVar} must be https (a provider API key would ride an unencrypted request otherwise)`;
  }
  // Measured: `fetch` throws "Request cannot be constructed from a URL that includes credentials"
  // for embedded userinfo. Without this the gateway boots reporting search=<provider> and then
  // fails EVERY call — and fails it as `network-error`, because the TypeError surfaces where a
  // transport fault would, so the logs point away from the actual cause. A permanently broken
  // feature that the deploy gate calls healthy is the exact shape the boot-guard rule exists to
  // prevent. (Credentials belong in the key env var, never in the endpoint.)
  if (parsed.username !== "" || parsed.password !== "") {
    return `${envVar} must not embed credentials in the URL — the HTTP client refuses such a URL, so every search would fail; put the key in its own env var`;
  }
  if (isBlockedEgressHost(parsed.hostname)) {
    return `${envVar} resolves to a private/internal/metadata address, which is refused`;
  }
  return null;
}

export interface BuildSearchOptions {
  /** Injected for tests; production passes nothing and the adapter uses global `fetch`. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Pre-built providers, bypassing env construction. Used by the in-container HTTP gate and tests
   *  to exercise the real verb/tool wiring with a deterministic provider. */
  providers?: SearchProvider[];
  /** Router timer seam (tests). */
  clock?: RouterClock;
  /** Receives one line per search (no query). */
  log?: (line: string) => void;
}

export interface BuiltSearch {
  /** The verb the MCP layer registers. */
  fn: SearchFn;
  /** Ordered provider names, for the boot line. */
  providers: string[];
  /** Router counters (in-memory, process-local). */
  metrics(): RouterMetrics;
}

/**
 * Construct the search verb from env, or `undefined` when the feature is disabled.
 *
 * Throws (fail-closed, at boot) when enabled but misconfigured: an unknown provider name, a missing
 * key, a non-https endpoint, or an endpoint pointing at a private address. Messages name the ENV
 * VAR, never the value (R9).
 */
export function buildSearch(env: NodeJS.ProcessEnv, secrets: SecretStore, opts: BuildSearchOptions = {}): BuiltSearch | undefined {
  const settings = loadSearchSettings(env);
  if (!settings.enabled) return undefined;

  if (settings.providers.length === 0) {
    throw new Error("BGW_SEARCH_ENABLED=1 but BGW_SEARCH_PROVIDERS is empty — configure at least one provider or unset BGW_SEARCH_ENABLED");
  }

  // An explicit provider list lets the gate/tests inject a deterministic provider without a key,
  // while production always travels the env path below.
  if (opts.providers) return built(opts.providers, settings, opts);

  if (new Set(settings.providers).size !== settings.providers.length) {
    // Breaker state and metrics are per provider name; listing one twice is a typo, not a policy.
    throw new Error("BGW_SEARCH_PROVIDERS names a provider more than once");
  }

  const constructed: SearchProvider[] = [];
  for (const name of settings.providers) {
    if (name === "brave") {
      const apiKey = secrets.get("BGW_BRAVE_SEARCH_API_KEY");
      if (!apiKey) {
        throw new Error("BGW_SEARCH_ENABLED=1 lists provider 'brave' but BGW_BRAVE_SEARCH_API_KEY is not set");
      }
      const urlError = searchEndpointError(settings.braveApiUrl, "BGW_BRAVE_SEARCH_API_URL");
      if (urlError) throw new Error(urlError);
      constructed.push(
        new BraveSearchProvider({
          apiKey,
          apiUrl: settings.braveApiUrl,
          ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
          ...(opts.now ? { now: opts.now } : {}),
        }),
      );
      continue;
    }
    throw new Error(
      `BGW_SEARCH_PROVIDERS names an unknown provider '${name}' — known providers: ${KNOWN_SEARCH_PROVIDERS.join(", ")}`,
    );
  }

  return built(constructed, settings, opts);
}

function built(providers: SearchProvider[], settings: SearchSettings, opts: BuildSearchOptions): BuiltSearch {
  const router = createSearchRouter({
    providers,
    providerTimeoutMs: settings.providerTimeoutMs,
    totalTimeoutMs: settings.totalTimeoutMs,
    breakerThreshold: settings.breakerThreshold,
    breakerCooldownMs: settings.breakerCooldownMs,
    emptyResultsFallback: settings.emptyResultsFallback,
    ...(opts.clock ? { clock: opts.clock } : {}),
    ...(opts.log ? { log: opts.log } : {}),
  });
  return { fn: router.search, providers: providers.map((p) => p.name), metrics: router.metrics };
}

/**
 * Wrap providers into the {@link SearchFn} verb: a router with the default breaker and empty-result
 * policy. One code path — a single provider is a one-provider router (VIL-123).
 */
export function makeSearchFn(
  providers: SearchProvider[],
  settings: Pick<SearchSettings, "providerTimeoutMs" | "totalTimeoutMs"> & Partial<Pick<SearchSettings, "breakerThreshold" | "breakerCooldownMs" | "emptyResultsFallback">>,
  clock?: RouterClock,
): SearchFn {
  if (providers.length === 0) throw new Error("makeSearchFn requires at least one provider");
  return createSearchRouter({ providers, ...settings, ...(clock ? { clock } : {}) }).search;
}

/**
 * Wrap a {@link SearchFn} so no error crossing it can carry BYO secret material to a consumer (R9),
 * preserving the typed failure and the attempt record. One implementation because BOTH entrypoints
 * need it and a hand-rolled near-copy in each is exactly how the two surfaces drift.
 *
 * The adapter already reports failure SHAPE only, so this is defense in depth rather than the
 * primary guarantee — but the primary guarantee lives in a different file from the one an entrypoint
 * author reads, which is precisely when defense in depth earns its keep.
 */
export function redactedSearchFn(fn: SearchFn, secrets: { redactableValues(): readonly string[] }): SearchFn {
  return async (req) => {
    try {
      return redactSearchResponse(await fn(req), secrets);
    } catch (err) {
      if (err instanceof SearchAttemptsError) {
        throw new SearchAttemptsError(
          new SearchProviderError(err.failure.code, redactSecrets(err.failure.message, secrets), {
            httpStatus: err.failure.httpStatus,
            ...(err.failure.retryAfterMs !== undefined ? { retryAfterMs: err.failure.retryAfterMs } : {}),
          }),
          err.attempts,
        );
      }
      throw new Error(redactSecrets(err instanceof Error ? err.message : String(err), secrets));
    }
  };
}

/**
 * Scrub every caller-visible string on a SUCCESSFUL response.
 *
 * The success path needs this as much as the error path: a provider payload is attacker-influenced
 * text that the MCP layer renders into both `content` and `structuredContent`, and the endpoint is
 * deployment-configurable — so an upstream that reflected the request's `x-subscription-token` into
 * a title, snippet, or URL would hand the gateway's own credential to the consumer. R9 says a secret
 * never reaches consumer output, and "errors only" is not that guarantee.
 *
 * Redacting a URL can corrupt it; that is the correct trade. A URL containing the API key is not a
 * link worth preserving.
 */
export function redactSearchResponse(res: SearchResponse, secrets: { redactableValues(): readonly string[] }): SearchResponse {
  return {
    ...res,
    query: redactSecrets(res.query, secrets),
    provider: redactSecrets(res.provider, secrets),
    results: res.results.map((r) => ({
      ...r,
      title: redactSecrets(r.title, secrets),
      url: redactSecrets(r.url, secrets),
      displayUrl: redactSecrets(r.displayUrl, secrets),
      snippet: redactSecrets(r.snippet, secrets),
    })),
  };
}

export { SearchAttemptsError };
