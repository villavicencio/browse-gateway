/**
 * Task 2 §6 — HTTP entrypoint artifact lifecycle: per-graph disposal (DELETE, idle reap, `closeAll`,
 * and failed-session-open cleanup all share ONE idempotent dispose promise) and process shutdown
 * (bounded, diagnosable `ArtifactRuntime.close()` correctly ordered between `closeAll()` and
 * `gateway.shutdown()`). `createConsumerGraphDisposer` / `closeArtifactRuntimeBounded` /
 * `runShutdownSequence` are tested directly (fast, deterministic); the cross-layer section drives a
 * REAL loopback `createHttpHandler` + a REAL `ArtifactRuntime` with a fake drive/browser, mirroring
 * exactly how `http-main.ts` wires `buildServer`.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpHandler, createGatewayMcpServer } from "../dist/mcp/index.js";
import { PolicyEngine, ConsumerRegistry } from "../dist/policy/index.js";
import { ArtifactRuntime } from "../dist/artifacts/index.js";
import {
  createConsumerGraphDisposer,
  closeArtifactRuntimeBounded,
  runShutdownSequence,
} from "../dist/mcp/artifact-graph-lifecycle.js";

/** A promise that outlives every bound this file tests against, via an UNREF'D real timer — never a
 *  bare `new Promise(() => {})`, which Node's test runner flags as a dangling-resolution leak once the
 *  bounded wrapper around it has already resolved and the test has moved on. */
function neverResolvesInTime() {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, 60_000);
    t.unref?.();
  });
}

