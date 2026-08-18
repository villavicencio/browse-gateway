import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { ArtifactStore, SYSTEM_SCHEDULER, canonicalizeStoreOptions } from "./store.js";
import { ARTIFACT_ID, ArtifactStoreError, type ArtifactFailureCode, type ArtifactDiscardResult, type ArtifactMetadata, type ArtifactOwner, type ArtifactRecord, type ArtifactResponseLease, type ArtifactResponseOutcome, type ArtifactScheduler, type ArtifactStoreOptions, type DownloadLike, type OperationResult, type ResponseLease } from "./types.js";
import { canonicalizeHost, canonicalizeHostForIp } from "../security/url.js";
import { isIP } from "node:net";

/**
 * Validate and freeze an {@link ArtifactOwner}. Scope is a closed two-member set; `drive` requires a
 * non-empty controller and `consumer` must not carry one at all, so a consumer-scoped artifact can
 * never acquire controller lineage by accident. The returned snapshot is frozen and owned by the
 * runtime — never the caller's object.
 */
function canonicalizeOwner(owner: ArtifactOwner | undefined): ArtifactOwner {
  if (!owner || typeof owner !== "object") throw new ArtifactStoreError("artifact-config-invalid");
  let scope: unknown, consumerId: unknown, controllerId: unknown;
  try {
    const candidate = owner as { scope?: unknown; consumerId?: unknown; controllerId?: unknown };
    // Snapshot every caller-controlled property exactly once. Getters/proxies are untrusted and their
    // raw exceptions must never cross the runtime boundary or be re-read after validation.
    scope = candidate.scope;
    consumerId = candidate.consumerId;
    controllerId = candidate.controllerId;
  } catch {
    throw new ArtifactStoreError("artifact-config-invalid");
  }
  if (typeof consumerId !== "string" || consumerId.length === 0) {
    throw new ArtifactStoreError("artifact-config-invalid");
  }
  if (scope === "consumer") {
    if (controllerId !== undefined) throw new ArtifactStoreError("artifact-config-invalid");
    return Object.freeze({ scope: "consumer" as const, consumerId });
  }
  if (scope === "drive") {
    if (typeof controllerId !== "string" || controllerId.length === 0) {
      throw new ArtifactStoreError("artifact-config-invalid");
    }
    return Object.freeze({ scope: "drive" as const, consumerId, controllerId });
  }
  throw new ArtifactStoreError("artifact-config-invalid");
}

const HOST = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const MAX_ID_ATTEMPTS = 8;
/**
 * The closed failure vocabulary as a RUNTIME value. The TypeScript union is erased at run time, so a
 * JavaScript caller can hand `invalidate()` any value at all; this table is what actually keeps the
 * vocabulary closed. Spelled as an exhaustive `Record` so a new {@link ArtifactFailureCode} fails the
 * typecheck here rather than silently escaping normalization.
 */
const FAILURE_CODES: Readonly<Record<ArtifactFailureCode, true>> = Object.freeze({
  "download-capture-failed": true, "download-settle-timeout": true, "download-lifecycle-race": true, "multiple-artifacts": true, "inline-pdf-unsupported": true,
  "artifact-size-limit": true, "artifact-not-pdf": true, "artifact-write-failed": true, "artifact-integrity-failed": true, "artifact-filesystem-unsupported": true, "artifact-transport-unsupported": true,
  "artifact-capacity": true, "artifact-expired": true, "artifact-not-found": true, "artifact-owner-mismatch": true, "artifact-rate-limited": true, "artifact-response-timeout": true, "artifact-cleanup-failed": true, "artifact-runtime-invalidated": true,
  "artifact-root-locked": true, "artifact-root-invalid": true, "artifact-config-invalid": true,
});
/** Module-private membership set. `Set.prototype.has` compares by identity/SameValueZero, so a
 *  symbol, object, array or hostile proxy is classified WITHOUT any property access or coercion. */
const CLOSED_REASONS: ReadonlySet<unknown> = new Set(Object.keys(FAILURE_CODES));
/** The ONE settlement budget an operation ever gets, in the injected scheduler's time domain. Every
 *  accessor wait shares it; no sequential accessor step gets a fresh one. */
const SETTLEMENT_BUDGET_MS = 5_000;
/**
 * The SEPARATE confirmation budget driver disposal gets (Amendment 7 §2), opened when cleanup
 * ownership is claimed and never charged against {@link SETTLEMENT_BUDGET_MS}.
 *
 * The two must not share, because cleanup is routinely claimed BY the settlement deadline itself —
 * the timer calls `invalidate()`, which takes disposal ownership at the exact instant the operation's
 * remaining budget is zero. Confirming under that remainder gave an already-answered `cancel()`/
 * `delete()` no time at all, recorded a successful disposal as unconfirmed, retained the identity for
 * good and poisoned the runtime against every later capture — on the ordinary timeout path.
 */
const CLEANUP_CONFIRM_BUDGET_MS = 5_000;
/**
 * The CLOSED range a landed main-frame HTTP status may fall in — the whole of RFC 9110's status
 * space, and nothing else. A driver reports the status it read off the wire, so a value outside this
 * range (a zero, a negative, a fraction, a NaN, a 9000, a string, an object) is not an observation
 * this stack can have made; it is a malformed report, and the operation is retired rather than
 * allowed to decide the inline-PDF predicate from it.
 */
/** Amendment 2 §3: at most 30 retrieval attempts per consumer per rolling minute. */
const MAX_RETRIEVALS_PER_WINDOW = 30;
const RETRIEVAL_WINDOW_MS = 60_000;
const MIN_HTTP_STATUS = 100;
const MAX_HTTP_STATUS = 599;

/** The widest instant a `Date` can represent. A scheduler value outside it has no ISO rendering. */
const MAX_TIME_VALUE = 8.64e15;
/**
 * Render ONE instant from the injected scheduler's domain as ISO-8601, or answer `undefined` when it
 * has no rendering at all.
 *
 * The clock is an INJECTED authority, and nothing validates the numbers it returns: `now()` may
 * answer a NaN, an infinity or 1e20, and `new Date(...).toISOString()` throws a raw `RangeError` on
 * every one of them. Thrown from the projection this is called from, that exception would escape
 * `seal()` — a public method whose whole error vocabulary is closed — so an unrenderable instant is
 * reported as the malformed configuration it is, not as an escaping Node exception.
 */
function isoInstant(value: number): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAX_TIME_VALUE) return undefined;
  try { return new Date(value).toISOString(); } catch { return undefined; }
}

/**
 * Project the private committed record into the ONE public artifact shape (Task 2 §3.1).
 *
 * Built at successful seal, from the record the store just committed plus the operation's OWN frozen
 * canonical `sourceHost` — never a caller string re-read at projection time, and never a later
 * lookup. The result is frozen and carries no `consumerId`, `status`, raw scheduler number, owner,
 * path, operation ID or reservation state: authorization is decided from the runtime's private
 * ledger, so a field a caller could rewrite decides nothing.
 */
function projectMetadata(record: ArtifactRecord, sourceHost: string): ArtifactMetadata | undefined {
  const createdAt = isoInstant(record.createdAt);
  const expiresAt = isoInstant(record.expiresAt);
  if (createdAt === undefined || expiresAt === undefined) return undefined;
  return Object.freeze({
    artifactId: record.id,
    kind: "pdf" as const,
    disposition: "attachment" as const,
    sizeBytes: record.bytes,
    sha256: record.sha256,
    createdAt,
    expiresAt,
    sourceHost,
  });
}

/**
 * Adapt Task 1's accepted private lease to Amendment 4's authoritative one.
 *
 * A pure adapter, deliberately: the bytes were opened, verified, hashed and encoded ONCE, inside the
 * store, under the single global permit — this wraps that one encoding into its final embedded
 * resource and adds nothing. Nothing here re-reads the file, re-encodes the buffer or copies it, so
 * the permit continues to bound exactly one raw buffer and one base64 string, as Amendment 2 §3
 * requires.
 *
 * `complete()` is asynchronous and idempotent with FIRST-OUTCOME-WINS semantics, and it never
 * rejects: it is invoked from guarded transport fallbacks and from a `finally`, where a rejection
 * would replace the failure being handled. The private completion beneath it makes the artifact
 * permanently unavailable, performs the owned durable discard, and releases the permit and the
 * response reservation — in that order, synchronously, so no waiter admitted by the release can
 * observe the artifact still present.
 */
function makeResponseLease(raw: ResponseLease, metadata: ArtifactMetadata): ArtifactResponseLease {
  let completion: Promise<void> | undefined;
  return Object.freeze({
    metadata,
    resource: Object.freeze({
      type: "resource" as const,
      // The URI carries the authorized opaque ID and nothing else: no path, no root, no private URL.
      resource: Object.freeze({ uri: `artifact:${metadata.artifactId}`, mimeType: "application/pdf" as const, blob: raw.base64 }),
    }),
    deadlineMs: raw.deadline,
    /**
     * All three outcomes perform the SAME irreversible terminal work — Amendment 2 §5 gives
     * `sent`, transport failure and the exact 15-second timeout the same destination, and no path
     * returns an artifact to `available`. The reason exists for the audit surface above, which is
     * why nothing here reads it: an out-of-vocabulary value handed in by a JavaScript caller cannot
     * reach a decision, a callback or a log line, because it reaches nothing at all.
     */
    complete(_outcome: ArtifactResponseOutcome): Promise<void> {
      if (completion) return completion;
      // Latched BEFORE the work, so a re-entrant completion observes the latch rather than
      // discarding twice. The private completion is synchronous, so awaiting this resolved promise
      // still means the deletion and the permit release have already happened.
      completion = Promise.resolve();
      try { raw.complete(); } catch { /* the private completion is total; a throw must not reject */ }
      return completion;
    },
  });
}

/** What an untrusted accessor produced, or that the operation stopped waiting for it. */
type AccessorOutcome<T> = { state: "value"; value: T } | { state: "threw" } | { state: "stopped" };

