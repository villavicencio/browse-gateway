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

  get info(): SessionInfo {
    return {
      id: this.id,
      createdAt: this.createdAt,
      lastActivityAt: this.#lastActivityAt,
      state: this.#state,
      inFlight: this.#inFlight,
      ...(this.consumerId ? { consumerId: this.consumerId } : {}),
      core: this.#core.kind,
    };
  }

  /**
   * Close the underlying core and mark the session closed. Idempotent and
   * concurrency-safe: the state flips before the await, so a second (or racing) call
   * is a no-op and the core is never double-closed.
   */
  async close(): Promise<void> {
    if (this.#state === "closed") return;
    this.#state = "closed";
    await this.#core.close();
  }
}
