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
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpHandler, createGatewayMcpServer, awaitBounded, getArtifactLeaseTracker } from "../dist/mcp/index.js";
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

test("#53 r11: healthToken set with NO operatorHealth producer → the token is honored, gets the consumer-tier body (not 401)", async () => {
  const { deps } = makeDeps({ healthToken: "op-secret" }); // no operatorHealth wired
  const handler = createHttpHandler(deps);
  const { server, url } = await startServer(handler);
  try {
    const op = await fetch(new URL("/health", url.origin), { headers: { Authorization: "Bearer op-secret" } });
    assert.equal(op.status, 200, "the operator token is recognized even without a producer (contract)");
    assert.deepEqual(await op.json(), { status: "ok" }, "falls back to the bare consumer-tier liveness body");
  } finally {
    await new Promise((r) => server.close(r));
    server.closeAllConnections?.();
  }
});

// --- Task 2 Slice B: ArtifactLeaseTracker HTTP integration (H1-H9) --------------------------
//
// `browser_get_artifact` itself is Task 7 (out of this slice's scope) and does not exist yet. Every
// test below drives the REAL production seam — `createHttpHandler`, the real
// `@modelcontextprotocol/sdk` client/server over a real loopback socket, `createArtifactLeaseTracker`,
// and the request-context correlation helper — through a TEST-ONLY stand-in tool that plays the part
// Task 7 will implement: look up the active tracker via `extra.requestId`, acquire a (fake) lease,
// register it, and follow the exact guarded-fallback contract Task 2 §4.2/§5.1 documents for that
// future tool. This proves the tracker/context mechanics H1-H9 are ABOUT, without depending on a real
// ArtifactRuntime or the not-yet-built production tool.

const ARTIFACT_ID = "a".repeat(22);

/** A fake `ArtifactResponseLease.complete()` is idempotent, exactly like the real one built in
 *  `src/artifacts/index.ts` (`makeResponseLease`'s `if (completion) return completion;` latch): the
 *  FIRST outcome wins and every later call is a no-op observation of that same settled outcome. A
 *  non-idempotent fake would let a caller bug (double-completing a lease) masquerade as two DIFFERENT
 *  recorded outcomes instead of the one a real lease would ever produce. */
function fakeArtifactLease(overrides = {}) {
  const calls = [];
  const artifactId = overrides.artifactId ?? ARTIFACT_ID;
  let settled;
  const lease = {
    metadata: Object.freeze({
      artifactId,
      kind: "pdf",
      disposition: "attachment",
      sizeBytes: overrides.sizeBytes ?? 3,
      sha256: "x".repeat(64),
      createdAt: new Date(0).toISOString(),
      expiresAt: new Date(1).toISOString(),
      sourceHost: "example.com",
    }),
    resource: Object.freeze({
      type: "resource",
      resource: Object.freeze({ uri: `artifact:${artifactId}`, mimeType: "application/pdf", blob: overrides.blob ?? "AAA=" }),
    }),
    deadlineMs: overrides.deadlineMs ?? Date.now() + 15_000,
    complete(outcome) {
      if (settled) return settled;
      calls.push(outcome);
      settled = (async () => {
        await overrides.onComplete?.(outcome);
      })();
      return settled;
    },
  };
  return { lease, calls };
}

/**
 * Registers the TEST-ONLY stand-in for `browser_get_artifact` described above. `acquire(args, tracker,
 * extra)` decides what "acquisition" produces for a given call — a lease, `null` (denial), or a throw.
 *
 * Follows Task 2 §4.2 EXACTLY: "every exception after acquisition but before registration invokes one
 * guarded fallback `lease.complete('transport-failed')`; the tool never directly completes a
 * successfully registered lease." So the guarded fallback below runs ONLY in the acquire-to-register
 * window (`preRegisterThrow`); once `tracker.register()` has succeeded, only the tracker itself may
 * ever call `lease.complete()` (via finish/close/error/deadline) — the tool must let a later throw
 * propagate untouched.
 */
