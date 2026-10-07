# `src/search` — the `search` verb

Discovery as a first-class operation. A client asks for a query; Obscura decides which sanctioned
provider answers it and returns a normalized, provider-agnostic result list.

## Why this is not `retrieve("https://<engine>/search?q=…")`

Handing a SERP URL to `retrieve` gives a *discovery* problem the semantics of a *destination-page*
problem: the escalation ladder, the clearance poll, the markdown extractor, and the block classifier
are all tuned for reading a page a caller already chose. A search engine that challenges the request
then looks like a blocked destination, and the caller's next move — rotate an exit, re-roll, force a
proxy — is wrong for a discovery failure. It also makes each consumer own the engine's markup and
the decision of which engine to switch to, which is provider mechanics leaking into every client.

## The two invariants

1. **Disabled is byte-identical to absent.** With `BGW_SEARCH_ENABLED` unset, `buildSearch` returns
   `undefined`, the runtime carries no `search`, and `createGatewayMcpServer` registers no `search`
   tool. A deployment with the feature off lists exactly the tools it listed before this shipped.
   `test/search-mcp.test.mjs` and the pre-existing `test/mcp-surface.test.mjs` both pin it, and
   `scripts/validate-http.mjs` proves it inside the image.
2. **Nothing provider-specific crosses the seam.** An adapter maps its own wire shape into
   `SearchResult` and its own errors into `SearchFailureClass`. The normalized key set is asserted
   exactly, so a leaked vendor field fails a test rather than quietly becoming public contract.

## Where the policy layer applies

**The provider API call does not go through the navigation allowlist, and that is deliberate.** The
allowlist governs *consumer-directed navigation* — a consumer names a URL and the browser is clamped
to approved destinations. A provider endpoint is deployment configuration that no consumer can
influence, so there is no per-request authorization decision to make.

What must not happen is a deployment pointing the adapter at a private or metadata address, turning
`search` into an SSRF primitive. So the same `isBlockedEgressHost` filter the policy engine uses is
applied to the configured endpoint — once, at **boot**, in `searchEndpointError`, alongside an
https-only check (the API key rides a request header). A bad endpoint refuses the boot.

**Know what that check does and does not cover.** `isBlockedEgressHost` is pure and does no DNS
resolution — by design, and stated in its own header. It catches IP literals (every private range,
including alternate encodings and IPv4-mapped IPv6) and internal names (`localhost`, `.internal`,
`.local`, the metadata names). It does **not** catch a public hostname that *resolves* to a private
address — `https://127.0.0.1.sslip.io/` passes it. The complementary layer for that is the container
network filter in compose, exactly as for the browser path; a boot-time DNS check would not be a
substitute anyway, since what a name resolves to at boot says nothing about what it resolves to at
request time. `test/search-config.test.mjs` pins this boundary so it is not later mistaken for a
complete guarantee.

Redirects are the other half, and they are refused outright (`redirect: "manual"`). Measured on
Node 24: `fetch` strips `Authorization` across a cross-origin redirect but forwards a **custom**
header verbatim, so following one would both disclose `x-subscription-token` to the redirect target
and reach that target without any of the checks above. A 3xx is therefore a typed failure, not a hop.

Boot is the right place for the same reason every other guard lives there: per the project rule,
anything that must fail a deploy has to be observable at boot. A check inside the per-connection
`buildServer:` callback would be a per-session 500 that no deploy probe reaches.

## Configuration

| Env | Meaning | Default |
|---|---|---|
| `BGW_SEARCH_ENABLED` | `1` enables the feature and registers the tool | unset (off) |
| `BGW_SEARCH_PROVIDERS` | ordered CSV of provider names; tried in this order, each name at most once | `brave` |
| `BGW_SEARCH_PROVIDER_TIMEOUT_MS` | per-provider budget (a `Retry-After` retry spends the same budget) | `8000` |
| `BGW_SEARCH_TOTAL_TIMEOUT_MS` | total deadline across all providers; every attempt is clamped to it | `20000` |
| `BGW_SEARCH_BREAKER_THRESHOLD` | consecutive counted failures that open a provider's breaker | `2` |
| `BGW_SEARCH_BREAKER_COOLDOWN_MS` | how long an open breaker skips its provider before one half-open probe | `300000` |
| `BGW_SEARCH_EMPTY_RESULTS_FALLBACK` | `0` stops at the first provider that answers "nothing matched" | on |
| `BGW_BRAVE_SEARCH_API_URL` | endpoint base; https only, non-private | the documented endpoint |
| `BGW_BRAVE_SEARCH_API_KEY` | **secret**, listed in `SECRET_KEYS` | — |

