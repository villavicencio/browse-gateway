import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, statSync, readFileSync, symlinkSync, chmodSync, writeFileSync, rmSync, readdirSync, linkSync, unlinkSync, fsyncSync, existsSync, rmdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../dist/artifacts/index.js";

const dirs = [];
function temp() { const dir = mkdtempSync(join(tmpdir(), "bgw-artifact-")); dirs.push(dir); return dir; }
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });
function source() { const path = join(temp(), "source.pdf"); writeFileSync(path, Buffer.from("%PDF-1.7\nhello")); return path; }

const STAGE_BYTES = 8 * 1024 * 1024, SOURCE_BYTES = 14;
const IDLE = { count: 0, bytes: 0, stagingBytes: 0, stagePermits: 0, stagePermitLimit: 2, responsePermitHeld: false, responseWaiters: 0, responseBytes: 0, consumers: 0 };
// `capture` runs synchronously into `afterPartFsync`, so flipping `arm` after the call pauses
// exactly the captures a test wants staging and lets the rest run to completion.
function stagingGate() { let arm = true, release; const held = new Promise((resolve) => { release = resolve; }); return { hook: () => (arm ? held : undefined), arm: () => { arm = true; }, disarm: () => { arm = false; }, release: () => release() }; }
// A staging capture shrinks to its exact size as soon as the source is stat'd, so proving that
// uncommitted bytes block admission needs a source big enough to matter against the cap.
function bigSource(bytes) { const path = join(temp(), "big.pdf"); writeFileSync(path, Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(bytes - 9)])); return path; }

// Deterministic scheduler: virtual time only, every registration retained so a test can fire a
// cancelled or post-close callback by hand and prove it is inert.
function fakeScheduler(start = 1_000_000) {
  let time = start, next = 1;
  const registrations = [], cleared = [], live = new Map();
  return {
    now: () => time,
    setTimeout(callback, delayMs) { const registration = { handle: next++, callback, delayMs, dueAt: time + delayMs }; registrations.push(registration); live.set(registration.handle, registration); return registration.handle; },
    clearTimeout(handle) { cleared.push(handle); live.delete(handle); },
    registrations, cleared,
    pending: () => Array.from(live.values()),
    registration: (delayMs) => registrations.find((r) => r.delayMs === delayMs),
    advance(ms) {
      const target = time + ms;
      for (;;) {
        const due = Array.from(live.values()).filter((r) => r.dueAt <= target).sort((a, b) => a.dueAt - b.dueAt)[0];
        if (!due) break;
        live.delete(due.handle); time = due.dueAt; due.callback();
      }
      time = target;
    },
  };
}

test("disabled store has no filesystem side effects", async () => {
  const root = join(temp(), "not-created");
  const store = new ArtifactStore({ enabled: false, root });
  assert.equal(store.enabled, false);
  assert.equal(await store.close(), undefined);
  assert.equal(readdirSync(join(root, ".."), { withFileTypes: true }).some((entry) => entry.name === "not-created"), false);
});

test("enabled store creates private root/data and exclusive lock", async () => {
  const root = join(temp(), "artifacts");
  const store = new ArtifactStore({ enabled: true, root });
  assert.equal(statSync(root).mode & 0o777, 0o700);
  assert.equal(statSync(join(root, "data")).mode & 0o777, 0o700);
  assert.equal(statSync(join(root, ".gateway-lock")).isDirectory(), true);
  await store.close();
});

test("existing root and data symlinks are rejected without touching targets", () => {
  const base = temp(), victim = join(base, "victim"), root = join(base, "artifacts");
  mkdirSync(join(victim, "data"), { recursive: true, mode: 0o700 }); writeFileSync(join(victim, "data", "sentinel"), "keep"); symlinkSync(victim, root);
  assert.throws(() => new ArtifactStore({ root }), e => e.code === "artifact-root-invalid"); assert.equal(readFileSync(join(victim, "data", "sentinel"), "utf8"), "keep"); assert.equal(existsSync(join(victim, ".gateway-lock")), false);
  rmSync(root); mkdirSync(root, { mode: 0o700 }); symlinkSync(victim, join(root, "data"));
  assert.throws(() => new ArtifactStore({ root }), e => e.code === "artifact-root-invalid"); assert.equal(readFileSync(join(victim, "data", "sentinel"), "utf8"), "keep");
});

test("matching startup symlink and directory are rejected and untouched", () => {
  for (const kind of ["symlink", "directory"]) {
    const base = temp(), root = join(base, "artifacts"), victim = join(base, "victim"), id = "Q".repeat(22);
    mkdirSync(join(root, "data"), { recursive: true, mode: 0o700 }); mkdirSync(victim, { mode: 0o700 }); writeFileSync(join(victim, "sentinel"), "keep");
    if (kind === "symlink") symlinkSync(victim, join(root, "data", `${id}.pdf`)); else mkdirSync(join(root, "data", `${id}.pdf`));
    assert.throws(() => new ArtifactStore({ root }), e => e.code === "artifact-root-invalid"); assert.equal(existsSync(join(root, "data", `${id}.pdf`)), true); assert.equal(readFileSync(join(victim, "sentinel"), "utf8"), "keep");
  }
});

test("recoverable boot validation failure rolls back this boot's lock", async () => {
  const root = join(temp(), "artifacts");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "data"), { mode: 0o700 });
  writeFileSync(join(root, "data", "unexpected"), "x");
  assert.throws(() => new ArtifactStore({ enabled: true, root }), e => e.code === "artifact-root-invalid");
  assert.equal(existsSync(join(root, ".gateway-lock")), false);
  unlinkSync(join(root, "data", "unexpected"));
  const store = new ArtifactStore({ enabled: true, root });
  assert.equal(existsSync(join(root, ".gateway-lock")), true);
  await store.close();
});

test("source is copied once with strict PDF magic, size and sha256", async () => {
  const root = join(temp(), "artifacts");
  const source = join(temp(), "source.pdf");
  writeFileSync(source, Buffer.from("%PDF-1.7\nhello"));
  const store = new ArtifactStore({ enabled: true, root });
  const result = await store.capture(source, { id: "A".repeat(22), consumerId: "owner" });
  assert.equal(result.status, "available");
  assert.equal(result.bytes, 14);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(readdirSync(join(root, "data")), [`${"A".repeat(22)}.pdf`]);
  await store.close();
});

test("post-link directory fsync failure rolls back both artifact names", async () => {
  const root = join(temp(), "artifacts");
  const source = join(temp(), "source.pdf");
  writeFileSync(source, Buffer.from("%PDF-1.7\nhello"));
  const store = new ArtifactStore({ enabled: true, root, fsOps: { linkSync, unlinkSync, fsyncSync: () => { throw new Error("fsync sentinel"); } } });
  const result = await store.capture(source, { id: "Z".repeat(22), consumerId: "owner" });
  assert.deepEqual(result, { status: "capture-failed", failure: "artifact-cleanup-failed" });
  assert.deepEqual(readdirSync(join(root, "data")), []);
  await store.close();
});

