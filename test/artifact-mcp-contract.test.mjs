/**
 * Task 2 Slice C1 — MCP contract tests for `browser_get_artifact` (Task 7) and the capture-outcome
 * projection at the retrieve/drive MCP boundary (Task 5).
 *
 * Two harnesses, chosen per what each test actually needs:
 *  - InMemoryTransport: fast, in-process. Used for schema/registration-gate/construction-time tests
 *    and for the retrieve/drive structuredContent projection tests — NONE of these need an active
 *    HTTP request tracker (Task 2 §5.1's `ArtifactLeaseTracker`), and InMemoryTransport never
 *    establishes one, which is itself the RED-by-construction proof that a call with no active HTTP
 *    context is denied.
 *  - A real loopback `createHttpHandler` + `StreamableHTTPClientTransport`: used for every test that
 *    needs `deps.artifacts.consumeForServer` to actually run — success shape, denial collapse, the
 *    guarded acquire/register order, and the identity-immutability proof — because only the real HTTP
 *    seam correlates a tool's `extra.requestId` to an active tracker (Task 2 §5.1/§5.4, already proven
 *    at the tracker level in test/http-server.test.mjs's Slice B "Task2/H*" tests via a test-only
 *    stand-in tool). This file exercises the REAL tool built into `createGatewayMcpServer`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createGatewayMcpServer, createHttpHandler } from "../dist/mcp/index.js";
import { PolicyEngine, ConsumerRegistry } from "../dist/policy/index.js";

const ARTIFACT_ID = "a".repeat(22);

const retrieveOutcome = (over = {}) => ({
  markdown: "# T\n\nbody",
  title: "T",
  status: 200,
  blocked: false,
  reason: null,
  degraded: false,
  proxyUsed: false,
  captchaSolved: false,
  ...over,
});

function fakeMetadata(over = {}) {
  return Object.freeze({
    artifactId: over.artifactId ?? ARTIFACT_ID,
    kind: "pdf",
    disposition: "attachment",
    sizeBytes: over.sizeBytes ?? 3,
    sha256: "x".repeat(64),
    createdAt: new Date(0).toISOString(),
    expiresAt: new Date(1e12).toISOString(),
    sourceHost: "example.com",
  });
}

/** Same idempotent-completion shape as http-server.test.mjs's `fakeArtifactLease` (Slice B) — the
 *  FIRST outcome wins, matching the real lease's `makeResponseLease` latch. */
function fakeLease(over = {}) {
  const calls = [];
  const artifactId = over.artifactId ?? ARTIFACT_ID;
  let settled;
  const lease = {
    metadata: over.metadata ?? fakeMetadata({ artifactId }),
    resource: Object.freeze({
      type: "resource",
      resource: Object.freeze({ uri: `artifact:${artifactId}`, mimeType: "application/pdf", blob: over.blob ?? "AAA=" }),
    }),
    deadlineMs: over.deadlineMs ?? Date.now() + 15_000,
    complete(outcome) {
      if (settled) return settled;
      calls.push(outcome);
      settled = Promise.resolve();
      return settled;
    },
  };
  return { lease, calls };
}

function minimalDrive(over = {}) {
  const snap = (url) => ({ url: url ?? "https://example.com/", title: "T", tree: "tree" });
  return {
    async open() {},
    async navigate(url) { return snap(url); },
    async snapshot() { return snap(); },
    async click() { return snap(); },
    async type() { return snap(); },
    async selectOption() { return snap(); },
    async pressKey() { return snap(); },
    async waitFor() { return snap(); },
    async screenshot() { return "AAA="; },
    async close() {},
    ...over,
  };
}

// --- InMemoryTransport: no active HTTP request tracker is ever established -----------------------

async function connectInMemory(deps) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createGatewayMcpServer(deps);
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

/** True iff a tool call errored, whether the SDK surfaced it as a thrown protocol error or an
 *  `isError` result (mirrors the existing "invalid arguments" pattern in mcp-surface.test.mjs). */
