/**
 * Task 2 §6 — the HTTP entrypoint's artifact lifecycle wiring: per-graph disposal (DELETE, idle reap,
 * `closeAll`, and failed-session-open cleanup all funnel through ONE idempotent promise per graph) and
 * process shutdown (a bounded, diagnosable `ArtifactRuntime.close()` in the correct position between
 * `closeAll()` and `gateway.shutdown()`, and reused for a startup failure after the runtime was already
 * constructed). Kept in its own small module — unlike `http-main.ts` — so this ordering is directly
 * unit-testable with fakes; `http-main.ts`'s top-level `main().catch()` side effect on import makes it
 * unsafe to exercise directly.
 */

/** The exact drive-lineage surface this module needs from `ArtifactRuntime` — a structural type (not
 *  the concrete class) so a test can supply a fake without constructing a real runtime. */
export interface ArtifactLineageRuntime {
  invalidateController(input: { consumerId: string; controllerId: string }): void;
  discardController(input: { consumerId: string; controllerId: string }): Promise<unknown>;
}

export interface ConsumerGraphDisposalTarget {
  drive: { close(): Promise<void> };
  /** Absent = artifact capture disabled for this graph; dispose then only closes the drive session,
   *  exactly as before Task 2 (byte-identical). */
  artifactRuntime?: ArtifactLineageRuntime;
  consumerId: string;
  controllerId: string;
}

/**
 * Build ONE idempotent dispose function for a consumer graph (Task 2 §6 "Runtime ownership ledger"
 * table: DELETE / idle reap / orphan init / close-all all synchronously mark the controller invalidated
 * before their first await). The returned function memoizes its promise on first call — a second call
 * (concurrent DELETE + idle reap, or a defensive re-invocation from failed-session-open cleanup)
 * observes the SAME in-flight/settled promise rather than re-running the sequence or double-fencing.
 *
 * Order, exactly: (1) synchronously invalidate this exact `{consumerId, controllerId}` lineage — before
 * any await, so no new drive operation/acquisition can start against it from this instant; (2) close
 * the drive controller/browser resources; (3) THEN await `artifactRuntime.discardController(...)`. Step
 * 3 always runs even if step 2 fails — a browser teardown failure must never abandon a committed
 * drive-lineage artifact — and it discards ONLY this lineage's drive-scoped artifacts; a consumer-scoped
 * (transient) artifact is untouched by construction (`ArtifactRuntime.discardController` itself never
 * looks at consumer-scoped entries).
 */
export function createConsumerGraphDisposer(target: ConsumerGraphDisposalTarget): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return function dispose(): Promise<void> {
    if (pending) return pending;
    pending = (async () => {
      target.artifactRuntime?.invalidateController({ consumerId: target.consumerId, controllerId: target.controllerId });
      try {
        await target.drive.close();
      } catch {
        // GatewayDriveController.close() already swallows its own teardown errors; this is
        // belt-and-braces so a close failure can never skip the discard step below.
      }
      if (target.artifactRuntime) {
        try {
          await target.artifactRuntime.discardController({ consumerId: target.consumerId, controllerId: target.controllerId });
        } catch {
          // discardController resolves with a closed clean/refused/failed result and is documented
          // never to throw; guarded anyway so a hostile/future implementation can't hang or crash disposal.
        }
      }
    })();
    return pending;
  };
}

export interface BoundedArtifactRuntime {
  close(): Promise<unknown>;
}

/**
 * Await `artifactRuntime.close()` up to `timeoutMs`, never hanging shutdown past the bound and never
 * throwing — a closed failure code the close reports is LOGGED (diagnosable) rather than swallowed, and
 * a hung/rejecting close still lets the caller proceed (fail-closed: the runtime itself already refuses
 * future work once poisoned; this function only bounds the WAIT). `artifactRuntime` absent (disabled
 * mode, or a startup failure before it was ever constructed) is a no-op.
 *
 * Shared by both call sites this bound protects: process shutdown (between `closeAll()` and
 * `gateway.shutdown()`) and a startup failure AFTER the runtime was already constructed — so an
 * artifact-enabled boot that fails on a LATER guard (DNS-rebind, health-token collision, …) still
 * releases the root lock instead of abandoning it for good.
 */
export async function closeArtifactRuntimeBounded(
  artifactRuntime: BoundedArtifactRuntime | undefined,
  timeoutMs: number,
  log: (msg: string) => void,
): Promise<void> {
  if (!artifactRuntime) return;
  let settled = false;
  await new Promise<void>((resolve) => {
    // Deliberately REFERENCED (no `.unref()`): this bound is what stands between a hung
    // `ArtifactRuntime.close()` and the rest of process shutdown ever proceeding — an unref'd timer
    // does not reliably fire once whatever else was keeping the loop alive (the very close() call
    // this bounds) has nothing else pending, which is exactly the hung-close case this exists for.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      log(`artifact runtime close: budget (${timeoutMs}ms) exhausted — proceeding`);
      resolve();
    }, timeoutMs);
    artifactRuntime.close().then(
      (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // The closed failure-code vocabulary only (never a raw exception) — diagnosable, secrets-free.
        if (result) log(`artifact runtime close reported: ${String(result)}`);
        resolve();
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        log("artifact runtime close: rejected unexpectedly — proceeding");
        resolve();
      },
    );
  });
}

export interface ShutdownSequenceTarget {
  httpServer: { close: () => unknown; closeAllConnections?: () => void };
  handler: { drain: (ms: number) => Promise<void>; closeAll: () => Promise<void> };
  gateway: { shutdown: () => Promise<void> };
  artifactRuntime?: BoundedArtifactRuntime;
}

/**
 * The ONE ordered process-shutdown sequence (Task 2 §6 "HTTP process" step 5): refuse new HTTP, drain
 * active response trackers/in-flight tool calls, close every consumer graph (draining + disposing —
 * each graph's dispose is the `createConsumerGraphDisposer` above, so drive-lineage artifacts are
 * discarded here too), THEN bounded-close the artifact runtime, THEN `gateway.shutdown()`. Extracted so
 * this exact ordering is unit-testable with fakes — `http-main.ts` calls this and layers its own
 * operational logging (session counts, elapsed time) around it.
 */
export async function runShutdownSequence(
  target: ShutdownSequenceTarget,
  opts: { drainMs: number; artifactCloseTimeoutMs: number; log: (msg: string) => void },
): Promise<void> {
  const t0 = Date.now();
  target.httpServer.close(); // refuse new connections
  await target.handler.drain(opts.drainMs); // let in-flight tool calls (and active leases) settle
  opts.log(`drain finished after ${Date.now() - t0}ms`);
  await target.handler.closeAll().catch(() => {}); // close transports + dispose every consumer graph
  target.httpServer.closeAllConnections?.(); // drop lingering sockets (e.g. idle SSE) so close() completes
  await closeArtifactRuntimeBounded(target.artifactRuntime, opts.artifactCloseTimeoutMs, opts.log);
  await target.gateway.shutdown().catch(() => {});
}