/**
 * Await ONE untrusted driver accessor against the operation's terminal/deadline signal.
 *
 * MODULE-LEVEL AND CLOSURE-FREE ON PURPOSE. The continuations this attaches to the third-party
 * promise capture only `finish` — never the {@link ArtifactOperation}, the {@link ArtifactRuntime} or
 * the {@link DownloadLike}. So a `failure()`/`path()` that never settles retains a resolve function
 * for an already-settled promise and nothing else: it cannot publish, mutate accounting, release or
 * reuse a reservation, or reach a callback, however long it stays pending.
 *
 * A SYNCHRONOUS throw is caught here too: `Promise.resolve(fn())` never sees it, because the throw
 * happens while evaluating `fn()` itself.
 *
 * `isCurrent` is the caller's SYNCHRONOUS authority predicate, consulted exactly once — after the one
 * `then` read, before the adoption — and deliberately never handed to {@link adoptUntrusted}, so no
 * continuation retained by a promise that never settles can reach it or the operation behind it.
 */
function raceUntrusted<T>(invoke: () => T | Promise<T>, stop: Promise<void>, isCurrent: () => boolean): Promise<AccessorOutcome<T>> {
  let raw: T | Promise<T>;
  let then: unknown;
  try {
    raw = invoke();
    // Same boundary as the disposal path: classifying the return value reads `then`, and that read is
    // as untrusted as the call itself. A throwing getter is an accessor that failed, not an escape.
    // ONE read, and the callable it produced is the one adopted below: handing the value back to
    // `Promise.resolve(raw)` read `then` a SECOND time, so the answer that classified was never the
    // answer that ran. A value answering callable-first and callable-second let the DRIVER pick which
    // continuation the gateway adopted; one answering callable-first and non-callable-second was
    // reclassified as a plain accessor value and fulfilled with the OBJECT ITSELF — a `failure()`
    // nothing answered became a truthy reported failure, and a `path()` nothing answered became a
    // captured path. A value whose `then` is not callable is simply not a thenable: an ordinary value.
    then = raw !== null && (typeof raw === "object" || typeof raw === "function") ? (raw as { then?: unknown }).then : undefined;
  } catch {
    return Promise.resolve({ state: "threw" });
  }
  if (typeof then !== "function") return Promise.resolve({ state: "value", value: raw as T });
  // That ONE read is untrusted code in its own right, and it runs BETWEEN the accessor's own terminal
  // check and this adoption: a getter may synchronously `invalidate()` the operation and then hand
  // back a perfectly callable `then`. Applying it anyway ran hostile code on behalf of a generation
  // that no longer existed and handed it this module's settlement capability. The same rule the
  // `failure`/`path` property reads already follow — a decided operation touches nothing further on
  // the driver's behalf — so the snapshot is dropped and the wait is over. NOT symmetric with
  // `invokeDisposal()`: once cleanup is claimed, terminalization revokes no confirmation obligation.
  if (!isCurrent()) return Promise.resolve({ state: "stopped" });
  return adoptUntrusted<T>(then as (...args: unknown[]) => unknown, raw as object, stop);
}

/**
 * Adopt the ONE snapshotted `then`, split out of {@link raceUntrusted} so this scope holds no
 * reference to the authority predicate — or to anything it closes over. A `then` that settles nothing
 * retains these continuations for as long as it likes, and they can still reach only `finish`.
 */
function adoptUntrusted<T>(then: (...args: unknown[]) => unknown, raw: object, stop: Promise<void>): Promise<AccessorOutcome<T>> {
  return new Promise<AccessorOutcome<T>>((resolve) => {
    let done = false;
    const finish = (outcome: AccessorOutcome<T>) => { if (!done) { done = true; resolve(outcome); } };
    // The adoption is OURS, not the promise machinery's: the EXACT snapshot is applied against its
    // own value as receiver, one settlement wins, and a `then` that throws after already settling
    // cannot rewrite the answer it gave. A `then` that settles nothing leaves this pending on
    // purpose — the operation's one deadline, through `stop`, is what decides it.
    try {
      Reflect.apply(then, raw, [(value: T) => finish({ state: "value", value }), () => finish({ state: "threw" })]);
    } catch {
      finish({ state: "threw" });
    }
    void stop.then(() => finish({ state: "stopped" }));
  });
}

/**
 * Invoke ONE closed disposal operation. The call happens SYNCHRONOUSLY inside this function, so the
 * caller can start `cancel()` and then `delete()` without waiting for the first to settle — a hung,
 * throwing or rejecting `cancel()` must never prevent the `delete()` attempt, which is exactly the
 * case where the driver's copy would otherwise be left on disk.
 *
 * The boolean is what the driver REPORTED, not whether the bytes are gone. Those are different facts:
 * against a real driver the two disposal calls are mutually exclusive, so one of them reports failure
 * on a disposal that fully succeeded. Callers holding the staged path decide from the file instead —
 * see `ArtifactOperation`'s `#startCleanup` — and this answer is what they fall back on when they
 * have no path to consult.
 */
function invokeDisposal(run: () => Promise<void> | void): Promise<boolean> {
  let raw: Promise<void> | void;
  let then: unknown;
  try {
    raw = run();
    // The RETURN VALUE is untrusted too: classifying it reads `then`, which can be a getter that
    // throws. Probing it outside this try made that throw escape a synchronous caller. ONE read, and
    // the callable it produced is the one adopted below: `Promise.resolve(raw)` read `then` a SECOND
    // time, so a value answering callable-first and non-callable-second was classified as a promise
    // and then adopted as a plain value — fulfilling with the object itself and recording a disposal
    // NOTHING had confirmed. A value whose `then` is not callable is simply not a thenable: that is a
    // completed call, like any `void`.
    then = raw !== null && (typeof raw === "object" || typeof raw === "function") ? (raw as { then?: unknown }).then : undefined;
  } catch {
    return Promise.resolve(false);
  }
  if (typeof then !== "function") return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    // The adoption is OURS, not the promise machinery's: one settlement wins, and a `then` that
    // throws after already settling cannot rewrite the answer it gave. A `then` that settles nothing
    // leaves this pending on purpose — the caller's claim-anchored budget is what decides it.
    let settled = false;
    const settleOnce = (confirmed: boolean): void => { if (!settled) { settled = true; resolve(confirmed); } };
    try {
      Reflect.apply(then as (...args: unknown[]) => unknown, raw as object, [() => settleOnce(true), () => settleOnce(false)]);
    } catch {
      settleOnce(false);
    }
  });
}

/**
 * The runtime's private channel to an operation. Reachable only through this module-private table:
 * the operation exposes no public disposal, discard-notification or close-resolution method, so
 * nothing outside `src/artifacts/` can revoke a generation or free an identity.
 */
interface RuntimeHooks {
  /** Retire the generation on runtime close. */
  dispose(): void;
  /** The store proved this operation's artifact is durably gone, and names close-owned cleanup. */
  artifactDiscarded(closeOwned: boolean): void;
  /** The one store-close result, for an operation whose discard the store refused. */
  storeCloseSettled(failed: boolean): void;
}
const runtimeHooks = new WeakMap<ArtifactOperation, RuntimeHooks>();
const disposeForRuntime = (operation: ArtifactOperation) => runtimeHooks.get(operation)?.dispose();
const notifyArtifactDiscarded = (operation: ArtifactOperation, closeOwned: boolean) => runtimeHooks.get(operation)?.artifactDiscarded(closeOwned);
const settleStoreClose = (operation: ArtifactOperation, failed: boolean) => runtimeHooks.get(operation)?.storeCloseSettled(failed);

/**
 * One capture operation and the single synchronous authority over its outcome (Amendment 3 §1,
 * Amendment 5 §2).
 *
 * State: `open -> sealing -> committed(result) | invalidated(reason)`. Every transition happens in
 * synchronous, in-memory code, so `invalidate()` and the commitment step inside `seal()` can never
 * interleave: whichever runs first decides, and the other observes the decision.
 *
 * An `available` capture reached before commitment is PROVISIONAL. Invalidation while `open`/`sealing`
 * discards it and wins; only a committed result is returnable, and ordinary invalidation after
 * commitment leaves it alone.
 */
