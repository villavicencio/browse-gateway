import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync, linkSync, unlinkSync, fsyncSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactRuntime, ArtifactStore } from "../dist/artifacts/index.js";
const dirs=[]; const temp=()=>{const d=mkdtempSync(join(tmpdir(),"bgw-artifact-"));dirs.push(d);return d};
afterEach(()=>{while(dirs.length)rmSync(dirs.pop(),{recursive:true,force:true})});
const OWNER = { scope: "consumer", consumerId: "owner" };
const ownerOf = (id) => ({ scope: "consumer", consumerId: id });
function pdf(dir){const p=join(dir,"x.pdf");writeFileSync(p,Buffer.from("%PDF-1.7\nhello"));return p}

test("lease is one-time and complete deletes the artifact", async()=>{const root=join(temp(),"a"), source=pdf(temp()), s=new ArtifactStore({enabled:true,root}); const id="B".repeat(22); await s.capture(source,{id,consumerId:"c"}); const l=await s.acquire(id,"c"); assert.ok(l); assert.equal(await s.acquire(id,"c"),null); assert.equal(l.base64,Buffer.from("%PDF-1.7\nhello").toString("base64")); l.complete(); l.complete(); assert.equal(await s.acquire(id,"c"),null); s.close()});

test("inline PDF is rejected only for exact status 200 and no downloads", async () => {
  const root = join(temp(), "a");
  const r = new ArtifactRuntime({ enabled: true, root });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: "C".repeat(22) });
  op.noteMainResponseContentType({ status: 200, contentType: " Application/PDF ; charset=binary " });
  assert.deepEqual(await op.seal(), { outcome: "inline-pdf-unsupported", failure: "inline-pdf-unsupported" });
  for (const status of [206, 404, null]) {
    const candidate = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: `${status === null ? "N" : status === 206 ? "P" : "Q"}`.repeat(22) });
    candidate.noteMainResponseContentType({ status, contentType: "application/pdf" });
    assert.equal((await candidate.seal()).outcome, "none");
  }
  r.close();
});

test("generated IDs reserve collisions and canonicalize the source host",()=>{
  const ids = ["G".repeat(22), "G".repeat(22), "H".repeat(22)];
  const r = new ArtifactRuntime({ enabled: true, root: join(temp(), "a"), idGenerator: () => ids.shift() });
  const a = r.createOperation({ owner: OWNER, sourceHost: "EXAMPLE.COM." });
  const b = r.createOperation({ owner: OWNER, sourceHost: "example.com" });
  assert.notEqual(a.artifactId, b.artifactId);
  assert.equal(a.sourceHost, "example.com");
  assert.throws(() => r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: a.artifactId }), /artifact-capacity/);
  r.close();
});

test("download failure accessor exceptions are private capture failures", async () => {
  const r = new ArtifactRuntime({ enabled: true, root: join(temp(), "a") });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: "X".repeat(22) });
  const secret = "/private/secret-path sentinel";
  op.registerDownload({ failure: () => Promise.reject(new Error(secret)), path: () => "/not-read" });
  const result = await op.seal();
  assert.deepEqual(result, { outcome: "capture-failed", failure: "download-capture-failed" });
  assert.equal(JSON.stringify(result).includes(secret), false);
  r.close();
});

test("download path accessor exceptions are private capture failures", async () => {
  const r = new ArtifactRuntime({ enabled: true, root: join(temp(), "a") });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: "V".repeat(22) });
  const secret = "/private/secret-path sentinel";
  op.registerDownload({ failure: () => undefined, path: () => { throw new Error(secret); } });
  const result = await op.seal();
  assert.deepEqual(result, { outcome: "capture-failed", failure: "download-capture-failed" });
  assert.equal(JSON.stringify(result).includes(secret), false);
  r.close();
});

test("second in-flight download terminalizes operation and late first capture cannot publish", async () => {
  const root = join(temp(), "a");
  const source = pdf(temp());
  const terminals = [];
  const r = new ArtifactRuntime({ enabled: true, root, onOperationTerminal: (reason) => terminals.push(reason) });
  let release;
  const deferred = new Promise((resolve) => { release = resolve; });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: "E".repeat(22) });
  op.registerDownload({ path: async () => { await deferred; return source; } });
  op.registerDownload({ path: () => source });
  // The terminal decision is SYNCHRONOUS with the second event — observed here while the first
  // capture is still in flight, which is the ordering the old promise-returning API expressed.
  assert.deepEqual(terminals, ["multiple-artifacts"]);
  // And the ID stays reserved while that continuation is still running.
  assert.throws(() => r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: "E".repeat(22) }), (e) => e.code === "artifact-capacity");
  release();
  assert.deepEqual(await op.seal(), { outcome: "capture-failed", failure: "multiple-artifacts" });
  assert.deepEqual(readdirSync(join(root, "data")), []);
  r.close();
});

test("invalidation and close win against an in-flight download", async () => {
  for (const action of ["invalidate", "close"]) {
    const root = join(temp(), `a-${action}`);
    const source = pdf(temp());
    const r = new ArtifactRuntime({ enabled: true, root });
    let release;
    const deferred = new Promise((resolve) => { release = resolve; });
    const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: `${action === "close" ? "H" : "I"}`.repeat(22) });
    op.registerDownload({ path: async () => { await deferred; return source; } });
    // Both paths invalidate synchronously, before the in-flight copy can resolve.
    if (action === "close") r.close(); else op.invalidate("artifact-runtime-invalidated");
    release();
    const terminal = await op.seal();
    assert.deepEqual(terminal, { outcome: "capture-failed", failure: "artifact-runtime-invalidated" });
    assert.deepEqual(await op.seal(), terminal, "the terminal result is stable");
    // A closed runtime removes the emptied data directory; an invalidated one keeps it, empty.
    if (action === "close") assert.equal(existsSync(join(root, "data")), false);
    else assert.deepEqual(readdirSync(join(root, "data")), []);
  }
});

test("closed store fails closed and does not write", async()=>{const root=join(temp(),"a"), source=pdf(temp()), s=new ArtifactStore({enabled:true,root}); s.close(); assert.equal((await s.capture(source,{id:"F".repeat(22),consumerId:"c"})).status,"capture-failed"); assert.equal(await s.acquire("F".repeat(22),"c"),null);});

test("malicious operation id cannot delete a file outside the data directory",()=>{const base=temp(), root=join(base,"artifacts"), victim=join(base,"victim.pdf"); writeFileSync(victim,"sentinel"); const r=new ArtifactRuntime({enabled:true,root}); assert.throws(()=>r.createOperation({ owner: ownerOf("c"), sourceHost: "example.com", artifactId: "../../victim" })); assert.equal(readFileSync(victim,"utf8"),"sentinel"); r.close()});

test("runtime default operation ids are deterministic-shaped and unique",()=>{const r=new ArtifactRuntime({enabled:true,root:join(temp(),"a")}); const a=r.createOperation({ owner: ownerOf("c"), sourceHost: "example.com" }), b=r.createOperation({ owner: ownerOf("c"), sourceHost: "example.com" }); assert.notEqual(a.artifactId,b.artifactId); assert.match(a.artifactId,/^[A-Za-z0-9_-]{22,64}$/); r.close()});

test("one valid download after a 200 PDF response is available, never inline", async () => {
  const r = new ArtifactRuntime({ enabled: true, root: join(temp(), "a") });
  const source = pdf(temp());
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: "J".repeat(22) });
  op.noteMainResponseContentType({ status: 200, contentType: "application/pdf" });
  op.registerDownload({ failure: () => undefined, path: () => source });
  const result = await op.seal();
  assert.notEqual(result.outcome, "inline-pdf-unsupported");
  assert.equal(result.outcome, "available");
  r.close();
});