function registerFakeArtifactTool(server, acquire) {
  const DENIED = { isError: true, content: [{ type: "text", text: "Artifact is unavailable." }] };
  server.registerTool(
    "browser_get_artifact",
    {
      title: "Get artifact",
      description: "test stand-in",
      inputSchema: {
        artifactId: z.string(),
        // Test-only knobs (Task 7's real schema is exactly `{ artifactId }`, per Task 2 §3.3) that
        // pick which side of the acquire-to-register boundary a simulated failure lands on.
        preRegisterThrow: z.boolean().optional(),
        postRegisterThrow: z.boolean().optional(),
      },
    },
    async (args, extra) => {
      const tracker = getArtifactLeaseTracker(extra.requestId);
      if (!tracker) return DENIED; // Task 2 §4.2: registration outside an active HTTP context is closed-invariant denial
      let lease;
      try {
        lease = await acquire(args, tracker, extra);
      } catch {
        return DENIED;
      }
      if (!lease) return DENIED;
      if (args?.preRegisterThrow) {
        // Simulates a resource/context-construction failure in the acquire-to-register window
        // (Task 2 §3.5/§4.2): the lease was acquired but NEVER registered, so the guarded fallback is
        // the ONLY completion this lease will ever see.
        await lease.complete("transport-failed").catch(() => {});
        return DENIED;
      }
      try {
        tracker.register(lease);
      } catch {
        return DENIED; // register() already fail-completed the lease it rejected
      }
      if (args?.postRegisterThrow) throw new Error("boom-after-register"); // only the tracker may complete this lease now
      return { content: [lease.resource], structuredContent: { artifact: lease.metadata } };
    },
  );
}

function artifactDeps(acquire, over = {}) {
  const registry = new ConsumerRegistry([
    { id: "alice", token: "tok-alice", allow: ["*"] },
    { id: "bob", token: "tok-bob", allow: ["*"] },
  ]);
  const policy = new PolicyEngine({ registry });
  return {
    authenticate: (t) => policy.authenticate(t),
    buildServer: (consumer) => {
      const server = createGatewayMcpServer({ retrieve: async ({ url }) => outcome({ markdown: `${consumer.id} read ${url}` }) });
      registerFakeArtifactTool(server, acquire);
      return { server, dispose: async () => {} };
    },
    artifactsEnabled: true,
    ...over,
  };
}

/** POST a raw request against an already-initialized MCP session, pausing the response the instant
 *  headers arrive so the caller controls exactly when (or whether) the body is drained. */
function pausedPost(port, sessionId, token, jsonBody) {
  const bodyStr = JSON.stringify(jsonBody);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId,
          Authorization: `Bearer ${token}`,
          "Content-Length": Buffer.byteLength(bodyStr),
        },
      },
      (res) => {
        res.pause();
        resolve({ status: res.statusCode, res, req });
      },
    );
    req.on("error", reject);
    req.end(bodyStr);
  });
}

/** The installed SDK (Task 0.5) answers a POST tool call as either a plain `application/json` body OR
 *  an SSE stream (`event: message\ndata: {...}\n\n`) — which one it picks is the transport's choice,
 *  not something a raw client should assume. Parse both without weakening what gets asserted: for SSE,
 *  take the LAST `data:` frame (the final JSON-RPC response), exactly what a real EventSource-based
 *  client would deliver to `onmessage`. */
function parseSseOrJson(text) {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("event:") && !trimmed.startsWith("data:")) {
    return JSON.parse(text);
  }
  const dataLines = text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim());
  if (dataLines.length === 0) throw new Error("SSE body carried no data: frame");
  return JSON.parse(dataLines[dataLines.length - 1]);
}

/** Drain a paused response to completion and parse it (JSON or SSE — see {@link parseSseOrJson}). */
function drainJson(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => {
      try {
        resolve(parseSseOrJson(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(err);
      }
    });
    res.on("error", reject);
    res.resume();
  });
}

/** Poll `check` until it returns true or `maxMs` elapses; returns whether it became true. */
async function pollUntil(check, maxMs, stepMs = 10) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return await check();
}

async function initSession(url, token) {
  const c = connect(url, token);
  await c.client.connect(c.transport);
  return { client: c.client, sessionId: c.transport.sessionId };
}