async function callErrors(client, params) {
  try {
    const res = await client.callTool(params);
    return res.isError === true;
  } catch {
    return true;
  }
}

// --- Registration gate (C1) -----------------------------------------------------------------------

test("C1: browser_get_artifact is absent when deps.artifacts is not supplied", async () => {
  const client = await connectInMemory({ retrieve: async () => retrieveOutcome() });
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(!names.includes("browser_get_artifact"));
});

test("C1: browser_get_artifact is registered exactly once when deps.artifacts is supplied", async () => {
  const client = await connectInMemory({
    retrieve: async () => retrieveOutcome(),
    artifacts: { consumerId: "alice", consumeForServer: async () => { throw new Error("unused"); } },
  });
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.equal(names.filter((n) => n === "browser_get_artifact").length, 1);
});

// --- Input schema (C2) ------------------------------------------------------------------------

test("C2: a non-string artifactId fails MCP schema validation; consumeForServer is never invoked", async () => {
  let called = false;
  const client = await connectInMemory({
    retrieve: async () => retrieveOutcome(),
    artifacts: { consumerId: "alice", consumeForServer: async () => { called = true; throw new Error("denied"); } },
  });
  const errored = await callErrors(client, { name: "browser_get_artifact", arguments: { artifactId: 12345 } });
  assert.equal(errored, true);
  assert.equal(called, false);
});

test("C2: extra fields fail MCP schema validation (strict shape); consumeForServer is never invoked", async () => {
  let called = false;
  const client = await connectInMemory({
    retrieve: async () => retrieveOutcome(),
    artifacts: { consumerId: "alice", consumeForServer: async () => { called = true; throw new Error("denied"); } },
  });
  const errored = await callErrors(client, {
    name: "browser_get_artifact",
    arguments: { artifactId: ARTIFACT_ID, controllerId: "sneak-in", path: "/etc/passwd" },
  });
  assert.equal(errored, true);
  assert.equal(called, false);
});

// --- Registration-outside-active-context denial, and the collapsed literal (§3.5) -----------------

test("no active HTTP request context: browser_get_artifact returns the fixed denial and never calls consumeForServer", async () => {
  let called = false;
  const client = await connectInMemory({
    retrieve: async () => retrieveOutcome(),
    artifacts: { consumerId: "alice", consumeForServer: async () => { called = true; throw new Error("should not run"); } },
  });
  const res = await client.callTool({ name: "browser_get_artifact", arguments: { artifactId: ARTIFACT_ID } });
  assert.equal(res.isError, true);
  assert.deepEqual(res.content, [{ type: "text", text: "Artifact is unavailable." }]);
  assert.equal(res.structuredContent, undefined);
  assert.equal(called, false);
});

// --- Construction-time identity validation (§4.2) --------------------------------------------------

test("construction: artifacts.consumerId must be a non-empty string", () => {
  assert.throws(() =>
    createGatewayMcpServer({
      retrieve: async () => retrieveOutcome(),
      artifacts: { consumerId: "", consumeForServer: async () => { throw new Error(); } },
    }),
  );
});

test("construction: artifacts.controllerId is required when drive and artifacts coexist", () => {
  assert.throws(() =>
    createGatewayMcpServer({
      retrieve: async () => retrieveOutcome(),
      drive: minimalDrive(),
      artifacts: { consumerId: "alice", consumeForServer: async () => { throw new Error(); } },
    }),
  );
});

test("construction: artifacts.controllerId is optional when drive is absent", () => {
  assert.doesNotThrow(() =>
    createGatewayMcpServer({
      retrieve: async () => retrieveOutcome(),
      artifacts: { consumerId: "alice", consumeForServer: async () => { throw new Error(); } },
    }),
  );
});

