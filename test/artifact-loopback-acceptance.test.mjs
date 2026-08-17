/**
 * Task 2 acceptance — ONE real loopback end-to-end test.
 *
 * Deliberately real, not mocked, at every layer this task cares about:
 *  - a real, temporary `ArtifactRuntime` (Task 1) publishes a real minimal PDF fixture through the
 *    real `ArtifactCaptureOperation` lifecycle (`createOperation` -> `registerDownload` -> `seal`),
 *    driving the actual `DownloadLike` seam with a fixture file on disk;
 *  - a real `createGatewayMcpServer` + `createHttpHandler` + Node `http` server, listening on
 *    loopback, with `deps.artifacts.consumeForServer` wired to the runtime's own
 *    `acquireResponseLease` — the exact closure production uses (`src/mcp/http-main.ts`);
 *  - a real MCP Streamable HTTP session (`StreamableHTTPClientTransport`) authenticated against a
 *    real `PolicyEngine`/`ConsumerRegistry`, calling the real `browser_get_artifact` tool.
 *
 * No live browser and no network beyond 127.0.0.1.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createGatewayMcpServer, createHttpHandler } from "../dist/mcp/index.js";
import { ArtifactRuntime } from "../dist/artifacts/index.js";
import { PolicyEngine, ConsumerRegistry } from "../dist/policy/index.js";

const dirs = [];
function tempDir() {
  const d = mkdtempSync(join(tmpdir(), "bgw-artifact-e2e-"));
  dirs.push(d);
  return d;
}
after(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

// The Task 1 DownloadLike seam is a real file on disk — a minimal but structurally valid PDF.
const FIXTURE_BYTES = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
  "utf8",
);
const FIXTURE_SHA256 = createHash("sha256").update(FIXTURE_BYTES).digest("hex");

const retrieveOutcome = () => ({
  markdown: "unused",
  title: "unused",
  status: 200,
  blocked: false,
  reason: null,
  degraded: false,
  proxyUsed: false,
  captchaSolved: false,
});

async function startServer(handler) {
  const server = createServer((req, res) =>
    handler.handle(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    }),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { server, url: new URL(`http://127.0.0.1:${port}/mcp`) };
}

async function connectSession(url, token) {
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

test("Task 2 acceptance: real loopback capture -> browser_get_artifact round trip", async () => {
  // --- 1. Real, temporary ArtifactRuntime; the fixture lives on the SAME tmp filesystem as the
  //     store's root, exactly like every other Task 1 test (a cross-filesystem link would fail). ---
  const root = join(tempDir(), "store");
  const fixturePath = join(tempDir(), "fixture.pdf");
  writeFileSync(fixturePath, FIXTURE_BYTES);
  const runtime = new ArtifactRuntime({ enabled: true, root });

  // Server-derived identities: minted here, server-side, never from MCP input. Drive-scoped so the
  // real ownership/lineage check in `acquireResponseLease` (consumerId AND controllerId) is exercised.
  const OWNER_CONSUMER = "alice";
  const OWNER_CONTROLLER = "ctrl-alice-1";

  // --- 2. Task 1 capture: real operation, real DownloadLike seam, real seal(). ---
  const operation = runtime.createOperation({
    owner: { scope: "drive", consumerId: OWNER_CONSUMER, controllerId: OWNER_CONTROLLER },
    sourceHost: "example.com",
  });
  const receipt = operation.registerDownload({ path: () => fixturePath });
  assert.equal(receipt, true, "the operation must accept ownership of the fixture download");
  const sealed = await operation.seal();
  assert.equal(sealed.outcome, "available", `capture did not publish: ${JSON.stringify(sealed)}`);
  const artifactId = sealed.artifact.artifactId;
  assert.equal(sealed.artifact.sizeBytes, FIXTURE_BYTES.length);
  assert.equal(sealed.artifact.sha256, FIXTURE_SHA256);

  // --- 3. Real MCP server + real HTTP handler, wired exactly like production (http-main.ts):
  //     `consumeForServer` is the runtime's own `acquireResponseLease`, nothing else. ---
  const registry = new ConsumerRegistry([
    { id: OWNER_CONSUMER, token: "tok-alice", allow: ["*"] },
    { id: "bob", token: "tok-bob", allow: ["*"] },
  ]);
  const policy = new PolicyEngine({ registry });
  const deps = {
    authenticate: (token) => policy.authenticate(token),
    buildServer: (consumer) => {
      const isOwner = consumer.id === OWNER_CONSUMER;
      const server = createGatewayMcpServer({
        retrieve: async () => retrieveOutcome(),
        artifacts: {
          consumerId: consumer.id,
          controllerId: isOwner ? OWNER_CONTROLLER : "ctrl-bob-1",
          consumeForServer: (input) => runtime.acquireResponseLease(input),
        },
      });
      return { server, dispose: async () => {} };
    },
    artifactsEnabled: true,
  };
  const handler = createHttpHandler(deps);
  const { server, url } = await startServer(handler);

  let aliceClient, bobClient;
  try {
    aliceClient = await connectSession(url, "tok-alice");
    bobClient = await connectSession(url, "tok-bob");

    // --- 4. Foreign identity, tried FIRST (before the real consumer ever fetches), so the denial is
    //     provably an owner-mismatch and not just "already consumed". ---
    const foreignRes = await bobClient.callTool({
      name: "browser_get_artifact",
      arguments: { artifactId },
    });
    assert.equal(foreignRes.isError, true);
    assert.deepEqual(foreignRes.content, [{ type: "text", text: "Artifact is unavailable." }]);
    assert.equal(foreignRes.structuredContent, undefined);
    assert.equal(JSON.stringify(foreignRes).includes(root), false, "no server path leaked to a foreign caller");

    // --- 5. The real owning identity: success. ---
    const res = await aliceClient.callTool({ name: "browser_get_artifact", arguments: { artifactId } });
    assert.equal(res.isError ?? false, false);
    assert.equal(res.content.length, 1);
    const block = res.content[0];
    assert.equal(block.type, "resource");
    assert.equal(block.resource.uri, `artifact:${artifactId}`);
    assert.equal(block.resource.mimeType, "application/pdf");
    // Byte-for-byte: decode the returned blob and compare against the original fixture bytes.
    const decoded = Buffer.from(block.resource.blob, "base64");
    assert.ok(decoded.equals(FIXTURE_BYTES), "returned artifact bytes must equal the fixture bytes exactly");

    assert.deepEqual(Object.keys(block.resource).sort(), ["blob", "mimeType", "uri"]);
    assert.deepEqual(Object.keys(res.structuredContent).sort(), ["artifact"]);
    const meta = res.structuredContent.artifact;
    assert.equal(meta.artifactId, artifactId);
    assert.equal(meta.sizeBytes, FIXTURE_BYTES.length);
    assert.equal(meta.sha256, FIXTURE_SHA256);
    // The ONE public projection: exactly these fields, never owner/controller/path/record internals.
    assert.deepEqual(
      Object.keys(meta).sort(),
      ["artifactId", "createdAt", "disposition", "expiresAt", "kind", "sha256", "sizeBytes", "sourceHost"].sort(),
    );
    const serialized = JSON.stringify(res);
    for (const forbidden of [OWNER_CONSUMER, OWNER_CONTROLLER, fixturePath, root, "consumerId", "controllerId", "owner", "path"]) {
      assert.equal(serialized.includes(forbidden), false, `response leaked "${forbidden}"`);
    }

    // --- 6. Response completion allows cleanup, one-shot: the artifact was consumed by the round
    //     trip above (real Node `res` "finish" -> tracker -> lease.complete -> store discard), so a
    //     second fetch by the rightful owner gets the same fixed unavailable result. ---
    const secondRes = await aliceClient.callTool({ name: "browser_get_artifact", arguments: { artifactId } });
    assert.equal(secondRes.isError, true);
    assert.deepEqual(secondRes.content, [{ type: "text", text: "Artifact is unavailable." }]);
    assert.equal(secondRes.structuredContent, undefined);
  } finally {
    await aliceClient?.close().catch(() => {});
    await bobClient?.close().catch(() => {});
    await handler.closeAll().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    server.closeAllConnections?.();
    await runtime.close();
  }
});
