/**
 * Gateway service skeleton (U2).
 *
 * Owns configuration and the session lifecycle, and exposes ONE internal request path —
 * `withSession` — that every consumer surface funnels through (MCP in U6, CDP/REST in
 * v1.1). Policy (the U3 allowlist + per-consumer auth) wraps this single method, so no
 * surface can reach a browser without passing through it. That's the whole point of
 * enforcing below the verb layer.
 */
import { loadConfig } from "./config.js";
import type { GatewayConfig } from "./config.js";
import { SessionManager } from "./session-manager.js";
import type { CoreFactory } from "./session-manager.js";
import type { Session } from "./session.js";
import type { PolicyEngine } from "../policy/index.js";
import type { Consumer } from "../policy/index.js";
import type { BrowserCoreOptions } from "../browser/index.js";

export class Gateway {
  readonly #config: GatewayConfig;
  readonly #sessions: SessionManager;
  readonly #policy?: PolicyEngine;

  private constructor(config: GatewayConfig, sessions: SessionManager, policy?: PolicyEngine) {
    this.#config = config;
    this.#sessions = sessions;
    this.#policy = policy;
  }

  /**
   * Build a gateway from config (defaults to env). A core factory can be injected for
   * tests; a policy engine enables the authenticated `withConsumerSession` path.
   */
  static create(
    config: GatewayConfig = loadConfig(),
    coreFactory?: CoreFactory,
    policy?: PolicyEngine,
  ): Gateway {
    const sessions = new SessionManager({
      maxSessions: config.maxSessions,
      coreOptions: config.core,
      coreFactory,
    });
    return new Gateway(config, sessions, policy);
  }

  get policy(): PolicyEngine | undefined {
    return this.#policy;
  }

  get config(): GatewayConfig {
    return this.#config;
  }

  get sessions(): SessionManager {
    return this.#sessions;
  }

  /**
   * The single internal request path: acquire a session, run `fn`, and ALWAYS release it
   * — even if `fn` throws (e.g. a browser-core crash mid-render). Sessions never leak.
   */
  async withSession<T>(
    fn: (session: Session) => Promise<T>,
    coreOverrides?: BrowserCoreOptions,
  ): Promise<T> {
    const session = await this.#sessions.acquire(coreOverrides);
    try {
      return await fn(session);
    } finally {
      await this.#sessions.release(session.id);
    }
  }

  /**
   * Authenticated variant of {@link withSession}: resolve the consumer from `token`
   * (rejecting unknown credentials BEFORE any session opens), install that consumer's
   * allowlist guard on the session's core, then run `fn`. Every consumer surface goes
   * through here so auth + allowlist can't be bypassed per-surface.
   */
  async withConsumerSession<T>(
    token: string,
    fn: (session: Session, consumer: Consumer) => Promise<T>,
    coreOverrides?: BrowserCoreOptions,
  ): Promise<T> {
    const policy = this.#policy;
    if (!policy) throw new Error("gateway has no policy engine configured");
    const consumer = policy.authenticate(token);
    return this.withSession(async (session) => {
      await session.core.setNavigationGuard(policy.guardFor(consumer));
      return fn(session, consumer);
    }, coreOverrides);
  }

  /** Tear down every session — no orphaned browser processes. */
  async shutdown(): Promise<void> {
    await this.#sessions.shutdown();
  }
}

export { loadConfig, DEFAULT_GATEWAY_CONFIG } from "./config.js";
export type { GatewayConfig } from "./config.js";
export { SessionManager, SessionManagerError } from "./session-manager.js";
export type {
  CoreFactory,
  SessionManagerOptions,
  SessionManagerErrorCode,
} from "./session-manager.js";
export { Session } from "./session.js";
export type { SessionInfo, SessionState } from "./session.js";
