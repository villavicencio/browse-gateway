import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync, linkSync, unlinkSync, fsyncSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactRuntime, ArtifactStore } from "../dist/artifacts/index.js";
const dirs=[]; const temp=()=>{const d=mkdtempSync(join(tmpdir(),"bgw-artifact-"));dirs.push(d);return d};
afterEach(()=>{while(dirs.length)rmSync(dirs.pop(),{recursive:true,force:true})});
function pdf(dir){const p=join(dir,"x.pdf");writeFileSync(p,Buffer.from("%PDF-1.7\nhello"));return p}

test("lease is one-time and complete deletes the artifact", async()=>{const root=join(temp(),"a"), source=pdf(temp()), s=new ArtifactStore({enabled:true,root}); const id="B".repeat(22); await s.capture(source,{id,consumerId:"c"}); const l=s.acquire(id,"c"); assert.ok(l); assert.equal(s.acquire(id,"c"),null); assert.equal(l.base64,Buffer.from("%PDF-1.7\nhello").toString("base64")); l.complete(); l.complete(); assert.equal(s.acquire(id,"c"),null); s.close()});

test("inline PDF is rejected only for exact status 200 and no downloads",()=>{
  const root = join(temp(), "a");
  const r = new ArtifactRuntime({ enabled: true, root });
  const op = r.createOperation("owner", "example.com", "C".repeat(22));
  op.noteMainResponse(200, " Application/PDF ; charset=binary ");
  assert.deepEqual(op.seal(), { outcome: "inline-pdf-unsupported", failure: "inline-pdf-unsupported" });
  for (const status of [206, 404, null]) {
    const candidate = r.createOperation("owner", "example.com", `${status === null ? "N" : status === 206 ? "P" : "Q"}`.repeat(22));
    candidate.noteMainResponse(status, "application/pdf");
    assert.equal(candidate.seal().outcome, "none");
  }
  r.close();
});

test("generated IDs reserve collisions and canonicalize the source host",()=>{
  const ids = ["G".repeat(22), "G".repeat(22), "H".repeat(22)];
  const r = new ArtifactRuntime({ enabled: true, root: join(temp(), "a"), idGenerator: () => ids.shift() });
  const a = r.createOperation("owner", "EXAMPLE.COM.");
  const b = r.createOperation("owner", "example.com");
  assert.notEqual(a.artifactId, b.artifactId);
  assert.equal(a.sourceHost, "example.com");
  assert.throws(() => r.createOperation("owner", "example.com", a.artifactId), /artifact-capacity/);
  r.close();
});

test("download failure accessor exceptions are private capture failures", async()=>{
  const r = new ArtifactRuntime({ enabled: true, root: join(temp(), "a") });
  const op = r.createOperation("owner", "example.com", "X".repeat(22));
  const secret = "/private/secret-path sentinel";
  const result = await op.registerDownload({ failure: () => Promise.reject(new Error(secret)), path: () => "/not-read" });
  assert.deepEqual(result, { outcome: "capture-failed", failure: "download-capture-failed" });
  assert.equal(JSON.stringify(result).includes(secret), false);
  r.close();
});

test("download path accessor exceptions are private capture failures", async()=>{
  const r = new ArtifactRuntime({ enabled: true, root: join(temp(), "a") });
  const op = r.createOperation("owner", "example.com", "V".repeat(22));
  const secret = "/private/secret-path sentinel";
  const result = await op.registerDownload({ failure: () => undefined, path: () => { throw new Error(secret); } });
  assert.deepEqual(result, { outcome: "capture-failed", failure: "download-capture-failed" });
  assert.equal(JSON.stringify(result).includes(secret), false);
  r.close();
});

