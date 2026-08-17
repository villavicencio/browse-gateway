import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync, linkSync, unlinkSync, fsyncSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactRuntime } from "../dist/artifacts/index.js";
// Amendment 3 §1: `ArtifactRuntime` is the ONLY cross-module runtime API, so the concrete store is
// not on the public barrel. These tests reach it as what it is — an INTERNAL module of
// `src/artifacts/` — which is a module-local import, not a runtime-owned instance anyone else can
// obtain. `../dist/artifacts/index.js` imports the same file, so this is the same class object the
// runtime constructs, and the prototype wrapper below still observes production captures.
import { ArtifactStore } from "../dist/artifacts/store.js";
import * as artifactIndex from "../dist/artifacts/index.js";
const dirs=[]; const temp=()=>{const d=mkdtempSync(join(tmpdir(),"bgw-artifact-"));dirs.push(d);return d};
afterEach(()=>{while(dirs.length)rmSync(dirs.pop(),{recursive:true,force:true})});
const OWNER = { scope: "consumer", consumerId: "owner" };
const ownerOf = (id) => ({ scope: "consumer", consumerId: id });
function pdf(dir){const p=join(dir,"x.pdf");writeFileSync(p,Buffer.from("%PDF-1.7\nhello"));return p}

// ---------------------------------------------------------------------------------------------
// Observing the runtime's store WITHOUT a production seam.
//
// Amendment 3 §1: the only cross-module runtime API is ArtifactRuntime, and its concrete store stays
// private. `runtime.store` is therefore gone — a caller holding a runtime cannot reach the object
// that owns the filesystem, the accounting and consumer authorization. The interleavings below still
// need that exact instance (a close, a lease, a discard, an accounting read staged mid-operation),
// so it is observed from the TEST side instead: one module-local wrapper on
// `ArtifactStore.prototype.capture` remembers the receiver a capture actually ran against.
//
// The wrapper is deliberately inert. It records `this` by IDENTITY — `Set.prototype.add` reads no
// property of it — and forwards through `Reflect.apply` with the original function, the original
// receiver and the original arguments, so the production call it stands in front of is unchanged and
// its result is returned verbatim. `this` is recorded SYNCHRONOUSLY at invocation, which is what
// makes the store reachable from a `beforeCommit` callback that runs later in the same operation.
// ---------------------------------------------------------------------------------------------
const stagedStores = new Set();
const originalCapture = ArtifactStore.prototype.capture;
ArtifactStore.prototype.capture = function (...args) {
  stagedStores.add(this);
  return Reflect.apply(originalCapture, this, args);
};
afterEach(() => { stagedStores.clear(); });
/** The store this test's runtime capture actually staged through. Valid only AFTER a capture has
 *  begun; a test with no capture, or with two distinct stores, fails here rather than guessing. */
function observedStore() {
  assert.equal(stagedStores.size, 1, "no single store staged a capture in this test, so none was observed");
  return [...stagedStores][0];
}

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

// Amendment 7 §5.2 step 1: the `closed` fence is raised synchronously, and "from that instant
// createOperation() is permanently rejected". The fence was checked on ENTRY and never again — but
// everything between the check and the reservation is caller-controlled code. The input snapshot's
// getters, the nested owner properties and an injected `idGenerator` can all re-enter and close the
// runtime while this frame is still deciding, and the frame then went on to reserve an identity and
// hand back a live operation belonging to a runtime whose close had already accounted for every
// identity it knew about.
test("createOperation refuses an identity to a runtime its own untrusted input closed", async () => {
  const triggers = ["owner", "nested-owner", "sourceHost", "artifactId", "idGenerator"];
  const observed = [];
  for (const trigger of triggers) {
    let runtime, closing;
    const shut = () => { closing ??= runtime.close(); };
    const owner = trigger === "nested-owner" ? { scope: "consumer", get consumerId() { shut(); return "owner"; } } : OWNER;
    const input = {
      get owner() { if (trigger === "owner") shut(); return owner; },
      get sourceHost() { if (trigger === "sourceHost") shut(); return "example.com"; },
      get artifactId() { if (trigger === "artifactId") shut(); return trigger === "idGenerator" ? undefined : "C".repeat(22); },
    };
    runtime = new ArtifactRuntime({
      enabled: true, root: join(temp(), "a"),
      idGenerator: () => { if (trigger === "idGenerator") shut(); return "D".repeat(22); },
    });
    let created = false, code;
    try { created = !!runtime.createOperation(input); } catch (e) { code = e.code; }
    observed.push([trigger, created, code, await within(closing ?? Promise.resolve("never-closed"), `close-${trigger}`)]);
  }
  // No operation escapes, the exception vocabulary is the closed one, and the close the input itself
  // requested still completes cleanly — a refused call reserved nothing for it to fail on.
  assert.deepEqual(observed, triggers.map((trigger) => [trigger, false, "artifact-runtime-invalidated", undefined]));
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

// `failure` is a caller-supplied PROPERTY, and the staging prefix used to read it TWICE — once for
// the conditional, once to select the callable it invoked. A stateful getter answers those two reads
// differently: the value that was classified is not the value that runs, and a second read that
// throws is charged to the driver as a capture failure it never reported. One read, one snapshot,
// invoked against its own receiver — the same discipline the disposal and option paths already use.
test("stateful download failure getter is read once and invoked with its own receiver", async () => {
  const root = join(temp(), "a"), source = pdf(temp()), id = "S".repeat(22);
  const privateMarker = "/private/second-read sentinel";
  const r = new ArtifactRuntime({ enabled: true, root });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });
  let reads = 0, calls = 0, receiver;
  const download = {
    get failure() {
      reads += 1;
      // A VALID accessor on the first read, and a trap on every later one. Nothing about this
      // download is malformed: it reports no failure, so the capture must proceed to publication.
      if (reads > 1) throw new Error(privateMarker);
      return function () { calls += 1; receiver = this; return undefined; };
    },
    path: () => source,
  };
  op.registerDownload(download);
  const result = await op.seal();
  assert.equal(reads, 1, "the failure property was read more than once");
  assert.equal(calls, 1, "the snapshotted accessor was not invoked exactly once");
  assert.equal(receiver, download, "the accessor did not run against the download it came from");
  assert.equal(result.outcome, "available", "a download reporting no failure did not publish");
  assert.equal(result.artifact.id, id);
  assert.equal(JSON.stringify(result).includes(privateMarker), false, "the second-read sentinel escaped");
  assert.deepEqual(readdirSync(join(root, "data")), [`${id}.pdf`]);
  await r.close();
});

// The control for the terminal recheck between that one read and the call. Reading the property runs
// untrusted code, and that code can retire this generation before the callable it returned is ever
// invoked. A decided operation touches nothing further on the driver's behalf — the same rule
// `registerDownload` and `#startCleanup` already follow — so the snapshot is dropped, not called.
test("a failure getter that terminalizes on read has its snapshot dropped, not invoked", async () => {
  const r = new ArtifactRuntime({ enabled: true, root: join(temp(), "a") });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: "R".repeat(22) });
  let reads = 0, calls = 0;
  op.registerDownload({
    get failure() { reads += 1; op.invalidate("download-lifecycle-race"); return () => { calls += 1; return undefined; }; },
    path: () => { throw new Error("the path accessor must never be reached"); },
  });
  assert.deepEqual(await op.seal(), { outcome: "capture-failed", failure: "download-lifecycle-race" });
  assert.equal(reads, 1, "the failure property was read more than once");
  assert.equal(calls, 0, "a decided operation invoked the driver accessor anyway");
  await r.close();
});

// `path` is the same hostile property boundary as `failure`. Reading it may synchronously retire the
// operation; the callable returned by that read must then be dropped rather than invoked on behalf of
// a generation that no longer exists.
test("a path getter that terminalizes on read has its snapshot dropped, not invoked", async () => {
  const r = new ArtifactRuntime({ enabled: true, root: join(temp(), "a") });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: "Q".repeat(22) });
  let reads = 0, calls = 0;
  op.registerDownload({
    failure: () => undefined,
    get path() {
      reads += 1;
      op.invalidate("download-lifecycle-race");
      return function () { calls += 1; return "/must-not-be-read"; };
    },
  });
  assert.deepEqual(await op.seal(), { outcome: "capture-failed", failure: "download-lifecycle-race" });
  assert.equal(reads, 1, "the path property was read more than once");
  assert.equal(calls, 0, "a decided operation invoked the path accessor anyway");
  await r.close();
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
  assert.equal(await observedStore().acquire(id, "owner"), null);
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
  const failed = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id }); failed.registerDownload({ failure: () => { throw new Error("private"); }, cancel: () => {}, delete: () => {} });
  assert.equal((await failed.seal()).failure, "download-capture-failed");
  await (r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id })).seal();
  const pathFailed = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id }); pathFailed.registerDownload({ path: () => { throw new Error("private"); }, cancel: () => {}, delete: () => {} });
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
  assert.equal(observedStore().discardArtifact(id), true);
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
  const lease = await observedStore().acquire(id, "owner"); assert.ok(lease); lease.complete();
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
  const lease = await observedStore().acquire(id, "owner"); assert.ok(lease); lease.complete();
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
  const lease = await observedStore().acquire(id, "owner"); assert.ok(lease); lease.complete();
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
  const lease = await observedStore().acquire(id, "owner"); assert.ok(lease); lease.complete();
  assert.equal((r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id })).artifactId, id);
  await r.close();
});

test("capture-originated cleanup failure retains the explicit ID reservation", async () => {
  const root = join(temp(), "a"), source = pdf(temp()), id = "K".repeat(22);
  const r = new ArtifactRuntime({ enabled: true, root, fsOps: { linkSync, unlinkSync, fsyncSync() { throw new Error("fsync"); } } });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });
  op.registerDownload({ path: () => source, cancel: () => {}, delete: () => {} });
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
  const lease = await observedStore().acquire(id, "owner"); assert.ok(lease); lease.complete();
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
  op.registerDownload({ path: () => source, cancel: () => {}, delete: () => {} });
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

test("in-flight invalidation and multiple retain ID until disposal confirmation completes", async () => {
  for (const mode of ["invalidate", "multiple"]) {
    const root = join(temp(), mode), source = pdf(temp()), id = `${mode === "invalidate" ? "C" : "D"}`.repeat(22);
    let cleanedUp; const cleaned = new Promise((resolve) => { cleanedUp = resolve; });
    const r = new ArtifactRuntime({ enabled: true, root, onOperationReleased: () => cleanedUp() });
    let confirmDelete; const deleteConfirmed = new Promise((resolve) => { confirmDelete = resolve; });
    const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });
    op.registerDownload({ path: () => source, cancel: () => {}, delete: () => deleteConfirmed });
    if (mode === "invalidate") op.invalidate("artifact-runtime-invalidated");
    else op.registerDownload({ path: () => source });
    // Terminal already, and the staging continuation has no more authority. The ID stays reserved
    // because BOTH driver disposal confirmations are the release boundary.
    assert.throws(() => r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id }), (e) => e.code === "artifact-capacity");
    confirmDelete();
    const terminal = await op.seal();
    // seal() is no longer a cleanup barrier once the outcome is already decided, so wait on the
    // operation's release observer to prove the cleanup confirmation landed.
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
  assert.equal(await observedStore().acquire(id, "owner"), null);
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

test("disabled runtime clean no-op discard releases an operation ID before close", async () => {
  const root = join(temp(), "disabled-release"), id = "Z".repeat(22);
  const runtime = new ArtifactRuntime({ enabled: false, root });
  const operation = runtime.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });
  assert.equal(operation.registerDownload({
    failure: async () => null,
    path: async () => "/private/disabled-store-never-reads-this",
    cancel: async () => {},
    delete: async () => {},
  }), true);
  assert.deepEqual(await operation.seal(), { outcome: "capture-failed", failure: "artifact-runtime-invalidated" });
  await new Promise((resolve) => setImmediate(resolve));
  const replacement = runtime.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });
  replacement.invalidate("download-lifecycle-race");
  await runtime.close();
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

test("registerDownload returns an ownership receipt, not a promise, and seal awaits the staging", async () => {
  const source = pdf(temp());
  const r = new ArtifactRuntime({ enabled: true, root: join(temp(), "a") });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com" });
  const receipt = op.registerDownload({ path: () => source });
  // Amendment 7 §8.1: a synchronous boolean transfer receipt — NOT the private staging ledger, which
  // no caller may await, retain or race.
  assert.equal(receipt, true, "an accepted first download did not return an exact `true` receipt");
  assert.equal(typeof receipt, "boolean");
  assert.equal((await op.seal()).outcome, "available", "seal must await the staging it started");
  r.close();
});

// A `true` receipt is a claim about what is ALREADY installed, and a waitable staging obligation is
// part of it. `registerDownload()` called `#stage(download)` first and registered the promise it
// returned afterwards — but `#stage`'s own synchronous prefix reads `download.failure`, so the first
// untrusted driver touch happened while the job ledger was still empty. A `failure` getter that
// re-enters `seal()` from there snapshotted that empty ledger, awaited nothing, and committed
// `none` for a download the very next line went on to stage successfully: the operation reported
// "this page produced no artifact" about an artifact it had already accepted ownership of.
test("a seal re-entered from the download's own accessor waits for the staging that receipt accepted", async () => {
  const source = pdf(temp());
  const r = new ArtifactRuntime({ enabled: true, root: join(temp(), "a") });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: "R".repeat(22) });
  let reentrant, reads = 0;
  const receipt = op.registerDownload({
    get failure() { reads += 1; reentrant ??= op.seal(); return undefined; },
    path: () => source,
  });
  assert.equal(receipt, true, "the operation refused the first download");
  const outer = await within(op.seal(), "outer-seal");
  assert.equal(reads, 1, "the failure property was not read exactly once");
  assert.ok(reentrant, "the hostile accessor never re-entered seal()");
  assert.equal(outer.outcome, "available", "seal committed before the staging its own receipt had accepted");
  assert.deepEqual(await within(reentrant, "reentrant-seal"), outer, "the re-entrant seal committed an outcome the accepted staging never produced");
  await r.close();
});

