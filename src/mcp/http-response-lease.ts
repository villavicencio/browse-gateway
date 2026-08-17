/**
 * Task 2 §5.2 — the repo-owned per-POST tracker that maps the SDK's Streamable HTTP dispatch onto
 * the ACTUAL Node `ServerResponse` completion boundary and, through that, onto one
 * `ArtifactResponseLease.complete()`.
 *
 * Deliberately independent of the SDK/transport: `transport.handleRequest()` resolving, `res.end()`
 * being CALLED, and a stream-controller closing are all too early (Task 2 §5.3/§5.4 — confirmed
 * against the installed `@modelcontextprotocol/sdk` 1.29.0 `StreamableHTTPServerTransport`, which
 * wraps `@hono/node-server`'s `getRequestListener` around the EXACT `req`/`res` this module is handed;
 * it attaches its own `finish`/`close` listeners but never removes ours and never replaces `res`, so a
 * tracker armed on the real pair observes the real Node completion boundary without patching SDK
 * internals). Node `finish` is the only in-process signal that the bytes reached kernel socket
 * machinery — the only claim Task 2 makes (§5.3).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ArtifactResponseLease, ArtifactResponseOutcome } from "../artifacts/index.js";

/** The exact JSON-RPC tool name a batch/dispatch gate recognizes (Task 2 §3.6/§5.1). */
export const ARTIFACT_TOOL_NAME = "browser_get_artifact";

/** Task 2 §5.1's exact tracker shape — the only surface a caller (a future tool, or `http-server.ts`
 *  itself on shutdown) may use. */
export interface ArtifactLeaseTracker {
  /** Register the one lease this request may carry (Task 2 §5.1 step 3). Exactly one call may
   *  succeed; every call after the first — or any call once this tracker is already terminal — is a
   *  closed invariant failure: the passed lease is immediately completed `transport-failed` (so it
   *  can never strand a permit) and `register` throws {@link ArtifactLeaseTrackerError}. */
  register(lease: ArtifactResponseLease): void;
  /** Force this tracker to its terminal state with `outcome`, exactly once (idempotent — a later
   *  Node event or a second call observes the outcome already decided). Used for an outcome this
   *  tracker cannot observe on its own, e.g. process/session shutdown. */
  completeRequest(outcome: ArtifactResponseOutcome): Promise<void>;
  /** Resolves once terminalization has fully completed: listeners detached, timer cleared, every
   *  tracker-held reference released, and (when a lease was registered) its `complete()` awaited. */
  readonly settled: Promise<void>;
}

/** `http-server.ts`-only extension of {@link ArtifactLeaseTracker}: arms reset/error detection BEFORE
 *  any lease exists, so a client reset landing during acquisition (Task 2 §7 "Client reset during
 *  acquisition/serialization", acceptance H7) is latched immediately instead of missed. Deliberately
 *  NOT on the public tracker shape a tool receives — Task 2 §5.1 names exactly three members there. */
export interface HttpArtifactLeaseTracker extends ArtifactLeaseTracker {
  activate(): void;
}

/** Every case `register()`/a hostile duplicate call can hit is a closed invariant failure — never
 *  retryable, and never distinguished to a caller beyond the guarded fallback completion Task 2 §5.1
 *  already requires. */
export class ArtifactLeaseTrackerError extends Error {
  readonly code: "duplicate-registration" | "tracker-terminal";
  constructor(code: "duplicate-registration" | "tracker-terminal") {
    super(code);
    this.name = "ArtifactLeaseTrackerError";
    this.code = code;
  }
}

export interface ArtifactLeaseTrackerOptions {
  /** The ONE clock this tracker computes its remaining deadline from — MUST be the same domain as
   *  `lease.deadlineMs` (Task 2 §5.2: "the 15-second timer uses only `lease.deadlineMs - now`").
   *  Defaults to `Date.now` for production; tests inject a fake scheduler for deterministic races. */
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** @internal test seam (Task 2 §5.2 step 4, acceptance S3): fires synchronously the instant
   *  tracker-held request/response/lease references are cleared — strictly before `lease.complete()`
   *  is awaited, so a test can prove release happens before a deliberately deferred completion settles. */
  onReferencesReleased?: () => void;
}

type TrackerState = "idle" | "active" | "terminal";

/** Build one tracker bound to the exact `req`/`res` pair carrying this POST's response. Cheap to
 *  create for every POST: no listener and no timer exists until `activate()` or `register()` arms
 *  them, so a non-artifact request costs nothing beyond the object itself (Task 2 §5.1). */
