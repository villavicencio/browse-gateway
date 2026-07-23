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
import { defaultOrphanDirOps } from "./orphan-sweep.js";
import type { OrphanDirOps } from "./orphan-sweep.js";

export type CoreFactory = (opts: BrowserCoreOptions) => Promise<BrowserCore>;

/**
 * One live ORPHAN — a launch that consumed real OS resources without becoming a registered session
 * (issue #54 Part 2): a WEDGED launch (dir only — maybe a half-spawned Chromium findable via the dir
 * sweep), a launch that RESOLVED late (a real core, torn down best-effort), a failed launch whose dir
 * may hold a straggler, or a shutdown-race self-teardown. Counted in {@link SessionManager.activeCount}
 * until CONFIRMED reclaimed, so capacity never lies about live browsers — the acquire gate back-pressures
 * instead (truthful: the processes exist and hold RSS/pids).
 */
interface OrphanRecord {
  /** The gateway-owned (mkdtemp'd) profile dir; absent when the launch used a caller-supplied or
   *  patchright-owned dir — those are never swept or removed. */
  dir?: string;
  /** Set once a late-resolving core arrived — its confirmable teardown then owns the record and the
   *  dir sweep skips it (the two kill paths converge, but only one should drive the record's fate). */
  session?: Session;
  /** Single-flight latch so a reaper tick racing shutdown can't run two sweeps over one dir. */
  sweeping?: boolean;
}

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

/**
 * Ceiling on how long a single browser-core factory launch (`chromium.launchPersistentContext` + any
 * restore-state seed) may run before it's treated as WEDGED (an Xvfb wedge, a `launchPersistentContext`
 * that never resolves) and failed as `CORE_LAUNCH`, releasing its reserved capacity slot (issue #54). A
 * healthy cold headful launch resolves in single-digit seconds even on a busy host, so 2 min unambiguously
 * means "stuck" — and bounding it is what stops a hung launch from pinning a `#reserved` slot toward a
 * permanent `SESSION_LIMIT` (the reaper only scans `#sessions`, never reserved launches). Reaping any
 * half-spawned Chromium orphaned under the still-pending launch is a separate spike (#54 Part 2 — it needs
 * a spawn-side PID hook the post-resolve capture can't provide). Not env-overridable by design (ticket
 * #43); `SessionManagerOptions.launchDeadlineMs` overrides it for tests.
 */
export const LAUNCH_DEADLINE_MS = 120_000;

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
  /** Bounded deadline for a single core factory launch before it's failed as `CORE_LAUNCH` and its
   *  reserved slot released (issue #54). Default {@link LAUNCH_DEADLINE_MS}; overridable for tests. */
  launchDeadlineMs?: number;
  /** Gateway-owned profile-dir lifecycle (mint / sweep-by-dir / remove — issue #54 Part 2). Default
   *  {@link defaultOrphanDirOps} (real mkdtemp + /proc sweep + rm); injectable for tests. */
  orphanDirOps?: OrphanDirOps;
}

export class SessionManager {
  readonly #sessions = new Map<string, Session>();
  readonly #maxSessions: number;
  readonly #perConsumerMax: number;
  readonly #coreOptions: BrowserCoreOptions;
  readonly #factory: CoreFactory;
  readonly #closeGraceMs: number;
  readonly #killConfirmMs: number;
  readonly #launchDeadlineMs: number;
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
  readonly #dirOps: OrphanDirOps;
  /** Gateway-owned ephemeral profile dirs of REGISTERED sessions, removed only after the session's
   *  teardown CONFIRMS death (a SIGKILL'd/patchright-owned profile was a silent disk leak before —
   *  patchright removes only its own temp dirs, and never on a kill). Issue #54 Part 2. */
  readonly #ownedDirs = new Map<Session, string>();
  /** The live-orphan ledger (issue #54 Part 2) — see {@link OrphanRecord}. Every entry is counted in
   *  {@link activeCount}; entries leave only on a CONFIRMED reclaim (sweep/teardown/reconfirm) or the
   *  loud unsupported-platform degrade. */
  readonly #orphans = new Set<OrphanRecord>();
  /** In-flight orphan work (late-orphan teardowns, dir sweeps, dir removals) — each internally bounded;
   *  `shutdown()` awaits them so the no-orphan drain covers this path too (the Part-1 deferral). */
  readonly #orphanWork = new Set<Promise<void>>();