test("registerDownload refuses with exact false, and never touches the download it refused", async () => {
  const source = pdf(temp());
  const r = new ArtifactRuntime({ enabled: true, root: join(temp(), "a") });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: "S".repeat(22) });
  assert.equal(op.registerDownload({ path: () => source }), true);

  // A SECOND registration is refused. It still terminalizes the operation (`multiple-artifacts`), but
  // the refused driver object stays the CALLER's to dispose of — so nothing here may touch it.
  const untouched = { calls: [], path() { this.calls.push("path"); return source; }, cancel() { this.calls.push("cancel"); }, delete() { this.calls.push("delete"); } };
  assert.equal(op.registerDownload(untouched), false, "a second registration did not refuse with exact `false`");
  assert.deepEqual(untouched.calls, [], "a refused download was touched by the operation that refused it");

  // A non-open operation refuses the same way, and equally without touching anything.
  const closedOp = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: "T".repeat(22) });
  closedOp.invalidate("artifact-runtime-invalidated");
  const late = { calls: [], path() { this.calls.push("path"); return source; }, cancel() { this.calls.push("cancel"); }, delete() { this.calls.push("delete"); } };
  assert.equal(closedOp.registerDownload(late), false, "a non-open operation did not refuse with exact `false`");
  assert.deepEqual(late.calls, [], "a non-open operation touched the download it refused");

  assert.deepEqual(await op.seal(), { outcome: "capture-failed", failure: "multiple-artifacts" });
  await r.close();
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
  assert.equal(await observedStore().acquire(result.artifact.id, "attacker"), null);
  assert.ok(await observedStore().acquire(result.artifact.id, "rightful"));
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
  const sentinel = "/private/statements/2026-08/INVALIDATION_REASON_SENTINEL";
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

/** The operation settlement deadline, and the SEPARATE driver-cleanup confirmation budget it opens
 *  (Amendment 7 §2). Spelled here so an assertion says which of the two it is advancing through. */
const D = 5_000;
const C = 5_000;

/**
 * A DETERMINISTIC scheduler in ONE injected time domain (Amendment 7 §3).
 *
 * `now()` is VIRTUAL and monotonic: nothing here reads `Date.now()`, so a deadline production
 * computes as `now() + budget` is reached only because a test advanced to it. That is the whole
 * point — an ambient `now()` let the settlement timer fire while the clock had not moved, so
 * `#remaining()` still read a full budget and the zero-remaining cleanup defect was invisible.
 *
 * Advancing dispatches every timer due at or before the target, INCLUDING one armed by a timer
 * callback at that same instant and one armed from a microtask continuation of that callback —
 * which is exactly how a cleanup budget opened inside the settlement timer's `invalidate()` reaches
 * this clock. Microtasks are drained explicitly between timer phases.
 */
function fakeScheduler(start = 1_000_000) {
  let time = start;
  let seq = 0;
  const timers = new Set();
  /** One explicit drain of the microtask queue (and the immediate phase behind it). */
  const microtasks = () => new Promise((resolve) => setImmediate(resolve));
  const scheduler = {
    now: () => time,
    processStartedAt: () => 0,
    setTimeout(callback, delayMs) {
      const handle = { callback, delayMs, dueAt: time + Math.max(0, delayMs), order: seq++ };
      timers.add(handle);
      return handle;
    },
    clearTimeout(handle) { timers.delete(handle); },
    /** Advance to an ABSOLUTE instant. Backward movement is a test bug, never a silent no-op. */
    async advanceTo(target) {
      if (!Number.isFinite(target) || target < time) {
        throw new Error(`advanceTo(${target}) would move virtual time backwards from ${time}`);
      }
      // A callback may arm a timer due at this same instant, so due-timer selection re-runs until
      // the instant is genuinely quiet. Bounded, so a self-rearming timer FAILS the test instead of
      // hanging the runner.
      for (let phase = 0; ; phase++) {
        if (phase > 1_000) throw new Error(`advanceTo(${target}) never settled: a timer re-arms itself at the same instant`);
        await microtasks();
        let next;
        for (const t of timers) {
          if (t.dueAt > target) continue;
          if (!next || t.dueAt < next.dueAt || (t.dueAt === next.dueAt && t.order < next.order)) next = t;
        }
        if (!next) break;
        timers.delete(next);
        time = Math.max(time, next.dueAt);
        next.callback();
      }
      time = target;
      await microtasks();
    },
    /** Advance BY a finite, non-negative delta. */
    async advanceBy(deltaMs) {
      if (!Number.isFinite(deltaMs) || deltaMs < 0) {
        throw new Error(`advanceBy(${deltaMs}) is not a finite non-negative delta`);
      }
      await scheduler.advanceTo(time + deltaMs);
    },
    /**
     * Advance virtual time SYNCHRONOUSLY, dispatching every callback that comes due.
     *
     * This is the shape a DRIVER has. `cancel()`/`delete()` are invoked synchronously inside
     * `invalidate()`, so untrusted code can burn a whole budget before it returns, without ever
     * yielding. Deliberately drains NO microtasks: a synchronous caller has not yielded, so a promise
     * continuation must not be allowed to stand in for a timer these tests assert the existence of.
     */
    advanceSync(deltaMs) {
      if (!Number.isFinite(deltaMs) || deltaMs < 0) {
        throw new Error(`advanceSync(${deltaMs}) is not a finite non-negative delta`);
      }
      const target = time + deltaMs;
      for (let phase = 0; ; phase++) {
        if (phase > 1_000) throw new Error(`advanceSync(${deltaMs}) never settled: a timer re-arms itself at the same instant`);
        let next;
        for (const t of timers) {
          if (t.dueAt > target) continue;
          if (!next || t.dueAt < next.dueAt || (t.dueAt === next.dueAt && t.order < next.order)) next = t;
        }
        if (!next) break;
        timers.delete(next);
        time = Math.max(time, next.dueAt);
        next.callback();
      }
      time = target;
    },
    /** Offsets from now of every pending timer due within `withinMs` — which bounds exist at THIS
     *  instant, and for how long, read directly instead of inferred from what an advance dispatched. */
    dueIn(withinMs) {
      return Array.from(timers).map((t) => t.dueAt - time).filter((offset) => offset <= withinMs).sort((a, b) => a - b);
    },
    /** Advance one operation-scale budget and report how many timers that dispatched. */
    async fire(maxDelayMs = D) {
      const before = timers.size;
      await scheduler.advanceBy(maxDelayMs);
      return before - timers.size;
    },
    get armed() { return Array.from(timers).filter((t) => t.dueAt - time <= D).length; },
  };
  return scheduler;
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
    await scheduler.advanceBy(D);

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

// ---------------------------------------------------------------------------------------------
// R2 — the guard on the guard. Every deadline assertion below is only worth what this scheduler is
// worth, so its own determinism is asserted first: virtual monotonic time, rejected backward
// movement, and same-instant re-arming dispatched by the advance that caused it.
// ---------------------------------------------------------------------------------------------

test("the injected scheduler owns explicit monotonic time and dispatches same-instant re-arms", async () => {
  const scheduler = fakeScheduler();
  const start = scheduler.now();

  await assert.rejects(() => scheduler.advanceTo(start - 1), /backwards/, "backward movement was accepted");
  await assert.rejects(() => scheduler.advanceBy(-1), /non-negative/, "a negative delta was accepted");
  await assert.rejects(() => scheduler.advanceBy(Number.POSITIVE_INFINITY), /non-negative/, "a non-finite delta was accepted");
  await assert.rejects(() => scheduler.advanceBy(Number.NaN), /non-negative/, "NaN was accepted as a delta");

  // Nothing here reads the wall clock: time moves only because the test moved it.
  await scheduler.advanceBy(0);
  assert.equal(scheduler.now(), start, "advanceBy(0) moved virtual time");

  const fired = [];
  scheduler.setTimeout(() => {
    fired.push("first");
    // Armed from a MICROTASK continuation of a timer callback — the exact shape of a cleanup budget
    // opened by the settlement timer. A one-shot drain misses it, and the bound it represents then
    // silently never expires.
    void Promise.resolve().then(() => { scheduler.setTimeout(() => fired.push("same-instant"), 0); });
  }, 1_000);
  await scheduler.advanceTo(start + 1_000);
  assert.deepEqual(fired, ["first", "same-instant"], "a timer armed at the same instant was never dispatched");
  assert.equal(scheduler.now(), start + 1_000, "virtual time did not land exactly on the target");

  scheduler.setTimeout(() => fired.push("later"), 1_000);
  await scheduler.advanceBy(999);
  assert.deepEqual(fired, ["first", "same-instant"], "a timer fired before its due instant");
  await scheduler.advanceBy(1);
  assert.deepEqual(fired, ["first", "same-instant", "later"], "a timer due exactly at the target did not fire");

  // The SYNCHRONOUS advance and the timer census are load-bearing for the claim-time budget assertion
  // below — one is how untrusted driver code burns a budget without yielding, the other is how a test
  // observes that the budget exists — so both are guarded here, at the same bar as the rest.
  assert.throws(() => scheduler.advanceSync(-1), /finite non-negative/, "a negative synchronous delta was accepted");
  assert.throws(() => scheduler.advanceSync(Number.NaN), /finite non-negative/, "NaN was accepted as a synchronous delta");
  const sync = [];
  scheduler.setTimeout(() => sync.push("due"), 100);
  scheduler.setTimeout(() => sync.push("beyond"), 400);
  assert.deepEqual(scheduler.dueIn(200), [100], "the census did not report exactly the bounds inside its window");
  const at = scheduler.now();
  scheduler.advanceSync(99);
  assert.deepEqual(sync, [], "a synchronous advance dispatched a timer before its due instant");
  scheduler.advanceSync(1);
  assert.deepEqual(sync, ["due"], "a synchronous advance did not dispatch the callback that came due");
  assert.equal(scheduler.now(), at + 100, "the synchronous advance did not land exactly on the target");
  assert.deepEqual(scheduler.dueIn(1_000), [300], "a dispatched timer stayed in the census, or a pending one was lost");
});

// ---------------------------------------------------------------------------------------------
// R1 — the operation settlement deadline and the driver-cleanup confirmation budget are SEPARATE.
//
// Cleanup ownership is routinely claimed BY the settlement timer, where what remains of the
// operation's budget is exactly zero. Charging disposal for that remainder recorded an already
// answered cancel()/delete() as unconfirmed: the identity was retained for good and the runtime was
// poisoned against every later capture, on the ordinary timeout path.
// ---------------------------------------------------------------------------------------------

test("an immediately-answered disposal claimed AT the deadline does not poison the runtime", async () => {
  const scheduler = fakeScheduler();
  const root = join(temp(), "a"), id = "D".repeat(22);
  let released = 0;
  const r = new ArtifactRuntime({ enabled: true, root, scheduler, onOperationReleased: () => { released += 1; } });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });
  // Hung ACCESSOR, instant DISPOSAL. The only thing that can poison this runtime is the operation
  // deadline being mistaken for the cleanup budget.
  const download = hungDownload({ hang: "failure", cancel: "ok", delete: "ok" });
  op.registerDownload(download);

  const sealing = op.seal();
  assert.equal(scheduler.armed, 1, "seal() did not arm the settlement deadline on the injected clock");
  await scheduler.advanceBy(D);            // the deadline fires; cleanup is claimed at that instant

  assert.deepEqual(
    await within(sealing, "seal-at-deadline"),
    { outcome: "capture-failed", failure: "download-settle-timeout" },
    "the operation did not return at its own deadline",
  );
  assert.deepEqual(download.calls.filter((c) => c === "cancel" || c === "delete"), ["cancel", "delete"]);
  assert.equal(released, 1, "a disposal that had already answered did not release its reservation");
  assert.doesNotThrow(
    () => r.createOperation({ owner: OWNER, sourceHost: "example.com" }),
    "an immediately-answered disposal at the deadline poisoned the runtime",
  );
  await r.close();
});

test("a hung disposal poisons at D + C, and not one instant earlier", async () => {
  const scheduler = fakeScheduler();
  const root = join(temp(), "a"), id = "E".repeat(22);
  let released = 0;
  const r = new ArtifactRuntime({ enabled: true, root, scheduler, onOperationReleased: () => { released += 1; } });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });
  const download = hungDownload({ hang: "failure", cancel: "ok", delete: "hangs" });
  op.registerDownload(download);

  const sealing = op.seal();
  await scheduler.advanceBy(D);
  assert.deepEqual(
    await within(sealing, "seal-hung-disposal"),
    { outcome: "capture-failed", failure: "download-settle-timeout" },
    "the operation did not return at its own deadline",
  );
  // At D the disposal is merely OUTSTANDING. Its budget has just opened; it has not been spent.
  assert.doesNotThrow(
    () => r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: "F".repeat(22) }),
    "an outstanding disposal poisoned the runtime at D",
  );
  assert.equal(released, 0, "an unconfirmed disposal released its reservation");
  assert.throws(
    () => r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id }),
    (e) => e.code === "artifact-capacity",
    "the unsafe identity was reusable while its disposal was still running",
  );

  await scheduler.advanceBy(C - 1);
  assert.doesNotThrow(
    () => r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: "G".repeat(22) }),
    "the cleanup confirmation budget expired before D + C",
  );

  await scheduler.advanceBy(1);            // exactly D + C
  assert.throws(
    () => r.createOperation({ owner: OWNER, sourceHost: "example.com" }),
    (e) => e.code === "artifact-cleanup-failed",
    "a hung disposal never poisoned the runtime",
  );
  assert.equal(released, 0, "a hung disposal released its identity");
  await r.close();
});