test("canonicalizeHost synchronous failure is typed and private", () => {
  const secret = "/private/host-secret";
  assert.throws(() => new ArtifactRuntime({ enabled: true, root: join(temp(), "a") }).createOperation({ owner: ownerOf("c"), sourceHost: secret }), (e) => e.code === "artifact-config-invalid" && !String(e).includes(secret));
});


test("tampered available artifact is discarded and frees explicit ID quota", async () => {
  const root = join(temp(), "a"), source = pdf(temp()), id = "T".repeat(22); let discarded = 0;
  const r = new ArtifactRuntime({ enabled: true, root, maxCount: 1, onDiscard: () => discarded++ });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });
  op.registerDownload({ path: () => source });
  assert.equal((await op.seal()).outcome, "available");
  writeFileSync(join(root, "data", `${id}.pdf`), Buffer.from("tampered"));
  assert.equal(await r.store.acquire(id, "owner"), null);
  assert.equal(discarded, 1);
  const replacement = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });
  assert.equal(replacement.artifactId, id);
  await r.close();
});

test("terminal operation outcomes release explicit IDs at the correct boundary", async () => {
  const root = join(temp(), "a"), r = new ArtifactRuntime({ enabled: true, root }), id = "R".repeat(22);
  // Each terminal outcome must free the ID, so the next operation can claim it again.
  const none = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id }); assert.deepEqual(await none.seal(), { outcome: "none" });
  await (r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id })).seal();
  const inline = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id }); inline.noteMainResponseContentType({ status: 200, contentType: "application/pdf" });
  assert.equal((await inline.seal()).outcome, "inline-pdf-unsupported");
  await (r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id })).seal();
  const failed = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id }); failed.registerDownload({ failure: () => { throw new Error("private"); } });
  assert.equal((await failed.seal()).failure, "download-capture-failed");
  await (r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id })).seal();
  const pathFailed = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id }); pathFailed.registerDownload({ path: () => { throw new Error("private"); } });
  assert.equal((await pathFailed.seal()).failure, "download-capture-failed");
  await (r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id })).seal();
  const invalid = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id }); invalid.invalidate("artifact-runtime-invalidated");
  assert.equal((await invalid.seal()).failure, "artifact-runtime-invalidated");
  await (r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id })).seal();
  await r.close();
});

test("runtime observer failure still releases explicit ID reservation", async () => {
  const root = join(temp(), "a"), source = pdf(temp()), id = "U".repeat(22);
  const r = new ArtifactRuntime({ enabled: true, root, onDiscard: () => { throw new Error("observer sentinel"); } });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });
  op.registerDownload({ path: () => source });
  assert.equal((await op.seal()).outcome, "available");
  assert.equal(r.store.discardArtifact(id), true);
  assert.equal((r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id })).artifactId, id);
  await r.close();
});

test("in-flight and available artifacts retain IDs until terminal cleanup", async () => {
  const root = join(temp(), "a"), source = pdf(temp()), id = "Q".repeat(22), r = new ArtifactRuntime({ enabled: true, root });
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });
  op.registerDownload({ path: async () => { await gate; return source; } });
  assert.throws(() => r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id }), (e) => e.code === "artifact-capacity");
  release();
  assert.equal((await op.seal()).outcome, "available");
  assert.throws(() => r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id }), (e) => e.code === "artifact-capacity");
  const lease = await r.store.acquire(id, "owner"); assert.ok(lease); lease.complete();
  assert.equal((r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id })).artifactId, id);
  await r.close();
});

test("sealing an available operation retains its ID until durable discard", async () => {
  const root = join(temp(), "a"), source = pdf(temp()), id = "S".repeat(22);
  const r = new ArtifactRuntime({ enabled: true, root });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });
  op.registerDownload({ path: () => source });
  assert.equal((await op.seal()).outcome, "available");
  assert.throws(() => r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id }), (e) => e.code === "artifact-capacity");
  const lease = await r.store.acquire(id, "owner"); assert.ok(lease); lease.complete();
  assert.equal((r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id })).artifactId, id);
  await r.close();
});

test("ordinary invalidation after capture commits an available artifact", async () => {
  const root = join(temp(), "a"), source = pdf(temp()), id = "O".repeat(22);
  const r = new ArtifactRuntime({ enabled: true, root });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });
  op.registerDownload({ path: () => source });
  const available = await op.seal();
  assert.equal(available.outcome, "available");
  // Ordinary invalidation AFTER commitment must leave the returnable artifact alone.
  op.invalidate("artifact-runtime-invalidated");
  assert.deepEqual(await op.seal(), available);
  assert.equal(existsSync(join(root, "data", `${id}.pdf`)), true);
  assert.throws(() => r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id }), (e) => e.code === "artifact-capacity");
  const lease = await r.store.acquire(id, "owner"); assert.ok(lease); lease.complete();
  assert.equal((r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id })).artifactId, id);
  await r.close();
});

test("repeated ordinary invalidation cannot revoke a sealed available artifact", async () => {
  const root = join(temp(), "a"), source = pdf(temp()), id = "P".repeat(22);
  const r = new ArtifactRuntime({ enabled: true, root });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });
  op.registerDownload({ path: () => source });
  const available = await op.seal();
  assert.equal(available.outcome, "available");
  op.invalidate("artifact-runtime-invalidated");
  op.invalidate("artifact-runtime-invalidated");
  assert.deepEqual(await op.seal(), available);
  assert.equal(existsSync(join(root, "data", `${id}.pdf`)), true);
  assert.throws(() => r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id }), (e) => e.code === "artifact-capacity");
  const lease = await r.store.acquire(id, "owner"); assert.ok(lease); lease.complete();
  assert.equal((r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id })).artifactId, id);
  await r.close();
});

test("capture-originated cleanup failure retains the explicit ID reservation", async () => {
  const root = join(temp(), "a"), source = pdf(temp()), id = "K".repeat(22);
  const r = new ArtifactRuntime({ enabled: true, root, fsOps: { linkSync, unlinkSync, fsyncSync() { throw new Error("fsync"); } } });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });
  op.registerDownload({ path: () => source });
  assert.deepEqual(await op.seal(), { outcome: "capture-failed", failure: "artifact-cleanup-failed" });
  assert.throws(() => r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id }), (e) => e.code === "artifact-capacity");
  await r.close();
});

test("stale operation methods cannot release a replacement reservation", async () => {
  const root = join(temp(), "a"), source = pdf(temp()), id = "L".repeat(22);
  const r = new ArtifactRuntime({ enabled: true, root });
  const old = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });
  old.registerDownload({ path: () => source });
  assert.equal((await old.seal()).outcome, "available");
  const lease = await r.store.acquire(id, "owner"); assert.ok(lease); lease.complete();
  const replacement = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });
  // Every stale method call on the retired operation must be inert: none of them may free the ID the
  // replacement now holds.
  await old.seal(); old.invalidate("artifact-runtime-invalidated"); await old.seal();
  assert.throws(() => r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id }), (e) => e.code === "artifact-capacity");
  await replacement.seal();
  await r.close();
});

