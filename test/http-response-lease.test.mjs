/**
 * Task 2 §5.2 — the repo-owned `ArtifactLeaseTracker` maps the SDK's Streamable HTTP dispatch onto
 * the ACTUAL Node `ServerResponse` completion boundary (`finish`, `close`, `error`, an absolute
 * deadline, or an explicitly forced outcome) and, through that, onto one `ArtifactResponseLease`'s
 * `complete()`.
 *
 * These are unit-level, fake-req/res tests: they prove the tracker's own state machine — exact-once
 * completion, ordering, reference release, deadline math — deterministically, with an injected clock
 * and a fake `ArtifactResponseLease`. The REAL Node `finish`/reset/backpressure/SDK-loopback proof
 * lives in `test/http-server.test.mjs` (H1/H2/H8), which is what actually exercises a real socket.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  createArtifactLeaseTracker,
  ArtifactLeaseTrackerError,
  batchContainsArtifactRetrieval,
  isArtifactToolCall,
  ARTIFACT_TOOL_NAME,
} from "../dist/mcp/index.js";

/** A minimal fake `IncomingMessage`/`ServerResponse` pair: real EventEmitters (so `.once`/`.removeListener`
 *  behave exactly like the Node originals) plus the handful of fields/methods the tracker reads. */
function fakeReqRes() {
  const req = new EventEmitter();
  const res = new EventEmitter();
  res.writableFinished = false;
  res.destroyed = false;
  res.destroy = () => {
    res.destroyed = true;
  };
  return { req, res };
}

/** A fake `ArtifactResponseLease` (Task 2 §4.1): records every `complete()` call (outcome + call
 *  count) so a test can assert exact-once completion without a real store/runtime. */
function fakeLease(overrides = {}) {
  const calls = [];
  let resolveGate;
  const gate = overrides.deferred ? new Promise((r) => (resolveGate = r)) : undefined;
  const lease = {
    metadata: Object.freeze({
      artifactId: "a".repeat(22),
      kind: "pdf",
      disposition: "attachment",
      sizeBytes: 3,
      sha256: "x".repeat(64),
      createdAt: new Date(0).toISOString(),
      expiresAt: new Date(1).toISOString(),
      sourceHost: "example.com",
    }),
    resource: Object.freeze({
      type: "resource",
      resource: Object.freeze({ uri: "artifact:" + "a".repeat(22), mimeType: "application/pdf", blob: "AAA=" }),
    }),
    deadlineMs: overrides.deadlineMs ?? 15_000,
    async complete(outcome) {
      calls.push(outcome);
      if (overrides.onComplete) overrides.onComplete(outcome);
      if (gate) await gate;
    },
  };
  return { lease, calls, resolveGate: () => resolveGate?.() };
}

function fakeClock(startMs = 0) {
  let now = startMs;
  const timers = []; // { id, at, cb }
  let nextId = 1;
  return {
    now: () => now,
    setTimer: (cb, ms) => {
      const id = nextId++;
      timers.push({ id, at: now + ms, cb });
      return id;
    },
    clearTimer: (id) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    /** Advance the clock and fire any timers whose deadline has passed, in order. */
    advance(ms) {
      now += ms;
      const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at);
      for (const t of due) {
        const i = timers.findIndex((x) => x.id === t.id);
        if (i >= 0) timers.splice(i, 1);
        t.cb();
      }
    },
    pendingCount: () => timers.length,
  };
}

test("tracker: finish completes the lease exactly once with 'sent'", async () => {
  const { req, res } = fakeReqRes();
  const { lease, calls } = fakeLease();
  const tracker = createArtifactLeaseTracker(req, res, {});
  tracker.register(lease);
  res.writableFinished = true;
  res.emit("finish");
  await tracker.settled;
  assert.deepEqual(calls, ["sent"]);
});

test("tracker: close before writable-finish completes 'transport-failed' (reset)", async () => {
  const { req, res } = fakeReqRes();
  const { lease, calls } = fakeLease();
  const tracker = createArtifactLeaseTracker(req, res, {});
  tracker.register(lease);
  res.writableFinished = false;
  res.emit("close");
  await tracker.settled;
  assert.deepEqual(calls, ["transport-failed"]);
});

test("tracker: close WITH writableFinished=true completes 'sent' (finish observed via close)", async () => {
  const { req, res } = fakeReqRes();
  const { lease, calls } = fakeLease();
  const tracker = createArtifactLeaseTracker(req, res, {});
  tracker.register(lease);
  res.writableFinished = true;
  res.emit("close");
  await tracker.settled;
  assert.deepEqual(calls, ["sent"]);
});

