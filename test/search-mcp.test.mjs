/**
 * The `search` MCP tool (VIL-122) — driven through a real MCP client over an in-memory transport
 * with an injected verb. No provider, no network.
 *
 * The invariant this file exists to protect: with no `search` dep the tool is NOT REGISTERED, so a
 * deployment with the feature off lists exactly the tools it listed before the feature shipped.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createGatewayMcpServer, ERROR_KIND_META_KEY } from "../dist/mcp/index.js";
import { makeSearchFn, SearchAttemptsError, SearchProviderError, DEFAULT_SEARCH_PROVIDER_TIMEOUT_MS, DEFAULT_SEARCH_TOTAL_TIMEOUT_MS } from "../dist/search/index.js";
import { fakeSearchProvider, DEFAULT_RESULTS } from "./helpers/fake-search-provider.mjs";

const retrieve = async () => ({
  markdown: "# Title\n\nbody",
  title: "Title",
  status: 200,
  blocked: false,
  reason: null,
  degraded: false,
  proxyUsed: false,
  captchaSolved: false,
});

const SETTINGS = { providerTimeoutMs: DEFAULT_SEARCH_PROVIDER_TIMEOUT_MS, totalTimeoutMs: DEFAULT_SEARCH_TOTAL_TIMEOUT_MS };

async function connect(deps) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createGatewayMcpServer({ retrieve, ...deps });
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

const withProvider = (opts) => makeSearchFn([fakeSearchProvider(opts)], SETTINGS);

test("the search tool is ABSENT when no search dep is injected", async () => {
  const client = await connect({});
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ["retrieve"]);
  assert.ok(!tools.some((t) => t.name === "search"));
});

test("the search tool is registered when the dep IS injected", async () => {
  const client = await connect({ search: withProvider() });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["retrieve", "search"]);
  const tool = tools.find((t) => t.name === "search");
  // The description must steer a caller AWAY from handing a SERP URL to retrieve — that is the
  // behaviour the whole ticket exists to replace.
  assert.match(tool.description, /retrieve/);
  assert.match(tool.description, /search-engine URL/i);
});

test("a successful search renders every result URL in the CONTENT TEXT", async () => {
  const client = await connect({ search: withProvider() });
  const res = await client.callTool({ name: "search", arguments: { query: "example query" } });
  assert.equal(res.isError ?? false, false);
  const text = res.content[0].text;
  assert.match(text, /^provider=fake results=3 durationMs=\d+/);
  // Only `content` text reliably reaches a consumer agent (measured), so the results must be here
  // and not only in structuredContent.
  for (const r of DEFAULT_RESULTS) {
    assert.ok(text.includes(r.url), `result URL missing from the text body: ${r.url}`);
    assert.ok(text.includes(r.title), `result title missing from the text body: ${r.title}`);
    assert.ok(text.includes(r.snippet), `result snippet missing from the text body`);
  }
  assert.match(text, /^1\. First Result Title$/m);
});

test("structuredContent is the normalized response and carries NO provider-specific field", async () => {
  const client = await connect({ search: withProvider() });
  const res = await client.callTool({ name: "search", arguments: { query: "example query" } });
  const sc = res.structuredContent;
  assert.deepEqual(Object.keys(sc).sort(), ["attempts", "durationMs", "provider", "query", "results", "retrievedAt"]);
  for (const r of sc.results) {
    assert.deepEqual(Object.keys(r).sort(), ["displayUrl", "publishedAt", "rank", "snippet", "title", "url"]);
  }
  assert.deepEqual(Object.keys(sc.attempts[0]).sort(), ["durationMs", "outcome", "provider"]);
});

test("zero results is a SUCCESS the agent can read, not an error", async () => {
  const client = await connect({ search: withProvider({ throwCode: "empty-results" }) });
  const res = await client.callTool({ name: "search", arguments: { query: "nothing matches this" } });
  assert.equal(res.isError ?? false, false);
  assert.match(res.content[0].text, /^provider=fake results=0 /);
  assert.match(res.content[0].text, /No results\./);
  assert.deepEqual(res.structuredContent.results, []);
  assert.equal(res.structuredContent.attempts[0].outcome, "empty");
});

test("a provider failure is an in-band tool error naming the class, provider, status and attempts", async () => {
  const client = await connect({ search: withProvider({ throwCode: "rate-limited", httpStatus: 429, retryAfterMs: 7000 }) });
  const res = await client.callTool({ name: "search", arguments: { query: "q" } });
  assert.equal(res.isError, true);
  assert.equal(res._meta[ERROR_KIND_META_KEY], "in-band");
  const text = res.content[0].text;
  assert.match(text, /failureClass=rate-limited/);
  assert.match(text, /provider=fake/);
  assert.match(text, /status=429/);
  assert.match(text, /attempts=1/);
  assert.match(text, /retryAfterMs=7000/);
  assert.match(text, /Wait for the retry window/);
  assert.equal(res.structuredContent.attempts[0].failureClass, "rate-limited");
});

test("each failure class renders its own distinct advice", async () => {
  const seen = new Map();
  for (const code of ["authentication-failed", "quota-exhausted", "provider-unavailable", "timeout", "unsupported-query"]) {
    const client = await connect({ search: withProvider({ throwCode: code }) });
    const res = await client.callTool({ name: "search", arguments: { query: "q" } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, new RegExp(`failureClass=${code}\\b`));
    seen.set(code, res.content[0].text.slice(res.content[0].text.indexOf(").") + 2));
  }
  // Distinct classes must not collapse to the same advice — otherwise splitting them bought nothing.
  assert.equal(new Set(seen.values()).size, seen.size);
});

test("a status-less failure renders status=n/a rather than null", async () => {
  const client = await connect({ search: withProvider({ throwCode: "network-error" }) });
  const res = await client.callTool({ name: "search", arguments: { query: "q" } });
  assert.match(res.content[0].text, /status=n\/a/);
});

test("a verb that throws an untyped error is INTERNAL, not in-band", async () => {
  const client = await connect({
    search: async () => {
      throw new Error("wiring is broken");
    },
  });
  const res = await client.callTool({ name: "search", arguments: { query: "q" } });
  assert.equal(res.isError, true);
  // A gateway-side defect must not look like a target's verdict to a client-side breaker.
  assert.equal(res._meta[ERROR_KIND_META_KEY], "internal");
  assert.match(res.content[0].text, /browse-gateway error: wiring is broken/);
});

test("the schema rejects an empty query and out-of-range counts", async () => {
  const client = await connect({ search: withProvider() });
  for (const args of [{ query: "" }, { query: "q", count: 0 }, { query: "q", count: 21 }, { query: "q", count: 1.5 }, { query: "x".repeat(401) }]) {
    const res = await client.callTool({ name: "search", arguments: args });
    assert.equal(res.isError, true, `expected ${JSON.stringify(args)} to be rejected`);
  }
});

test("the schema rejects malformed country / language / safeSearch values", async () => {
  const client = await connect({ search: withProvider() });
  for (const args of [{ query: "q", country: "USA" }, { query: "q", language: "eng" }, { query: "q", safeSearch: "medium" }]) {
    const res = await client.callTool({ name: "search", arguments: args });
    assert.equal(res.isError, true, `expected ${JSON.stringify(args)} to be rejected`);
  }
});

test("optional arguments are forwarded, and the count default is 10", async () => {
  const provider = fakeSearchProvider();
  const client = await connect({ search: makeSearchFn([provider], SETTINGS) });
  await client.callTool({ name: "search", arguments: { query: "q" } });
  assert.equal(provider.calls[0].req.count, 10);
  assert.equal(provider.calls[0].req.safeSearch, "moderate");
  assert.equal(provider.calls[0].req.country, undefined);

  await client.callTool({ name: "search", arguments: { query: "q2", count: 3, country: "GB", language: "en", safeSearch: "strict" } });
  assert.deepEqual(provider.calls[1].req, { query: "q2", count: 3, safeSearch: "strict", country: "GB", language: "en" });
});

test("registering search does not disturb the retrieve tool", async () => {
  const client = await connect({ search: withProvider() });
  const res = await client.callTool({ name: "retrieve", arguments: { url: "https://example.com/" } });
  assert.equal(res.isError ?? false, false);
  assert.match(res.content[0].text, /# Title/);
});

test("a SearchAttemptsError carrying several attempts reports the count and the LAST provider", async () => {
  const client = await connect({
    search: async () => {
      throw new SearchAttemptsError(new SearchProviderError("provider-unavailable", "down", { httpStatus: 503 }), [
        { provider: "first", outcome: "failed", failureClass: "timeout", durationMs: 8000 },
        { provider: "second", outcome: "failed", failureClass: "provider-unavailable", httpStatus: 503, durationMs: 20 },
      ]);
    },
  });
  const res = await client.callTool({ name: "search", arguments: { query: "q" } });
  assert.match(res.content[0].text, /attempts=2/);
  assert.match(res.content[0].text, /provider=second/);
  assert.equal(res.structuredContent.attempts.length, 2);
});
