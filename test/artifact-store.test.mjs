import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, statSync, readFileSync, symlinkSync, chmodSync, writeFileSync, rmSync, readdirSync, linkSync, unlinkSync, fsyncSync, existsSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../dist/artifacts/index.js";

const dirs = [];
function temp() { const dir = mkdtempSync(join(tmpdir(), "bgw-artifact-")); dirs.push(dir); return dir; }
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });
function source() { const path = join(temp(), "source.pdf"); writeFileSync(path, Buffer.from("%PDF-1.7\nhello")); return path; }

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
  assert.equal(store.acquire("Y".repeat(22), "owner"), null);
  assert.equal(existsSync(join(root, ".gateway-lock")), true);
  assert.throws(() => new ArtifactStore({ enabled: true, root }), (e) => e.code === "artifact-root-locked" && !String(e).includes("sentinel"));
  await store.close();
  assert.equal(existsSync(join(root, ".gateway-lock")), true);
});

test("discard failure retains available record and callback", async () => {
  const root = join(temp(), "artifacts"), source = join(temp(), "source.pdf"), id = "D".repeat(22); writeFileSync(source, Buffer.from("%PDF-1.7\nhello")); let callbacks = 0;
  const store = new ArtifactStore({ root, onDiscard: () => { callbacks++; }, fsOps: { linkSync, fsyncSync, unlinkSync(path) { if (path.endsWith(`${id}.pdf`)) throw new Error("unlink"); return unlinkSync(path); } } });
  assert.equal((await store.capture(source, { id, consumerId: "owner" })).status, "available"); assert.equal(store.discardArtifact(id), false); assert.equal(callbacks, 0); assert.equal(store.acquire(id, "owner"), null); assert.equal(existsSync(join(root, ".gateway-lock")), true); await store.close();
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
  const lease = store.acquire(early, "owner");
  assert.ok(lease, "now === expiresAt - 1 must remain available");
  lease.complete();
  clock.advance(1);
  assert.equal(store.acquire(exact, "owner"), null);
  assert.deepEqual(readdirSync(join(root, "data")), []);
  assert.deepEqual(discarded, [early, exact]);
  await store.close();
});

test("response lease deadline and timeout advance only on the injected scheduler", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), clock = fakeScheduler(), discarded = [], id = "T".repeat(22);
  const store = new ArtifactStore({ root, scheduler: clock, onDiscard: (i) => discarded.push(i) });
  assert.equal((await store.capture(pdf, { id, consumerId: "owner" })).status, "available");
  const wallBefore = Date.now();
  const lease = store.acquire(id, "owner");
  assert.ok(lease);
  assert.equal(lease.deadline, clock.now() + 15_000);
  assert.ok(clock.pending().some((r) => r.delayMs === 15_000), "lease timeout must be registered on the injected scheduler");
  clock.advance(14_999);
  assert.deepEqual(discarded, []);
  assert.equal(existsSync(join(root, "data", `${id}.pdf`)), true);
  clock.advance(1);
  assert.deepEqual(discarded, [id]);
  assert.equal(existsSync(join(root, "data", `${id}.pdf`)), false);
  assert.equal(store.acquire(id, "owner"), null);
  lease.complete(); lease.complete();
  assert.deepEqual(discarded, [id]);
  assert.ok(Date.now() - wallBefore < 15_000, "ambient wall time must be irrelevant");
  await store.close();
});

test("lease completion cancels the timeout and later time advance is inert", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), clock = fakeScheduler(), discarded = [], id = "C".repeat(22);
  const store = new ArtifactStore({ root, scheduler: clock, onDiscard: (i) => discarded.push(i) });
  assert.equal((await store.capture(pdf, { id, consumerId: "owner" })).status, "available");
  const lease = store.acquire(id, "owner");
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
  const lease = store.acquire(id, "owner");
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
