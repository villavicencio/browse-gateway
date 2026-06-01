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
  /** Max concurrent consumer-bound (drive) sessions per consumer. Default 1. */
  perConsumerMax?: number;
}

export class SessionManager {
  readonly #sessions = new Map<string, Session>();
  readonly #maxSessions: number;
  readonly #perConsumerMax: number;
  readonly #coreOptions: BrowserCoreOptions;
  readonly #factory: CoreFactory;
  /** Slots claimed by in-flight `acquire()` calls before their core finishes launching. */
  #reserved = 0;
  #reaperTimer?: ReturnType<typeof setInterval>;

  constructor(opts: SessionManagerOptions) {
    this.#maxSessions = opts.maxSessions;
    this.#perConsumerMax = opts.perConsumerMax ?? 1;
    this.#coreOptions = opts.coreOptions ?? {};
    this.#factory = opts.coreFactory ?? createBrowserCore;
  }

  /** Count of open sessions bound to `consumerId` (drive sessions; transient ones are untagged). */
  #countForConsumer(consumerId: string): number {
    let n = 0;
    for (const s of this.#sessions.values()) if (s.consumerId === consumerId) n++;
    return n;
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
   * Create a new session. Rejects with `SESSION_LIMIT` when the global ceiling is reached, or
   * when `meta.consumerId` is set and that consumer is already at its per-consumer cap (so one
   * consumer can't hold open more than its share of drive sessions). Rejects with `CORE_LAUNCH`
   * when the browser fails to start. The global ceiling counts in-flight launches (reserved
   * slots), so concurrent `acquire()` calls can't overshoot, and a launch failure never leaves a
   * leaked/half-counted session.
   */
  async acquire(
    overrides?: BrowserCoreOptions,
    meta?: { consumerId?: string },
  ): Promise<Session> {
    if (this.#sessions.size + this.#reserved >= this.#maxSessions) {
      throw new SessionManagerError(
        "SESSION_LIMIT",
        `session limit reached (${this.#maxSessions})`,
      );
    }
    if (meta?.consumerId && this.#countForConsumer(meta.consumerId) >= this.#perConsumerMax) {
      throw new SessionManagerError(
        "SESSION_LIMIT",
        `per-consumer session limit reached (${this.#perConsumerMax})`,
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
      const session = new Session(core, meta?.consumerId ? { consumerId: meta.consumerId } : {});
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

  /**
   * Close every session whose last activity is older than `ttlMs`, returning the reaped ids.
   * `now` is injectable for testing. Drive sessions are refreshed via `Session.touch()` on each
   * use, so only genuinely idle ones are reaped — the load-bearing leak guard for held sessions.
   */
  async reapIdle(ttlMs: number, now: number = Date.now()): Promise<string[]> {
    const stale = [...this.#sessions.values()].filter((s) => now - s.lastActivityAt > ttlMs);
    await Promise.all(stale.map((s) => this.release(s.id)));
    return stale.map((s) => s.id);
  }

  /** Start a background timer that reaps idle sessions every `intervalMs`. Idempotent. */
  startReaper(ttlMs: number, intervalMs: number): void {
    this.stopReaper();
    const timer = setInterval(() => void this.reapIdle(ttlMs), intervalMs);
    timer.unref?.(); // never keep the process alive just for the reaper
    this.#reaperTimer = timer;
  }

  /** Stop the background reaper timer, if running. */
  stopReaper(): void {
    if (this.#reaperTimer) {
      clearInterval(this.#reaperTimer);
      this.#reaperTimer = undefined;
    }
  }

  /** Close every session and clear the registry — no orphaned browsers left behind. */
  async shutdown(): Promise<void> {
    this.stopReaper();
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.all(sessions.map((s) => s.close().catch(() => {})));
  }
}
