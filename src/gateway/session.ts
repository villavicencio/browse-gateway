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

  /** Mark the session as just-used so the idle reaper defers closing it. */
  touch(): void {
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