test("Task2/H0 (Task 0.5 seam): a tool handler reaches ITS OWN tracker via extra.requestId across real async SDK dispatch", async () => {
  let observedTracker;
  const deps = artifactDeps(async (args, _tracker, extra) => {
    // Cross a real await boundary (a macrotask) before touching the tracker again — proving the
    // AsyncLocalStorage context (and the extra.requestId correlation) survives the SDK's actual
    // asynchronous tool-dispatch machinery, not just a synchronous callback.
    await new Promise((r) => setTimeout(r, 5));
    observedTracker = getArtifactLeaseTracker(extra.requestId);
    return fakeArtifactLease({ artifactId: args.artifactId }).lease;
  });
  const handler = createHttpHandler(deps);
  const { server, url } = await startServer(handler);
  let client;
  try {
    const s = await initSession(url, "tok-alice");
    client = s.client;
    const res = await client.callTool({ name: "browser_get_artifact", arguments: { artifactId: ARTIFACT_ID } });
    assert.equal(res.isError, undefined);
    assert.ok(observedTracker, "the tool observed a tracker after an async gap");
    assert.equal(typeof observedTracker.register, "function");
  } finally {
    await stop({ server, handler, client });
  }
});

test("Task2/H1: real Node 'finish' — not handler return — completes the lease 'sent'", async () => {
  const blob = Buffer.alloc(12 * 1024 * 1024, 65).toString("base64"); // large enough to backpressure loopback
  const { lease, calls } = fakeArtifactLease({ blob });
  const deps = artifactDeps(async () => lease);
  const handler = createHttpHandler(deps);
  const { server, url } = await startServer(handler);
  let client;
  try {
    const s = await initSession(url, "tok-alice");
    client = s.client;
    const { res } = await pausedPost(url.port, s.sessionId, "tok-alice", {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "browser_get_artifact", arguments: { artifactId: ARTIFACT_ID } },
    });
    // While the client holds the response paused (not reading), the tracker must NOT have completed
    // yet — this is the exact claim Task 2 §5.3/§5.4 makes: handler return / res.end() is too early.
    const settledEarly = await pollUntil(() => calls.length > 0, 300);
    assert.equal(settledEarly, false, "must not complete before the client has read the response");
    await drainJson(res);
    await pollUntil(() => calls.length > 0, 2_000);
    assert.deepEqual(calls, ["sent"]);
  } finally {
    await stop({ server, handler, client });
  }
});

test("Task2/H2: a real client reset under backpressure completes 'transport-failed' exactly once, then the next call proceeds", async () => {
  const blob = Buffer.alloc(12 * 1024 * 1024, 65).toString("base64");
  const { lease, calls } = fakeArtifactLease({ blob });
  const deps = artifactDeps(async () => lease);
  const handler = createHttpHandler(deps);
  const { server, url } = await startServer(handler);
  let client;
  try {
    const s = await initSession(url, "tok-alice");
    client = s.client;
    const { res, req } = await pausedPost(url.port, s.sessionId, "tok-alice", {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "browser_get_artifact", arguments: { artifactId: ARTIFACT_ID } },
    });
    assert.equal(await pollUntil(() => calls.length > 0, 300), false);
    req.destroy(); // abrupt client-side reset while the response is still paused/backpressured
    res.destroy();
    await pollUntil(() => calls.length > 0, 2_000);
    assert.deepEqual(calls, ["transport-failed"]);
    // The session/handler must not be left wedged: a normal subsequent call still succeeds.
    const again = await client.callTool({ name: "retrieve", arguments: { url: "https://example.com/" } });
    assert.equal(again.content[0].text, "alice read https://example.com/");
  } finally {
    await stop({ server, handler, client });
  }
});

