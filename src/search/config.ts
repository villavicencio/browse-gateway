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
import { SearchProviderError } from "./types.js";
import type { SearchAttempt, SearchFn, SearchProvider, SearchRequest, SearchResponse, SearchResult } from "./types.js";

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
}

export interface BuiltSearch {
  /** The verb the MCP layer registers. */
  fn: SearchFn;
  /** Ordered provider names, for the boot line. */
  providers: string[];
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
  if (opts.providers) {
    return { fn: makeSearchFn(opts.providers, settings), providers: opts.providers.map((p) => p.name) };
  }

  const built: SearchProvider[] = [];
  for (const name of settings.providers) {
    if (name === "brave") {
      const apiKey = secrets.get("BGW_BRAVE_SEARCH_API_KEY");
      if (!apiKey) {
        throw new Error("BGW_SEARCH_ENABLED=1 lists provider 'brave' but BGW_BRAVE_SEARCH_API_KEY is not set");
      }
      const urlError = searchEndpointError(settings.braveApiUrl, "BGW_BRAVE_SEARCH_API_URL");
      if (urlError) throw new Error(urlError);
      built.push(
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

  return { fn: makeSearchFn(built, settings), providers: built.map((p) => p.name) };
}

/**
 * Wrap providers into the {@link SearchFn} verb.
 *
 * VIL-122 runs exactly ONE provider — the first — and reports one attempt. Ordered fallback across
 * the rest is the sibling ticket's scope and is deliberately not implemented here: a half-built
 * fallback that silently swallows the first provider's failure class is worse than none, because
 * the caller then cannot tell which provider's verdict they are reading.
 */
export function makeSearchFn(providers: SearchProvider[], settings: Pick<SearchSettings, "providerTimeoutMs" | "totalTimeoutMs">, now: () => number = Date.now): SearchFn {
  const provider = providers[0];
  if (!provider) throw new Error("makeSearchFn requires at least one provider");
  // Clamp the per-attempt budget to the total deadline: a per-provider timeout larger than the
  // total is a configuration that promises the caller a bound it would then blow through.
  const budgetMs = Math.min(settings.providerTimeoutMs, settings.totalTimeoutMs);

  return async (req: SearchRequest): Promise<SearchResponse> => {
    const started = now();
    const controller = new AbortController();
    const deadline = started + budgetMs;
    const attempt: SearchAttempt = { provider: provider.name, outcome: "ok", durationMs: 0 };
    let results: SearchResult[] = [];
    try {
      results = await provider.search(req, { deadline, signal: controller.signal });
    } catch (err) {
      if (err instanceof SearchProviderError && err.code === "empty-results") {
        // A provider that answered correctly and had nothing is not a broken provider. The verb
        // reports a successful search with zero results; the attempt records that it was empty.
        attempt.outcome = "empty";
        attempt.httpStatus = err.httpStatus;
        attempt.durationMs = now() - started;
        return response(req, provider.name, [], [attempt], started, now());
      }
      attempt.outcome = "failed";
      attempt.durationMs = now() - started;
      if (err instanceof SearchProviderError) {
        attempt.failureClass = err.code;
        attempt.httpStatus = err.httpStatus;
        if (err.retryAfterMs !== undefined) attempt.retryAfterMs = err.retryAfterMs;
        throw new SearchAttemptsError(err, [attempt]);
      }
      // A non-typed throw from an adapter is an adapter defect, not a provider verdict. Classify it
      // conservatively and keep the attempt record so the caller still sees what was tried. The raw
      // message is deliberately NOT propagated: a transport error can quote the request, and the
      // request carries the API key in a header — so only the failure SHAPE crosses this boundary
      // (same rule the adapter applies to its own fetch/stream errors).
      const wrapped = new SearchProviderError("network-error", `search failed (${err instanceof Error ? err.name : "unknown error"})`);
      attempt.failureClass = wrapped.code;
      throw new SearchAttemptsError(wrapped, [attempt]);
    }
    attempt.durationMs = now() - started;
    return response(req, provider.name, results, [attempt], started, now());
  };
}

function response(
  req: SearchRequest,
  provider: string,
  results: SearchResult[],
  attempts: SearchAttempt[],
  started: number,
  ended: number,
): SearchResponse {
  return {
    query: req.query,
    provider,
    results,
    attempts,
    retrievedAt: new Date(ended).toISOString(),
    durationMs: ended - started,
  };
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
      return await fn(req);
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
 * A failed search, carrying the ordered attempt record alongside the typed cause. The MCP layer
 * renders both, so a caller sees WHICH provider failed and HOW, not just a class.
 */
export class SearchAttemptsError extends Error {
  readonly failure: SearchProviderError;
  readonly attempts: SearchAttempt[];
  constructor(failure: SearchProviderError, attempts: SearchAttempt[]) {
    super(failure.message);
    this.name = "SearchAttemptsError";
    this.failure = failure;
    this.attempts = attempts;
  }
}
