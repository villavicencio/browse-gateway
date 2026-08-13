export type ArtifactStatus = "available" | "capture-failed" | "multiple-artifacts" | "expired" | "consuming";
export type ArtifactFailureCode = "artifact-transport-unsupported" | "capture-failed" | "multiple-artifacts" | "unavailable";
export type ArtifactFailure = ArtifactFailureCode;
export type ArtifactStoreErrorCode = "invalid-artifact-id" | "artifact-store-unavailable";
export class ArtifactStoreError extends Error {
  readonly code: ArtifactStoreErrorCode;
  constructor(code: ArtifactStoreErrorCode) { super(code); this.name = "ArtifactStoreError"; this.code = code; }
}
export interface ArtifactRecord { id: string; consumerId: string; bytes: number; sha256: string; createdAt: number; expiresAt: number; status: "available" | "consuming"; }
export interface ArtifactStoreOptions { enabled?: boolean; root: string; ttlMs?: number; maxBytes?: number; maxCount?: number; perConsumerBytes?: number; perConsumerCount?: number; now?: () => number; }
export interface CaptureOptions { id: string; consumerId: string; ttlMs?: number; }
export interface ResponseLease { record: ArtifactRecord; bytes: number; base64: string; deadline: number; complete(): void; }
export interface OperationResult { status: "unsupported-inline" | "available" | "capture-failed" | "multiple-artifacts"; artifact?: ArtifactRecord; }
export interface DownloadLike { path(): Promise<string | null> | string | null; failure?(): Promise<unknown> | unknown; }
export const ARTIFACT_ID = /^[A-Za-z0-9_-]{22,64}$/;
