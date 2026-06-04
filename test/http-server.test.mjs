/**
 * U7a HTTP surface tests — drive the shared service over a REAL loopback socket with a real MCP
 * StreamableHTTP client, an injected fake retrieve/drive (no browser), and a real PolicyEngine.
 * Covers: a consumer round-trip, 401 on a bad bearer, per-session consumer binding (a foreign token
 * can't drive another's session), idle-MCP reaping on disconnect-without-DELETE (C1), and DNS-rebind
 * rejection. The real-browser end-to-end is scripts/validate-http.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpHandler, createGatewayMcpServer } from "../dist/mcp/index.js";
import { PolicyEngine, ConsumerRegistry } from "../dist/policy/index.js";

const outcome = (over = {}) => ({ markdown: "# T\n\nbody", title: "T", status: 200, blocked: false, degraded: false, proxyUsed: false, ...over });

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
