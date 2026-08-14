import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, statSync, writeFileSync, rmSync, readdirSync, linkSync, unlinkSync, fsyncSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../dist/artifacts/index.js";

const dirs = [];
function temp() { const dir = mkdtempSync(join(tmpdir(), "bgw-artifact-")); dirs.push(dir); return dir; }
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

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

test("startup cleanup unlink failure retains lock and hides raw errors", () => {
  const root = join(temp(), "artifacts"), id = "S".repeat(22); mkdirSync(root, { mode: 0o700 }); mkdirSync(join(root, "data"), { mode: 0o700 }); writeFileSync(join(root, "data", `${id}.part`), "part");
  const sentinel = "/private/startup-sentinel"; assert.throws(() => new ArtifactStore({ root, fsOps: { linkSync, fsyncSync, unlinkSync() { throw new Error(sentinel); } } }), e => e.code === "artifact-cleanup-failed" && !String(e).includes(sentinel)); assert.equal(existsSync(join(root, ".gateway-lock")), true); assert.throws(() => new ArtifactStore({ root }), e => e.code === "artifact-root-locked");
});

test("startup cleanup fsync failure retains lock because deletion is not durable", () => {
  const root = join(temp(), "artifacts"), id = "F".repeat(22); mkdirSync(root, { mode: 0o700 }); mkdirSync(join(root, "data"), { mode: 0o700 }); writeFileSync(join(root, "data", `${id}.part`), "part");
  assert.throws(() => new ArtifactStore({ root, fsOps: { linkSync, unlinkSync, fsyncSync() { throw new Error("/private/fsync-sentinel"); } } }), e => e.code === "artifact-cleanup-failed" && !String(e).includes("fsync-sentinel")); assert.equal(existsSync(join(root, ".gateway-lock")), true); assert.throws(() => new ArtifactStore({ root }), e => e.code === "artifact-root-locked");
});