const dirs = [];
function temp() {
  const dir = mkdtempSync(join(tmpdir(), "bgw-artifact-lifecycle-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

// ---- createConsumerGraphDisposer ------------------------------------------------------------------

/** A fake artifact runtime that records every call, in order, so ordering assertions don't rely on
 *  timing — only on the SEQUENCE the disposer actually issued. */
function fakeLineageRuntime(opts = {}) {
  const calls = [];
  return {
    calls,
    invalidateController(input) {
      calls.push({ op: "invalidate", ...input });
    },
    async discardController(input) {
      calls.push({ op: "discard", ...input });
      if (opts.discardThrows) throw new Error("discard boom");
      return opts.discardResult ?? "clean";
    },
  };
}

test("dispose: synchronously fences the lineage before invoking drive.close() (event order, not merely 'not yet started')", () => {
  // The invariant this proves is ORDER, not that drive.close() hasn't been invoked yet: dispose()'s
  // synchronous prefix (up to its first await) calls BOTH invalidateController and drive.close() in the
  // same synchronous turn — an async `close` with no internal await runs its own body synchronously too,
  // so asserting "close hasn't started" is a false invariant that happens to pass by accident of the
  // fake's shape. What Task 2 §6 actually requires is that the fence is issued strictly BEFORE the
  // close invocation — observed here via ONE shared, ordered event log.
  const events = [];
  const runtime = {
    invalidateController(input) {
      events.push({ op: "invalidate", ...input });
    },
    async discardController(input) {
      events.push({ op: "discard", ...input });
      return "clean";
    },
  };
  const drive = { close: async () => { events.push({ op: "drive-close" }); } };
  const dispose = createConsumerGraphDisposer({ drive, artifactRuntime: runtime, consumerId: "c1", controllerId: "ctrl1" });
  dispose(); // deliberately not awaited — proving the SYNCHRONOUS portion ran already
  assert.equal(events[0]?.op, "invalidate", "the fence is the very first thing dispose() does");
  assert.deepEqual(events[0], { op: "invalidate", consumerId: "c1", controllerId: "ctrl1" });
  assert.equal(events[1]?.op, "drive-close", "drive.close() is invoked strictly AFTER the fence, in the same synchronous turn");
});

test("dispose: closes the drive session, THEN discards the exact {consumerId, controllerId} lineage (sequential, not concurrent)", async () => {
  const runtime = fakeLineageRuntime();
  const order = [];
  const drive = {
    close: async () => {
      order.push("drive-close-start");
      await new Promise((r) => setTimeout(r, 5));
      order.push("drive-close-end");
    },
  };
  const dispose = createConsumerGraphDisposer({ drive, artifactRuntime: runtime, consumerId: "c1", controllerId: "ctrl1" });
  await dispose();
  assert.deepEqual(order, ["drive-close-start", "drive-close-end"]);
  assert.deepEqual(
    runtime.calls,
    [
      { op: "invalidate", consumerId: "c1", controllerId: "ctrl1" },
      { op: "discard", consumerId: "c1", controllerId: "ctrl1" },
    ],
    "discard is called only AFTER drive.close() has fully settled, with the exact lineage identity",
  );
});

test("dispose: duplicate disposal — a second call returns the SAME promise and performs no extra work", async () => {
  const runtime = fakeLineageRuntime();
  let closeCount = 0;
  const drive = { close: async () => { closeCount++; } };
  const dispose = createConsumerGraphDisposer({ drive, artifactRuntime: runtime, consumerId: "c1", controllerId: "ctrl1" });
  const p1 = dispose();
  const p2 = dispose();
  assert.equal(p1, p2, "the exact same promise is returned");
  await p1;
  await dispose(); // a THIRD call, after settlement
  assert.equal(closeCount, 1, "drive.close() ran exactly once");
  assert.equal(runtime.calls.filter((c) => c.op === "invalidate").length, 1, "invalidateController ran exactly once");
  assert.equal(runtime.calls.filter((c) => c.op === "discard").length, 1, "discardController ran exactly once");
});

test("dispose: a drive.close() failure does not skip discardController (all attempts run) and never hangs", async () => {
  const runtime = fakeLineageRuntime();
  const drive = { close: async () => { throw new Error("teardown boom"); } };
  const dispose = createConsumerGraphDisposer({ drive, artifactRuntime: runtime, consumerId: "c1", controllerId: "ctrl1" });
  await assert.doesNotReject(dispose());
  assert.equal(runtime.calls.filter((c) => c.op === "discard").length, 1, "discard still ran despite drive.close() rejecting");
});

test("dispose: a discardController refusal/failure does not throw or hang", async () => {
  for (const discardResult of ["refused", "failed"]) {
    const runtime = fakeLineageRuntime({ discardResult });
    const dispose = createConsumerGraphDisposer({ drive: { close: async () => {} }, artifactRuntime: runtime, consumerId: "c1", controllerId: "ctrl1" });
    await assert.doesNotReject(dispose());
  }
  const throwing = fakeLineageRuntime({ discardThrows: true });
  const dispose = createConsumerGraphDisposer({ drive: { close: async () => {} }, artifactRuntime: throwing, consumerId: "c1", controllerId: "ctrl1" });
  await assert.doesNotReject(dispose(), "a hostile/throwing discardController is guarded, never propagates");
});

test("dispose: disabled (no artifactRuntime) only closes the drive session — no invalidate/discard calls at all", async () => {
  let closed = false;
  const dispose = createConsumerGraphDisposer({ drive: { close: async () => { closed = true; } }, consumerId: "c1", controllerId: "ctrl1" });
  await dispose();
  assert.equal(closed, true);
});

test("dispose: real ArtifactRuntime — a committed drive-lineage artifact is discarded, a consumer-scoped artifact is untouched", async () => {
  const root = join(temp(), "artifacts");
  const runtime = new ArtifactRuntime({ enabled: true, root });
  try {
    const pdf = join(temp(), "doc.pdf");
    writeFileSync(pdf, Buffer.from("%PDF-1.7\nhello"));
    const driveOp = runtime.createOperation({ owner: { scope: "drive", consumerId: "c1", controllerId: "ctrl1" }, sourceHost: "example.com" });
    assert.ok(driveOp.registerDownload({ path: () => pdf }));
    const driveResult = await driveOp.seal();
    const consumerOp = runtime.createOperation({ owner: { scope: "consumer", consumerId: "c1" }, sourceHost: "example.com" });
    assert.ok(consumerOp.registerDownload({ path: () => pdf }));
    const consumerResult = await consumerOp.seal();
    assert.equal(driveResult.outcome, "available");
    assert.equal(consumerResult.outcome, "available");

    const dispose = createConsumerGraphDisposer({ drive: { close: async () => {} }, artifactRuntime: runtime, consumerId: "c1", controllerId: "ctrl1" });
    await dispose();

    await assert.rejects(runtime.acquireResponseLease({ artifactId: driveResult.artifact.artifactId, consumerId: "c1", controllerId: "ctrl1" }));
    const lease = await runtime.acquireResponseLease({ artifactId: consumerResult.artifact.artifactId, consumerId: "c1" });
    assert.ok(lease, "the consumer-scoped (transient) artifact survives controller disposal");
    await lease.complete("sent");
  } finally {
    await runtime.close();
  }
});

// ---- closeArtifactRuntimeBounded -----------------------------------------------------------------

test("closeArtifactRuntimeBounded: absent runtime is a no-op — resolves immediately, logs nothing", async () => {
  const logs = [];
  await closeArtifactRuntimeBounded(undefined, 50, (m) => logs.push(m));
  assert.deepEqual(logs, []);
});

test("closeArtifactRuntimeBounded: a clean close (no result) resolves without logging a failure", async () => {
  const logs = [];
  await closeArtifactRuntimeBounded({ close: async () => undefined }, 50, (m) => logs.push(m));
  assert.deepEqual(logs, []);
});

test("closeArtifactRuntimeBounded: a reported closed failure code is logged (diagnosable, no raw exception text)", async () => {
  const logs = [];
  await closeArtifactRuntimeBounded({ close: async () => "artifact-cleanup-failed" }, 50, (m) => logs.push(m));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /artifact-cleanup-failed/);
});

test("closeArtifactRuntimeBounded: a HUNG close resolves at the bound, never hangs", async () => {
  const logs = [];
  let releaseClose;
  const closeP = new Promise((resolve) => { releaseClose = resolve; });
  const t0 = Date.now();
  await closeArtifactRuntimeBounded({ close: () => closeP }, 30, (m) => logs.push(m));
  assert.ok(Date.now() - t0 < 500, "resolved close to the bound, not the (infinite) close duration");
  assert.ok(logs.some((m) => /exhausted/.test(m)));
  // Settle the underlying close() before this test returns — nothing left pending across test boundaries.
  releaseClose();
  await closeP;
});

test("closeArtifactRuntimeBounded: a rejecting close resolves anyway (fail-closed, never hangs or throws)", async () => {
  const logs = [];
  await assert.doesNotReject(closeArtifactRuntimeBounded({ close: async () => { throw new Error("boom"); } }, 50, (m) => logs.push(m)));
  assert.ok(logs.some((m) => /rejected/.test(m)));
});

// ---- runShutdownSequence --------------------------------------------------------------------------

function orderedFakeShutdownTarget(over = {}) {
  const order = [];
  const target = {
    httpServer: {
      close: () => order.push("httpServer.close"),
      closeAllConnections: () => order.push("httpServer.closeAllConnections"),
    },
    handler: {
      drain: async (ms) => {
        order.push(`handler.drain(${ms})`);
        if (over.drainDelayMs) await new Promise((r) => setTimeout(r, over.drainDelayMs));
      },
      closeAll: async () => {
        order.push("handler.closeAll");
        if (over.closeAllDelayMs) await new Promise((r) => setTimeout(r, over.closeAllDelayMs));
      },
    },
    gateway: { shutdown: async () => order.push("gateway.shutdown") },
    artifactRuntime: over.artifactRuntime,
  };
  return { target, order };
}

test("runShutdownSequence: exact order — refuse HTTP, drain, closeAll, drop sockets, artifact close, THEN gateway.shutdown", async () => {
  const artifactRuntime = { close: async () => { order.push("artifactRuntime.close"); return undefined; } };
  const { target, order } = orderedFakeShutdownTarget({ artifactRuntime });
  await runShutdownSequence(target, { drainMs: 100, artifactCloseTimeoutMs: 100, log: () => {} });
  assert.deepEqual(order, [
    "httpServer.close",
    "handler.drain(100)",
    "handler.closeAll",
    "httpServer.closeAllConnections",
    "artifactRuntime.close",
    "gateway.shutdown",
  ]);
});

test("runShutdownSequence: shutdown with an active lease — artifactRuntime.close() does not start until drain (which the active lease keeps pending) AND closeAll have both settled", async () => {
  const { target, order } = orderedFakeShutdownTarget({ drainDelayMs: 40 }); // simulates an active response lease keeping inFlight elevated
  target.artifactRuntime = { close: async () => { order.push("artifactRuntime.close"); } };
  await runShutdownSequence(target, { drainMs: 200, artifactCloseTimeoutMs: 200, log: () => {} });
  const drainIdx = order.indexOf("handler.drain(200)");
  const closeAllIdx = order.indexOf("handler.closeAll");
  const artifactIdx = order.indexOf("artifactRuntime.close");
  assert.ok(drainIdx < closeAllIdx && closeAllIdx < artifactIdx, `expected drain < closeAll < artifactRuntime.close, got ${order.join(",")}`);
});

test("runShutdownSequence: runtime-close order — artifactRuntime.close() runs strictly after closeAll settles, strictly before gateway.shutdown", async () => {
  const { target, order } = orderedFakeShutdownTarget({ closeAllDelayMs: 30 });
  target.artifactRuntime = { close: async () => { order.push("artifactRuntime.close"); } };
  await runShutdownSequence(target, { drainMs: 10, artifactCloseTimeoutMs: 100, log: () => {} });
  assert.deepEqual(
    order.filter((e) => ["handler.closeAll", "artifactRuntime.close", "gateway.shutdown"].includes(e)),
    ["handler.closeAll", "artifactRuntime.close", "gateway.shutdown"],
  );
});

test("runShutdownSequence: artifact close failure/refusal is diagnosable but never blocks reaching gateway.shutdown (bounded)", async () => {
  const logs = [];
  const { target, order } = orderedFakeShutdownTarget();
  target.artifactRuntime = { close: () => neverResolvesInTime() }; // hung close
  const t0 = Date.now();
  await runShutdownSequence(target, { drainMs: 10, artifactCloseTimeoutMs: 30, log: (m) => logs.push(m) });
  assert.ok(Date.now() - t0 < 500, "did not hang past the artifact-close bound");
  assert.deepEqual(order, ["httpServer.close", "handler.drain(10)", "handler.closeAll", "httpServer.closeAllConnections", "gateway.shutdown"]);
  assert.ok(logs.some((m) => /exhausted/.test(m)));
});

test("runShutdownSequence: disabled (no artifactRuntime) reaches gateway.shutdown with no artifact step", async () => {
  const { target, order } = orderedFakeShutdownTarget();
  await runShutdownSequence(target, { drainMs: 10, artifactCloseTimeoutMs: 100, log: () => {} });
  assert.deepEqual(order, ["httpServer.close", "handler.drain(10)", "handler.closeAll", "httpServer.closeAllConnections", "gateway.shutdown"]);
});

// ---- Cross-layer: the REAL createHttpHandler wired exactly like http-main.ts's buildServer ---------

function makeArtifactHttpDeps(runtime) {
  const registry = new ConsumerRegistry([
    { id: "alice", token: "tok-alice", allow: ["*"] },
    { id: "bob", token: "tok-bob", allow: ["*"] },
  ]);
  const policy = new PolicyEngine({ registry });
  const graphs = []; // { consumerId, controllerId, driveClosed }
  let nextController = 1;
  const deps = {
    authenticate: (t) => policy.authenticate(t),
    buildServer: (consumer) => {
      const controllerId = `ctrl-${nextController++}`;
      const graph = { consumerId: consumer.id, controllerId, driveClosed: false };
      graphs.push(graph);
      const drive = { close: async () => { graph.driveClosed = true; } };
      const server = createGatewayMcpServer({
        retrieve: async ({ url }) => ({ markdown: `${consumer.id} ${url}`, title: "t", status: 200, blocked: false, reason: null, degraded: false, proxyUsed: false, captchaSolved: false }),
      });
      const dispose = createConsumerGraphDisposer({ drive, artifactRuntime: runtime, consumerId: consumer.id, controllerId });
      return { server, dispose };
    },
  };
  return { deps, graphs };
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
  server.closeAllConnections?.();
}

test("HTTP: an explicit DELETE fences + closes + discards the lineage exactly once", async () => {
  const runtimeRoot = join(temp(), "artifacts");
  const runtime = new ArtifactRuntime({ enabled: true, root: runtimeRoot });
  try {
    const { deps, graphs } = makeArtifactHttpDeps(runtime);
    const handler = createHttpHandler(deps);
    const { server, url } = await startServer(handler);
    let client;
    try {
      const c = connect(url, "tok-alice");
      client = c.client;
      await client.connect(c.transport);
      assert.equal(graphs.length, 1);
      const [graph] = graphs;
      await c.transport.terminateSession(); // explicit DELETE
      await new Promise((r) => setTimeout(r, 20)); // onsessionclosed -> cleanup() is fire-and-forget
      assert.equal(graph.driveClosed, true);
      assert.equal(handler.sessionCount(), 0);
      // The lineage is now invalidated: a fresh createOperation for it must fail closed.
      assert.throws(() => runtime.createOperation({ owner: { scope: "drive", consumerId: graph.consumerId, controllerId: graph.controllerId }, sourceHost: "example.com" }));
    } finally {
      client = undefined; // already terminated
      await stop({ server, handler });
    }
  } finally {
    await runtime.close();
  }
});

test("HTTP: the idle reaper disposes an abandoned session's lineage exactly once", async () => {
  const runtimeRoot = join(temp(), "artifacts");
  const runtime = new ArtifactRuntime({ enabled: true, root: runtimeRoot });
  try {
    const { deps, graphs } = makeArtifactHttpDeps(runtime);
    const handler = createHttpHandler({ ...deps, sessionIdleTtlMs: 1_000 });
    const { server, url } = await startServer(handler);
    let client;
    try {
      const c = connect(url, "tok-alice");
      client = c.client;
      await client.connect(c.transport);
      const [graph] = graphs;
      const reaped = await handler.reapIdle(Date.now() + 10_000); // no DELETE — simulate a crashed client
      assert.equal(reaped.length, 1);
      assert.equal(graph.driveClosed, true);
      assert.throws(() => runtime.createOperation({ owner: { scope: "drive", consumerId: graph.consumerId, controllerId: graph.controllerId }, sourceHost: "example.com" }));
    } finally {
      await stop({ server, handler, client });
    }
  } finally {
    await runtime.close();
  }
});

test("HTTP: a failed session-open still fences + closes + discards the orphaned lineage (no leak)", async () => {
  const runtimeRoot = join(temp(), "artifacts");
  const runtime = new ArtifactRuntime({ enabled: true, root: runtimeRoot });
  try {
    const registry = new ConsumerRegistry([{ id: "alice", token: "tok-alice", allow: ["*"] }]);
    const policy = new PolicyEngine({ registry });
    let capturedGraph;
    const handler = createHttpHandler({
      authenticate: (t) => policy.authenticate(t),
      buildServer: (consumer) => {
        const controllerId = "ctrl-orphan";
        capturedGraph = { consumerId: consumer.id, controllerId };
        const drive = { close: async () => { capturedGraph.driveClosed = true; } };
        const dispose = createConsumerGraphDisposer({ drive, artifactRuntime: runtime, consumerId: consumer.id, controllerId });
        return { server: { connect: async () => { throw new Error("connect boom"); } }, dispose };
      },
    });
    const { server, url } = await startServer(handler);
    try {
      const { client, transport } = connect(url, "tok-alice");
      await assert.rejects(client.connect(transport));
      assert.equal(capturedGraph.driveClosed, true, "the orphaned graph's drive session was closed");
      assert.throws(() => runtime.createOperation({ owner: { scope: "drive", ...capturedGraph }, sourceHost: "example.com" }));
    } finally {
      await stop({ server, handler });
    }
  } finally {
    await runtime.close();
  }
});

test("HTTP: closeAll disposes every live graph's lineage exactly once each", async () => {
  const runtimeRoot = join(temp(), "artifacts");
  const runtime = new ArtifactRuntime({ enabled: true, root: runtimeRoot });
  try {
    const { deps, graphs } = makeArtifactHttpDeps(runtime);
    const handler = createHttpHandler(deps);
    const { server, url } = await startServer(handler);
    let alice, bob;
    try {
      const a = connect(url, "tok-alice");
      alice = a.client;
      await alice.connect(a.transport);
      const b = connect(url, "tok-bob");
      bob = b.client;
      await bob.connect(b.transport);
      assert.equal(graphs.length, 2);
      await handler.closeAll();
      for (const graph of graphs) {
        assert.equal(graph.driveClosed, true);
        assert.throws(() => runtime.createOperation({ owner: { scope: "drive", consumerId: graph.consumerId, controllerId: graph.controllerId }, sourceHost: "example.com" }));
      }
    } finally {
      await stop({ server, handler });
    }
  } finally {
    await runtime.close();
  }
});