test("a disposal answering after D + C cannot heal poison, release, or reopen the identity", async () => {
  const scheduler = fakeScheduler();
  const root = join(temp(), "a"), id = "I".repeat(22);
  let released = 0;
  const r = new ArtifactRuntime({ enabled: true, root, scheduler, onOperationReleased: () => { released += 1; } });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });
  let answerDelete;
  const download = {
    calls: [],
    failure: () => new Promise(() => {}),
    path: () => "/never-read",
    cancel() { download.calls.push("cancel"); return Promise.resolve(); },
    delete() { download.calls.push("delete"); return new Promise((resolve) => { answerDelete = resolve; }); },
  };
  op.registerDownload(download);

  const sealing = op.seal();
  await scheduler.advanceBy(D + C);        // settlement, then the whole confirmation budget
  await within(sealing, "seal");
  assert.throws(() => r.createOperation({ owner: OWNER, sourceHost: "example.com" }), (e) => e.code === "artifact-cleanup-failed");

  answerDelete();                          // the driver finally answers, long past its bound
  await scheduler.advanceBy(D);

  assert.equal(released, 0, "a late settlement released a retained, unsafe identity");
  assert.throws(() => r.createOperation({ owner: OWNER, sourceHost: "example.com" }), (e) => e.code === "artifact-cleanup-failed", "a late settlement healed a poisoned runtime");
  assert.throws(() => r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id }), (e) => e.code === "artifact-cleanup-failed", "a late settlement reopened an unsafe identity");
  await r.close();
});

// ---------------------------------------------------------------------------------------------
// The CALLABLE BOUNDARY, on the mandatory cleanup path.
//
// `cancel`/`delete` are functions a DRIVER supplied, so every property of them is caller-controlled
// too — including `call` itself. Invoking through `fn.call(download)` reads that property, hands the
// caller a getter it can throw from, and loses the invocation the throw was raised to prevent: the
// cleanup the operation is obliged to perform silently never happens. `Reflect.apply` reads NOTHING
// off the callable and still passes the download as the receiver a driver's own method expects.
// ---------------------------------------------------------------------------------------------

test("a disposal callable with a hostile `call` getter is invoked without reading it, against its own receiver", async () => {
  const scheduler = fakeScheduler();
  const root = join(temp(), "a"), id = "W".repeat(22);
  const sentinel = "/private/hostile-call sentinel";
  let released = 0;
  const r = new ArtifactRuntime({ enabled: true, root, scheduler, onOperationReleased: () => { released += 1; } });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });

  let callReads = 0, cancelCalls = 0, deleteCalls = 0;
  let cancelReceiver, deleteReceiver;
  const order = [];
  // A PERFECTLY GOOD cancel — it answers immediately — behind a `call` property that traps. Nothing
  // about this download is malformed; only the property the runtime has no business reading is.
  const cancel = function () { cancelCalls += 1; cancelReceiver = this; order.push("cancel"); };
  Object.defineProperty(cancel, "call", {
    configurable: true,
    get() { callReads += 1; throw new Error(sentinel); },
  });
  const remove = function () { deleteCalls += 1; deleteReceiver = this; order.push("delete"); };
  const download = { failure: () => new Promise(() => {}), path: () => "/never-read", cancel, delete: remove };
  op.registerDownload(download);

  const sealing = op.seal();
  await scheduler.advanceBy(D);            // the deadline claims cleanup and invokes both operations

  assert.equal(callReads, 0, "the runtime read a caller-controlled `call` property off a disposal callable");
  assert.equal(cancelCalls, 1, "the hostile property read displaced the mandatory cancel() invocation");
  assert.equal(deleteCalls, 1, "delete() was not invoked exactly once");
  assert.equal(cancelReceiver, download, "cancel() did not run against the download it came from");
  assert.equal(deleteReceiver, download, "delete() did not run against the download it came from");
  assert.deepEqual(order, ["cancel", "delete"], "the synchronous cancel-then-delete order was not preserved");

  const result = await within(sealing, "seal-hostile-call");
  assert.deepEqual(result, { outcome: "capture-failed", failure: "download-settle-timeout" }, "the operation lost its own terminal reason");
  assert.equal(JSON.stringify(result).includes(sentinel), false, "the hostile getter's raw text escaped");

  // Both operations answered immediately, so this cleanup is CONFIRMED: the identity comes back and
  // the runtime is not poisoned. A read that threw instead would have retained the ID for good.
  await within(new Promise((resolve) => setImmediate(resolve)), "drain");
  assert.equal(released, 1, "a confirmed cleanup did not release its reservation");
  assert.doesNotThrow(
    () => r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id }),
    "a hostile `call` getter poisoned the runtime and retained the identity",
  );
  await r.close();
});

// ---------------------------------------------------------------------------------------------
// STATEFUL THENABLE ADOPTION — the fail-OPEN half of the same boundary.
//
// Classifying a disposal return value reads `then`; adopting it through `Promise.resolve(raw)` reads
// it a SECOND time. A thenable that answers callable-first and non-callable-second is therefore
// classified as a promise and then adopted as a plain value — so the promise machinery resolves with
// the object itself and the runtime records a cleanup that NOTHING ever confirmed. Amendment 7 §2:
// an unconfirmed cleanup is permanently failed, and no later settlement may release its identity.
// ---------------------------------------------------------------------------------------------

/** A disposal return value whose `then` is CALLABLE on its first read and non-callable on every
 *  later one. The first read's callable retains the adopter's callbacks without ever calling them,
 *  so a correct adopter stays pending and the owner's budget timer is the only thing that decides. */
function statefulThenable(sink) {
  let reads = 0;
  const value = {
    get then() {
      reads += 1;
      if (reads === 1) return function (onFulfilled) { sink.settlers.push(onFulfilled); };
      // The second answer is what the old adoption path saw: not callable, so `Promise.resolve()`
      // treated this exact object as an ordinary value and fulfilled with it.
      return 0;
    },
    get reads() { return reads; },
  };
  sink.values.push(value);
  return value;
}

test("a disposal thenable whose `then` changes between reads is read once and never falsely confirmed", async () => {
  const scheduler = fakeScheduler();
  const root = join(temp(), "a"), id = "Y".repeat(22);
  let released = 0;
  const r = new ArtifactRuntime({ enabled: true, root, scheduler, onOperationReleased: () => { released += 1; } });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });

  const sink = { values: [], settlers: [] };
  const calls = [];
  const download = {
    failure: () => new Promise(() => {}),
    path: () => "/never-read",
    cancel() { calls.push("cancel"); return statefulThenable(sink); },
    delete() { calls.push("delete"); return statefulThenable(sink); },
  };
  op.registerDownload(download);

  const sealing = op.seal();
  await scheduler.advanceBy(D);            // settlement; cleanup is claimed and both calls are made

  assert.deepEqual(calls, ["cancel", "delete"], "both mandatory disposal operations were not invoked");
  assert.equal(sink.values.length, 2, "each disposal call did not return its own thenable");
  assert.deepEqual(sink.values.map((v) => v.reads), [1, 1], "a disposal return value's `then` was read more than once");

  assert.deepEqual(
    await within(sealing, "seal-stateful-thenable"),
    { outcome: "capture-failed", failure: "download-settle-timeout" },
    "the operation did not return its own terminal reason at D",
  );

  // C - 1: the adoption is genuinely OUTSTANDING. The identity is held and unusable, and the runtime
  // is not poisoned yet, because the budget that decides has not expired.
  await scheduler.advanceBy(C - 1);
  assert.equal(released, 0, "an unconfirmed adoption released its reservation");
  assert.throws(
    () => r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id }),
    (e) => e.code === "artifact-capacity",
    "the unsafe identity was reusable while its disposal was still outstanding",
  );
  assert.doesNotThrow(
    () => r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: "Z".repeat(22) }),
    "the cleanup confirmation budget expired before D + C",
  );

  // Exactly C: unconfirmed becomes permanently failed.
  await scheduler.advanceBy(1);
  assert.throws(
    () => r.createOperation({ owner: OWNER, sourceHost: "example.com" }),
    (e) => e.code === "artifact-cleanup-failed",
    "a cleanup nothing ever confirmed was recorded as successful",
  );

  // The retained callbacks finally answer, long past the bound. Late settlement is inert.
  for (const settle of sink.settlers) settle();
  await scheduler.advanceBy(D + C);
  assert.equal(sink.settlers.length, 2, "the adoption never handed its callbacks to the thenable");
  assert.equal(released, 0, "a late settlement released a retained, unsafe identity");
  assert.throws(() => r.createOperation({ owner: OWNER, sourceHost: "example.com" }), (e) => e.code === "artifact-cleanup-failed", "a late settlement healed a poisoned runtime");
  assert.throws(
    () => r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id }),
    (e) => e.code === "artifact-cleanup-failed",
    "a late settlement made the unsafe identity reusable",
  );
  await r.close();
});

// ---------------------------------------------------------------------------------------------
// ACCESSOR THENABLE ADOPTION — the SAME one-read boundary, on `failure()` and `path()`.
//
// `raceUntrusted()` classified the accessor's return value by reading `then`, then handed that same
// object to `Promise.resolve(raw)` — which reads `then` a SECOND time. Two reads of one hostile
// getter are two different answers, and the answer that classified was not the answer that ran:
//
//  - callable A first, callable B second: A decided there was a thenable at all, and B was the
//    callable actually invoked, so the driver chose which continuation the gateway adopted;
//  - callable first, NON-callable second: the value was reclassified as an ordinary accessor value
//    and the promise machinery fulfilled with the OBJECT ITSELF — a `failure()` nothing answered
//    became a truthy reported failure, and a `path()` nothing answered became a captured path.
//
// Amendment 7 §2, as already enforced on the disposal half above: the snapshot that classifies is
// the snapshot that runs, applied against its own value as receiver.
// ---------------------------------------------------------------------------------------------

const accessorRecord = () => ({ reads: 0, invoked: [], receivers: [], settlers: [], value: undefined });

/** An accessor return value whose `then` answers a DIFFERENT callable on each read: A first, B on
 *  every later one. Neither settles — each records only that it ran and against which receiver, and
 *  retains the adopter's `onFulfilled` so a late answer can be replayed past the deadline. */
function twoCallableThenable(record) {
  let reads = 0;
  const value = {
    get then() {
      reads += 1;
      record.reads = reads;
      if (reads === 1) return function first(onFulfilled) { record.invoked.push("A"); record.receivers.push(this); record.settlers.push(onFulfilled); };
      return function second(onFulfilled) { record.invoked.push("B"); record.receivers.push(this); record.settlers.push(onFulfilled); };
    },
  };
  record.value = value;
  return value;
}

/** The fail-OPEN shape: CALLABLE on the first read, non-callable on every later one. A one-read
 *  adopter takes the callable — which never settles, so only the operation's own deadline decides.
 *  The two-read path saw `0` and adopted this exact object as an ordinary accessor value. */
function callableThenNonCallable(record) {
  let reads = 0;
  const value = {
    get then() {
      reads += 1;
      record.reads = reads;
      if (reads === 1) return function first(onFulfilled) { record.invoked.push("A"); record.receivers.push(this); record.settlers.push(onFulfilled); };
      return 0;
    },
  };
  record.value = value;
  return value;
}

test("a failure() thenable answering a different callable per read is read once and only its first callable runs", async () => {
  const scheduler = fakeScheduler();
  const root = join(temp(), "a"), source = pdf(temp()), id = "P".repeat(22);
  const r = new ArtifactRuntime({ enabled: true, root, scheduler });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });

  const record = accessorRecord();
  let pathCalls = 0;
  op.registerDownload({ failure: () => twoCallableThenable(record), path: () => { pathCalls += 1; return source; } });

  const sealing = op.seal();
  await scheduler.advanceBy(D);

  assert.equal(record.reads, 1, "the failure() return value's `then` was read more than once");
  assert.deepEqual(record.invoked, ["A"], "the callable that classified the value was not the callable that was invoked");
  assert.deepEqual(record.receivers, [record.value], "the one-read snapshot was not applied against its own value as receiver");
  assert.equal(pathCalls, 0, "a failure() that never answered was allowed to advance to path()");
  assert.deepEqual(
    await within(sealing, "seal-failure-two-callables"),
    { outcome: "capture-failed", failure: "download-settle-timeout" },
    "a never-answering failure() accessor did not retire on the operation's own deadline",
  );
  assert.equal(existsSync(join(root, "data", `${id}.pdf`)), false, "an unanswered accessor published an artifact");
  await r.close();
});

test("a path() thenable answering a different callable per read is read once and only its first callable runs", async () => {
  const scheduler = fakeScheduler();
  const root = join(temp(), "a"), id = "R".repeat(22);
  const r = new ArtifactRuntime({ enabled: true, root, scheduler });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });

  const record = accessorRecord();
  op.registerDownload({ failure: () => undefined, path: () => twoCallableThenable(record) });

  const sealing = op.seal();
  await scheduler.advanceBy(D);

  assert.equal(record.reads, 1, "the path() return value's `then` was read more than once");
  assert.deepEqual(record.invoked, ["A"], "the callable that classified the value was not the callable that was invoked");
  assert.deepEqual(record.receivers, [record.value], "the one-read snapshot was not applied against its own value as receiver");
  assert.deepEqual(
    await within(sealing, "seal-path-two-callables"),
    { outcome: "capture-failed", failure: "download-settle-timeout" },
    "a never-answering path() accessor did not retire on the operation's own deadline",
  );
  assert.equal(existsSync(join(root, "data", `${id}.pdf`)), false, "an unanswered accessor published an artifact");
  await r.close();
});