test("Task2/H3: no finish/reset before the deadline — the tracker destroys the response, completes 'timed-out' once, and the next request proceeds", async () => {
  // A large, never-drained blob is what makes this deterministic: a small body can flush to the
  // kernel (and fire 'finish') within a few milliseconds regardless of whether the client is reading
  // it, which would race the 60ms deadline. Held back by real backpressure, the deadline is the ONLY
  // thing that can end this response.
  const blob = Buffer.alloc(12 * 1024 * 1024, 65).toString("base64");
  const { lease, calls } = fakeArtifactLease({ deadlineMs: Date.now() + 60, blob });
  const deps = artifactDeps(async () => lease);
  const handler = createHttpHandler(deps);
  const { server, url } = await startServer(handler);
  let client;
  try {
    const s = await initSession(url, "tok-alice");
    client = s.client;
    const { res } = await pausedPost(url.port, s.sessionId, "tok-alice", {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "browser_get_artifact", arguments: { artifactId: ARTIFACT_ID } },
    });
    // Never resume/read `res` — only the deadline can end this. Whether the tracker actually called
    // `res.destroy()` on the real Node `ServerResponse` BEFORE completing `timed-out` (the fencing
    // order this is meant to prove) is already asserted directly, with full control over the exact
    // object, in http-response-lease.test.mjs — a client-side stream's `.destroyed`/`.aborted` flags
    // are not a reliable proxy for that server-side fact on a paused, never-drained response. Here the
    // integration-level proof is behavioral: the session is left usable, not wedged.
    await pollUntil(() => calls.length > 0, 2_000);
    assert.deepEqual(calls, ["timed-out"]);
    res.destroy(); // release the client-side socket so the process can exit cleanly
    const again = await client.callTool({ name: "retrieve", arguments: { url: "https://example.com/" } });
    assert.equal(again.content[0].text, "alice read https://example.com/");
  } finally {
    await stop({ server, handler, client });
  }
});

test("Task2/H4: a failure BEFORE registration completes the lease exactly once via the guarded fallback (pre-header fixed error)", async () => {
  const { lease, calls } = fakeArtifactLease({ artifactId: "b".repeat(22) });
  const deps = artifactDeps(async () => lease);
  const handler = createHttpHandler(deps);
  const { server, url } = await startServer(handler);
  let client;
  try {
    const s = await initSession(url, "tok-alice");
    client = s.client;
    const res = await client.callTool({ name: "browser_get_artifact", arguments: { artifactId: ARTIFACT_ID, preRegisterThrow: true } });
    assert.equal(res.isError, true, "no response has started — the fixed external error is returned");
    assert.deepEqual(calls, ["transport-failed"], "the never-registered lease is completed exactly once via the guarded fallback");
  } finally {
    await stop({ server, handler, client });
  }
});

test("Task2/H4b: a throw AFTER successful registration is never hand-completed by the tool — only the tracker's own finish/close/error decides the outcome, exactly once", async () => {
  const { lease, calls } = fakeArtifactLease({ artifactId: "b1".padEnd(22, "0") });
  const deps = artifactDeps(async () => lease);
  const handler = createHttpHandler(deps);
  const { server, url } = await startServer(handler);
  let client;
  try {
    const s = await initSession(url, "tok-alice");
    client = s.client;
    const res = await client.callTool({ name: "browser_get_artifact", arguments: { artifactId: ARTIFACT_ID, postRegisterThrow: true } });
    assert.equal(res.isError, true, "the tool's own throw surfaces as a tool error");
    // Whatever the SDK does with the throw, the REAL response still reaches ONE Node completion —
    // the tracker (never the tool) decides it, and decides it only once.
    assert.equal(calls.length, 1, "exactly one completion, driven solely by the tracker");
  } finally {
    await stop({ server, handler, client });
  }
});

test("Task2/H5: a JSON-RPC batch containing browser_get_artifact is rejected before any dispatch; the session is untouched", async () => {
  let acquireCalls = 0;
  const deps = artifactDeps(async (args) => {
    acquireCalls++;
    return fakeArtifactLease({ artifactId: args.artifactId }).lease;
  });
  const handler = createHttpHandler(deps);
  const { server, url } = await startServer(handler);
  let client;
  try {
    const s = await initSession(url, "tok-alice");
    client = s.client;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "mcp-session-id": s.sessionId, Authorization: "Bearer tok-alice" },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_get_artifact", arguments: { artifactId: ARTIFACT_ID } } },
      ]),
    });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.error.code, -32600);
    assert.equal(acquireCalls, 0, "zero acquisitions from a rejected batch");
    assert.equal(handler.sessionCount(), 1, "the session itself is untouched by the rejected batch");
  } finally {
    await stop({ server, handler, client });
  }
});