test("post-link part unlink failure poisons store and retains lock", async () => {
  const root = join(temp(), "artifacts"), source = join(temp(), "source.pdf");
  writeFileSync(source, Buffer.from("%PDF-1.7\nhello"));
  const sentinel = new Error("/private/sentinel");
  const ops = { linkSync, fsyncSync, unlinkSync(path) { if (path.endsWith(".part")) throw sentinel; return unlinkSync(path); } };
  const store = new ArtifactStore({ enabled: true, root, fsOps: ops });
  assert.deepEqual(await store.capture(source, { id: "Y".repeat(22), consumerId: "owner" }), { status: "capture-failed", failure: "artifact-cleanup-failed" });
  assert.deepEqual(await store.capture(source, { id: "X".repeat(22), consumerId: "owner" }), { status: "capture-failed", failure: "artifact-runtime-invalidated" });
  assert.equal(await store.acquire("Y".repeat(22), "owner"), null);
  assert.equal(existsSync(join(root, ".gateway-lock")), true);
  assert.throws(() => new ArtifactStore({ enabled: true, root }), (e) => e.code === "artifact-root-locked" && !String(e).includes("sentinel"));
  await store.close();
  assert.equal(existsSync(join(root, ".gateway-lock")), true);
});

test("discard failure retains available record and callback", async () => {
  const root = join(temp(), "artifacts"), source = join(temp(), "source.pdf"), id = "D".repeat(22); writeFileSync(source, Buffer.from("%PDF-1.7\nhello")); let callbacks = 0;
  const store = new ArtifactStore({ root, onDiscard: () => { callbacks++; }, fsOps: { linkSync, fsyncSync, unlinkSync(path) { if (path.endsWith(`${id}.pdf`)) throw new Error("unlink"); return unlinkSync(path); } } });
  assert.equal((await store.capture(source, { id, consumerId: "owner" })).status, "available"); assert.equal(store.discardArtifact(id), false); assert.equal(callbacks, 0); assert.equal(await store.acquire(id, "owner"), null); assert.equal(existsSync(join(root, ".gateway-lock")), true); await store.close();
});

test("rollback final unlink failure after dir fsync failure poisons store and retains lock", async () => {
  const root = join(temp(), "artifacts"), source = join(temp(), "source.pdf");
  writeFileSync(source, Buffer.from("%PDF-1.7\nhello"));
  const ops = { linkSync, fsyncSync() { throw new Error("fsync sentinel"); }, unlinkSync(path) { if (path.endsWith(".pdf")) throw new Error("unlink sentinel"); return unlinkSync(path); } };
  const store = new ArtifactStore({ enabled: true, root, fsOps: ops });
  assert.deepEqual(await store.capture(source, { id: "W".repeat(22), consumerId: "owner" }), { status: "capture-failed", failure: "artifact-cleanup-failed" });
  assert.equal(existsSync(join(root, ".gateway-lock")), true);
  await store.close();
  assert.equal(existsSync(join(root, ".gateway-lock")), true);
});


test("close after part fsync waits for capture and invalidates without publishing", async () => {
  const root = join(temp(), "artifacts"), source = join(temp(), "source.pdf"); writeFileSync(source, Buffer.from("%PDF-1.7\nhello"));
  let release; const paused = new Promise(resolve => { release = resolve; }); let reached; const seam = new Promise(resolve => { reached = resolve; });
  const store = new ArtifactStore({ root, afterPartFsync: async () => { reached(); await paused; } }); const id = "C".repeat(22); const pending = store.capture(source, { id, consumerId: "owner" }); await seam;
  const closing = store.close(); assert.equal(existsSync(join(root, ".gateway-lock")), true); release(); assert.deepEqual(await pending, { status: "capture-failed", failure: "artifact-runtime-invalidated" }); assert.equal(await closing, undefined); assert.equal(existsSync(join(root, ".gateway-lock")), false);
});

test("same-id in-flight capture is rejected without touching first part", async () => {
  const root = join(temp(), "artifacts"), source = join(temp(), "source.pdf"), id = "K".repeat(22); writeFileSync(source, Buffer.from("%PDF-1.7\nhello"));
  let release; const paused = new Promise(resolve => { release = resolve; }); let reached; const seam = new Promise(resolve => { reached = resolve; }); const store = new ArtifactStore({ root, afterPartFsync: async () => { reached(); await paused; } });
  const first = store.capture(source, { id, consumerId: "a" }); await seam; assert.deepEqual(await store.capture(source, { id, consumerId: "b" }), { status: "capture-failed", failure: "artifact-capacity" }); assert.equal(existsSync(join(root, "data", `${id}.part`)), true); release(); assert.equal((await first).status, "available"); assert.equal(existsSync(join(root, "data", `${id}.pdf`)), true); await store.close();
});

test("lock removal failure returns typed close failure and retains lock", async () => {
  const root = join(temp(), "artifacts"); const ops = { linkSync, unlinkSync, fsyncSync, rmdirSync() { throw new Error("rmdir sentinel"); } }; const store = new ArtifactStore({ root, fsOps: ops });
  assert.equal(await store.close(), "artifact-cleanup-failed"); assert.equal(existsSync(join(root, ".gateway-lock")), true);
});

test("post-link close cleanup failure is awaitable and retains the lock", async () => {
  const root = join(temp(), "artifacts"), source = join(temp(), "source.pdf"), id = "L".repeat(22);
  writeFileSync(source, Buffer.from("%PDF-1.7\nhello")); let release; const paused = new Promise(r => { release = r; }); let reached; const seam = new Promise(r => { reached = r; });
  const store = new ArtifactStore({ root, afterLinkBeforeCommit: async () => { reached(); await paused; }, fsOps: { linkSync, fsyncSync, unlinkSync(path) { if (path.endsWith(`${id}.pdf`)) throw new Error("/private/sentinel"); return unlinkSync(path); } } });
  const capture = store.capture(source, { id, consumerId: "owner" }); await seam; const closing = store.close(); assert.equal(existsSync(join(root, ".gateway-lock")), true); release();
  assert.equal(await closing, "artifact-cleanup-failed"); assert.equal((await capture).failure, "artifact-cleanup-failed"); assert.equal(existsSync(join(root, ".gateway-lock")), true); assert.throws(() => new ArtifactStore({ root }), e => e.code === "artifact-root-locked" && !String(e).includes("sentinel"));
});