test("a failure() thenable callable first and non-callable second cannot report a failure nothing answered", async () => {
  const scheduler = fakeScheduler();
  const root = join(temp(), "a"), source = pdf(temp()), id = "S".repeat(22);
  const r = new ArtifactRuntime({ enabled: true, root, scheduler });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });

  const record = accessorRecord();
  let pathCalls = 0;
  op.registerDownload({ failure: () => callableThenNonCallable(record), path: () => { pathCalls += 1; return source; } });

  const sealing = op.seal();
  await scheduler.advanceBy(D);

  assert.equal(record.reads, 1, "the failure() return value's `then` was read more than once");
  assert.deepEqual(record.invoked, ["A"], "the exact one-read callable snapshot was not the one adopted");
  assert.equal(pathCalls, 0, "a failure() that never answered was allowed to advance to path()");
  const result = await within(sealing, "seal-failure-callable-then-noncallable");
  assert.deepEqual(
    result,
    { outcome: "capture-failed", failure: "download-settle-timeout" },
    "an accessor that never answered was adopted as an ordinary value and decided the outcome itself",
  );

  // The retained callable answers at last, a full budget past the deadline. Late settlement is inert.
  for (const settle of record.settlers) settle(undefined);
  await scheduler.advanceBy(D);
  assert.equal(record.reads, 1, "a late accessor answer re-read the value's `then`");
  assert.deepEqual(await within(op.seal(), "reseal-failure-callable-then-noncallable"), result, "a late accessor answer rewrote a decided outcome");
  assert.equal(existsSync(join(root, "data", `${id}.pdf`)), false, "a late accessor answer published an artifact");
  await r.close();
});

test("a path() thenable callable first and non-callable second cannot publish a path nothing produced", async () => {
  const scheduler = fakeScheduler();
  const root = join(temp(), "a"), source = pdf(temp()), id = "T".repeat(22);
  const r = new ArtifactRuntime({ enabled: true, root, scheduler });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });

  const record = accessorRecord();
  op.registerDownload({ failure: () => undefined, path: () => callableThenNonCallable(record) });

  const sealing = op.seal();
  await scheduler.advanceBy(D);

  assert.equal(record.reads, 1, "the path() return value's `then` was read more than once");
  assert.deepEqual(record.invoked, ["A"], "the exact one-read callable snapshot was not the one adopted");
  const result = await within(sealing, "seal-path-callable-then-noncallable");
  assert.deepEqual(
    result,
    { outcome: "capture-failed", failure: "download-settle-timeout" },
    "an accessor that never answered was adopted as an ordinary value and decided the outcome itself",
  );
  assert.equal(existsSync(join(root, "data", `${id}.pdf`)), false, "a value that answered no path published an artifact");

  // The retained callable finally answers with a REAL path, past the deadline: nothing may stage,
  // capture or publish on it.
  for (const settle of record.settlers) settle(source);
  await scheduler.advanceBy(D);
  assert.equal(record.reads, 1, "a late accessor answer re-read the value's `then`");
  assert.equal(existsSync(join(root, "data", `${id}.pdf`)), false, "a late path() answer published an artifact after the deadline");
  assert.deepEqual(await within(op.seal(), "reseal-path-callable-then-noncallable"), result, "a late path() answer rewrote a decided outcome");
  await r.close();
});

// ---------------------------------------------------------------------------------------------
// THE ONE `then` READ IS ITSELF UNTRUSTED CODE, AND IT CAN RETIRE THE GENERATION IT ANSWERS FOR.
//
// Reading `then` once and adopting THAT snapshot is right as far as it goes — but the read runs
// driver code. A getter that synchronously calls `invalidate()` and then hands back a perfectly
// callable `then` used to have that callable applied anyway, on behalf of a generation that no
// longer existed, and was handed this module's own settlement capability along with it. Every other
// untrusted seam in this class already follows the opposite rule — `registerDownload`,
// `#startCleanup`, and the `failure`/`path` PROPERTY reads whose snapshots are dropped rather than
// invoked once the read itself terminalized. The same authority recheck belongs between the one
// `then` read and the apply: after the read, before a single further hostile instruction.
//
// The disposal half is deliberately NOT symmetric: once `#startCleanup()` has claimed ownership,
// terminalization does not revoke the obligation to obtain confirmation from BOTH `cancel()` and
// `delete()`, so `invokeDisposal()` keeps adopting unconditionally.
// ---------------------------------------------------------------------------------------------

/** The path a leaked adoption would deliver: present on the download, and never in any result. */
const RACE_SENTINEL = "/private/lifecycle-race/SENTINEL.pdf";

/** A return value whose ONE `then` read retires the operation and THEN offers a callable. A correct
 *  adopter drops that callable unapplied; a stale one runs it and hands over `resolve`/`reject`. */
function terminalizingThenable(record, retire) {
  let reads = 0;
  const value = {
    get then() {
      reads += 1;
      record.reads = reads;
      retire();
      return function adopted(onFulfilled, onRejected) {
        record.invoked.push("adopted");
        record.receivers.push(this);
        record.settlers.push(onFulfilled, onRejected);
      };
    },
  };
  record.value = value;
  return value;
}

test("a failure() thenable whose one `then` read terminalizes the operation is never adopted", async () => {
  const scheduler = fakeScheduler();
  const root = join(temp(), "a"), id = "L".repeat(22);
  let released = 0;
  const r = new ArtifactRuntime({ enabled: true, root, scheduler, onOperationReleased: () => { released += 1; } });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });

  const record = accessorRecord();
  const disposals = [];
  let pathCalls = 0;
  op.registerDownload({
    failure: () => terminalizingThenable(record, () => op.invalidate("download-lifecycle-race")),
    path: () => { pathCalls += 1; return RACE_SENTINEL; },
    cancel() { disposals.push("cancel"); return Promise.resolve(); },
    delete() { disposals.push("delete"); return Promise.resolve(); },
  });

  const result = await within(op.seal(), "seal-failure-terminalizing-then");
  assert.equal(record.reads, 1, "the failure() return value's `then` was read more than once");
  assert.deepEqual(record.invoked, [], "a retired generation applied the callable its own `then` read produced");
  assert.deepEqual(record.settlers, [], "the hostile callable was handed this module's settlement capability");
  assert.equal(pathCalls, 0, "a retired generation went on to read a path from the driver");
  assert.deepEqual(
    result,
    { outcome: "capture-failed", failure: "download-lifecycle-race" },
    "the reason the hostile getter's own invalidation established did not stand",
  );
  assert.equal(JSON.stringify(result).includes(RACE_SENTINEL), false, "a driver-supplied path escaped in the result");
  assert.deepEqual(disposals, ["cancel", "delete"], "the attributed download was not disposed exactly once, in order");
  assert.deepEqual(readdirSync(join(root, "data")), [], "a terminalized generation published an artifact");

  // A late replay of anything the adoption retained is inert, and publishes nothing.
  for (const settle of record.settlers) settle(RACE_SENTINEL);
  await within(new Promise((resolve) => setImmediate(resolve)), "drain");
  assert.deepEqual(await within(op.seal(), "reseal-failure-terminalizing-then"), result, "a late answer rewrote a decided outcome");
  assert.deepEqual(readdirSync(join(root, "data")), [], "a late answer published an artifact");
  assert.equal(released, 1, "a confirmed disposal did not release the identity exactly once");
  assert.deepEqual(scheduler.dueIn(D + C), [], "the operation left a settlement or confirmation timer armed");
  assert.equal(await within(r.close(), "close-failure-terminalizing-then"), undefined, "the runtime did not close cleanly");
});

test("a path() thenable whose one `then` read terminalizes the operation is never adopted", async () => {
  const scheduler = fakeScheduler();
  const root = join(temp(), "a"), source = pdf(temp()), id = "M".repeat(22);
  let released = 0;
  const r = new ArtifactRuntime({ enabled: true, root, scheduler, onOperationReleased: () => { released += 1; } });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });

  const record = accessorRecord();
  const disposals = [];
  op.registerDownload({
    failure: () => undefined,
    path: () => terminalizingThenable(record, () => op.invalidate("download-lifecycle-race")),
    cancel() { disposals.push("cancel"); return Promise.resolve(); },
    delete() { disposals.push("delete"); return Promise.resolve(); },
  });

  const result = await within(op.seal(), "seal-path-terminalizing-then");
  assert.equal(record.reads, 1, "the path() return value's `then` was read more than once");
  assert.deepEqual(record.invoked, [], "a retired generation applied the callable its own `then` read produced");
  assert.deepEqual(record.settlers, [], "the hostile callable was handed this module's settlement capability");
  assert.deepEqual(
    result,
    { outcome: "capture-failed", failure: "download-lifecycle-race" },
    "the reason the hostile getter's own invalidation established did not stand",
  );
  assert.deepEqual(disposals, ["cancel", "delete"], "the attributed download was not disposed exactly once, in order");
  assert.equal(existsSync(join(root, "data", `${id}.pdf`)), false, "a terminalized generation published an artifact");

  // Whatever the adoption retained answers with a REAL path: nothing may stage, capture or publish.
  for (const settle of record.settlers) settle(source);
  await within(new Promise((resolve) => setImmediate(resolve)), "drain");
  assert.equal(record.reads, 1, "a late answer re-read the value's `then`");
  assert.equal(existsSync(join(root, "data", `${id}.pdf`)), false, "a late path() answer published an artifact");
  assert.deepEqual(await within(op.seal(), "reseal-path-terminalizing-then"), result, "a late answer rewrote a decided outcome");
  assert.equal(released, 1, "a confirmed disposal did not release the identity exactly once");
  assert.deepEqual(scheduler.dueIn(D + C), [], "the operation left a settlement or confirmation timer armed");
  assert.equal(await within(r.close(), "close-path-terminalizing-then"), undefined, "the runtime did not close cleanly");
});

// ---------------------------------------------------------------------------------------------
// A COMMITTED OPERATION OWNS NO TIMER.
//
// The staging job's `finally` decrements `#active` and asks to drop the settlement deadline while
// the operation is still `sealing` — which is deliberately NOT terminal, so the timer correctly
// stays armed for the commitment that is about to happen. `#commit()` then installed `committed`
// and never asked again, so a perfectly successful capture left a live deadline in the injected
// time domain; `close()` cancels the STORE's timers and can never reach an operation's.
// ---------------------------------------------------------------------------------------------

/** The store's own cleanup interval, in that same injected domain — the one timer a live runtime
 *  legitimately owns, and the exact residue a committed operation must not add to. */
const STORE_CLEANUP_INTERVAL = 60_000;

test("a successful available commit drops its settlement deadline, and close leaves no injected timer", async () => {
  const scheduler = fakeScheduler();
  const root = join(temp(), "a"), source = pdf(temp()), id = "Q".repeat(22);
  const r = new ArtifactRuntime({ enabled: true, root, scheduler });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });
  op.registerDownload({ failure: () => undefined, path: async () => source });

  const result = await within(op.seal(), "seal-committed-deadline");
  assert.equal(result.outcome, "available", "the committed-deadline probe never reached an available commit");

  assert.deepEqual(
    scheduler.dueIn(Number.MAX_SAFE_INTEGER),
    [STORE_CLEANUP_INTERVAL],
    "a committed operation left its settlement deadline armed in the injected scheduler domain",
  );

  assert.equal(await within(r.close(), "close-committed-deadline"), undefined, "the runtime did not close cleanly");
  assert.deepEqual(
    scheduler.dueIn(Number.MAX_SAFE_INTEGER),
    [],
    "runtime close left a timer behind in the injected scheduler domain",
  );
});

// ---------------------------------------------------------------------------------------------
// M1 — a discard has THREE outcomes, and the runtime owns its own reservations.
//
// `discardArtifact()` collapsed "the store refused, because it is closing and owns the deletion
// itself" into the same `false` as "deletion could not be proven". A refusal therefore rewrote a
// good terminal reason as `artifact-cleanup-failed` and stranded the operation's identity for the
// life of the process. Separately, the store's `onDiscard` hook deleted the runtime reservation
// directly, which freed an ID without consulting a single one of the operation's release conditions.
// ---------------------------------------------------------------------------------------------

test("a discard refused by a closed store preserves the terminal reason and releases on clean close", async () => {
  const scheduler = fakeScheduler();
  const root = join(temp(), "a"), src = pdf(temp()), id = "K".repeat(22);
  let released = 0;
  const r = new ArtifactRuntime({ enabled: true, root, scheduler, onOperationReleased: () => { released += 1; } });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });
  op.registerDownload({ path: () => src });
  await within(new Promise((resolve) => setImmediate(resolve)), "stage");

  // The store closes FIRST and owns the physical deletion from that instant. Its close-owned callback
  // must retire the still-open operation as runtime-invalidated; leaving it open would let seal()
  // publish the provisional record after close deleted the backing bytes.
  assert.equal(await within(observedStore().close(), "store-close"), undefined, "the store close was not clean");
  assert.deepEqual(
    await within(op.seal(), "seal-after-store-close"),
    { outcome: "capture-failed", failure: "artifact-runtime-invalidated" },
    "store close left a deleted provisional publishable",
  );
  assert.equal(released, 0, "the identity was released before the store's close result reached the operation");

  assert.equal(await within(r.close(), "runtime-close"), undefined);
  assert.deepEqual(
    await within(op.seal(), "seal-after-runtime-close"),
    { outcome: "capture-failed", failure: "artifact-runtime-invalidated" },
    "a close-refused discard was reported as a cleanup failure",
  );
  assert.equal(released, 1, "a clean store close did not release the close-refused identity");
});