test("second in-flight download terminalizes operation and late first capture cannot publish", async()=>{
  const root = join(temp(), "a");
  const source = pdf(temp());
  const r = new ArtifactRuntime({ enabled: true, root });
  let release;
  const deferred = new Promise(resolve => { release = resolve; });
  const op = r.createOperation("owner", "example.com", "E".repeat(22));
  const first = op.registerDownload({ path: async () => { await deferred; return source; } });
  const second = op.registerDownload({ path: () => source });
  assert.deepEqual(await second, { outcome: "capture-failed", failure: "multiple-artifacts" });
  release();
  await first;
  assert.deepEqual(op.seal(), { outcome: "capture-failed", failure: "multiple-artifacts" });
  assert.deepEqual(readdirSync(join(root, "data")), []);
  r.close();
});

test("invalidation and close win against an in-flight download", async()=>{
  for (const action of ["invalidate", "close"]) {
    const root = join(temp(), `a-${action}`);
    const source = pdf(temp());
    const r = new ArtifactRuntime({ enabled: true, root });
    let release;
    const deferred = new Promise(resolve => { release = resolve; });
    const op = r.createOperation("owner", "example.com", `${action === "close" ? "H" : "I"}`.repeat(22));
    const pending = op.registerDownload({ path: async () => { await deferred; return source; } });
    const terminal = action === "close" ? (r.close(), op.invalidate()) : op.invalidate();
    release();
    await pending;
    assert.deepEqual(terminal, { outcome: "capture-failed", failure: "artifact-runtime-invalidated" });
    assert.deepEqual(op.seal(), terminal);
    assert.deepEqual(readdirSync(join(root, "data")), []);
  }
});

test("closed store fails closed and does not write", async()=>{const root=join(temp(),"a"), source=pdf(temp()), s=new ArtifactStore({enabled:true,root}); s.close(); assert.equal((await s.capture(source,{id:"F".repeat(22),consumerId:"c"})).status,"capture-failed"); assert.equal(s.acquire("F".repeat(22),"c"),null);});

test("malicious operation id cannot delete a file outside the data directory",()=>{const base=temp(), root=join(base,"artifacts"), victim=join(base,"victim.pdf"); writeFileSync(victim,"sentinel"); const r=new ArtifactRuntime({enabled:true,root}); assert.throws(()=>r.createOperation("c","example.com","../../victim")); assert.equal(readFileSync(victim,"utf8"),"sentinel"); r.close()});

test("runtime default operation ids are deterministic-shaped and unique",()=>{const r=new ArtifactRuntime({enabled:true,root:join(temp(),"a")}); const a=r.createOperation("c","example.com"), b=r.createOperation("c","example.com"); assert.notEqual(a.artifactId,b.artifactId); assert.match(a.artifactId,/^[A-Za-z0-9_-]{22,64}$/); r.close()});

test("one valid download after a 200 PDF response is available, never inline", async()=>{
  const r = new ArtifactRuntime({ enabled: true, root: join(temp(), "a") });
  const source = pdf(temp()); const op = r.createOperation("owner", "example.com", "J".repeat(22));
  op.noteMainResponse(200, "application/pdf");
  const result = await op.registerDownload({ failure: () => undefined, path: () => source });
  assert.notEqual(result.outcome, "inline-pdf-unsupported");
  assert.equal(result.outcome, "available");
  r.close();
});

test("canonicalizeHost synchronous failure is typed and private", () => {
  const secret = "/private/host-secret";
  assert.throws(() => new ArtifactRuntime({ enabled: true, root: join(temp(), "a") }).createOperation("c", secret), (e) => e.code === "artifact-config-invalid" && !String(e).includes(secret));
});


test("tampered available artifact is discarded and frees explicit ID quota", async () => {
  const root = join(temp(), "a"), source = pdf(temp()), id = "T".repeat(22); let discarded = 0;
  const r = new ArtifactRuntime({ enabled: true, root, maxCount: 1, onDiscard: () => discarded++ });
  const op = r.createOperation("owner", "example.com", id); const result = await op.registerDownload({ path: () => source }); assert.equal(result.outcome, "available");
  writeFileSync(join(root, "data", `${id}.pdf`), Buffer.from("tampered")); assert.equal(r.store.acquire(id, "owner"), null); assert.equal(discarded, 1);
  const replacement = r.createOperation("owner", "example.com", id); assert.equal(replacement.artifactId, id); await r.close();
});