test("construction: consumerId/consumeForServer are each read exactly once from deps.artifacts (hostile stateful getters)", () => {
  let consumerReads = 0;
  let consumeForServerReads = 0;
  const artifacts = {
    get consumerId() {
      consumerReads++;
      if (consumerReads > 1) throw new Error("read twice");
      return "alice";
    },
    get consumeForServer() {
      consumeForServerReads++;
      if (consumeForServerReads > 1) throw new Error("read twice");
      return async () => { throw new Error("denied"); };
    },
  };
  assert.doesNotThrow(() => createGatewayMcpServer({ retrieve: async () => retrieveOutcome(), artifacts }));
  assert.equal(consumerReads, 1);
  assert.equal(consumeForServerReads, 1);
});

// --- HTTP loopback: everything that needs a real, active ArtifactLeaseTracker ----------------------

function httpArtifactDeps(consumeForServer, artifactsOver = {}) {
  const registry = new ConsumerRegistry([{ id: "alice", token: "tok-alice", allow: ["*"] }]);
  const policy = new PolicyEngine({ registry });
  return {
    authenticate: (t) => policy.authenticate(t),
    buildServer: (consumer) => {
      const server = createGatewayMcpServer({
        retrieve: async ({ url }) => retrieveOutcome({ markdown: `${consumer.id} read ${url}` }),
        artifacts: { consumerId: consumer.id, consumeForServer, ...artifactsOver },
      });
      return { server, dispose: async () => {} };
    },
    artifactsEnabled: true,
  };
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

function connectHttp(url, token) {
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  const client = new Client({ name: "test", version: "1.0.0" });
  return { client, transport };
}

async function stop({ server, handler, client }) {
  if (client) await client.close().catch(() => {});
  await handler.closeAll().catch(() => {});
  await new Promise((r) => server.close(r));
  server.closeAllConnections?.();
}

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

async function pollUntil(check, maxMs, stepMs = 10) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return await check();
}

async function initSession(url, token) {
  const c = connectHttp(url, token);
  await c.client.connect(c.transport);
  return { client: c.client, sessionId: c.transport.sessionId };
}

test("HTTP/C3: success returns exactly one application/pdf embedded resource + exact metadata, no extra fields", async () => {
  const blob = Buffer.from("hello").toString("base64");
  const { lease } = fakeLease({ blob });
  const deps = httpArtifactDeps(async (input) => {
    assert.equal(input.artifactId, ARTIFACT_ID);
    assert.equal(input.consumerId, "alice");
    return lease;
  });
  const handler = createHttpHandler(deps);
  const { server, url } = await startServer(handler);
  let client;
  try {
    const s = await initSession(url, "tok-alice");
    client = s.client;
    const res = await client.callTool({ name: "browser_get_artifact", arguments: { artifactId: ARTIFACT_ID } });
    assert.equal(res.isError ?? false, false);
    assert.equal(res.content.length, 1);
    assert.equal(res.content[0].type, "resource");
    assert.equal(res.content[0].resource.uri, `artifact:${ARTIFACT_ID}`);
    assert.equal(res.content[0].resource.mimeType, "application/pdf");
    assert.equal(res.content[0].resource.blob, blob);
    assert.deepEqual(Object.keys(res.structuredContent), ["artifact"]);
    assert.deepEqual(res.structuredContent.artifact, lease.metadata);
  } finally {
    await stop({ server, handler, client });
  }
});