test("tracker: response error completes 'transport-failed'", async () => {
  const { req, res } = fakeReqRes();
  const { lease, calls } = fakeLease();
  const tracker = createArtifactLeaseTracker(req, res, {});
  tracker.register(lease);
  res.emit("error", new Error("boom"));
  await tracker.settled;
  assert.deepEqual(calls, ["transport-failed"]);
});

test("tracker: request error/abort completes 'transport-failed'", async () => {
  for (const event of ["error", "aborted"]) {
    const { req, res } = fakeReqRes();
    const { lease, calls } = fakeLease();
    const tracker = createArtifactLeaseTracker(req, res, {});
    tracker.register(lease);
    req.emit(event, new Error("client gone"));
    await tracker.settled;
    assert.deepEqual(calls, ["transport-failed"], `event=${event}`);
  }
});

test("tracker: finish and close racing synchronously complete exactly once (finish wins)", async () => {
  const { req, res } = fakeReqRes();
  const { lease, calls } = fakeLease();
  const tracker = createArtifactLeaseTracker(req, res, {});
  tracker.register(lease);
  res.writableFinished = true;
  res.emit("finish");
  res.emit("close"); // fires in the same turn, as real Node does after a clean finish
  await tracker.settled;
  assert.deepEqual(calls, ["sent"], "exactly one completion despite two terminal events");
});

