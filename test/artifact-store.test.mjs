import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, statSync, lstatSync, fstatSync, readFileSync, symlinkSync, chmodSync, writeFileSync, rmSync, readdirSync, linkSync, unlinkSync, fsyncSync, existsSync, rmdirSync, renameSync } from "node:fs";
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
const LOCK = ".gateway-lock", OWNER = "owner.json";
const ownerPath = (root) => join(root, LOCK, OWNER);
// The one scheduler owns process-start too, so a test supplies it exactly rather than racing a clock.
const PROCESS_START = 1_732_000_000_123;

// Deterministic scheduler: virtual time only, every registration retained so a test can fire a
// cancelled or post-close callback by hand and prove it is inert.
function fakeScheduler(start = 1_000_000) {
  let time = start, next = 1;
  const registrations = [], cleared = [], live = new Map();
  return {
    now: () => time,
    processStartedAt: () => PROCESS_START,
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
  assert.deepEqual(await capture, { status: "capture-failed", failure: "artifact-runtime-invalidated" }); assert.equal(await closing, undefined); assert.equal(existsSync(join(root, "data")), false, "a clean close removes the emptied data directory"); assert.equal(existsSync(join(root, ".gateway-lock")), false);
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
  // The clean close removed `data`, so this is a directory the store never owned at all — an even
  // clearer thing for a disposed store to keep its hands off.
  mkdirSync(join(root, "data"), { mode: 0o700 });
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
  assert.equal(existsSync(join(root, "data")), false, "and the emptied data directory goes with it");
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

test("lock diagnostic metadata is private and carries only closed operator fields", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), id = "A".repeat(22), clock = fakeScheduler();
  const store = new ArtifactStore({ root, scheduler: clock });
  const meta = ownerPath(root), entry = lstatSync(meta);
  assert.equal(entry.isSymbolicLink(), false, "the diagnostic entry is not a symlink");
  assert.equal(entry.isFile(), true, "the diagnostic entry is one regular file");
  assert.equal(entry.nlink, 1, "and is not a hard link to anything else");
  assert.equal(entry.mode & 0o777, 0o600, "diagnostic metadata must be strictly private");
  assert.equal(entry.uid, process.getuid(), "and owned by this process");
  const raw = readFileSync(meta, "utf8"), parsed = JSON.parse(raw);
  assert.deepEqual(Object.keys(parsed).sort(), ["nonce", "pid", "startedAt", "version"], "exactly the closed field set");
  assert.equal(parsed.version, 1);
  assert.equal(parsed.pid, process.pid);
  assert.equal(typeof parsed.nonce, "string");
  assert.ok(parsed.nonce.length >= 22, "the ownership nonce is opaque and long");
  // startedAt comes from the one scheduler's process-start accessor, so it is exact: a constructor
  // clock read would produce the scheduler's current time instead, which is a different value.
  assert.equal(parsed.startedAt, PROCESS_START, "startedAt must be the scheduler's process-start value");
  assert.notEqual(parsed.startedAt, clock.now(), "and must not be the moment this store took the lock");
  assert.equal((await store.capture(pdf, { id, consumerId: "secret-consumer" })).status, "available");
  assert.equal(readFileSync(meta, "utf8"), raw, "artifact work never writes into the diagnostic");
  for (const secret of [root, "secret-consumer", id, pdf, "%PDF"]) assert.equal(raw.includes(secret), false, "no root path, consumer, artifact ID, token or browser data appears in the diagnostic");
  assert.deepEqual(readdirSync(join(root, LOCK)), [OWNER], "the lock holds exactly one diagnostic file");
  await store.close();
});