test("a close-refused discard that quiesces first waits for the clean store-close acknowledgement", async () => {
  const scheduler = fakeScheduler();
  const root = join(temp(), "a"), src = pdf(temp()), blockerSrc = pdf(temp());
  const id = "Q".repeat(22), blockerId = "R".repeat(22);
  let released = 0, hookCalls = 0, releaseBlocker;
  let blockerEnteredResolve;
  const blockerEntered = new Promise((resolve) => { blockerEnteredResolve = resolve; });
  const blockerHold = new Promise((resolve) => { releaseBlocker = resolve; });
  const r = new ArtifactRuntime({
    enabled: true, root, scheduler,
    afterPartFsync: async () => {
      hookCalls += 1;
      if (hookCalls === 2) { blockerEnteredResolve(); await blockerHold; }
    },
    onOperationReleased: () => { released += 1; },
  });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });
  op.registerDownload({ path: () => src });
  await within(new Promise((resolve) => setImmediate(resolve)), "stage");

  // Keep STORE close pending with unrelated physical work, then retire an already-quiescent
  // operation. Its discard is refused and must remain reserved until the later close acknowledgement.
  const blockerCapture = observedStore().capture(blockerSrc, { id: blockerId, consumerId: "owner" });
  await within(blockerEntered, "blocker-entered");
  const storeClose = observedStore().close();
  op.invalidate("artifact-runtime-invalidated");
  const runtimeClose = r.close();
  assert.equal(released, 0, "quiescence released before store close proved physical cleanup");

  releaseBlocker();
  assert.deepEqual(await within(blockerCapture, "blocker-capture"), { status: "capture-failed", failure: "artifact-runtime-invalidated" });
  assert.equal(await within(storeClose, "store-close"), undefined);
  assert.equal(await within(runtimeClose, "runtime-close"), undefined);
  assert.deepEqual(await within(op.seal(), "seal"), { outcome: "capture-failed", failure: "artifact-runtime-invalidated" });
  assert.equal(released, 1, "clean close acknowledgement did not release the already-quiescent identity exactly once");
});

test("a FAILED store close makes a refused discard a permanent cleanup failure", async () => {
  const scheduler = fakeScheduler();
  const root = join(temp(), "a"), src = pdf(temp()), id = "L".repeat(22);
  let released = 0;
  const r = new ArtifactRuntime({
    enabled: true, root, scheduler,
    closeStepFails: (step) => step === "delete-files",
    onOperationReleased: () => { released += 1; },
  });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });
  op.registerDownload({ path: () => src });
  await within(new Promise((resolve) => setImmediate(resolve)), "stage");

  assert.equal(await within(observedStore().close(), "store-close"), "artifact-cleanup-failed");
  op.invalidate("artifact-runtime-invalidated");
  assert.equal(await within(r.close(), "runtime-close"), "artifact-cleanup-failed");

  assert.deepEqual(
    await within(op.seal(), "seal"),
    { outcome: "capture-failed", failure: "artifact-cleanup-failed" },
    "a failed store close did not supersede the terminal reason",
  );
  assert.equal(released, 0, "a failed store close released an identity it could not prove was clean");
  assert.equal(existsSync(join(root, ".gateway-lock")), true, "a failed close removed the lock");
});

// The OTHER refusal owner. `discardArtifactDetailed()` refuses for two unrelated reasons and the
// operation cannot tell them apart from the result alone (Amendment 7 §5.1): a closing store owns the
// deletion, and so does the response lease of a record that already reached `consuming`. The second is
// reachable in the narrow pre-commit window — capture has published the record, a response has
// acquired it, and the operation has not committed yet — and treating that refusal as store-close
// pending latched a close result no store close was ever going to deliver: the lease deleted the bytes
// and freed the store's accounting, while the operation's identity stayed reserved for the life of the
// process and every same-ID replacement was refused with `artifact-capacity`.
test("a provisional discard refused by a CONSUMING lease is released by that lease's completion", async () => {
  const scheduler = fakeScheduler();
  const root = join(temp(), "a"), src = pdf(temp()), id = "U".repeat(22);
  const LEASE = 15_000; // the response lease's exact bound (Amendment 2 §5), in the injected domain
  let released = 0, acquired = false, lease, op;
  const r = new ArtifactRuntime({
    enabled: true, root, scheduler,
    // The exact window between "staged jobs settled" and "result committed": a response acquires the
    // published record — moving it to `consuming` — and only then is the operation invalidated.
    beforeCommit: async () => {
      if (acquired) return;
      acquired = true;
      lease = await observedStore().acquire(id, "owner");
      op.invalidate("download-lifecycle-race");
    },
    onOperationReleased: () => { released += 1; },
  });
  op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });
  op.registerDownload({ path: () => src });

  assert.deepEqual(
    await within(op.seal(), "seal-against-consuming-lease"),
    { outcome: "capture-failed", failure: "download-lifecycle-race" },
    "a consuming refusal rewrote the operation's own terminal reason",
  );
  assert.ok(lease, "the precondition never acquired the published record as a response lease");

  // Nothing the lease owns was disturbed: its record, its bytes, its permit and its accounting are
  // exactly as the store left them, and the identity stays reserved against a replacement.
  const held = observedStore().accounting();
  assert.equal(held.responsePermitHeld, true, "the refused discard settled the response permit");
  assert.equal(held.count, 1, "the refused discard removed the consuming record");
  assert.equal(existsSync(join(root, "data", `${id}.pdf`)), true, "the refused discard deleted the lease's bytes");
  assert.equal(released, 0, "the identity was released while the lease still owned the artifact");
  assert.throws(
    () => r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id }),
    (e) => e.code === "artifact-capacity",
    "a replacement claimed the ID out from under a response that had not returned",
  );

  // The lease resolves it, exactly as Amendment 7 §5.1 requires: its `complete()` runs the owned
  // discard, and THAT ordinary notification is what frees the operation's identity.
  lease.complete();
  const settled = observedStore().accounting();
  assert.equal(existsSync(join(root, "data", `${id}.pdf`)), false, "the lease's completion left the artifact on disk");
  assert.equal(settled.responsePermitHeld, false, "the lease's completion did not yield the response permit");
  assert.deepEqual([settled.count, settled.bytes, settled.consumers], [0, 0, 0], "the lease's completion left accounting behind");
  assert.equal(released, 1, "the consuming lease's completion did not release the operation identity exactly once");
  assert.equal(
    r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id }).artifactId,
    id,
    "the identity stayed reserved after its owner proved the deletion",
  );

  // A stale second completion and the lease's own expired 15s timeout are both inert: neither may
  // release a second time, nor take the name back from the replacement that now holds it.
  lease.complete();
  await scheduler.advanceBy(LEASE + D);
  assert.equal(released, 1, "a stale lease settlement released an identity a second time");
  assert.throws(
    () => r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id }),
    (e) => e.code === "artifact-capacity",
    "a stale lease settlement freed the replacement's reservation",
  );

  assert.equal(await within(r.close(), "runtime-close"), undefined, "the close after a consuming handoff was not clean");
});

test("artifact-less invalidation after direct store close does not wait for a discard notification that cannot exist", async () => {
  const root = join(temp(), "a"), source = pdf(temp()), id = "V".repeat(22), control = "W".repeat(22);
  let released = 0;
  const r = new ArtifactRuntime({ enabled: true, root, onOperationReleased: () => { released += 1; } });

  // The TARGET operation stages nothing, so nothing about it ever reaches the store — which is how the
  // store gets observed at all. Stage and cleanly consume ONE harmless control artifact through the
  // same runtime first: its capture identifies the internal store, and consuming it durably discards
  // the bytes and releases that operation, leaving the store empty and the counter at a known 1.
  const seed = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: control });
  seed.registerDownload({ path: () => source });
  assert.equal((await within(seed.seal(), "seal-control")).outcome, "available", "the control artifact never staged, so no store was observed");
  const seedLease = await within(observedStore().acquire(control, "owner"), "acquire-control");
  assert.ok(seedLease, "the control artifact was not retrievable, so it cannot be cleanly consumed");
  seedLease.complete();
  assert.equal(released, 1, "the cleanly consumed control artifact did not release its own identity");
  assert.deepEqual(readdirSync(join(root, "data")), [], "the control artifact left bytes behind for the store close to own");
  released = 0;  // from here the counter answers for the ARTIFACT-LESS operation alone

  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });

  // The public store may be closed directly before the runtime adopts that result. This operation has
  // never staged a record, so invalidation must not manufacture an artifact wait: no store sweep and no
  // lease can ever emit an onDiscard notification for this ID.
  assert.equal(await within(observedStore().close(), "direct-store-close"), undefined);
  op.invalidate("artifact-runtime-invalidated");
  assert.deepEqual(await within(op.seal(), "artifact-less-seal"), { outcome: "capture-failed", failure: "artifact-runtime-invalidated" });
  assert.equal(released, 0, "the operation released before the runtime adopted the clean store-close proof");

  assert.equal(await within(r.close(), "runtime-adopts-close"), undefined);
  assert.equal(released, 1, "a clean close stranded an artifact-less operation behind an impossible discard notification");
});

test("a public store discard during in-flight publication tombstones the capture until it quiesces", async () => {
  const scheduler = fakeScheduler();
  const root = join(temp(), "a"), src = pdf(temp()), id = "P".repeat(22);
  const terminal = [];
  let released = 0, reachedLinkResolve, releaseLink;
  const reachedLink = new Promise((resolve) => { reachedLinkResolve = resolve; });
  const holdLink = new Promise((resolve) => { releaseLink = resolve; });
  let releasedResolve;
  const operationReleased = new Promise((resolve) => { releasedResolve = resolve; });
  const r = new ArtifactRuntime({
    enabled: true,
    root,
    scheduler,
    afterLinkBeforeCommit: async () => { reachedLinkResolve(); await holdLink; },
    onOperationTerminal: (reason) => terminal.push(reason),
    onOperationReleased: () => { released += 1; releasedResolve(); },
  });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });
  op.registerDownload({ path: () => src, cancel: () => {}, delete: () => {} });
  await within(reachedLink, "linked-before-commit");
  assert.equal(existsSync(join(root, "data", `${id}.pdf`)), true, "the capture never reached the linked pre-commit window");

  assert.equal(observedStore().discardArtifact(id), true, "the linked in-flight artifact was not durably discarded");
  assert.deepEqual(terminal, ["download-lifecycle-race"], "the in-flight discard did not synchronously retire the operation");
  assert.equal(released, 0, "the identity released while the capture continuation was still running");
  assert.equal(existsSync(join(root, "data", `${id}.pdf`)), false, "the in-flight discard left linked bytes behind");
  assert.deepEqual(
    await within(op.seal(), "seal-during-inflight-discard"),
    { outcome: "capture-failed", failure: "download-lifecycle-race" },
    "the terminal operation waited for or published the discarded in-flight capture",
  );
  assert.throws(
    () => r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id }),
    (e) => e.code === "artifact-capacity",
    "the in-flight operation released its identity before its continuation quiesced",
  );

  releaseLink();
  await within(operationReleased, "inflight-operation-release");
  assert.equal(released, 1, "the cleanly discarded operation did not release exactly once after quiescence");
  assert.equal(
    r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id }).artifactId,
    id,
    "the identity remained reserved after terminalization, clean deletion and quiescence",
  );
  await r.close();
});

test("a public store discard terminalizes an open operation before its deleted provisional can publish", async () => {
  const scheduler = fakeScheduler();
  const root = join(temp(), "a"), src = pdf(temp()), id = "N".repeat(22);
  const terminal = [];
  let released = 0;
  const r = new ArtifactRuntime({
    enabled: true,
    root,
    scheduler,
    onOperationTerminal: (reason) => terminal.push(reason),
    onOperationReleased: () => { released += 1; },
  });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });
  op.registerDownload({ path: () => src });
  await within(new Promise((resolve) => setImmediate(resolve)), "stage");
  assert.equal(existsSync(join(root, "data", `${id}.pdf`)), true, "the precondition never staged an artifact");

  // Public store access can durably delete the store record while its operation is still open. The
  // callback must synchronously retire that operation; merely clearing the committed-artifact wait
  // bit leaves the stale provisional record publishable by a later seal().
  assert.equal(observedStore().discardArtifact(id), true, "the staged artifact was not durably discarded");
  assert.deepEqual(terminal, ["download-lifecycle-race"], "durable external discard left the operation open");
  assert.equal(existsSync(join(root, "data", `${id}.pdf`)), false, "the discarded artifact remained on disk");
  assert.deepEqual(
    await within(op.seal(), "seal-after-public-discard"),
    { outcome: "capture-failed", failure: "download-lifecycle-race" },
    "seal published an available record whose backing bytes were already deleted",
  );
  assert.equal(released, 1, "a cleanly deleted, terminal and quiescent operation did not release exactly once");
  assert.equal(
    r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id }).artifactId,
    id,
    "the replacement identity remained reserved after safe terminalization",
  );
  await r.close();
});

test("a committed artifact's durable discard releases its identity through the operation", async () => {
  const scheduler = fakeScheduler();
  const root = join(temp(), "a"), src = pdf(temp()), id = "O".repeat(22);
  let released = 0;
  const r = new ArtifactRuntime({ enabled: true, root, scheduler, onOperationReleased: () => { released += 1; } });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });
  op.registerDownload({ path: () => src });
  assert.equal((await within(op.seal(), "seal")).outcome, "available");
  // Committed and still retrievable: the identity is reserved until the store proves it is gone.
  assert.equal(released, 0, "a retrievable artifact released its identity");
  assert.throws(() => r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id }), (e) => e.code === "artifact-capacity");

  assert.equal(observedStore().discardArtifact(id), true);
  assert.equal(released, 1, "a durable discard did not release the committed identity");
  assert.equal(r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id }).artifactId, id);
  await r.close();
});