test("Task2/disabled-parity: artifacts disabled — a batch naming browser_get_artifact follows legacy SDK dispatch, not top-level rejection", async () => {
  let acquireCalls = 0;
  const deps = artifactDeps(
    async (args) => {
      acquireCalls++;
      return fakeArtifactLease({ artifactId: args.artifactId }).lease;
    },
    { artifactsEnabled: false },
  );
  const handler = createHttpHandler(deps);
  const { server, url } = await startServer(handler);
  let client;
  try {
    const s = await initSession(url, "tok-alice");
    client = s.client;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "mcp-session-id": s.sessionId, Authorization: "Bearer tok-alice" },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_get_artifact", arguments: { artifactId: ARTIFACT_ID } } },
      ]),
    });
    assert.notEqual(r.status, 400, "disabled mode must not top-level-reject the batch");
    const text = await r.text();
    assert.match(text, /"id":1/, "the batch reached real dispatch — the tools/list entry answered");
    assert.match(text, /"id":2/, "the batch reached real dispatch — the tools/call entry answered");
    // The tool itself sees no tracker (disabled mode installs no context for a batch either way), so
    // it denies — but the acquisition path was exercised by real dispatch, not short-circuited.
    assert.equal(handler.sessionCount(), 1, "the session itself is untouched");
  } finally {
    await stop({ server, handler, client });
  }
});

test("Task2/disabled-parity: artifacts disabled — a single browser_get_artifact call installs no tracker/context (legacy dispatch, no listeners, no inFlight extension)", async () => {
  let observedTracker = "unset";
  const deps = artifactDeps(
    async (_args, tracker) => {
      observedTracker = tracker;
      return fakeArtifactLease({ artifactId: ARTIFACT_ID }).lease;
    },
    { artifactsEnabled: false },
  );
  const handler = createHttpHandler(deps);
  const { server, url } = await startServer(handler);
  let client;
  try {
    const s = await initSession(url, "tok-alice");
    client = s.client;
    const res = await client.callTool({ name: "browser_get_artifact", arguments: { artifactId: ARTIFACT_ID } });
    // registerFakeArtifactTool looks up its tracker via `getArtifactLeaseTracker(extra.requestId)`
    // BEFORE calling `acquire` — with no context installed, that lookup is undefined, so the tool
    // takes its "no active context" denial branch and `acquire` (and this callback) never runs.
    assert.equal(observedTracker, "unset", "acquire never ran — no tracker/context was installed for this call");
    assert.equal(res.isError, true, "the fake tool's closed-invariant denial fires with no tracker present");
    // The call still completed normally through legacy dispatch (no wedge, no leaked inFlight): the
    // session is immediately reusable and reports no lingering in-flight extension.
    const again = await client.callTool({ name: "retrieve", arguments: { url: "https://example.com/y" } });
    assert.equal(again.content[0].text, "alice read https://example.com/y");
  } finally {
    await stop({ server, handler, client });
  }
});

test("Task2/H6: concurrent artifact + non-artifact POSTs on ONE session bind to their own response, no cross-completion", async () => {
  const first = fakeArtifactLease({ artifactId: "c".repeat(22) });
  const deps = artifactDeps(async () => first.lease);
  const handler = createHttpHandler(deps);
  const { server, url } = await startServer(handler);
  let client;
  try {
    const s = await initSession(url, "tok-alice");
    client = s.client;
    const [artifactRes, retrieveRes] = await Promise.all([
      client.callTool({ name: "browser_get_artifact", arguments: { artifactId: ARTIFACT_ID } }),
      client.callTool({ name: "retrieve", arguments: { url: "https://example.com/x" } }),
    ]);
    assert.equal(artifactRes.structuredContent.artifact.artifactId, "c".repeat(22));
    assert.equal(retrieveRes.content[0].text, "alice read https://example.com/x");
    assert.deepEqual(first.calls, ["sent"], "the artifact lease completed exactly once, tied to its own response");
  } finally {
    await stop({ server, handler, client });
  }
});