test("clean post-link close invalidates capture and removes lock", async () => {
  const root = join(temp(), "artifacts"), source = join(temp(), "source.pdf"), id = "M".repeat(22);
  writeFileSync(source, Buffer.from("%PDF-1.7\nhello")); let release; const paused = new Promise(r => { release = r; }); let reached; const seam = new Promise(r => { reached = r; });
  const store = new ArtifactStore({ root, afterLinkBeforeCommit: async () => { reached(); await paused; } }); const capture = store.capture(source, { id, consumerId: "owner" }); await seam; const closing = store.close(); release();
  assert.deepEqual(await capture, { status: "capture-failed", failure: "artifact-runtime-invalidated" }); assert.equal(await closing, undefined); assert.deepEqual(readdirSync(join(root, "data")), []); assert.equal(existsSync(join(root, ".gateway-lock")), false);
});

test("close resolves cleanup failure when data readdir fails", async () => {
  const root = join(temp(), "artifacts"), ops = { linkSync, unlinkSync, fsyncSync, readdirSync() { throw new Error("/private/readdir-sentinel"); } };
  const store = new ArtifactStore({ root, fsOps: ops }); const first = store.close(); assert.equal(await first, "artifact-cleanup-failed"); assert.equal(await store.close(), "artifact-cleanup-failed"); assert.equal(existsSync(join(root, ".gateway-lock")), true);
});

test("startup cleanup unlink failure retains lock and hides raw errors", () => {
  const root = join(temp(), "artifacts"), id = "S".repeat(22); mkdirSync(root, { mode: 0o700 }); mkdirSync(join(root, "data"), { mode: 0o700 }); chmodSync(join(root, "data", ".."), 0o700); writeFileSync(join(root, "data", `${id}.part`), "part"); chmodSync(join(root, "data", `${id}.part`), 0o600);
  const sentinel = "/private/startup-sentinel"; assert.throws(() => new ArtifactStore({ root, fsOps: { linkSync, fsyncSync, unlinkSync() { throw new Error(sentinel); } } }), e => e.code === "artifact-cleanup-failed" && !String(e).includes(sentinel)); assert.equal(existsSync(join(root, ".gateway-lock")), true); assert.throws(() => new ArtifactStore({ root }), e => e.code === "artifact-root-locked");
});

test("startup cleanup fsync failure retains lock because deletion is not durable", () => {
  const root = join(temp(), "artifacts"), id = "F".repeat(22); mkdirSync(root, { mode: 0o700 }); mkdirSync(join(root, "data"), { mode: 0o700 }); writeFileSync(join(root, "data", `${id}.part`), "part"); chmodSync(join(root, "data", `${id}.part`), 0o600);
  assert.throws(() => new ArtifactStore({ root, fsOps: { linkSync, unlinkSync, fsyncSync() { throw new Error("/private/fsync-sentinel"); } } }), e => e.code === "artifact-cleanup-failed" && !String(e).includes("fsync-sentinel")); assert.equal(existsSync(join(root, ".gateway-lock")), true); assert.throws(() => new ArtifactStore({ root }), e => e.code === "artifact-root-locked");
});

test("startup validates every entry before deleting any valid entry", () => {
  const root = join(temp(), "artifacts"), valid = "A".repeat(22), invalid = "B".repeat(22);
  mkdirSync(root, { mode: 0o700 }); mkdirSync(join(root, "data"), { mode: 0o700 });
  const validPath = join(root, "data", `${valid}.pdf`); writeFileSync(validPath, "valid"); chmodSync(validPath, 0o600);
  mkdirSync(join(root, "data", `${invalid}.pdf`), { mode: 0o700 });
  assert.throws(() => new ArtifactStore({ root }), e => e.code === "artifact-root-invalid");
  assert.equal(readFileSync(validPath, "utf8"), "valid"); assert.equal(statSync(validPath).isFile(), true);
  assert.equal(existsSync(join(root, ".gateway-lock")), false);
});

test("discard observer failure does not poison store or prevent release", async () => {
  const root = join(temp(), "artifacts"), source = join(temp(), "source.pdf"), id = "O".repeat(22);
  writeFileSync(source, Buffer.from("%PDF-1.7\nhello"));
  const store = new ArtifactStore({ root, onDiscard: () => { throw new Error("observer sentinel"); } });
  assert.equal((await store.capture(source, { id, consumerId: "owner" })).status, "available"); assert.equal(store.discardArtifact(id), true);
  assert.equal(existsSync(join(root, "data", `${id}.pdf`)), false);
  assert.equal((await store.capture(source, { id, consumerId: "owner" })).status, "available");
  assert.equal(await store.close(), undefined); assert.equal(existsSync(join(root, ".gateway-lock")), false);
});

test("close retains failure from a record discard even when residual cleanup later succeeds", async () => {
  const root = join(temp(), "artifacts"), source = join(temp(), "source.pdf"), id = "V".repeat(22);
  writeFileSync(source, Buffer.from("%PDF-1.7\nhello")); let attempts = 0;
  const store = new ArtifactStore({ root, fsOps: { linkSync, fsyncSync, readdirSync, rmdirSync, unlinkSync(path) { if (path.endsWith(`${id}.pdf`) && attempts++ === 0) throw new Error("first discard"); return unlinkSync(path); } } });
  assert.equal((await store.capture(source, { id, consumerId: "owner" })).status, "available"); assert.equal(await store.close(), "artifact-cleanup-failed");
  assert.equal(existsSync(join(root, "data", `${id}.pdf`)), false); assert.equal(await store.close(), "artifact-cleanup-failed");
  assert.equal(existsSync(join(root, ".gateway-lock")), true);
});

test("periodic cleanup interval must be a finite positive integer", () => {
  for (const cleanupIntervalMs of [0, -1, 1.5, NaN, Infinity, "60000"]) {
    const root = join(temp(), "artifacts");
    assert.throws(() => new ArtifactStore({ root, cleanupIntervalMs }), (e) => e.code === "artifact-config-invalid");
    assert.equal(existsSync(root), false);
  }
});

test("expiry is decided by the injected scheduler at the exact TTL boundary", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), clock = fakeScheduler(), discarded = [];
  const early = "E".repeat(22), exact = "X".repeat(22);
  const store = new ArtifactStore({ root, scheduler: clock, ttlMs: 1000, onDiscard: (id) => discarded.push(id) });
  const record = await store.capture(pdf, { id: early, consumerId: "owner" });
  assert.equal(record.createdAt, clock.now());
  assert.equal(record.expiresAt, clock.now() + 1000);
  assert.equal((await store.capture(pdf, { id: exact, consumerId: "owner" })).status, "available");
  clock.advance(999);
  const lease = await store.acquire(early, "owner");
  assert.ok(lease, "now === expiresAt - 1 must remain available");
  lease.complete();
  clock.advance(1);
  assert.equal(await store.acquire(exact, "owner"), null);
  assert.deepEqual(readdirSync(join(root, "data")), []);
  assert.deepEqual(discarded, [early, exact]);
  await store.close();
});