The boot line reports `search=off` or `search=<providers>`, so a misconfiguration is visible to the
pre-swap smoke without a new deploy step.

## Known gap: `publishedAt` is always `null` for Brave

The per-result schema on the vendor's API reference sits behind a collapsed accordion that neither
the browser tier nor a plain fetch expanded. The only per-result fields confirmed from the vendor's
own JSON examples are `title`, `url`, `description` and `extra_snippets` — **no date field name was
confirmed**. Rather than invent one and ship a field that is silently always absent, the adapter
reports `null`. Resolve by inspecting one live response once a key exists.

## Routing (VIL-123)

`router.ts` is the only code path; a single-provider deployment is a one-provider router.

**The deadline invariant.** Each attempt's deadline is `min(now + providerTimeoutMs, totalDeadline)`,
and the router enforces it itself rather than trusting the adapter: a router-owned timer settles the
attempt at the deadline (a provider that ignores both `ctx.deadline` and `ctx.signal` is abandoned,
not awaited) and `ctx.signal` is aborted on every exit. No attempt starts with less than
`MIN_ATTEMPT_MS` (500 ms) left. When the total deadline cuts an attempt or prevents one, the outcome
is `total-deadline-exhausted` with the full attempt list — not whichever provider failed last.

**Policy by failure class.**

| Class | Moves to next provider | Breaker | Retried |
|---|---|---|---|
| `rate-limited` | yes | counts | once, only if `Retry-After` + 500 ms fits the provider's remaining budget |
| `authentication-failed`, `quota-exhausted` | yes | **opens at once** | never |
| `timeout`, `network-error`, `provider-unavailable`, `malformed-response` | yes | counts | no |
| `unsupported-query` | yes (another provider may have different limits) | no — it is the query | no |
| `empty-results` | yes, unless `BGW_SEARCH_EMPTY_RESULTS_FALLBACK=0` | no | no |

**Breaker.** Per provider, in-memory. Threshold consecutive counted failures open it; while open the
provider is recorded as `skipped: true` (no request sent); after the cooldown exactly one half-open
probe is admitted, and its result closes or re-opens it. **Last resort:** when every provider is open
and nothing has been sent yet in this search, the LAST provider is called anyway — exactly one request,
never one per dead provider. Without that rule a one-provider deployment would refuse every search for
the whole cooldown after two timeouts.

**Outcomes.** Any provider with results wins. Otherwise, if any provider answered "nothing matched",
the search succeeds with zero results. Otherwise it fails with `total-deadline-exhausted` when the
deadline ended it, else the first of `authentication-failed` > `quota-exhausted` > `rate-limited`
found in the history, else the first failure. The MCP text names the provider whose class is
reported, `tried=` lists the chain (breaker skips marked), and a success served by a later provider
says `fallback=true`.

**Observability.** One log line per search (`search: outcome=… provider=… attempts=[…]`), which
never carries the query. `BuiltSearch.metrics()` returns per-provider counters; surfacing them on
`/health` is VIL-130's.

## Scope

Shipped: one real provider (Brave) behind the router. **No second real provider yet**: the one
planned (Google Custom Search JSON API) is closed to new customers and discontinued 2027-01-01
(Google's overview page, fetched 2026-10-07), so the fallback is proven with deterministic fakes and
a real second adapter is a follow-up. Also deferred: the query cache, canonical-URL deduplication,
and a browser-SERP fallback (`captcha` and `challenge-interstitial` stay declared for it).
