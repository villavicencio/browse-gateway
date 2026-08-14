import { randomBytes } from "node:crypto";
import { ArtifactStore } from "./store.js";
import { ARTIFACT_ID, ArtifactStoreError, type ArtifactStoreOptions, type DownloadLike, type OperationResult } from "./types.js";
import { canonicalizeHost, canonicalizeHostForIp } from "../security/url.js";
import { isIP } from "node:net";

const HOST = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const MAX_ID_ATTEMPTS = 8;

export class ArtifactOperation {
  private events = 0; private sealed = false; private generation = 0; private result?: OperationResult; private status: number | null = null; private contentType: string | null = null;
  private active = 0; private cleanupConfirmed = true; private released = false; private waitingForArtifact = false;
  constructor(private readonly store: ArtifactStore, private readonly consumerId: string, readonly sourceHost: string, readonly artifactId: string, private readonly release: () => void) {}
  noteMainResponse(status: number | null, contentType: string | null) { if (!this.sealed) { this.status = status; this.contentType = contentType; } }
  private tryRelease() { if (this.sealed && this.active === 0 && this.cleanupConfirmed && !this.waitingForArtifact && !this.released) { this.released = true; this.release(); } }
  private discard() { const clean = this.store.discardArtifact(this.artifactId); this.cleanupConfirmed = clean; this.waitingForArtifact = false; if (!clean) this.result = { outcome: "capture-failed", failure: "artifact-cleanup-failed" }; return clean; }
  private terminal(result: OperationResult, cleanup = false) { this.sealed = true; this.generation++; this.result = result; this.cleanupConfirmed = !cleanup; this.waitingForArtifact = false; this.tryRelease(); return this.result; }
  async registerDownload(download: DownloadLike) {
    if (this.sealed) return this.result;
    this.active++;
    this.events++;
    const generation = this.generation;
    try {
      if (this.events > 1) { this.sealed = true; this.generation++; this.result = { outcome: "capture-failed", failure: "multiple-artifacts" }; this.cleanupConfirmed = this.discard(); this.tryRelease(); return this.result; }
      let failure: unknown;
      try { failure = download.failure ? await download.failure() : undefined; } catch { failure = true; }
      if (this.sealed || generation !== this.generation) return this.result;
      if (failure) return this.terminal({ outcome: "capture-failed", failure: "download-capture-failed" });
      let path: string | null;
      try { path = await download.path(); } catch { path = null; }
      if (this.sealed || generation !== this.generation) return this.result;
      if (!path) return this.terminal({ outcome: "capture-failed", failure: "download-capture-failed" });
      const captured = await this.store.capture(path, { id: this.artifactId, consumerId: this.consumerId });
      if (this.sealed || generation !== this.generation) { this.discard(); this.tryRelease(); return this.result; }
      if (captured.status === "available") { this.result = { outcome: "available", artifact: captured }; this.waitingForArtifact = true; }
      else if ("failure" in captured) this.terminal({ outcome: "capture-failed", failure: captured.failure });
      return this.result;
    } finally { this.active--; this.tryRelease(); }
  }
  seal(): OperationResult {
    if (this.sealed) return this.result ?? { outcome: "capture-failed", failure: "artifact-runtime-invalidated" };
    const essence = ((this.contentType ?? "").trim().toLowerCase().split(";", 1)[0] ?? "").trim();
    if (this.events === 0 && this.status === 200 && essence === "application/pdf") return this.terminal({ outcome: "inline-pdf-unsupported", failure: "inline-pdf-unsupported" });
    return this.terminal(this.result ?? { outcome: "none" });
  }
  invalidate() {
    if (!this.sealed) { this.sealed = true; this.generation++; this.result = { outcome: "capture-failed", failure: "artifact-runtime-invalidated" }; }
    this.cleanupConfirmed = this.discard(); this.tryRelease(); return this.result!;
  }
}

export class ArtifactRuntime {
  readonly store: ArtifactStore; private readonly idGenerator: () => string; private readonly reserved = new Set<string>();
  constructor(options: ArtifactStoreOptions) { this.store = new ArtifactStore({ ...options, onDiscard: (id) => { this.reserved.delete(id); try { options.onDiscard?.(id); } catch {} } }); this.idGenerator = options.idGenerator ?? (() => randomBytes(16).toString("base64url")); }
  createOperation(consumerId: string, sourceHost: string, explicitId?: string) {
    let host: string;
    try { host = canonicalizeHost(sourceHost); } catch { throw new ArtifactStoreError("artifact-config-invalid"); }
    if (!HOST.test(host) || isIP(canonicalizeHostForIp(host)) !== 0 || /[\u0000-\u001f\u007f]/.test(sourceHost)) throw new ArtifactStoreError("artifact-config-invalid");
    let id = explicitId;
    if (id !== undefined) { if (!ARTIFACT_ID.test(id)) throw new ArtifactStoreError("invalid-artifact-id"); if (this.reserved.has(id)) throw new ArtifactStoreError("artifact-capacity"); }
    else for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) { const candidate = this.idGenerator(); if (ARTIFACT_ID.test(candidate) && !this.reserved.has(candidate)) { id = candidate; break; } }
    if (!id) throw new ArtifactStoreError("artifact-capacity"); this.reserved.add(id); return new ArtifactOperation(this.store, consumerId, host, id, () => this.reserved.delete(id));
  }
  close() { return this.store.close(); }
}
export * from "./types.js";
export { ArtifactStore } from "./store.js";