test("response lease deadline and timeout advance only on the injected scheduler", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), clock = fakeScheduler(), discarded = [], id = "T".repeat(22);
  const store = new ArtifactStore({ root, scheduler: clock, onDiscard: (i) => discarded.push(i) });
  assert.equal((await store.capture(pdf, { id, consumerId: "owner" })).status, "available");
  const wallBefore = Date.now();
  const lease = await store.acquire(id, "owner");
  assert.ok(lease);
  assert.equal(lease.deadline, clock.now() + 15_000);
  assert.ok(clock.pending().some((r) => r.delayMs === 15_000), "lease timeout must be registered on the injected scheduler");
  clock.advance(14_999);
  assert.deepEqual(discarded, []);
  assert.equal(existsSync(join(root, "data", `${id}.pdf`)), true);
  clock.advance(1);
  assert.deepEqual(discarded, [id]);
  assert.equal(existsSync(join(root, "data", `${id}.pdf`)), false);
  assert.equal(await store.acquire(id, "owner"), null);
  lease.complete(); lease.complete();
  assert.deepEqual(discarded, [id]);
  assert.ok(Date.now() - wallBefore < 15_000, "ambient wall time must be irrelevant");
  await store.close();
});

test("lease completion cancels the timeout and later time advance is inert", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), clock = fakeScheduler(), discarded = [], id = "C".repeat(22);
  const store = new ArtifactStore({ root, scheduler: clock, onDiscard: (i) => discarded.push(i) });
  assert.equal((await store.capture(pdf, { id, consumerId: "owner" })).status, "available");
  const lease = await store.acquire(id, "owner");
  assert.ok(lease);
  const timeout = clock.registration(15_000);
  lease.complete();
  assert.equal(clock.cleared.includes(timeout.handle), true);
  assert.deepEqual(discarded, [id]);
  assert.equal((await store.capture(pdf, { id, consumerId: "owner" })).status, "available");
  clock.advance(60_000);
  assert.deepEqual(discarded, [id]);
  assert.equal(existsSync(join(root, "data", `${id}.pdf`)), true);
  lease.complete();
  assert.deepEqual(discarded, [id]);
  await store.close();
});

test("periodic cleanup defaults to 60s, is single-flight, and reschedules only after settlement", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), clock = fakeScheduler(), discarded = [];
  const first = "A".repeat(22), second = "B".repeat(22);
  let reentering = false, nested = false, registrationsDuringPass = -1, passes = 0;
  const store = new ArtifactStore({ root, scheduler: clock, ttlMs: 1000, onDiscard: (id) => discarded.push(id), onCleanupPass: () => {
    if (reentering) { nested = true; return; }
    passes++;
    reentering = true; periodic.callback(); reentering = false;
    registrationsDuringPass = clock.registrations.length;
  } });
  const periodic = clock.registration(60_000);
  assert.ok(periodic, "constructor must schedule the default 60s cleanup on the injected scheduler");
  assert.equal(clock.registrations.length, 1);
  assert.equal((await store.capture(pdf, { id: first, consumerId: "owner" })).status, "available");
  assert.equal((await store.capture(pdf, { id: second, consumerId: "owner" })).status, "available");
  clock.advance(60_000);
  assert.equal(nested, false, "a second pass must not enter while one is running");
  assert.equal(passes, 1);
  assert.equal(registrationsDuringPass, 1, "the next schedule must not be established mid-pass");
  assert.equal(clock.registrations.length, 2);
  assert.equal(clock.registration(60_000).delayMs, 60_000);
  assert.deepEqual(discarded.slice().sort(), [first, second].sort());
  assert.deepEqual(readdirSync(join(root, "data")), []);
  await store.close();
});

test("close cancels artifact timers and post-close callbacks cannot mutate state", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), clock = fakeScheduler(), discarded = [], id = "L".repeat(22);
  let unlinks = 0;
  const ops = { linkSync, fsyncSync, unlinkSync(path) { unlinks++; return unlinkSync(path); } };
  const store = new ArtifactStore({ root, scheduler: clock, fsOps: ops, onDiscard: (i) => discarded.push(i) });
  assert.equal((await store.capture(pdf, { id, consumerId: "owner" })).status, "available");
  const lease = await store.acquire(id, "owner");
  assert.ok(lease);
  const periodic = clock.registration(60_000), timeout = clock.registration(15_000);
  assert.equal(await store.close(), undefined);
  assert.equal(clock.pending().length, 0);
  assert.equal(clock.cleared.includes(periodic.handle), true);
  assert.equal(clock.cleared.includes(timeout.handle), true);
  assert.deepEqual(discarded, [id]);
  const settled = unlinks;
  periodic.callback(); timeout.callback(); lease.complete();
  assert.equal(unlinks, settled, "no post-close callback may attempt filesystem mutation");
  assert.deepEqual(discarded, [id]);
  assert.equal(clock.registrations.length, 2, "close must not leave the periodic pass rescheduling");
  assert.equal(existsSync(join(root, ".gateway-lock")), false);
});

test("a staging capture holds its global count slot before it is committed", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), gate = stagingGate();
  const committed = "A".repeat(22), staging = "B".repeat(22), rejected = "C".repeat(22);
  const store = new ArtifactStore({ root, maxCount: 2, afterPartFsync: gate.hook });
  gate.disarm();
  assert.equal((await store.capture(pdf, { id: committed, consumerId: "one" })).status, "available");
  gate.arm();
  const pending = store.capture(pdf, { id: staging, consumerId: "two" });
  gate.disarm();
  assert.deepEqual(await store.capture(pdf, { id: rejected, consumerId: "three" }), { status: "capture-failed", failure: "artifact-capacity" });
  assert.equal(existsSync(join(root, "data", `${rejected}.part`)), false, "a rejected reservation must not create a destination file");
  assert.equal(store.accounting().count, 2);
  gate.release();
  assert.equal((await pending).status, "available");
  await store.close();
});

test("per-consumer count reservation includes that consumer's staging capture", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), gate = stagingGate();
  const first = "D".repeat(22), second = "E".repeat(22);
  const store = new ArtifactStore({ root, perConsumerCount: 1, afterPartFsync: gate.hook });
  const pending = store.capture(pdf, { id: first, consumerId: "owner" });
  gate.disarm();
  assert.deepEqual(await store.capture(pdf, { id: second, consumerId: "owner" }), { status: "capture-failed", failure: "artifact-capacity" });
  assert.equal(existsSync(join(root, "data", `${second}.part`)), false);
  assert.equal((await store.capture(pdf, { id: second, consumerId: "other" })).status, "available");
  gate.release();
  assert.equal((await pending).status, "available");
  await store.close();
});