// A close-owned discard is NOT a proof of clean close. It is one step inside a close whose result
// does not exist yet, so a committed operation that treats it as the last release condition frees
// its identity from inside a close that may still fail — which is exactly what Amendment 7 §5.2
// forbids: "A failed store close records cleanup failure and retains the ID permanently."
test("a failed store close retains the committed identity its own sweep already deleted", async () => {
  const scheduler = fakeScheduler();
  const root = join(temp(), "a"), src = pdf(temp()), id = "S".repeat(22);
  let released = 0;
  const steps = [], discards = [];
  const r = new ArtifactRuntime({
    enabled: true, root, scheduler,
    closeStepFails: (step) => step === "fsync-data",
    onCloseStep: (step) => steps.push([step, released]),
    onDiscard: (discardedId, closeOwned) => discards.push([closeOwned, released]),
    onOperationReleased: () => { released += 1; },
  });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });
  op.registerDownload({ path: () => src });
  const committed = await within(op.seal(), "seal");
  assert.equal(committed.outcome, "available", "the precondition never committed an available artifact");
  assert.equal(released, 0, "a retrievable artifact released its identity");

  assert.equal(await within(r.close(), "runtime-close"), "artifact-cleanup-failed", "the close did not fail after its own sweep");
  // Close owns the PHYSICAL deletion below, and this close performed it. What it never earned is the
  // logical release: the record, the reservation, the accounting and this notification are all held
  // back until the ordered teardown proves itself, so a close that fails announces nothing at all.
  assert.deepEqual(discards, [], "a failed close announced a logical release it never proved");
  assert.deepEqual(steps, [["delete-files", 0]], "the close-owned delete step released the identity before a close result existed");
  assert.equal(existsSync(join(root, "data", `${id}.pdf`)), false, "the close-owned sweep never deleted the backing artifact");
  assert.equal(existsSync(join(root, ".gateway-lock")), true, "a failed close removed the lock");
  assert.deepEqual(await within(op.seal(), "seal-after-close"), committed, "the committed available result did not survive the failed close");
  assert.equal(released, 0, "a failed store close released an identity whose cleanup it could not prove");

  // Permanently. Neither a later timer, a later settlement nor a repeated close may free it.
  await scheduler.advanceBy(D + C);
  assert.equal(await within(r.close(), "repeat-close"), "artifact-cleanup-failed", "a repeated close reported a different result");
  await within(new Promise((resolve) => setImmediate(resolve)), "quiesce");
  assert.equal(released, 0, "a late settlement released the permanently retained identity");
});

test("a committed identity is released by the CLEAN close result, never by the sweep inside it", async () => {
  const scheduler = fakeScheduler();
  const root = join(temp(), "a"), src = pdf(temp()), id = "T".repeat(22);
  let released = 0;
  const steps = [], discards = [];
  const r = new ArtifactRuntime({
    enabled: true, root, scheduler,
    onCloseStep: (step) => steps.push([step, released]),
    onDiscard: (discardedId, closeOwned) => discards.push([closeOwned, released]),
    onOperationReleased: () => { released += 1; },
  });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });
  op.registerDownload({ path: () => src });
  assert.equal((await within(op.seal(), "seal")).outcome, "available", "the precondition never committed an available artifact");
  assert.equal(released, 0, "a retrievable artifact released its identity");

  assert.equal(await within(r.close(), "runtime-close"), undefined, "the close was not clean");
  assert.deepEqual(discards, [[true, 0]], "the close-owned discard callback released the identity before a close result existed");
  assert.deepEqual(
    steps,
    [["delete-files", 0], ["fsync-data", 0], ["close-data-fd", 0], ["remove-data", 0], ["remove-diagnostic", 0], ["remove-lock", 0], ["fsync-root", 0], ["close-root-fd", 0]],
    "the identity was released during the close's physical teardown rather than from its result",
  );
  assert.equal(released, 1, "a clean store close did not release the committed identity exactly once");
  await within(new Promise((resolve) => setImmediate(resolve)), "quiesce");
  assert.equal(released, 1, "the clean close released the committed identity more than once");
});

// ---------------------------------------------------------------------------------------------
// The ONE runtime close promise, published before anything callback-capable runs.
//
// `ArtifactRuntime.close()` is a sequence of steps that all hand control to caller code: every
// tracked operation is invalidated (which reaches `onOperationTerminal`, `onOperationReleased` and
// the store's discard notification), and then the store closes, whose sweep announces every artifact
// it deleted. An observer that closes the runtime from one of those notifications is the ORDINARY
// runtime shape — the store fixed exactly this defect in its own `close()` — so it must be handed
// the promise the first caller is already awaiting, not a second one over the same close.
// ---------------------------------------------------------------------------------------------

test("a runtime close re-entered from an onDiscard observer is the ONE published promise", async () => {
  const scheduler = fakeScheduler();
  const root = join(temp(), "a"), src = pdf(temp()), id = "R".repeat(22);
  const discards = [];
  let nested, released = 0, r;
  r = new ArtifactRuntime({
    enabled: true, root, scheduler,
    onOperationReleased: () => { released += 1; },
    // The close sweep's own notification, which lands while the outer close frame is still inside
    // `store.close()` — i.e. before it could assign anything derived from that call's result.
    onDiscard: (discardedId, closeOwned) => { discards.push([discardedId, closeOwned]); nested ??= r.close(); },
  });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });
  op.registerDownload({ path: () => src });
  assert.equal((await within(op.seal(), "seal")).outcome, "available", "the precondition never committed an available artifact");

  const outer = r.close();
  assert.deepEqual(discards, [[id, true]], "the close-owned discard observer never ran, so nothing re-entered close");
  assert.ok(nested, "the discard observer's re-entrant close() produced nothing");
  assert.equal(nested, outer, "a close re-entered from onDiscard published a SECOND promise over the one close");
  assert.deepEqual(
    await within(Promise.all([outer, nested]), "close"),
    [undefined, undefined],
    "the one close did not settle every caller with its one clean result",
  );
  // The ordered teardown still ran exactly once, and to the end: a second promise over the same
  // close must not have been bought by skipping, repeating or abandoning any of it.
  assert.equal(existsSync(join(root, "data")), false, "the ordered teardown did not remove the data directory");
  assert.equal(existsSync(join(root, ".gateway-lock")), false, "the ordered teardown did not remove the lock");
  assert.equal(released, 1, "the one close did not release the committed identity exactly once");
  assert.equal(r.close(), outer, "a later close published a promise other than the canonical one");
});

test("a runtime close re-entered from operation invalidation is the ONE published promise", async () => {
  const scheduler = fakeScheduler();
  const root = join(temp(), "a");
  const order = [];
  let nested, r;
  r = new ArtifactRuntime({
    enabled: true, root, scheduler,
    // Synchronously reachable from `close()`'s step 2, i.e. BEFORE the store is even asked to close.
    // Publication has to precede invalidation too, not merely precede the store call.
    onOperationTerminal: (reason) => { order.push(`terminal:${reason}`); nested ??= r.close(); },
    onCloseStep: (step) => order.push(`step:${step}`),
  });
  const first = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: "U".repeat(22) });
  const second = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: "V".repeat(22) });

  const outer = r.close();
  assert.ok(nested, "the invalidation callback's re-entrant close() produced nothing");
  assert.equal(nested, outer, "a close re-entered from operation invalidation published a SECOND promise");
  // Amendment 7 §5.2's order survives the re-entry: every tracked generation is retired before the
  // store begins the teardown that owns physical deletion.
  assert.deepEqual(
    order,
    ["terminal:artifact-runtime-invalidated", "terminal:artifact-runtime-invalidated",
      "step:delete-files", "step:fsync-data", "step:close-data-fd", "step:remove-data", "step:remove-diagnostic", "step:remove-lock", "step:fsync-root", "step:close-root-fd"],
    "the store close began before every tracked operation had been invalidated",
  );
  assert.deepEqual(
    await within(Promise.all([outer, nested]), "close"),
    [undefined, undefined],
    "the one close did not settle every caller with its one clean result",
  );
  const invalidated = { outcome: "capture-failed", failure: "artifact-runtime-invalidated" };
  assert.deepEqual(await within(first.seal(), "seal-first"), invalidated, "the first generation was not retired by the close");
  assert.deepEqual(await within(second.seal(), "seal-second"), invalidated, "the second generation was not retired by the close");
  assert.equal(existsSync(join(root, ".gateway-lock")), false, "the ordered teardown did not remove the lock");
  assert.throws(() => r.createOperation({ owner: OWNER, sourceHost: "example.com" }), (e) => e.code === "artifact-runtime-invalidated");
});

// A close that cannot even start is still a close: the canonical promise is already published and
// every caller is already holding it, so an unexpected synchronous throw out of the store must be
// reported in the closed failure vocabulary rather than rejecting it or stranding it forever — and
// step 4 still owes every tracked operation that one result. A committed artifact whose deletion
// this close never even attempted must come out of it exactly as Amendment 7 §5.2 requires: cleanup
// failure, identity retained permanently, bytes still on disk.
test("a store close that throws synchronously settles the canonical runtime close, and never strands it", async () => {
  const base = fakeScheduler();
  // Armed only for the close itself: the capture below needs a working clock, and a fault that
  // cannot be aimed at the step under test proves nothing about that step.
  let hostile = false;
  const scheduler = { ...base, clearTimeout: (handle) => { if (hostile) throw new Error("hostile clearTimeout"); base.clearTimeout(handle); } };
  const root = join(temp(), "a"), src = pdf(temp()), id = "W".repeat(22);
  let released = 0;
  const r = new ArtifactRuntime({ enabled: true, root, scheduler, onOperationReleased: () => { released += 1; } });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });
  op.registerDownload({ path: () => src });
  const committed = await within(op.seal(), "seal");
  assert.equal(committed.outcome, "available", "the precondition never committed an available artifact");

  hostile = true;
  const outer = r.close();
  const second = r.close();
  assert.equal(second, outer, "the failed close did not latch ONE canonical promise");
  assert.deepEqual(
    await within(Promise.all([outer, second, r.close()]), "close"),
    ["artifact-cleanup-failed", "artifact-cleanup-failed", "artifact-cleanup-failed"],
    "a close that could not start reported outside the closed vocabulary, or gave its callers different answers",
  );
  // Nothing was proved gone, so nothing is released and nothing is deleted.
  assert.equal(released, 0, "a close that never ran released the committed identity");
  assert.equal(existsSync(join(root, "data", `${id}.pdf`)), true, "a close that threw before its sweep still deleted the artifact");
  assert.equal(existsSync(join(root, ".gateway-lock")), true, "a close that threw before its teardown still removed the lock");
  assert.deepEqual(await within(op.seal(), "seal-after-close"), committed, "the committed available result did not survive the failed close");
  assert.throws(() => r.createOperation({ owner: OWNER, sourceHost: "example.com" }), (e) => e.code === "artifact-runtime-invalidated");
  // Permanently: no later settlement may free the identity this failed close retained.
  await within(new Promise((resolve) => setImmediate(resolve)), "quiesce");
  assert.equal(released, 0, "a late settlement released the permanently retained identity");
});

// Step 2 failing is not a clean close. An `invalidate()` that throws leaves that generation's
// cleanup unproven, so the close must still retire every operation behind it, still close the store
// that owns physical deletion, and still report the failure — reporting `undefined` would tell the
// caller a teardown succeeded that demonstrably did not.
test("an operation invalidation that throws during close still closes the store and reports cleanup failure", async () => {
  const base = fakeScheduler();
  let hostile = false;
  // The cleanup-confirmation budget `invalidate()` arms for an operation that still owns a download.
  const scheduler = { ...base, setTimeout: (callback, delayMs) => { if (hostile) throw new Error("hostile setTimeout"); return base.setTimeout(callback, delayMs); } };
  const root = join(temp(), "a");
  const terminal = [];
  const r = new ArtifactRuntime({ enabled: true, root, scheduler, onOperationTerminal: (reason) => terminal.push(reason) });
  const owning = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: "X".repeat(22) });
  const behind = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: "Y".repeat(22) });
  assert.equal(owning.registerDownload({ path: () => new Promise(() => {}), cancel: () => {}, delete: () => {} }), true, "the precondition never took ownership of a download");

  hostile = true;
  const outer = r.close();
  assert.equal(
    await within(outer, "close"),
    "artifact-cleanup-failed",
    "a close whose own operation invalidation threw reported a clean teardown",
  );
  // The throw was contained to its own generation: the operation behind it was still retired, and
  // the store still performed the teardown it owns.
  assert.deepEqual(terminal, ["artifact-runtime-invalidated"], "the operation behind the throwing one was never invalidated");
  assert.deepEqual(
    await within(behind.seal(), "seal-behind"),
    { outcome: "capture-failed", failure: "artifact-runtime-invalidated" },
    "the operation behind the throwing one did not observe the close",
  );
  assert.equal(existsSync(join(root, ".gateway-lock")), false, "a throwing invalidation skipped the store close that owns the teardown");
  assert.equal(r.close(), outer, "the failed close did not latch ONE canonical promise");
});

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
  // The accepted staging job is registered before the driver is touched and runs from its own
  // continuation, so the accessor this test leaves hanging is invoked one turn later. Drain to it:
  // an operation already invalidated in this frame invokes nothing further on the driver's behalf,
  // and there would be no late accessor left to race.
  await within(new Promise((resolve) => setImmediate(resolve)), "stage");
  assert.equal(typeof releaseAccessor, "function", "the staging job never invoked the untrusted accessor");

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
  await scheduler.advanceBy(C);            // the cleanup confirmation budget expires
  await within(new Promise((resolve) => setImmediate(resolve)), "drain");

  // Runtime health: sticky, exact, and it does not rewrite the operation's own terminal reason.
  assert.deepEqual(await within(op.seal(), "seal-poisoned"), { outcome: "capture-failed", failure: "download-settle-timeout" });
  assert.throws(() => r.createOperation({ owner: OWNER, sourceHost: "example.com" }), (e) => e.code === "artifact-cleanup-failed");
  assert.throws(() => r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: lost }), (e) => e.code === "artifact-cleanup-failed");
  // Neither operation has released: the poisoned one never can, and the committed one is still
  // holding its identity against the artifact that is still retrievable.
  assert.equal(released, 0, "an unconfirmed disposal released its artifact-ID reservation");

  // The unsafe ID is retained, and the pre-existing artifact is still retrievable.
  const lease = await within(observedStore().acquire(keep, "owner"), "acquire");
  assert.ok(lease && lease.record.id === keep, "poison destroyed an already committed artifact");
  lease.complete();
  // Consuming it discards it durably, which releases THAT operation's identity through its own
  // release conditions (M1) — and only that one. The poisoned identity is still unusable.
  assert.equal(released, 1, "the consumed artifact's own operation did not release its identity");
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
  await scheduler.advanceBy(C);            // cleanup budget expires with delete still outstanding
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