test("terminal operation outcomes release explicit IDs at the correct boundary", async () => {
  const root = join(temp(), "a"), r = new ArtifactRuntime({ enabled: true, root }), id = "R".repeat(22);
  const none = r.createOperation("owner", "example.com", id); assert.deepEqual(none.seal(), { outcome: "none" }); r.createOperation("owner", "example.com", id).seal();
  const inline = r.createOperation("owner", "example.com", id); inline.noteMainResponse(200, "application/pdf"); assert.equal(inline.seal().outcome, "inline-pdf-unsupported"); r.createOperation("owner", "example.com", id).seal();
  const failed = r.createOperation("owner", "example.com", id); assert.equal((await failed.registerDownload({ failure: () => { throw new Error("private"); } })).failure, "download-capture-failed"); r.createOperation("owner", "example.com", id).seal();
  const pathFailed = r.createOperation("owner", "example.com", id); assert.equal((await pathFailed.registerDownload({ path: () => { throw new Error("private"); } })).failure, "download-capture-failed"); r.createOperation("owner", "example.com", id).seal();
  const invalid = r.createOperation("owner", "example.com", id); assert.equal(invalid.invalidate().failure, "artifact-runtime-invalidated"); r.createOperation("owner", "example.com", id).seal(); await r.close();
});

test("runtime observer failure still releases explicit ID reservation", async () => {
  const root = join(temp(), "a"), source = pdf(temp()), id = "U".repeat(22);
  const r = new ArtifactRuntime({ enabled: true, root, onDiscard: () => { throw new Error("observer sentinel"); } });
  const op = r.createOperation("owner", "example.com", id);
  assert.equal((await op.registerDownload({ path: () => source })).outcome, "available");
  assert.equal(r.store.discardArtifact(id), true);
  assert.equal(r.createOperation("owner", "example.com", id).artifactId, id);
  await r.close();
});

test("in-flight and available artifacts retain IDs until terminal cleanup", async () => {
  const root = join(temp(), "a"), source = pdf(temp()), id = "Q".repeat(22), r = new ArtifactRuntime({ enabled: true, root }); let release; const gate = new Promise(resolve => { release = resolve; });
  const op = r.createOperation("owner", "example.com", id); const pending = op.registerDownload({ path: async () => { await gate; return source; } }); assert.throws(() => r.createOperation("owner", "example.com", id), e => e.code === "artifact-capacity"); release(); assert.equal((await pending).outcome, "available"); assert.throws(() => r.createOperation("owner", "example.com", id), e => e.code === "artifact-capacity"); const lease = r.store.acquire(id, "owner"); assert.ok(lease); lease.complete(); assert.equal(r.createOperation("owner", "example.com", id).artifactId, id); await r.close();
});

test("sealing an available operation retains its ID until durable discard", async () => {
  const root = join(temp(), "a"), source = pdf(temp()), id = "S".repeat(22);
  const r = new ArtifactRuntime({ enabled: true, root });
  const op = r.createOperation("owner", "example.com", id);
  assert.equal((await op.registerDownload({ path: () => source })).outcome, "available");
  assert.equal(op.seal().outcome, "available");
  assert.throws(() => r.createOperation("owner", "example.com", id), e => e.code === "artifact-capacity");
  const lease = r.store.acquire(id, "owner"); assert.ok(lease); lease.complete();
  assert.equal(r.createOperation("owner", "example.com", id).artifactId, id);
  await r.close();
});

