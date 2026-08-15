import { randomBytes } from "node:crypto";
import { ArtifactStore, SYSTEM_SCHEDULER } from "./store.js";
import { ARTIFACT_ID, ArtifactStoreError, type ArtifactFailureCode, type ArtifactOwner, type ArtifactRecord, type ArtifactScheduler, type ArtifactStoreOptions, type DownloadLike, type OperationResult } from "./types.js";
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
 *  accessor wait and every disposal confirmation shares it; no sequential step gets a fresh one. */
const SETTLEMENT_BUDGET_MS = 5_000;

type Thenable<T> = { then: (onFulfilled: (value: T) => void, onRejected: (reason: unknown) => void) => unknown };
const isThenable = <T>(value: unknown): value is Thenable<T> =>
  value !== null && (typeof value === "object" || typeof value === "function") && typeof (value as { then?: unknown }).then === "function";

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
 */
function raceUntrusted<T>(invoke: () => T | Promise<T>, stop: Promise<void>): Promise<AccessorOutcome<T>> {
  let raw: T | Promise<T>;
  let awaitable: boolean;
  try {
    raw = invoke();
    // Same boundary as the disposal path: classifying the return value reads `then`, and that read is
    // as untrusted as the call itself. A throwing getter is an accessor that failed, not an escape.
    awaitable = isThenable<T>(raw);
  } catch {
    return Promise.resolve({ state: "threw" });
  }
  if (!awaitable) return Promise.resolve({ state: "value", value: raw as T });
  return new Promise<AccessorOutcome<T>>((resolve) => {
    let done = false;
    const finish = (outcome: AccessorOutcome<T>) => { if (!done) { done = true; resolve(outcome); } };
    Promise.resolve(raw as Promise<T>).then((value) => finish({ state: "value", value }), () => finish({ state: "threw" }));
    void stop.then(() => finish({ state: "stopped" }));
  });
}

/**
 * Invoke ONE closed disposal operation. The call happens SYNCHRONOUSLY inside this function, so the
 * caller can start `cancel()` and then `delete()` without waiting for the first to settle — a hung,
 * throwing or rejecting `cancel()` must never prevent the `delete()` attempt, which is exactly the
 * case where the driver's copy would otherwise be left on disk.
 */
function invokeDisposal(run: () => Promise<void> | void): Promise<boolean> {
  let raw: Promise<void> | void;
  let awaitable: boolean;
  try {
    raw = run();
    // The RETURN VALUE is untrusted too: classifying it reads `then`, which can be a getter that
    // throws. Probing it outside this try made that throw escape a synchronous caller. A value whose
    // `then` is not callable is simply not a thenable — that is a completed call, like any `void`.
    awaitable = isThenable<void>(raw);
  } catch {
    return Promise.resolve(false);
  }
  if (!awaitable) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    // Adoption reads `then` a SECOND time. A getter that throws only then is caught by the promise
    // machinery itself, which rejects — so it lands on the rejection handler as an unconfirmed call.
    Promise.resolve(raw as Promise<void>).then(() => resolve(true), () => resolve(false));
  });
}

/**
 * Await every disposal confirmation, but only for what is LEFT of the one deadline. Like
 * {@link raceUntrusted}, the continuations left behind on an unsettled driver promise capture nothing
 * of the runtime, so an abandoned disposal is detached rather than retained. No remaining budget
 * means both calls were still attempted but neither can be confirmed.
 */
function confirmWithin(attempts: Array<Promise<boolean>>, remainingMs: number, scheduler: ArtifactScheduler): Promise<boolean> {
  if (remainingMs <= 0) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let done = false;
    let timer: unknown;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      if (timer !== undefined) scheduler.clearTimeout(timer);
      resolve(ok);
    };
    timer = scheduler.setTimeout(() => finish(false), remainingMs);
    void Promise.all(attempts).then((results) => finish(results.every(Boolean)), () => finish(false));
  });
}
/** Runtime disposal is reachable only through this module-private table: the operation exposes no
 *  public disposal method, so nothing outside `src/artifacts/` can revoke a generation. */