test("staging bytes block aggregate over-admission while nothing is committed", async () => {
  const root = join(temp(), "artifacts"), big = bigSource(5 * 1024 * 1024), pdf = source(), gate = stagingGate();
  const first = "F".repeat(22), second = "G".repeat(22);
  const store = new ArtifactStore({ root, maxBytes: 12 * 1024 * 1024, afterPartFsync: gate.hook });
  const pending = store.capture(big, { id: first, consumerId: "one" });
  gate.disarm();
  // 5 MiB staging + an 8 MiB admission exceeds the 12 MiB cap, with no record committed anywhere.
  assert.deepEqual(await store.capture(pdf, { id: second, consumerId: "two" }), { status: "capture-failed", failure: "artifact-capacity" });
  assert.equal(existsSync(join(root, "data", `${second}.part`)), false);
  assert.equal(store.accounting().stagingBytes, 5 * 1024 * 1024, "an uncommitted copy still holds its exact bytes");
  gate.release();
  assert.equal((await pending).status, "available");
  // A committed 5 MiB artifact still leaves no room for an 8 MiB admission under a 12 MiB cap.
  assert.deepEqual(await store.capture(pdf, { id: second, consumerId: "two" }), { status: "capture-failed", failure: "artifact-capacity" });
  assert.equal(store.discardArtifact(first), true);
  assert.equal((await store.capture(pdf, { id: second, consumerId: "two" })).status, "available");
  await store.close();
});

test("per-consumer staging bytes are reserved independently of other consumers", async () => {
  const root = join(temp(), "artifacts"), big = bigSource(5 * 1024 * 1024), pdf = source(), gate = stagingGate();
  const first = "H".repeat(22), blocked = "I".repeat(22), other = "J".repeat(22);
  const store = new ArtifactStore({ root, perConsumerBytes: 12 * 1024 * 1024, afterPartFsync: gate.hook });
  const pending = store.capture(big, { id: first, consumerId: "owner" });
  gate.disarm();
  assert.deepEqual(await store.capture(pdf, { id: blocked, consumerId: "owner" }), { status: "capture-failed", failure: "artifact-capacity" });
  assert.equal(existsSync(join(root, "data", `${blocked}.part`)), false);
  assert.equal((await store.capture(pdf, { id: other, consumerId: "stranger" })).status, "available");
  gate.release();
  assert.equal((await pending).status, "available");
  await store.close();
});

test("exact source size releases the unused byte reservation promptly", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), gate = stagingGate(), id = "K".repeat(22);
  const store = new ArtifactStore({ root, afterPartFsync: gate.hook });
  const pending = store.capture(pdf, { id, consumerId: "owner" });
  gate.disarm();
  assert.deepEqual(store.accounting(), { ...IDLE, count: 1, bytes: SOURCE_BYTES, stagingBytes: SOURCE_BYTES, stagePermits: 1, consumers: 1 }, "the pessimistic reservation must shrink to the exact size before the copy completes");
  gate.release();
  assert.equal((await pending).status, "available");
  assert.deepEqual(store.accounting(), { ...IDLE, count: 1, bytes: SOURCE_BYTES, consumers: 1 });
  await store.close();
});

test("every terminal capture and lease path releases its reservation exactly once", async () => {
  const pdf = source(), id = "L".repeat(22);
  const tiny = join(temp(), "tiny.pdf"); writeFileSync(tiny, Buffer.from("%PD"));
  const notPdf = join(temp(), "plain.pdf"); writeFileSync(notPdf, Buffer.from("plain text, not a pdf"));
  const oversize = join(temp(), "big.pdf"); writeFileSync(oversize, Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(STAGE_BYTES)]));
  const failures = [[tiny, "artifact-not-pdf"], [notPdf, "artifact-integrity-failed"], [oversize, "artifact-size-limit"]];
  for (const [path, failure] of failures) {
    const store = new ArtifactStore({ root: join(temp(), "artifacts") });
    assert.deepEqual(await store.capture(path, { id, consumerId: "owner" }), { status: "capture-failed", failure });
    assert.deepEqual(store.accounting(), IDLE);
    await store.close();
  }
  { // write failure with confirmed rollback
    const store = new ArtifactStore({ root: join(temp(), "artifacts"), fsOps: { unlinkSync, fsyncSync, linkSync() { throw new Error("/private/link-sentinel"); } } });
    assert.deepEqual(await store.capture(pdf, { id, consumerId: "owner" }), { status: "capture-failed", failure: "artifact-write-failed" });
    assert.deepEqual(store.accounting(), IDLE);
    await store.close();
  }
  { // completion, repeated completion and repeated discard
    const store = new ArtifactStore({ root: join(temp(), "artifacts") });
    assert.equal((await store.capture(pdf, { id, consumerId: "owner" })).status, "available");
    const lease = await store.acquire(id, "owner"); assert.ok(lease);
    assert.deepEqual(store.accounting(), { ...IDLE, count: 1, bytes: SOURCE_BYTES, consumers: 1, responsePermitHeld: true, responseBytes: SOURCE_BYTES });
    lease.complete(); lease.complete();
    assert.equal(store.discardArtifact(id), true); assert.equal(store.discardArtifact(id), true);
    assert.deepEqual(store.accounting(), IDLE);
    await store.close();
  }
  { // explicit discard of an available artifact
    const store = new ArtifactStore({ root: join(temp(), "artifacts") });
    assert.equal((await store.capture(pdf, { id, consumerId: "owner" })).status, "available");
    assert.equal(store.discardArtifact(id), true);
    assert.deepEqual(store.accounting(), IDLE);
    await store.close();
  }
  { // expiry and lease timeout on the injected clock
    const clock = fakeScheduler(), store = new ArtifactStore({ root: join(temp(), "artifacts"), scheduler: clock, ttlMs: 1000 });
    assert.equal((await store.capture(pdf, { id, consumerId: "owner" })).status, "available");
    clock.advance(60_000); // the periodic pass reaps the expired record and releases its reservation
    assert.deepEqual(store.accounting(), IDLE);
    assert.equal((await store.capture(pdf, { id, consumerId: "owner" })).status, "available");
    const lease = await store.acquire(id, "owner"); assert.ok(lease);
    clock.advance(15_000);
    assert.deepEqual(store.accounting(), IDLE);
    lease.complete();
    assert.deepEqual(store.accounting(), IDLE);
    await store.close();
  }
  { // clean close
    const store = new ArtifactStore({ root: join(temp(), "artifacts") });
    assert.equal((await store.capture(pdf, { id, consumerId: "owner" })).status, "available");
    assert.equal(await store.close(), undefined);
    assert.deepEqual(store.accounting(), IDLE);
  }
});