// ---------------------------------------------------------------------------------------------
// Amendment 7 §2 — C opens at the SYNCHRONOUS cleanup claim, so the timer that spends it is armed
// at the claim, before a single caller-supplied property is read.
//
// `#startCleanup()` claimed ownership, then read `cancel`/`delete` and invoked both, and armed the
// budget only once those calls had RETURNED. Both are untrusted driver code, invoked synchronously
// inside `invalidate()`: a `cancel()` that advances the injected clock through the whole budget
// before returning left the disposal with NO bound at all during the one window a bound exists for,
// and then armed one due a full C after an instant already gone. At the boundary the runtime was
// still open for new captures and the unsafe identity still merely "running" — the exact opposite
// of what an expired confirmation budget must mean.
// ---------------------------------------------------------------------------------------------

test("the cleanup budget is armed at the claim, so a cancel() that burns C poisons at the boundary", async () => {
  const scheduler = fakeScheduler();
  const root = join(temp(), "a"), id = "S".repeat(22);
  let released = 0;
  const r = new ArtifactRuntime({ enabled: true, root, scheduler, onOperationReleased: () => { released += 1; } });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });

  // What the RETAINED identity answers at ONE exact instant, with no drain and no wall clock:
  // `artifact-capacity` is cleanup still running, `artifact-cleanup-failed` is the poison an expired
  // budget must have installed. `reusable` — the answer once the ID is free — would be neither.
  const retainedIdAnswers = () => {
    try { r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id }); return "reusable"; }
    catch (e) { return e?.code ?? "threw"; }
  };

  const calls = [];
  let budgetDuringCancel, atBoundaryMinusOne, atBoundary;
  const download = {
    failure: () => new Promise(() => {}),   // hung: the operation still owns the driver's copy
    path: () => "/never-read",
    cancel() {
      calls.push("cancel");
      // The bound must ALREADY exist, for exactly C, before this untrusted method got control.
      budgetDuringCancel = scheduler.dueIn(C);
      // Driver code burning the whole budget inside the very call the budget is meant to bound —
      // synchronously, in the one injected time domain, with nothing read off a wall clock.
      scheduler.advanceSync(C - 1);
      atBoundaryMinusOne = retainedIdAnswers();
      scheduler.advanceSync(1);
      atBoundary = retainedIdAnswers();
    },
    delete() { calls.push("delete"); return new Promise(() => {}); },   // never settles
  };
  op.registerDownload(download);

  const claimedAt = scheduler.now();
  assert.deepEqual(scheduler.dueIn(C), [], "a timer inside the budget window existed before cleanup was ever claimed");
  op.invalidate("artifact-runtime-invalidated");

  // Everything the claim-time arming must NOT have cost: both closed operations, still attempted, in
  // order, across an expiry that landed between them.
  assert.deepEqual(calls, ["cancel", "delete"], "disposal did not attempt both operations, in order, across the expiry");
  assert.deepEqual(budgetDuringCancel, [C], "no cleanup budget was armed, for exactly C, before the first driver method ran");
  assert.equal(scheduler.now(), claimedAt + C, "the driver did not advance the injected clock by exactly the budget");
  assert.equal(atBoundaryMinusOne, "artifact-capacity", "the budget expired one instant before the boundary");
  assert.equal(atBoundary, "artifact-cleanup-failed", "at the boundary the unsafe identity was still merely running: the budget was armed too late to expire");
  // Same instant, no drain: the poison is the synchronous consequence of the boundary itself.
  assert.throws(() => r.createOperation({ owner: OWNER, sourceHost: "example.com" }), (e) => e.code === "artifact-cleanup-failed", "the runtime stayed open for new captures past the cleanup budget");
  assert.equal(released, 0, "an unconfirmable disposal released its artifact-ID reservation");
  assert.deepEqual(await within(op.seal(), "seal-boundary"), { outcome: "capture-failed", failure: "artifact-runtime-invalidated" }, "the expired cleanup budget rewrote the operation's terminal reason");
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

test("a queued staging continuation invalidated before its first turn reads no hostile accessor", async () => {
  const r = new ArtifactRuntime({ enabled: true, root: join(temp(), "a") });
  const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: "O".repeat(22) });
  let accessorReads = 0;
  op.registerDownload({
    get failure() { accessorReads += 1; return () => undefined; },
    get path() { accessorReads += 1; return () => "/must-not-run"; },
    cancel: () => Promise.resolve(),
    delete: () => Promise.resolve(),
  });

  // registerDownload() owns and queues the staging job synchronously. Invalidation wins before that
  // job's first microtask; the stale continuation must retire without touching failure/path at all.
  op.invalidate("artifact-runtime-invalidated");
  assert.deepEqual(await within(op.seal(), "seal"), { outcome: "capture-failed", failure: "artifact-runtime-invalidated" });
  assert.equal(accessorReads, 0, "a stale continuation still entered a hostile driver accessor");
  await r.close();
});

for (const [label, disposal] of [
  ["neither", {}],
  ["cancel only", { cancel: () => Promise.resolve() }],
  ["delete only", { delete: () => Promise.resolve() }],
]) {
  test(`a download offering ${label} disposal method cannot confirm cleanup or release its identity`, async () => {
    const scheduler = fakeScheduler();
    const id = "P".repeat(22);
    const r = new ArtifactRuntime({ enabled: true, root: join(temp(), "a"), scheduler });
    const op = r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id });
    op.registerDownload({
      failure: () => new Promise(() => {}),
      path: () => "/never-read",
      ...disposal,
    });
    op.invalidate("artifact-runtime-invalidated");
    await within(new Promise((resolve) => setImmediate(resolve)), "drain");

    assert.deepEqual(await within(op.seal(), "seal"), { outcome: "capture-failed", failure: "artifact-runtime-invalidated" });
    assert.throws(
      () => r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: id }),
      (e) => e.code === "artifact-cleanup-failed",
      "unconfirmed disposal released an unsafe identity",
    );
    await r.close();
  });
}

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

/**
 * Assert the whole closed contract for a download that fights back during disposal.
 *
 * `budgetElapses` distinguishes the two ways a disposal fails: one that ANSWERS badly (a throw, a
 * rejection, an unreadable property) is unconfirmed the moment it answers, while one that never
 * answers at all is decided by the claim-anchored confirmation budget — so that budget is advanced
 * before the closed contract is asserted, and only for those cases.
 */
async function assertHostileDisposal(label, build, expectedCalls, { budgetElapses = false } = {}) {
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
  if (budgetElapses) {
    // Still merely OUTSTANDING until the budget it was claimed under expires.
    assert.doesNotThrow(
      () => r.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: "J".repeat(22) }),
      `${label}: an outstanding disposal poisoned the runtime before its budget expired`,
    );
    await scheduler.advanceBy(C);
  }

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
    // `then` is read EXACTLY ONCE, inside the try that owns the whole classification, and the exact
    // callable that read produced is the one adopted. A getter that throws on that read is a failed
    // call and must not escape as a synchronous throw out of invalidate(). A getter arming its trap
    // for a SECOND read never gets one — the adoption no longer hands the value back to
    // `Promise.resolve()` — and the callable it did hand over confirms nothing, so this fails closed
    // on the claim-anchored budget instead of on a read that now never happens.
    const reads = [];
    const hostile = (calls, sentinel, name) => {
      let seen = 0;
      return {
        get then() {
          seen += 1;
          reads.push(`${name}:${seen}`);
          if (shape === "always" || seen >= 2) { calls.push(`${name}-then-throw`); throw new Error(sentinel); }
          // Callable on the FIRST read, so the value really is classified as a thenable and adopted.
          // It settles NOTHING: a disposal that never answers, rather than one that answered badly.
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
      shape === "always" ? ["cancel", "cancel-then-throw", "delete", "delete-then-throw"] : ["cancel", "delete"],
      { budgetElapses: shape === "second-access" },
    );
    assert.deepEqual(reads, ["cancel:1", "delete:1"], `${shape}: a disposal return value's \`then\` was read more than once`);
  });
}

// ---------------------------------------------------------------------------------------------
// PR #139 adversarial-security correction — the public runtime boundary.
//
//  1. The operation returned the store's OWN mutable record, and the store authorized from it: a
//     caller could rewrite `result.artifact.consumerId` and then acquire as that consumer.
//  2. `runtime.store` exposed a store whose every field was a writable, enumerable own property —
//     root, data path, records, descriptors, callbacks, reservations and timers, all serializable.
//  3. `new ArtifactRuntime(undefined | null | proxy)` escaped as a raw Node exception, and the
//     untrusted option object was spread and re-read rather than snapshotted once.
//  4. `noteMainResponseContentType()` read an unvalidated object, so a null threw immediately and a
//     hostile `contentType` threw a raw, secret-bearing exception later, inside `seal()`.
// ---------------------------------------------------------------------------------------------

const CONFIG_SENTINEL = "/private/statements/2026-08/CONFIG_GETTER_SENTINEL";
const configBoom = () => { throw new Error(CONFIG_SENTINEL); };
const serializeSafely = (value) => { try { return JSON.stringify(value); } catch { return "<serialization threw>"; } };

test("a mutated sealed artifact record cannot re-authorize a different consumer", async () => {
  // The reported reproduction, exactly.
  const root = join(temp(), "a"), source = pdf(temp());
  const r = new ArtifactRuntime({ enabled: true, root });
  const op = r.createOperation({ owner: ownerOf("rightful"), sourceHost: "example.com", artifactId: "K".repeat(22) });
  op.registerDownload({ path: () => source });
  const result = await op.seal();
  assert.equal(result.outcome, "available");
  try { result.artifact.consumerId = "attacker"; } catch {}
  try { Object.defineProperty(result.artifact, "consumerId", { value: "attacker" }); } catch {}
  assert.equal(result.artifact.consumerId, "rightful", "the caller's mutation reached the published record");
  assert.equal(await observedStore().acquire(result.artifact.id, "attacker"), null, "a mutated record authorized the wrong consumer");
  const lease = await observedStore().acquire(result.artifact.id, "rightful");
  assert.ok(lease, "the rightful consumer lost access to its own artifact");
  lease.complete();
  await r.close();
});

test("the sealed artifact and its lease record are distinct frozen snapshots", async () => {
  const root = join(temp(), "a"), source = pdf(temp());
  const r = new ArtifactRuntime({ enabled: true, root });
  const op = r.createOperation({ owner: ownerOf("rightful"), sourceHost: "example.com", artifactId: "L".repeat(22) });
  op.registerDownload({ path: () => source });
  const result = await op.seal();
  assert.equal(result.outcome, "available");
  assert.equal(Object.isFrozen(result.artifact), true, "the published record crossed the seam mutable");
  const original = { ...result.artifact };
  for (const [field, value] of [["consumerId", "attacker"], ["status", "consuming"], ["bytes", 1], ["sha256", "0".repeat(64)], ["expiresAt", 0], ["id", "M".repeat(22)]]) {
    try { result.artifact[field] = value; } catch {}
    try { Object.defineProperty(result.artifact, field, { value, writable: true, configurable: true }); } catch {}
  }
  assert.deepEqual({ ...result.artifact }, original, "a caller's mutation reached the published record");
  // Sealing again returns the SAME committed result, still frozen and still describing the artifact.
  assert.deepEqual(await op.seal(), result);
  const lease = await observedStore().acquire(original.id, "rightful");
  assert.ok(lease, "integrity or expiry followed the caller's mutation");
  assert.equal(Object.isFrozen(lease.record), true, "the lease record crossed the seam mutable");
  assert.notEqual(lease.record, result.artifact, "the lease handed back the very object the seal returned");
  assert.equal(lease.record.consumerId, "rightful");
  assert.equal(lease.record.status, "consuming");
  assert.equal(lease.record.sha256, original.sha256);
  lease.complete();
  await r.close();
});

test("runtime exposes no concrete store authority", async () => {
  const root = join(temp(), "a"), source = pdf(temp()), id = "N".repeat(22);
  const r = new ArtifactRuntime({ enabled: true, root });

  assert.equal("store" in r, false, "the concrete store is reachable from the authoritative runtime");
  assert.equal(r.store, undefined, "runtime.store exposes filesystem and authorization authority");
  assert.equal(
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(r), "store"),
    undefined,
    "the runtime prototype exposes a store authority accessor",
  );
  assert.deepEqual(Object.keys(r), [], "the runtime exposes enumerable authority");
  assert.deepEqual(Object.getOwnPropertyNames(r), [], "the runtime exposes own authority properties");
  assert.equal(serializeSafely(r), "{}", "serializing the runtime disclosed private authority");
  assert.equal(serializeSafely(r).includes(root), false, "the runtime serialized its configured root");

  const op = r.createOperation({ owner: ownerOf("owner"), sourceHost: "example.com", artifactId: id });
  op.registerDownload({ path: () => source });
  const result = await op.seal();
  assert.equal(result.outcome, "available", "removing the store surface broke authoritative capture");
  assert.deepEqual(readdirSync(join(root, "data")), [`${id}.pdf`]);
  assert.equal(await r.close(), undefined);
});

