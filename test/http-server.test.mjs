/**
 * U7a HTTP surface tests — drive the shared service over a REAL loopback socket with a real MCP
 * StreamableHTTP client, an injected fake retrieve/drive (no browser), and a real PolicyEngine.
 * Covers: a consumer round-trip, 401 on a bad bearer, per-session consumer binding (a foreign token
 * can't drive another's session), idle-MCP reaping on disconnect-without-DELETE (C1), and DNS-rebind
 * rejection. The real-browser end-to-end is scripts/validate-http.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpHandler, createGatewayMcpServer, awaitBounded } from "../dist/mcp/index.js";
import { PolicyEngine, ConsumerRegistry } from "../dist/policy/index.js";

const outcome = (over = {}) => ({ markdown: "# T\n\nbody", title: "T", status: 200, blocked: false, reason: null, degraded: false, proxyUsed: false, captchaSolved: false, ...over });

function makeDeps(over = {}) {
  const registry = new ConsumerRegistry([
    { id: "alice", token: "tok-alice", allow: ["*"] },
    { id: "bob", token: "tok-bob", allow: ["*"] },
  ]);
  const policy = new PolicyEngine({ registry });
  const disposed = [];
  const deps = {
    authenticate: (t) => policy.authenticate(t),
    buildServer: (consumer) => {
      // Real MCP server; retrieve is tagged with the consumer id so isolation is observable.
      const server = createGatewayMcpServer({ retrieve: async ({ url }) => outcome({ markdown: `${consumer.id} read ${url}` }) });
      return { server, dispose: async () => void disposed.push(consumer.id) };
    },
    ...over,
  };
  return { deps, disposed };
}

async function startServer(handler) {
  const server = createServer((req, res) =>
    handler.handle(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    }),
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return { server, url: new URL(`http://127.0.0.1:${port}/mcp`) };
}

function connect(url, token) {
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  const client = new Client({ name: "test", version: "1.0.0" });
  return { client, transport };
}

async function stop({ server, handler, client }) {
  if (client) await client.close().catch(() => {});
  await handler.closeAll().catch(() => {});
  await new Promise((r) => server.close(r));
  server.closeAllConnections?.(); // don't let a lingering SSE keep-alive hang the test
}

test("HTTP: a consumer initializes, lists tools, and retrieves", async () => {
  const { deps } = makeDeps();
  const handler = createHttpHandler(deps);
  const { server, url } = await startServer(handler);
  let client;
  try {
    const c = connect(url, "tok-alice");
    client = c.client;
    await client.connect(c.transport);
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes("retrieve"));
    const res = await client.callTool({ name: "retrieve", arguments: { url: "https://example.com/" } });
    assert.equal(res.content[0].text, "alice read https://example.com/");
    assert.equal(handler.sessionCount(), 1);
  } finally {
    await stop({ server, handler, client });
  }
});

test("HTTP: a bad bearer is rejected (401) and never opens a session", async () => {
  const { deps } = makeDeps();
  const handler = createHttpHandler(deps);
  const { server, url } = await startServer(handler);
  try {
    const { client, transport } = connect(url, "not-a-real-token");
    await assert.rejects(client.connect(transport));
    assert.equal(handler.sessionCount(), 0);
  } finally {
    await stop({ server, handler });
  }
});

test("HTTP: a session is bound to its consumer — a foreign token cannot drive it (403)", async () => {
  const { deps } = makeDeps();
  const handler = createHttpHandler(deps);
  const { server, url } = await startServer(handler);
  let client;
  try {
    const c = connect(url, "tok-alice");
    client = c.client;
    await client.connect(c.transport);
    const sid = c.transport.sessionId;
    assert.ok(sid, "alice's session id");
    // Replay alice's session id with bob's bearer — the ownership check must reject before dispatch.
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": sid,
        Authorization: "Bearer tok-bob",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(r.status, 403);
    assert.equal(handler.sessionCount(), 1, "alice's session is untouched");
  } finally {
    await stop({ server, handler, client });
  }
});

test("HTTP: an idle session (disconnect without DELETE) is reaped and its controller disposed (C1)", async () => {
  const { deps, disposed } = makeDeps();
  const handler = createHttpHandler({ ...deps, sessionIdleTtlMs: 1_000 });
  const { server, url } = await startServer(handler);
  let client;
  try {
    const c = connect(url, "tok-alice");
    client = c.client;
    await client.connect(c.transport);
    assert.equal(handler.sessionCount(), 1);
    // Do NOT send DELETE — simulate a crashed client. Streamable HTTP fires onsessionclosed only on
    // an explicit DELETE, so without the idle reaper this session (and its browser session) would
    // leak. Force the reaper at a future time past the TTL.
    const reaped = await handler.reapIdle(Date.now() + 10_000);
    assert.equal(reaped.length, 1, "the idle session was reaped");
    assert.equal(handler.sessionCount(), 0);
    assert.deepEqual(disposed, ["alice"], "the drive controller was disposed (browser session released)");
  } finally {
    await stop({ server, handler, client });
  }
});

test("HTTP: DNS-rebind protection rejects an init whose Host is not allow-listed, disposing the orphan", async () => {
  const { deps, disposed } = makeDeps();
  const handler = createHttpHandler({ ...deps, allowedHosts: ["browse-gateway.example:9999"] });
  const { server, url } = await startServer(handler);
  try {
    // The client dials 127.0.0.1:<port>, so its Host header is not in allowedHosts -> rejected at
    // the transport, no session created (and the orphaned per-consumer server is disposed).
    const { client, transport } = connect(url, "tok-alice");
    await assert.rejects(client.connect(transport));
    assert.equal(handler.sessionCount(), 0);
    assert.deepEqual(disposed, ["alice"], "the orphaned per-consumer controller was disposed");
  } finally {
    await stop({ server, handler });
  }
});

test("HTTP: a throw during session open disposes the controller (no leak)", async () => {
  // server.connect throwing bypasses the normal orphan check; the catch in openSession must still
  // dispose, or the per-consumer controller + its browser session leak (reliability finding #1).
  const registry = new ConsumerRegistry([{ id: "alice", token: "tok-alice", allow: ["*"] }]);
  const policy = new PolicyEngine({ registry });
  const disposed = [];
  const handler = createHttpHandler({
    authenticate: (t) => policy.authenticate(t),
    buildServer: (consumer) => ({
      server: { connect: async () => { throw new Error("connect boom"); } },
      dispose: async () => void disposed.push(consumer.id),
    }),
  });
  const { server, url } = await startServer(handler);
  try {
    const { client, transport } = connect(url, "tok-alice");
    await assert.rejects(client.connect(transport));
    assert.deepEqual(disposed, ["alice"], "controller disposed even when open throws");
    assert.equal(handler.sessionCount(), 0);
  } finally {
    await stop({ server, handler });
  }
});

test("HTTP: an oversized request body is rejected with 413", async () => {
  const { deps } = makeDeps();
  const handler = createHttpHandler({ ...deps, maxBodyBytes: 16 });
  const { server, url } = await startServer(handler);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer tok-alice" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } }),
    });
    assert.equal(r.status, 413);
    assert.equal(handler.sessionCount(), 0);
  } finally {
    await stop({ server, handler });
  }
});

test("HTTP: a malformed JSON body is rejected with 400", async () => {
  const { deps } = makeDeps();
  const handler = createHttpHandler(deps);
  const { server, url } = await startServer(handler);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer tok-alice" },
      body: "not json",
    });
    assert.equal(r.status, 400);
  } finally {
    await stop({ server, handler });
  }
});

test("HTTP: a non-initialize POST with no session id is rejected with 400", async () => {
  const { deps } = makeDeps();
  const handler = createHttpHandler(deps);
  const { server, url } = await startServer(handler);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer tok-alice" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(r.status, 400);
  } finally {
    await stop({ server, handler });
  }
});

test("HTTP: a token that stops authenticating is rejected on the next request (per-request re-auth)", async () => {
  const registry = new ConsumerRegistry([{ id: "alice", token: "tok-alice", allow: ["*"] }]);
  const policy = new PolicyEngine({ registry });
  let revoked = false;
  const handler = createHttpHandler({
    authenticate: (t) => {
      if (revoked && t === "tok-alice") throw new Error("revoked");
      return policy.authenticate(t);
    },
    buildServer: () => ({ server: createGatewayMcpServer({ retrieve: async () => outcome() }), dispose: async () => {} }),
  });
  const { server, url } = await startServer(handler);
  let client;
  try {
    const c = connect(url, "tok-alice");
    client = c.client;
    await client.connect(c.transport);
    const sid = c.transport.sessionId;
    revoked = true; // simulate the token no longer resolving (e.g. removed from the registry on restart)
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "mcp-session-id": sid, Authorization: "Bearer tok-alice" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    assert.equal(r.status, 401, "re-auth runs before session routing, so a now-invalid token is rejected");
  } finally {
    await stop({ server, handler, client });
  }
});

test("HTTP: the idle reaper does NOT close a session with an in-flight tool call, then reaps once it settles", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const registry = new ConsumerRegistry([{ id: "alice", token: "tok-alice", allow: ["*"] }]);
  const policy = new PolicyEngine({ registry });
  const handler = createHttpHandler({
    authenticate: (t) => policy.authenticate(t),
    buildServer: () => ({
      server: createGatewayMcpServer({ retrieve: async () => { await gate; return outcome(); } }),
      dispose: async () => {},
    }),
    sessionIdleTtlMs: 1,
  });
  const { server, url } = await startServer(handler);
  let client;
  try {
    const c = connect(url, "tok-alice");
    client = c.client;
    await client.connect(c.transport);
    const callP = client.callTool({ name: "retrieve", arguments: { url: "https://example.com/" } }); // blocks on gate
    await new Promise((r) => setTimeout(r, 50)); // let the POST reach the server and bump inFlight
    assert.equal((await handler.reapIdle(Date.now() + 10_000)).length, 0, "in-flight session is not reaped");
    assert.equal(handler.sessionCount(), 1);
    release();
    await callP;
    assert.equal((await handler.reapIdle(Date.now() + 10_000)).length, 1, "reapable once the call settles");
  } finally {
    await stop({ server, handler, client });
  }
});

test("HTTP: closeAll AWAITS a fire-and-forget cleanup already in flight (deferred dispose) — #50 follow-up", async () => {
  // After #50 made the browser teardown async-confirmed, a cleanup started fire-and-forget by
  // onsessionclosed/onclose leaves its session out of the `sessions` map while its dispose (browser
  // teardown) is still settling. closeAll must drain those in-flight cleanups, not just iterate `sessions`.
  let releaseDispose;
  const disposeGate = new Promise((r) => (releaseDispose = r));
  const disposed = [];
  const registry = new ConsumerRegistry([{ id: "alice", token: "tok-alice", allow: ["*"] }]);
  const policy = new PolicyEngine({ registry });
  const handler = createHttpHandler({
    authenticate: (t) => policy.authenticate(t),
    buildServer: (consumer) => ({
      server: createGatewayMcpServer({ retrieve: async ({ url }) => outcome({ markdown: `${consumer.id} ${url}` }) }),
      dispose: async () => {
        disposed.push(consumer.id);
        await disposeGate; // the browser teardown is still settling
      },
    }),
  });
  const { server, url } = await startServer(handler);
  let client;
  try {
    const c = connect(url, "tok-alice");
    client = c.client;
    await client.connect(c.transport);
    assert.equal(handler.sessionCount(), 1);
    // Explicit DELETE → the server fires onsessionclosed → cleanup() FIRE-AND-FORGET: cleanup removes the
    // session from `sessions` synchronously, then blocks on the deferred dispose — leaving a cleanup IN
    // FLIGHT (in `cleanups`) whose session is already gone. (The real onclose/onsessionclosed shutdown race.)
    await c.transport.terminateSession();
    for (let i = 0; i < 80 && handler.sessionCount() !== 0; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(handler.sessionCount(), 0, "the session left the sessions map (onclose cleanup ran)");
    assert.equal(disposed.length, 1, "the fire-and-forget dispose started");
    // closeAll's `sessions` snapshot is now empty, but the in-flight cleanup's dispose is unsettled — it
    // must drain `cleanups` and stay pending until that dispose settles.
    let closed = false;
    const closeP = handler.closeAll().then(() => (closed = true));
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(closed, false, "closeAll stays pending while an in-flight cleanup's dispose is unsettled");
    releaseDispose();
    await closeP;
    assert.equal(closed, true, "closeAll resolves once the in-flight dispose settles");
  } finally {
    releaseDispose(); // never leave the gate closed (would hang teardown)
    await client?.close().catch(() => {});
    await new Promise((r) => server.close(r));
    server.closeAllConnections?.();
  }
});

test("HTTP: closeAll bounds MULTIPLE hung disposes under ONE deadline, not N× (no compounding) — #50 follow-up", async () => {
  // Several hung drive ops (dispose never settles). closeAll must return within ~one cleanupAwaitMs so
  // http-main reaches gateway.shutdown() (the authoritative force-kill) — a per-session bound would
  // compound to N×cleanupAwaitMs and could blow the shutdown budget.
  const N = 3;
  const registry = new ConsumerRegistry([{ id: "alice", token: "tok-alice", allow: ["*"] }]);
  const policy = new PolicyEngine({ registry });
  const handler = createHttpHandler({
    authenticate: (t) => policy.authenticate(t),
    cleanupAwaitMs: 200,
    buildServer: () => ({
      server: createGatewayMcpServer({ retrieve: async ({ url }) => outcome({ markdown: url }) }),
      dispose: () => new Promise(() => {}), // NEVER settles
    }),
  });
  const { server, url } = await startServer(handler);
  const clients = [];
  try {
    for (let i = 0; i < N; i++) {
      const c = connect(url, "tok-alice");
      clients.push(c.client);
      await c.client.connect(c.transport);
    }
    assert.equal(handler.sessionCount(), N);
    for (const cl of clients) await cl.close().catch(() => {}); // clients gone → transport.close() is fast
    const t0 = Date.now();
    await handler.closeAll();
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 200 * (N - 1), `closeAll bounded under ONE deadline, not compounded (elapsed ${elapsed}ms for ${N} hung sessions)`);
  } finally {
    for (const cl of clients) await cl.close().catch(() => {});
    await new Promise((r) => server.close(r));
    server.closeAllConnections?.();
  }
});

// --- #47: liveness/health route -------------------------------------------------------------

test("#47: GET /health returns a fast authed liveness signal and opens NO session", async () => {
  const { deps } = makeDeps(); // no `health` dep → exercises the bare `{status:"ok"}` fallback
  const handler = createHttpHandler(deps);
  const { server, url } = await startServer(handler);
  try {
    const res = await fetch(new URL("/health", url.origin), { headers: { Authorization: "Bearer tok-alice" } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(await res.json(), { status: "ok" });
    assert.equal(handler.sessionCount(), 0, "liveness must not open an MCP/browser session");
  } finally {
    await new Promise((r) => server.close(r));
    server.closeAllConnections?.();
  }
});

test("#47: GET /health is authed — a bad or absent bearer is 401, never a liveness leak", async () => {
  const { deps } = makeDeps();
  const handler = createHttpHandler(deps);
  const { server, url } = await startServer(handler);
  try {
    const bad = await fetch(new URL("/health", url.origin), { headers: { Authorization: "Bearer nope" } });
    assert.equal(bad.status, 401);
    const none = await fetch(new URL("/health", url.origin));
    assert.equal(none.status, 401);
  } finally {
    await new Promise((r) => server.close(r));
    server.closeAllConnections?.();
  }
});

test("#47: the injected health producer body passes through verbatim (the #53 enrichment seam)", async () => {
  const { deps } = makeDeps({ health: () => ({ status: "ok", forceKillAvailable: true, unconfirmedCount: 0 }) });
  const handler = createHttpHandler(deps);
  const { server, url } = await startServer(handler);
  try {
    const res = await fetch(new URL("/health", url.origin), { headers: { Authorization: "Bearer tok-bob" } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok", forceKillAvailable: true, unconfirmedCount: 0 });
  } finally {
    await new Promise((r) => server.close(r));
    server.closeAllConnections?.();
  }
});

// A raw GET so the Host header can be set explicitly (fetch/undici forbids overriding Host).
function rawGet(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("#47: GET /health applies the DNS-rebind Host guard — valid bearer + disallowed Host is 403 (codex r2)", async () => {
  // The Host allowlist is load-bearing (the transport enforces it on MCP routes; /health bypasses the
  // transport, so it must apply the SAME check). Auth alone is NOT the gate — a valid bearer with a
  // rebind Host must still be refused, especially before #53 exposes pool internals here.
  const { deps } = makeDeps({ allowedHosts: ["gw.allowed:8080"] });
  const handler = createHttpHandler(deps);
  const { server, url } = await startServer(handler);
  try {
    const ok = await rawGet(url.port, "/health", { Host: "gw.allowed:8080", Authorization: "Bearer tok-alice" });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body), { status: "ok" });

    const rebind = await rawGet(url.port, "/health", { Host: "evil.rebind:8080", Authorization: "Bearer tok-alice" });
    assert.equal(rebind.status, 403, "a valid bearer must not bypass the Host allowlist");

    const missingHost = await rawGet(url.port, "/health", { Host: "", Authorization: "Bearer tok-alice" });
    assert.equal(missingHost.status, 403, "an absent Host is refused when the allowlist is configured");
  } finally {
    await new Promise((r) => server.close(r));
    server.closeAllConnections?.();
  }
});

test("awaitBounded: a rejecting promise resolves the bound WITHOUT an unhandledRejection (#50 follow-up)", async () => {
  // The bounded-await helper must OBSERVE both outcomes of `p` — a rejecting `p` must not propagate nor
  // leave a discarded derived promise that Node reports as unhandled (the `void p.finally()` trap).
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    const rejecting = Promise.reject(new Error("dispose/log boom"));
    // Resolves via observing p's rejection (not via the timeout) and does not throw.
    await awaitBounded(rejecting, 10_000);
    await new Promise((r) => setTimeout(r, 30)); // give any stray rejection a tick to surface
    assert.equal(unhandled.length, 0, "no unhandledRejection from a rejecting bounded promise");
    // And the timeout path still works for a genuinely hung promise.
    const t0 = Date.now();
    await awaitBounded(new Promise(() => {}), 50);
    assert.ok(Date.now() - t0 >= 45, "the timeout path bounds a never-settling promise");
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

// --- issue #53: the operator-tier health surface --------------------------------------------------

const POOL_OK = { forceKillAvailable: true, unconfirmedCount: 0, orphanCount: 0, watchedCount: 0, activeCount: 1, reservedCount: 0, maxSessions: 2 };
const POOL_DEGRADED = { forceKillAvailable: false, unconfirmedCount: 1, orphanCount: 1, watchedCount: 1, activeCount: 2, reservedCount: 0, maxSessions: 2 };

test("#53: buildOperatorHealth derives ONE degraded verdict from the pool getters", async () => {
  const { buildOperatorHealth } = await import("../dist/mcp/http-server.js");
  assert.equal(buildOperatorHealth(POOL_OK).status, "ok");
  assert.equal(buildOperatorHealth({ ...POOL_OK, forceKillAvailable: false }).status, "degraded");
  assert.equal(buildOperatorHealth({ ...POOL_OK, unconfirmedCount: 1 }).status, "degraded");
  assert.equal(buildOperatorHealth({ ...POOL_OK, orphanCount: 1 }).status, "degraded");
  // watchedCount alone is informational — a pending wedge under sweep is normal transient state.
  assert.equal(buildOperatorHealth({ ...POOL_OK, watchedCount: 3 }).status, "ok");
  // pool-at-capacity alone is not degradation (back-pressure is working as designed).
  assert.equal(buildOperatorHealth({ ...POOL_OK, activeCount: 2 }).status, "ok");
});

test("#53: the operator token gets the counters; a consumer token gets the bare liveness body", async () => {
  const { buildOperatorHealth } = await import("../dist/mcp/http-server.js");
  const { deps } = makeDeps({
    healthToken: "op-secret",
    operatorHealth: () => buildOperatorHealth(POOL_DEGRADED),
  });
  const handler = createHttpHandler(deps);
  const { server, url } = await startServer(handler);
  try {
    const op = await fetch(new URL("/health", url.origin), { headers: { Authorization: "Bearer op-secret" } });
    assert.equal(op.status, 200);
    const opBody = await op.json();
    assert.equal(opBody.status, "degraded");
    assert.equal(opBody.forceKillAvailable, false);
    assert.equal(opBody.unconfirmedCount, 1);
    assert.equal(opBody.orphanCount, 1);
    assert.equal(opBody.activeCount, 2);

    const consumer = await fetch(new URL("/health", url.origin), { headers: { Authorization: "Bearer tok-alice" } });
    assert.equal(consumer.status, 200);
    assert.deepEqual(await consumer.json(), { status: "ok" }, "pool internals never reach a consumer token");

    const bad = await fetch(new URL("/health", url.origin), { headers: { Authorization: "Bearer nope" } });
    assert.equal(bad.status, 401, "an unknown bearer stays 401 with the operator tier configured");
  } finally {
    await new Promise((r) => server.close(r));
    server.closeAllConnections?.();
  }
});

test("#53: the operator health token authenticates NOTHING but /health (never the MCP routes)", async () => {
  const { buildOperatorHealth } = await import("../dist/mcp/http-server.js");
  const { deps } = makeDeps({ healthToken: "op-secret", operatorHealth: () => buildOperatorHealth(POOL_OK) });
  const handler = createHttpHandler(deps);
  const { server, url } = await startServer(handler);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: "Bearer op-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } }, id: 1 }),
    });
    assert.equal(res.status, 401, "the health token must never open an MCP session");
    assert.equal(handler.sessionCount(), 0);
  } finally {
    await new Promise((r) => server.close(r));
    server.closeAllConnections?.();
  }
});

test("#53: a rebind Host is refused BEFORE any token tier (operator token included)", async () => {
  const { buildOperatorHealth } = await import("../dist/mcp/http-server.js");
  const { deps } = makeDeps({
    allowedHosts: ["gw.allowed:8080"],
    healthToken: "op-secret",
    operatorHealth: () => buildOperatorHealth(POOL_OK),
  });
  const handler = createHttpHandler(deps);
  const { server, url } = await startServer(handler);
  try {
    const rebind = await rawGet(url.port, "/health", { Host: "evil.rebind:8080", Authorization: "Bearer op-secret" });
    assert.equal(rebind.status, 403, "pool internals must never cross a rebound Host");
    const ok = await rawGet(url.port, "/health", { Host: "gw.allowed:8080", Authorization: "Bearer op-secret" });
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.body).forceKillAvailable, true);
  } finally {
    await new Promise((r) => server.close(r));
    server.closeAllConnections?.();
  }
});

test("#53: an EMPTY configured health token never matches (no accidental open tier)", async () => {
  const { buildOperatorHealth } = await import("../dist/mcp/http-server.js");
  const { deps } = makeDeps({ healthToken: "", operatorHealth: () => buildOperatorHealth(POOL_DEGRADED) });
  const handler = createHttpHandler(deps);
  const { server, url } = await startServer(handler);
  try {
    const none = await fetch(new URL("/health", url.origin), { headers: { Authorization: "Bearer " } });
    assert.equal(none.status, 401, "an empty bearer against an empty token is refused, not matched");
  } finally {
    await new Promise((r) => server.close(r));
    server.closeAllConnections?.();
  }
});
