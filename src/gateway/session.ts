/**
 * A browser session: a single owned browser core plus its lifecycle metadata.
 *
 * Mirrors safe-browser's "the tool owns the CDP session" model — a Session owns exactly
 * one `BrowserCore` and is the only thing allowed to close it.
 */
import { randomUUID } from "node:crypto";
import type { BrowserCore } from "../browser/index.js";

export type SessionState = "open" | "closed";

export interface SessionInfo {
  id: string;
  createdAt: number;
  /** Wall-clock ms of the last activity — the idle reaper keys off this. */
  lastActivityAt: number;
  state: SessionState;
  /** Number of verbs currently executing on this session; the idle reaper never reaps while > 0. */
  inFlight: number;
  /** The consumer that owns this session, if it is a consumer-bound (drive) session. */
  consumerId?: string;
  /** The owned core's kind, e.g. "patchright". */
  core: string;
  /** Whether this session's browser can be force-killed (issue #50) — false = force-kill degraded to
   *  graceful-close-only for it (PID capture failed at launch). Surfaced so a degraded process is visible. */
  forceKillAvailable: boolean;
}

export class Session {
  readonly id: string;
  readonly createdAt: number;
  /** Set for consumer-bound (drive) sessions; absent for transient (retrieve) sessions. */
  readonly consumerId?: string;
  readonly #core: BrowserCore;
  #state: SessionState = "open";
  #lastActivityAt: number;
  /** Verbs currently awaiting on this session. Held > 0 for the whole of a long navigate so the
   *  idle reaper can't close the browser mid-flight (mirrors the MCP transport's `inFlight` guard). */
  #inFlight = 0;
  /** Wall-clock ms when the CURRENT in-flight burst began (undefined when idle). The reaper uses this
   *  to reclaim a verb that never settles (hung browser/CDP) instead of leaking its slot forever. */
  #inFlightSince?: number;

  constructor(core: BrowserCore, opts: { id?: string; consumerId?: string } = {}) {
    this.#core = core;
    this.id = opts.id ?? randomUUID();
    this.consumerId = opts.consumerId;
    this.createdAt = Date.now();
    this.#lastActivityAt = this.createdAt;
  }

  get state(): SessionState {
    return this.#state;
  }

  get lastActivityAt(): number {
    return this.#lastActivityAt;
  }

  /** Verbs currently executing on this session. The idle reaper skips a session while this is > 0. */
  get inFlight(): number {
    return this.#inFlight;
  }

  /** How long the CURRENT in-flight burst has been running at `now` (0 when nothing is in flight).
   *  The reaper reads this to reclaim a verb wedged past the max-in-flight deadline. */
  inFlightMs(now: number = Date.now()): number {
    return this.#inFlightSince === undefined ? 0 : now - this.#inFlightSince;
  }

  /** Mark the session as just-used so the idle reaper defers closing it. */
  touch(): void {
    this.#lastActivityAt = Date.now();
  }