test("a second store refuses a pre-existing lock and leaves its metadata and data untouched", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), id = "B".repeat(22);
  const store = new ArtifactStore({ root, scheduler: fakeScheduler() });
  assert.equal((await store.capture(pdf, { id, consumerId: "first" })).status, "available");
  const meta = ownerPath(root), artifact = join(root, "data", `${id}.pdf`);
  const metaBefore = readFileSync(meta), metaStat = lstatSync(meta);
  const artifactBefore = readFileSync(artifact), artifactStat = lstatSync(artifact);
  // The lock is refused on the name alone: the loser never reads it to decide liveness, never
  // rewrites it as its own, and never touches the winner's artifacts.
  assert.throws(() => new ArtifactStore({ root, scheduler: fakeScheduler() }), e => e.code === "artifact-root-locked");
  assert.deepEqual(readFileSync(meta), metaBefore, "the holder's diagnostic is byte-for-byte unchanged");
  const metaAfter = lstatSync(meta);
  assert.equal(metaAfter.ino, metaStat.ino, "and is the same file, not a replacement");
  assert.equal(metaAfter.mtimeMs, metaStat.mtimeMs, "and was never rewritten");
  assert.equal(metaAfter.mode & 0o777, 0o600);
  assert.deepEqual(readFileSync(artifact), artifactBefore, "committed artifact bytes are untouched");
  assert.equal(lstatSync(artifact).ino, artifactStat.ino);
  assert.equal(lstatSync(artifact).mtimeMs, artifactStat.mtimeMs);
  assert.deepEqual(readdirSync(root).sort(), [LOCK, "data"], "the refusal adds nothing to the root");
  assert.deepEqual(readdirSync(join(root, LOCK)), [OWNER], "and nothing to the lock");
  assert.deepEqual(readdirSync(join(root, "data")), [`${id}.pdf`]);
  // The holder is undisturbed: it still owns the lock and still completes its own lifecycle.
  assert.equal(await store.close(), undefined);
  assert.equal(existsSync(join(root, LOCK)), false);
});

test("a replaced lock directory prevents removal and is never touched", async () => {
  const root = join(temp(), "artifacts"), impostor = join(root, LOCK);
  const store = new ArtifactStore({ root, scheduler: fakeScheduler() });
  const mine = readFileSync(ownerPath(root));
  // Same name, same mode, same diagnostic bytes — a different directory. Only the retained
  // device/inode can tell them apart, and content equality must not be mistaken for ownership.
  renameSync(impostor, join(root, "stashed"));
  mkdirSync(impostor, { mode: 0o700 });
  writeFileSync(ownerPath(root), mine, { mode: 0o600 });
  const swapped = lstatSync(impostor), swappedOwner = lstatSync(ownerPath(root));
  assert.equal(await store.close(), "artifact-cleanup-failed", "a lock this store cannot claim is never removed");
  assert.equal(existsSync(impostor), true, "the impostor lock survives");
  assert.equal(lstatSync(impostor).ino, swapped.ino, "and is the same directory, not a recreated one");
  assert.deepEqual(readdirSync(impostor), [OWNER], "its contents are untouched");
  assert.deepEqual(readFileSync(ownerPath(root)), mine);
  assert.equal(lstatSync(ownerPath(root)).ino, swappedOwner.ino, "its diagnostic was never unlinked");
  assert.deepEqual(readdirSync(join(root, "stashed")), [OWNER], "and the store's own stashed lock is not hunted down");
  assert.equal((await store.capture(source(), { id: "C".repeat(22), consumerId: "after" })).failure, "artifact-runtime-invalidated");
});

// Each variant leaves a plausible diagnostic in place. The first three replace the entry, so the
// retained identity must catch them; the rest keep the original inode, mode and owner, so only
// reading the content against this boot's own expected values can. The last three are valid JSON of
// the right shape — a diagnostic is owned by what it says, not merely by parsing.
const TAMPERS = [
  ["a symlink", (root, victim) => { unlinkSync(ownerPath(root)); symlinkSync(victim, ownerPath(root)); }],
  ["a hard link", (root, victim) => { unlinkSync(ownerPath(root)); linkSync(victim, ownerPath(root)); }],
  ["a directory", (root) => { unlinkSync(ownerPath(root)); mkdirSync(ownerPath(root), { mode: 0o600 }); }],
  ["a world-readable mode", (root) => chmodSync(ownerPath(root), 0o644)],
  ["malformed content", (root) => writeFileSync(ownerPath(root), "not json at all")],
  ["a foreign nonce", (root) => { const meta = JSON.parse(readFileSync(ownerPath(root), "utf8")); writeFileSync(ownerPath(root), JSON.stringify({ ...meta, nonce: "Z".repeat(meta.nonce.length) })); }],
  ["a rewritten process start", (root) => { const meta = JSON.parse(readFileSync(ownerPath(root), "utf8")); writeFileSync(ownerPath(root), JSON.stringify({ ...meta, startedAt: meta.startedAt + 1 })); }],
  ["an unexpected extra field", (root) => { const meta = JSON.parse(readFileSync(ownerPath(root), "utf8")); writeFileSync(ownerPath(root), JSON.stringify({ ...meta, operator: "note" })); }],
];