test("HTTP: every runtime denial — however it is spelled — collapses to the byte-identical fixed literal", async () => {
  let nextDenial;
  const deps = httpArtifactDeps(async () => { throw nextDenial; });
  const handler = createHttpHandler(deps);
  const { server, url } = await startServer(handler);
  let client;
  try {
    const s = await initSession(url, "tok-alice");
    client = s.client;
    const denials = [
      new Error("artifact-not-found"),
      new Error("artifact-owner-mismatch"),
      new Error("artifact-rate-limited"),
      { code: "artifact-config-invalid" },
      "not-even-an-error",
    ];
    let refContent, refMeta;
    for (const denial of denials) {
      nextDenial = denial;
      const res = await client.callTool({ name: "browser_get_artifact", arguments: { artifactId: ARTIFACT_ID } });
      assert.equal(res.isError, true);
      assert.equal(res.structuredContent, undefined);
      const content = JSON.stringify(res.content);
      const meta = JSON.stringify(res._meta);
      if (refContent === undefined) {
        refContent = content;
        refMeta = meta;
        assert.deepEqual(res.content, [{ type: "text", text: "Artifact is unavailable." }]);
      } else {
        assert.equal(content, refContent, "denial body must be byte-identical across every denial reason");
        assert.equal(meta, refMeta, "denial _meta must be byte-identical across every denial reason");
      }
    }
  } finally {
    await stop({ server, handler, client });
  }
});

test("HTTP guarded order: a reset landing during acquisition means register() itself denies; the lease is fail-completed exactly once", async () => {
  let releaseAcquire;
  const acquireGate = new Promise((r) => (releaseAcquire = r));
  const { lease, calls } = fakeLease({ artifactId: "d".repeat(22) });
  const deps = httpArtifactDeps(async () => {
    await acquireGate; // simulate slow acquisition the reset can land during
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
      params: { name: "browser_get_artifact", arguments: { artifactId: "d".repeat(22) } },
    });
    req.destroy(); // reset while the real tool is still awaiting consumeForServer, before register()
    res.destroy();
    await new Promise((r) => setTimeout(r, 30)); // let the reset propagate to the tracker
    releaseAcquire(); // now the tool calls tracker.register(lease) against an already-terminal tracker
    await pollUntil(() => calls.length > 0, 2_000);
    assert.deepEqual(calls, ["transport-failed"], "a lease acquired after a reset can never be delivered, and completes exactly once");
  } finally {
    await stop({ server, handler, client });
  }
});

test("C6 (HTTP): a mutable deps.artifacts object cannot retarget the identity after server construction", async () => {
  const seen = [];
  let currentConsumerId = "alice";
  const artifacts = {
    get consumerId() { return currentConsumerId; }, // stateful/hostile getter
    consumeForServer: async (input) => {
      seen.push(input);
      return fakeLease().lease;
    },
  };
  const registry = new ConsumerRegistry([{ id: "alice", token: "tok-alice", allow: ["*"] }]);
  const policy = new PolicyEngine({ registry });
  const deps = {
    authenticate: (t) => policy.authenticate(t),
    buildServer: (consumer) => {
      const server = createGatewayMcpServer({ retrieve: async () => retrieveOutcome(), artifacts });
      currentConsumerId = "mallory"; // mutate immediately after construction, before any call
      return { server, dispose: async () => {} };
    },
    artifactsEnabled: true,
  };
  const handler = createHttpHandler(deps);
  const { server, url } = await startServer(handler);
  let client;
  try {
    const s = await initSession(url, "tok-alice");
    client = s.client;
    await client.callTool({ name: "browser_get_artifact", arguments: { artifactId: ARTIFACT_ID } });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].consumerId, "alice", "a post-construction mutation of a stateful getter must not retarget the snapshotted identity");
  } finally {
    await stop({ server, handler, client });
  }
});

// --- Task 5: project existing retrieve/drive ArtifactOutcome into structuredContent ----------------

test("Task5/retrieve: an absent artifactOutcome preserves output byte-for-byte (disabled parity)", async () => {
  const client = await connectInMemory({ retrieve: async () => retrieveOutcome({ markdown: "hello" }) });
  const res = await client.callTool({ name: "retrieve", arguments: { url: "https://x/" } });
  assert.equal(res.isError ?? false, false);
  assert.equal(res.content[0].text, "hello");
  assert.equal(res.structuredContent, undefined);
});

