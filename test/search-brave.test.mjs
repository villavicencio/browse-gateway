/**
 * BraveSearchProvider tests (VIL-122) — the adapter behind the SearchProvider seam. Pure unit tests
 * with an injected fetch; no network.
 *
 * The fake fetch returns a REAL `Response` built over a REAL `ReadableStream`, so the adapter's
 * capped streaming body read is exercised exactly as it is in production. A fake that handed back
 * `{ json: async () => ({...}) }` would let the byte cap and the abort-through-body-read behaviour
 * pass without ever running — the failure mode this repo calls "a test whose stub guarantees the
 * assertion". Where the stub does model transport behaviour (undici rejects an in-flight body read
 * when the signal aborts) it is called out at the site.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BraveSearchProvider, SearchProviderError, braveStatusToFailureClass, parseRetryAfterMs, BRAVE_MAX_QUERY_CHARS, BRAVE_MAX_QUERY_WORDS } from "../dist/search/index.js";
import { DEFAULT_RESULTS } from "./helpers/fake-search-provider.mjs";

const KEY = "brave-key-abcdef3210";
const API_URL = "https://api.search.invalid/res/v1/web/search";
const FIXTURE = readFileSync(new URL("./fixtures/search/brave-web-search-ok.json", import.meta.url), "utf8");

const REQ = { query: "example query", count: 10, safeSearch: "moderate" };

/** A live context whose deadline is `ms` from now. */
const ctx = (ms = 5_000, signal = new AbortController().signal) => ({ deadline: Date.now() + ms, signal });

/** Fake fetch returning a real Response over a real stream. Records the request it was given. */
function fakeFetch(body, init = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    return new Response(body, { status: init.status ?? 200, headers: init.headers ?? {} });
  };
  fn.calls = calls;
  return fn;
}

const providerWith = (fetchImpl, over = {}) => new BraveSearchProvider({ apiKey: KEY, apiUrl: API_URL, fetchImpl, ...over });

test("normalizes the documented response into the provider-agnostic result shape", async () => {
  const f = fakeFetch(FIXTURE);
  const results = await providerWith(f).search(REQ, ctx());
  assert.deepEqual(results, DEFAULT_RESULTS);
});

test("no provider-specific field survives normalization", async () => {
  const results = await providerWith(fakeFetch(FIXTURE)).search(REQ, ctx());
  // Exact key set — a new field leaking through (e.g. `extra_snippets`, `description`, `meta_url`)
  // fails here rather than silently becoming part of the public contract.
  for (const r of results) {
    assert.deepEqual(Object.keys(r).sort(), ["displayUrl", "publishedAt", "rank", "snippet", "title", "url"]);
  }
});

test("sends the documented parameters and carries the key ONLY in the auth header", async () => {
  const f = fakeFetch(FIXTURE);
  await providerWith(f).search({ query: "example query", count: 5, country: "US", language: "en", safeSearch: "strict" }, ctx());
  const { url, opts } = f.calls[0];
  const params = new URL(url).searchParams;
  assert.equal(params.get("q"), "example query");
  assert.equal(params.get("count"), "5");
  assert.equal(params.get("country"), "US");
  assert.equal(params.get("search_lang"), "en");
  assert.equal(params.get("safesearch"), "strict");
  // Plain-prose snippets: the documented default injects highlight markers.
  assert.equal(params.get("text_decorations"), "false");
  assert.equal(opts.headers["x-subscription-token"], KEY);
  // The key must not ride the URL, where it would reach logs and audit trails.
  assert.ok(!String(url).includes(KEY));
});

test("clamps count to the documented provider maximum", async () => {
  const f = fakeFetch(FIXTURE);
  await providerWith(f).search({ ...REQ, count: 999 }, ctx());
  assert.equal(new URL(f.calls[0].url).searchParams.get("count"), "20");
});

test("zero web results → empty-results", async () => {
  const f = fakeFetch(JSON.stringify({ web: { results: [] } }));
  await assert.rejects(providerWith(f).search(REQ, ctx()), (err) => {
    assert.ok(err instanceof SearchProviderError);
    assert.equal(err.code, "empty-results");
    return true;
  });
});

test("results with an unusable URL are dropped, and an all-unusable page is empty-results", async () => {
  const f = fakeFetch(JSON.stringify({ web: { results: [{ title: "t", url: "javascript:alert(1)" }, { title: "u", url: "not a url" }] } }));
  await assert.rejects(providerWith(f).search(REQ, ctx()), (err) => err.code === "empty-results");
});

test("401 → authentication-failed; 403 too", async () => {
  for (const status of [401, 403]) {
    const f = fakeFetch("{}", { status });
    await assert.rejects(providerWith(f).search(REQ, ctx()), (err) => {
      assert.equal(err.code, "authentication-failed");
      assert.equal(err.httpStatus, status);
      return true;
    });
  }
});