test("unconfirmed cleanup retains reserved count and bytes instead of freeing capacity", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), id = "M".repeat(22);
  const store = new ArtifactStore({ root, fsOps: { linkSync, fsyncSync, unlinkSync(path) { if (path.endsWith(`${id}.pdf`)) throw new Error("/private/unlink-sentinel"); return unlinkSync(path); } } });
  assert.equal((await store.capture(pdf, { id, consumerId: "owner" })).status, "available");
  assert.equal(store.discardArtifact(id), false);
  const retained = { ...IDLE, count: 1, bytes: SOURCE_BYTES, consumers: 1 };
  assert.deepEqual(store.accounting(), retained, "an undeleted artifact's capacity must not become reusable");
  assert.equal(await store.close(), "artifact-cleanup-failed");
  assert.deepEqual(store.accounting(), retained, "close must not fabricate zero accounting for unconfirmed cleanup");
  assert.equal(existsSync(join(root, ".gateway-lock")), true);
});

test("a stale lease cannot release a replacement reservation or the live response permit", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), clock = fakeScheduler(), discarded = [], id = "N".repeat(22);
  const store = new ArtifactStore({ root, scheduler: clock, onDiscard: (i) => discarded.push(i) });
  assert.equal((await store.capture(pdf, { id, consumerId: "owner" })).status, "available");
  const stale = await store.acquire(id, "owner"); assert.ok(stale);
  const staleTimeout = clock.registration(15_000);
  clock.advance(15_000);
  assert.deepEqual(discarded, [id]);
  assert.deepEqual(store.accounting(), IDLE);
  assert.equal((await store.capture(pdf, { id, consumerId: "owner" })).status, "available");
  const fresh = await store.acquire(id, "owner"); assert.ok(fresh, "the replacement artifact must be leasable");
  const live = store.accounting();
  stale.complete(); staleTimeout.callback();
  assert.deepEqual(store.accounting(), live, "a stale token must not touch the replacement's accounting");
  assert.equal(store.accounting().responsePermitHeld, true);
  assert.equal(existsSync(join(root, "data", `${id}.pdf`)), true);
  fresh.complete();
  assert.deepEqual(store.accounting(), IDLE);
  assert.deepEqual(discarded, [id, id]);
  await store.close();
});

test("at most two stage copies run and a third fails before creating a destination file", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), gate = stagingGate();
  const a = "O".repeat(22), b = "P".repeat(22), c = "Q".repeat(22);
  const store = new ArtifactStore({ root, afterPartFsync: gate.hook });
  const first = store.capture(pdf, { id: a, consumerId: "one" });
  const second = store.capture(pdf, { id: b, consumerId: "two" });
  gate.disarm();
  assert.deepEqual(await store.capture(pdf, { id: c, consumerId: "three" }), { status: "capture-failed", failure: "artifact-capacity" });
  assert.equal(existsSync(join(root, "data", `${c}.part`)), false);
  assert.deepEqual(readdirSync(join(root, "data")).sort(), [`${a}.part`, `${b}.part`].sort());
  assert.equal(store.accounting().stagePermits, 2);
  assert.equal(store.accounting().stagePermitLimit, 2);
  gate.release();
  assert.equal((await first).status, "available");
  assert.equal((await second).status, "available");
  assert.equal(store.accounting().stagePermits, 0, "a rejected stage must leak no permit");
  assert.equal((await store.capture(pdf, { id: c, consumerId: "three" })).status, "available");
  await store.close();
});

test("one global response permit serializes leases and starts the deadline after admission", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), clock = fakeScheduler();
  const a = "R".repeat(22), b = "S".repeat(22);
  const store = new ArtifactStore({ root, scheduler: clock });
  assert.equal((await store.capture(pdf, { id: a, consumerId: "owner" })).status, "available");
  assert.equal((await store.capture(pdf, { id: b, consumerId: "owner" })).status, "available");
  const first = await store.acquire(a, "owner"); assert.ok(first);
  assert.equal(first.deadline, clock.now() + 15_000);
  const waiting = store.acquire(b, "owner");
  await Promise.resolve(); await Promise.resolve();
  assert.equal(await Promise.race([waiting, Promise.resolve("waiting")]), "waiting", "a second lease must not be granted while the permit is held");
  assert.equal(store.accounting().responseWaiters, 1);
  assert.equal(clock.pending().filter((r) => r.delayMs === 15_000).length, 1, "a waiting acquire must not start a lease deadline");
  assert.equal(existsSync(join(root, "data", `${b}.pdf`)), true, "a waiting acquire must not touch its artifact");
  clock.advance(5_000);
  first.complete();
  const second = await waiting;
  assert.ok(second);
  assert.equal(second.deadline, clock.now() + 15_000, "the 15s lease must start at admission, not at request");
  assert.deepEqual(store.accounting(), { ...IDLE, count: 1, bytes: SOURCE_BYTES, consumers: 1, responsePermitHeld: true, responseBytes: SOURCE_BYTES });
  second.complete();
  assert.deepEqual(store.accounting(), IDLE);
  await store.close();
});

test("a lease timeout admits exactly one waiter and close cancels the rest", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), clock = fakeScheduler();
  const a = "T".repeat(22), b = "U".repeat(22), c = "V".repeat(22);
  const store = new ArtifactStore({ root, scheduler: clock });
  for (const id of [a, b, c]) assert.equal((await store.capture(pdf, { id, consumerId: "owner" })).status, "available");
  const first = await store.acquire(a, "owner"); assert.ok(first);
  const secondPending = store.acquire(b, "owner"), thirdPending = store.acquire(c, "owner");
  await Promise.resolve(); await Promise.resolve();
  assert.equal(await Promise.race([secondPending, Promise.resolve("waiting")]), "waiting", "a held permit must block every waiter");
  assert.equal(store.accounting().responseWaiters, 2);
  clock.advance(15_000);
  const second = await secondPending;
  assert.ok(second, "a lease timeout must admit the first waiter");
  assert.equal(await Promise.race([thirdPending, Promise.resolve("waiting")]), "waiting", "a timeout must admit exactly one waiter");
  assert.equal(store.accounting().responseWaiters, 1);
  const closing = store.close();
  assert.equal(await thirdPending, null, "close must cancel a waiting acquire");
  assert.equal(await closing, undefined);
  assert.deepEqual(store.accounting(), IDLE, "close must release clean reservations and permits");
  assert.equal(existsSync(join(root, ".gateway-lock")), false);
});

