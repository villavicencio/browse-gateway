/**
 * Search enablement, boot guards, and the verb wrapper (VIL-122).
 *
 * The load-bearing property here is the DISABLED invariant: with `BGW_SEARCH_ENABLED` unset,
 * `buildSearch` returns undefined and nothing downstream registers a tool. Everything else is the
 * fail-closed behaviour a deploy depends on — each guard must refuse at boot, and each message must
 * name the env var and never its value.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSearch,
  makeSearchFn,
  loadSearchSettings,
  searchEndpointError,
  redactedSearchFn,
  SearchAttemptsError,
  SearchProviderError,
  SEARCH_FAILURE_CLASSES,
  BRAVE_DEFAULT_API_URL,
  DEFAULT_SEARCH_PROVIDER_TIMEOUT_MS,
  DEFAULT_SEARCH_TOTAL_TIMEOUT_MS,
} from "../dist/search/index.js";
import { SecretStore } from "../dist/security/index.js";
import { fakeSearchProvider, DEFAULT_RESULTS } from "./helpers/fake-search-provider.mjs";

const KEY = "brave-key-abcdef3210";
const store = (env) => new SecretStore(() => env);
const SETTINGS = { providerTimeoutMs: DEFAULT_SEARCH_PROVIDER_TIMEOUT_MS, totalTimeoutMs: DEFAULT_SEARCH_TOTAL_TIMEOUT_MS };
const REQ = { query: "example query", count: 10, safeSearch: "moderate" };

test("disabled by default → buildSearch returns undefined (the tool is never registered)", () => {
  assert.equal(buildSearch({}, store({})), undefined);
  // Explicitly not-1 is still off — only the exact opt-in enables it.
  assert.equal(buildSearch({ BGW_SEARCH_ENABLED: "true" }, store({})), undefined);
  assert.equal(buildSearch({ BGW_SEARCH_ENABLED: "0" }, store({})), undefined);
});

test("a disabled build ignores every other search setting, valid or not", () => {
  // A half-configured deployment must not half-enable: no key, a bogus provider, and an http URL
  // together still produce a clean `undefined` rather than a boot refusal.
  const env = { BGW_SEARCH_PROVIDERS: "nonesuch", BGW_BRAVE_SEARCH_API_URL: "http://10.0.0.1/" };
  assert.equal(buildSearch(env, store(env)), undefined);
});

test("enabled without a key → throws naming the env var, never a value", () => {
  const env = { BGW_SEARCH_ENABLED: "1" };
  assert.throws(() => buildSearch(env, store(env)), (err) => {
    assert.match(err.message, /BGW_BRAVE_SEARCH_API_KEY/);
    return true;
  });
});

test("enabled with a key → one provider, in the configured order", () => {
  const env = { BGW_SEARCH_ENABLED: "1", BGW_BRAVE_SEARCH_API_KEY: KEY };
  const built = buildSearch(env, store(env));
  assert.deepEqual(built.providers, ["brave"]);
  assert.equal(typeof built.fn, "function");
});

test("an unknown provider name refuses the boot rather than falling back to the default", () => {
  const env = { BGW_SEARCH_ENABLED: "1", BGW_SEARCH_PROVIDERS: "braev", BGW_BRAVE_SEARCH_API_KEY: KEY };
  assert.throws(() => buildSearch(env, store(env)), /unknown provider 'braev'/);
});

test("an empty provider list refuses the boot", () => {
  const env = { BGW_SEARCH_ENABLED: "1", BGW_SEARCH_PROVIDERS: " , ", BGW_BRAVE_SEARCH_API_KEY: KEY };
  assert.throws(() => buildSearch(env, store(env)), /BGW_SEARCH_PROVIDERS is empty/);
});

test("a non-https endpoint refuses the boot (the key rides a header)", () => {
  const env = { BGW_SEARCH_ENABLED: "1", BGW_BRAVE_SEARCH_API_KEY: KEY, BGW_BRAVE_SEARCH_API_URL: "http://api.search.invalid/x" };
  assert.throws(() => buildSearch(env, store(env)), /must be https/);
});

test("a private/metadata endpoint refuses the boot (no SSRF primitive via config)", () => {
  for (const host of ["http://169.254.169.254/latest", "https://169.254.169.254/latest", "https://127.0.0.1/x", "https://10.1.2.3/x"]) {
    const env = { BGW_SEARCH_ENABLED: "1", BGW_BRAVE_SEARCH_API_KEY: KEY, BGW_BRAVE_SEARCH_API_URL: host };
    assert.throws(() => buildSearch(env, store(env)), /BGW_BRAVE_SEARCH_API_URL/, `expected ${host} to be refused`);
  }
});

test("KNOWN BOUNDARY: the endpoint check is literal, not DNS-resolving", () => {
  // Pinned deliberately so this limit is never mistaken for a complete SSRF guarantee.
  // `isBlockedEgressHost` is pure and resolves nothing (its own header says so), so a PUBLIC name
  // that resolves to a private address passes it. The complementary layer is the container network
  // filter, same as for the browser path — and a boot-time DNS check would not substitute, since
  // what a name resolves to at boot says nothing about what it resolves to at request time.
  assert.equal(searchEndpointError("https://127.0.0.1.sslip.io/search", "BGW_X"), null);
  // What it DOES catch: IP literals in every encoding, and the internal name suffixes.
  for (const blocked of [
    "https://127.0.0.1/x",
    "https://169.254.169.254/x",
    "https://[::1]/x",
    "https://foo.localhost/x",
    "https://svc.internal/x",
    "https://metadata.google.internal/x",
  ]) {
    assert.match(searchEndpointError(blocked, "BGW_X") ?? "", /private\/internal\/metadata/, `expected ${blocked} to be refused`);
  }
});

test("searchEndpointError names the variable it was given, and passes a good URL", () => {
  assert.equal(searchEndpointError(BRAVE_DEFAULT_API_URL, "BGW_X"), null);
  assert.match(searchEndpointError("nope", "BGW_X"), /BGW_X is not a valid URL/);
  assert.match(searchEndpointError("http://a.invalid/", "BGW_X"), /BGW_X must be https/);
});

test("settings fall back to the shipped defaults on a junk value", () => {
  const s = loadSearchSettings({ BGW_SEARCH_PROVIDER_TIMEOUT_MS: "1e3", BGW_SEARCH_TOTAL_TIMEOUT_MS: "-5" });
  assert.equal(s.providerTimeoutMs, DEFAULT_SEARCH_PROVIDER_TIMEOUT_MS);
  assert.equal(s.totalTimeoutMs, DEFAULT_SEARCH_TOTAL_TIMEOUT_MS);
  assert.equal(s.braveApiUrl, BRAVE_DEFAULT_API_URL);
});

test("every failure class carries caller-facing advice", async () => {
  // A class with no hint is a dead end for the caller — the point of a closed vocabulary is that
  // each member implies a different next move. Asserted through the real MCP text path.
  const { createGatewayMcpServer } = await import("../dist/mcp/index.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  for (const code of SEARCH_FAILURE_CLASSES) {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createGatewayMcpServer({
      retrieve: async () => ({ markdown: "x", title: "t", status: 200, blocked: false, reason: null, degraded: false, proxyUsed: false, captchaSolved: false }),
      search: async () => {
        throw new SearchAttemptsError(new SearchProviderError(code, "boom"), [{ provider: "fake", outcome: "failed", failureClass: code, durationMs: 1 }]);
      },
    });
    await server.connect(st);
    const client = new Client({ name: "t", version: "1.0.0" });
    await client.connect(ct);
    const res = await client.callTool({ name: "search", arguments: { query: "q" } });
    const text = res.content[0].text;
    assert.match(text, new RegExp(`failureClass=${code}\\b`));
    // The hint is whatever follows the closing paren — it must not be empty.
    const hint = text.slice(text.indexOf(")." ) + 2).trim();
    assert.ok(hint.length > 0, `class ${code} rendered no hint`);
  }
});

test("makeSearchFn: a successful search reports one ok attempt and the normalized results", async () => {
  const provider = fakeSearchProvider();
  const fn = makeSearchFn([provider], SETTINGS);
  const res = await fn(REQ);
  assert.equal(res.provider, "fake");
  assert.equal(res.query, "example query");
  assert.deepEqual(res.results, DEFAULT_RESULTS);
  assert.equal(res.attempts.length, 1);
  assert.equal(res.attempts[0].outcome, "ok");
  assert.equal(res.attempts[0].failureClass, undefined);
  assert.ok(Number.isFinite(Date.parse(res.retrievedAt)));
});

test("makeSearchFn: an empty provider answer is a SUCCESS with zero results, marked `empty`", async () => {
  const fn = makeSearchFn([fakeSearchProvider({ throwCode: "empty-results" })], SETTINGS);
  const res = await fn(REQ);
  assert.deepEqual(res.results, []);
  assert.equal(res.attempts[0].outcome, "empty");
  // `empty` is its own state: a working provider that found nothing is never reported as failed.
  assert.equal(res.attempts[0].failureClass, undefined);
});

test("makeSearchFn: a typed provider failure throws with the attempt record intact", async () => {
  const fn = makeSearchFn([fakeSearchProvider({ throwCode: "rate-limited", httpStatus: 429, retryAfterMs: 7000 })], SETTINGS);
  await assert.rejects(fn(REQ), (err) => {
    assert.ok(err instanceof SearchAttemptsError);
    assert.equal(err.failure.code, "rate-limited");
    assert.equal(err.attempts[0].outcome, "failed");
    assert.equal(err.attempts[0].failureClass, "rate-limited");
    assert.equal(err.attempts[0].retryAfterMs, 7000);
    assert.equal(err.attempts[0].httpStatus, 429);
    return true;
  });
});

test("makeSearchFn: an untyped adapter throw is classified without echoing its message", async () => {
  const leaky = { name: "leaky", async search() { throw new Error(`boom with ${KEY} inside`); } };
  const fn = makeSearchFn([leaky], SETTINGS);
  await assert.rejects(fn(REQ), (err) => {
    assert.equal(err.failure.code, "network-error");
    assert.ok(!err.message.includes(KEY), `the key leaked into: ${err.message}`);
    return true;
  });
});

test("makeSearchFn clamps the per-attempt budget to the total deadline", async () => {
  const provider = fakeSearchProvider();
  const fn = makeSearchFn([provider], { providerTimeoutMs: 60_000, totalTimeoutMs: 1_000 });
  const before = Date.now();
  await fn(REQ);
  // The deadline handed to the provider reflects the SMALLER of the two budgets.
  assert.ok(provider.calls[0].deadline - before <= 1_000 + 50, "per-attempt deadline exceeded the total budget");
});

test("makeSearchFn refuses to build with no providers", () => {
  assert.throws(() => makeSearchFn([], SETTINGS), /at least one provider/);
});

test("redactedSearchFn scrubs a leaked secret while preserving the typed failure", async () => {
  const secrets = store({ BGW_BRAVE_SEARCH_API_KEY: KEY });
  const leaking = async () => {
    throw new SearchAttemptsError(new SearchProviderError("provider-unavailable", `upstream said ${KEY}`, { httpStatus: 503 }), [
      { provider: "brave", outcome: "failed", failureClass: "provider-unavailable", durationMs: 3 },
    ]);
  };
  await assert.rejects(redactedSearchFn(leaking, secrets)(REQ), (err) => {
    assert.ok(err instanceof SearchAttemptsError);
    assert.equal(err.failure.code, "provider-unavailable");
    assert.equal(err.failure.httpStatus, 503);
    assert.equal(err.attempts.length, 1);
    assert.ok(!err.message.includes(KEY), `the key survived redaction: ${err.message}`);
    return true;
  });
});

test("redactedSearchFn passes a success through untouched", async () => {
  const secrets = store({ BGW_BRAVE_SEARCH_API_KEY: KEY });
  const fn = redactedSearchFn(makeSearchFn([fakeSearchProvider()], SETTINGS), secrets);
  assert.deepEqual((await fn(REQ)).results, DEFAULT_RESULTS);
});

test("every search env var the code reads is forwarded by the stdio launcher", async () => {
  // The launcher's -e list is an explicit ALLOWLIST, not a pass-through: a variable missing from it
  // is invisible inside the container whatever the operator exported, so the feature reads as
  // disabled on that path with no error anywhere. That is exactly how the search wiring shipped
  // unreachable on the stdio launcher until review caught it; this pins the class shut.
  const { readFileSync } = await import("node:fs");
  const launcher = readFileSync(new URL("../scripts/browse-gateway-mcp-launcher.sh", import.meta.url), "utf8");
  const source = readFileSync(new URL("../src/search/config.ts", import.meta.url), "utf8");
  const read = [...source.matchAll(/env\.(BGW_[A-Z0-9_]+)/g)].map((m) => m[1]);
  assert.ok(read.length >= 5, `expected to find the search env reads, found ${read.length}`);
  const forwarded = new Set([...launcher.matchAll(/-e (BGW_[A-Z0-9_]+)/g)].map((m) => m[1]));
  for (const name of new Set(read)) {
    assert.ok(forwarded.has(name), `${name} is read by src/search/config.ts but not forwarded by browse-gateway-mcp-launcher.sh`);
  }
  // The secret is named in SECRET_KEYS rather than read via `env.` — assert it explicitly.
  assert.ok(forwarded.has("BGW_BRAVE_SEARCH_API_KEY"), "the provider key is not forwarded by the stdio launcher");
});

test("contract: the adapter and the deterministic fake normalize to the SAME shape", async () => {
  // The point of the seam: these assertions are a contract on SearchProvider, not a description of
  // one adapter. `search-brave.test.mjs` runs the identical expectation against the real adapter.
  const results = await fakeSearchProvider().search(REQ, { deadline: Date.now() + 1000, signal: new AbortController().signal });
  for (const r of results) {
    assert.deepEqual(Object.keys(r).sort(), ["displayUrl", "publishedAt", "rank", "snippet", "title", "url"]);
  }
  assert.deepEqual(results.map((r) => r.rank), [1, 2, 3]);
});
