import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactRuntime, ArtifactStore } from "../dist/artifacts/index.js";
const dirs=[]; const temp=()=>{const d=mkdtempSync(join(tmpdir(),"bgw-artifact-"));dirs.push(d);return d};
afterEach(()=>{while(dirs.length)rmSync(dirs.pop(),{recursive:true,force:true})});
function pdf(dir){const p=join(dir,"x.pdf");writeFileSync(p,Buffer.from("%PDF-1.7\nhello"));return p}

test("lease is one-time and complete deletes the artifact", async()=>{const root=join(temp(),"a"), source=pdf(temp()), s=new ArtifactStore({enabled:true,root}); const id="B".repeat(22); await s.capture(source,{id,consumerId:"c"}); const l=s.acquire(id,"c"); assert.ok(l); assert.equal(s.acquire(id,"c"),null); assert.equal(l.base64,Buffer.from("%PDF-1.7\nhello").toString("base64")); l.complete(); l.complete(); assert.equal(s.acquire(id,"c"),null); s.close()});

test("operation seals inline PDF as unsupported and records one valid download", async()=>{const root=join(temp(),"a"), source=pdf(temp()), r=new ArtifactRuntime({enabled:true,root}); const op=r.createOperation("owner","example.com","C".repeat(22)); op.noteMainResponseContentType(" application/pdf "); assert.deepEqual(op.seal(),{status:"unsupported-inline"}); const op2=r.createOperation("owner","example.com","D".repeat(22)); await op2.registerDownload({path:()=>source}); assert.equal(op2.seal().status,"available"); r.close()});

test("operation rejects multiple downloads", async()=>{const root=join(temp(),"a"), source=pdf(temp()), r=new ArtifactRuntime({enabled:true,root}); const op=r.createOperation("owner","example.com","E".repeat(22)); await op.registerDownload({path:()=>source}); await op.registerDownload({path:()=>source}); assert.equal(op.seal().status,"multiple-artifacts"); r.close()});