test("a tampered diagnostic prevents lock removal and never touches its target", async () => {
  // One accumulated report rather than per-variant assertions: a variant that stops failing is as
  // interesting as one that starts, and both must be visible in the same run.
  const observed = [];
  for (const [what, tamper] of TAMPERS) {
    const root = join(temp(), "artifacts"), victim = join(temp(), "victim");
    writeFileSync(victim, "keep");
    const store = new ArtifactStore({ root, scheduler: fakeScheduler() });
    tamper(root, victim);
    const entry = lstatSync(ownerPath(root));
    const result = await store.close();
    const survives = existsSync(join(root, LOCK)) && lstatSync(ownerPath(root)).ino === entry.ino;
    observed.push(`${what}: ${result} lock-intact=${survives} victim=${readFileSync(victim, "utf8")}`);
  }
  assert.deepEqual(observed, TAMPERS.map(([what]) => `${what}: artifact-cleanup-failed lock-intact=true victim=keep`));
});

test("a non-empty data directory blocks removal, retains the lock and reports cleanup failure", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), id = "D".repeat(22);
  const store = new ArtifactStore({ root, scheduler: fakeScheduler() });
  assert.equal((await store.capture(pdf, { id, consumerId: "owner" })).status, "available");
  // An entry this store did not create. It is never deleted, and it is the reason data cannot go.
  const stray = join(root, "data", "not-an-artifact");
  writeFileSync(stray, "keep");
  assert.equal(await store.close(), "artifact-cleanup-failed");
  assert.equal(readFileSync(stray, "utf8"), "keep", "close deletes only the strict artifact files it owns");
  assert.deepEqual(readdirSync(join(root, "data")), ["not-an-artifact"], "its own artifact is still swept, and nothing else is");
  assert.equal(existsSync(join(root, LOCK)), true, "a data directory that cannot go retains the lock");
  assert.deepEqual(readdirSync(join(root, LOCK)), [OWNER], "with its diagnostic intact");
  // Retention is not cosmetic: the root stays locked against a fresh store.
  assert.throws(() => new ArtifactStore({ root }), e => e.code === "artifact-root-locked");
});

test("a clean close tears down in order and leaves a private empty root", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), id = "E".repeat(22), steps = [];
  const store = new ArtifactStore({ root, scheduler: fakeScheduler(), onCloseStep: (step) => steps.push(step) });
  assert.equal((await store.capture(pdf, { id, consumerId: "owner" })).status, "available");
  assert.equal(await store.close(), undefined);
  // The order is the contract, not an implementation detail: data cannot go before its descriptor is
  // closed, the lock cannot go before the data it guards, and the root fsync must cover every removal.
  assert.deepEqual(steps, ["delete-files", "fsync-data", "close-data-fd", "remove-data", "remove-diagnostic", "remove-lock", "fsync-root", "close-root-fd"]);
  assert.deepEqual(readdirSync(root), [], "a clean close leaves the root empty");
  const left = lstatSync(root);
  assert.equal(left.isDirectory(), true, "the root itself survives");
  assert.equal(left.mode & 0o777, 0o700, "and is still private");
  assert.equal(left.uid, process.getuid());
});