test("poisoning the store settles held and queued response ownership", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), clock = fakeScheduler();
  const held = "W".repeat(22), queued = "X".repeat(22), poison = "Y".repeat(22);
  let unlinks = 0;
  const store = new ArtifactStore({ root, scheduler: clock, fsOps: { linkSync, fsyncSync, unlinkSync(path) { unlinks++; if (path.endsWith(`${poison}.pdf`)) throw new Error("/private/unlink-sentinel"); return unlinkSync(path); } } });
  for (const id of [held, queued, poison]) assert.equal((await store.capture(pdf, { id, consumerId: "owner" })).status, "available");
  const lease = await store.acquire(held, "owner"); assert.ok(lease);
  const waiting = store.acquire(queued, "owner");
  await Promise.resolve(); await Promise.resolve();
  assert.equal(store.accounting().responseWaiters, 1);
  // An unrelated artifact's unconfirmed cleanup poisons the store while one lease holds the
  // response permit and another waits behind it.
  assert.equal(store.discardArtifact(poison), false);
  const stranded = new Promise((resolve) => { setImmediate(() => resolve("still waiting")); });
  assert.equal(await Promise.race([waiting, stranded]), null, "a poisoned store must refuse a queued acquire, not strand it");
  const settled = { ...IDLE, count: 3, bytes: 3 * SOURCE_BYTES, consumers: 1 };
  assert.deepEqual(store.accounting(), settled, "response ownership settles while unconfirmed-cleanup capacity stays retained");
  assert.equal(clock.pending().length, 0, "poisoning must cancel artifact timers");
  const mutations = unlinks;
  clock.advance(60_000); lease.complete(); lease.complete();
  assert.equal(unlinks, mutations, "no post-poison callback may attempt filesystem mutation");
  assert.deepEqual(store.accounting(), settled);
  assert.equal(await store.close(), "artifact-cleanup-failed");
  assert.equal(existsSync(join(root, ".gateway-lock")), true);
});

test("a replaced root refuses publication and acquire without touching the replacement", async () => {
  const base = temp(), root = join(base, "artifacts"), pdf = source(), original = join(base, "original"), kept = "A".repeat(22);
  const store = new ArtifactStore({ root });
  assert.equal((await store.capture(pdf, { id: kept, consumerId: "owner" })).status, "available");
  renameSync(root, original);
  mkdirSync(join(root, "data"), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, "data", "sentinel"), "keep");
  assert.deepEqual(await store.capture(pdf, { id: "B".repeat(22), consumerId: "owner" }), { status: "capture-failed", failure: "artifact-runtime-invalidated" });
  assert.equal(await store.acquire(kept, "owner"), null);
  assert.deepEqual(readdirSync(join(root, "data")), ["sentinel"], "no work may create anything in the replacement tree");
  assert.equal(readFileSync(join(root, "data", "sentinel"), "utf8"), "keep");
  assert.equal(await store.close(), "artifact-cleanup-failed");
  assert.equal(existsSync(join(root, ".gateway-lock")), false, "close must not create or remove a lock in the replacement");
  assert.equal(existsSync(join(original, ".gateway-lock")), true, "unproven ownership retains the original lock");
  assert.equal(existsSync(join(original, "data", `${kept}.pdf`)), true, "cleanup is skipped where ownership is unproven");
});

test("a replaced data directory is never published into, discarded through or deleted", async () => {
  const base = temp(), root = join(base, "artifacts"), pdf = source(), data = join(root, "data"), moved = join(base, "moved"), kept = "C".repeat(22);
  const store = new ArtifactStore({ root });
  assert.equal((await store.capture(pdf, { id: kept, consumerId: "owner" })).status, "available");
  renameSync(data, moved);
  mkdirSync(data, { mode: 0o700 });
  const decoy = join(data, `${kept}.pdf`); writeFileSync(decoy, "decoy"); chmodSync(decoy, 0o600);
  assert.deepEqual(await store.capture(pdf, { id: "D".repeat(22), consumerId: "owner" }), { status: "capture-failed", failure: "artifact-runtime-invalidated" });
  assert.deepEqual(readdirSync(data), [`${kept}.pdf`], "publication must create nothing in the replacement");
  assert.equal(store.discardArtifact(kept), false, "discard must refuse while data identity is unproven");
  assert.equal(readFileSync(decoy, "utf8"), "decoy", "discard must not delete through the replacement");
  assert.equal(await store.close(), "artifact-cleanup-failed");
  assert.equal(readFileSync(decoy, "utf8"), "decoy", "close must not delete through the replacement");
  assert.equal(existsSync(join(root, ".gateway-lock")), true, "uncertainty retains the lock");
});

test("an injected owner, mode or type change fails closed with no raw detail", async () => {
  for (const change of [{ uid: 4_294_967_290 }, { mode: 0o777 }, { directory: false }]) {
    const root = join(temp(), "artifacts"), pdf = source(), kept = "E".repeat(22);
    let armed = false; const observed = [];
    const store = new ArtifactStore({ root, identityOverride: function (...args) { observed.push(args); return armed ? change : undefined; } });
    assert.equal((await store.capture(pdf, { id: kept, consumerId: "owner" })).status, "available");
    armed = true;
    const refused = await store.capture(pdf, { id: "F".repeat(22), consumerId: "owner" });
    assert.deepEqual(refused, { status: "capture-failed", failure: "artifact-runtime-invalidated" });
    assert.equal(JSON.stringify(refused).includes(root), false, "a closed failure carries no path");
    assert.equal(await store.acquire(kept, "owner"), null);
    assert.equal(await store.close(), "artifact-cleanup-failed");
    assert.equal(existsSync(join(root, ".gateway-lock")), true);
    assert.equal(existsSync(join(root, "data", `${kept}.pdf`)), true);
    // The selector is told which directory and which reading, and nothing else: no path, no
    // descriptor number, no observed stat, no private value it could report back.
    assert.ok(observed.length > 0);
    for (const args of observed) {
      assert.equal(args.length, 2, "the identity seam takes exactly two closed-enum arguments");
      assert.ok(["root", "data"].includes(args[0]));
      assert.ok(["descriptor", "path"].includes(args[1]));
    }
  }
});

test("an unreadable retained descriptor refuses later work and still closes", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), kept = "G".repeat(22);
  let armed = false;
  const store = new ArtifactStore({ root, identityOverride: (_target, source) => (armed && source === "descriptor" ? "unreadable" : undefined) });
  assert.equal((await store.capture(pdf, { id: kept, consumerId: "owner" })).status, "available");
  armed = true;
  assert.equal(await store.acquire(kept, "owner"), null);
  assert.deepEqual(await store.capture(pdf, { id: "H".repeat(22), consumerId: "owner" }), { status: "capture-failed", failure: "artifact-runtime-invalidated" });
  assert.equal(store.discardArtifact(kept), false);
  assert.equal(await store.close(), "artifact-cleanup-failed");
  assert.equal(await store.close(), "artifact-cleanup-failed", "close stays total and idempotent");
  assert.equal(existsSync(join(root, "data", `${kept}.pdf`)), true, "cleanup is skipped where ownership is unproven");
  assert.equal(existsSync(join(root, ".gateway-lock")), true);
});

