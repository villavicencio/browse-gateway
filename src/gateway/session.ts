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
  state: SessionState;
  /** The owned core's kind, e.g. "patchright". */
  core: string;
}

export class Session {
  readonly id: string;
  readonly createdAt: number;
  readonly #core: BrowserCore;
  #state: SessionState = "open";

  constructor(core: BrowserCore, id: string = randomUUID()) {
    this.#core = core;
    this.id = id;
    this.createdAt = Date.now();
  }

  get state(): SessionState {
    return this.#state;
  }

  /** The browser core this session owns. Throws once the session is closed. */
  get core(): BrowserCore {
    if (this.#state === "closed") {
      throw new Error(`session ${this.id} is closed`);
    }
    return this.#core;
  }

  get info(): SessionInfo {
    return { id: this.id, createdAt: this.createdAt, state: this.#state, core: this.#core.kind };
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