test("429 with Retry-After: 7 → rate-limited carrying retryAfterMs 7000", async () => {
  const f = fakeFetch("{}", { status: 429, headers: { "retry-after": "7" } });
  await assert.rejects(providerWith(f).search(REQ, ctx()), (err) => {
    assert.equal(err.code, "rate-limited");
    assert.equal(err.retryAfterMs, 7000);
    assert.equal(err.httpStatus, 429);
    return true;
  });
});

test("429 without a parseable Retry-After → rate-limited with no retryAfterMs", async () => {
  const f = fakeFetch("{}", { status: 429, headers: { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" } });
  await assert.rejects(providerWith(f).search(REQ, ctx()), (err) => {
    assert.equal(err.code, "rate-limited");
    assert.equal(err.retryAfterMs, undefined);
    return true;
  });
});

test("5xx → provider-unavailable", async () => {
  const f = fakeFetch("{}", { status: 503 });
  await assert.rejects(providerWith(f).search(REQ, ctx()), (err) => err.code === "provider-unavailable");
});

test("422 → unsupported-query (a request rejection is not a malformed response)", async () => {
  const f = fakeFetch("{}", { status: 422 });
  await assert.rejects(providerWith(f).search(REQ, ctx()), (err) => err.code === "unsupported-query");
});

test("402 → quota-exhausted", async () => {
  const f = fakeFetch("{}", { status: 402 });
  await assert.rejects(providerWith(f).search(REQ, ctx()), (err) => err.code === "quota-exhausted");
});

test("malformed JSON → malformed-response", async () => {
  const f = fakeFetch("not json at all");
  await assert.rejects(providerWith(f).search(REQ, ctx()), (err) => err.code === "malformed-response");
});

test("a 200 with no web section → malformed-response", async () => {
  const f = fakeFetch(JSON.stringify({ query: { original: "x" } }));
  await assert.rejects(providerWith(f).search(REQ, ctx()), (err) => err.code === "malformed-response");
});

test("an oversized body is refused AT the cap, without pulling the rest", async () => {
  const CHUNK = new Uint8Array(600_000);
  let pulls = 0;
  const fn = async () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          pulls++;
          if (pulls > 10) return controller.close();
          controller.enqueue(CHUNK);
        },
      }),
    );
  await assert.rejects(providerWith(fn, { maxBodyBytes: 1_000_000 }).search(REQ, ctx()), (err) => {
    assert.equal(err.code, "malformed-response");
    return true;
  });
  // Two 600 KB chunks cross the 1 MB cap; the reader must stop there rather than draining ten.
  assert.ok(pulls <= 3, `expected the read to stop at the cap, pulled ${pulls} chunks`);
});

test("a stalled body aborts at the deadline → timeout", async () => {
  // Models undici: an in-flight body read rejects when the request signal aborts. The adapter's own
  // deadline timer is what fires that signal, so this exercises the real abort-through-body path.
  const fn = async (_url, opts) =>
    new Response(
      new ReadableStream({
        start(controller) {
          opts.signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
        },
      }),
    );
  await assert.rejects(providerWith(fn).search(REQ, ctx(20)), (err) => {
    assert.equal(err.code, "timeout");
    return true;
  });
});

test("a deadline already in the past never issues a request", async () => {
  const f = fakeFetch(FIXTURE);
  await assert.rejects(providerWith(f).search(REQ, { deadline: Date.now() - 1, signal: new AbortController().signal }), (err) => err.code === "timeout");
  assert.equal(f.calls.length, 0);
});

test("an already-aborted caller signal never issues a request", async () => {
  const f = fakeFetch(FIXTURE);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(providerWith(f).search(REQ, { deadline: Date.now() + 5_000, signal: ac.signal }), (err) => err.code === "timeout");
  assert.equal(f.calls.length, 0);
});

test("a transport throw becomes network-error and NEVER echoes the key", async () => {
  // The realistic leak: a transport error that quotes the request it failed on — headers included.
  const fn = async () => {
    throw new Error(`connect ECONNREFUSED while sending x-subscription-token: ${KEY}`);
  };
  await assert.rejects(providerWith(fn).search(REQ, ctx()), (err) => {
    assert.equal(err.code, "network-error");
    assert.ok(!err.message.includes(KEY), `the key leaked into: ${err.message}`);
    return true;
  });
});