test("Task5/retrieve: {outcome:'none'} preserves the existing success shape, no structuredContent added", async () => {
  const client = await connectInMemory({
    retrieve: async () => retrieveOutcome({ markdown: "hello", artifactOutcome: { outcome: "none" } }),
  });
  const res = await client.callTool({ name: "retrieve", arguments: { url: "https://x/" } });
  assert.equal(res.isError ?? false, false);
  assert.equal(res.content[0].text, "hello");
  assert.equal(res.structuredContent, undefined);
});

test("Task5/retrieve: {outcome:'available'} returns empty text + metadata, and is NOT an MCP error", async () => {
  const metadata = fakeMetadata();
  const client = await connectInMemory({
    retrieve: async () => retrieveOutcome({ markdown: "discarded", artifactOutcome: { outcome: "available", artifact: metadata } }),
  });
  const res = await client.callTool({ name: "retrieve", arguments: { url: "https://x/" } });
  assert.equal(res.isError ?? false, false);
  assert.equal(res.content[0].text, "");
  assert.deepEqual(res.structuredContent, { artifactOutcome: "available", artifact: metadata });
});

test("Task5/retrieve: {outcome:'capture-failed'} surfaces a sanitized in-band error with the closed failure code", async () => {
  const client = await connectInMemory({
    retrieve: async () => retrieveOutcome({ artifactOutcome: { outcome: "capture-failed", failure: "artifact-write-failed" } }),
  });
  const res = await client.callTool({ name: "retrieve", arguments: { url: "https://secret.example/path?token=abc" } });
  assert.equal(res.isError, true);
  assert.deepEqual(res.structuredContent, { artifactOutcome: "capture-failed", artifactFailure: "artifact-write-failed" });
  assert.doesNotMatch(res.content[0].text, /token=abc/);
});

test("Task5/retrieve: {outcome:'inline-pdf-unsupported'} surfaces the sanitized in-band error", async () => {
  const client = await connectInMemory({
    retrieve: async () => retrieveOutcome({ artifactOutcome: { outcome: "inline-pdf-unsupported", failure: "inline-pdf-unsupported" } }),
  });
  const res = await client.callTool({ name: "retrieve", arguments: { url: "https://x/" } });
  assert.equal(res.isError, true);
  assert.deepEqual(res.structuredContent, { artifactOutcome: "inline-pdf-unsupported", artifactFailure: "inline-pdf-unsupported" });
});

test("Task5/drive: an available artifactOutcome adds structuredContent; formatSnapshot text is unchanged", async () => {
  const metadata = fakeMetadata();
  const drive = minimalDrive({ navigate: async (url) => ({ url, title: "T", tree: "tree", artifactOutcome: { outcome: "available", artifact: metadata } }) });
  const client = await connectInMemory({ retrieve: async () => retrieveOutcome(), drive });
  const res = await client.callTool({ name: "browser_navigate", arguments: { url: "https://x/" } });
  assert.equal(res.isError ?? false, false);
  assert.match(res.content[0].text, /^url: https:\/\/x\//);
  assert.deepEqual(res.structuredContent, { artifactOutcome: "available", artifact: metadata });
});

test("Task5/drive: {outcome:'none'} adds no structuredContent", async () => {
  const drive = minimalDrive({ navigate: async (url) => ({ url, title: "T", tree: "tree", artifactOutcome: { outcome: "none" } }) });
  const client = await connectInMemory({ retrieve: async () => retrieveOutcome(), drive });
  const res = await client.callTool({ name: "browser_navigate", arguments: { url: "https://x/" } });
  assert.equal(res.isError ?? false, false);
  assert.equal(res.structuredContent, undefined);
});

test("Task5/drive: an absent artifactOutcome preserves drive output byte-for-byte", async () => {
  const drive = minimalDrive();
  const client = await connectInMemory({ retrieve: async () => retrieveOutcome(), drive });
  const res = await client.callTool({ name: "browser_navigate", arguments: { url: "https://x/" } });
  assert.equal(res.isError ?? false, false);
  assert.equal(res.structuredContent, undefined);
});