// Every removal and fsync step of a clean close. `close-root-fd` is deliberately absent: it is a
// descriptor close after the last durability point, not a removal or an fsync, and failing it cannot
// leave the tree in a different state.
const CLOSE_FAULTS = ["delete-files", "fsync-data", "close-data-fd", "remove-data", "remove-diagnostic", "remove-lock", "fsync-root"];

test("a failure at any removal or fsync step fails the close and never leaves the root unlocked", async () => {
  const observed = [];
  for (const failAt of CLOSE_FAULTS) {
    const root = join(temp(), "artifacts"), pdf = source(), id = "F".repeat(22);
    const store = new ArtifactStore({ root, scheduler: fakeScheduler(), closeStepFails: (step) => step === failAt });
    assert.equal((await store.capture(pdf, { id, consumerId: "owner" })).status, "available");
    const result = await store.close();
    // Sampled before the probe below, which would create a lock of its own if the root were free.
    const locked = existsSync(join(root, LOCK));
    // A later success must not mask this failure, and the root must not be left claimable.
    let refused = false;
    try { new ArtifactStore({ root, scheduler: fakeScheduler() }); } catch (e) { refused = e.code === "artifact-root-locked"; }
    observed.push(`${failAt}: ${result} locked=${locked} refused=${refused}`);
  }
  assert.deepEqual(observed, CLOSE_FAULTS.map((step) => `${step}: artifact-cleanup-failed locked=true refused=true`));
});

test("a failed final root fsync restores a lock it can prove, and never adopts one it cannot", async () => {
  // The final fsync covers removals that already completed, so it cannot retain an already-removed
  // lock. It recreates one instead, bound to this boot.
  const root = join(temp(), "artifacts");
  const store = new ArtifactStore({ root, scheduler: fakeScheduler(), closeStepFails: (step) => step === "fsync-root" });
  assert.equal(await store.close(), "artifact-cleanup-failed");
  const restored = lstatSync(ownerPath(root));
  assert.equal(restored.isFile(), true); assert.equal(restored.nlink, 1); assert.equal(restored.mode & 0o777, 0o600);
  const meta = JSON.parse(readFileSync(ownerPath(root), "utf8"));
  assert.deepEqual(Object.keys(meta).sort(), ["nonce", "pid", "startedAt", "version"], "the restored diagnostic is the same closed field set");
  assert.equal(meta.pid, process.pid); assert.equal(meta.startedAt, PROCESS_START);
  assert.equal(existsSync(join(root, "data")), false, "restoring a lock does not resurrect removed data");

  // If another process won the freed name first, the compensation must not read, alter or remove it.
  const other = join(temp(), "artifacts"), foreign = ownerPath(other);
  let taken;
  const loser = new ArtifactStore({
    root: other, scheduler: fakeScheduler(), closeStepFails: (step) => step === "fsync-root",
    onCloseStep: (step) => { if (step === "remove-lock") { mkdirSync(join(other, LOCK), { mode: 0o700 }); writeFileSync(foreign, "foreign", { mode: 0o600 }); taken = { lock: lstatSync(join(other, LOCK)).ino, owner: lstatSync(foreign).ino }; } },
  });
  assert.equal(await loser.close(), "artifact-cleanup-failed");
  assert.equal(readFileSync(foreign, "utf8"), "foreign", "a lock this store does not own is left exactly as found");
  // Inodes, not just bytes: a compensation that recreated the directory or the diagnostic would
  // leave identical-looking content behind a different file.
  assert.equal(lstatSync(join(other, LOCK)).ino, taken.lock, "the winner's lock directory is the one still standing");
  assert.equal(lstatSync(foreign).ino, taken.owner, "and its diagnostic was never replaced");
  assert.deepEqual(readdirSync(join(other, LOCK)), [OWNER]);
});