test("the built public artifact entrypoint exposes no concrete store constructor", () => {
  // Amendment 3 §1: `ArtifactRuntime` is the SOLE cross-module runtime API, and the concrete store —
  // which owns the filesystem, the byte/count accounting and consumer authorization — stays private
  // to `src/artifacts/`. A barrel re-export handed every importer of the public entrypoint a
  // constructor for that authority with no runtime, no operation ownership and no owner attribution
  // in front of it. The closed ERROR vocabulary stays public: it carries no filesystem authority.
  assert.equal(
    Object.getOwnPropertyNames(artifactIndex).includes("ArtifactStore"),
    false,
    "the public artifact entrypoint re-exports the concrete store",
  );
  assert.equal(artifactIndex.ArtifactStore, undefined, "the public artifact entrypoint resolves a concrete store binding");
  assert.throws(
    () => new artifactIndex.ArtifactStore({ enabled: false, root: join(temp(), "public-barrel-store") }),
    TypeError,
    "a concrete store was constructible straight from the public artifact entrypoint",
  );
  assert.equal(typeof artifactIndex.ArtifactRuntime, "function", "the sole cross-module runtime API left the public entrypoint");
  assert.equal(typeof artifactIndex.ArtifactStoreError, "function", "the closed error vocabulary left the public entrypoint");
});

test("malformed runtime configuration is refused with a closed code and leaks nothing", () => {
  const abs = join(temp(), "a");
  const cases = [
    ["undefined", undefined],
    ["null", null],
    ["a number", 7],
    ["a string", CONFIG_SENTINEL],
    ["an array", [CONFIG_SENTINEL]],
    ["a throwing proxy", new Proxy({}, { get: configBoom, has: configBoom, ownKeys: configBoom })],
    ["a throwing root getter", { get root() { return configBoom(); } }],
    ["a coercible root object", { root: { toString: () => CONFIG_SENTINEL } }],
    ["a symbol root", { root: Symbol(CONFIG_SENTINEL) }],
    ["a relative root", { root: "relative/artifacts" }],
    ["an empty root", { root: "" }],
    ["a throwing scheduler getter", { root: abs, get scheduler() { return configBoom(); } }],
    ["a non-object scheduler", { root: abs, scheduler: CONFIG_SENTINEL }],
    ["a non-function scheduler member", { root: abs, scheduler: { ...fakeScheduler(), clearTimeout: CONFIG_SENTINEL } }],
    ["a non-object fsOps", { root: abs, fsOps: CONFIG_SENTINEL }],
    ["a non-function fsOps member", { root: abs, fsOps: { linkSync, unlinkSync, fsyncSync: CONFIG_SENTINEL } }],
    ["a throwing fsOps member getter", { root: abs, fsOps: { linkSync, unlinkSync, get fsyncSync() { return configBoom(); } } }],
    ["a non-function id generator", { root: abs, idGenerator: CONFIG_SENTINEL }],
    ["a non-function discard callback", { root: abs, onDiscard: CONFIG_SENTINEL }],
    ["a non-function terminal callback", { root: abs, onOperationTerminal: CONFIG_SENTINEL }],
    ["a non-function commit seam", { root: abs, beforeCommit: CONFIG_SENTINEL }],
    ["a non-number ttl", { root: abs, ttlMs: CONFIG_SENTINEL }],
    ["a non-boolean enabled", { root: abs, enabled: CONFIG_SENTINEL }],
  ];
  for (const [label, options] of cases) {
    assert.throws(() => new ArtifactRuntime(options), (e) => {
      assert.equal(e?.code, "artifact-config-invalid", `${label} was not refused with the closed configuration code`);
      assert.equal(String(e?.message ?? "").includes("SENTINEL"), false, `${label} leaked raw exception text`);
      assert.equal(String(e?.stack ?? "").includes("SENTINEL"), false, `${label} leaked a sentinel through a stack`);
      return true;
    }, label);
  }
  assert.equal(existsSync(abs), false, "a refused configuration reached the filesystem");
});

// Amendment 2 §7, the runtime half of the same defect: `ArtifactRuntime` shares the store's ONE
// canonicalization, so `new ArtifactRuntime({ enabled: false })` was refused with
// `artifact-config-invalid` for want of a root the disabled configuration never meant to name.
test("a disabled runtime is constructible with no root at all and stays inert", async () => {
  const runtime = new ArtifactRuntime({ enabled: false });
  // A capture that observed nothing still reports nothing.
  assert.deepEqual(await runtime.createOperation({ owner: OWNER, sourceHost: "example.com" }).seal(), { outcome: "none" });
  // And one that observed a download fails CLOSED, disposing of the driver's copy exactly as an
  // enabled-but-closed store does — the disabled store owns no bytes, so nobody else can.
  const disposed = [];
  const operation = runtime.createOperation({ owner: OWNER, sourceHost: "example.com", artifactId: "Z".repeat(22) });
  const source = pdf(temp());
  assert.equal(operation.registerDownload({
    path: () => source,
    cancel: async () => { disposed.push("cancel"); },
    delete: async () => { disposed.push("delete"); },
  }), true);
  assert.deepEqual(await operation.seal(), { outcome: "capture-failed", failure: "artifact-runtime-invalidated" });
  assert.deepEqual(disposed.sort(), ["cancel", "delete"], "the refused capture did not dispose of the driver's copy");
  assert.equal(readFileSync(source).toString(), "%PDF-1.7\nhello", "a disabled runtime mutated the source it refused");
  assert.equal(await runtime.close(), undefined);
});

// The whole option surface, spelled here so a new member added to `ArtifactStoreOptions` without a
// disabled-path decision shows up as an untouched-option regression rather than silently.
const RUNTIME_OPTION_KEYS = [
  "root", "ttlMs", "cleanupIntervalMs", "maxBytes", "maxCount", "perConsumerBytes", "perConsumerCount",
  "idGenerator", "fsOps", "scheduler", "onDiscard", "onCleanupPass", "afterPartFsync", "afterLinkBeforeCommit",
  "beforeCommit", "onOperationTerminal", "onOperationReleased", "onOperationCommitted", "identityOverride",
  "onCloseStep", "closeStepFails", "afterRootDescriptor", "onDataPathOpen", "onDescriptorClose",
];

test("a disabled runtime configuration reads `enabled` exactly once and touches no other option", () => {
  const reads = new Map();
  const count = (key) => reads.set(key, (reads.get(key) ?? 0) + 1);
  const options = {};
  Object.defineProperty(options, "enabled", { enumerable: true, configurable: true, get() { count("enabled"); return false; } });
  // Every other member both COUNTS its read and throws, so an untouched option is proved twice over:
  // by an empty read log, and by a construction that never saw the exception a touched one raises.
  for (const key of RUNTIME_OPTION_KEYS) {
    Object.defineProperty(options, key, { enumerable: true, configurable: true, get() { count(key); return configBoom(); } });
  }
  const runtime = new ArtifactRuntime(options);
  assert.equal(reads.get("enabled"), 1, `enabled was read ${reads.get("enabled") ?? 0} times, not once`);
  assert.deepEqual([...reads.keys()], ["enabled"], "a disabled configuration read an option other than `enabled`");
  return runtime.close();
});

// Requirement: the disabled short-circuit is reached only by an EXACT `false`, and a malformed or
// throwing `enabled` is still refused with the closed code — with no root supplied, so the refusal
// cannot be coming from root validation.
test("a malformed or throwing runtime `enabled` is refused with the closed code even with no root", () => {
  const cases = [
    ["a throwing enabled getter", { get enabled() { return configBoom(); } }],
    ["a string enabled", { enabled: "false" }],
    ["a zero enabled", { enabled: 0 }],
    ["a null enabled", { enabled: null }],
    ["a boxed enabled", { enabled: new Boolean(false) }],
    ["an object enabled", { enabled: { valueOf: () => false } }],
  ];
  for (const [label, options] of cases) {
    assert.throws(() => new ArtifactRuntime(options), (e) => {
      assert.equal(e?.code, "artifact-config-invalid", `${label} was not refused with the closed configuration code`);
      assert.equal(String(e?.message ?? "").includes("SENTINEL"), false, `${label} leaked raw exception text`);
      assert.equal(String(e?.stack ?? "").includes("SENTINEL"), false, `${label} leaked a sentinel through a stack`);
      return true;
    }, label);
  }
});

test("each runtime option is read exactly once, including the discard callback", async () => {
  const root = join(temp(), "a"), source = pdf(temp()), id = "O".repeat(22);
  const reads = new Map();
  const discards = [];
  const stated = {
    enabled: true, root, ttlMs: 600_000, cleanupIntervalMs: 60_000, maxBytes: 64 * 1024 * 1024, maxCount: 16,
    perConsumerBytes: 16 * 1024 * 1024, perConsumerCount: 4,
    fsOps: { linkSync, unlinkSync, fsyncSync }, scheduler: fakeScheduler(),
    idGenerator: () => "P".repeat(22),
    onDiscard: (discardedId) => discards.push(discardedId),
    onCleanupPass: () => {}, afterPartFsync: () => {}, afterLinkBeforeCommit: () => {},
    beforeCommit: () => {}, onOperationTerminal: () => {}, onOperationReleased: () => {}, onOperationCommitted: () => {},
    identityOverride: () => undefined, onCloseStep: () => {}, closeStepFails: () => false,
    afterRootDescriptor: () => {}, onDataPathOpen: () => {}, onDescriptorClose: () => {},
  };
  const options = {};
  for (const [key, value] of Object.entries(stated)) {
    Object.defineProperty(options, key, { enumerable: true, configurable: true, get() { reads.set(key, (reads.get(key) ?? 0) + 1); return value; } });
  }
  const r = new ArtifactRuntime(options);
  for (const key of Object.keys(stated)) assert.equal(reads.get(key), 1, `${key} was read ${reads.get(key) ?? 0} times at construction, not once`);

  // A callback is authority too: re-reading it at call time lets a stateful getter swap which
  // function the runtime hands its discard notifications to, long after construction.
  const op = r.createOperation({ owner: ownerOf("owner"), sourceHost: "example.com", artifactId: id });
  op.registerDownload({ path: () => source });
  assert.equal((await op.seal()).outcome, "available");
  assert.equal(observedStore().discardArtifact(id), true);
  assert.deepEqual(discards, [id], "the configured discard callback did not receive the discard");
  for (const key of Object.keys(stated)) assert.equal(reads.get(key), 1, `${key} was re-read after construction`);
  await r.close();
  for (const key of Object.keys(stated)) assert.equal(reads.get(key), 1, `${key} was re-read during close`);
});

test("a malformed main-response observation terminalizes with a closed code and never throws raw", async () => {
  const hostile = [
    ["null", null],
    ["undefined", undefined],
    ["a number", 200],
    ["a string", CONFIG_SENTINEL],
    ["a throwing proxy", new Proxy({}, { get: configBoom })],
    ["a throwing status getter", { get status() { return configBoom(); }, contentType: "application/pdf" }],
    ["a throwing contentType getter", { status: 200, get contentType() { return configBoom(); } }],
    ["a contentType object with a throwing trim", { status: 200, contentType: { trim: configBoom, toLowerCase: configBoom, toString: configBoom } }],
    ["a symbol contentType", { status: 200, contentType: Symbol(CONFIG_SENTINEL) }],
    ["a numeric contentType", { status: 200, contentType: 42 }],
    ["a NaN status", { status: NaN, contentType: "application/pdf" }],
    ["an infinite status", { status: Number.POSITIVE_INFINITY, contentType: "application/pdf" }],
    ["a fractional status", { status: 200.5, contentType: "application/pdf" }],
    ["an out-of-range status", { status: 9000, contentType: "application/pdf" }],
    ["a numeric-string status", { status: "200", contentType: "application/pdf" }],
    ["a coercible status object", { status: { valueOf: configBoom }, contentType: "application/pdf" }],
    ["an omitted status", { contentType: "application/pdf" }],
    ["an omitted contentType", { status: 200 }],
  ];
  for (const [label, observation] of hostile) {
    const r = new ArtifactRuntime({ enabled: true, root: join(temp(), "a") });
    const op = r.createOperation({ owner: OWNER, sourceHost: "example.com" });
    assert.equal(op.noteMainResponseContentType(observation), undefined, `${label} threw or returned a value`);
    const result = await op.seal();
    assert.deepEqual(result, { outcome: "capture-failed", failure: "artifact-config-invalid" }, `${label} was not terminalized with the closed code`);
    assert.equal(serializeSafely(result).includes("SENTINEL"), false, `${label} leaked raw text through the result`);
    await r.close();
  }
});

test("a hostile observation accessor is read once, cannot throw out, and never rewrites the first reason", async () => {
  // Stateful: a second read would see a hostile value the first read did not offer.
  const accepted = new ArtifactRuntime({ enabled: true, root: join(temp(), "a") });
  const op = accepted.createOperation({ owner: OWNER, sourceHost: "example.com" });
  let statusReads = 0, typeReads = 0;
  op.noteMainResponseContentType({
    get status() { statusReads += 1; return statusReads === 1 ? 200 : Symbol(CONFIG_SENTINEL); },
    get contentType() { typeReads += 1; return typeReads === 1 ? "application/pdf" : { trim: configBoom }; },
  });
  assert.equal(statusReads, 1, "the status was read more than once");
  assert.equal(typeReads, 1, "the content type was read more than once");
  assert.deepEqual(await op.seal(), { outcome: "inline-pdf-unsupported", failure: "inline-pdf-unsupported" }, "the first, valid observation was lost");
  await accepted.close();

  // Re-entrant: the getter terminalizes the operation and THEN throws. The throw must not escape,
  // and the reason the re-entrant call established must stand.
  const reentrant = new ArtifactRuntime({ enabled: true, root: join(temp(), "a") });
  const victim = reentrant.createOperation({ owner: OWNER, sourceHost: "example.com" });
  assert.equal(victim.noteMainResponseContentType({
    status: 200,
    get contentType() { victim.invalidate("download-lifecycle-race"); return configBoom(); },
  }), undefined, "a re-entrant hostile getter threw out of the observation");
  const result = await victim.seal();
  assert.deepEqual(result, { outcome: "capture-failed", failure: "download-lifecycle-race" }, "the first terminal reason was rewritten");
  assert.equal(serializeSafely(result).includes("SENTINEL"), false, "raw text crossed the result seam");
  await reentrant.close();
});