test("invalidation cleanup failure remains terminal and retains operation reservation", async () => {
  const root = join(temp(), "a"), source = pdf(temp()), id = "A".repeat(22);
  let reachedLink;
  const linked = new Promise((resolve) => { reachedLink = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const r = new ArtifactRuntime({ enabled: true, root, afterLinkBeforeCommit: async () => { reachedLink(); await gate; }, fsOps: { linkSync, fsyncSync, unlinkSync(path) { if (path.endsWith(`${id}.pdf`)) throw new Error("unlink"); return unlinkSync(path); } } });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });
  op.registerDownload({ path: () => source });
  await linked;
  // Invalidated mid-publication, and the discard itself fails: the cleanup failure supersedes the
  // invalidation reason and the reservation must be retained forever after.
  op.invalidate("artifact-runtime-invalidated");
  release();
  assert.deepEqual(await op.seal(), { outcome: "capture-failed", failure: "artifact-cleanup-failed" });
  op.invalidate("artifact-runtime-invalidated");
  assert.deepEqual(await op.seal(), { outcome: "capture-failed", failure: "artifact-cleanup-failed" });
  assert.throws(() => r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id }), (e) => e.code === "artifact-capacity");
  assert.equal(existsSync(join(root, ".gateway-lock")), true);
});

test("multiple cleanup failure supersedes multiple-artifacts and retains reservation", async () => {
  const root = join(temp(), "a"), source = pdf(temp()), id = "B".repeat(22);
  const r = new ArtifactRuntime({ enabled: true, root, fsOps: { linkSync, fsyncSync, unlinkSync(path) { if (path.endsWith(`${id}.pdf`)) throw new Error("unlink"); return unlinkSync(path); } } });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });
  op.registerDownload({ path: () => source });
  assert.equal((await op.seal()).outcome, "available");
  // A second event on a committed operation is inert; the reservation is still held by the artifact.
  op.registerDownload({ path: () => source });
  assert.equal((await op.seal()).outcome, "available");
  assert.throws(() => r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id }), (e) => e.code === "artifact-capacity");
});

test("in-flight invalidation and multiple retain ID until continuation cleanup completes", async () => {
  for (const mode of ["invalidate", "multiple"]) {
    const root = join(temp(), mode), source = pdf(temp()), id = `${mode === "invalidate" ? "C" : "D"}`.repeat(22);
    let cleanedUp; const cleaned = new Promise((resolve) => { cleanedUp = resolve; });
    const r = new ArtifactRuntime({ enabled: true, root, onOperationReleased: () => cleanedUp() });
    let release; const gate = new Promise((resolve) => { release = resolve; });
    const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });
    op.registerDownload({ path: async () => { await gate; return source; } });
    if (mode === "invalidate") op.invalidate("artifact-runtime-invalidated");
    else op.registerDownload({ path: () => source });
    // Terminal already, but the first continuation is still running: the ID stays reserved.
    assert.throws(() => r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id }), (e) => e.code === "artifact-capacity");
    release();
    const terminal = await op.seal();
    // seal() is no longer a cleanup barrier once the outcome is already decided (that is what keeps
    // teardown non-queued), so wait on the continuation's own durable discard instead.
    await cleaned;
    assert.equal(readdirSync(join(root, "data")).length, 0);
    assert.equal(r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id }).artifactId, id);
    assert.equal(terminal.failure, mode === "invalidate" ? "artifact-runtime-invalidated" : "multiple-artifacts");
  }
});

test("runtime close invalidates preexisting operations and rejects new ones", async () => {
  const root = join(temp(), "a"), r = new ArtifactRuntime({ enabled: true, root });
  const open = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: "Z".repeat(22) });
  const closing = r.close();
  assert.throws(() => r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: "Y".repeat(22) }), (e) => e.code === "artifact-runtime-invalidated");
  assert.deepEqual(await open.seal(), { outcome: "capture-failed", failure: "artifact-runtime-invalidated" });
  assert.strictEqual(r.close(), closing);
  await closing;
});

test("runtime close revokes committed available artifacts without a public disposal method", async () => {
  const root = join(temp(), "a"), source = pdf(temp()), id = "W".repeat(22);
  const r = new ArtifactRuntime({ enabled: true, root });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });
  // The operation exposes NO disposal surface: revocation is reachable only from inside the runtime.
  assert.equal(typeof op.disposeForRuntime, "undefined");
  assert.equal(Object.getOwnPropertyNames(Object.getPrototypeOf(op)).some((name) => /dispose/i.test(name)), false);
  op.registerDownload({ path: () => source });
  assert.equal((await op.seal()).outcome, "available");
  const closing = r.close();
  await closing;
  assert.equal(await r.store.acquire(id, "owner"), null);
});

test("capture rejects every invalid per-capture TTL before accounting", async () => {
  for (const ttlMs of [-1, 0, NaN, Infinity, 1.5]) {
    const root = join(temp(), `ttl-${String(ttlMs)}`), source = pdf(temp()), id = "V".repeat(22);
    const s = new ArtifactStore({ enabled: true, root, maxCount: 1 });
    assert.deepEqual(await s.capture(source, { id, consumerId: "c", ttlMs }), { status: "capture-failed", failure: "artifact-config-invalid" });
    assert.equal(await s.acquire(id, "c"), null);
    await s.close();
  }
});

test("id generator failures are private typed configuration errors", () => {
  for (const idGenerator of [() => { throw new Error("secret sentinel"); }, () => Symbol("secret"), () => ({ secret: true }), () => null]) {
    const r = new ArtifactRuntime({ enabled: true, root: join(temp(), "generator") , idGenerator });
    assert.throws(() => r.createOperation({ owner: OWNER, sourceHost: "example.com" }), e => e.code === "artifact-config-invalid" && !String(e).includes("secret"));
    r.close();
  }
});

test("all public artifact ID boundaries reject nonstrings with private typed errors", async () => {
  const values = [Symbol("private sentinel"), { secret: true }, 42, null];
  for (const value of values) {
    const runtime = new ArtifactRuntime({ enabled: false, root: join(temp(), "runtime-boundary") });
    assert.throws(() => runtime.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: value }), e => e.code === "invalid-artifact-id" && !String(e).includes("TypeError") && !String(e).includes("private sentinel"));
    await runtime.close();

    const store = new ArtifactStore({ enabled: false, root: join(temp(), "store-boundary") });
    await assert.rejects(store.capture("/private/sentinel", { id: value, consumerId: "owner" }), e => e.code === "invalid-artifact-id" && !String(e).includes("TypeError") && !String(e).includes("private sentinel"));
    assert.throws(() => store.acquire(value, "owner"), e => e.code === "invalid-artifact-id" && !String(e).includes("TypeError") && !String(e).includes("private sentinel"));
    assert.throws(() => store.discardArtifact(value), e => e.code === "invalid-artifact-id" && !String(e).includes("TypeError") && !String(e).includes("private sentinel"));
  }
});




test("invalidate carries the exact lifecycle code and discards a staged artifact", async () => {
  const root = join(temp(), "a");
  const source = pdf(temp());
  const r = new ArtifactRuntime({ enabled: true, root });
  for (const code of ["download-settle-timeout", "download-lifecycle-race"]) {
    const id = code[9].toUpperCase().repeat(22);
    const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });
    op.registerDownload({ path: () => source });
    await new Promise((resolve) => setImmediate(resolve)); // let the copy land before terminalizing
    op.invalidate(code);
    assert.deepEqual(await op.seal(), { outcome: "capture-failed", failure: code });
    assert.deepEqual(readdirSync(join(root, "data")), [], `${code} left a file behind`);
  }
  r.close();
});

test("invalidate wins against a late in-flight capture, which cannot publish", async () => {
  const root = join(temp(), "a");
  const source = pdf(temp());
  const r = new ArtifactRuntime({ enabled: true, root });
  let release;
  const deferred = new Promise((resolve) => { release = resolve; });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: "T".repeat(22) });
  op.registerDownload({ path: async () => { await deferred; return source; } });
  op.invalidate("download-settle-timeout");
  release();
  assert.deepEqual(await op.seal(), { outcome: "capture-failed", failure: "download-settle-timeout" });
  assert.deepEqual(readdirSync(join(root, "data")), [], "a late completion published after terminalization");
  r.close();
});