test("over-long queries are refused locally, without spending a request", async () => {
  const f = fakeFetch(FIXTURE);
  const p = providerWith(f);
  await assert.rejects(p.search({ ...REQ, query: "x".repeat(BRAVE_MAX_QUERY_CHARS + 1) }, ctx()), (err) => err.code === "unsupported-query");
  await assert.rejects(p.search({ ...REQ, query: Array(BRAVE_MAX_QUERY_WORDS + 1).fill("w").join(" ") }, ctx()), (err) => err.code === "unsupported-query");
  await assert.rejects(p.search({ ...REQ, query: "   " }, ctx()), (err) => err.code === "unsupported-query");
  assert.equal(f.calls.length, 0);
});

test("a redirect is REFUSED, and the key never reaches the redirect target", async () => {
  // End-to-end over REAL http servers and the REAL global fetch — not a stub. Node strips
  // `Authorization` across a cross-origin redirect but forwards a CUSTOM header verbatim, so
  // without `redirect: "manual"` the subscription token would be handed to whatever host the
  // endpoint points at, bypassing the https-only + private-address checks done at boot. Delete the
  // flag and this test fails by observing the key arrive at the second server.
  const { createServer } = await import("node:http");
  const seen = [];
  const dest = createServer((req, res) => {
    seen.push(req.headers["x-subscription-token"] ?? null);
    res.end('{"web":{"results":[{"title":"t","url":"https://x.example.invalid/"}]}}');
  });
  await new Promise((r) => dest.listen(0, "127.0.0.1", r));
  const destPort = dest.address().port;
  const start = createServer((req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${destPort}/dest` });
    res.end();
  });
  await new Promise((r) => start.listen(0, "127.0.0.1", r));
  const startPort = start.address().port;
  try {
    const p = new BraveSearchProvider({ apiKey: KEY, apiUrl: `http://127.0.0.1:${startPort}/search` });
    await assert.rejects(p.search(REQ, ctx()), (err) => {
      assert.ok(err instanceof SearchProviderError);
      // The 3xx arrives as a response instead of being followed, and reads as a bad endpoint.
      assert.equal(err.code, "provider-unavailable");
      assert.equal(err.httpStatus, 302);
      return true;
    });
    assert.deepEqual(seen, [], "the API key was forwarded to the redirect target");
  } finally {
    await new Promise((r) => dest.close(r));
    await new Promise((r) => start.close(r));
  }
});

test("the fetch is issued with redirect:manual", async () => {
  const f = fakeFetch(FIXTURE);
  await providerWith(f).search(REQ, ctx());
  assert.equal(f.calls[0].opts.redirect, "manual");
});

test("an error response body is cancelled BEFORE the throw escapes, not eventually", async () => {
  // Throwing with the body unread leaves the request alive after the deadline timer is cleared;
  // a run of 429/5xx would then pin connections and defeat the advertised bound.
  //
  // The ordering is the point, so this asserts it directly instead of sleeping and re-checking: a
  // settle-later cancel would satisfy "cancelled eventually" while still letting the exception
  // escape with the request in flight. `ReadableStream.cancel()` runs the underlying source's
  // cancel algorithm synchronously — only the promise it returns settles later — so the callback
  // must already have fired by the time the caller's catch runs.
  const order = [];
  const body = new ReadableStream({ pull() {}, cancel() { order.push("cancel"); } });
  const fn = async () => new Response(body, { status: 429 });
  await assert.rejects(providerWith(fn).search(REQ, ctx()), (err) => err.code === "rate-limited");
  order.push("caller-observed-throw");
  assert.deepEqual(order, ["cancel", "caller-observed-throw"]);
});

test("3xx maps to provider-unavailable (a redirect means the endpoint is not the API)", () => {
  for (const status of [301, 302, 307, 308]) {
    assert.equal(braveStatusToFailureClass(status), "provider-unavailable");
  }
});

test("status → failure-class mapping is total over the documented codes", () => {
  assert.equal(braveStatusToFailureClass(401), "authentication-failed");
  assert.equal(braveStatusToFailureClass(402), "quota-exhausted");
  assert.equal(braveStatusToFailureClass(429), "rate-limited");
  assert.equal(braveStatusToFailureClass(400), "unsupported-query");
  assert.equal(braveStatusToFailureClass(422), "unsupported-query");
  assert.equal(braveStatusToFailureClass(404), "provider-unavailable");
  assert.equal(braveStatusToFailureClass(500), "provider-unavailable");
  assert.equal(braveStatusToFailureClass(418), "malformed-response");
});

test("parseRetryAfterMs honours delta-seconds only", () => {
  assert.equal(parseRetryAfterMs("7"), 7000);
  assert.equal(parseRetryAfterMs(" 0 "), 0);
  assert.equal(parseRetryAfterMs(null), undefined);
  assert.equal(parseRetryAfterMs("-3"), undefined);
  assert.equal(parseRetryAfterMs("soon"), undefined);
  assert.equal(parseRetryAfterMs("Wed, 21 Oct 2026 07:28:00 GMT"), undefined);
});
