/**
 * Owns the create/use/destroy lifecycle of browser sessions over the U1 core.
 *
 * The browser core is created through an injectable factory (default `createBrowserCore`)
 * so the lifecycle is unit-testable without launching real browsers. A max-session ceiling
 * caps concurrent browsers — each headful Chrome is heavy, so this is the load-bearing
 * resource control that R2/AE5 tune in U7.
 */
import { createBrowserCore } from "../browser/index.js";
import type { BrowserCore, BrowserCoreOptions } from "../browser/index.js";
import { Session } from "./session.js";
import type { SessionInfo } from "./session.js";

export type CoreFactory = (opts: BrowserCoreOptions) => Promise<BrowserCore>;

export type SessionManagerErrorCode = "SESSION_LIMIT" | "CORE_LAUNCH";

export class SessionManagerError extends Error {
  readonly code: SessionManagerErrorCode;
  constructor(code: SessionManagerErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SessionManagerError";
    this.code = code;
  }
}

export interface SessionManagerOptions {
  maxSessions: number;
  coreOptions?: BrowserCoreOptions;
  coreFactory?: CoreFactory;
}

export class SessionManager {
  readonly #sessions = new Map<string, Session>();
  readonly #maxSessions: number;
  readonly #coreOptions: BrowserCoreOptions;
  readonly #factory: CoreFactory;
  /** Slots claimed by in-flight `acquire()` calls before their core finishes launching. */
  #reserved = 0;

  constructor(opts: SessionManagerOptions) {
    this.#maxSessions = opts.maxSessions;
    this.#coreOptions = opts.coreOptions ?? {};
    this.#factory = opts.coreFactory ?? createBrowserCore;
  }

  get activeCount(): number {
    return this.#sessions.size;
  }

  get maxSessions(): number {
    return this.#maxSessions;
  }

  list(): SessionInfo[] {
    return [...this.#sessions.values()].map((s) => s.info);
  }

  /**
   * Create a new session. Rejects with `SESSION_LIMIT` when the ceiling is reached and
   * `CORE_LAUNCH` when the browser fails to start. The ceiling counts in-flight launches
   * (reserved slots), so concurrent `acquire()` calls can't overshoot the cap, and a
   * launch failure never leaves a leaked/half-counted session.
   */
  async acquire(overrides?: BrowserCoreOptions): Promise<Session> {
    if (this.#sessions.size + this.#reserved >= this.#maxSessions) {
      throw new SessionManagerError(
        "SESSION_LIMIT",
        `session limit reached (${this.#maxSessions})`,
      );
    }
    this.#reserved++;
    try {
      const coreOptions = overrides ? { ...this.#coreOptions, ...overrides } : this.#coreOptions;
      let core: BrowserCore;
      try {
        core = await this.#factory(coreOptions);
      } catch (cause) {
        throw new SessionManagerError("CORE_LAUNCH", "browser core failed to launch", {
          cause,
        });
      }
      const session = new Session(core);
      this.#sessions.set(session.id, session);
      return session;
    } finally {
      this.#reserved--;
    }
  }

  get(id: string): Session | undefined {
    return this.#sessions.get(id);
  }

  /** Close and forget a session. Idempotent — unknown ids are a no-op. */
  async release(id: string): Promise<void> {
    const session = this.#sessions.get(id);
    if (!session) return;
    this.#sessions.delete(id);
    await session.close();
  }

  /** Close every session and clear the registry — no orphaned browsers left behind. */
  async shutdown(): Promise<void> {
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.all(sessions.map((s) => s.close().catch(() => {})));
  }
}
