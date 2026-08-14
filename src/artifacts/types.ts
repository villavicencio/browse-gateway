export type ArtifactStatus = "available" | "capture-failed" | "expired" | "consuming";
export type ArtifactFailureCode =
  | "download-capture-failed" | "download-settle-timeout" | "download-lifecycle-race" | "multiple-artifacts" | "inline-pdf-unsupported"
  | "artifact-size-limit" | "artifact-not-pdf" | "artifact-write-failed" | "artifact-integrity-failed" | "artifact-filesystem-unsupported" | "artifact-transport-unsupported"
  | "artifact-capacity" | "artifact-expired" | "artifact-not-found" | "artifact-owner-mismatch" | "artifact-rate-limited" | "artifact-response-timeout" | "artifact-cleanup-failed" | "artifact-runtime-invalidated"
  | "artifact-root-locked" | "artifact-root-invalid" | "artifact-config-invalid";
export type ArtifactFailure = ArtifactFailureCode;
export type ArtifactStoreErrorCode = "invalid-artifact-id" | "artifact-store-unavailable" | ArtifactFailureCode;
export class ArtifactStoreError extends Error { readonly code: ArtifactStoreErrorCode; constructor(code: ArtifactStoreErrorCode) { super(code); this.name = "ArtifactStoreError"; this.code = code; } }
export interface ArtifactRecord { id: string; consumerId: string; bytes: number; sha256: string; createdAt: number; expiresAt: number; status: "available" | "consuming"; }
/** @internal test seam: aggregate accounting only — never IDs, consumers, paths, names, hashes or content. */
export interface ArtifactAccounting { count: number; bytes: number; stagingBytes: number; stagePermits: number; stagePermitLimit: number; responsePermitHeld: boolean; responseWaiters: number; responseBytes: number; consumers: number; }
/** The single time domain for artifact expiry, leases and cleanup. Never mixed with ambient `Date.now`/`setTimeout`. */
export interface ArtifactScheduler { now(): number; /** Process start, in the same domain as `now`. Diagnostic only: never read to decide liveness. */ processStartedAt(): number; setTimeout(callback: () => void, delayMs: number): unknown; clearTimeout(handle: unknown): void; }
export interface ArtifactStoreOptions { enabled?: boolean; root: string; ttlMs?: number; cleanupIntervalMs?: number; maxBytes?: number; maxCount?: number; perConsumerBytes?: number; perConsumerCount?: number; idGenerator?: () => string; fsOps?: FsOps; /** @internal test seam */ scheduler?: ArtifactScheduler; /** @internal test seam */ onDiscard?: (id: string) => void; /** @internal test seam */ onCleanupPass?: () => void; /** @internal test seam */ afterPartFsync?: () => void | Promise<void>; /** @internal test seam */ afterLinkBeforeCommit?: () => void | Promise<void>;
  /** @internal test seam: a fault selector keyed only by which directory and which reading. It is
   * passed no path, descriptor, stat or observed identity, and returns only values its caller supplies. */
  identityOverride?: (target: "root" | "data", source: "descriptor" | "path") => { dev?: number; ino?: number; uid?: number; mode?: number; directory?: boolean } | "unreadable" | undefined;
  /** @internal test seam: one closed close-step label per completed step. It carries no path,
   * descriptor, stat, identity, ID or byte count, and its return value is ignored. */
  onCloseStep?: (step: ArtifactCloseStep) => void;
  /** @internal test seam: a fault selector keyed only by close-step label. It is passed no path,
   * descriptor, stat or identity, and decides only whether that step fails. */
  closeStepFails?: (step: ArtifactCloseStep) => boolean;
  /** @internal test seam */ afterRootDescriptor?: () => void;
  /** @internal test seam */ onDataPathOpen?: () => void;
  /** @internal test seam */ onDescriptorClose?: () => void; }
/** @internal test seam: the closed set of ordered teardown steps a clean close performs. */
export type ArtifactCloseStep = "delete-files" | "fsync-data" | "close-data-fd" | "remove-data" | "remove-diagnostic" | "remove-lock" | "fsync-root" | "close-root-fd";
export interface FsOps { linkSync: typeof import("node:fs").linkSync; unlinkSync: typeof import("node:fs").unlinkSync; fsyncSync: typeof import("node:fs").fsyncSync; rmdirSync?: typeof import("node:fs").rmdirSync; /** @internal test seam */ readdirSync?: typeof import("node:fs").readdirSync; }
export interface CaptureOptions { id: string; consumerId: string; ttlMs?: number; }
export type CaptureResult = ArtifactRecord | { status: "capture-failed"; failure: ArtifactFailureCode };
export interface ResponseLease { record: ArtifactRecord; bytes: number; base64: string; deadline: number; complete(): void; }
export type ArtifactOutcome =
  | { outcome: "none" }
  | { outcome: "available"; artifact: ArtifactRecord }
  | { outcome: "inline-pdf-unsupported"; failure: "inline-pdf-unsupported" }
  | { outcome: "capture-failed"; failure: ArtifactFailureCode };
export type OperationResult = ArtifactOutcome;
export interface DownloadLike { path(): Promise<string | null> | string | null; failure?(): Promise<unknown> | unknown; }
export const ARTIFACT_ID = /^[A-Za-z0-9_-]{22,64}$/;