export function createArtifactLeaseTracker(
  req: IncomingMessage,
  res: ServerResponse,
  options: ArtifactLeaseTrackerOptions = {},
): HttpArtifactLeaseTracker {
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const clearTimer = options.clearTimer ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout));

  let state: TrackerState = "idle";
  let lease: ArtifactResponseLease | undefined;
  let deadlineTimer: unknown;
  let settleResolve!: () => void;
  const settled = new Promise<void>((resolve) => {
    settleResolve = resolve;
  });
  let terminalizing: Promise<void> | undefined;

  let onFinish: (() => void) | undefined;
  let onResClose: (() => void) | undefined;
  let onResError: (() => void) | undefined;
  let onReqError: (() => void) | undefined;
  let onReqAborted: (() => void) | undefined;

  function detachListeners(): void {
    if (onFinish) res.removeListener("finish", onFinish);
    if (onResClose) res.removeListener("close", onResClose);
    if (onResError) res.removeListener("error", onResError);
    if (onReqError) req.removeListener("error", onReqError);
    if (onReqAborted) req.removeListener("aborted", onReqAborted);
    onFinish = onResClose = onResError = onReqError = onReqAborted = undefined;
  }

  function clearDeadline(): void {
    if (deadlineTimer !== undefined) {
      clearTimer(deadlineTimer);
      deadlineTimer = undefined;
    }
  }

  /** Task 2 §5.2's exact ordered terminalization. Idempotent: the FIRST outcome wins, latched via
   *  `terminalizing` before any of the ordered steps run. */
  function terminalize(outcome: ArtifactResponseOutcome): Promise<void> {
    if (terminalizing) return terminalizing;
    state = "terminal";
    // Steps 2: detach listeners and clear the timer — no later Node event can reach this tracker.
    detachListeners();
    clearDeadline();
    // Step 3: fence non-sent responses BEFORE the lease's completion can release the permit, so a
    // late SDK write can never reach the wire after this tracker has already decided the outcome.
    if (outcome !== "sent") {
      try {
        if (!res.destroyed) res.destroy();
      } catch {
        /* best-effort fence; the socket may already be gone */
      }
    }
    // Step 4: drop tracker-held references before awaiting completion, through a function captured
    // off the lease itself — not a method that still closes over this tracker's own fields.
    const activeLease = lease;
    lease = undefined;
    const complete = activeLease ? activeLease.complete.bind(activeLease) : undefined;
    options.onReferencesReleased?.();
    terminalizing = (async () => {
      // Step 5: await the minimal completion authority.
      if (complete) {
        try {
          await complete(outcome);
        } catch {
          /* ArtifactResponseLease.complete is documented total/non-throwing; belt-and-braces only */
        }
      }
    })().finally(() => {
      // Step 6: settle. The next global-permit waiter may proceed only after this, but the permit
      // itself was already released inside `complete()`, not by this tracker.
      settleResolve();
    });
    return terminalizing;
  }

  function armListeners(): void {
    onFinish = () => {
      void terminalize("sent");
    };
    onResClose = () => {
      void terminalize(res.writableFinished ? "sent" : "transport-failed");
    };
    onResError = () => {
      void terminalize("transport-failed");
    };
    onReqError = () => {
      void terminalize("transport-failed");
    };
    onReqAborted = () => {
      void terminalize("transport-failed");
    };
    res.once("finish", onFinish);
    res.once("close", onResClose);
    res.once("error", onResError);
    req.once("error", onReqError);
    req.once("aborted", onReqAborted);
  }

  function activate(): void {
    if (state !== "idle") return;
    armListeners();
  }

  function register(candidate: ArtifactResponseLease): void {
    if (state === "terminal") {
      void candidate.complete("transport-failed").catch(() => {});
      throw new ArtifactLeaseTrackerError("tracker-terminal");
    }
    if (state === "active") {
      void candidate.complete("transport-failed").catch(() => {});
      throw new ArtifactLeaseTrackerError("duplicate-registration");
    }
    state = "active";
    lease = candidate;
    if (!onFinish) armListeners(); // activate() may already have armed these — never double-arm
    const remaining = Math.max(0, candidate.deadlineMs - now());
    deadlineTimer = setTimer(() => {
      void terminalize("timed-out");
    }, remaining);
  }

  function completeRequest(outcome: ArtifactResponseOutcome): Promise<void> {
    return terminalize(outcome);
  }

  return { register, completeRequest, settled, activate };
}

/** Task 2 §3.6: true iff `body` is a JSON-RPC BATCH (array) containing a `tools/call` to
 *  {@link ARTIFACT_TOOL_NAME}. Defensive against a malformed element: anything that isn't a plain
 *  object with the exact shape simply doesn't match — this never throws on hostile input. */
export function batchContainsArtifactRetrieval(body: unknown): boolean {
  if (!Array.isArray(body)) return false;
  for (const entry of body) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    if (rec.method !== "tools/call") continue;
    const params = rec.params;
    if (!params || typeof params !== "object") continue;
    if ((params as Record<string, unknown>).name === ARTIFACT_TOOL_NAME) return true;
  }
  return false;
}

/** Task 2 §5.1: true iff `body` is a single (non-batch) JSON-RPC request calling
 *  {@link ARTIFACT_TOOL_NAME}. Only this exact shape activates the per-POST tracker/request context —
 *  every other dispatch (including a batch, rejected separately) costs nothing extra. */
export function isArtifactToolCall(body: unknown): body is { id?: string | number; method: "tools/call"; params: { name: string } } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const rec = body as Record<string, unknown>;
  if (rec.method !== "tools/call") return false;
  const params = rec.params;
  if (!params || typeof params !== "object") return false;
  return (params as Record<string, unknown>).name === ARTIFACT_TOOL_NAME;
}