export class ArtifactOperation {
  readonly operationId!: string;
  readonly owner!: ArtifactOwner;
  readonly sourceHost!: string;
  readonly artifactId!: string;
  readonly #store: ArtifactStore;
  readonly #release: () => void;
  readonly #scheduler: ArtifactScheduler;
  readonly #beforeCommit?: () => void | Promise<void>;
  readonly #onTerminal?: (reason: ArtifactFailureCode) => void;
  readonly #onReleased?: () => void;
  readonly #onCommitted?: () => void;
  readonly #onCleanupUnconfirmed?: () => void;
  /** The runtime's token-bound owner-ledger publication, invoked ONCE, on the legal
   *  `sealing -> committed(available)` transition and never from anywhere else. */
  readonly #publishOwner?: (metadata: ArtifactMetadata) => void;
  #state: { name: "open" | "sealing" } | { name: "committed"; result: OperationResult } | { name: "invalidated"; reason: ArtifactFailureCode } = { name: "open" };
  #events = 0;
  #jobs = new Set<Promise<void>>();
  /** A staged artifact that has not been committed yet — discardable until `seal()` commits it. */
  #provisional?: ArtifactRecord;
  #status: number | null = null;
  #contentType: string | null = null;
  #cleanupFailed = false;
  #released = false;
  /** Staging jobs still running. A terminal state reached while one is in flight must NOT release the
   *  ID reservation until that continuation has finished cleaning up (B2 invariant). */
  #active = 0;
  /** A committed `available` artifact keeps its reservation until the store durably discards it, so a
   *  replacement operation cannot claim the same ID while the artifact is still retrievable. */
  #waitingForArtifact = false;
  /** A refusal this operation cannot resolve itself is outstanding (Amendment 7 §5.1/§5.2). Set three
   *  ways, all meaning "somebody else owns this deletion and has not reported yet": a discard was
   *  REFUSED because the store is closing, a discard was REFUSED because the record is `consuming` and
   *  its response lease owns resolution, or the close's own sweep deleted this operation's committed
   *  artifact from inside a close that can still fail. The result alone does not name the owner, so
   *  this latch deliberately does NOT claim one. It is cleared by whoever actually reports: a
   *  lease-owned `onDiscard`, or the ONE store-close result. Until then the terminal reason stands
   *  unchanged and the identity stays reserved. This operation owns no filesystem retry in any case. */
  #refusalPending = false;
  /** The store-close result, once known. Latched because it can arrive on either side of the refusal
   *  it answers: the store's close settles from a capture's own `finally`, which can run before the
   *  staging continuation that discovers the refusal. */
  #storeClose: { settled: false } | { settled: true; failed: boolean } = { settled: false };
  /** The ONE attributed download, while it is still this operation's to dispose of. Cleared the
   *  instant cleanup takes ownership of it, and when the staging job that consumed it finishes. */
  #download?: DownloadLike;
  /** Where the driver staged its copy, as the staging job read it — the only evidence this operation
   *  can consult to decide whether disposal actually removed the bytes. Absent until the path read
   *  succeeds, and never re-read from the driver: a terminal operation touches nothing further on the
   *  driver's behalf, and `path()` REJECTS once disposal has been invoked anyway (measured). */
  #stagedPath?: string;
  /** The single cleanup record for that download. `idle -> running -> confirmed | failed`, advanced
   *  by compare-and-set: the first request becomes owner and invokes the driver, later ones only
   *  observe. Repeated invalidation, close, kill or a late accessor can never dispose twice. */
  #cleanup: "idle" | "running" | "confirmed" | "failed" = "idle";
  /** Sticky: disposal could not be confirmed. Distinct from {@link #cleanupFailed} (a failed STORE
   *  discard, which supersedes the result under B2). This one never rewrites the terminal reason —
   *  it retains the unsafe identity and poisons the runtime for NEW captures. */
  #cleanupUnconfirmed = false;
  /** The single lifecycle deadline instant, established by the first synchronous `seal()`/
   *  `invalidate()` and never extended. Its timer is armed only while something is actually waiting. */
  #deadlineAt?: number;
  #deadlineTimer?: unknown;
  /** Resolves when the operation is terminal or its deadline expires — whichever happens first. */
  #stop?: Promise<void>;
  #wake?: () => void;
  constructor(
    store: ArtifactStore,
    owner: ArtifactOwner,
    sourceHost: string,
    artifactId: string,
    release: () => void,
    scheduler: ArtifactScheduler,
    beforeCommit?: () => void | Promise<void>,
    onTerminal?: (reason: ArtifactFailureCode) => void,
    onReleased?: () => void,
    onCommitted?: () => void,
    /** Fires once, when this operation could not confirm disposal of its attributed download. */
    onCleanupUnconfirmed?: () => void,
    publishOwner?: (metadata: ArtifactMetadata) => void,
  ) {
    this.#store = store;
    this.#release = release;
    this.#scheduler = scheduler;
    this.#beforeCommit = beforeCommit;
    this.#onTerminal = onTerminal;
    this.#onReleased = onReleased;
    this.#onCommitted = onCommitted;
    this.#onCleanupUnconfirmed = onCleanupUnconfirmed;
    this.#publishOwner = publishOwner;
    // TypeScript `readonly` disappears at runtime. These values govern store ownership/reservation
    // after asynchronous driver work, so expose them as immutable own properties: neither assignment
    // nor `defineProperty` may replace the frozen owner snapshot or disconnect the reserved identity.
    Object.defineProperties(this, {
      owner: { value: owner, enumerable: false, writable: false, configurable: false },
      sourceHost: { value: sourceHost, enumerable: false, writable: false, configurable: false },
      artifactId: { value: artifactId, enumerable: false, writable: false, configurable: false },
      // Opaque and private: never serialized, logged, or derived from anything the caller supplied.
      operationId: { value: randomBytes(16).toString("base64url"), enumerable: false, writable: false, configurable: false },
    });
    runtimeHooks.set(this, {
      dispose: () => this.invalidate("artifact-runtime-invalidated"),
      artifactDiscarded: (closeOwned) => this.#noteArtifactDiscarded(closeOwned),
      storeCloseSettled: (failed) => this.#settleStoreClose(failed),
    });
  }