  constructor(opts: SessionManagerOptions) {
    this.#maxSessions = opts.maxSessions;
    this.#perConsumerMax = opts.perConsumerMax ?? 1;
    this.#coreOptions = opts.coreOptions ?? {};
    this.#factory = opts.coreFactory ?? createBrowserCore;
    this.#closeGraceMs = opts.closeGraceMs ?? CLOSE_GRACE_MS;
    this.#killConfirmMs = opts.killConfirmMs ?? KILL_CONFIRM_MS;
    this.#launchDeadlineMs = opts.launchDeadlineMs ?? LAUNCH_DEADLINE_MS;
    this.#dirOps = opts.orphanDirOps ?? defaultOrphanDirOps;
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

  /** Everything occupying a capacity slot: registered sessions — including mid-teardown (`#closing`)
   *  and unconfirmed force-kills (`#unconfirmed`), counted until death confirms — PLUS live orphans
   *  (`#orphans`: wedged/late/failed launches not yet confirmed reclaimed, issue #54 Part 2), so this
   *  never under-reports live browsers. It CAN transiently exceed {@link maxSessions} (a replacement
   *  took a freed slot before a late orphan surfaced) — that is the truthful state, and the acquire
   *  gate back-pressures on it until the orphan drains. */
  get activeCount(): number {
    return this.#sessions.size + this.#orphans.size;
  }

  /** Count of live orphans (issue #54 Part 2) — launches that consumed OS resources without becoming a
   *  registered session, counted in {@link activeCount} until confirmed reclaimed. The health-surface
   *  primitive alongside {@link unconfirmedCount}. */
  get orphanCount(): number {
    return this.#orphans.size;
  }

  get maxSessions(): number {
    return this.#maxSessions;
  }

  list(): SessionInfo[] {
    return [...this.#sessions.values()].map((s) => s.info);
  }

  /** Whether every live core can be force-killed (issue #50). False means at least one session's core
   *  degraded to graceful-close-only (no Chromium PID / Linux generation marker captured at launch).
   *  Exposed as the primitive for an operational health surface (wiring tracked as a follow-up); today a
   *  degradation also emits a loud launch-time stderr line. */
  get forceKillAvailable(): boolean {
    for (const s of this.#sessions.values()) if (!s.forceKillAvailable) return false;
    return true;
  }

  /** Count of browsers whose death could NOT be confirmed — a best-effort SIGKILL was sent but neither a
   *  clean close nor an ESRCH confirmed the process is gone (issue #50). Retained (never erased) so a
   *  possibly-alive orphan is accounted for; the reaper's reconfirm loop keeps retrying these. Non-zero
   *  means a browser may still be alive despite its teardown. Exposed as the primitive for an operational
   *  health surface (wiring tracked as a follow-up). */
  get unconfirmedCount(): number {
    return this.#unconfirmed.size;
  }

  /**
   * Create a new session. Rejects with `SESSION_LIMIT` when the global ceiling is reached, when
   * `meta.consumerId` is set and that consumer is already at its per-consumer cap (so one consumer can't
   * hold open more than its share of drive sessions), or when the manager is shutting down. Rejects with
   * `CORE_LAUNCH` when the browser fails to start OR when the launch wedges past `#launchDeadlineMs` (issue
   * #54) — either way the `finally` releases the reserved slot, so a hung launch never pins capacity toward
   * a permanent `SESSION_LIMIT`. The global ceiling counts in-flight launches (reserved slots), so
   * concurrent `acquire()` calls can't overshoot, and a launch failure never leaves a leaked/half-counted
   * session.
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
    // #54 Part 2: gate on activeCount (registered + live orphans), not #sessions alone — a wedged/late
    // orphan holds real RSS/pids, so admitting a replacement on top of it would let live browsers exceed
    // the cap the resource control exists for. Truthful back-pressure: the orphan drains (bounded sweep /
    // teardown), then capacity frees.
    if (this.activeCount + this.#reserved >= this.#maxSessions) {
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
   * launch is a single tracked promise in `#launching`. The factory launch is raced against
   * `#launchDeadlineMs` so a wedged `launchPersistentContext` fails as `CORE_LAUNCH` instead of pinning its
   * reserved slot forever (issue #54). Re-checks `#shuttingDown` AFTER the (possibly slow) factory launch:
   * if shutdown began while the core was launching, the just-launched browser is
   * torn down (close→confirmed-kill) and NEVER registered, so it can't outlive shutdown as an orphan.
   * The re-check and `#sessions.set` are synchronous-contiguous (no await between them), so an acquire
   * that observes "not shutting down" registers atomically before any concurrent shutdown could
   * interleave — and it is in `#launching`, so shutdown awaits it and then sees the registered session.
   */
  async #launchAndRegister(
    overrides?: BrowserCoreOptions,
    meta?: { consumerId?: string },
  ): Promise<Session> {
    // Always a fresh object — the dir injection below must never mutate the shared #coreOptions.
    const coreOptions: BrowserCoreOptions = { ...this.#coreOptions, ...(overrides ?? {}) };
    // #54 Part 2: OWN the ephemeral profile dir. `""`/unset means "fresh ephemeral profile"; a
    // gateway-minted mkdtemp dir keeps that exact contract (unique per launch, never reused — so it
    // can't shadow vault-seeded restoreState) while making the launch's Chromium FINDABLE
    // (`--user-data-dir=<dir>` on its cmdline) if the launch wedges pre-resolve, and giving the
    // profile a confirmed-death removal hook (patchright removes only its OWN temp dirs, and never on
    // a SIGKILL — both were silent disk leaks). A caller-supplied non-empty dir is respected: never
    // injected over, never swept, never removed. Mint failure degrades to Part-1 semantics
    // (patchright-owned dir, no sweep key) — availability over hygiene, loudly.
    let ownedDir: string | undefined;
    if (!coreOptions.userDataDir) {
      try {
        ownedDir = await this.#dirOps.make();
        coreOptions.userDataDir = ownedDir;
      } catch (err) {
        process.stderr.write(
          `[browse-gateway] profile-dir mint failed (${err instanceof Error ? err.message : "error"}); ` +
            `launching with a patchright-owned ephemeral dir (no orphan sweep key for this launch)\n`,
        );
      }
    }
    // Bound the factory launch so a WEDGED `launchPersistentContext` (Xvfb wedge, a launch that never
    // resolves) can't pin its reserved slot forever (issue #54). Attaching `.then(onF, onR)` to `launchP`
    // handles its eventual rejection on BOTH arms, so an abandoned wedged launch that rejects late can't
    // surface as an unhandled rejection. The reserved-slot release is NOT done here — `acquire`'s `finally`
    // already decrements `#reserved`/`#reservedByConsumer` and drops the tracked `#launching` entry when
    // THIS promise settles, so rejecting on the deadline is what frees the slot. A never-returning
    // half-spawned Chromium (no core, no PID) is #54 Part 2; a launch that RESOLVES late IS reaped below.
    let launchP: Promise<BrowserCore>;
    try {
      launchP = this.#factory(coreOptions);
    } catch (cause) {
      // A factory that throws SYNCHRONOUSLY (before returning its promise) must still surface as the
      // documented CORE_LAUNCH, not a raw error (issue #54, codex r1). The async-rejection path is
      // normalized by the `.then(onR)` arm below; this try guards the synchronous throw the race can't see.
      throw new SessionManagerError("CORE_LAUNCH", "browser core failed to launch", { cause });
    }
    const deadline = deadlineTimer(this.#launchDeadlineMs);
    const outcome = await Promise.race([
      launchP.then(
        (c) => ({ kind: "launched" as const, core: c }),
        (cause) => ({ kind: "failed" as const, cause }),
      ),
      deadline.promise.then(() => ({ kind: "timeout" as const })),
    ]);
    deadline.clear(); // don't leave the launch-deadline timer dangling on the common fast-launch path
    if (outcome.kind === "failed") {
      // #54 Part 2: a REJECTED launch usually means Chromium exited — but "usually" is not "confirmed".
      // Enqueue the owned dir as an orphan and let the sweep decide: an empty scan confirms instantly
      // (rec dropped, dir removed); a straggler process is killed + confirmed like a wedge.
      if (ownedDir !== undefined) this.#enqueueOrphan({ dir: ownedDir });
      throw new SessionManagerError("CORE_LAUNCH", "browser core failed to launch", { cause: outcome.cause });
    }
    if (outcome.kind === "timeout") {
      // The deadline won and the reserved slot is released (acquire's `finally`). The launch becomes a
      // LIVE ORPHAN (issue #54 Part 2): counted in activeCount until confirmed reclaimed, so a
      // replacement admitted into the freed slot can't stack live browsers past the cap. Two reclaim
      // paths converge on the one record:
      //  - the DIR SWEEP (reaper tick + the immediate kick below) kills whatever half-spawned Chromium
      //    carries the owned dir on its cmdline and confirms via the /proc generation discipline — the
      //    spawn-side hook a never-resolving launch needs (no core, no PID for #50's capture);
      //  - a LATE RESOLVE upgrades the record with the real core and runs the confirmable teardown
      //    (an unconfirmed close goes to `#unconfirmed` for the reaper's reconfirm; the record stays
      //    counted until that confirms).
      // A late REJECTION is swallowed (the sweep owns the record). Both paths are tracked in
      // `#orphanWork`, which shutdown() drains — closing the Part-1 no-orphan deferral.
      const rec: OrphanRecord = ownedDir !== undefined ? { dir: ownedDir } : {};
      this.#enqueueOrphan(rec);
      void launchP.then(
        (lateCore) => this.#reapLateLaunch(lateCore, rec),
        () => {}, // swallow a late rejection (already handled by the race's `.then(onR)` arm) — never unhandled
      );
      throw new SessionManagerError(
        "CORE_LAUNCH",
        `browser core launch exceeded ${this.#launchDeadlineMs}ms deadline`,
      );
    }
    const core = outcome.core;
    if (this.#shuttingDown) {
      // Never register once shutdown began. Tear down the orphan (close→confirmed-kill); if the kill
      // can't confirm, hand it to `#unconfirmed` so shutdown's drain reclaims it. It was never in
      // `#sessions`, so this is no-orphan hygiene (the CLI path) — #54 Part 2 gives it an OrphanRecord
      // so its dir is removed on confirm and shutdown's drain covers the teardown.
      const orphan = new Session(core);
      const rec: OrphanRecord = { session: orphan, ...(ownedDir !== undefined ? { dir: ownedDir } : {}) };
      this.#orphans.add(rec);
      try {
        await orphan.teardown(this.#closeGraceMs, this.#killConfirmMs);
        await this.#finalizeOrphan(rec);
      } catch {
        this.#unconfirmed.add(orphan); // rec stays counted; the reconfirm drain finalizes it
      }
      throw new SessionManagerError("SESSION_LIMIT", "session manager is shutting down");
    }
    const session = new Session(core, meta?.consumerId ? { consumerId: meta.consumerId } : {});
    if (ownedDir !== undefined) this.#ownedDirs.set(session, ownedDir);
    this.#sessions.set(session.id, session);
    return session;
  }

  /** Add an orphan record and kick an immediate best-effort sweep (the reaper retries on its tick). */
  #enqueueOrphan(rec: OrphanRecord): void {
    this.#orphans.add(rec);
    void this.#sweepOrphan(rec);
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
  /**
   * Confirmable teardown of a core from a launch that RESOLVED after its deadline (issue #54 Part 2).
   * The acquire that started it already rejected and released its reserved slot, so this never registers
   * a session — but the record stays COUNTED in `activeCount` until death confirms (a replacement may
   * already hold the freed slot; the live orphan must not be capacity the gate can't see). Upgrades the
   * wedge record with the real session so the dir sweep stands down; on an unconfirmed force-kill the
   * orphan goes to `#unconfirmed` (reconfirm loop), record retained. Tracked in `#orphanWork` so
   * `shutdown()` drains it (each teardown internally bounded to ~closeGraceMs + killConfirmMs).
   */
  #reapLateLaunch(core: BrowserCore, rec: OrphanRecord): Promise<void> {
    const orphan = new Session(core);
    rec.session = orphan; // the confirmable teardown owns the record now; a mid-flight sweep stands down
    this.#orphans.add(rec); // re-add if a completed sweep already dropped it (a set add is idempotent)
    const work = (async () => {
      try {
        await orphan.teardown(this.#closeGraceMs, this.#killConfirmMs);
        await this.#finalizeOrphan(rec);
      } catch {
        this.#unconfirmed.add(orphan); // rec stays counted; the reconfirm drain finalizes it
      }
    })();
    return this.#trackOrphanWork(work);
  }

  /** Track a bounded orphan-work promise so `shutdown()`'s drain awaits it; self-removes on settle. */
  #trackOrphanWork(work: Promise<void>): Promise<void> {
    this.#orphanWork.add(work);
    void work.finally(() => this.#orphanWork.delete(work)).catch(() => {});
    return work;
  }

  /**
   * CONFIRMED reclaim of an orphan: remove its gateway-owned dir (best-effort — a leaked DIR is disk
   * hygiene, never a reason to keep holding a capacity slot) and drop the record from the ledger.
   */
  async #finalizeOrphan(rec: OrphanRecord): Promise<void> {
    this.#orphans.delete(rec);
    if (rec.dir !== undefined) {
      const dir = rec.dir;
      rec.dir = undefined; // never remove twice
      await this.#dirOps.remove(dir).catch((err) => {
        process.stderr.write(
          `[browse-gateway] orphan profile-dir removal failed (${err instanceof Error ? err.message : "error"})\n`,
        );
      });
    }
  }

  /**
   * One bounded sweep attempt over a dir-only orphan (issue #54 Part 2): kill-and-confirm whatever the
   * wedged launch spawned under the owned profile dir (see {@link import("./orphan-sweep.js")}), then
   * finalize on confirm. Single-flight per record; stands down once a late-resolved session owns the
   * record. `"unsupported"` (no /proc — macOS dev) degrades LOUDLY to Part-1 semantics: uncount the
   * record rather than pin a capacity slot forever on a platform that cannot confirm (prod is the Linux
   * container, where the sweep is real). `"unconfirmed"` keeps the record counted; the reaper retries.
   */
  #sweepOrphan(rec: OrphanRecord): Promise<void> {
    if (rec.sweeping || rec.session !== undefined || !this.#orphans.has(rec)) return Promise.resolve();
    if (rec.dir === undefined) {
      // No sweep key (mint failed / caller-supplied dir launch): nothing findable — Part-1 semantics.
      this.#orphans.delete(rec);
      return Promise.resolve();
    }
    rec.sweeping = true;
    const dir = rec.dir;
    const work = this.#dirOps.sweep(dir, this.#killConfirmMs).then(
      async (result) => {
        rec.sweeping = false;
        if (rec.session !== undefined) return; // a late core arrived mid-sweep — its teardown owns the record
        if (result === "confirmed") {
          await this.#finalizeOrphan(rec);
          return;
        }
        if (result === "unsupported") {
          process.stderr.write(
            "[browse-gateway] orphan sweep unsupported on this platform (no /proc); releasing the " +
              "capacity slot WITHOUT confirming the wedged launch's process tree (Part-1 semantics — " +
              "any half-spawned Chromium and its profile dir leak until system cleanup)\n",
          );
          this.#orphans.delete(rec);
          return;
        }
        // "unconfirmed": something still lives (e.g. a D-state unkillable). Stay counted — the #50
        // never-lie posture — and let the next reaper tick retry.
      },
      () => {
        rec.sweeping = false; // sweep errored — retry on the next tick
      },
    );
    return this.#trackOrphanWork(work);
  }

  #beginTeardown(session: Session): Promise<void> {
    const existing = this.#closing.get(session.id);
    if (existing) return existing;
    if (this.#unconfirmed.has(session)) return Promise.resolve();
    const done = session.teardown(this.#closeGraceMs, this.#killConfirmMs).then(
      () => {
        // CONFIRMED dead → free the slot now, and only now. #54 Part 2: the confirmed death is also the
        // removal hook for the session's gateway-owned profile dir (never earlier — a live browser writes it).
        this.#sessions.delete(session.id);
        this.#closing.delete(session.id);
        this.#removeOwnedDir(session);
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

  /** Remove a REGISTERED session's gateway-owned profile dir after its death confirmed (issue #54
   *  Part 2). Best-effort + tracked in `#orphanWork` so shutdown's drain covers an in-flight removal.
   *  No-op for a session that had no owned dir (caller-supplied / mint-failed launch). */
  #removeOwnedDir(session: Session): void {
    const dir = this.#ownedDirs.get(session);
    if (dir === undefined) return;
    this.#ownedDirs.delete(session);
    void this.#trackOrphanWork(
      this.#dirOps.remove(dir).catch((err) => {
        process.stderr.write(
          `[browse-gateway] profile-dir removal failed (${err instanceof Error ? err.message : "error"})\n`,
        );
      }),
    );
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
          async () => {
            this.#sessions.delete(s.id); // no-op for an orphan never registered
            this.#unconfirmed.delete(s);
            // #54 Part 2: confirmed death frees the profile dir + orphan slot too — a registered
            // session's owned dir, or an anchorless orphan's ledger record (whichever this was).
            this.#removeOwnedDir(s);
            const rec = [...this.#orphans].find((r) => r.session === s);
            if (rec) await this.#finalizeOrphan(rec);
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
    // #54 Part 2: retry the dir sweep over any dir-only orphan still counted (a wedged launch whose
    // first sweep couldn't confirm, or one enqueued between ticks). Single-flight per record.
    await Promise.all([...this.#orphans].map((rec) => this.#sweepOrphan(rec).catch(() => {})));
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
    // AWAIT in-flight launches to COMPLETION so a launch racing shutdown self-tears-down (registers→torn-down,
    // or fails) rather than orphaning a browser — the #50 no-orphan guarantee. This needs NO separate shutdown
    // timer: every `#launching` entry already settles within `#launchDeadlineMs` because `#launchAndRegister`
    // races the factory launch against that deadline internally (a wedged-forever launch throws CORE_LAUNCH at
    // the deadline), so `allSettled` cannot hang. Awaiting each entry to completion — NOT truncating at a
    // shorter shutdown bound — is what lets a launch that resolved into a shutdown-orphan teardown finish its
    // close→confirmed-kill instead of leaving detached Chrome behind when the caller `process.exit`s after
    // shutdown (codex #54 r4). #54 Part 2: the in-flight ORPHAN work (late-orphan teardowns, dir sweeps,
    // dir removals — each internally bounded) is drained right after, closing the Part-1 deferral.
    await Promise.allSettled([...this.#launching]);
    await Promise.allSettled([...this.#orphanWork]);
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
    // #54 Part 2: one final sweep pass over any dir-only orphan still counted (a wedge whose earlier
    // sweep couldn't confirm, or one enqueued during the drain), bounded per record by killConfirmMs;
    // then drain the dir removals/teardowns that pass spawned.
    await Promise.allSettled([...this.#orphans].map((rec) => this.#sweepOrphan(rec)));
    await Promise.allSettled([...this.#orphanWork]);
    // Do NOT unconditionally clear the maps (issue #50): a confirmed teardown already removed itself from
    // #sessions/#closing/#unconfirmed, so anything STILL present is a browser we could not confirm dead.
    // Erasing it would report a clean shutdown (activeCount 0) while a process may be alive — the exact
    // invariant this ticket exists to hold. Retain it (honest accounting) and surface it loudly; on prod
    // the container namespace teardown reaps it regardless, and on the CLI a best-effort SIGKILL was sent.
    if (this.#orphans.size > 0) {
      process.stderr.write(
        `[browse-gateway] shutdown: ${this.#orphans.size} orphaned launch(es) could not be confirmed ` +
          `reclaimed (accounting retained — orphanCount)\n`,
      );
    }
    if (this.#unconfirmed.size > 0) {
      process.stderr.write(
        `[browse-gateway] shutdown: ${this.#unconfirmed.size} browser teardown(s) could not be confirmed dead ` +
          `(best-effort SIGKILL sent); accounting retained (unconfirmedCount)\n`,
      );
    }
  }
}

/** A cancellable deadline: `promise` resolves after `ms`; `clear()` cancels the timer so the common path
 *  (the launch resolves, or shutdown drains its launches) doesn't leave it dangling. NOT unref'd — like the
 *  teardown grace timer (issue #50), this is a FOREGROUND awaited timer: it is the trigger that unblocks a
 *  wedged launch and a shutdown waiting on one (issue #54), so it must keep the event loop alive until it
 *  fires or is cleared; an unref'd timer would let the loop empty mid-await and the operation would hang
 *  forever. It always fires or is cleared within one deadline window, so it never lingers. */
function deadlineTimer(ms: number): { promise: Promise<void>; clear: () => void } {
  let handle: ReturnType<typeof setTimeout>;
  const promise = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, ms);
  });
  return { promise, clear: () => clearTimeout(handle) };
}