// --- Amendment 3 §1 / Amendment 5 §2: the authoritative operation API and commit authority ---

test("createOperation is owner-bound and exposes an opaque per-operation identity", () => {
  const r = new ArtifactRuntime({ enabled: true, root: join(temp(), "a") });
  const op = r.createOperation({ owner: OWNER, sourceHost: "EXAMPLE.COM." });
  assert.equal(op.sourceHost, "example.com");
  assert.deepEqual(op.owner, OWNER);
  assert.equal(typeof op.operationId, "string");
  assert.ok(op.operationId.length > 0);
  assert.notEqual(op.operationId, op.artifactId, "operation identity is not the artifact identity");
  const other = r.createOperation({ owner: OWNER, sourceHost: "example.com" });
  assert.notEqual(op.operationId, other.operationId);
  r.close();
});

test("createOperation rejects a malformed owner before reserving anything", () => {
  const r = new ArtifactRuntime({ enabled: true, root: join(temp(), "a") });
  for (const owner of [undefined, {}, { scope: "consumer", consumerId: "" }, { scope: "drive", consumerId: "c" }]) {
    assert.throws(() => r.createOperation({ owner, sourceHost: "example.com" }), (e) => e.code === "artifact-config-invalid");
  }
  r.close();
});

test("registerDownload starts staging without exposing a promise, and seal awaits it", async () => {
  const source = pdf(temp());
  const r = new ArtifactRuntime({ enabled: true, root: join(temp(), "a") });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com" });
  assert.equal(op.registerDownload({ path: () => source }), undefined, "registerDownload returns nothing");
  assert.equal((await op.seal()).outcome, "available", "seal must await the staging it started");
  r.close();
});

test("invalidate before commit wins: a paused seal resumes to capture-failed with the exact reason", async () => {
  const root = join(temp(), "a");
  const source = pdf(temp());
  let releaseCommit;
  const paused = new Promise((resolve) => { releaseCommit = resolve; });
  const r = new ArtifactRuntime({ enabled: true, root, beforeCommit: () => paused });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: "M".repeat(22) });
  op.registerDownload({ path: () => source });
  const sealing = op.seal();
  await new Promise((resolve) => setImmediate(resolve));

  // Synchronous invalidation lands in the exact window between "jobs settled" and "result committed".
  op.invalidate("artifact-runtime-invalidated");
  releaseCommit();

  assert.deepEqual(await sealing, { outcome: "capture-failed", failure: "artifact-runtime-invalidated" });
  assert.deepEqual(readdirSync(join(root, "data")), [], "a provisional artifact survived invalidation");
  r.close();
});

test("the inverse order: once committed, ordinary invalidation preserves the artifact", async () => {
  const root = join(temp(), "a");
  const source = pdf(temp());
  const r = new ArtifactRuntime({ enabled: true, root });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: "N".repeat(22) });
  op.registerDownload({ path: () => source });
  const committed = await op.seal();
  assert.equal(committed.outcome, "available");

  op.invalidate("artifact-runtime-invalidated");

  assert.deepEqual(await op.seal(), committed, "a committed result must not be rewritten");
  assert.equal(readdirSync(join(root, "data")).length, 1, "an already-returnable artifact was destroyed");
  r.close();
});

test("invalidate is synchronous and idempotent; the first reason stands", async () => {
  const r = new ArtifactRuntime({ enabled: true, root: join(temp(), "a") });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com" });
  op.invalidate("download-lifecycle-race");
  op.invalidate("download-settle-timeout");
  assert.deepEqual(await op.seal(), { outcome: "capture-failed", failure: "download-lifecycle-race" });
  r.close();
});

test("a late registerDownload after sealing began is inert and cannot change the outcome", async () => {
  const source = pdf(temp());
  const r = new ArtifactRuntime({ enabled: true, root: join(temp(), "a") });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com" });
  const sealing = op.seal();
  op.registerDownload({ path: () => source }); // arrives after the generation left `open`
  assert.deepEqual(await sealing, { outcome: "none" });
  r.close();
});

test("seal on an invalidated operation reports the invalidation WITHOUT committing", async () => {
  let commits = 0;
  const r2 = new ArtifactRuntime({ enabled: true, root: join(temp(), "b"), onOperationCommitted: () => { commits += 1; } });
  const op = r2.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: "I".repeat(22) });
  op.invalidate("download-lifecycle-race");

  // Only `sealing -> committed` is a legal commitment. Sealing an already-invalidated operation must
  // report the original reason and run NO commitment/release logic — repeatedly.
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await op.seal(), { outcome: "capture-failed", failure: "download-lifecycle-race" });
  }
  assert.equal(commits, 0, "seal committed an already-invalidated operation — an illegal transition");

  // And a later ordinary invalidation still cannot rewrite it.
  op.invalidate("artifact-runtime-invalidated");
  assert.deepEqual(await op.seal(), { outcome: "capture-failed", failure: "download-lifecycle-race" });
  r2.close();
});

test("a beforeCommit exception invalidates with a closed code instead of committing", async () => {
  const root = join(temp(), "a");
  const source = pdf(temp());
  const r = new ArtifactRuntime({
    enabled: true,
    root,
    beforeCommit: () => { throw new Error("/private/commit-seam sentinel"); },
  });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: "F".repeat(22) });
  op.registerDownload({ path: () => source });

  const result = await op.seal();

  // An exception before commitment must fail closed, not be swallowed and then committed as available.
  assert.equal(result.outcome, "capture-failed", "a commit-seam fault produced a returnable artifact");
  assert.equal(JSON.stringify(result).includes("sentinel"), false, "raw exception text crossed the seam");
  assert.deepEqual(readdirSync(join(root, "data")), [], "a provisional artifact survived a commit fault");
  r.close();
});

test("public operation/store inputs normalize hostile getters without raw exception leakage", async () => {
  const secret = "PRIVATE_GETTER_SENTINEL";
  const runtime = new ArtifactRuntime({ enabled: false, root: join(temp(), "hostile-runtime-input") });
  const operationInputs = [
    null,
    undefined,
    new Proxy({}, { get() { throw new Error(secret); } }),
    { owner: new Proxy({}, { get() { throw new Error(secret); } }), sourceHost: "example.com" },
  ];
  for (const input of operationInputs) {
    assert.throws(
      () => runtime.createOperation(input),
      (e) => e?.code === "artifact-config-invalid" && !String(e).includes(secret) && !(e instanceof TypeError),
      "hostile createOperation input escaped its closed error boundary",
    );
  }
  const operationReads = { owner: 0, sourceHost: 0, artifactId: 0, scope: 0, consumerId: 0, controllerId: 0 };
  const statefulOwner = {};
  for (const [key, value] of [["scope", "consumer"], ["consumerId", "stable-owner"], ["controllerId", undefined]]) {
    Object.defineProperty(statefulOwner, key, { get() { operationReads[key]++; return value; } });
  }
  const statefulInput = {};
  for (const [key, value] of [["owner", statefulOwner], ["sourceHost", "example.com"], ["artifactId", "Q".repeat(22)]]) {
    Object.defineProperty(statefulInput, key, { get() { operationReads[key]++; return value; } });
  }
  runtime.createOperation(statefulInput);
  assert.deepEqual(operationReads, { owner: 1, sourceHost: 1, artifactId: 1, scope: 1, consumerId: 1, controllerId: 1 }, "createOperation re-read untrusted properties");
  await runtime.close();

  const store = new ArtifactStore({ enabled: false, root: join(temp(), "hostile-store-input") });
  const captureOptions = [
    null,
    undefined,
    new Proxy({}, { get() { throw new Error(secret); } }),
    { get id() { throw new Error(secret); }, consumerId: "owner" },
    { id: "Z".repeat(22), get consumerId() { throw new Error(secret); } },
    { id: "Z".repeat(22), consumerId: "owner", get ttlMs() { throw new Error(secret); } },
  ];
  for (const options of captureOptions) {
    await assert.rejects(
      store.capture("/private/sentinel", options),
      (e) => e?.code === "artifact-config-invalid" && !String(e).includes(secret) && !(e instanceof TypeError),
      "hostile capture options escaped the closed error boundary",
    );
  }
  const captureReads = { id: 0, consumerId: 0, ttlMs: 0 };
  const statefulOptions = {};
  for (const [key, value] of [["id", "R".repeat(22)], ["consumerId", "stable-owner"], ["ttlMs", 5_000]]) {
    Object.defineProperty(statefulOptions, key, { get() { captureReads[key]++; return value; } });
  }
  assert.deepEqual(await store.capture("/private/sentinel", statefulOptions), { status: "capture-failed", failure: "artifact-runtime-invalidated" });
  assert.deepEqual(captureReads, { id: 1, consumerId: 1, ttlMs: 1 }, "capture re-read untrusted options");
  await store.close();
});

