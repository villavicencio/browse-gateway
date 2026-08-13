import { ArtifactStore } from "./store.js";
import type { ArtifactStoreOptions, DownloadLike, OperationResult } from "./types.js";

export class ArtifactOperation {
  private events = 0;
  private sealed = false;
  private result?: OperationResult;
  constructor(private readonly store: ArtifactStore, private readonly consumerId: string, private readonly id: string) {}
  noteMainResponseContentType(contentType: string) { if (!this.sealed) this.contentType = contentType; }
  private contentType = "";
  async registerDownload(download: DownloadLike) { if (this.sealed) return; this.events++; if (this.events > 1) return; const failure = download.failure ? await download.failure() : undefined; if (failure) { this.result = { status: "capture-failed" }; return; } const path = await download.path(); if (!path) { this.result = { status: "capture-failed" }; return; } const captured = await this.store.capture(path, { id: this.id, consumerId: this.consumerId }); if (captured.status === "available") this.result = { status: "available", artifact: captured }; else this.result = { status: "capture-failed" }; }
  seal(): OperationResult { if (this.sealed) return this.result ?? { status: "capture-failed" }; this.sealed = true; if (this.events === 0 && this.contentType.trim().toLowerCase() === "application/pdf") this.result = { status: "unsupported-inline" }; else if (this.events > 1) this.result = { status: "multiple-artifacts" }; return this.result ?? { status: "capture-failed" }; }
  invalidate() { this.sealed = true; this.result = { status: "capture-failed" }; return this.result; }
}

export class ArtifactRuntime {
  readonly store: ArtifactStore;
  constructor(options: ArtifactStoreOptions) { this.store = new ArtifactStore(options); }
  createOperation(consumerId: string, _sourceHost: string, id = "A".repeat(22)) { return new ArtifactOperation(this.store, consumerId, id); }
  close() { this.store.close(); }
}
export * from "./types.js";
export { ArtifactStore } from "./store.js";