test("capture-originated cleanup failure retains the explicit ID reservation", async () => {
  const root = join(temp(), "a"), source = pdf(temp()), id = "K".repeat(22);
  const r = new ArtifactRuntime({ enabled: true, root, fsOps: {
    linkSync, unlinkSync,
    fsyncSync() { throw new Error("fsync"); }
  } });
  const op = r.createOperation("owner", "example.com", id);
  assert.deepEqual(await op.registerDownload({ path: () => source }), { outcome: "capture-failed", failure: "artifact-cleanup-failed" });
  assert.throws(() => r.createOperation("owner", "example.com", id), e => e.code === "artifact-capacity");
  await r.close();
});

test("stale operation methods cannot release a replacement reservation", async () => {
  const root = join(temp(), "a"), source = pdf(temp()), id = "L".repeat(22);
  const r = new ArtifactRuntime({ enabled: true, root });
  const old = r.createOperation("owner", "example.com", id);
  assert.equal((await old.registerDownload({ path: () => source })).outcome, "available");
  old.seal();
  const lease = r.store.acquire(id, "owner"); assert.ok(lease); lease.complete();
  const replacement = r.createOperation("owner", "example.com", id);
  old.seal(); old.invalidate(); old.seal();
  assert.throws(() => r.createOperation("owner", "example.com", id), e => e.code === "artifact-capacity");
  replacement.seal();
  await r.close();
});

test("invalidation cleanup failure retains operation reservation and reports cleanup failure", async () => {
  const root = join(temp(), "a"), source = pdf(temp()), id = "A".repeat(22);
  const r = new ArtifactRuntime({ enabled: true, root, fsOps: { linkSync, fsyncSync, unlinkSync(path) { if (path.endsWith(`${id}.pdf`)) throw new Error("unlink"); return unlinkSync(path); } } });
  const op = r.createOperation("owner", "example.com", id);
  assert.equal((await op.registerDownload({ path: () => source })).outcome, "available");
  assert.deepEqual(op.invalidate(), { outcome: "capture-failed", failure: "artifact-cleanup-failed" });
  assert.throws(() => r.createOperation("owner", "example.com", id), e => e.code === "artifact-capacity");
  assert.equal(existsSync(join(root, ".gateway-lock")), true);
});

test("multiple cleanup failure supersedes multiple-artifacts and retains reservation", async () => {
  const root = join(temp(), "a"), source = pdf(temp()), id = "B".repeat(22);
  const r = new ArtifactRuntime({ enabled: true, root, fsOps: { linkSync, fsyncSync, unlinkSync(path) { if (path.endsWith(`${id}.pdf`)) throw new Error("unlink"); return unlinkSync(path); } } });
  const op = r.createOperation("owner", "example.com", id);
  assert.equal((await op.registerDownload({ path: () => source })).outcome, "available");
  assert.deepEqual(await op.registerDownload({ path: () => source }), { outcome: "capture-failed", failure: "artifact-cleanup-failed" });
  assert.throws(() => r.createOperation("owner", "example.com", id), e => e.code === "artifact-capacity");
});

test("in-flight invalidation and multiple retain ID until continuation cleanup completes", async () => {
  for (const mode of ["invalidate", "multiple"]) {
    const root = join(temp(), mode), source = pdf(temp()), id = `${mode === "invalidate" ? "C" : "D"}`.repeat(22), r = new ArtifactRuntime({ enabled: true, root });
    let release; const gate = new Promise(resolve => { release = resolve; });
    const op = r.createOperation("owner", "example.com", id);
    const first = op.registerDownload({ path: async () => { await gate; return source; } });
    const terminal = mode === "invalidate" ? op.invalidate() : await op.registerDownload({ path: () => source });
    assert.throws(() => r.createOperation("owner", "example.com", id), e => e.code === "artifact-capacity");
    release(); await first;
    assert.equal(readdirSync(join(root, "data")).length, 0);
    assert.equal(r.createOperation("owner", "example.com", id).artifactId, id);
    assert.equal(terminal.failure, mode === "invalidate" ? "artifact-runtime-invalidated" : "multiple-artifacts");
  }
});