test("tracker: deadline timeout destroys the response BEFORE completing 'timed-out' (fencing order)", async () => {
  const { req, res } = fakeReqRes();
  const order = [];
  const realDestroy = res.destroy;
  res.destroy = () => {
    order.push("destroy");
    realDestroy();
  };
  const { lease, calls } = fakeLease({ onComplete: (outcome) => order.push(`complete:${outcome}`) });
  const clock = fakeClock(1_000);
  const tracker = createArtifactLeaseTracker(req, res, { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  tracker.register({ ...lease, deadlineMs: 1_000 + 15_000 });
  assert.equal(clock.pendingCount(), 1, "exactly one deadline timer armed");
  clock.advance(15_000);
  await tracker.settled;
  assert.deepEqual(order, ["destroy", "complete:timed-out"], "response is fenced before the lease completes");
  assert.equal(res.destroyed, true);
  assert.equal(clock.pendingCount(), 0, "the timer is cleared, not just fired");
});

test("tracker: a late finish after timeout cannot re-complete (listeners were detached)", async () => {
  const { req, res } = fakeReqRes();
  const { lease, calls } = fakeLease();
  const clock = fakeClock(0);
  const tracker = createArtifactLeaseTracker(req, res, { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  tracker.register({ ...lease, deadlineMs: 5_000 });
  clock.advance(5_000);
  await tracker.settled;
  assert.deepEqual(calls, ["timed-out"]);
  // A late SDK write finally reaching 'finish' must be a no-op: the listener was removed.
  res.writableFinished = true;
  res.emit("finish");
  assert.deepEqual(calls, ["timed-out"], "no second completion");
});

test("tracker: register() uses only deadlineMs - now() for the remaining budget", async () => {
  const { req, res } = fakeReqRes();
  const { lease } = fakeLease();
  const clock = fakeClock(12_000);
  let capturedMs;
  const tracker = createArtifactLeaseTracker(req, res, {
    now: clock.now,
    setTimer: (cb, ms) => {
      capturedMs = ms;
      return clock.setTimer(cb, ms);
    },
    clearTimer: clock.clearTimer,
  });
  tracker.register({ ...lease, deadlineMs: 12_000 + 4_500 });
  assert.equal(capturedMs, 4_500);
});

test("tracker: duplicate registration completes the LATER lease transport-failed and throws", async () => {
  const { req, res } = fakeReqRes();
  const first = fakeLease();
  const second = fakeLease();
  const tracker = createArtifactLeaseTracker(req, res, {});
  tracker.register(first.lease);
  assert.throws(() => tracker.register(second.lease), ArtifactLeaseTrackerError);
  await Promise.resolve(); // let the fallback complete() microtask run
  assert.deepEqual(second.calls, ["transport-failed"]);
  assert.deepEqual(first.calls, [], "the first, already-registered lease is untouched");
  // The first lease still owns the tracker: finish still resolves it normally.
  res.writableFinished = true;
  res.emit("finish");
  await tracker.settled;
  assert.deepEqual(first.calls, ["sent"]);
});

test("tracker: activate() before register() latches a reset that lands during acquisition (H7)", async () => {
  const { req, res } = fakeReqRes();
  const tracker = createArtifactLeaseTracker(req, res, {});
  tracker.activate(); // the HTTP layer calls this before the tool starts acquiring
  res.writableFinished = false;
  res.emit("close"); // the client resets while acquisition is still in flight — no lease exists yet
  await tracker.settled; // must settle even with nothing registered
  const late = fakeLease();
  assert.throws(() => tracker.register(late.lease), ArtifactLeaseTrackerError);
  await Promise.resolve();
  assert.deepEqual(late.calls, ["transport-failed"], "a lease acquired after the reset is immediately failed");
});

test("tracker: activate() is idempotent and a no-op once active", async () => {
  const { req, res } = fakeReqRes();
  const { lease, calls } = fakeLease();
  const tracker = createArtifactLeaseTracker(req, res, {});
  tracker.register(lease);
  tracker.activate(); // must not re-arm/duplicate listeners
  res.writableFinished = true;
  res.emit("finish");
  await tracker.settled;
  assert.deepEqual(calls, ["sent"]);
});

test("tracker: completeRequest() forces completion once (e.g. shutdown) and fences later events", async () => {
  const { req, res } = fakeReqRes();
  const { lease, calls } = fakeLease();
  const tracker = createArtifactLeaseTracker(req, res, {});
  tracker.register(lease);
  await tracker.completeRequest("transport-failed");
  assert.deepEqual(calls, ["transport-failed"]);
  res.writableFinished = true;
  res.emit("finish");
  assert.deepEqual(calls, ["transport-failed"], "the earlier forced outcome wins; finish is a no-op");
});

test("tracker: completeRequest() on an idle tracker (no lease ever registered) settles cleanly", async () => {
  const { req, res } = fakeReqRes();
  const tracker = createArtifactLeaseTracker(req, res, {});
  await tracker.completeRequest("transport-failed");
  await tracker.settled; // must not hang
});

test("tracker: references release BEFORE a deliberately deferred complete() settles (S3)", async () => {
  const { req, res } = fakeReqRes();
  const { lease, calls, resolveGate } = fakeLease({ deferred: true });
  let releasedBeforeSettle = false;
  const tracker = createArtifactLeaseTracker(req, res, {
    onReferencesReleased: () => {
      releasedBeforeSettle = true;
    },
  });
  tracker.register(lease);
  res.writableFinished = true;
  res.emit("finish");
  // The completion is deliberately deferred (the fake lease's complete() awaits an external gate),
  // so `settled` must NOT have resolved yet even though references were already released.
  let settledYet = false;
  tracker.settled.then(() => {
    settledYet = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(releasedBeforeSettle, true, "references released synchronously during terminalization");
  assert.equal(settledYet, false, "settled has not resolved while complete() is still pending");
  resolveGate();
  await tracker.settled;
  assert.equal(settledYet, true);
  assert.deepEqual(calls, ["sent"]);
});

test("batchContainsArtifactRetrieval: true only for a batch array containing the exact tool call", () => {
  assert.equal(batchContainsArtifactRetrieval([{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: ARTIFACT_TOOL_NAME } }]), true);
  assert.equal(
    batchContainsArtifactRetrieval([
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: ARTIFACT_TOOL_NAME } },
    ]),
    true,
    "anywhere in the batch",
  );
  assert.equal(batchContainsArtifactRetrieval([{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "retrieve" } }]), false);
  assert.equal(batchContainsArtifactRetrieval({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: ARTIFACT_TOOL_NAME } }), false, "not a batch at all");
  assert.equal(batchContainsArtifactRetrieval([null, 42, "x", { method: "tools/call" }, { params: {} }]), false, "hostile/malformed entries never throw");
  assert.equal(batchContainsArtifactRetrieval([]), false);
  assert.equal(batchContainsArtifactRetrieval(undefined), false);
});

test("isArtifactToolCall: true only for a single, well-shaped tool call to the artifact tool", () => {
  assert.equal(isArtifactToolCall({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: ARTIFACT_TOOL_NAME } }), true);
  assert.equal(isArtifactToolCall({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "retrieve" } }), false);
  assert.equal(isArtifactToolCall([{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: ARTIFACT_TOOL_NAME } }]), false, "batches never activate directly");
  assert.equal(isArtifactToolCall(null), false);
  assert.equal(isArtifactToolCall(undefined), false);
  assert.equal(isArtifactToolCall("nonsense"), false);
});
