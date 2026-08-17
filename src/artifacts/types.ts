/** Who an artifact belongs to. Never exposed in MCP results. */
export type ArtifactOwner =
  | { scope: "consumer"; consumerId: string }
  | { scope: "drive"; consumerId: string; controllerId: string };
/**
 * The authoritative cross-module capture-operation interface (Amendment 3 §1). Callers create one via
 * `ArtifactRuntime.createOperation` and hand it to the browser layer, which drives the lifecycle and
 * never invents owner or host, nor touches the store.
 */
export interface ArtifactCaptureOperation {
  /** Opaque and private: never serialized or logged. */
  readonly operationId: string;
  readonly owner: ArtifactOwner;
  /**
   * Starts internal staging and returns an explicit SYNCHRONOUS OWNERSHIP RECEIPT (Amendment 7 §8.1,
   * which supersedes Amendment 3 §1 for this signature alone).
   *
   * Exact `true` transfers ownership of the driver object to the operation; exact `false` RETAINS
   * disposal ownership in the caller, and the operation does not touch the object it refused. A
   * boolean is not the private staging ledger: no caller can await, retain or race it. Returning
   * nothing was the defect — a caller could not tell an acceptance from a refusal, so a refused
   * download ended up owned by nobody: never staged, never cancelled, never deleted.
   *
   * Existing callers that ignore the result remain call-compatible; every implementation and fake
   * must return the exact receipt.
   */
  registerDownload(download: DownloadLike): boolean;
  /**
   * The landed main-frame observation. API WIDENING (documented): Amendment 3 §1 spells this with a
   * bare content type, which cannot express Amendment 5 §1's three-part predicate — that needs the
   * landed status from the SAME response. Amendment 5 has higher precedence, so the parameter is the
   * atomic pair rather than the predicate being weakened.
   */
  noteMainResponseContentType(observation: { status: number | null; contentType: string | null }): void;
  /** Commit the outcome, awaiting the staging this operation started. */
  seal(): Promise<ArtifactOutcome>;
  /**
   * Retire with an exact closed reason. Synchronous, idempotent, non-throwing, and it wins against a
   * pending seal. The reason is normalized at RUNTIME against the closed vocabulary — this type is
   * erased, so a value outside it becomes `artifact-config-invalid` and never reaches a result,
   * callback or log. Invalidating an operation that still owns an attributed download also takes
   * disposal ownership of it, exactly once, bounded by that operation's single settlement deadline.
   */
  invalidate(reason: ArtifactFailureCode): void;
}
/** Amendment 3 §1's operation result; the same closed shape as {@link ArtifactOutcome}. */
export type ArtifactStatus = "available" | "capture-failed" | "expired" | "consuming";
export type ArtifactFailureCode =
  | "download-capture-failed" | "download-settle-timeout" | "download-lifecycle-race" | "multiple-artifacts" | "inline-pdf-unsupported"
  | "artifact-size-limit" | "artifact-not-pdf" | "artifact-write-failed" | "artifact-integrity-failed" | "artifact-filesystem-unsupported" | "artifact-transport-unsupported"
  | "artifact-capacity" | "artifact-expired" | "artifact-not-found" | "artifact-owner-mismatch" | "artifact-rate-limited" | "artifact-response-timeout" | "artifact-cleanup-failed" | "artifact-runtime-invalidated"
  | "artifact-root-locked" | "artifact-root-invalid" | "artifact-config-invalid";
export type ArtifactFailure = ArtifactFailureCode;
export type ArtifactStoreErrorCode = "invalid-artifact-id" | "artifact-store-unavailable" | ArtifactFailureCode;
export class ArtifactStoreError extends Error { readonly code: ArtifactStoreErrorCode; constructor(code: ArtifactStoreErrorCode) { super(code); this.name = "ArtifactStoreError"; this.code = code; } }
/**
 * One artifact, as it crosses a PUBLIC boundary: an operation result, a capture result or a response
 * lease. Every field is `readonly`, and every instance a caller receives is a frozen snapshot taken
 * at that crossing — never the store's own record.
 *
 * This is a security property, not a style: the store authorizes retrieval from `consumerId`, proves
 * integrity from `bytes`/`sha256`, and expires from `expiresAt`. Handing the authoritative object to
 * a caller let `result.artifact.consumerId = "attacker"` re-authorize the artifact to somebody else.
 */
export interface ArtifactRecord { readonly id: string; readonly consumerId: string; readonly bytes: number; readonly sha256: string; readonly createdAt: number; readonly expiresAt: number; readonly status: "available" | "consuming"; }
/** @internal test seam: aggregate accounting only — never IDs, consumers, paths, names, hashes or content. */
export interface ArtifactAccounting { count: number; bytes: number; stagingBytes: number; stagePermits: number; stagePermitLimit: number; responsePermitHeld: boolean; responseWaiters: number; responseBytes: number; consumers: number; }
/** The single time domain for artifact expiry, leases, cleanup AND capture-operation settlement
 *  (its accessor waits and disposal confirmations). Never mixed with ambient `Date.now`/`setTimeout`. */
