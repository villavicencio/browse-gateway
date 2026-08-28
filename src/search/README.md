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

Boot is the right place for the same reason every other guard lives there: per the project rule,
anything that must fail a deploy has to be observable at boot. A check inside the per-connection
`buildServer:` callback would be a per-session 500 that no deploy probe reaches.

## Configuration

| Env | Meaning | Default |
|---|---|---|
| `BGW_SEARCH_ENABLED` | `1` enables the feature and registers the tool | unset (off) |
| `BGW_SEARCH_PROVIDERS` | ordered CSV of provider names | `brave` |
| `BGW_SEARCH_PROVIDER_TIMEOUT_MS` | per-attempt budget | `8000` |
| `BGW_SEARCH_TOTAL_TIMEOUT_MS` | total deadline; the per-attempt budget is clamped to it | `20000` |
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

## Scope

One provider, one attempt, one recorded outcome. Ordered multi-provider fallback, circuit breakers,
caching, and a browser-driven SERP fallback are the sibling ticket's scope. `SearchFailureClass`
already declares the three classes that work needs (`captcha`, `challenge-interstitial`,
`total-deadline-exhausted`) so the closed vocabulary does not widen twice.