test("createOperation validates owner scope and controller shape exactly", () => {
  const r = new ArtifactRuntime({ enabled: true, root: join(temp(), "a") });
  const rejected = [
    { scope: "consumer" },                                        // no consumer
    { scope: "", consumerId: "c" },                               // empty scope
    { scope: "CONSUMER", consumerId: "c" },                       // wrong case
    { scope: "operator", consumerId: "c" },                       // not in the closed set
    { scope: "drive", consumerId: "c" },                          // drive without a controller
    { scope: "drive", consumerId: "c", controllerId: "" },        // drive with an empty controller
    { scope: "consumer", consumerId: "c", controllerId: "k" },    // consumer must NOT carry one
  ];
  for (const owner of rejected) {
    assert.throws(
      () => r.createOperation({ owner, sourceHost: "example.com" }),
      (e) => e.code === "artifact-config-invalid",
      `accepted a malformed owner: ${JSON.stringify(owner)}`,
    );
  }
  // Both legal shapes are accepted.
  assert.ok(r.createOperation({ owner: { scope: "consumer", consumerId: "c" }, sourceHost: "example.com" }));
  assert.ok(r.createOperation({ owner: { scope: "drive", consumerId: "c", controllerId: "k" }, sourceHost: "example.com" }));
  r.close();
});

test("the operation keeps a frozen snapshot: mutating the caller's owner cannot divert an artifact", async () => {
  const root = join(temp(), "a"), source = pdf(temp());
  const r = new ArtifactRuntime({ enabled: true, root });
  const owner = { scope: "consumer", consumerId: "rightful" };
  const op = r.createOperation({ owner, sourceHost: "example.com", artifactId: "Z".repeat(22) });

  // The caller mutates its own object AFTER creation — asynchronously, before staging completes.
  owner.consumerId = "attacker";
  owner.scope = "drive";
  owner.controllerId = "injected";

  // TypeScript `readonly` is erased. The operation's own identity-bearing properties must also be
  // non-writable and non-configurable at the JavaScript boundary, or a caller can replace the frozen
  // owner snapshot (or disconnect the reserved ID/host) before the asynchronous staging read.
  assert.throws(() => { op.owner = { scope: "consumer", consumerId: "attacker" }; }, "owner property was replaceable");
  assert.throws(() => { op.artifactId = "Y".repeat(22); }, "artifactId property was replaceable");
  assert.throws(() => { op.sourceHost = "attacker.test"; }, "sourceHost property was replaceable");
  assert.throws(() => { op.operationId = "attacker-operation"; }, "operationId property was replaceable");
  for (const property of ["owner", "artifactId", "sourceHost", "operationId"]) {
    assert.throws(
      () => Object.defineProperty(op, property, { value: "redefined" }),
      `${property} could be redefined`,
    );
  }
  assert.deepEqual(Object.keys(op), [], "operation internals or private identity are enumerable");
  assert.equal(JSON.stringify(op), "{}", "operation serialization exposed private capture state");
  assert.deepEqual(Object.keys(r), [], "runtime internals or store are enumerable");
  assert.equal(JSON.stringify(r), "{}", "runtime serialization exposed the private store or root");

  op.registerDownload({ path: () => source });
  const result = await op.seal();

  assert.equal(result.outcome, "available");
  assert.equal(result.artifact.consumerId, "rightful", "the stored artifact followed the mutated owner");
  assert.equal(op.owner.consumerId, "rightful", "the operation retained caller-mutable owner state");
  assert.equal(op.owner.scope, "consumer");
  assert.equal("controllerId" in op.owner, false, "a controller id was injected after creation");
  assert.throws(() => { op.owner.consumerId = "attacker"; }, "the owner snapshot is not frozen");
  // And the artifact really belongs to the rightful owner.
  assert.equal(await r.store.acquire(result.artifact.id, "attacker"), null);
  assert.ok(await r.store.acquire(result.artifact.id, "rightful"));
  await r.close();
});

// ---------------------------------------------------------------------------------------------
// Slice 1 — runtime invalidation vocabulary (final security matrix C)
//
// The closed failure vocabulary was enforced only by the TypeScript union, which is erased at
// runtime: a JavaScript caller could store an arbitrary path, URL or bearer-like string as an
// operation's invalidation reason and have it returned by seal() and handed to onOperationTerminal.
// ---------------------------------------------------------------------------------------------

/** The exact closed vocabulary, duplicated deliberately: if production drops or renames a member,
 *  this list stops matching and the preservation test below goes RED instead of silently narrowing. */
const FAILURE_CODES = [
  "download-capture-failed", "download-settle-timeout", "download-lifecycle-race", "multiple-artifacts", "inline-pdf-unsupported",
  "artifact-size-limit", "artifact-not-pdf", "artifact-write-failed", "artifact-integrity-failed", "artifact-filesystem-unsupported", "artifact-transport-unsupported",
  "artifact-capacity", "artifact-expired", "artifact-not-found", "artifact-owner-mismatch", "artifact-rate-limited", "artifact-response-timeout", "artifact-cleanup-failed", "artifact-runtime-invalidated",
  "artifact-root-locked", "artifact-root-invalid", "artifact-config-invalid",
];

test("every closed failure code survives invalidation exactly", async () => {
  const terminals = [];
  const r = new ArtifactRuntime({ enabled: true, root: join(temp(), "a"), onOperationTerminal: (reason) => terminals.push(reason) });
  for (const code of FAILURE_CODES) {
    const op = r.createOperation({ owner: OWNER, sourceHost: "example.com" });
    op.invalidate(code);
    assert.deepEqual(await op.seal(), { outcome: "capture-failed", failure: code }, `the exact code ${code} was not preserved`);
  }
  assert.deepEqual(terminals, FAILURE_CODES, "the terminal callback did not receive each exact code");
  await r.close();
});

