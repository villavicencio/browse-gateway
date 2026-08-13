import { randomBytes } from "node:crypto";
import { ArtifactStore } from "./store.js";
import { ARTIFACT_ID, ArtifactStoreError, type ArtifactStoreOptions, type DownloadLike, type OperationResult } from "./types.js";

export class ArtifactOperation {
  private events = 0;
  private sealed = false;
  private generation = 0;
  private result?: OperationResult;
  private capturedId?: string;
  constructor(private readonly store: ArtifactStore, private readonly consumerId: string, private readonly id: string) {}
  noteMainResponseContentType(contentType: string) { if (!this.sealed) this.contentType = contentType; }
  private contentType = "";
  async registerDownload(download: DownloadLike) {
    if (this.sealed) return; this.events++; if (this.events > 1) { this.generation++; this.sealed = true; this.store.discardArtifact(this.id); this.result = { status: "multiple-artifacts" }; return; }
    const generation = this.generation; const failure = download.failure ? await download.failure() : undefined; if (this.sealed || generation !== this.generation) return;
    if (failure) { this.result = { status: "capture-failed" }; return; }
    const path = await download.path(); if (this.sealed || generation !== this.generation) return; if (!path) { this.result = { status: "capture-failed" }; return; }
    const captured = await this.store.capture(path, { id: this.id, consumerId: this.consumerId });
    if (this.sealed || generation !== this.generation) { this.store.discardArtifact(this.id); return; }
    if (captured.status === "available") { this.capturedId = captured.id; this.result = { status: "available", artifact: captured }; } else this.result = { status: "capture-failed" };
  }
  seal(): OperationResult { if (this.sealed) return this.result ?? { status: "capture-failed" }; this.sealed = true; this.generation++; const essence = this.contentType.trim().toLowerCase().split(";", 1)[0] ?? ""; if (this.events === 0 && essence.trim() === "application/pdf") this.result = { status: "unsupported-inline" }; else if (this.events > 1) { this.store.discardArtifact(this.id); this.result = { status: "multiple-artifacts" }; } return this.result ?? { status: "capture-failed" }; }
  invalidate() { this.sealed = true; this.generation++; this.store.discardArtifact(this.id); this.result = { status: "capture-failed" }; return this.result; }
}

export class ArtifactRuntime {
  readonly store: ArtifactStore;
  constructor(options: ArtifactStoreOptions) { this.store = new ArtifactStore(options); }
  createOperation(consumerId: string, sourceHost: string, id = randomBytes(16).toString("base64url")) { if (!/^(?=.{1,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(sourceHost)) throw new Error("invalid source host"); if (!ARTIFACT_ID.test(id)) throw new ArtifactStoreError("invalid-artifact-id"); return new ArtifactOperation(this.store, consumerId, id); }
  close() { this.store.close(); }
}
export * from "./types.js";
export { ArtifactStore } from "./store.js";