test("constructor rollback removes only the lock it created, and never once cleanup mutation has begun", async () => {
  // The lock is swapped underneath a failing constructor. Rollback must remove the lock this boot
  // created, not whatever happens to be standing at that name.
  const root = join(temp(), "artifacts"), lock = join(root, LOCK), stash = join(root, "stashed");
  let swapped;
  assert.throws(() => new ArtifactStore({ root, afterRootDescriptor: () => {
    renameSync(lock, stash); mkdirSync(lock, { mode: 0o700 }); writeFileSync(ownerPath(root), "foreign", { mode: 0o600 });
    swapped = { lock: lstatSync(lock).ino, owner: lstatSync(ownerPath(root)).ino };
    rmdirSync(join(root, "data"));
  } }), e => e.code === "artifact-root-invalid");
  assert.equal(existsSync(lock), true, "a lock this constructor did not create survives its rollback");
  assert.equal(lstatSync(lock).ino, swapped.lock, "and is the same directory, untouched");
  assert.equal(readFileSync(ownerPath(root), "utf8"), "foreign", "its diagnostic is neither read nor removed");
  assert.equal(lstatSync(ownerPath(root)).ino, swapped.owner);
  assert.deepEqual(readdirSync(stash), [OWNER], "and this boot's own displaced lock is not hunted down either");

  // Rollback belongs strictly to the pre-mutation window: once startup cleanup has begun deleting
  // artifact files, a failure is a cleanup failure that retains the lock and its diagnostic.
  const second = join(temp(), "artifacts"), id = "G".repeat(22);
  mkdirSync(join(second, "data"), { recursive: true, mode: 0o700 });
  writeFileSync(join(second, "data", `${id}.pdf`), Buffer.from("%PDF-1.7\nx"), { mode: 0o600 });
  chmodSync(join(second, "data", `${id}.pdf`), 0o600);
  assert.throws(() => new ArtifactStore({ root: second, fsOps: { linkSync, fsyncSync, unlinkSync() { throw new Error("/private/sentinel"); } } }), e => e.code === "artifact-cleanup-failed" && !String(e).includes("sentinel"));
  assert.equal(existsSync(join(second, LOCK)), true, "a mutating constructor keeps its lock rather than rolling back");
  const kept = JSON.parse(readFileSync(ownerPath(second), "utf8"));
  assert.deepEqual(Object.keys(kept).sort(), ["nonce", "pid", "startedAt", "version"], "with its diagnostic intact");
  assert.equal(lstatSync(ownerPath(second)).mode & 0o777, 0o600);
});

test("no public error or result exposes the configured path, PID, process start, nonce or lock contents", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), notPdf = join(temp(), "x.pdf"), fileRoot = join(temp(), "file-root");
  writeFileSync(notPdf, "not a pdf at all"); writeFileSync(fileRoot, "occupied");
  const store = new ArtifactStore({ root, scheduler: fakeScheduler() });
  const raw = readFileSync(ownerPath(root), "utf8"), secret = JSON.parse(raw);
  // Two haystacks: everything a caller can read, and the same minus stack traces. Stacks carry code
  // locations and are checked only against needles that cannot collide with a path or a line number.
  const shallow = [], deep = [];
  const record = (value) => {
    shallow.push(String(value)); deep.push(String(value));
    if (value && typeof value === "object") { shallow.push(JSON.stringify(value)); deep.push(JSON.stringify(value)); if (value.stack) deep.push(String(value.stack)); }
  };
  const attempt = (fn) => { try { record(fn()); } catch (e) { record(e); } };
  attempt(() => new ArtifactStore({ root, scheduler: fakeScheduler() }));
  attempt(() => new ArtifactStore({ root: fileRoot }));
  attempt(() => new ArtifactStore({ root: "not/absolute" }));
  attempt(() => store.discardArtifact("!!!"));
  record(await store.capture(notPdf, { id: "H".repeat(22), consumerId: "owner" }));
  try { await store.capture(pdf, { id: "short", consumerId: "owner" }); } catch (e) { record(e); }
  record(await store.acquire("I".repeat(22), "owner"));
  record(store.accounting());
  // A close that fails its ownership proof must not describe in public what it found.
  writeFileSync(ownerPath(root), "tampered");
  record(await store.close());
  for (const [what, needle] of [["the configured root path", root], ["the ownership nonce", secret.nonce], ["the diagnostic contents", raw]])
    assert.equal(deep.join("\n").includes(needle), false, `no public error or result exposes ${what}`);
  for (const [what, needle] of [["the process id", String(process.pid)], ["the process start", String(PROCESS_START)], ["the lock directory name", LOCK]])
    assert.equal(shallow.join("\n").includes(needle), false, `no public error or result exposes ${what}`);
});

