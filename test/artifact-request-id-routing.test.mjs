/**
 * Stabilization slice, finding 1 — duplicate IN-FLIGHT JSON-RPC request ids on ONE MCP session.
 *
 * The installed `@modelcontextprotocol/sdk` 1.29.0 routes a response by request id alone. Its
 * `WebStandardStreamableHTTPServerTransport` performs an UNCONDITIONAL
 * `this._requestToStreamMapping.set(message.id, streamId)` for every dispatched request, and `send()`
 * resolves a response through `_requestToStreamMapping.get(message.id)`. Two concurrent POSTs on one
 * session that share an id therefore collapse onto ONE mapping entry: the second silently overwrites
 * the first, so the FIRST request's response is written into the SECOND request's still-open stream.
 *
 * For `browser_get_artifact` that means the private PDF bytes leave the process on a socket belonging
 * to a different request, while the first request's own response never arrives and its lease is
 * terminalized as `timed-out` — i.e. the audit records "not sent" for bytes that reached the kernel,
 * contradicting Task 2 §5.3's stated meaning of a `sent` outcome.
 *
 * Real at every layer this concerns: a real temporary `ArtifactRuntime` publishing a real fixture PDF
 * through the real capture lifecycle, the real `createGatewayMcpServer` + `createHttpHandler` + Node
 * `http` server on loopback, and RAW `fetch` POSTs — the SDK *client* mints unique ids of its own, so
 * only a raw client can express the duplicate this test is about.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createGatewayMcpServer, createHttpHandler } from "../dist/mcp/index.js";
import { ArtifactRuntime } from "../dist/artifacts/index.js";
import { PolicyEngine, ConsumerRegistry } from "../dist/policy/index.js";

const dirs = [];
function tempDir() {
  const d = mkdtempSync(join(tmpdir(), "bgw-artifact-reqid-"));
  dirs.push(d);
  return d;
}
after(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

const FIXTURE_BYTES = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
  "utf8",
);
const FIXTURE_BLOB = FIXTURE_BYTES.toString("base64");

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

/** A two-way gate: the server side announces it was ENTERED, the test side decides when it is RELEASED.
 *  This is what makes the race deterministic rather than dependent on how long a file read happens to
 *  take — the ordering under test (A dispatched, B overwrites the mapping, A responds) is forced. */
function gate() {
  let release, markEntered;
  const released = new Promise((r) => {
    release = r;
  });
  const entered = new Promise((r) => {
    markEntered = r;
  });
  return { released, entered, release: () => release(), markEntered: () => markEntered() };
}

