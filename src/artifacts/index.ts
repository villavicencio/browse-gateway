import { randomBytes } from "node:crypto";
import { ArtifactStore } from "./store.js";
import { ARTIFACT_ID, ArtifactStoreError, type ArtifactFailureCode, type ArtifactStoreOptions, type DownloadLike, type OperationResult } from "./types.js";
import { canonicalizeHost, canonicalizeHostForIp } from "../security/url.js";
import { isIP } from "node:net";

const HOST = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const MAX_ID_ATTEMPTS = 8;
const runtimeDisposers = new WeakMap<ArtifactOperation, () => OperationResult>();
const disposeForRuntime = (operation: ArtifactOperation) => runtimeDisposers.get(operation)?.();

export class ArtifactOperation {
  private events = 0; private sealed = false; private generation = 0; private result?: OperationResult; private status: number | null = null; private contentType: string | null = null;
  private active = 0; private cleanupConfirmed = true; private released = false; private waitingForArtifact = false;
  private disposed = false;
  constructor(private readonly store: ArtifactStore, private readonly consumerId: string, readonly sourceHost: string, readonly artifactId: string, private readonly release: () => void) {
    runtimeDisposers.set(this, () => this.#disposeForRuntime());
  }
  noteMainResponse(status: number | null, contentType: string | null) { if (!this.sealed) { this.status = status; this.contentType = contentType; } }
  private tryRelease() { if (this.sealed && this.active === 0 && this.cleanupConfirmed && !this.waitingForArtifact && !this.released) { this.released = true; this.release(); } }
  private discard() { const clean = this.store.discardArtifact(this.artifactId); this.cleanupConfirmed = clean; this.waitingForArtifact = false; if (!clean) this.result = { outcome: "capture-failed", failure: "artifact-cleanup-failed" }; return clean; }
  #disposeForRuntime() {
    if (this.disposed) return this.result ?? { outcome: "capture-failed", failure: "artifact-runtime-invalidated" };
    this.disposed = true;
    if (this.result?.outcome === "available") {
      this.sealed = true;
      this.generation++;
      const clean = this.discard();
      this.result = { outcome: "capture-failed", failure: clean ? "artifact-runtime-invalidated" : "artifact-cleanup-failed" };
      this.tryRelease();
      return this.result;
    }
    if (!this.sealed) { this.sealed = true; this.generation++; this.result = { outcome: "capture-failed", failure: "artifact-runtime-invalidated" }; }
    const clean = this.discard();
    if (!clean) this.result = { outcome: "capture-failed", failure: "artifact-cleanup-failed" };
    this.tryRelease();
    return this.result!;
  }
  private terminal(result: OperationResult, cleanup = false) {
    this.sealed = true;
    this.generation++;
    this.result = result;
    this.cleanupConfirmed = !cleanup && !(result.outcome === "capture-failed" && result.failure === "artifact-cleanup-failed");
    // An available artifact remains reserved until the store's synchronous onDiscard callback.
    if (result.outcome !== "available") this.waitingForArtifact = false;
    this.tryRelease();
    return this.result;
  }
  async registerDownload(download: DownloadLike) {
    if (this.disposed) return this.result ?? { outcome: "capture-failed", failure: "artifact-runtime-invalidated" };
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
      else if ("failure" in captured) this.terminal({ outcome: "capture-failed", failure: captured.failure }, captured.failure === "artifact-cleanup-failed");
      return this.result;
    } finally { this.active--; this.tryRelease(); }
  }
  seal(): OperationResult {
    if (this.disposed) return this.result ?? { outcome: "capture-failed", failure: "artifact-runtime-invalidated" };
    if (this.sealed) return this.result ?? { outcome: "capture-failed", failure: "artifact-runtime-invalidated" };
    const essence = ((this.contentType ?? "").trim().toLowerCase().split(";", 1)[0] ?? "").trim();
    if (this.events === 0 && this.status === 200 && essence === "application/pdf") return this.terminal({ outcome: "inline-pdf-unsupported", failure: "inline-pdf-unsupported" });
    return this.terminal(this.result ?? { outcome: "none" });
  }
  invalidate() {
    if (this.result?.outcome === "available") { this.sealed = true; return this.result; }
    if (!this.sealed) { this.sealed = true; this.generation++; this.result = { outcome: "capture-failed", failure: "artifact-runtime-invalidated" }; }
    this.cleanupConfirmed = this.discard(); this.tryRelease(); return this.result!;
  }
}

export class ArtifactRuntime {
  readonly store: ArtifactStore; private readonly idGenerator: () => string; private readonly reserved = new Map<string, symbol>(); private readonly operations = new Map<symbol, ArtifactOperation>(); private closed = false; private closePromise?: Promise<ArtifactFailureCode | undefined>;
  constructor(options: ArtifactStoreOptions) {
    this.store = new ArtifactStore({ ...options, onDiscard: (id) => {
      // ArtifactStore invokes onDiscard synchronously after durable deletion, before a replacement can be created.
      const token = this.reserved.get(id);
      if (token !== undefined) {
        this.reserved.delete(id);
        this.operations.delete(token);
      }
      try { options.onDiscard?.(id); } catch {}
    } });
    this.idGenerator = options.idGenerator ?? (() => randomBytes(16).toString("base64url"));
  }
  createOperation(consumerId: string, sourceHost: string, explicitId?: string) {
    if (this.closed) throw new ArtifactStoreError("artifact-runtime-invalidated");
    let host: string;
    try { host = canonicalizeHost(sourceHost); } catch { throw new ArtifactStoreError("artifact-config-invalid"); }
    if (!HOST.test(host) || isIP(canonicalizeHostForIp(host)) !== 0 || /[\u0000-\u001f\u007f]/.test(sourceHost)) throw new ArtifactStoreError("artifact-config-invalid");
    let id = explicitId;
    if (id !== undefined && typeof id !== "string") throw new ArtifactStoreError("invalid-artifact-id");
    if (id !== undefined) { if (!ARTIFACT_ID.test(id)) throw new ArtifactStoreError("invalid-artifact-id"); if (this.reserved.has(id)) throw new ArtifactStoreError("artifact-capacity"); }
    else for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
      let candidate: unknown;
      try { candidate = this.idGenerator(); } catch { throw new ArtifactStoreError("artifact-config-invalid"); }
      if (typeof candidate !== "string") throw new ArtifactStoreError("artifact-config-invalid");
      if (ARTIFACT_ID.test(candidate) && !this.reserved.has(candidate)) { id = candidate; break; }
    }
    if (!id) throw new ArtifactStoreError("artifact-capacity");
    const token = Symbol(id);
    this.reserved.set(id, token);
    const operation = new ArtifactOperation(this.store, consumerId, host, id, () => { if (this.reserved.get(id) === token) this.reserved.delete(id); this.operations.delete(token); });
    this.operations.set(token, operation);
    return operation;
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    for (const operation of Array.from(this.operations.values())) disposeForRuntime(operation);
    this.closePromise = this.store.close();
    return this.closePromise;
  }
}
export * from "./types.js";
export { ArtifactStore } from "./store.js";
