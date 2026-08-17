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
/**
 * The ONE public projection of an artifact (Task 2 §3.1). Every field here is safe to hand to an MCP
 * consumer; everything the private {@link ArtifactRecord} carries and this does not — the owning
 * `consumerId`, the mutable `status`, and two raw numbers in the injected scheduler's time domain —
 * is store/runtime state, and each of them was crossing the operation boundary before Task 2.
 *
 * It is built ONCE, at successful seal, while the operation still owns the trusted canonical
 * `sourceHost` and the private committed record; no later lookup re-derives it and no MCP surface
 * ever serializes the record itself. Instances are frozen: authorization is decided from the private
 * ledger, never from a field a caller can rewrite.
 *
 * `filename` is deliberately absent in the first implementation: Task 1's accepted `DownloadLike`/
 * operation contract retains none, and manufacturing one would mean reaching back into an untrusted
 * driver object during retrieval. Capturing a filename is separate scope, not a reason to widen this.
 */
export interface ArtifactMetadata {
  readonly artifactId: string;
  readonly kind: "pdf";
  readonly disposition: "attachment";
  readonly sizeBytes: number;
  readonly sha256: string;
  /** ISO-8601, rendered from the record's instant in the ONE injected scheduler domain. */
  readonly createdAt: string;
  readonly expiresAt: string;
  /** Canonical hostname only (Amendment 2 §9): never a URL, a path or a query. */
  readonly sourceHost: string;
  readonly filename?: string;
}
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
/**
 * The PRIVATE Task 1 lease, as the store still spells it: the authoritative record, the raw byte
 * count, the one encoding and a synchronous completion. It never leaves `src/artifacts/`.
 * {@link ArtifactResponseLease} is the public adapter over it.
 */
export interface ResponseLease {
  record: ArtifactRecord; bytes: number; base64: string; deadline: number; complete(): void;
  /**
   * Hand the deadline off to the claimant, exclusively (Amendment 4 §1/§2, plan §4.1). Synchronous,
   * idempotent, and total: it disarms the store's own internal deadline timer so it can never again
   * independently release the response permit or discard the artifact.
   *
   * A caller that never calls this keeps the store's ordinary auto-timeout behavior; production
   * calls it immediately upon receiving this lease, before constructing the public
   * `ArtifactResponseLease` — pre-return expiry stays store-owned, and post-return timeout becomes
   * exclusively whatever later owns the lease (a future HTTP tracker), never a second, racing timer.
   */
  claimTimeout(): void;
}
/** The three exact terminal outcomes a response lease may be completed with (Amendment 4 §1/§2). */
export type ArtifactResponseOutcome = "sent" | "transport-failed" | "timed-out";
/**
 * The AUTHORITATIVE cross-module response lease (Amendment 4 §1). A caller receives the artifact only
 * ever like this: already encoded, already assembled into its final embedded-resource block, under a
 * permit and a reservation the lease still holds, and against one absolute deadline.
 *
 * Deliberately NOT the private Task 1 lease. That one hands out `record` (the owning consumer, the
 * mutable status and two raw scheduler numbers), a bare `bytes` count and a raw `base64` string, and
 * completes SYNCHRONOUSLY with no reason at all — so a transport adapter could neither say WHY a
 * response ended nor await the deletion its completion performs. Here:
 *
 *  - `resource` is the finished block. The MCP layer never receives a `Buffer` and never re-encodes:
 *    one encoding exists, it is made in the artifact layer under the permit, and it is handed on.
 *  - `deadlineMs` is ONE absolute instant in the injected scheduler's domain, opened immediately
 *    before file open and never extended. A transport tracker computes its own remaining time from
 *    `deadlineMs - runtime.now()`; the clock is published by the runtime, so tracking the remaining
 *    budget never requires widening this shape.
 *  - `complete()` is asynchronous and idempotent, and the FIRST outcome wins. It makes the artifact
 *    permanently unavailable, performs the owned private discard, and only then releases the permit
 *    and the response reservation. No outcome — and no failure inside one — returns it to available.
 */
export interface ArtifactResponseLease {
  readonly metadata: ArtifactMetadata;
  readonly resource: {
    readonly type: "resource";
    readonly resource: {
      readonly uri: string;
      readonly mimeType: "application/pdf";
      readonly blob: string;
    };
  };
  readonly deadlineMs: number;
  complete(outcome: ArtifactResponseOutcome): Promise<void>;
}
export type ArtifactOutcome =
  | { outcome: "none" }
  // Task 2 §3.2: the ONE deliberate public-surface migration. A successful capture carries the safe
  // projection; the private record stays store/runtime-only and is never serialized at an MCP seam.
  | { outcome: "available"; artifact: ArtifactMetadata }
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