const TIMED_OUT = Symbol("timed-out");
/** Bounded await: a hung POST must fail this test by assertion, never by hanging the runner. */
async function within(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((r) => {
        timer = setTimeout(() => r(TIMED_OUT), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { server, url: new URL(`http://127.0.0.1:${port}/mcp`) };
}

test("duplicate in-flight JSON-RPC id: a second POST must not capture the artifact response of the first", async () => {
  const root = join(tempDir(), "store");
  const fixturePath = join(tempDir(), "fixture.pdf");
  writeFileSync(fixturePath, FIXTURE_BYTES);
  const runtime = new ArtifactRuntime({ enabled: true, root });

  const OWNER_CONSUMER = "alice";
  const OWNER_CONTROLLER = "ctrl-alice-1";

  // Real Task 1 capture: real operation, real DownloadLike seam, real seal().
  const operation = runtime.createOperation({
    owner: { scope: "drive", consumerId: OWNER_CONSUMER, controllerId: OWNER_CONTROLLER },
    sourceHost: "example.com",
  });
  assert.equal(operation.registerDownload({ path: () => fixturePath }), true);
  const sealed = await operation.seal();
  assert.equal(sealed.outcome, "available", `capture did not publish: ${JSON.stringify(sealed)}`);
  const artifactId = sealed.artifact.artifactId;

  const artifactGate = gate(); // parks the artifact acquisition until the duplicate id has landed
  const secondGate = gate(); //  parks the second call so ITS stream is still open when A responds

  // Observe the outcome the REAL lease is completed with. The second half of the claim is an
  // accounting lie — a `timed-out`/`transport-failed` outcome recorded for bytes that did reach the
  // kernel — so it is measured here, not argued from the code.
  const outcomes = [];
  let secondEntered = false;

  const registry = new ConsumerRegistry([{ id: OWNER_CONSUMER, token: "tok-alice", allow: ["*"] }]);
  const policy = new PolicyEngine({ registry });
  const handler = createHttpHandler({
    authenticate: (token) => policy.authenticate(token),
    buildServer: (consumer) => ({
      server: createGatewayMcpServer({
        retrieve: async () => {
          secondEntered = true;
          secondGate.markEntered();
          await secondGate.released;
          return retrieveOutcome();
        },
        artifacts: {
          consumerId: consumer.id,
          controllerId: OWNER_CONTROLLER,
          consumeForServer: async (input) => {
            artifactGate.markEntered();
            await artifactGate.released;
            const lease = await runtime.acquireResponseLease(input);
            // Same lease, same authority — only the outcome is recorded on the way through.
            return {
              metadata: lease.metadata,
              resource: lease.resource,
              deadlineMs: lease.deadlineMs,
              complete: (outcome) => {
                outcomes.push(outcome);
                return lease.complete(outcome);
              },
            };
          },
        },
      }),
      dispose: async () => {},
    }),
    artifactsEnabled: true,
  });
  const { server, url } = await startServer(handler);

  // One real MCP session, opened by the real client so initialize/notifications are exactly as
  // production sees them; the raw POSTs below then reuse its session id.
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer tok-alice` } },
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  const sessionId = transport.sessionId;
  assert.ok(sessionId, "the session must be open before the raw POSTs");

  const DUPLICATE_ID = 4242; // the ONE id both in-flight POSTs share
  const aborters = [];
  const rawPost = (body) => {
    const ac = new AbortController();
    aborters.push(ac);
    return fetch(url, {
      method: "POST",
      signal: ac.signal,
      headers: {
        Authorization: "Bearer tok-alice",
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify(body),
    })
      .then(async (r) => ({ status: r.status, text: await r.text() }))
      .catch((err) => ({ status: 0, text: `FETCH-ERROR:${err.name}` }));
  };

  try {
    // POST A — the artifact retrieval. Parks inside consumeForServer, so its mapping entry is
    // established and it has NOT yet produced a response.
    const postA = rawPost({
      jsonrpc: "2.0",
      id: DUPLICATE_ID,
      method: "tools/call",
      params: { name: "browser_get_artifact", arguments: { artifactId } },
    });
    await within(artifactGate.entered, 5_000);

    // POST B — a SECOND in-flight request reusing the SAME id. Either it is refused before dispatch
    // (the fixed behavior) or it is dispatched and overwrites A's mapping entry (the defect).
    const postB = rawPost({
      jsonrpc: "2.0",
      id: DUPLICATE_ID,
      method: "tools/call",
      params: { name: "retrieve", arguments: { url: "https://example.com/" } },
    });
    const dispatched = await within(Promise.race([secondGate.entered, postB]), 5_000);
    assert.notEqual(dispatched, TIMED_OUT, "the second POST neither dispatched nor answered");

    // Let A's artifact response go out. This is the exact instant the SDK resolves the id.
    artifactGate.release();

    const respB = await within(postB, 5_000);
    assert.notEqual(respB, TIMED_OUT, "the second POST never completed");
    // THE CLAIM: A's private PDF must never be written to B's response.
    assert.equal(
      respB.text.includes(FIXTURE_BLOB),
      false,
      `the second POST's response carried the first POST's artifact bytes (status ${respB.status})`,
    );
    // Refused BEFORE dispatch: the colliding call must never reach a tool handler, so it can never
    // establish the mapping entry that does the damage.
    assert.equal(respB.status, 400, `duplicate id was not refused: ${respB.text.slice(0, 200)}`);
    assert.equal(secondEntered, false, "the colliding call reached its tool handler anyway");

    secondGate.release();

    // And the request that actually asked for the artifact must be the one that receives it.
    const respA = await within(postA, 5_000);
    assert.notEqual(respA, TIMED_OUT, "the artifact POST never received a response");
    assert.equal(respA.status, 200, `artifact POST status ${respA.status}: ${respA.text.slice(0, 200)}`);
    assert.ok(
      respA.text.includes(FIXTURE_BLOB),
      "the artifact POST's own response did not carry the artifact bytes",
    );

    // And the audit must agree with reality. The outcome is recorded when the tracker terminalizes on
    // the real Node `finish`, which is strictly after the client's body arrives — so wait for it.
    await within(
      (async () => {
        while (outcomes.length === 0) await new Promise((r) => setTimeout(r, 10));
      })(),
      2_000,
    );
    assert.deepEqual(
      outcomes,
      ["sent"],
      `bytes reached the client but the lease recorded ${JSON.stringify(outcomes)}`,
    );
  } finally {
    artifactGate.release();
    secondGate.release();
    for (const ac of aborters) ac.abort();
    await new Promise((r) => setTimeout(r, 50)); // let a reset-driven terminalization settle
    await client.close().catch(() => {});
    await handler.closeAll().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    server.closeAllConnections?.();
    await runtime.close();
  }
});

test("disabled parity: with artifacts disabled a duplicate in-flight id is dispatched exactly as before", async () => {
  // The gate above is a Task 2 request-shape restriction, not a general protocol correction: a build
  // with artifacts disabled has no response-scoped lease to protect, so it must accept every request it
  // accepted before Task 2 existed. Proven by DISPATCH, not by a status code — both calls must reach a
  // tool handler, which is exactly what the enabled build refuses.
  let entered = 0;
  let bothEntered;
  const both = new Promise((r) => {
    bothEntered = r;
  });

  const registry = new ConsumerRegistry([{ id: "alice", token: "tok-alice", allow: ["*"] }]);
  const policy = new PolicyEngine({ registry });
  const release = gate();
  const handler = createHttpHandler({
    authenticate: (token) => policy.authenticate(token),
    buildServer: () => ({
      server: createGatewayMcpServer({
        retrieve: async () => {
          if (++entered === 2) bothEntered();
          await release.released;
          return retrieveOutcome();
        },
      }),
      dispose: async () => {},
    }),
    // artifactsEnabled deliberately absent — the disabled build.
  });
  const { server, url } = await startServer(handler);

  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer tok-alice` } },
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  const sessionId = transport.sessionId;

  const aborters = [];
  const rawPost = (body) => {
    const ac = new AbortController();
    aborters.push(ac);
    return fetch(url, {
      method: "POST",
      signal: ac.signal,
      headers: {
        Authorization: "Bearer tok-alice",
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify(body),
    })
      .then(async (r) => ({ status: r.status, text: await r.text() }))
      .catch((err) => ({ status: 0, text: `FETCH-ERROR:${err.name}` }));
  };

  try {
    const call = { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "retrieve", arguments: { url: "https://example.com/" } } };
    void rawPost(call);
    void rawPost(call); // the SAME id, concurrently — accepted, as it was before Task 2
    const reached = await within(both, 5_000);
    assert.notEqual(reached, TIMED_OUT, "a disabled build refused a request it used to dispatch");
    assert.equal(entered, 2);
  } finally {
    release.release();
    for (const ac of aborters) ac.abort();
    await new Promise((r) => setTimeout(r, 50));
    await client.close().catch(() => {});
    await handler.closeAll().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    server.closeAllConnections?.();
  }
});
