export type ArtifactStatus = "available" | "capture-failed" | "expired" | "consuming";
export type ArtifactFailureCode = "artifact-transport-unsupported" | "capture-failed" | "multiple-artifacts" | "inline-pdf-unsupported" | "unavailable";
export type ArtifactFailure = ArtifactFailureCode;
export type ArtifactStoreErrorCode = "invalid-artifact-id" | "artifact-store-unavailable";
export class ArtifactStoreError extends Error {
  readonly code: ArtifactStoreErrorCode;
  constructor(code: ArtifactStoreErrorCode) { super(code); this.name = "ArtifactStoreError"; this.code = code; }
}
export interface ArtifactRecord { id: string; consumerId: string; bytes: number; sha256: string; createdAt: number; expiresAt: number; status: "available" | "consuming"; }
export interface ArtifactStoreOptions { enabled?: boolean; root: string; ttlMs?: number; maxBytes?: number; maxCount?: number; perConsumerBytes?: number; perConsumerCount?: number; now?: () => number; idGenerator?: () => string; fsOps?: FsOps; }
export interface FsOps { linkSync: typeof import("node:fs").linkSync; unlinkSync: typeof import("node:fs").unlinkSync; fsyncSync: typeof import("node:fs").fsyncSync; }
export interface CaptureOptions { id: string; consumerId: string; ttlMs?: number; }
export interface ResponseLease { record: ArtifactRecord; bytes: number; base64: string; deadline: number; complete(): void; }
export type ArtifactOutcome =
  | { outcome: "none" }
  | { outcome: "available"; artifact: ArtifactRecord }
  | { outcome: "inline-pdf-unsupported"; failure: "inline-pdf-unsupported" }
  | { outcome: "capture-failed"; failure: ArtifactFailureCode };
export type OperationResult = ArtifactOutcome;
export interface DownloadLike { path(): Promise<string | null> | string | null; failure?(): Promise<unknown> | unknown; }
export const ARTIFACT_ID = /^[A-Za-z0-9_-]{22,64}$/;
