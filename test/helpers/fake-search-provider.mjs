/**
 * Deterministic {@link SearchProvider} for tests and for the in-container HTTP gate.
 *
 * It exists so the SAME normalization assertions can run against the real adapter (with a fake
 * fetch) and against a provider that never touches a network — which is what makes those assertions
 * a contract on the seam rather than a description of one adapter's behaviour.
 */
import { SearchProviderError } from "../../dist/search/index.js";

/**
 * @param {object} opts
 * @param {import("../../dist/search/index.js").SearchResult[]} [opts.results] results to return
 * @param {string} [opts.throwCode] a SearchFailureClass to throw instead of returning
 * @param {number} [opts.httpStatus]
 * @param {number} [opts.retryAfterMs]
 * @param {string} [opts.name]
 */
export function fakeSearchProvider(opts = {}) {
  const calls = [];
  return {
    name: opts.name ?? "fake",
    calls,
    async search(req, ctx) {
      calls.push({ req, deadline: ctx.deadline });
      if (opts.throwCode) {
        throw new SearchProviderError(opts.throwCode, `fake provider failed with ${opts.throwCode}`, {
          httpStatus: opts.httpStatus ?? null,
          ...(opts.retryAfterMs !== undefined ? { retryAfterMs: opts.retryAfterMs } : {}),
        });
      }
      return opts.results ?? DEFAULT_RESULTS;
    },
  };
}

/** The same three results the Brave fixture normalizes to — so a contract test can assert one
 *  expected shape against both providers. */
export const DEFAULT_RESULTS = [
  {
    rank: 1,
    title: "First Result Title",
    url: "https://alpha.example.invalid/docs/getting-started",
    displayUrl: "alpha.example.invalid/docs/getting-started",
    snippet: "A short description of the first result, as the provider returns it.",
    publishedAt: null,
  },
  {
    rank: 2,
    title: "Second Result Title",
    url: "https://beta.example.invalid/",
    displayUrl: "beta.example.invalid",
    snippet: "A short description of the second result.",
    publishedAt: null,
  },
  {
    rank: 3,
    title: "Third Result Title",
    url: "https://gamma.example.invalid/a/b?q=1",
    displayUrl: "gamma.example.invalid/a/b",
    snippet: "A short description of the third result.",
    publishedAt: null,
  },
];