  /**
   * Amendment 5 §1: status and content type are ONE observation of the SAME landed main-frame
   * response, so they are taken together and never separately.
   *
   * API WIDENING (documented): Amendment 3 §1 spells this method with a bare `contentType`, which
   * cannot express Amendment 5's three-part predicate — it needs the landed status from that same
   * response. Amendment 5 has higher precedence, so the parameter is widened to the atomic pair
   * rather than the predicate being weakened to content type alone. The method name is unchanged.
   *
   * RUNTIME-HARDENED. The parameter is typed, but types are erased: the browser core hands this
   * whatever a driver produced, and a public JavaScript caller can hand it anything at all. So the
   * FIRST instruction is the open-state check — a decided operation reads nothing — and everything
   * after it treats the object as untrusted. A malformed observation is reported the only way this
   * class reports anything, with the exact closed code `artifact-config-invalid`; nothing here throws
   * a raw exception, which used to happen twice over: immediately for a null, and much later inside
   * `seal()` when a `contentType` object's `trim()` threw its own secret-bearing text.
   */
  noteMainResponseContentType(observation: { status: number | null; contentType: string | null }): void {
    // Late observations are the caller's to classify via invalidate(): nothing is read or coerced.
    if (this.#state.name !== "open") return;
    if (!observation || typeof observation !== "object") { this.invalidate("artifact-config-invalid"); return; }
    let status: unknown, contentType: unknown;
    try {
      // Amendment 5 §1's ATOMIC PAIR, snapshotted exactly once. A getter or proxy may throw or answer
      // differently on a second read; neither may govern the inline-PDF predicate.
      const candidate = observation as { status?: unknown; contentType?: unknown };
      status = candidate.status;
      contentType = candidate.contentType;
    } catch {
      this.invalidate("artifact-config-invalid");
      return;
    }
    if (!(status === null || (typeof status === "number" && Number.isInteger(status) && status >= MIN_HTTP_STATUS && status <= MAX_HTTP_STATUS))) {
      this.invalidate("artifact-config-invalid");
      return;
    }
    if (!(contentType === null || typeof contentType === "string")) {
      this.invalidate("artifact-config-invalid");
      return;
    }
    // A hostile getter may have re-entered and retired this generation while the pair was being read.
    // The snapshot belongs to an operation that is still open, or to nobody — and the reason that
    // retired it stands, because `invalidate()` is first-reason-wins.
    if (this.#state.name !== "open") return;
    this.#status = status;
    this.#contentType = contentType;
  }

  /**
   * Attribute one download event and answer with an exact OWNERSHIP RECEIPT (Amendment 7 §8.1).
   *
   * `true` is returned only after the claim, the active accounting and ownership have all been
   * installed SYNCHRONOUSLY — before a single untrusted driver property is read or method called, so
   * a hostile getter that re-enters finds an operation already spoken for. `false` means this
   * operation did not take the object, and it does not touch what it refused: reading `path()` or
   * calling `cancel()` on a download whose disposal still belongs to the caller would be a second
   * owner. The staging itself stays internal — a boolean is not a ledger anyone can await or race.
   */
  registerDownload(download: DownloadLike): boolean {
    if (this.#state.name !== "open") return false; // late events are the caller's to classify via invalidate()
    this.#events += 1;
    if (this.#events > 1) {
      // More than one event is ambiguous by contract; no guessing which was meant. The operation
      // terminalizes, but ownership of THIS object stays with the caller — hence the refusal.
      this.invalidate("multiple-artifacts");
      return false;
    }
    // Accounting and ownership FIRST, synchronously, ahead of every untrusted driver touch below —
    // and the staging OBLIGATION with them, which is the half a boolean receipt still has to install.
    //
    // `#stage()` reads `download.failure` inside its OWN synchronous prefix, so calling it here — as
    // this used to — performed the first untrusted driver touch while `#jobs` was still empty. A
    // `failure` getter that re-entered `seal()` from there snapshotted that empty ledger, awaited
    // nothing, and committed `none` for the download this operation had just taken ownership of: a
    // page that produced an artifact reported producing none. The staging is therefore started from
    // a continuation of a promise this module owns — no caller value is read or adopted to build it —
    // so the registration below is already installed when the driver first runs, and a re-entrant
    // seal waits for exactly this accepted staging generation.
    this.#active += 1;
    this.#download = download;
    // The wait every untrusted accessor races against is created here too, and for the same reason:
    // `#stage()` used to create it in the frame this call no longer runs in, and `seal()` arms the
    // one settlement deadline only against a wait that already exists.
    const stop = this.#signal();
    const job = Promise.resolve().then(() => this.#stage(download, stop)).finally(() => {
      this.#active -= 1;
      this.#clearDeadline();
      this.#tryRelease();
    });
    this.#jobs.add(job);
    void job.then(() => this.#jobs.delete(job));
    // Ownership is this operation's, even if synchronous re-entry during the staging prefix above has
    // already terminalized the generation: the transfer happened, and the disposal that follows from
    // it is this operation's to perform.
    return true;
  }

  /** Terminal = the outcome is already decided. `sealing` is NOT terminal: registered jobs finish. */
  #isTerminal(): boolean {
    return this.#state.name === "invalidated" || this.#state.name === "committed";
  }

  /**
   * The signal every untrusted wait races against: resolved by terminalization, or by the one
   * deadline. Created on first use, which is `registerDownload()` — so `seal()` can arm the deadline
   * against a wait that already exists.
   */
  #signal(): Promise<void> {
    if (!this.#stop) {
      this.#stop = new Promise<void>((resolve) => { this.#wake = resolve; });
      if (this.#isTerminal()) this.#wake!();
    }
    this.#armDeadline();
    return this.#stop;
  }

  /** Record the single deadline INSTANT. Idempotent: the first synchronous `seal()`/`invalidate()`
   *  fixes it, and every later call — and every later wait — observes that exact instant. */
  #openDeadline(): void {
    if (this.#deadlineAt === undefined) this.#deadlineAt = this.#scheduler.now() + SETTLEMENT_BUDGET_MS;
  }

  /** Arm the deadline timer, but only while something is actually waiting on the signal and the
   *  outcome is still undecided — a terminal operation has already woken every waiter. */
  #armDeadline(): void {
    if (this.#deadlineAt === undefined || this.#deadlineTimer !== undefined) return;
    if (this.#stop === undefined || this.#isTerminal()) return;
    this.#deadlineTimer = this.#scheduler.setTimeout(() => {
      this.#deadlineTimer = undefined;
      // The budget is spent with untrusted work still outstanding. Terminalize with the EXACT closed
      // timeout code — reporting a bland "none" here would make a lost artifact look like a page that
      // simply produced none — and wake every waiter. `invalidate()` starts disposal exactly once.
      this.invalidate("download-settle-timeout");
      this.#wake?.();
    }, Math.max(0, this.#deadlineAt - this.#scheduler.now()));
  }

  /** Drop the deadline timer once nothing can be waiting on it any more. */
  #clearDeadline(): void {
    if (this.#deadlineTimer === undefined || !this.#isTerminal() || this.#active > 0) return;
    this.#scheduler.clearTimeout(this.#deadlineTimer);
    this.#deadlineTimer = undefined;
  }

  async #stage(download: DownloadLike, stop: Promise<void>): Promise<void> {
    // `#download` — this operation's disposal ownership of the driver's copy — the registration of
    // this very job, and the `stop` wait handed in above were ALL installed by `registerDownload()`
    // before this job started, so the untrusted accessors below can never run ahead of the ownership
    // that makes their disposal somebody's responsibility, nor ahead of the staging obligation a
    // re-entrant `seal()` has to wait for.
    // The job is queued after ownership is installed. Invalidation may win before this microtask gets
    // its first turn; a continuation already made stale must retire without beginning another hostile
    // property read. The checks inside each accessor remain necessary for synchronous re-entry DURING
    // that accessor.
    if (this.#isTerminal()) return;
    try {
      // Both accessors are UNTRUSTED third-party code. They may throw synchronously, reject, resolve
      // never, or resolve long after the outcome was decided; none of those may govern this ledger.
      const failure = await raceUntrusted<unknown>(() => {
        // ONE read. `failure` is a caller-supplied PROPERTY, so the value that decides whether there
        // is an accessor at all must be the value that actually runs: a stateful getter answers a
        // valid callable first and something else — or a throw — second, and this classified one
        // value and then invoked another. The read stays inside `raceUntrusted`'s guard, so a getter
        // that throws is still an accessor that failed rather than an escaping exception.
        const reportFailure = download.failure;
        if (!reportFailure) return undefined;
        // That read is untrusted code and may have re-entered and retired this generation. A decided
        // operation invokes nothing further on its behalf; the terminal check below returns anyway.
        if (this.#isTerminal()) return undefined;
        // Invoked through `Reflect.apply`, which reads NO property of the callable — `call`, `bind`
        // and `length` are all caller-controlled on a caller-supplied function — while still passing
        // the download as the receiver a driver's own method expects. A snapshot that is truthy but
        // not callable throws here, which is the same failed-accessor answer as before.
        return Reflect.apply(reportFailure, download, []);
        // The returned value's `then` read is untrusted too, and can retire this generation between
        // the call above and the adoption. The predicate is consulted synchronously there and never
        // captured by a continuation, so a `failure()` that never settles retains nothing of this.
      }, stop, () => !this.#isTerminal());
      if (failure.state === "stopped" || this.#isTerminal()) return;
      if (failure.state === "threw" || failure.value) { this.invalidate("download-capture-failed"); return; }
      const path = await raceUntrusted<string | null>(() => {
        // ONE read, the same as `failure` above. The getter itself is untrusted and may retire this
        // generation; in that case the callable it returned is never invoked on the retired owner's
        // behalf. Reflect.apply invokes the exact snapshot without reading `call`/`bind` from it.
        const resolvePath = download.path;
        if (this.#isTerminal()) return null;
        return Reflect.apply(resolvePath, download, []);
        // Same seam as `failure` above: the return value's one `then` read may retire this
        // generation, and a stale snapshot is dropped rather than applied.
      }, stop, () => !this.#isTerminal());
      if (path.state === "stopped" || this.#isTerminal()) return;
      if (path.state === "threw" || !path.value) { this.invalidate("download-capture-failed"); return; }
      // The ONE place the driver's staged path is legitimately known, recorded so `#startCleanup()`
      // can confirm disposal from the bytes themselves without ever calling back into the driver.
      //
      // Recorded ONLY if it names a file RIGHT NOW, which makes the later absence a positive cut —
      // present, then gone — rather than an absence that was always true. Without that, a driver
      // handing back a path it never wrote would have its "disposal" confirmed by a file that never
      // existed, which is the one way filesystem evidence could be weaker than the promises it
      // replaces. The type is erased too, so a non-string is not a path and is never recorded. An
      // unrecorded path is "no evidence", which leaves the decision to the driver's own answer.
      if (typeof path.value === "string") {
        try {
          if (existsSync(path.value)) this.#stagedPath = path.value;
        } catch {
          // an unreadable path is not evidence in either direction
        }
      }
      const captured = await this.#store.capture(path.value, { id: this.artifactId, consumerId: this.owner.consumerId });
      if (this.#isTerminal()) {
        // Invalidated while the copy was in flight: it cannot publish, and its file goes with it.
        if (captured.status === "available") this.#discardStaged();
        return;
      }
      if (captured.status === "available") this.#provisional = captured;
      else if ("failure" in captured) this.invalidate(captured.failure);
    } catch {
      // Any exception before commitment invalidates with a closed internal code (Amendment 5 §2).
      this.invalidate("download-capture-failed");
    } finally {
      // This job no longer owns the driver's copy: either the store took one, or a terminal branch
      // already took disposal ownership through `#startCleanup()`, which clears this itself.
      this.#download = undefined;
    }
  }

  /**
   * Dispose of the attributed download EXACTLY ONCE, under its OWN confirmation budget.
   *
   * Compare-and-set on `#cleanup` makes the first caller the owner synchronously, so repeated
   * invalidation, a page close, a kill and a late accessor between them can only observe the record.
   * `running` is installed BEFORE the first untrusted property read or method call, so a hostile
   * getter that re-enters finds ownership already taken. `cancel()` and `delete()` are both INVOKED
   * synchronously here, in that order, without waiting for the first to settle; only their
   * confirmations are awaited, together, under {@link CLEANUP_CONFIRM_BUDGET_MS} — which opens HERE,
   * at the claim, and is never the remainder of the operation's settlement deadline.
   *
   * WHAT COUNTS AS CONFIRMATION. Two independent proofs, either of which is sufficient:
   *
   *  - both closed operations reported success — a cooperative driver's own answer; or
   *  - FILESYSTEM EVIDENCE: the path the staging job read no longer names a file.
   *
   * The second exists because the first is unobtainable from a real driver. Measured in-container
   * (docs/solutions/integration-issues/driver-disposal-calls-are-mutually-exclusive-not-concurrent.md):
   * `cancel()` and `delete()` are MUTUALLY EXCLUSIVE — whichever lands first makes the other reject —
   * so requiring both turned every ordinary refused download into an unconfirmed cleanup, and an
   * unconfirmed cleanup poisons the runtime for the life of the process. One HTML login redirect
   * served as an attachment therefore disabled capture until the container restarted.
   *
   * Evidence only ever ADDS confirmation; it never withdraws one the driver already gave. And the
   * relaxation that was refuted stays refuted: `cancel()` alone leaves the bytes ON DISK (measured),
   * so it satisfies neither proof — the disposal it did not perform cannot be evidenced by a file
   * that is still there, and a missing `delete()` is a failed confirmation under the first.
   *
   * The timer that SPENDS that budget is therefore armed here too, at the claim, before the first
   * caller-supplied property is read. `cancel()`/`delete()` are untrusted code invoked synchronously
   * from this frame, so a driver can advance the injected clock through the whole budget before it
   * returns: arming afterwards left the disposal unbounded across exactly the window the bound exists
   * for, and then scheduled expiry a full budget past an instant already gone.
   */
  #startCleanup(): void {
    const download = this.#download;
    if (this.#cleanup !== "idle" || !download) return;
    this.#cleanup = "running";
    this.#download = undefined;
    // One-shot: whichever lands first — the budget timer, or both confirmations — decides, and the
    // other is inert. A confirmation that beats the timer clears it; an expiry that beats the driver
    // leaves a settlement it can no longer heal, release or reuse an identity with.
    let settled = false;
    let timer: unknown;
    const settle = (confirmed: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) { this.#scheduler.clearTimeout(timer); timer = undefined; }
      this.#finishCleanup(confirmed);
    };
    // The driver's own answer first, then the bytes. Consulted on the EXPIRY path too: a `delete()`
    // whose promise never settles has still removed the file, and a budget that ignored that would
    // poison the runtime over a disposal it can see succeeded.
    const confirm = (reported: boolean): void => settle(reported || this.#stagedBytesGone());
    timer = this.#scheduler.setTimeout(() => { timer = undefined; confirm(false); }, CLEANUP_CONFIRM_BUDGET_MS);
    const attempts: Array<Promise<boolean>> = [];
    for (const method of ["cancel", "delete"] as const) {
      let fn: unknown;
      try {
        fn = download[method];
      } catch {
        // Reading the property is as untrusted as calling it: a getter that throws must not escape
        // this synchronous transition (`invalidate()` is called directly by the deadline timer, where
        // a throw becomes an uncaught exception), and must not skip the NEXT operation. It is also not
        // "not offered" — the operation exists and could not even be reached, so it counts as an
        // attempt that failed, which is what keeps the cleanup unconfirmed.
        attempts.push(Promise.resolve(false));
        continue;
      }
      // DownloadLike permits an implementation to omit either capability, but omission cannot prove
      // the driver's bytes are gone. Amendment 7 requires both closed operations to be invoked and
      // confirmed; a missing or non-callable member is therefore one failed confirmation.
      if (typeof fn !== "function") { attempts.push(Promise.resolve(false)); continue; }
      // `Reflect.apply` reads NO property of the callable. `call` is as caller-controlled as any
      // other property of a driver-supplied function: reading it to invoke through it handed the
      // driver a getter it could throw from, and lost the mandatory invocation the throw prevented.
      // The receiver stays the download, which is what a driver's own method expects.
      attempts.push(invokeDisposal(() => Reflect.apply(fn as () => Promise<void> | void, download, [])));
    }
    // Promise settlement is still guarded by the same one-shot. A hung driver promise retains this
    // operation through `settle`, exactly as the previous call-site `.then(... this.#finishCleanup)`
    // did; the timer makes that retention bounded in authority even though the promise may stay live.
    void Promise.all(attempts).then((results) => confirm(results.every(Boolean)), () => confirm(false));
  }

  /**
   * FILESYSTEM EVIDENCE: is the driver's staged copy gone?
   *
   * A fact about the bytes, not about the driver's promise plumbing — which is the whole point, since
   * the two disposal promises cannot both succeed. Deliberately conservative in every uncertain
   * direction: an unrecorded path, or a stat that throws, is NO evidence rather than good news, so it
   * leaves the decision entirely to the driver's own reported confirmations.
   *
   * `#stagedPath` is only ever set for a path that EXISTED when the staging job read it, so a `false`
   * here is a positive cut — present, then gone — and never the vacuous absence of a file that was
   * never written.
   */
  #stagedBytesGone(): boolean {
    const staged = this.#stagedPath;
    if (staged === undefined) return false;
    try {
      return !existsSync(staged);
    } catch {
      return false;
    }
  }

  /** Land the cleanup record. Confirmed cleanup can release the identity; unconfirmed retains it for
   *  good and poisons the runtime, without ever rewriting the operation's own terminal reason. */
  #finishCleanup(confirmed: boolean): void {
    if (this.#cleanup !== "running") return;
    this.#cleanup = confirmed ? "confirmed" : "failed";
    if (confirmed) { this.#tryRelease(); return; }
    this.#cleanupUnconfirmed = true;
    try { this.#onCleanupUnconfirmed?.(); } catch {}
  }

  /**
   * Commit this operation's outcome. Async because it awaits the staging it started; the commitment
   * itself is a synchronous transition rechecked under the same authority `invalidate()` uses, so an
   * invalidation that lands while the jobs are settling still wins.
   */
  async seal(): Promise<OperationResult> {
    if (this.#state.name === "committed") return this.#state.result;
    // Already terminal: the outcome is decided, so do NOT wait on staging. This is what keeps a
    // teardown that invalidated first from queueing behind a capture that may never finish.
    if (this.#state.name === "invalidated") return this.#invalidatedResult(this.#state.reason);
    // The first synchronous seal()/invalidate() fixes the ONE deadline, and arms it against the waits
    // that already exist — this is what stops an accessor that never settles from blocking the barrier
    // below forever. JavaScript call ordering is the linearization authority: a later call observes
    // this exact instant rather than starting a second budget.
    this.#openDeadline();
    this.#armDeadline();
    this.#state = { name: "sealing" };
    await Promise.allSettled(Array.from(this.#jobs));
    // Test seam: the exact window between "jobs settled" and "result committed".
    if (this.#beforeCommit) {
      try {
        await this.#beforeCommit();
      } catch {
        // Amendment 5 §2: any exception before commitment atomically invalidates with a closed internal
        // code. Swallowing it and then committing would publish an artifact whose commitment step
        // demonstrably failed. The raw exception never crosses the seam.
        this.invalidate("artifact-write-failed");
        return this.#invalidatedResult("artifact-write-failed");
      }
    }
    // Synchronous authority recheck, immediately before commitment. Read through a widened local:
    // the state can legitimately have changed during the awaits above, which narrowing cannot know.
    const current = this.#state as { name: string; reason?: ArtifactFailureCode };
    if (current.name === "invalidated") return this.#invalidatedResult(current.reason!);
    if (this.#provisional) {
      // Task 2 §3.2: the safe projection is constructed HERE, at the successful seal, while this
      // operation still owns both the trusted canonical host and the private committed record. An
      // instant the injected clock made unrenderable is a malformed configuration, and an artifact
      // this stack cannot describe must not stay retrievable — `invalidate()` discards the staged
      // record on its way out, exactly as every other pre-commitment failure does.
      const metadata = projectMetadata(this.#provisional, this.sourceHost);
      if (!metadata) { this.invalidate("artifact-config-invalid"); return this.#invalidatedResult("artifact-config-invalid"); }
      return this.#commit({ outcome: "available", artifact: metadata });
    }
    const essence = ((this.#contentType ?? "").trim().toLowerCase().split(";", 1)[0] ?? "").trim();
    if (this.#events === 0 && this.#status === 200 && essence === "application/pdf") {
      return this.#commit({ outcome: "inline-pdf-unsupported", failure: "inline-pdf-unsupported" });
    }
    return this.#commit({ outcome: "none" });
  }

  /**
   * The result an INVALIDATED generation reports. Deliberately NOT a commitment: `invalidated` is
   * already terminal, and only `sealing -> committed` is a legal transition. Sealing merely observes
   * it, so no state changes and no commitment/release logic runs — however many times it is called.
   */
  #invalidatedResult(reason: ArtifactFailureCode): OperationResult {
    return { outcome: "capture-failed", failure: this.#cleanupFailed ? "artifact-cleanup-failed" : reason };
  }

  #commit(result: OperationResult): OperationResult {
    if (this.#state.name === "committed") return this.#state.result;
    this.#state = { name: "committed", result };
    // Task 2 §6: the owner ledger is populated ONLY by the successful commit, and only from inside
    // the legal `sealing -> committed` transition — so nothing provisional, invalidated or merely
    // staged is ever retrievable, and the entry is bound to this operation's reservation token.
    if (result.outcome === "available") { try { this.#publishOwner?.(result.artifact); } catch {} }
    // Committed is terminal, so the ONE settlement deadline is over — dropped HERE, before any
    // untrusted callback or the result itself becomes observable. The staging job's `finally` already
    // asked, but it runs while the state is still `sealing`, which is deliberately not terminal, so
    // it correctly left the timer armed for exactly this transition. Nothing asked again, and a
    // perfectly successful capture left a live timer in the injected domain that only the operation
    // could reach: `close()` cancels the STORE's timers. By here the jobs have settled and `#active`
    // is zero, so this is the same guarded clear every other terminal path uses.
    this.#clearDeadline();
    // @internal test seam: fires ONLY on the legal `sealing -> committed` transition.
    try { this.#onCommitted?.(); } catch {}
    // An available artifact stays reserved until the store durably discards it (the runtime clears the
    // reservation from its own onDiscard hook); every other outcome frees the ID now.
    this.#waitingForArtifact = result.outcome === "available";
    this.#tryRelease();
    return result;
  }

  /**
   * Retire this operation with an exact closed reason. SYNCHRONOUS and idempotent — the first reason
   * stands, and a committed result is left untouched so an already-returnable artifact survives
   * ordinary teardown.
   *
   * The parameter is typed, but types are erased: a JavaScript caller can pass a path, a URL, a
   * bearer-like string or a hostile object, and the value is stored as the reason and returned by
   * `seal()`. So the FIRST instruction is the terminal check — an already-decided operation returns
   * without reading, coercing or stringifying the supplied value at all — and the second is a
   * side-effect-free membership check against the closed vocabulary, BEFORE any state write,
   * callback, cleanup or result construction.
   */
  invalidate(reason: ArtifactFailureCode): void {
    if (this.#state.name === "committed" || this.#state.name === "invalidated") return;
    const code: ArtifactFailureCode = CLOSED_REASONS.has(reason) ? reason : "artifact-config-invalid";
    this.#openDeadline();
    this.#state = { name: "invalidated", reason: code };
    // Synchronously, in this order: stop the untrusted accessors from governing this operation, then
    // take disposal ownership of the driver's copy. Both happen before the result is observable, so a
    // caller that seals immediately afterwards is never queued behind a promise that may never settle.
    this.#wake?.();
    this.#startCleanup();
    this.#discardStaged();
    this.#clearDeadline();
    this.#tryRelease();
    // @internal test seam: fires synchronously, at the instant the generation became terminal.
    try { this.#onTerminal?.(this.#cleanupFailed ? "artifact-cleanup-failed" : code); } catch {}
  }

  /**
   * Discard whatever this operation staged, and classify the store's answer EXACTLY.
   *
   * The two negative answers demand opposite handling, which is why the detailed method exists.
   * `failed` means durable deletion is unproven: the outcome becomes a cleanup failure and the
   * identity is retained for good.
   *
   * `refused` means the deletion belongs to SOMEBODY ELSE — and which somebody is not knowable from
   * the result (Amendment 7 §5.1). A closing store owns it; so does the response lease of a record
   * that reached `consuming` between publication and commitment, which is reachable in the narrow
   * pre-commit window where a response acquires a provisional artifact this operation has not
   * committed yet. Either way the bytes are still there, the terminal reason stands, and this
   * operation owns no filesystem retry: it establishes the artifact wait — physical cleanup is
   * pending, elsewhere — and latches the refusal until its actual owner reports. Inferring "store
   * close" from the refusal alone stranded the identity of every operation whose provisional record a
   * response had already acquired: no store close was coming to answer a latch it never took.
   */
  #discardStaged(): void {
    this.#provisional = undefined;
    const result = this.#store.discardArtifactDetailed(this.artifactId);
    if (result === "failed") { this.#cleanupFailed = true; return; }
    if (result !== "refused") return;
    // A close result that has ALREADY arrived answers a refusal the store could only have made
    // because it was closing, and nothing further is owed: that close has finished accounting for
    // every artifact it owned, so no notification is coming for this one.
    if (this.#storeClose.settled) { if (this.#storeClose.failed) this.#cleanupFailed = true; return; }
    this.#waitingForArtifact = true;
    this.#refusalPending = true;
  }

  /**
   * The store proved this operation's artifact is durably gone.
   *
   * Before commitment, that deletion revokes the provisional result: leaving the operation open would
   * let a later seal publish `available` for bytes the store has already removed. Terminalize it as the
   * exact lifecycle race it is. After an `available` commitment, deletion merely clears ONE release
   * condition. Neither branch releases directly; {@link #tryRelease} still checks every condition.
   *
   * A CLOSE-OWNED deletion is not proof of a clean close. It is one step INSIDE a close whose result
   * does not exist yet, and that close can still fail after it — at the data-directory fsync, at the
   * teardown, at the lock. Treating it as the last release condition freed a committed identity from
   * inside a close that then returned `artifact-cleanup-failed`, which Amendment 7 §5.2 forbids: a
   * failed close records cleanup failure and retains the ID permanently. So the physical-artifact wait
   * is cleared and the ONE store-close result is waited on in its place.
   *
   * An ORDINARY deletion has no such second act. Whoever ran it — a response lease's `complete()`, its
   * exact 15-second timeout, or a public discard — proved durable deletion on its own authority, so it
   * resolves both the wait and any refusal this operation latched while that owner held the record.
   */
  #noteArtifactDiscarded(closeOwned: boolean): void {
    if (this.#state.name === "open" || this.#state.name === "sealing") {
      this.#provisional = undefined;
      // A close-owned deletion retires this operation with the close-specific reason: runtime close
      // normally invalidates open operations before it asks the store to close, but the inverse
      // ordering is also legal, and seal must not publish bytes the close sweep already removed. An
      // ordinary one is the lifecycle race it looks like.
      this.invalidate(closeOwned ? "artifact-runtime-invalidated" : "download-lifecycle-race");
      // FALL THROUGH, deliberately. That invalidation re-entered #discardStaged(), which — the store
      // being fenced by its own close, or the record being held by a lease — can have been REFUSED and
      // left an artifact wait behind. This notification is precisely the proof that wait exists for:
      // the deletion it announces has already happened. Returning here instead left the wait standing
      // with no second notification coming, and the identity reserved for good.
    } else if (!this.#waitingForArtifact) return;
    this.#waitingForArtifact = false;
    if (closeOwned) {
      // Latched, because the one close result can arrive on either side of this notification.
      if (this.#storeClose.settled) { if (this.#storeClose.failed) this.#cleanupFailed = true; }
      else this.#refusalPending = true;
    } else {
      // The owner reported. This is the resolution of a `consuming` refusal — the lease's completion
      // or its exact 15-second timeout — and it cannot be cancelling a latch a store close still owes,
      // because the store emits no ordinary discard notification once close has been requested.
      this.#refusalPending = false;
    }
    this.#tryRelease();
  }

  /** The one store-close result. A clean close proves every store-owned artifact is gone — including a
   *  refusal for an ID that never had a record and therefore emitted no discard notification. A failed
   *  close is a cleanup failure this operation inherits permanently. */
  #settleStoreClose(failed: boolean): void {
    this.#storeClose = { settled: true, failed };
    if (!this.#refusalPending) return;
    this.#refusalPending = false;
    if (failed) this.#cleanupFailed = true;
    else this.#waitingForArtifact = false;
    this.#tryRelease();
  }

  /**
   * The SOLE logical-ID release linearization point (Amendment 7 §5.2). Every condition must hold:
   * the generation is terminal, no staging continuation is still running, cleanup actually succeeded
   * (a failed discard must retain the reservation so the ID can never be reused), no committed
   * artifact is still awaiting its durable discard, and no refused discard is still unresolved.
   *
   * For a refused discard, whichever arrives second — operation quiescence, or the resolution from
   * whoever actually owned the deletion (a lease-owned notification, or the clean store-close result)
   * — reaches here and is the release point.
   */
  #tryRelease(): void {
    if (this.#released) return;
    if (this.#state.name === "open" || this.#state.name === "sealing") return;
    if (this.#active > 0 || this.#cleanupFailed || this.#waitingForArtifact || this.#refusalPending) return;
    // Driver disposal is the same kind of condition: while it is still running we cannot say the
    // driver's bytes are gone, and once it has FAILED we never can — so the identity is retained for
    // good rather than handed to a replacement operation that would reuse it.
    if (this.#cleanup === "running" || this.#cleanupUnconfirmed) return;
    this.#released = true;
    this.#release();
    // @internal test seam: the exact boundary "continuation cleanup completed and the ID was freed".
    try { this.#onReleased?.(); } catch {}
  }

}

export class ArtifactRuntime {
  readonly #store: ArtifactStore;
  readonly #scheduler: ArtifactScheduler;
  readonly #idGenerator: () => string;
  readonly #reserved = new Map<string, symbol>();
  readonly #operations = new Map<symbol, ArtifactOperation>();
  /**
   * The private owner ledger (Task 2 §6). It is the ONLY authority retrieval is authorized from: the
   * store knows the owning `consumerId` and nothing about drive lineage, and the public metadata
   * deliberately carries neither.
   *
   * Populated only by the successful operation commit callback, and removed only by that same
   * operation's token-bound release — which Task 1 already gates on durable discard — so a stale or
   * duplicated notification cannot delete a replacement's entry, and an ID cannot be authorized
   * after the artifact behind it is gone.
   */
  readonly #artifactOwners = new Map<string, { token: symbol; owner: ArtifactOwner; metadata: ArtifactMetadata }>();
  /**
   * Drive lineage (Task 2 §6). Consumer and controller stay SEPARATE primitive keys in a nested map:
   * concatenating them into one string key would make `a|b` and `ab|` collide, and a serialized
   * composite is exactly the sort of value that ends up in a log line.
   */
  readonly #controllerState = new Map<string, Map<string, "active" | "invalidated">>();
  /** Retrieval attempt instants per consumer, in the injected domain (Amendment 2 §3). Bounded to
   *  {@link MAX_RETRIEVALS_PER_WINDOW} entries by construction: once the window is full the attempt
   *  is refused WITHOUT being recorded, so a flood cannot grow this and the window still slides from
   *  the thirty attempts actually admitted. */
  readonly #retrievals = new Map<string, number[]>();
  #closed = false;
  /** STICKY capture poison, owned by the runtime (never the browser core): set when an operation
   *  could not confirm disposal of its attributed download. It rejects every LATER createOperation
   *  with exactly `artifact-cleanup-failed`, while already committed artifacts stay retrievable and
   *  every unsafe identity stays reserved. */
  #cleanupPoisoned = false;
  #closePromise?: Promise<ArtifactFailureCode | undefined>;
  readonly #beforeCommit?: () => void | Promise<void>;
  readonly #onTerminal?: (reason: ArtifactFailureCode) => void;
  readonly #onReleased?: () => void;
  readonly #onCommitted?: () => void;
  constructor(untrustedOptions: ArtifactStoreOptions) {
    // The SAME sanitizing boundary the store uses, applied here too, because this constructor is a
    // public JavaScript entry point of its own: `new ArtifactRuntime(undefined | null | proxy)` used
    // to escape as a raw Node `TypeError [ERR_INVALID_ARG_TYPE]`, or as whatever text a hostile getter
    // chose to throw. Everything below reads the frozen, validated result — never the caller's object.
    const options = canonicalizeStoreOptions(untrustedOptions);
    // Snapshotted here, not read at notification time: re-reading `options.onDiscard` when a discard
    // happened let a stateful getter swap which function received it, long after construction.
    const notifyDiscard = options.onDiscard;
    // Spreading the CANONICAL object is not the untrusted spread this replaced: every caller-supplied
    // property has already been read exactly once and validated, so the store re-reads plain data.
    this.#store = new ArtifactStore({ ...options, onDiscard: (id, closeOwned) => {
      // ArtifactStore invokes onDiscard synchronously after durable deletion, before a replacement can
      // be created. It NOTIFIES the token-bound operation and never deletes the reservation itself:
      // durable deletion clears one of that operation's release conditions, and the operation is the
      // only thing that knows whether the others hold. Deleting here freed identities out from under
      // operations that were still open or still running a continuation.
      const token = this.#reserved.get(id);
      if (token !== undefined) {
        const operation = this.#operations.get(token);
        if (operation) notifyArtifactDiscarded(operation, closeOwned);
        // No direct-delete fallback. A missing operation can mean cleanup poisoning deliberately
        // detached it while retaining its unsafe identity. Only that operation's token-checked
        // #tryRelease path may delete a reservation; absence is not proof that release is safe.
      }
      try { notifyDiscard?.(id, closeOwned); } catch {}
    } });
    // ONE time domain for the whole subsystem: operation deadlines share the store's injected
    // scheduler and never mix ambient Date.now()/setTimeout into a settlement bound.
    this.#scheduler = options.scheduler ?? SYSTEM_SCHEDULER;
    this.#idGenerator = options.idGenerator ?? (() => randomBytes(16).toString("base64url"));
    this.#beforeCommit = options.beforeCommit;
    this.#onTerminal = options.onOperationTerminal;
    this.#onReleased = options.onOperationReleased;
    this.#onCommitted = options.onOperationCommitted;
  }
  createOperation(input: { owner: ArtifactOwner; sourceHost: string; artifactId?: string }): ArtifactOperation {
    if (this.#closed) throw new ArtifactStoreError("artifact-runtime-invalidated");
    // Unconfirmed driver disposal means this session's download bytes are unaccounted for. No NEW
    // capture may start on it; retrieval of what was already committed is deliberately untouched.
    if (this.#cleanupPoisoned) throw new ArtifactStoreError("artifact-cleanup-failed");
    if (!input || typeof input !== "object") throw new ArtifactStoreError("artifact-config-invalid");
    let owner: unknown, sourceHost: unknown, suppliedId: unknown;
    try {
      // One synchronous snapshot of the untrusted input. A getter/proxy may throw or mutate between
      // reads; neither its exception nor a second value is allowed to cross this boundary.
      owner = input.owner;
      sourceHost = input.sourceHost;
      suppliedId = input.artifactId;
    } catch {
      throw new ArtifactStoreError("artifact-config-invalid");
    }
    // Exact closed scope set, exact controller shape, then a FROZEN CANONICAL SNAPSHOT. The caller
    // keeps its own object and may mutate it afterwards; the operation must never read that state
    // again, or a mutation landing mid-staging could divert an artifact to a different owner.
    const canonicalOwner = canonicalizeOwner(owner as ArtifactOwner | undefined);
    // Task 2 §6, "operation create": a drive generation requires an ACTIVE lineage. Checked here on
    // the canonical snapshot, and again below with the other two fences, because everything between
    // is caller-controlled code that can dispose this very lineage while the frame is still deciding.
    if (this.#invalidLineage(canonicalOwner)) throw new ArtifactStoreError("artifact-runtime-invalidated");
    if (typeof sourceHost !== "string") throw new ArtifactStoreError("artifact-config-invalid");
    let host: string;
    try { host = canonicalizeHost(sourceHost); } catch { throw new ArtifactStoreError("artifact-config-invalid"); }
    if (!HOST.test(host) || isIP(canonicalizeHostForIp(host)) !== 0 || /[\u0000-\u001f\u007f]/.test(sourceHost)) throw new ArtifactStoreError("artifact-config-invalid");
    let id: string | undefined;
    if (suppliedId !== undefined) {
      if (typeof suppliedId !== "string") throw new ArtifactStoreError("invalid-artifact-id");
      id = suppliedId;
    }
    if (id !== undefined) { if (!ARTIFACT_ID.test(id)) throw new ArtifactStoreError("invalid-artifact-id"); if (this.#reserved.has(id)) throw new ArtifactStoreError("artifact-capacity"); }
    else for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
      let candidate: unknown;
      try { candidate = this.#idGenerator(); } catch { throw new ArtifactStoreError("artifact-config-invalid"); }
      if (typeof candidate !== "string") throw new ArtifactStoreError("artifact-config-invalid");
      if (ARTIFACT_ID.test(candidate) && !this.#reserved.has(candidate)) { id = candidate; break; }
    }
    if (!id) throw new ArtifactStoreError("artifact-capacity");
    // The SAME two fences as on entry, rechecked after every caller-controlled read above and
    // immediately before the reservation is published. Everything between them is untrusted code —
    // the input snapshot's getters, the nested owner properties, and an injected `idGenerator` — and
    // any of it may re-enter and close or poison this runtime while this frame is still deciding.
    // Checked only on entry, the frame went on to reserve an identity and hand back a live operation
    // for a runtime whose close had already invalidated every operation it knew about and settled
    // every artifact it owned (Amendment 7 §5.2 step 1: rejected permanently from that instant).
    // Rechecked HERE, nothing has been reserved yet, so a refusal also leaks nothing.
    if (this.#closed) throw new ArtifactStoreError("artifact-runtime-invalidated");
    if (this.#cleanupPoisoned) throw new ArtifactStoreError("artifact-cleanup-failed");
    if (this.#invalidLineage(canonicalOwner)) throw new ArtifactStoreError("artifact-runtime-invalidated");
    const token = Symbol(id);
    this.#reserved.set(id, token);
    // Task 2 §6, "operation create": a drive generation establishes its lineage. First use activates
    // it; an entry that already exists is never overwritten, so a lineage that has been invalidated
    // stays invalidated and no later operation can quietly revive it.
    if (canonicalOwner.scope === "drive") {
      let lineage = this.#controllerState.get(canonicalOwner.consumerId);
      if (!lineage) { lineage = new Map(); this.#controllerState.set(canonicalOwner.consumerId, lineage); }
      if (!lineage.has(canonicalOwner.controllerId)) lineage.set(canonicalOwner.controllerId, "active");
    }
    const operation = new ArtifactOperation(
      this.#store, canonicalOwner, host, id,
      () => {
        if (this.#reserved.get(id!) === token) this.#reserved.delete(id!);
        // TOKEN-BOUND, exactly like the reservation above: release happens only once Task 1 has
        // proved the artifact durably discarded, and only the operation that published the entry may
        // remove it. A stale operation releasing late cannot revoke a replacement's authorization.
        if (this.#artifactOwners.get(id!)?.token === token) this.#artifactOwners.delete(id!);
        this.#operations.delete(token);
      },
      this.#scheduler, this.#beforeCommit, this.#onTerminal, this.#onReleased, this.#onCommitted,
      () => {
        // Poison is the RUNTIME's transition, not the operation's: drop the operation (and with it any
        // reference to the hung driver object) from the live map, but KEEP its identity reserved so the
        // unsafe ID can never be reused, and refuse every later capture.
        this.#cleanupPoisoned = true;
        this.#operations.delete(token);
      },
      (metadata) => { this.#artifactOwners.set(id!, { token, owner: canonicalOwner, metadata }); },
    );
    this.#operations.set(token, operation);
    return operation;
  }

  /**
   * Spend one retrieval attempt from this consumer's rolling-minute budget (Amendment 2 §3).
   *
   * ATTEMPTS are what the budget counts, not successes: a sweep of unknown IDs is exactly what the
   * limit exists to bound, and each of those is denied before it reaches a lookup. Answering `true`
   * means the attempt is refused, and a refused attempt is deliberately NOT recorded — so the array
   * cannot grow past the limit and the window keeps sliding off the thirty instants actually
   * admitted rather than being extended by the flood it is refusing.
   */
  #spendRetrieval(consumerId: string): boolean {
    const now = this.#scheduler.now();
    const cutoff = now - RETRIEVAL_WINDOW_MS;
    let attempts = this.#retrievals.get(consumerId);
    if (attempts) {
      // Rolling, not a fixed bucket: an instant leaves the window exactly one minute after it was
      // spent. Bounded work — the array can never hold more than the limit.
      while (attempts.length > 0 && attempts[0]! <= cutoff) attempts.shift();
      if (attempts.length === 0) { this.#retrievals.delete(consumerId); attempts = undefined; }
    }
    if (attempts && attempts.length >= MAX_RETRIEVALS_PER_WINDOW) return true;
    if (attempts) attempts.push(now);
    else this.#retrievals.set(consumerId, [now]);
    return false;
  }

  /** Whether this owner names a lineage that has already been fenced. Consumer-scoped owners have
   *  no lineage at all: a transient artifact binds to its consumer and outlives every controller. */
  #invalidLineage(owner: ArtifactOwner): boolean {
    return owner.scope === "drive" && this.#controllerState.get(owner.consumerId)?.get(owner.controllerId) === "invalidated";
  }

  /**
   * Fence one drive lineage (Amendment 4 §4).
   *
   * SYNCHRONOUS and total, because every graph-disposal path must call it BEFORE its first await:
   * a DELETE, an idle reap or a close-all that awaited a browser close first left a window in which
   * an already-open generation could still publish and a retrieval for the disposed lineage was
   * still authorized. It therefore invalidates every open/sealing generation of that lineage,
   * refuses every later drive operation on it, and revokes retrieval for its committed artifacts —
   * without deleting anything, which is `discardController`'s separate job.
   *
   * It never throws. A disposal path cannot handle an exception from its own fence, and a malformed
   * identity names no lineage that could ever have been created: `canonicalizeOwner` rejects a
   * non-string or empty controller at creation, so there is nothing to fence and nothing to bypass.
   *
   * Amendment 4 calls this allocation-free. The one deliberate exception is the bounded snapshot
   * below: `invalidate()` reaches the injected scheduler, the store's discard and an
   * `onOperationTerminal` observer, any of which may create or retire operations re-entrantly, and
   * iterating the live map while that happens is not a bound this method can state.
   */
  invalidateController(input: { consumerId: string; controllerId: string }): void {
    if (!input || typeof input !== "object") return;
    let consumerId: unknown, controllerId: unknown;
    try { consumerId = input.consumerId; controllerId = input.controllerId; } catch { return; }
    if (typeof consumerId !== "string" || consumerId.length === 0) return;
    if (typeof controllerId !== "string" || controllerId.length === 0) return;
    let lineage = this.#controllerState.get(consumerId);
    if (!lineage) { lineage = new Map(); this.#controllerState.set(consumerId, lineage); }
    // Recorded FIRST, so a generation retired below — and anything its observers do re-entrantly —
    // already sees a lineage that can never be revived.
    lineage.set(controllerId, "invalidated");
    const doomed: ArtifactOperation[] = [];
    for (const operation of this.#operations.values()) {
      const owner = operation.owner;
      if (owner.scope === "drive" && owner.consumerId === consumerId && owner.controllerId === controllerId) doomed.push(operation);
    }
    // Each generation is retired on its OWN account: `invalidate()` is designed to be total, but it
    // reaches caller code, and a throw from one must not skip the generations behind it.
    for (const operation of doomed) { try { disposeForRuntime(operation); } catch {} }
  }

  /**
   * Discard one drive lineage and report the CLOSED internal result (Task 2 §6, Amendment 7 §5.1).
   *
   * The lineage is fenced synchronously first — this call IS a disposal path — and then every
   * committed artifact it owns is discarded. All attempts run even when one of them fails, because a
   * teardown that stops at the first failure leaves the rest of the lineage on disk.
   *
   * The three results are not interchangeable:
   *
   *  - `clean`   — every artifact of the lineage was durably deleted, or there were none.
   *  - `refused` — at least one record is `consuming`, and its active response lease exclusively owns
   *    resolution (Amendment 2 §5). Deliberately NOT reported as clean: nothing was deleted, and only
   *    that lease's completion or its exact 15-second timeout may resolve it.
   *  - `failed`  — durable deletion could not be proven. The runtime is poisoned, so later capture is
   *    rejected with `artifact-cleanup-failed` and every unsafe identity stays reserved.
   *
   * Consumer-scoped artifacts are untouched: they bind to the consumer alone and outlive every
   * controller lineage (Task 1 invariant 10).
   */
  async discardController(input: { consumerId: string; controllerId: string }): Promise<ArtifactDiscardResult> {
    // The fence belongs to this call and lands BEFORE its first await, so no generation can publish
    // into a lineage that is being torn down. It is total and validates the identities itself.
    this.invalidateController(input);
    if (!input || typeof input !== "object") return "clean";
    let consumerId: unknown, controllerId: unknown;
    try { consumerId = input.consumerId; controllerId = input.controllerId; } catch { return "clean"; }
    if (typeof consumerId !== "string" || consumerId.length === 0) return "clean";
    if (typeof controllerId !== "string" || controllerId.length === 0) return "clean";
    // Snapshotted before the first discard: a durable deletion notifies its operation, which releases
    // its reservation and its ledger entry, so the map is mutated from underneath this loop.
    const doomed: string[] = [];
    for (const [artifactId, entry] of this.#artifactOwners) {
      const owner = entry.owner;
      if (owner.scope === "drive" && owner.consumerId === consumerId && owner.controllerId === controllerId) doomed.push(artifactId);
    }
    let refused = false, failed = false;
    for (const artifactId of doomed) {
      // Each artifact on its OWN account: the discard reaches the store's identity proof, its
      // filesystem authority and an `onDiscard` observer, and a throw from one must not skip the
      // rest of the lineage. An exception is exactly what `failed` means — deletion unproven.
      let result: ArtifactDiscardResult;
      try { result = this.#store.discardArtifactDetailed(artifactId); } catch { result = "failed"; }
      if (result === "failed") failed = true;
      else if (result === "refused") refused = true;
    }
    // Poison is the RUNTIME's transition, exactly as it is for unconfirmed driver disposal: later
    // capture is refused and every unsafe identity stays reserved, while what is already committed
    // and provably intact stays retrievable.
    if (failed) this.#cleanupPoisoned = true;
    // No separate "this lineage failed once" ledger: a failed deletion has already poisoned the
    // STORE, and the artifact it could not delete keeps its ledger entry (no `onDiscard` ran, so no
    // operation released it). A repeated disposal therefore re-finds that artifact and re-derives
    // `failed` from the store itself, instead of from a second, drifting record of the same fact —
    // and the two identities are never concatenated into one composite key to hold it.
    return failed ? "failed" : refused ? "refused" : "clean";
  }

  /**
   * The ONE clock this subsystem decides from, published so a transport tracker can compute its own
   * remaining budget as `lease.deadlineMs - runtime.now()` without the lease growing a `now()` of its
   * own — and without any caller mixing in ambient `Date.now()`, which is a different domain whenever
   * a scheduler is injected. Read-only: it exposes no timer, no authority and no state.
   */
  now(): number { return this.#scheduler.now(); }

  /**
   * Acquire one artifact into an authoritative response lease (Amendment 4 §1, Task 2 §4.1).
   *
   * Authorization is decided HERE, from the private owner ledger, before the store is touched at all:
   * consumer artifacts require the exact consumer identity, drive artifacts require the exact
   * consumer AND controller identity on a lineage that has not been invalidated. The store knows only
   * the owning consumer, so drive lineage could never have been enforced down there.
   *
   * Every denial — malformed input, invalid grammar, unknown, foreign, wrong lineage, invalidated
   * lineage, expired, consumed, concurrent — rejects with a CLOSED `ArtifactStoreError`. The codes
   * differ so the audit surface can say which (Task 2 §7, Amendment 2 §3); the MCP seam above collapses
   * all of them to one fixed external result, so none of them is an oracle.
   *
   * An invalid-grammar ID never reaches the store, so it performs no lookup, no path derivation and
   * no filesystem call at all.
   */
  async acquireResponseLease(input: { artifactId: string; consumerId: string; controllerId?: string }): Promise<ArtifactResponseLease> {
    const unavailable = (code: ArtifactFailureCode) => new ArtifactStoreError(code);
    if (!input || typeof input !== "object") throw unavailable("artifact-not-found");
    let artifactId: unknown, consumerId: unknown, controllerId: unknown;
    try {
      // One synchronous snapshot of caller-controlled properties, exactly as every other public
      // entry point in this module does: a getter may throw or answer differently on a second read,
      // and neither may govern an authorization decision.
      artifactId = input.artifactId;
      consumerId = input.consumerId;
      controllerId = input.controllerId;
    } catch {
      throw unavailable("artifact-not-found");
    }
    if (typeof consumerId !== "string" || consumerId.length === 0) throw unavailable("artifact-not-found");
    // Spent BEFORE the grammar check and the ledger lookup: the budget bounds attempts, and a sweep
    // of malformed or unknown IDs is precisely the attempt it exists to bound.
    if (this.#spendRetrieval(consumerId)) throw unavailable("artifact-rate-limited");
    // The closed grammar, BEFORE any lookup or path derivation (Task 2 §7). A well-typed traversal,
    // Unicode or overlong string is denied here, having touched neither the ledger nor the store.
    if (typeof artifactId !== "string" || !ARTIFACT_ID.test(artifactId)) throw unavailable("artifact-not-found");
    const entry = this.#artifactOwners.get(artifactId);
    if (!entry) throw unavailable("artifact-not-found");
    if (entry.owner.consumerId !== consumerId) throw unavailable("artifact-owner-mismatch");
    if (entry.owner.scope === "drive") {
      if (typeof controllerId !== "string" || controllerId !== entry.owner.controllerId) throw unavailable("artifact-owner-mismatch");
      if (this.#controllerState.get(consumerId)?.get(controllerId) !== "active") throw unavailable("artifact-owner-mismatch");
    }
    // Expiry, the transition out of `available`, the identity re-proof, the read, the hash and the
    // ONE encoding are all Task 1's, under Task 1's single global permit: this layer adds no second
    // expiry rule and no second encoding. A `null` is every remaining reason at once — expired,
    // already consuming, consumed, unhealthy or closing — and is deliberately indistinguishable.
    let raw;
    try {
      raw = await this.#store.acquire(artifactId, consumerId);
    } catch {
      throw unavailable("artifact-not-found");
    }
    if (!raw) throw unavailable("artifact-not-found");
    // IMMEDIATELY, before this lease is wrapped or returned to anything: hand the deadline off. From
    // this instant the store's own internal timer can never again independently release the permit
    // or discard the artifact — that authority now belongs exclusively to this runtime and, later,
    // to whoever the public lease is registered with (Amendment 4 §1/§2, plan §4.1).
    raw.claimTimeout();
    return makeResponseLease(raw, entry.metadata);
  }
  /**
   * Close, in exactly the order Amendment 7 §5.2 fixes:
   *
   *  1. raise the `closed` fence synchronously — `createOperation()` is permanently rejected from
   *     this instant, so no replacement can claim an identity the steps below are still resolving;
   *  2. invalidate every tracked operation;
   *  3. request store close and await its ONE result — the store owns physical deletion and never
   *     waits on an operation callback to proceed;
   *  4. resolve every operation whose discard the store refused, with that same result.
   *
   * The ONE close promise is PUBLISHED FIRST, ahead of step 1 — before the fence, before a single
   * generation is invalidated and before the store is asked for anything. Every step below hands
   * control to caller code: `disposeForRuntime()` runs `invalidate()`, which reaches
   * `onOperationTerminal`, `onOperationReleased` and the store's `onDiscard`; the store close sweeps
   * its records and announces each deletion through `onDiscard` again. An observer that closes the
   * runtime from one of those notifications is the ordinary shape, not an attack — the store fixed
   * exactly this defect in its own `close()`. Assigning `#closePromise` from `#store.close().then(...)`
   * left it undefined across that entire window, so a re-entrant caller raised the fence a second
   * time, invalidated a second time and was handed a DIFFERENT promise over the same one close.
   * Latching first makes every caller — re-entrant, concurrent or later — an awaiter of the one
   * promise the one close settles exactly once.
   */
  close(): Promise<ArtifactFailureCode | undefined> {
    if (this.#closePromise) return this.#closePromise;
    let settle!: (result: ArtifactFailureCode | undefined) => void;
    const promise = new Promise<ArtifactFailureCode | undefined>((resolve) => { settle = resolve; });
    this.#closePromise = promise;
    this.#closed = true;
    const tracked = Array.from(this.#operations.values());
    // FAIL-CLOSED ORCHESTRATION LATCH. Each generation is retired on its OWN account: `invalidate()`
    // is designed to be total, but it reaches an injected scheduler and the store's discard beneath
    // it, so a throw from one operation must not skip the operations behind it, must not skip the
    // store close that owns physical deletion, and — the promise above being already published —
    // must not strand it. What it must NOT do either is disappear: a close whose own step 2 failed
    // has not proved that generation's cleanup, so it can never report a clean close.
    let orchestrationFailed = false;
    for (const operation of tracked) { try { disposeForRuntime(operation); } catch { orchestrationFailed = true; } }
    // The ONE completion path, shared by every way the store close can end — its result, its
    // rejection, and a synchronous throw out of the call itself. Step 4 belongs to all three: an
    // operation waiting on the one store-close result is waiting whether that close succeeded,
    // failed or never started, and answering only the runtime's own promise left every such
    // operation latched forever on a result that was never delivered.
    let completed = false;
    const complete = (result: ArtifactFailureCode | undefined): void => {
      if (completed) return;
      completed = true;
      // ONE boolean, decided before the loop and identical for every tracked operation: they are all
      // being told the same single close result, not each other's settlement mishaps.
      const failed = orchestrationFailed || result === "artifact-cleanup-failed";
      let clean = !failed;
      for (const operation of tracked) { try { settleStoreClose(operation, failed); } catch { clean = false; } }
      // `undefined` — a clean close — is reported only when every orchestration step AND the store
      // close itself were clean. Anything else is reported in the closed failure vocabulary, like
      // every other artifact failure, rather than rejecting or abandoning the promise every caller
      // is already holding.
      settle(clean ? result : "artifact-cleanup-failed");
    };
    try {
      void this.#store.close().then(complete, () => complete("artifact-cleanup-failed"));
    } catch {
      complete("artifact-cleanup-failed");
    }
    return promise;
  }
}
// Amendment 3 §1: `ArtifactRuntime` is the SOLE cross-module runtime API, so the concrete store is
// deliberately NOT re-exported here — it stays private to `src/artifacts/`, reachable only by the
// modules in this directory. `./types.js` still carries the closed type and error vocabulary,
// including `ArtifactStoreError`, which names failures and owns no filesystem authority.
export * from "./types.js";