  /**
   * Enter a verb: stamp activity and mark the session in-flight so the idle reaper won't close it
   * while a long navigate is still awaiting. ALWAYS pair with `endActivity()` in a `finally`. The
   * first entry of a burst records `#inFlightSince`, so a verb that never settles can still be
   * reclaimed once it exceeds the max-in-flight deadline (see `reapIdle`).
   */
  beginActivity(): void {
    if (this.#inFlight === 0) this.#inFlightSince = Date.now();
    this.#inFlight++;
    this.#lastActivityAt = Date.now();
  }

  /** Leave a verb: drop the in-flight count and re-stamp activity, so a just-finished long call
   *  isn't reaped on the very next tick for having started before the TTL. The count floors at 0
   *  (underflow guard), and the in-flight-burst start clears once the last verb leaves. */
  endActivity(): void {
    this.#inFlight = Math.max(0, this.#inFlight - 1);
    if (this.#inFlight === 0) this.#inFlightSince = undefined;
    this.#lastActivityAt = Date.now();
  }

  /** The browser core this session owns. Throws once the session is closed. */
  get core(): BrowserCore {
    if (this.#state === "closed") {
      throw new Error(`session ${this.id} is closed`);
    }
    return this.#core;
  }

  /** Whether this session's browser can be force-killed (issue #50) — proxies the owned core. */
  get forceKillAvailable(): boolean {
    return this.#core.forceKillAvailable;
  }

  get info(): SessionInfo {
    return {
      id: this.id,
      createdAt: this.createdAt,
      lastActivityAt: this.#lastActivityAt,
      state: this.#state,
      inFlight: this.#inFlight,
      ...(this.consumerId ? { consumerId: this.consumerId } : {}),
      core: this.#core.kind,
      forceKillAvailable: this.#core.forceKillAvailable,
    };
  }

  /**
   * Tear the session down with CONFIRMED death (issue #50): attempt a graceful `core.close()` raced
   * against `closeGraceMs`; a clean close is trusted death (the core resolves close only once the
   * process has exited). If the close fails fast OR is still pending at the grace deadline, abandon it
   * and escalate to `core.kill()` (SIGKILL + confirm within `killConfirmMs`). Flips the session to
   * `closed` and RESOLVES only when death is confirmed by either path; REJECTS if the force-kill can't
   * confirm the process died in time, leaving the session `open` (the manager keeps it counted and hands
   * it to the reconfirm loop). Idempotent: an already-closed session is a no-op.
   *
   * The session manager dedupes concurrent teardowns (its `#closing` map), so this runs at most once per
   * session; the core's own close/kill are the only things touching the browser.
   */
  async teardown(closeGraceMs: number, killConfirmMs: number): Promise<void> {
    if (this.#state === "closed") return;
    const closeP = this.#core.close();
    const grace = graceTimer(closeGraceMs);
    // 'closed' fires only on a CLEAN resolve; a rejecting close surfaces as 'close-failed' → escalate.
    const outcome = await Promise.race([
      closeP.then(() => "closed" as const, () => "close-failed" as const),
      grace.promise.then(() => "timeout" as const),
    ]);
    grace.clear(); // don't leave a dangling ~10s timer on the common clean-close path
    if (outcome === "closed") {
      this.#state = "closed";
      return;
    }
    closeP.catch(() => {}); // abandon a still-pending / rejected close without an unhandled rejection
    await this.#core.kill(killConfirmMs); // throws if death can't be confirmed → session stays 'open'
    this.#state = "closed";
  }

  /**
   * Kill-only reconfirm (issue #50): re-SIGKILL and re-confirm death, WITHOUT ever calling `core.close()`
   * again. The manager's reconfirm loop calls this every reaper tick for a session whose {@link teardown}
   * couldn't confirm the kill. Calling `close()` here would be unsafe — after the earlier SIGKILL tore
   * down the CDP transport, `core.close()` resolves instantly and would be mistaken for a clean death
   * while the OS process is still alive. `core.kill()` re-probes the real pid, so it only confirms a
   * genuine exit. Flips to `closed` on confirm; rejects (stays `open`) if still unconfirmed.
   */
  async reconfirm(killConfirmMs: number): Promise<void> {
    if (this.#state === "closed") return;
    // Single-flight (codex #50 r2): overlapping reconfirms — two fire-and-forget reaper ticks, or a reaper
    // tick racing shutdown — must not start two concurrent `core.kill()` on the same session (which would
    // re-signal its pid twice). Concurrent callers share the one in-flight kill; the latch clears on settle
    // so a still-unconfirmed session is retried on the next drain.
    if (this.#reconfirming) return this.#reconfirming;
    this.#reconfirming = (async () => {
      try {
        await this.#core.kill(killConfirmMs);
        this.#state = "closed";
      } finally {
        this.#reconfirming = undefined;
      }
    })();
    return this.#reconfirming;
  }
  #reconfirming?: Promise<void>;
}

/** A cancellable delay: `promise` resolves after `ms`; `clear()` cancels the (unref'd) timer so a
 *  clean close doesn't leave a dangling grace timer alive. */
function graceTimer(ms: number): { promise: Promise<void>; clear: () => void } {
  let handle: ReturnType<typeof setTimeout>;
  const promise = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, ms);
    handle.unref?.();
  });
  return { promise, clear: () => clearTimeout(handle) };
}