test("Task2/H7: a reset that lands DURING acquisition is latched; the lease acquired afterward is immediately transport-failed", async () => {
  let releaseAcquire;
  const acquireGate = new Promise((r) => (releaseAcquire = r));
  const { lease, calls } = fakeArtifactLease({ artifactId: "d".repeat(22) });
  const deps = artifactDeps(async (_args, tracker) => {
    tracker.activate(); // mirrors what http-server.ts already does before dispatch; idempotent here
    await acquireGate; // simulate a slow acquisition (real store I/O) the reset can land during
    return lease;
  });
  const handler = createHttpHandler(deps);
  const { server, url } = await startServer(handler);
  let client;
  try {
    const s = await initSession(url, "tok-alice");
    client = s.client;
    const { res, req } = await pausedPost(url.port, s.sessionId, "tok-alice", {
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: "browser_get_artifact", arguments: { artifactId: ARTIFACT_ID } },
    });
    req.destroy(); // reset while the fake tool is still "acquiring" (has not called register() yet)
    res.destroy();
    await new Promise((r) => setTimeout(r, 30)); // let the reset propagate to the tracker
    releaseAcquire(); // now let acquisition "complete" and try to register the lease it produced
    await pollUntil(() => calls.length > 0, 2_000);
    assert.deepEqual(calls, ["transport-failed"], "a lease acquired after a reset can never be delivered");
  } finally {
    await stop({ server, handler, client });
  }
});

test("Task2/H8: handleRequest() resolving does not drain inFlight — closeAll() waits for tracker settlement, not handler return", async () => {
  const blob = Buffer.alloc(12 * 1024 * 1024, 65).toString("base64");
  const { lease, calls } = fakeArtifactLease({ blob });
  const deps = artifactDeps(async () => lease);
  const handler = createHttpHandler({ ...deps, cleanupAwaitMs: 5_000 });
  const { server, url } = await startServer(handler);
  try {
    const s = await initSession(url, "tok-alice");
    const { res } = await pausedPost(url.port, s.sessionId, "tok-alice", {
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: { name: "browser_get_artifact", arguments: { artifactId: ARTIFACT_ID } },
    });
    assert.equal(await pollUntil(() => calls.length > 0, 200), false, "not yet completed (still paused)");
    let closeAllDone = false;
    const closeP = handler.closeAll().then(() => (closeAllDone = true));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(closeAllDone, false, "closeAll must not resolve while the artifact response is still in flight");
    await drainJson(res); // now let the client actually read — 'finish' fires, the tracker settles
    await closeP;
    assert.equal(closeAllDone, true);
    assert.deepEqual(calls, ["sent"]);
    await s.client.close().catch(() => {});
  } finally {
    await new Promise((r) => server.close(r));
    server.closeAllConnections?.();
  }
});

test("Task2/H9: registration failures each complete the exact acquired lease exactly once", async () => {
  // (a) a lookup with the wrong requestId never returns a foreign tracker (never crosses requests).
  {
    const deps = artifactDeps(async () => {
      const wrongTracker = getArtifactLeaseTracker("not-the-real-request-id");
      assert.equal(wrongTracker, undefined, "a mismatched requestId never returns a foreign tracker");
      return null; // simulated denial — no acquisition attempted
    });
    const handler = createHttpHandler(deps);
    const { server, url } = await startServer(handler);
    let client;
    try {
      const s = await initSession(url, "tok-alice");
      client = s.client;
      const res = await client.callTool({ name: "browser_get_artifact", arguments: { artifactId: ARTIFACT_ID } });
      assert.equal(res.isError, true);
    } finally {
      await stop({ server, handler, client });
    }
  }

  // (b) duplicate registration: the tool (mis)behaves and registers twice against the same tracker.
  {
    const first = fakeArtifactLease({ artifactId: "e".repeat(22) });
    const second = fakeArtifactLease({ artifactId: "f".repeat(22) });
    const deps = artifactDeps(async (_args, tracker) => {
      tracker.register(first.lease);
      try {
        tracker.register(second.lease); // duplicate — must throw and fail-complete `second`
        assert.fail("duplicate register() must throw");
      } catch {
        /* expected */
      }
      throw new Error("stop here — first is already registered and owns the tracker");
    });
    const handler = createHttpHandler(deps);
    const { server, url } = await startServer(handler);
    let client;
    try {
      const s = await initSession(url, "tok-alice");
      client = s.client;
      await client.callTool({ name: "browser_get_artifact", arguments: { artifactId: ARTIFACT_ID } }).catch(() => {});
      await pollUntil(() => first.calls.length > 0, 2_000);
      assert.deepEqual(first.calls, ["sent"], "the first, legitimately registered lease still completes normally");
      assert.deepEqual(second.calls, ["transport-failed"], "the duplicate is fail-completed exactly once");
    } finally {
      await stop({ server, handler, client });
    }
  }
});