test("invalid runtime invalidation reasons are mapped to a closed code and never leak", async () => {
  const sentinel = "/private/statements/2026-08 Bearer sk-live-SENTINEL";
  // Labelled, because coercing a hostile value for an assertion message is exactly what production
  // must not do either: a bare `String(reason)` here fires the proxy trap and leaks the sentinel.
  const hostile = [
    ["bearer-like path", sentinel],
    ["url with embedded token", `https://eid.example/private?token=${encodeURIComponent(sentinel)}`],
    ["empty string", ""],
    ["padded valid code", " download-capture-failed "],
    ["wrong-case valid code", "DOWNLOAD-CAPTURE-FAILED"],
    ["valid code with a suffix", "artifact-config-invalid extra"],
    ["null", null],
    ["undefined", undefined],
    ["number", 42],
    ["boolean", true],
    ["object with coercion hooks", { toString: () => sentinel, valueOf: () => sentinel }],
    ["array", [sentinel]],
    ["symbol", Symbol(sentinel)],
    ["hostile proxy", new Proxy({}, { get() { throw new Error(sentinel); }, has() { throw new Error(sentinel); }, ownKeys() { throw new Error(sentinel); } })],
  ];
  for (const [label, reason] of hostile) {
    const terminals = [];
    const r = new ArtifactRuntime({ enabled: true, root: join(temp(), "a"), onOperationTerminal: (code) => terminals.push(code) });
    const op = r.createOperation({ owner: OWNER, sourceHost: "example.com" });
    // Synchronous, non-throwing, and never evaluated: a hostile value must not be coerced at all.
    assert.equal(op.invalidate(reason), undefined, `invalidate threw or returned for the ${label}`);
    const result = await op.seal();
    assert.deepEqual(result, { outcome: "capture-failed", failure: "artifact-config-invalid" }, `an invalid reason was not normalized: the ${label}`);
    assert.deepEqual(terminals, ["artifact-config-invalid"], "the raw value reached the terminal callback");
    assert.equal(JSON.stringify(result).includes("SENTINEL"), false, "raw text crossed the result seam");
    assert.equal(terminals.some((code) => String(code).includes("SENTINEL")), false, "raw text crossed the callback seam");
    await r.close();
  }
});

test("an invalid reason after a terminal state rewrites nothing, throws nothing and leaks nothing", async () => {
  const sentinel = "/private/secret SENTINEL";
  const hostileValues = [sentinel, new Proxy({}, { get() { throw new Error(sentinel); } }), Symbol(sentinel)];
  const root = join(temp(), "a"), source = pdf(temp());
  const terminals = [];
  const r = new ArtifactRuntime({ enabled: true, root, onOperationTerminal: (code) => terminals.push(code) });

  // Already invalidated: the first reason stands and the hostile value is never even read.
  const invalidated = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: "X".repeat(22) });
  invalidated.invalidate("download-lifecycle-race");
  for (const reason of hostileValues) invalidated.invalidate(reason);
  assert.deepEqual(await invalidated.seal(), { outcome: "capture-failed", failure: "download-lifecycle-race" });

  // Already committed: an available artifact survives, and no rewrite reaches the result.
  const committed = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: "Y".repeat(22) });
  committed.registerDownload({ path: () => source });
  const available = await committed.seal();
  assert.equal(available.outcome, "available");
  for (const reason of hostileValues) committed.invalidate(reason);
  assert.deepEqual(await committed.seal(), available, "a committed result was rewritten by an invalid reason");
  assert.equal(existsSync(join(root, "data", `${"Y".repeat(22)}.pdf`)), true, "a committed artifact was destroyed");

  assert.deepEqual(terminals, ["download-lifecycle-race"], "a terminal operation emitted a second callback");
  assert.equal(JSON.stringify(terminals).includes("SENTINEL"), false);
  await r.close();
});

// ---------------------------------------------------------------------------------------------
// Slice 3 — attributed-download shared deadline, detached cleanup and runtime poison (matrix A)
//
// A DownloadLike whose failure()/path() never settles blocked #stage() forever: the browser core's
// own settlement guard returned, but the operation kept #active positive, so its artifact-ID
// reservation was never released and the operation, its job and the driver object stayed retained.
// Repeated hung events exhausted capacity, and no cancel()/delete() was ever attempted.
// ---------------------------------------------------------------------------------------------

/** A scheduler in ONE injected time domain, whose timers fire only when the test says so. Operation
 *  deadlines must live here — never on ambient setTimeout — so a bound is provable, not waited out. */
function fakeScheduler() {
  const timers = new Set();
  return {
    now: () => Date.now(),
    processStartedAt: () => 0,
    setTimeout(callback, delayMs) { const handle = { callback, delayMs }; timers.add(handle); return handle; },
    clearTimeout(handle) { timers.delete(handle); },
    /** Fire every armed operation-scale timer (<= the 5s settlement budget), newest state first. */
    fire(maxDelayMs = 5_000) {
      const due = Array.from(timers).filter((t) => t.delayMs <= maxDelayMs);
      for (const t of due) { timers.delete(t); t.callback(); }
      return due.length;
    },
    get armed() { return Array.from(timers).filter((t) => t.delayMs <= 5_000).length; },
  };
}

/** Resolve to a sentinel instead of hanging the runner: a wedged await must FAIL, not time out. */
async function within(promise, label, ms = 2_000) {
  let timer;
  const guard = new Promise((resolve) => { timer = setTimeout(() => resolve(`WEDGED:${label}`), ms); timer.unref?.(); });
  try { return await Promise.race([promise, guard]); } finally { clearTimeout(timer); }
}

/** A download whose accessors and disposal calls are individually controllable and recorded. */
function hungDownload({ hang = "failure", cancel = "ok", delete: del = "ok" } = {}) {
  const calls = [];
  const never = () => new Promise(() => {});
  const disposal = (name, mode) => {
    if (mode === "absent") return undefined;
    return () => {
      calls.push(name);
      if (mode === "throws") throw new Error(`driver ${name} threw synchronously`);
      if (mode === "rejects") return Promise.reject(new Error(`driver ${name} rejected`));
      if (mode === "hangs") return never();
      return Promise.resolve();
    };
  };
  const download = {
    failure: () => { calls.push("failure"); return hang === "failure" ? never() : Promise.resolve(undefined); },
    path: () => { calls.push("path"); return hang === "path" ? never() : "/driver/tmp/never-read.pdf"; },
    get calls() { return calls; },
  };
  const cancelFn = disposal("cancel", cancel);
  const deleteFn = disposal("delete", del);
  if (cancelFn) download.cancel = cancelFn;
  if (deleteFn) download.delete = deleteFn;
  return download;
}

for (const hang of ["failure", "path"]) {
  test(`a never-settling ${hang}() is bounded by the one deadline: seal returns, capacity is released`, async () => {
    const scheduler = fakeScheduler();
    const root = join(temp(), "a"), id = "A".repeat(22);
    const r = new ArtifactRuntime({ enabled: true, root, scheduler });
    const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });
    const download = hungDownload({ hang });
    op.registerDownload(download);

    const sealing = op.seal();
    assert.equal(scheduler.armed, 1, "seal() did not arm the one settlement deadline on the injected clock");
    scheduler.fire();

    assert.deepEqual(
      await within(sealing, "seal-hung-accessor"),
      { outcome: "capture-failed", failure: "download-settle-timeout" },
      "seal() stayed blocked on an accessor that never settles",
    );
    // The untrusted accessor is abandoned, and the driver's copy is disposed — cancel THEN delete.
    assert.deepEqual(download.calls.filter((c) => c === "cancel" || c === "delete"), ["cancel", "delete"]);
    // Capacity is genuinely back: the reservation was released once cleanup was confirmed.
    await within(new Promise((resolve) => setImmediate(resolve)), "drain");
    assert.equal(r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id }).artifactId, id);
    await r.close();
  });
}

