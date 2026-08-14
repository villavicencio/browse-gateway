import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from "node:fs";
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

test("download accessor exceptions become private capture failures", async()=>{
  const r = new ArtifactRuntime({ enabled: true, root: join(temp(), "a") });
  const op = r.createOperation("owner", "example.com", "X".repeat(22));
  const secret = "/private/secret-path sentinel";
  const result = await op.registerDownload({ failure: () => Promise.reject(new Error(secret)), path: () => { throw new Error(secret); } });
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

test("runtime default operation ids are unique",()=>{const r=new ArtifactRuntime({enabled:true,root:join(temp(),"a")}); const a=r.createOperation("c","example.com"), b=r.createOperation("c","example.com"); assert.notEqual(a,b); r.close()});