const runtimeDisposers = new WeakMap<ArtifactOperation, () => void>();
const disposeForRuntime = (operation: ArtifactOperation) => runtimeDisposers.get(operation)?.();

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
  /** The ONE attributed download, while it is still this operation's to dispose of. Cleared the
   *  instant cleanup takes ownership of it, and when the staging job that consumed it finishes. */
  #download?: DownloadLike;
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
  ) {
    this.#store = store;
    this.#release = release;
    this.#scheduler = scheduler;
    this.#beforeCommit = beforeCommit;
    this.#onTerminal = onTerminal;
    this.#onReleased = onReleased;
    this.#onCommitted = onCommitted;
    this.#onCleanupUnconfirmed = onCleanupUnconfirmed;
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
    runtimeDisposers.set(this, () => this.invalidate("artifact-runtime-invalidated"));
  }

  /**
   * Amendment 5 §1: status and content type are ONE observation of the SAME landed main-frame
   * response, so they are taken together and never separately.
   *
   * API WIDENING (documented): Amendment 3 §1 spells this method with a bare `contentType`, which
   * cannot express Amendment 5's three-part predicate — it needs the landed status from that same
   * response. Amendment 5 has higher precedence, so the parameter is widened to the atomic pair
   * rather than the predicate being weakened to content type alone. The method name is unchanged.
   */
  noteMainResponseContentType(observation: { status: number | null; contentType: string | null }): void {
    if (this.#state.name !== "open") return;
    this.#status = observation.status;
    this.#contentType = observation.contentType;
  }

  /**
   * Attribute one download event. Returns VOID: the staging it starts is internal, so no caller can
   * await, retain, or race the operation's own ledger. `seal()` is the only way to learn the outcome.
   */
  registerDownload(download: DownloadLike): void {
    if (this.#state.name !== "open") return; // late events are the caller's to classify via invalidate()
    this.#events += 1;
    if (this.#events > 1) {
      // More than one event is ambiguous by contract; no guessing which was meant.
      this.invalidate("multiple-artifacts");
      return;
    }
    this.#active += 1;
    const job = this.#stage(download).finally(() => {
      this.#active -= 1;
      this.#clearDeadline();
      this.#tryRelease();
    });
    this.#jobs.add(job);
    void job.then(() => this.#jobs.delete(job));
  }

  /** Terminal = the outcome is already decided. `sealing` is NOT terminal: registered jobs finish. */
  #isTerminal(): boolean {
    return this.#state.name === "invalidated" || this.#state.name === "committed";
  }

  /**
   * The signal every untrusted wait races against: resolved by terminalization, or by the one
   * deadline. Created on first use, which is inside the staging job — so `seal()` can arm the
   * deadline against a wait that already exists.
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

  /** What is left of the one budget. Never a fresh 5s: a sequential step gets the remainder or none. */
  #remaining(): number {
    if (this.#deadlineAt === undefined) return SETTLEMENT_BUDGET_MS;
    return Math.max(0, this.#deadlineAt - this.#scheduler.now());
  }

  /** Drop the deadline timer once nothing can be waiting on it any more. */
  #clearDeadline(): void {
    if (this.#deadlineTimer === undefined || !this.#isTerminal() || this.#active > 0) return;
    this.#scheduler.clearTimeout(this.#deadlineTimer);
    this.#deadlineTimer = undefined;
  }

  async #stage(download: DownloadLike): Promise<void> {
    // Disposable by this operation until the job that owns it finishes: a terminal state reached
    // while the driver still holds these bytes must dispose of them, not just forget them.
    this.#download = download;
    try {
      const stop = this.#signal();
      // Both accessors are UNTRUSTED third-party code. They may throw synchronously, reject, resolve
      // never, or resolve long after the outcome was decided; none of those may govern this ledger.
      const failure = await raceUntrusted<unknown>(() => (download.failure ? download.failure() : undefined), stop);
      if (failure.state === "stopped" || this.#isTerminal()) return;
      if (failure.state === "threw" || failure.value) { this.invalidate("download-capture-failed"); return; }
      const path = await raceUntrusted<string | null>(() => download.path(), stop);
      if (path.state === "stopped" || this.#isTerminal()) return;
      if (path.state === "threw" || !path.value) { this.invalidate("download-capture-failed"); return; }
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
   * Dispose of the attributed download EXACTLY ONCE, bounded by what remains of the one deadline.
   *
   * Compare-and-set on `#cleanup` makes the first caller the owner synchronously, so repeated
   * invalidation, a page close, a kill and a late accessor between them can only observe the record.
   * `cancel()` and `delete()` are both INVOKED synchronously here, in that order, without waiting for
   * the first to settle; only their confirmations are awaited, together, under the shared budget.
   */
  #startCleanup(): void {
    const download = this.#download;
    if (this.#cleanup !== "idle" || !download) return;
    this.#cleanup = "running";
    this.#download = undefined;
    const attempts: Array<Promise<boolean>> = [];
    let offered = false;
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
        offered = true;
        attempts.push(Promise.resolve(false));
        continue;
      }
      if (typeof fn !== "function") continue;
      offered = true;
      attempts.push(invokeDisposal(() => (fn as () => Promise<void> | void).call(download)));
    }
    // A download offering NEITHER closed operation leaves nothing to invoke. `cancel`/`delete` are
    // optional on DownloadLike and the accepted lifecycle invariants register plain `{ path }`
    // downloads, so this is "nothing to dispose", not a failed disposal. The stricter stance — a
    // source offering no disposal cannot prove its bytes are gone — is the browser core's, for the
    // UNATTRIBUTED events it owns, where the gateway has no other relationship to those bytes.
    if (!offered) { this.#finishCleanup(true); return; }
    void confirmWithin(attempts, this.#remaining(), this.#scheduler).then((confirmed) => this.#finishCleanup(confirmed));
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
    if (this.#provisional) return this.#commit({ outcome: "available", artifact: this.#provisional });
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

  #discardStaged(): void {
    this.#provisional = undefined;
    const clean = this.#store.discardArtifact(this.artifactId);
    if (!clean) this.#cleanupFailed = true;
  }

  /**
   * Release this operation's ID reservation, but only once every condition B2 established holds:
   * the generation is terminal, no staging continuation is still running, cleanup actually succeeded
   * (a failed discard must retain the reservation so the ID can never be reused), and no committed
   * artifact is still awaiting its durable discard.
   */
  #tryRelease(): void {
    if (this.#released) return;
    if (this.#state.name === "open" || this.#state.name === "sealing") return;
    if (this.#active > 0 || this.#cleanupFailed || this.#waitingForArtifact) return;
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
  #closed = false;
  /** Public store access remains source-compatible, but the backing authority is a non-enumerable
   *  private field so serializing the runtime cannot disclose its root or accounting internals. */
  get store(): ArtifactStore { return this.#store; }
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
  constructor(options: ArtifactStoreOptions) {
    this.#store = new ArtifactStore({ ...options, onDiscard: (id) => {
      // ArtifactStore invokes onDiscard synchronously after durable deletion, before a replacement can be created.
      const token = this.#reserved.get(id);
      if (token !== undefined) {
        this.#reserved.delete(id);
        this.#operations.delete(token);
      }
      try { options.onDiscard?.(id); } catch {}
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
    const token = Symbol(id);
    this.#reserved.set(id, token);
    const operation = new ArtifactOperation(
      this.#store, canonicalOwner, host, id,
      () => { if (this.#reserved.get(id!) === token) this.#reserved.delete(id!); this.#operations.delete(token); },
      this.#scheduler, this.#beforeCommit, this.#onTerminal, this.#onReleased, this.#onCommitted,
      () => {
        // Poison is the RUNTIME's transition, not the operation's: drop the operation (and with it any
        // reference to the hung driver object) from the live map, but KEEP its identity reserved so the
        // unsafe ID can never be reused, and refuse every later capture.
        this.#cleanupPoisoned = true;
        this.#operations.delete(token);
      },
    );
    this.#operations.set(token, operation);
    return operation;
  }
  close() {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    for (const operation of Array.from(this.#operations.values())) disposeForRuntime(operation);
    this.#closePromise = this.#store.close();
    return this.#closePromise;
  }
}
export * from "./types.js";
export { ArtifactStore } from "./store.js";