test("invalidation beats a pending accessor synchronously and seal() is never queued behind it", async () => {
  const scheduler = fakeScheduler();
  const r = new ArtifactRuntime({ enabled: true, root: join(temp(), "a"), scheduler });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: "B".repeat(22) });
  const download = hungDownload({ hang: "failure" });
  op.registerDownload(download);

  op.invalidate("artifact-runtime-invalidated");
  // Disposal starts at the instant of invalidation, not at some later drain.
  assert.deepEqual(download.calls.filter((c) => c === "cancel" || c === "delete"), ["cancel", "delete"]);
  assert.deepEqual(
    await within(op.seal(), "seal-after-invalidate"),
    { outcome: "capture-failed", failure: "artifact-runtime-invalidated" },
    "seal() queued behind an accessor that will never settle",
  );
  await r.close();
});

test("attributed disposal is exactly once across repeated invalidation, close and a late accessor", async () => {
  const scheduler = fakeScheduler();
  const root = join(temp(), "a");
  const r = new ArtifactRuntime({ enabled: true, root, scheduler });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: "C".repeat(22) });
  let releaseAccessor;
  const download = {
    calls: [],
    failure: () => new Promise((resolve) => { releaseAccessor = () => resolve(undefined); }),
    path: () => { download.calls.push("path"); return pdf(temp()); },
    cancel() { download.calls.push("cancel"); return Promise.resolve(); },
    delete() { download.calls.push("delete"); return Promise.resolve(); },
  };
  op.registerDownload(download);

  op.invalidate("download-settle-timeout");
  op.invalidate("artifact-runtime-invalidated");
  op.invalidate("download-capture-failed");
  await r.close();
  releaseAccessor();                       // the untrusted accessor finally settles, far too late
  await within(new Promise((resolve) => setImmediate(resolve)), "drain");

  assert.deepEqual(download.calls, ["cancel", "delete"], "disposal was duplicated or skipped");
  assert.equal(download.calls.includes("path"), false, "a late accessor resumed the staging pipeline");
  assert.deepEqual(await within(op.seal(), "seal"), { outcome: "capture-failed", failure: "download-settle-timeout" });
});

test("a hung cancel() still gets delete() invoked, and unconfirmed cleanup poisons the runtime", async () => {
  const scheduler = fakeScheduler();
  const root = join(temp(), "a"), source = pdf(temp()), keep = "K".repeat(22), lost = "L".repeat(22);
  // The ID-reservation axis, observed at its own seam: it must NEVER fire for an operation whose
  // driver disposal could not be confirmed, independently of the runtime-health axis.
  let released = 0;
  const r = new ArtifactRuntime({ enabled: true, root, scheduler, onOperationReleased: () => { released += 1; } });

  // A committed artifact from before the incident must survive the poison and stay retrievable.
  const committed = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: keep });
  committed.registerDownload({ path: () => source });
  assert.equal((await within(committed.seal(), "seal-committed")).outcome, "available");

  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: lost });
  const download = hungDownload({ hang: "path", cancel: "hangs" });
  op.registerDownload(download);
  op.invalidate("download-settle-timeout");

  // Cancel hung; delete must have been invoked anyway, immediately after it.
  assert.deepEqual(download.calls.filter((c) => c === "cancel" || c === "delete"), ["cancel", "delete"]);
  scheduler.fire();                        // the shared cleanup budget expires
  await within(new Promise((resolve) => setImmediate(resolve)), "drain");

  // Runtime health: sticky, exact, and it does not rewrite the operation's own terminal reason.
  assert.deepEqual(await within(op.seal(), "seal-poisoned"), { outcome: "capture-failed", failure: "download-settle-timeout" });
  assert.throws(() => r.createOperation({ owner: OWNER, sourceHost: "example.com" }), (e) => e.code === "artifact-cleanup-failed");
  assert.throws(() => r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: lost }), (e) => e.code === "artifact-cleanup-failed");
  // The unsafe ID is retained, and the pre-existing artifact is still retrievable.
  const lease = await within(r.store.acquire(keep, "owner"), "acquire");
  assert.ok(lease && lease.record.id === keep, "poison destroyed an already committed artifact");
  lease.complete();
  assert.equal(released, 0, "an unconfirmed disposal released its artifact-ID reservation");
  await r.close();
});

test("cleanup settling after the deadline cannot unpoison, release or reuse an identity", async () => {
  const scheduler = fakeScheduler();
  const root = join(temp(), "a"), id = "M".repeat(22);
  let released = 0;
  const r = new ArtifactRuntime({ enabled: true, root, scheduler, onOperationReleased: () => { released += 1; } });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });
  let releaseDelete;
  const download = {
    failure: () => undefined,
    path: () => new Promise(() => {}),
    cancel: () => Promise.resolve(),
    delete: () => new Promise((resolve) => { releaseDelete = resolve; }),
  };
  op.registerDownload(download);
  op.invalidate("artifact-runtime-invalidated");
  scheduler.fire();                        // cleanup budget expires with delete still outstanding
  await within(new Promise((resolve) => setImmediate(resolve)), "drain");
  assert.throws(() => r.createOperation({ owner: OWNER, sourceHost: "example.com" }), (e) => e.code === "artifact-cleanup-failed");

  assert.equal(released, 0, "an unconfirmed disposal released its reservation");
  releaseDelete();                          // the driver finally answers, long after the bound
  await within(new Promise((resolve) => setImmediate(resolve)), "drain-late");

  assert.equal(released, 0, "a late cleanup settlement released a retained, unsafe identity");

  assert.throws(() => r.createOperation({ owner: OWNER, sourceHost: "example.com" }), (e) => e.code === "artifact-cleanup-failed", "a late cleanup healed a poisoned runtime");
  assert.throws(() => r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id }), (e) => e.code === "artifact-cleanup-failed", "a late cleanup released an unsafe identity");
  await r.close();
});

for (const mode of ["throws", "rejects"]) {
  test(`a cancel() that ${mode} does not skip delete(), and a failed disposal is never confirmed`, async () => {
    const scheduler = fakeScheduler();
    const r = new ArtifactRuntime({ enabled: true, root: join(temp(), "a"), scheduler });
    const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: "N".repeat(22) });
    const download = hungDownload({ hang: "failure", cancel: mode });
    op.registerDownload(download);

    op.invalidate("download-capture-failed");
    assert.deepEqual(download.calls.filter((c) => c === "cancel" || c === "delete"), ["cancel", "delete"], "delete was skipped");
    await within(new Promise((resolve) => setImmediate(resolve)), "drain");

    assert.throws(() => r.createOperation({ owner: OWNER, sourceHost: "example.com" }), (e) => e.code === "artifact-cleanup-failed");
    assert.deepEqual(await within(op.seal(), "seal"), { outcome: "capture-failed", failure: "download-capture-failed" }, "cleanup failure rewrote the terminal reason");
    await r.close();
  });
}

test("a download offering no disposal is still bounded and still releases its capacity", async () => {
  // BOUNDARY (deliberate, and the one place this differs from the core's unattributed-disposal seam):
  // `cancel`/`delete` are optional on DownloadLike, and every accepted B2 invariant registers plain
  // `{ path }` downloads. So a download offering NEITHER method leaves the operation nothing to
  // invoke — that is not a failed disposal and must not poison the runtime. What it must still do is
  // stop governing the operation: the hung accessor is abandoned at the deadline and capacity returns.
  const scheduler = fakeScheduler();
  const id = "P".repeat(22);
  const r = new ArtifactRuntime({ enabled: true, root: join(temp(), "a"), scheduler });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });
  op.registerDownload({ failure: () => new Promise(() => {}), path: () => "/never-read" });
  op.invalidate("artifact-runtime-invalidated");
  await within(new Promise((resolve) => setImmediate(resolve)), "drain");
  assert.deepEqual(await within(op.seal(), "seal"), { outcome: "capture-failed", failure: "artifact-runtime-invalidated" });
  assert.equal(r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id }).artifactId, id, "a hung accessor kept its identity reserved");
  await r.close();
});