test("a compensating lock restoration makes its diagnostic's directory entry durable", async () => {
  // The fsync seam already receives descriptors, so the test classifies targets itself by fstat
  // identity. No new hook, and nothing about paths, fds, identities or the nonce leaves the store.
  const fsynced = [];
  const recorder = { linkSync, unlinkSync, fsyncSync(fd) { const st = fstatSync(fd); fsynced.push({ dev: st.dev, ino: st.ino, directory: st.isDirectory() }); return fsyncSync(fd); } };
  const at = (target) => fsynced.findIndex((f) => f.directory && f.dev === target.dev && f.ino === target.ino);

  const root = join(temp(), "artifacts");
  const store = new ArtifactStore({ root, scheduler: fakeScheduler(), closeStepFails: (step) => step === "fsync-root", fsOps: recorder });
  assert.equal(await store.close(), "artifact-cleanup-failed", "restoration never masks or replaces the original cleanup failure");
  const lock = lstatSync(join(root, LOCK)), rootDir = lstatSync(root);
  // The diagnostic's bytes are fsynced when it is written, but its *name* lives in this recreated
  // directory: without a directory fsync the entry is not durable across a crash.
  assert.ok(at(lock) >= 0, "the recreated lock directory is made durable");
  assert.ok(at(rootDir) > at(lock), "and the root that names it is fsynced afterwards, not instead");

  // A lock another process won is never opened, inspected or fsynced.
  const other = join(temp(), "artifacts"), foreign = ownerPath(other);
  let taken;
  const loser = new ArtifactStore({
    root: other, scheduler: fakeScheduler(), closeStepFails: (step) => step === "fsync-root", fsOps: recorder,
    onCloseStep: (step) => { if (step === "remove-lock") { mkdirSync(join(other, LOCK), { mode: 0o700 }); writeFileSync(foreign, "foreign", { mode: 0o600 }); taken = lstatSync(join(other, LOCK)); } },
  });
  const mark = fsynced.length;
  assert.equal(await loser.close(), "artifact-cleanup-failed");
  assert.equal(fsynced.slice(mark).some((f) => f.dev === taken.dev && f.ino === taken.ino), false, "a lock this store does not own is never fsynced");
  assert.equal(readFileSync(foreign, "utf8"), "foreign");
  assert.equal(lstatSync(join(other, LOCK)).ino, taken.ino);

  // The two restoration fsyncs are independent: a failing lock-directory fsync must not cost the
  // root its own, and neither may upgrade or mask the original cleanup failure.
  const third = join(temp(), "artifacts"), after = [];
  const failing = { linkSync, unlinkSync, fsyncSync(fd) {
    const st = fstatSync(fd);
    if (st.isDirectory() && existsSync(join(third, LOCK)) && st.ino === lstatSync(join(third, LOCK)).ino) throw new Error("/private/lock-fsync-sentinel");
    after.push({ dev: st.dev, ino: st.ino, directory: st.isDirectory() }); return fsyncSync(fd);
  } };
  const partial = new ArtifactStore({ root: third, scheduler: fakeScheduler(), closeStepFails: (step) => step === "fsync-root", fsOps: failing });
  const outcome = await partial.close();
  assert.equal(outcome, "artifact-cleanup-failed", "a failed restoration fsync leaves the original failure exactly as it was");
  const thirdRoot = lstatSync(third);
  assert.ok(after.some((f) => f.directory && f.dev === thirdRoot.dev && f.ino === thirdRoot.ino), "the retained root is still fsynced after the lock directory's fsync fails");
  assert.equal(existsSync(ownerPath(third)), true, "and the restored lock and diagnostic still stand");
});