test("directory fsync uses the retained data descriptor after startup", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), id = "I".repeat(22);
  let pathOpens = 0;
  const store = new ArtifactStore({ root, onDataPathOpen: () => { pathOpens++; } });
  assert.equal(pathOpens, 1, "startup opens the data directory by path exactly once, to retain its descriptor");
  assert.equal((await store.capture(pdf, { id, consumerId: "owner" })).status, "available");
  assert.equal(store.discardArtifact(id), true);
  assert.equal(existsSync(join(root, "data", `${id}.pdf`)), false, "the durable deletion really happened");
  assert.equal(pathOpens, 1, "no data directory reopen by path after startup");
  assert.equal(await store.close(), undefined);
  assert.equal(pathOpens, 1);
});

test("a constructor failure after the first descriptor closes it and rolls back the boot lock", async () => {
  const root = join(temp(), "artifacts");
  let closes = 0;
  assert.throws(() => new ArtifactStore({ root, onDescriptorClose: () => { closes++; }, afterRootDescriptor: () => { rmdirSync(join(root, "data")); } }), (e) => e.code === "artifact-root-invalid" && !String(e).includes(root));
  assert.equal(closes, 1, "the one descriptor this boot owned is closed exactly once");
  assert.equal(existsSync(join(root, ".gateway-lock")), false, "a pre-mutation failure rolls back this boot's lock");
  const store = new ArtifactStore({ root });
  assert.equal(existsSync(join(root, ".gateway-lock")), true, "the released lock lets a later boot start");
  assert.equal(await store.close(), undefined);
});

test("a root replaced during the commit window refuses to publish and retains everything", async () => {
  const base = temp(), root = join(base, "artifacts"), pdf = source(), original = join(base, "original"), id = "K".repeat(22);
  let release; const held = new Promise((r) => { release = r; }); let reached; const seam = new Promise((r) => { reached = r; });
  const store = new ArtifactStore({ root, afterLinkBeforeCommit: async () => { reached(); await held; } });
  const pending = store.capture(pdf, { id, consumerId: "owner" });
  await seam;
  // The link has landed but the record has not. Swap the root inside that commit window.
  renameSync(root, original);
  mkdirSync(join(root, "data"), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, "data", "sentinel"), "keep");
  release();
  assert.deepEqual(await pending, { status: "capture-failed", failure: "artifact-runtime-invalidated" }, "identity must be reproven immediately before the record is committed");
  assert.equal(await store.acquire(id, "owner"), null, "nothing may be published out of an unprovable tree");
  assert.deepEqual(readdirSync(join(root, "data")), ["sentinel"], "the replacement tree stays untouched");
  assert.equal(readFileSync(join(root, "data", "sentinel"), "utf8"), "keep");
  assert.equal(existsSync(join(original, "data", `${id}.pdf`)), true, "the uncertain artifact is retained, not deleted");
  assert.deepEqual(store.accounting(), { ...IDLE, count: 1, bytes: SOURCE_BYTES, consumers: 1 }, "its capacity stays reserved");
  assert.equal(await store.close(), "artifact-cleanup-failed");
  assert.equal(existsSync(join(original, ".gateway-lock")), true, "uncertainty retains the lock");
});

test("a public discard after a clean close performs no mutation at all", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), id = "L".repeat(22), stray = "M".repeat(22);
  let unlinks = 0, fsyncs = 0, discards = 0;
  const store = new ArtifactStore({ root, onDiscard: () => { discards++; }, fsOps: { linkSync, unlinkSync(path) { unlinks++; return unlinkSync(path); }, fsyncSync(fd) { fsyncs++; return fsyncSync(fd); } } });
  assert.equal((await store.capture(pdf, { id, consumerId: "owner" })).status, "available");
  assert.equal(await store.close(), undefined);
  const sentinel = join(root, "data", `${stray}.pdf`);
  writeFileSync(sentinel, "sentinel bytes"); chmodSync(sentinel, 0o600);
  const before = { unlinks, fsyncs, discards };
  assert.equal(store.discardArtifact(stray), false, "a disposed store refuses a public discard rather than acting on a tree it no longer owns");
  assert.equal(readFileSync(sentinel, "utf8"), "sentinel bytes", "a closed store must not delete through its former data directory");
  assert.deepEqual({ unlinks, fsyncs, discards }, before, "a closed store's discard performs no unlink, fsync or callback");
});

test("a public discard is refused from the moment close begins", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), clock = fakeScheduler(), gate = stagingGate();
  const id = "N".repeat(22), stray = "O".repeat(22);
  let unlinks = 0, fsyncs = 0, discards = 0;
  const store = new ArtifactStore({ root, scheduler: clock, afterPartFsync: gate.hook, onDiscard: () => { discards++; },
    fsOps: { linkSync, unlinkSync(path) { unlinks++; return unlinkSync(path); }, fsyncSync(fd) { fsyncs++; return fsyncSync(fd); } } });
  const pending = store.capture(pdf, { id, consumerId: "owner" });
  gate.disarm();
  // Close has begun but cannot finish: it is still waiting on the active capture, so the descriptors
  // are open and the store is not yet disposed.
  const closing = store.close();
  const sentinel = join(root, "data", `${stray}.pdf`);
  writeFileSync(sentinel, "sentinel bytes"); chmodSync(sentinel, 0o600);
  const before = { unlinks, fsyncs, discards, cleared: clock.cleared.length, waiters: store.accounting().responseWaiters };
  assert.equal(store.discardArtifact(stray), false, "a closing store refuses a public discard");
  assert.equal(readFileSync(sentinel, "utf8"), "sentinel bytes", "a closing store must not delete through its data directory");
  assert.deepEqual({ unlinks, fsyncs, discards, cleared: clock.cleared.length, waiters: store.accounting().responseWaiters }, before, "a refused discard performs no unlink, fsync, callback, timer or settlement mutation");
  gate.release();
  assert.deepEqual(await pending, { status: "capture-failed", failure: "artifact-runtime-invalidated" });
  assert.equal(await closing, undefined);
  // Close's own identity-bound cleanup still sweeps strict artifact files it owns — that path is
  // private and is exactly what the public refusal above does not do.
  assert.equal(existsSync(sentinel), false);
  assert.deepEqual(readdirSync(join(root, "data")), []);
  assert.equal(existsSync(join(root, ".gateway-lock")), false);
});

test("close closes both retained descriptors exactly once", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), id = "J".repeat(22);
  let closes = 0;
  const store = new ArtifactStore({ root, onDescriptorClose: () => { closes++; } });
  assert.equal((await store.capture(pdf, { id, consumerId: "owner" })).status, "available");
  assert.equal(closes, 0, "descriptors stay open while the store is live");
  assert.equal(await store.close(), undefined);
  assert.equal(closes, 2, "root and data descriptors each close exactly once");
  assert.equal(await store.close(), undefined);
  assert.equal(closes, 2, "a repeated close performs no second descriptor close");
  assert.equal(existsSync(join(root, ".gateway-lock")), false);
});