test("confirmed disposal releases the identity once, and never a replacement's reservation", async () => {
  const scheduler = fakeScheduler();
  const root = join(temp(), "a"), id = "R".repeat(22);
  let released = 0;
  const r = new ArtifactRuntime({ enabled: true, root, scheduler, onOperationReleased: () => { released += 1; } });
  const old = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });
  let finishDelete;
  const download = {
    failure: () => new Promise(() => {}),                 // hung: staging can never complete
    path: () => "/never-read",
    cancel: () => Promise.resolve(),
    delete: () => new Promise((resolve) => { finishDelete = resolve; }),
  };
  old.registerDownload(download);
  old.invalidate("artifact-runtime-invalidated");
  // Drain first, so the STAGING job has already ended: what still holds the identity here is the
  // running disposal and nothing else. Asserting before this drain would pass on the job counter
  // alone and prove nothing about the cleanup condition.
  await within(new Promise((resolve) => setImmediate(resolve)), "drain-staging");

  // Cleanup is RUNNING: terminal, staging finished, but the identity is not free — disposal unproven.
  assert.throws(() => r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id }), (e) => e.code === "artifact-capacity");
  assert.equal(released, 0, "the identity was released while disposal was still running");

  finishDelete();
  await within(new Promise((resolve) => setImmediate(resolve)), "drain");
  assert.equal(released, 1, "confirmed disposal did not release the identity");

  const replacement = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });
  assert.equal(replacement.artifactId, id);
  // Every stale call on the retired operation must be inert against the token the replacement holds.
  old.invalidate("download-settle-timeout");
  await within(old.seal(), "stale-seal");
  assert.equal(released, 1, "a retired operation released a replacement's reservation");
  assert.throws(() => r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id }), (e) => e.code === "artifact-capacity");
  await r.close();
});

// ---------------------------------------------------------------------------------------------
// Slice 3 (hostile-boundary follow-up) — a DownloadLike is untrusted at every ACCESS, not just at
// every call. `#startCleanup()` read `download.cancel`/`download.delete` outside a try, and
// `invokeDisposal()` probed `.then` outside its try, so a throwing property getter or a returned
// thenable with a throwing `then` getter made the SYNCHRONOUS `invalidate()` throw — skipping the
// second disposal attempt, stranding the cleanup record in `running`, and (via the deadline timer,
// which calls `invalidate()` directly) turning into an uncaught exception in a timer callback.
// ---------------------------------------------------------------------------------------------

/** Assert the whole closed contract for a download that fights back during disposal. */
async function assertHostileDisposal(label, build, expectedCalls) {
  const scheduler = fakeScheduler();
  const sentinel = "/private/driver-internals SENTINEL";
  const calls = [];
  const terminals = [];
  let released = 0;
  const id = "H".repeat(22);
  const r = new ArtifactRuntime({
    enabled: true, root: join(temp(), "a"), scheduler,
    onOperationTerminal: (code) => terminals.push(code),
    onOperationReleased: () => { released += 1; },
  });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });
  // Hung accessor, so the operation still owns the driver's copy when it is terminalized.
  op.registerDownload(build(calls, sentinel));

  // invalidate() is SYNCHRONOUS, idempotent and NON-THROWING: a hostile getter must not be able to
  // abort the very transition that decides the outcome (the deadline timer calls this directly).
  assert.doesNotThrow(() => op.invalidate("artifact-runtime-invalidated"), `${label}: invalidate threw`);
  assert.doesNotThrow(() => op.invalidate("download-settle-timeout"), `${label}: repeat invalidate threw`);
  // Both closed operations are attempted, in order, whatever the first one does.
  assert.deepEqual(calls, expectedCalls, `${label}: disposal did not attempt both operations in order`);

  await within(new Promise((resolve) => setImmediate(resolve)), `${label}-drain`);

  // Unconfirmed: identity retained for good, runtime poisoned closed, terminal reason NOT rewritten.
  assert.equal(released, 0, `${label}: an unconfirmable disposal released its identity`);
  assert.throws(() => r.createOperation({ owner: OWNER, sourceHost: "example.com" }), (e) => e.code === "artifact-cleanup-failed", `${label}: the runtime stayed open for new captures`);
  assert.throws(() => r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id }), (e) => e.code === "artifact-cleanup-failed", `${label}: the unsafe identity was reusable`);
  const result = await within(op.seal(), `${label}-seal`);
  assert.deepEqual(result, { outcome: "capture-failed", failure: "artifact-runtime-invalidated" }, `${label}: the terminal reason was rewritten`);
  assert.equal(JSON.stringify(result).includes("SENTINEL"), false, `${label}: raw driver text crossed the result seam`);
  assert.equal(JSON.stringify(terminals).includes("SENTINEL"), false, `${label}: raw driver text crossed the callback seam`);
  await r.close();
}

test("a cancel property getter that throws does not prevent the delete attempt", async () => {
  await assertHostileDisposal(
    "cancel-getter-throws",
    (calls, sentinel) => ({
      failure: () => new Promise(() => {}),
      path: () => "/never-read",
      get cancel() { calls.push("cancel-get"); throw new Error(sentinel); },
      delete() { calls.push("delete"); return Promise.resolve(); },
    }),
    ["cancel-get", "delete"],
  );
});

test("a delete property getter that throws after cancel was invoked fails closed", async () => {
  await assertHostileDisposal(
    "delete-getter-throws",
    (calls, sentinel) => ({
      failure: () => new Promise(() => {}),
      path: () => "/never-read",
      cancel() { calls.push("cancel"); return Promise.resolve(); },
      get delete() { calls.push("delete-get"); throw new Error(sentinel); },
    }),
    ["cancel", "delete-get"],
  );
});

test("both disposal getters throwing is still two attempts, and still fails closed", async () => {
  await assertHostileDisposal(
    "both-getters-throw",
    (calls, sentinel) => ({
      failure: () => new Promise(() => {}),
      path: () => "/never-read",
      get cancel() { calls.push("cancel-get"); throw new Error(sentinel); },
      get delete() { calls.push("delete-get"); throw new Error(sentinel); },
    }),
    ["cancel-get", "delete-get"],
  );
});

for (const shape of ["always", "second-access"]) {
  test(`a disposal returning a thenable whose then getter throws (${shape}) fails closed`, async () => {
    // `then` is probed at least twice on the way through a promise adoption: once to classify the
    // value, once by the adoption itself. A getter that throws on either access is the same hostile
    // shape, and neither may escape as a synchronous throw out of invalidate().
    const hostile = (calls, sentinel, name) => {
      let reads = 0;
      return {
        get then() {
          reads += 1;
          if (shape === "always" || reads >= 2) { calls.push(`${name}-then-throw`); throw new Error(sentinel); }
          // Callable on the FIRST read, so the value really is classified as a thenable and adopted —
          // which is what forces the second read. A `then` that is not callable is legitimately a
          // plain value, and treating that as a completed call is the same as any non-promise return.
          return function then() {};
        },
      };
    };
    await assertHostileDisposal(
      `then-getter-${shape}`,
      (calls, sentinel) => ({
        failure: () => new Promise(() => {}),
        path: () => "/never-read",
        cancel() { calls.push("cancel"); return hostile(calls, sentinel, "cancel"); },
        delete() { calls.push("delete"); return hostile(calls, sentinel, "delete"); },
      }),
      ["cancel", `cancel-then-throw`, "delete", `delete-then-throw`],
    );
  });
}
