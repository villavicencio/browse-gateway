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

/**
 * Ceiling on how long a single in-flight burst may hold the reaper off before it's treated as a
 * WEDGED verb (hung browser/CDP, Xvfb wedge) and reclaimed regardless of the in-flight guard. A
 * legitimate long navigate is ≤ ~210s worst case (PROXY_MAX_ATTEMPTS × (nav + clearance), see
 * `retrieve.ts`), so 10 min unambiguously means "stuck", and a ≤10-min reclaim latency beats
 * leaking the session + Chrome process + capacity slot forever. Not env-overridable by design —
 * env-tunable timeouts are ticket #43; `reapIdle`/`startReaper` take an optional param for tests.
 */
export const MAX_INFLIGHT_MS = 600_000;

/**
 * How long a teardown attempts a GRACEFUL `core.close()` before escalating to a force-kill (issue #50).
 * A healthy close resolves in ~1-2s; 10s is generous headroom so a normal teardown never escalates, yet
 * a wedged close (hung CDP/Xvfb) is force-killed promptly rather than pinning a browser + slot. Not
 * env-overridable by design (ticket #43); `SessionManagerOptions.closeGraceMs` overrides it for tests.
 */
export const CLOSE_GRACE_MS = 10_000;

/**
 * How long a force-kill waits to CONFIRM the OS process actually exited (SIGKILL → child `'exit'` /
 * `kill(pid,0)`→ESRCH) before giving up as unconfirmed. A same-uid child dies in <200ms in practice; 5s
 * tolerates a busy host. On timeout the session stays COUNTED (a cap-safe zombie) and the reaper's
 * reconfirm loop retries — the invariant (never free a slot without confirmed death) outranks capacity.
 * Not env-overridable by design (ticket #43); `SessionManagerOptions.killConfirmMs` overrides it for tests.
 */
export const KILL_CONFIRM_MS = 5_000;

/**
 * How many extra kill-only reconfirm passes `shutdown()` makes over sessions whose force-kill didn't
 * confirm on the first pass, before giving up and RETAINING them in accounting (issue #50). A SIGKILL'd
 * process is almost always reapable within one `KILL_CONFIRM_MS` probe; a couple more passes cover a
 * briefly-stuck one without letting shutdown hang when force-kill is unavailable (kill rejects fast).
 */
export const SHUTDOWN_RECONFIRM_TRIES = 3;

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
  /** Graceful-close grace before a teardown escalates to force-kill. Default {@link CLOSE_GRACE_MS};
   *  overridable for tests. The slot stays counted until close/kill CONFIRMS regardless of this value. */
  closeGraceMs?: number;
  /** Force-kill death-confirmation deadline. Default {@link KILL_CONFIRM_MS}; overridable for tests. */
  killConfirmMs?: number;
}