export interface ArtifactScheduler { now(): number; /** Process start, in the same domain as `now`. Diagnostic only: never read to decide liveness. */ processStartedAt(): number; setTimeout(callback: () => void, delayMs: number): unknown; clearTimeout(handle: unknown): void; }
/**
 * Everything an artifact configuration carries EXCEPT the two members that decide whether a root is
 * required at all. See {@link ArtifactStoreOptions}, which is the type callers use.
 */
export interface ArtifactStoreOptionsCommon { ttlMs?: number; cleanupIntervalMs?: number; maxBytes?: number; maxCount?: number; perConsumerBytes?: number; perConsumerCount?: number; idGenerator?: () => string; fsOps?: FsOps; /** @internal test seam: the one injected clock, shared by the store and by operation settlement deadlines. */ scheduler?: ArtifactScheduler; /** @internal: a clean discard revoked a committed record or one in-flight capture; closeOwned identifies the store-close sweep. */ onDiscard?: (id: string, closeOwned: boolean) => void; /** @internal test seam */ onCleanupPass?: () => void; /** @internal test seam */ afterPartFsync?: () => void | Promise<void>; /** @internal test seam */ afterLinkBeforeCommit?: () => void | Promise<void>;
  /** @internal test seam: the exact window between staged jobs settling and the result committing. */
  beforeCommit?: () => void | Promise<void>;
  /** @internal test seam: fires synchronously when a generation becomes terminal, carrying only its closed code. */
  onOperationTerminal?: (reason: ArtifactFailureCode) => void;
  /** @internal test seam: fires once a terminal operation's continuations finished and its ID was freed. */
  onOperationReleased?: () => void;
  /** @internal test seam: fires only on the legal `sealing -> committed` transition. */
  onOperationCommitted?: () => void;
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
/**
 * The configuration both public constructors take, as a DISCRIMINATED shape (Amendment 2 §7).
 *
 * A disabled configuration owns no tree: it opens no descriptor, takes no lock, arms no timer and
 * performs no filesystem call, so requiring it to name a root asked for a value nothing would ever
 * read — and `new ArtifactStore({ enabled: false })` was refused with `artifact-config-invalid` for
 * omitting it. `root` is therefore optional on the disabled member ONLY; an explicitly enabled or
 * default-enabled configuration still requires a non-empty absolute root, and its runtime validation
 * is unchanged. Existing callers are source-compatible either way: `{ root }`, `{ enabled: true, root }`
 * and `{ enabled: false, root }` all still typecheck.
 */
export type ArtifactStoreOptions =
  | (ArtifactStoreOptionsCommon & { enabled?: true; root: string })
  | (ArtifactStoreOptionsCommon & { enabled: false; root?: string });
/** @internal test seam: the closed set of ordered teardown steps a clean close performs. */
export type ArtifactCloseStep = "delete-files" | "fsync-data" | "close-data-fd" | "remove-data" | "remove-diagnostic" | "remove-lock" | "fsync-root" | "close-root-fd";
/**
 * The exact internal outcome of a discard (Amendment 7 §5.1). The public
 * `ArtifactStore.discardArtifact` boolean is exactly `result === "clean"`; runtime code must use the
 * detailed method, because the two `false` cases demand opposite handling:
 *
 *  - `clean`   — identity-proven durable deletion, or an identity-proven no-op/ENOENT.
 *  - `refused` — a requested/completed close was observed BEFORE any side effect. Store close owns
 *    the deletion; the caller keeps its terminal reason and waits for the one close result.
 *  - `failed`  — durable deletion could not be proven. The caller's outcome becomes a cleanup
 *    failure and its identity is retained permanently.
 */
export type ArtifactDiscardResult = "clean" | "refused" | "failed";
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
/** The driver download surface this project depends on. `cancel`/`delete` are the closed disposal
 *  operations used to dispose of a download the gateway will not keep; both exist on a real driver
 *  Download, and a source offering neither cannot prove its bytes are gone.
 *
 *  Every method here is UNTRUSTED third-party code: it may throw synchronously, reject, or never
 *  settle at all. Callers invoke `cancel` then `delete` without waiting for the first, and bound every
 *  wait — an accessor that never settles is abandoned, never awaited indefinitely. */
export interface DownloadLike { path(): Promise<string | null> | string | null; failure?(): Promise<unknown> | unknown; cancel?(): Promise<void> | void; delete?(): Promise<void> | void; }
export const ARTIFACT_ID = /^[A-Za-z0-9_-]{22,64}$/;
