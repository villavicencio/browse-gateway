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
import { isSealedRestore } from "../browser/index.js";

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
      perConsumerMax: config.perConsumerMax,
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
   *
   * The transient session is marked in-flight for the whole of `fn` (issue #49, subsumed by #50): a
   * hung render then holds `inFlight > 0`, so the reaper's wedged-in-flight branch can reclaim it past
   * the deadline even though a transient is untagged (`consumerId === undefined`) and thus invisible to
   * the idle-TTL branch. A healthy transient still releases synchronously here in the `finally` before
   * the reaper ever sees it. Mirrors `useConsumerSession`'s guard for the drive path.
   */
  async withSession<T>(
    fn: (session: Session) => Promise<T>,
    coreOverrides?: BrowserCoreOptions,
  ): Promise<T> {
    const session = await this.#sessions.acquire(coreOverrides);
    session.beginActivity();
    try {
      return await fn(session);
    } finally {
      session.endActivity();
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

  #requirePolicy(): PolicyEngine {
    if (!this.#policy) throw new Error("gateway has no policy engine configured");
    return this.#policy;
  }

  /**
   * Open a persistent, consumer-bound session for the stateful `drive` path: authenticate, acquire
   * a session tagged to the consumer (capped per-consumer), install that consumer's allowlist guard,
   * and return a handle. Unlike {@link withConsumerSession}, the session is NOT released — the caller
   * drives it via {@link useConsumerSession} and ends it with {@link closeConsumerSession}. The guard
   * is installed before the handle is returned, so the session is never drivable while unguarded.
   */
  async openConsumerSession(
    token: string,
    coreOverrides?: BrowserCoreOptions,
    opts?: { diagnostics?: boolean },
  ): Promise<string> {
    const policy = this.#requirePolicy();
    const consumer = policy.authenticate(token);
    // A restored credential MUST come from the vault producer (`sealRestoreState`, via
    // `buildWarmOverride`, whose owner is bound to the vault lookup). Refuse a freely hand-constructed
    // `restoreState` — which could pair a jar with a forged owner the nav clamp would then trust —
    // before any session opens.
    if (coreOverrides?.restoreState && !isSealedRestore(coreOverrides.restoreState)) {
      throw new Error("openConsumerSession: restoreState must be produced by the vault layer (sealRestoreState)");
    }
    const session = await this.#sessions.acquire(coreOverrides, { consumerId: consumer.id });
    try {
      // The credential owner host travels WITH the (sealed) restored state (`restoreState.ownerHost`),
      // so a credentialed (warm-replay) session is DEFINED by its restored state — there is no separate,
      // omittable/mismatchable `credentialHost` parameter. If a credential is restored, its nav clamp
      // is derived from the exact host the cookies were scoped to (the vault-keyed host).
      const credentialHost = coreOverrides?.restoreState?.ownerHost;
      // A diagnostics probe (the opt-in egress check) is guarded to the policy-owned approved host
      // set ONLY — never the consumer's allowlist — so a restrictive allowlist can't block a
      // service-internal probe and the probe can reach nothing else. The host set lives in the policy
      // (the caller only flips this flag), so a caller can't widen what "diagnostics" may reach.
      // A credentialed session clamps NAVIGATION to the credential's owner host (R4 no-exfil) — so a
      // retained parent-domain cookie can't ride a navigation to a sibling host the consumer's
      // allowlist would otherwise permit. Both extra guards are strictly narrower than the consumer's;
      // a cold session keeps the plain consumer guard.
      const guard = opts?.diagnostics
        ? policy.guardForDiagnostics(consumer)
        : credentialHost
          ? policy.guardForCredentialHost(consumer, credentialHost)
          : policy.guardFor(consumer);
      await session.core.setNavigationGuard(guard);
      // R4/R18: a credentialed (warm-replay) session opens with a stored credential RESTORED into the
      // jar — audit it attributably the moment it is guarded and ready. Only the consumer id + owning
      // host are recorded (both non-secret; host is scrubbed by the redacting sink anyway); the stored
      // credential/cookie values are never touched. A cold drive session (and the cold login-capture
      // session, which mints rather than restores auth) carries no restoreState and emits nothing here,
      // keeping the trail signal-dense.
      if (credentialHost) {
        policy.audit.record({
          ts: Date.now(),
          consumerId: consumer.id,
          action: "session-open",
          decision: "open",
          host: credentialHost,
          reason: "credentialed session",
        });
      }
    } catch (err) {
      await this.#sessions.release(session.id); // never leave a half-open, unguarded session
      throw err;
    }
    return session.id;
  }

  /**
   * Run `fn` against an already-open consumer session. Re-authenticates and verifies the handle
   * belongs to this consumer (so one consumer can't drive another's session — the error is identical
   * for an unknown handle and a foreign one, leaking nothing), and keeps the session open. The guard
   * installed at open persists on the context, so every action stays policy-checked.
   *
   * The session is marked in-flight for the WHOLE of `fn` (not just at call start) and re-stamped on
   * completion, so the idle reaper can't close the browser out from under a long navigate — the same
   * in-flight guard the MCP transport uses one layer up (`http-server.ts`). Activity was previously
   * stamped only before `fn` ran, so a navigate crossing the idle TTL got reaped mid-flight.
   */
  async useConsumerSession<T>(
    token: string,
    handle: string,
    fn: (session: Session, consumer: Consumer) => Promise<T>,
  ): Promise<T> {
    const policy = this.#requirePolicy();
    const consumer = policy.authenticate(token);
    const session = this.#sessions.get(handle);
    if (!session || session.consumerId !== consumer.id) {
      throw new Error(`no open session for handle ${handle}`);
    }
    session.beginActivity();
    try {
      return await fn(session, consumer);
    } finally {
      session.endActivity();
    }
  }

  /** Close an open consumer session. Verifies ownership; a no-op for an unknown/foreign handle. */
  async closeConsumerSession(token: string, handle: string): Promise<void> {
    const policy = this.#requirePolicy();
    const consumer = policy.authenticate(token);
    const session = this.#sessions.get(handle);
    if (session && session.consumerId === consumer.id) {
      await this.#sessions.release(handle);
    }
  }

  /** Tear down every session — no orphaned browser processes. */
  async shutdown(): Promise<void> {
    await this.#sessions.shutdown();
  }
}

export { loadConfig, loadCallTimeouts, DEFAULT_GATEWAY_CONFIG, DEFAULT_CALL_TIMEOUTS, poolSizingError } from "./config.js";
export type { GatewayConfig, CallTimeouts } from "./config.js";
export {
  SessionManager,
  SessionManagerError,
  MAX_INFLIGHT_MS,
  CLOSE_GRACE_MS,
  KILL_CONFIRM_MS,
} from "./session-manager.js";
export type {
  CoreFactory,
  SessionManagerOptions,
  SessionManagerErrorCode,
} from "./session-manager.js";
export { Session } from "./session.js";
export type { SessionInfo, SessionState } from "./session.js";