export class SessionManager {
  readonly #sessions = new Map<string, Session>();
  readonly #maxSessions: number;
  readonly #perConsumerMax: number;
  readonly #coreOptions: BrowserCoreOptions;
  readonly #factory: CoreFactory;
  readonly #closeGraceMs: number;
  readonly #killConfirmMs: number;
  /** Slots claimed by in-flight `acquire()` calls before their core finishes launching. */
  #reserved = 0;
  /** Per-consumer in-flight launch counts, so concurrent opens can't overshoot the per-consumer cap
   *  in the window between the cap check and the new session landing in the map. */
  readonly #reservedByConsumer = new Map<string, number>();
  /**
   * Sessions whose teardown is IN FLIGHT, id → the teardown promise. A session stays in `#sessions`
   * (still COUNTED against both caps) until that teardown CONFIRMS death — so a wedged close can't free a
   * slot for a replacement while the browser is still alive. Also dedupes a re-entrant release/reap: a
   * second teardown for the same id returns this promise instead of starting another close. (Issue #50.)
   */
  readonly #closing = new Map<string, Promise<void>>();
  /**
   * Sessions whose graceful close failed AND whose force-kill could not be CONFIRMED within the deadline
   * (issue #50). They stay in `#sessions` (counted — cap-safe) and are drained every reaper tick by a
   * KILL-ONLY reconfirm (`Session.reconfirm`, never `core.close()` again — a post-SIGKILL close resolves
   * instantly and would false-confirm death). Also holds anchorless orphans from the acquire⇄shutdown
   * self-teardown (a core torn down but never registered in `#sessions`). `reapIdle` skips these so the
   * normal reap path can't re-run close-first on them.
   */
  readonly #unconfirmed = new Set<Session>();
  /**
   * In-flight `acquire()` launch promises. `shutdown()` awaits these so a launch racing shutdown can't
   * leave a just-registered (or just-launched-and-self-torn-down) browser un-awaited (the CLI no-orphan
   * guarantee — prod's container namespace teardown is the ultimate backstop). Added before the launch's
   * first await, removed in `acquire`'s finally. (Issue #50.)
   */
  readonly #launching = new Set<Promise<Session>>();
  /** Set once `shutdown()` begins; `acquire()` refuses from here on, so no replacement is admitted while
   *  shutdown drains in-flight teardowns and launches. (Issue #50.) */
  #shuttingDown = false;
  #reaperTimer?: ReturnType<typeof setInterval>;

  constructor(opts: SessionManagerOptions) {
    this.#maxSessions = opts.maxSessions;
    this.#perConsumerMax = opts.perConsumerMax ?? 1;
    this.#coreOptions = opts.coreOptions ?? {};
    this.#factory = opts.coreFactory ?? createBrowserCore;
    this.#closeGraceMs = opts.closeGraceMs ?? CLOSE_GRACE_MS;
    this.#killConfirmMs = opts.killConfirmMs ?? KILL_CONFIRM_MS;
  }

  /**
   * Count of sessions bound to `consumerId` — registered ones PLUS in-flight launches. Counting
   * reserved launches is what makes the per-consumer cap hold under concurrent opens (transient
   * sessions are untagged and never counted here).
   */
  #countForConsumer(consumerId: string): number {
    let n = this.#reservedByConsumer.get(consumerId) ?? 0;
    for (const s of this.#sessions.values()) if (s.consumerId === consumerId) n++;
    return n;
  }

  /** Sessions occupying a capacity slot — includes sessions mid-teardown (`#closing`) and unconfirmed
   *  force-kills (`#unconfirmed`), which stay counted until death confirms, so this never under-reports
   *  live browsers. */
  get activeCount(): number {
    return this.#sessions.size;
  }

  get maxSessions(): number {
    return this.#maxSessions;
  }

