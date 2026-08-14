import { randomBytes } from "node:crypto";
import { ArtifactStore } from "./store.js";
import { ARTIFACT_ID, ArtifactStoreError, type ArtifactStoreOptions, type DownloadLike, type OperationResult } from "./types.js";
import { canonicalizeHost, canonicalizeHostForIp } from "../security/url.js";
import { isIP } from "node:net";

const HOST = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const MAX_ID_ATTEMPTS = 8;

export class ArtifactOperation {
  private events = 0; private sealed = false; private generation = 0; private result?: OperationResult; private status: number | null = null; private contentType: string | null = null;
  constructor(private readonly store: ArtifactStore, private readonly consumerId: string, readonly sourceHost: string, readonly artifactId: string) {}
  noteMainResponse(status: number | null, contentType: string | null) { if (!this.sealed) { this.status = status; this.contentType = contentType; } }
  async registerDownload(download: DownloadLike) {
    if (this.sealed) return this.result; this.events++; if (this.events > 1) { this.generation++; this.sealed = true; this.store.discardArtifact(this.artifactId); this.result = { outcome: "capture-failed", failure: "multiple-artifacts" }; return this.result; }
    const generation = this.generation;
    let failure: unknown;
    try { failure = download.failure ? await download.failure() : undefined; } catch { failure = true; }
    if (this.sealed || generation !== this.generation) return this.result;
    if (failure) { this.result = { outcome: "capture-failed", failure: "download-capture-failed" }; return this.result; }
    let path: string | null;
    try { path = await download.path(); } catch { path = null; }
    if (this.sealed || generation !== this.generation) return this.result;
    if (!path) { this.result = { outcome: "capture-failed", failure: "download-capture-failed" }; return this.result; }
    const captured = await this.store.capture(path, { id: this.artifactId, consumerId: this.consumerId });
    if (this.sealed || generation !== this.generation) { this.store.discardArtifact(this.artifactId); return this.result; }
    if (captured.status === "available") this.result = { outcome: "available", artifact: captured }; else this.result = { outcome: "capture-failed", failure: "artifact-write-failed" };
    return this.result;
  }
  seal(): OperationResult { if (this.sealed) return this.result ?? { outcome: "capture-failed", failure: "artifact-runtime-invalidated" }; this.sealed = true; this.generation++; const essence = ((this.contentType ?? "").trim().toLowerCase().split(";", 1)[0] ?? "").trim(); if (this.events === 0 && this.status === 200 && essence === "application/pdf") this.result = { outcome: "inline-pdf-unsupported", failure: "inline-pdf-unsupported" }; return this.result ?? { outcome: "none" }; }
  invalidate() { this.sealed = true; this.generation++; this.store.discardArtifact(this.artifactId); this.result = { outcome: "capture-failed", failure: "artifact-runtime-invalidated" }; return this.result; }
}

export class ArtifactRuntime {
  readonly store: ArtifactStore; private readonly idGenerator: () => string; private readonly reserved = new Set<string>();
  constructor(options: ArtifactStoreOptions) { this.store = new ArtifactStore(options); this.idGenerator = options.idGenerator ?? (() => randomBytes(16).toString("base64url")); }
  createOperation(consumerId: string, sourceHost: string, explicitId?: string) {
    const host = canonicalizeHost(sourceHost);
    if (!HOST.test(host) || isIP(canonicalizeHostForIp(host)) !== 0 || /[\u0000-\u001f\u007f]/.test(sourceHost)) throw new Error("invalid source host");
    let id = explicitId;
    if (id !== undefined) { if (!ARTIFACT_ID.test(id)) throw new ArtifactStoreError("invalid-artifact-id"); if (this.reserved.has(id)) throw new ArtifactStoreError("artifact-capacity"); }
    else for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) { const candidate = this.idGenerator(); if (ARTIFACT_ID.test(candidate) && !this.reserved.has(candidate)) { id = candidate; break; } }
    if (!id) throw new ArtifactStoreError("artifact-capacity"); this.reserved.add(id); return new ArtifactOperation(this.store, consumerId, host, id);
  }
  close() { this.store.close(); }
}
export * from "./types.js";
export { ArtifactStore } from "./store.js";