  list(): SessionInfo[] {
    return [...this.#sessions.values()].map((s) => s.info);
  }

  /** Whether every live core can be force-killed (issue #50). False means at least one session's core
   *  failed to capture its Chromium PID at launch, so force-kill has degraded to graceful-close-only for
   *  it — surfaced so a degraded process is observable (health) rather than only in stderr. */
  get forceKillAvailable(): boolean {
    for (const s of this.#sessions.values()) if (!s.forceKillAvailable) return false;
    return true;
  }

  /** Count of browsers whose death could NOT be confirmed — a best-effort SIGKILL was sent but neither a
   *  clean close nor an ESRCH confirmed the process is gone (issue #50). Retained (never erased) so a
   *  possibly-alive orphan is observable; the reaper's reconfirm loop keeps retrying these. Non-zero
   *  means a browser may still be alive despite its teardown — a health/observability signal. */
  get unconfirmedCount(): number {
    return this.#unconfirmed.size;
  }

  /**
   * Create a new session. Rejects with `SESSION_LIMIT` when the global ceiling is reached, when
   * `meta.consumerId` is set and that consumer is already at its per-consumer cap (so one consumer can't
   * hold open more than its share of drive sessions), or when the manager is shutting down. Rejects with
   * `CORE_LAUNCH` when the browser fails to start. The global ceiling counts in-flight launches (reserved
   * slots), so concurrent `acquire()` calls can't overshoot, and a launch failure never leaves a
   * leaked/half-counted session.
   */
  async acquire(
    overrides?: BrowserCoreOptions,
    meta?: { consumerId?: string },
  ): Promise<Session> {
    // Refuse once shutdown has begun, so a replacement can't be admitted while shutdown() drains in-flight
    // teardowns/launches (issue #50). Reuses SESSION_LIMIT — a shutdown is a "can't acquire now".
    if (this.#shuttingDown) {
      throw new SessionManagerError("SESSION_LIMIT", "session manager is shutting down");
    }
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
    if (meta?.consumerId) {
      this.#reservedByConsumer.set(meta.consumerId, (this.#reservedByConsumer.get(meta.consumerId) ?? 0) + 1);
    }
    // Track the launch BEFORE its first await so shutdown()'s `allSettled([...#launching])` snapshot
    // always includes an acquire in flight when the shutdown flag flips.
    const p = this.#launchAndRegister(overrides, meta);
    this.#launching.add(p);
    try {
      return await p;
    } finally {
      this.#reserved--;
      if (meta?.consumerId) {
        const remaining = (this.#reservedByConsumer.get(meta.consumerId) ?? 1) - 1;
        if (remaining > 0) this.#reservedByConsumer.set(meta.consumerId, remaining);
        else this.#reservedByConsumer.delete(meta.consumerId);
      }
      this.#launching.delete(p);
    }
  }

  /**
   * Launch a core and register its session — the awaited body of {@link acquire}, factored out so the
   * launch is a single tracked promise in `#launching`. Re-checks `#shuttingDown` AFTER the (possibly
   * slow) factory launch: if shutdown began while the core was launching, the just-launched browser is
   * torn down (close→confirmed-kill) and NEVER registered, so it can't outlive shutdown as an orphan.
   * The re-check and `#sessions.set` are synchronous-contiguous (no await between them), so an acquire
   * that observes "not shutting down" registers atomically before any concurrent shutdown could
   * interleave — and it is in `#launching`, so shutdown awaits it and then sees the registered session.
   */
  async #launchAndRegister(
    overrides?: BrowserCoreOptions,
    meta?: { consumerId?: string },
  ): Promise<Session> {
    const coreOptions = overrides ? { ...this.#coreOptions, ...overrides } : this.#coreOptions;
    let core: BrowserCore;
    try {
      core = await this.#factory(coreOptions);
    } catch (cause) {
      throw new SessionManagerError("CORE_LAUNCH", "browser core failed to launch", { cause });
    }
    if (this.#shuttingDown) {
      // Never register once shutdown began. Tear down the orphan (close→confirmed-kill); if the kill
      // can't confirm, hand it to `#unconfirmed` so shutdown's drain reclaims it. It was never in
      // `#sessions`, so it consumed no slot — this is purely no-orphan hygiene (the CLI path).
      const orphan = new Session(core);
      try {
        await orphan.teardown(this.#closeGraceMs, this.#killConfirmMs);
      } catch {
        this.#unconfirmed.add(orphan);
      }
      throw new SessionManagerError("SESSION_LIMIT", "session manager is shutting down");
    }
    const session = new Session(core, meta?.consumerId ? { consumerId: meta.consumerId } : {});
    this.#sessions.set(session.id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.#sessions.get(id);
  }

  /**
   * Tear down and forget a session. Idempotent — an unknown id, a re-entrant release, and a session
   * already tearing down or awaiting force-kill reconfirm are all no-ops. Awaits the FULL teardown
   * (close→confirmed-kill, internally bounded to ~`closeGraceMs + killConfirmMs`); the slot is freed only
   * when death is CONFIRMED, so a wedged close never frees capacity while the browser is still alive.
   */
  async release(id: string): Promise<void> {
    const session = this.#sessions.get(id);
    if (!session) return;
    await this.#beginTeardown(session);
  }

  /**
   * Start (or return the in-flight) teardown for `session`, keeping it COUNTED in `#sessions` until death
   * CONFIRMS — close-then-delete, not delete-then-close (issue #50). On confirmed death the entry (and its
   * slot) is removed; on an unconfirmed force-kill the session moves to `#unconfirmed` (still counted) for
   * the reaper's kill-only reconfirm loop. Dedupes via `#closing` so a racing release/reap shares one
   * teardown, and skips a session already in `#unconfirmed` (the drain owns it — re-running the close-first
   * teardown could false-confirm a post-SIGKILL close). The returned promise NEVER rejects (both
   * resolution arms only mutate maps), so a fire-and-forget reap and an awaited release are both safe.
   */
  #beginTeardown(session: Session): Promise<void> {
    const existing = this.#closing.get(session.id);
    if (existing) return existing;
    if (this.#unconfirmed.has(session)) return Promise.resolve();
    const done = session.teardown(this.#closeGraceMs, this.#killConfirmMs).then(
      () => {
        // CONFIRMED dead → free the slot now, and only now.
        this.#sessions.delete(session.id);
        this.#closing.delete(session.id);
      },
      () => {
        // Force-kill UNCONFIRMED → keep the session COUNTED (cap-safe) and hand it to the reconfirm loop;
        // drop it from `#closing` so it isn't permanently deduped. `done` still RESOLVES here.
        this.#unconfirmed.add(session);
        this.#closing.delete(session.id);
      },
    );
    this.#closing.set(session.id, done);
    return done;
  }

  /**
   * Retry every unconfirmed force-kill (issue #50): re-SIGKILL + re-confirm via `Session.reconfirm`
   * (kill-only — never re-runs `core.close()`, which after the earlier SIGKILL would resolve instantly and
   * false-confirm death). On a genuine confirm the session leaves `#sessions` + `#unconfirmed`; otherwise
   * it stays for the next tick. An anchorless orphan (never in `#sessions`) just leaves `#unconfirmed`.
   * Rejection-safe: the per-session `.then(onFulfilled, onRejected)` never rethrows.
   */
  #drainUnconfirmed(): Promise<void> {
    if (this.#unconfirmed.size === 0) return Promise.resolve();
    return Promise.all(
      [...this.#unconfirmed].map((s) =>
        s.reconfirm(this.#killConfirmMs).then(
          () => {
            this.#sessions.delete(s.id); // no-op for an orphan never registered
            this.#unconfirmed.delete(s);
          },
          () => {}, // still unconfirmed → stays for the next drain
        ),
      ),
    ).then(() => {});
  }

  /**
   * Close every consumer-bound (drive) session whose last activity is older than `ttlMs`, plus any WEDGED
   * in-flight session (drive OR transient) stuck past `maxInFlightMs`; returns the reaped ids and then
   * drains any unconfirmed force-kills. `now` is injectable for testing.
   *
   * Drive sessions are refreshed via `Session.beginActivity()/endActivity()` on each use, so only genuinely
   * idle ones are idle-reaped — the load-bearing leak guard for held sessions. A session with a verb IN
   * FLIGHT (`inFlight > 0`) is NOT idle-reaped even past the TTL — closing the browser mid-navigate would
   * hand a waiting caller a raw `no open session for handle …`. But that guard is BOUNDED: a verb still in
   * flight past `maxInFlightMs` is treated as WEDGED (hung browser/CDP, Xvfb wedge — its `finally` never
   * runs) and IS reaped, so a never-settling verb can't leak its session + Chrome + slot forever.
   *
   * The wedged branch applies to ALL sessions (issue #49, subsumed by #50): a transient (retrieve) session
   * is untagged, so `withSession`/`withConsumerSession` stamp begin/endActivity around it — a hung render
   * therefore holds `inFlight > 0` and, past the deadline, is reaped just like a wedged drive session. The
   * idle-TTL branch stays consumer-only: transients release synchronously in their `finally`, so a healthy
   * transient is never idle-reaped (its `consumerId === undefined` makes it invisible to that branch, and
   * once `endActivity` clears `inFlight` the wedged branch no longer matches it either). Sessions already
   * tearing down (`#closing`) or awaiting reconfirm (`#unconfirmed`) are skipped so the reap can't re-run a
   * close-first teardown on them.
   */
  async reapIdle(
    ttlMs: number,
    now: number = Date.now(),
    maxInFlightMs: number = MAX_INFLIGHT_MS,
  ): Promise<string[]> {
    const stale = [...this.#sessions.values()].filter(
      (s) =>
        !this.#closing.has(s.id) &&
        !this.#unconfirmed.has(s) &&
        ((s.consumerId !== undefined && s.inFlight === 0 && now - s.lastActivityAt > ttlMs) ||
          (s.inFlight > 0 && s.inFlightMs(now) > maxInFlightMs)),
    );
    // Swallow per-session teardown failures: reapIdle is driven fire-and-forget from the reaper's
    // setInterval, so nothing here may surface as an unhandled rejection. (release() already never rejects.)
    await Promise.all(stale.map((s) => this.release(s.id).catch(() => {})));
    await this.#drainUnconfirmed();
    return stale.map((s) => s.id);
  }

  /** Start a background timer that reaps idle sessions every `intervalMs`. Idempotent. `maxInFlightMs`
   *  bounds the in-flight guard so a wedged verb is reclaimed rather than pinning a browser forever. */
  startReaper(ttlMs: number, intervalMs: number, maxInFlightMs: number = MAX_INFLIGHT_MS): void {
    this.stopReaper();
    const timer = setInterval(() => void this.reapIdle(ttlMs, Date.now(), maxInFlightMs), intervalMs);
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

  /**
   * Close every session and clear the registry — no orphaned browsers left behind (issue #50).
   *
   * Sets `#shuttingDown` first so `acquire()` admits no replacement mid-drain, then AWAITS in-flight
   * acquire launches (`#launching`) so a launch racing shutdown can't register (or self-tear-down) a
   * browser after the scan. It then AWAITS the REAL teardowns — the in-flight ones already in `#closing`
   * plus a fresh teardown for every remaining session — rather than a bounded wait, so it never returns
   * while a force-kill is still pending, and finally drains any unconfirmed kills. On prod the container
   * namespace teardown (`docker rm -f`) reaps Chrome regardless; this full await is the CLI path's only
   * no-orphan guarantee.
   */
  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    this.stopReaper();
    await Promise.allSettled([...this.#launching]);
    const remaining = [...this.#sessions.values()].filter(
      (s) => !this.#closing.has(s.id) && !this.#unconfirmed.has(s),
    );
    await Promise.all([
      ...this.#closing.values(),
      ...remaining.map((s) => this.#beginTeardown(s)),
    ]);
    // Retry the kill-only reconfirm a bounded number of times so a just-SIGKILL'd process that wasn't
    // reapable on the first probe gets a few more chances within shutdown. Bounded so an UNAVAILABLE
    // force-kill (kill rejects fast) can't spin forever.
    for (let i = 0; i < SHUTDOWN_RECONFIRM_TRIES && this.#unconfirmed.size > 0; i++) {
      await this.#drainUnconfirmed();
    }
    // Do NOT unconditionally clear the maps (issue #50): a confirmed teardown already removed itself from
    // #sessions/#closing/#unconfirmed, so anything STILL present is a browser we could not confirm dead.
    // Erasing it would report a clean shutdown (activeCount 0) while a process may be alive — the exact
    // invariant this ticket exists to hold. Retain it (honest accounting) and surface it loudly; on prod
    // the container namespace teardown reaps it regardless, and on the CLI a best-effort SIGKILL was sent.
    if (this.#unconfirmed.size > 0) {
      process.stderr.write(
        `[browse-gateway] shutdown: ${this.#unconfirmed.size} browser teardown(s) could not be confirmed dead ` +
          `(best-effort SIGKILL sent); accounting retained (unconfirmedCount)\n`,
      );
    }
  }
}
