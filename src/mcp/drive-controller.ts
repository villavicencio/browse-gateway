/**
 * Concrete {@link DriveController}: binds the stateful drive verbs to the gateway and one consumer
 * token, tracking the current session handle. It lazily opens the session on the first navigate/open,
 * reuses it across verbs, and closes it on demand. Errors are scrubbed of BYO secret material (R9);
 * a session that was idle-reaped out from under us is detected and the handle reset so the next
 * navigate transparently reopens. Action verbs return the post-action snapshot.
 *
 * Proxy posture is escalate-on-block (matching retrieve, not always-on): the first navigate goes
 * DIRECT, and only escalates to a proxied residential exit if direct is blocked — and only on that
 * first navigate, before any interaction, because a stateful session can't swap its exit mid-flow
 * without losing page state (KTD-5). The proxy override is resolved fresh per open, so a secret
 * rotation takes effect on the next session.
 */
import { isHttpUrl, redactSecrets } from "../security/index.js";
import type { SecretStore } from "../security/index.js";
import type { Gateway, Session } from "../gateway/index.js";
import { DEFAULT_CALL_TIMEOUTS } from "../gateway/index.js";
import type { CallTimeouts } from "../gateway/index.js";
import { DIAGNOSTICS_EGRESS_HOSTS } from "../policy/index.js";
import type { BrowserCoreOptions, DriveTarget, PageSnapshot, WaitCondition } from "../browser/index.js";
import {
  proxyOverrideFor,
  navFailed,
  shouldEscalateDrive,
  proxyFromSecrets,
  escalationDiagnostics,
  classifyFailure,
  wafVendorFromFailure,
  EscalationError,
  hostForcesProxy,
  classifyExitOrg,
  parseExitOrg,
  isDeadExit,
  MIN_ATTEMPT_BUDGET_MS,
  PROXY_CLEARANCE_TIMEOUT_MS,
} from "../verbs/index.js";
import type { EscalationDiagnostics, EgressCheck, FailureSignal, FailureClass } from "../verbs/index.js";
import { redactFailureDiagnostics, attachFailure, failureOf, sanitizeUrlForError, assembleTiming } from "../observability/index.js";
import type { FailureDiagnostics } from "../observability/index.js";
import { buildWarmOverride } from "./vault-login.js";
import type { VaultEntryStore } from "./vault-login.js";
import type { DriveController } from "./server.js";

/** The egress probe renders an ip-info JSON endpoint on the policy-owned approved diagnostics host
 *  ({@link DIAGNOSTICS_EGRESS_HOSTS}) — single source of truth, so the probe URL can't drift from the
 *  host the diagnostics guard actually permits. */
const EXIT_INFO_URL = `https://${DIAGNOSTICS_EGRESS_HOSTS[0]}/json`;

export class GatewayDriveController implements DriveController {
  #handle?: string;
  /** True once the current session's first navigate landed a page — its exit/mode is committed. */
  #pinned = false;
  /** Whether the current session was opened proxied (vs direct) — drives reopen-after-reap + messaging. */
  #proxiedSession = false;
  /**
   * Canonical owner host of the current WARM (vault-restored) session, or undefined for a cold one.
   * Set the moment a warm session opens (from its sealed `restoreState.ownerHost`); drives re-warming
   * across an idle reap so a logged-in session is restored on reopen instead of silently downgrading
   * to a cold (logged-out) one. Cleared on discard/close.
   */
  #warmHost?: string;
  readonly #gateway: Gateway;
  readonly #secrets: SecretStore;
  readonly #token: string;
  /** Whether we run on a datacenter IP — the gate (with a configured proxy) for proxied sessions. */
  readonly #onDatacenterIp: boolean;
  /** Sticky-session suffix template (deployment config) — each resolve mints a fresh held exit. */
  readonly #stickySuffix?: string;
  /** Host suffixes that force residential from the first request (BGW_FORCE_PROXY_HOSTS). */
  readonly #forceProxyHosts: readonly string[];
  /** Owner-host suffixes whose warm-open navigates a shallow page FIRST (BGW_WARMUP_HOSTS) so a
   *  behavioral WAF (PerimeterX) issues a clearance token before the consumer's deep target. */
  readonly #warmupHosts: readonly string[];
  /** Shallow same-owner relative paths the warm-up navigates before the target (BGW_WARMUP_PATHS;
   *  default `["/"]`). Every path is a boot-validated same-host absolute path (see parseWarmupPaths). */
  readonly #warmupPaths: readonly string[];
  /** Optional progress log (stderr in prod, omitted in tests) for warm-up hop outcomes. */
  readonly #log?: (msg: string) => void;
  /** Host suffixes whose warm-open uses a FRESH residential exit instead of re-pinning the captured one
   *  (BGW_WARM_FRESH_EXIT_HOSTS) — the durable fix for exit-reputation-gated hosts whose bound sticky
   *  exit decays/burns. The captured stickyExitId is ignored for these; a fresh held exit is minted. */
  readonly #freshExitHosts: readonly string[];
  /** Opt-in: on an escalation failure, probe the proxy's exit and classify residential vs datacenter. */
  readonly #verifyEgressEnabled: boolean;
  /** #45: env-overridable per-call time bounds (issue #43), now consumed by the drive escalation loop —
   *  the global wall-clock budget + the proxied re-roll count / nav / clearance timeouts. Defaults to the
   *  shipped constants, so a controller built without them behaves exactly as before. */
  readonly #timeouts: CallTimeouts;
  /**
   * Encrypted credential store (U9 warm-open), or null/undefined when the vault is dormant
   * (BGW_VAULT_DIR unset) or this controller was constructed without vault wiring. Warm-open only
   * activates when the vault, the consumer id, AND the allowlist are all present.
   */
  readonly #vault?: VaultEntryStore | null;
  /** This controller's consumer id — one half of the vault entry key (the other is the host). */
  readonly #consumerId?: string;
  /** This consumer's allowlist — warm-open only restores a credential for an APPROVED host (the same
   *  allowlist the gateway's nav guard clamps to, so the warm gate and the guard agree). */
  readonly #allowlist?: { allows(host: string): boolean };

  constructor(
    gateway: Gateway,
    secrets: SecretStore,
    token: string,
    opts: {
      onDatacenterIp?: boolean;
      stickySuffix?: string;
      forceProxyHosts?: readonly string[];
      freshExitHosts?: readonly string[];
      /** Warm-up navigation (BGW_WARMUP_HOSTS / BGW_WARMUP_PATHS): on warm-open to a matching owner
       *  host, navigate the shallow path(s) first so the edge WAF issues a clearance token before the
       *  deep target. Absent/empty hosts → no warm-up (the default; non-regression). */
      warmupHosts?: readonly string[];
      warmupPaths?: readonly string[];
      /** Optional progress log for warm-up hop outcomes (prod entrypoints pass their stderr logger). */
      log?: (msg: string) => void;
      verifyEgress?: boolean;
      /** #45: env-overridable per-call time bounds (issue #43). Omitted → the shipped defaults (unchanged). */
      timeouts?: CallTimeouts;
      /** Warm-open (U9): the encrypted vault, this consumer's id, and its allowlist. All three are
       *  required for warm-open to activate; any omitted keeps every session cold (the default). */
      vault?: VaultEntryStore | null;
      consumerId?: string;
      allowlist?: { allows(host: string): boolean };
    } = {},
  ) {
    this.#gateway = gateway;
    this.#secrets = secrets;
    this.#token = token;
    this.#onDatacenterIp = opts.onDatacenterIp ?? false;
    this.#stickySuffix = opts.stickySuffix;
    this.#forceProxyHosts = opts.forceProxyHosts ?? [];
    this.#freshExitHosts = opts.freshExitHosts ?? [];
    this.#warmupHosts = opts.warmupHosts ?? [];
    this.#warmupPaths = opts.warmupPaths ?? ["/"];
    this.#log = opts.log;
    this.#verifyEgressEnabled = opts.verifyEgress ?? false;
    this.#timeouts = opts.timeouts ?? DEFAULT_CALL_TIMEOUTS;
    this.#vault = opts.vault;
    this.#consumerId = opts.consumerId;
    this.#allowlist = opts.allowlist;
  }

  /**
   * Resolve the proxy override fresh from the (possibly rotated) secret store on every session open,
   * so a `SecretStore.reload()` takes effect on the next session instead of being frozen at
   * construction. Returns the residential-proxy override when one is configured AND we're on a
   * datacenter IP, else undefined (direct). With a sticky suffix configured, every call also mints a
   * FRESH sticky session (a fresh held exit) — so resolve per attempt, never cache across attempts.
   */
  #resolveProxyOverride(): BrowserCoreOptions | undefined {
    return proxyOverrideFor(this.#secrets, this.#onDatacenterIp, this.#stickySuffix);
  }

  /**
   * The reduced-surface {@link FailureSignal} a drive snapshot presents to the shared classifier: the
   * accessibility `tree` stands in for visible text, plus the carried cfHint/pxHint/ddHint booleans
   * (issue #40) and the landed `finalUrl` (so classifyFailure catches a stale-status chrome-error dead nav,
   * codex #41 r1). The SINGLE builder so escalation diagnostics and the failure-envelope class/vendor read
   * the same signal and can't drift from each other (the drive↔retrieve detection-parity invariant). The
   * retrieve-only content signals (frameworkRoot/networkFailed) stay unset — the drive path never reaches
   * classifyFailure's content arm (a thin-200 shell is a returnable snapshot, never a drive failure).
   */
  #signalOf(snap: PageSnapshot): FailureSignal {
    return {
      title: snap.title,
      text: snap.tree,
      status: snap.status ?? null,
      cfHint: snap.cfHint,
      pxHint: snap.pxHint,
      ddHint: snap.ddHint,
      captchaKind: snap.captchaKind,
      finalUrl: snap.url,
    };
  }

  /**
   * Build structured escalation diagnostics from the last failed snapshot, reading proxy-configured
   * straight from the (possibly rotated) secret store. The drive snapshot's accessibility `tree` is
   * the reduced text surface classification reads; cfHint/pxHint/ddHint are carried booleans. Secrets-free
   * by construction (no creds, no proxy host).
   */
  #escalationDiag(opts: {
    proxyApplied: boolean;
    forced: boolean;
    attempts: number;
    last?: PageSnapshot;
    attemptMs?: number[];
    exitCheck?: EgressCheck;
    burnedExit?: boolean;
  }): EscalationDiagnostics {
    return escalationDiagnostics({
      proxyConfigured: proxyFromSecrets(this.#secrets) !== undefined,
      proxyApplied: opts.proxyApplied,
      forced: opts.forced,
      attempts: opts.attempts,
      last: opts.last ? this.#signalOf(opts.last) : null,
      ...(opts.attemptMs ? { attemptMs: opts.attemptMs } : {}), // #42: per proxied-attempt durations
      ...(opts.exitCheck ? { exitCheck: opts.exitCheck } : {}),
      ...(opts.burnedExit ? { burnedExit: true } : {}), // #45: all exits died without reaching the site
    });
  }

  /**
   * Redact and return the failure-evidence envelope (issue #39) carried on a failed drive snapshot, for
   * attaching to a thrown failure at parity with retrieve. REDACTS at this seam (secret set scrubbed +
   * cookie/authorization stripped) since the core built the RAW envelope; undefined when the snapshot
   * carried none. The SINGLE place drive failures pull the envelope, so the redaction can't be skipped.
   *
   * Also attaches the failure CLASS (issue #41) and the mitigation vendor (issue #40) — both a PROJECTION
   * of the shared classification (never a second classifier), so class, vendor, and the
   * escalation-diagnostics reason can't disagree (codex #40 r3). Gated on {@link navFailed} — the drive
   * failure predicate (null status, a chrome-error dead nav, a visible block, or a hard block): a bare
   * post-action `snapshot()` of a healthy page (an action that threw on a stale ref / locator timeout) is
   * NOT navFailed, so classifyFailure's reason===null arm can't emit a confidently-WRONG `empty-shell` —
   * both the class and the vendor stay UNSET there (mirroring the #40 no-hints gap). The content-family
   * classes (empty-shell / hydration-failed / real-zero-results / unsupported-browser) are a RETRIEVE-path
   * concern: on the interactive drive path a thin-200 shell is a returnable snapshot, never auto-failed, so
   * this only ever attaches the block/nav subset {anti-bot-block, captcha, hard-block, nav-failed}. Both are
   * closed vocabularies → pass redaction untouched.
   */
  #failure(snap?: PageSnapshot, opts?: { budgetExceeded?: boolean; burnedExit?: boolean }): FailureDiagnostics | undefined {
    if (!snap?.diagnostics) return undefined;
    // #signalOf carries captchaKind, so classifyFailure here and #escalationDiag's reason agree on one vendor.
    const signal = this.#signalOf(snap);
    // Classify ONLY a genuine drive nav failure — navFailed is the drive failure predicate (null status,
    // a chrome-error dead nav, a visible block, or a hard block). A bare post-action snapshot of a HEALTHY
    // page (an action that threw on a stale ref / locator timeout) is NOT navFailed, so its class stays
    // unset (no confidently-wrong empty-shell). The chrome-error stale-status case is handled inside
    // classifyFailure via the signal's finalUrl (codex #41 r1/r2), so this seam just gates on navFailed.
    // #43/#45: a loop-level verdict (only the escalation loop passes these) OVERRIDES the per-signal class,
    // like retrieve's seam — budget-exhausted ⇒ `timeout`, else all-exits-dead ⇒ `burned-exit` (a refinement
    // of the nav-failed the dead final snapshot classifies as). Both carry no WAF vendor. Other #failure
    // callers pass no opts → the per-signal classification, unchanged.
    const failureClass: FailureClass | undefined = navFailed(snap)
      ? opts?.budgetExceeded
        ? "timeout"
        : opts?.burnedExit
          ? "burned-exit"
          : classifyFailure(signal)
      : undefined;
    const wafVendor = failureClass ? wafVendorFromFailure(failureClass, signal) : undefined;
    // #42: fold the snapshot's first-class per-stage Timing into the envelope at THIS surface seam (like
    // failureClass/wafVendor) so a thrown drive failure carries the wall-clock breakdown. All-numeric →
    // redaction passes it through untouched.
    const diag: FailureDiagnostics = {
      ...snap.diagnostics,
      ...(failureClass ? { failureClass } : {}),
      ...(wafVendor ? { wafVendor } : {}),
      ...(snap.timing ? { timing: snap.timing } : {}),
      // #44: fold the core-computed solver eligibility + solve reason into the envelope at this seam (like
      // failureClass/wafVendor/timing), so a drive failure on a CAPTCHA page reports WHY the solve didn't
      // complete and whether the kind is solvable at all. Both are secret-free (closed-vocab / boolean) →
      // redaction passes them through untouched. Present only when the snapshot detected a CAPTCHA.
      ...(snap.solverEligible !== undefined ? { solverEligible: snap.solverEligible } : {}),
      ...(snap.captchaSolveReason ? { captchaSolveReason: snap.captchaSolveReason } : {}),
    };
    return redactFailureDiagnostics(diag, this.#secrets);
  }

  /**
   * Opt-in egress check (U4): open a fresh proxied session, fetch an ip-info endpoint, and classify
   * the exit as residential vs datacenter from its ASN/org. Best-effort and bounded — any failure
   * (blocked endpoint, dead exit, unparseable body) yields { kind: "unknown" } and never masks the
   * escalation error. Costs one extra proxied request, so it is off unless BGW_DIAG_VERIFY_EGRESS=1.
   */
  async #verifyEgress(): Promise<EgressCheck> {
    const override = this.#resolveProxyOverride();
    if (!override) return { kind: "unknown" };
    // A dedicated, constrained probe session: guarded to the diagnostics host ONLY (not the
    // consumer's allowlist), so a restrictive allowlist can't block egress verification and the probe
    // can reach nothing but the ip-info endpoint. Its own handle (the controller's session was already
    // discarded by the exhausted escalation loop), always closed. Any failure → unknown, never masks.
    let handle: string | undefined;
    try {
      handle = await this.#gateway.openConsumerSession(this.#token, override, { diagnostics: true });
      const render = await this.#gateway.useConsumerSession(this.#token, handle, (s) =>
        s.core.render(EXIT_INFO_URL, { clearanceTimeoutMs: PROXY_CLEARANCE_TIMEOUT_MS }),
      );
      const org = parseExitOrg(render.html);
      return { kind: classifyExitOrg(org), ...(org ? { org } : {}) };
    } catch {
      return { kind: "unknown" };
    } finally {
      if (handle) await this.#gateway.closeConsumerSession(this.#token, handle).catch(() => {});
    }
  }

  /**
   * Serialize public verb calls on this stateful controller. One MCP session maps to one
   * controller, and the transport can dispatch tool calls concurrently — two interleaved
   * navigates would both pass the `!#pinned` check and both call `#openSession`, landing two
   * browser sessions where one's handle is then lost (leak + per-consumer-cap drift). A promise
   * chain runs verbs one at a time. Internal helpers (`#run`, `#firstNavigate`, `#ensureOpen`,
   * `#openHealthyAndNavigate`, `#discardSession`) run INSIDE an already-held turn and must never
   * re-acquire — the chain is not re-entrant.
   */
  #lock: Promise<unknown> = Promise.resolve();
  #serialize<T>(fn: () => Promise<T>): Promise<T> {
    // Run after the previous turn settles regardless of outcome; keep the chain pointer on a
    // never-rejecting tail so one verb's failure can't wedge the queue.
    const run = this.#lock.then(fn, fn);
    this.#lock = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /**
   * #42: stamp the WHOLE-verb wall-clock as `timing.totalMs` on a snapshot-returning verb's result,
   * MERGING with the core stage breakdown the snapshot already carries. `t0` is captured by the caller
   * BEFORE entering {@link #serialize}, so the total is the true caller-facing latency INCLUDING any time
   * the call spent queued behind another verb (concurrent MCP dispatch) — not just its execution slice.
   * The total spans a navigate's escalation retries + warm-up, or an action's settle/solve; the core
   * snapshot alone reports only its ~tens-of-ms extraction time (the wrong number an action verb would
   * otherwise surface).
   *
   * On FAILURE the verb throws with a failure envelope attached (an EscalationError's `.failure`, or a
   * decorated error) whose `timing.totalMs` is the LAST core navigate only — which would contradict the
   * `attemptMs` array that sums the whole escalation. So override the envelope's `timing.totalMs` with the
   * whole-verb elapsed before rethrowing, keeping `totalMs >= sum(attemptMs)` (monotone) on failures too.
   * The envelope is already redacted and timing is all-numeric, so the in-place update is secret-safe.
   */
  async #timedSnap(t0: number, fn: () => Promise<PageSnapshot>): Promise<PageSnapshot> {
    try {
      const snap = await fn();
      return { ...snap, timing: assembleTiming({ ...(snap.timing ?? {}), totalMs: performance.now() - t0 }) };
    } catch (err) {
      // Ensure a failure envelope ALWAYS carries at least { totalMs } — merging existing core stages when
      // present — for parity with success snapshots and retrieve failures, even if a partial/alternate core
      // omitted the optional PageSnapshot.timing (the controller always knows the whole-verb elapsed).
      const failure = failureOf(err);
      if (failure) {
        failure.timing = assembleTiming({ ...(failure.timing ?? {}), totalMs: performance.now() - t0 });
      }
      throw err;
    }
  }

  async open(): Promise<void> {
    return this.#serialize(async () => {
      // Open a direct session lazily; escalation to a proxied exit (if needed) happens on the first
      // navigate — the only point we know whether the target blocks the direct IP.
      if (!this.#handle) await this.#openSession(undefined);
    });
  }

  async navigate(url: string, opts: { forceProxy?: boolean } = {}): Promise<PageSnapshot> {
    const t0 = performance.now(); // BEFORE #serialize — totalMs includes any queue wait (#42)
    return this.#serialize(() => this.#timedSnap(t0, () => this.#navigate(url, opts)));
  }

  async #navigate(url: string, opts: { forceProxy?: boolean }): Promise<PageSnapshot> {
    // Scheme allowlist (R14-adjacent): only http(s), rejected before any session/navigation —
    // mirrors retrieve(), so a non-http target can't slip past the host-based guard.
    if (!isHttpUrl(url)) {
      // Structural sanitize (sanitizeUrl/new URL) at the source: the requested url is a KNOWN structured
      // value, so it must never be interpolated raw — a non-canonical spelling (`https:example.com`, no
      // `//`) would slip the after-the-fact regex net (issue #39 r5).
      throw new Error(`unsupported URL scheme: only http(s) is allowed (${sanitizeUrlForError(url)})`);
    }
    // Force residential from the first request when the caller asks (forceProxy) or the host is on
    // the configured force-proxy list — for a known-hostile WAF the direct attempt only wastes a
    // round-trip and trips reputation (issue #21).
    const forced = (opts.forceProxy ?? false) || hostForcesProxy(new URL(url).hostname, this.#forceProxyHosts);
    // #45: the whole-navigate wall-clock budget (#43), absolute from HERE (post-serialize, so the queue wait
    // #timedSnap folds into totalMs is excluded) — it covers the direct attempt AND the cold escalation loop,
    // the drive twin of retrieve's t0-relative budgetDeadlineMs. The PINNED single-shot below does not need it
    // (one navigate, already bounded by its nav+clearance timeout — not the ~200s re-roll stacking source).
    const budgetDeadlineMs = performance.now() + this.#timeouts.callBudgetMs;
    // First navigate of a session: try direct, escalate to a proxied exit only on a block.
    if (!this.#pinned) {
      return this.#firstNavigate(url, forced, budgetDeadlineMs);
    }
    // Pinned session (direct or proxied): one shot. Reopen first if an idle reap closed it (same
    // mode). A failed nav means the committed exit/IP went bad, so discard it — the next navigate
    // re-runs the direct-first escalation rather than stranding the caller on a known-bad exit. We
    // surface the failure rather than swap the exit live under the page (that would lose state, KTD-5).
    // A prior navigate that hit the idle reap reset #handle (via #run's catch) while leaving #pinned set —
    // so an undefined handle HERE means #ensureOpen is about to RE-OPEN, not reuse, the session.
    const reopening = this.#handle === undefined;
    await this.#ensureOpen();
    // A warm session re-opened after an idle reap is a fresh session with NO edge-WAF clearance token —
    // exactly like a first warm-open — so on a warm-up host it would otherwise regress to deep-URL-first
    // and 403 (then surface a misleading "re-capture"/"retry" error whose real cause is the missing
    // warm-up). Warm it up before the target, symmetric with #openWarmAndNavigate. Gated on `reopening`:
    // a LIVE pinned session already carries the token from its first warm-up, so re-warming every navigate
    // would be wrong (and wasteful). A revoked entry already failed LOUD inside #ensureOpen above.
    if (reopening && this.#warmHost !== undefined) {
      await this.#warmUpForTarget(url);
    }
    // Capture warmth AFTER #ensureOpen (which may have RE-WARMED a reaped session): a stale warm replay
    // must fail LOUD with the operator-recapture signal on the reopen path too — not the generic "retry
    // for a fresh exit", which is actively wrong for a bound entry whose retry re-pins the SAME exit.
    const warm = this.#warmHost !== undefined;
    // A reopened PROXIED session (e.g. after an idle reap) lands a fresh exit + empty profile and can
    // re-hit the CF interstitial — which needs the escalated clearance budget. The default would time
    // out mid-challenge, the very failure this feature fixes.
    const snap = await this.#run((s) =>
      s.core.navigate(url, this.#proxiedSession ? { clearanceTimeoutMs: PROXY_CLEARANCE_TIMEOUT_MS } : {}),
    );
    if (navFailed(snap)) {
      await this.#discardSession();
      const failure = this.#failure(snap);
      if (warm) throw attachFailure(this.#warmError(url, snap.status ?? null), failure);
      const proxyAvailable = this.#resolveProxyOverride() !== undefined;
      throw attachFailure(
        new Error(
          `navigation failed (status=${snap.status ?? "n/a"}): the page was blocked or could not be ` +
            `reached${proxyAvailable ? " — retry navigate for a fresh exit" : ""}`,
        ),
        failure,
      );
    }
    return snap;
  }

  /**
   * First navigate of a session, escalate-on-block (matching retrieve's posture). Try DIRECT first —
   * the stealth core clears most client-side challenges (e.g. a Cloudflare JS challenge) on the
   * datacenter IP with no proxy cost. Only if direct is hard-blocked (IP reputation) do we escalate
   * to a proxied residential exit, and only here — BEFORE any interaction — because a stateful
   * session can't swap its exit mid-flow without losing page state (KTD-5).
   */
  async #firstNavigate(url: string, forced: boolean, budgetDeadlineMs: number): Promise<PageSnapshot> {
    // Warm-open (U9): if this consumer has a stored login for the (approved) target host, open a
    // logged-in session restored from the vault instead of a cold one. This takes precedence over BOTH
    // the force-proxy and the direct-first escalation: a warm session replays on the EXACT exit it was
    // captured on (R3, re-pinned inside buildWarmOverride for a bound capture; direct for a direct
    // capture), so it must not re-roll or re-escalate the exit. Falls through to the cold path below
    // when the vault is dormant/unwired, the host is not on the consumer's allowlist, or no entry exists.
    const warm = this.#buildWarmOverride(new URL(url).hostname);
    if (warm) {
      await this.#discardSession(); // drop any pre-opened (open()'d) cold session before opening warm
      return this.#openWarmAndNavigate(url, warm);
    }
    // Force-proxy: skip the direct attempt entirely and go residential from the first request.
    if (forced) {
      if (this.#resolveProxyOverride() === undefined) {
        // Fail loud rather than silently fall back to the direct attempt the caller opted out of.
        const dx = this.#escalationDiag({ proxyApplied: false, forced: true, attempts: 0, last: undefined });
        throw new EscalationError(
          // Structural sanitize at the source (issue #39 r5): the KNOWN requested url — spelling-proof.
          `force-proxy requested for ${sanitizeUrlForError(url)} but no residential proxy is available ` +
            `(proxy configured=${dx.proxyConfigured}, on datacenter IP=${this.#onDatacenterIp}) — ` +
            `set BGW_PROXY_* + BGW_ON_DATACENTER_IP, or drop the host from BGW_FORCE_PROXY_HOSTS`,
          dx,
        );
      }
      await this.#discardSession(); // drop any pre-opened direct session before going proxied
      return this.#openHealthyAndNavigate(url, true, budgetDeadlineMs);
    }
    if (!this.#handle) await this.#openSession(undefined); // reuse a pre-opened (direct) session if any
    const direct = await this.#run((s) => s.core.navigate(url));
    if (!navFailed(direct)) {
      this.#pinned = true; // direct works → commit it (no residential GB spent)
      return direct;
    }
    // Direct failed. Escalate to a proxied exit ONLY on a qualifying block — a visible challenge or a
    // hard reputation block, the two a clean residential exit can clear. A bare null-status failure
    // (an off-allowlist abort or an unreachable host) is surfaced directly: a fresh exit won't fix it,
    // so it must not spend the proxy budget (matches retrieve's escalation gate).
    await this.#discardSession(); // drop the blocked direct session before escalating
    if (this.#resolveProxyOverride() !== undefined && shouldEscalateDrive(direct)) {
      return this.#openHealthyAndNavigate(url, false, budgetDeadlineMs);
    }
    const dx = this.#escalationDiag({ proxyApplied: false, forced: false, attempts: 0, last: direct });
    throw new EscalationError(
      `navigation failed (status=${dx.lastStatus ?? "n/a"}, reason=${dx.reason ?? "unknown"}): ` +
        `the page was blocked or could not be reached` +
        (dx.proxyConfigured ? "" : " (no residential proxy configured to escalate to)"),
      dx,
      this.#failure(direct),
    );
  }

  async snapshot(): Promise<PageSnapshot> {
    const t0 = performance.now();
    return this.#serialize(() => this.#timedSnap(t0, () => this.#run((s) => s.core.snapshot())));
  }

  async click(target: DriveTarget): Promise<PageSnapshot> {
    const t0 = performance.now();
    return this.#serialize(() => this.#timedSnap(t0, () => this.#actAndSnap((s) => s.core.click(target))));
  }

  async type(target: DriveTarget, text: string, submit?: boolean): Promise<PageSnapshot> {
    const t0 = performance.now();
    return this.#serialize(() => this.#timedSnap(t0, () => this.#actAndSnap((s) => s.core.type(target, text, { submit }))));
  }

  async selectOption(target: DriveTarget, values: string[]): Promise<PageSnapshot> {
    const t0 = performance.now();
    return this.#serialize(() => this.#timedSnap(t0, () => this.#actAndSnap((s) => s.core.selectOption(target, values))));
  }

  async pressKey(key: string): Promise<PageSnapshot> {
    const t0 = performance.now();
    return this.#serialize(() => this.#timedSnap(t0, () => this.#actAndSnap((s) => s.core.pressKey(key))));
  }

  async waitFor(condition: WaitCondition): Promise<PageSnapshot> {
    const t0 = performance.now();
    return this.#serialize(() => this.#timedSnap(t0, () => this.#actAndSnap((s) => s.core.waitFor(condition))));
  }

  async screenshot(): Promise<string> {
    return this.#serialize(() => this.#run((s) => s.core.screenshot()));
  }

  async close(): Promise<void> {
    return this.#serialize(async () => {
      this.#pinned = false;
      this.#proxiedSession = false;
      this.#warmHost = undefined;
      const handle = this.#handle;
      if (!handle) return;
      this.#handle = undefined;
      await this.#gateway.closeConsumerSession(this.#token, handle).catch(() => {});
    });
  }

  /** Reopen the pinned session if an idle reap closed it, with the mode it committed to. A WARM session
   *  re-warms: rebuild the sealed override (re-pinning the SAME captured exit, R3) so a reaped logged-in
   *  session is restored rather than silently downgraded to cold. If the entry was revoked since (rebuild
   *  → undefined), FAIL LOUD — a session that was operating as logged-in must not silently become
   *  anonymous (the stale-warm-never-silent-cold contract). A non-warm proxied session re-resolves a
   *  fresh exit (rotation-safe); a direct one reopens direct. */
  async #ensureOpen(): Promise<void> {
    if (this.#handle) return;
    if (this.#warmHost) {
      const warm = this.#buildWarmOverride(this.#warmHost);
      if (warm) {
        await this.#openSessionWarm(warm);
        return;
      }
      // The warm entry was revoked/removed while this logged-in session was reaped. Fail LOUD rather
      // than silently reopening cold (which would mask the credential loss as an ordinary anonymous
      // page). Reset state so a DELIBERATE next navigate opens cold; this navigate ends with a clear,
      // actionable error.
      await this.#discardSession();
      throw new Error(
        "warm (logged-in) session ended: the stored credential was revoked or is no longer available — " +
          "close this drive session and start a new one (it will open cold), or ask the operator to re-capture",
      );
    }
    await this.#openSession(this.#proxiedSession ? this.#resolveProxyOverride() : undefined);
  }

  /**
   * Open a consumer session, scrubbing any secret material from a launch/restore/proxy error before it
   * propagates — the open-path analogue of {@link #run} (which already redacts the drive/use path). The
   * open path (browser launch + warm-cookie restore + proxy connect) can surface a secret in a raw
   * throw; redacting HERE means coverage no longer hangs on the session-manager's static CORE_LAUNCH
   * re-wrap holding (audit #2). A plain re-wrap matches #run — no caller branches on the open error's
   * type/code (SessionManagerError is only produced, never inspected; EscalationError is thrown at the
   * navigate/escalation layer, never by openConsumerSession). The `#verifyEgress` probe opens directly:
   * it already swallows every error to `{ kind: "unknown" }`, so it has no surface to redact.
   */
  async #openConsumerSession(override: BrowserCoreOptions | undefined): Promise<string> {
    try {
      return await this.#gateway.openConsumerSession(this.#token, override);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(redactSecrets(message, this.#secrets));
    }
  }

  /** Open a consumer session with the given core override (a proxied exit, or undefined for direct),
   *  recording whether it is proxied for reopen-after-reap and failure messaging. */
  async #openSession(override: BrowserCoreOptions | undefined): Promise<void> {
    this.#handle = await this.#openConsumerSession(override);
    this.#proxiedSession = override !== undefined;
  }

  /**
   * Build the sealed warm-open override for `host` when warm-open is fully wired (vault + consumer id +
   * allowlist all present) AND the host is on this consumer's allowlist AND a vault entry exists for
   * `(consumer, host)`. Returns undefined otherwise (→ cold open). The allowlist gate is the SAME one
   * the gateway's nav guard clamps to, so we never decrypt+inject a credential for a host the session
   * could not then navigate. `buildWarmOverride` owns ownerHost (derived from its own vault lookup, the
   * R4/seal invariant — never a caller value) and re-pins the captured sticky exit for a bound entry.
   */
  #buildWarmOverride(host: string): BrowserCoreOptions | undefined {
    if (!this.#vault || !this.#consumerId || !this.#allowlist) return undefined;
    // This gate is deliberately the LOOSER of the two host checks: Allowlist.allows strips a leading
    // `www.` while the vault lookup + nav clamp (canonicalizeHost, no www-strip per #21/#36) do not.
    // Stripping only ever ADMITS more hosts to the decrypt attempt; the authoritative selection
    // (vault.get on the exact canonical host) and the clamp agree with each other, so a www/non-www
    // mismatch yields a cold open (no entry) or a correctly-clamped warm open — never a credential on
    // an off-owner-navigable session. Do not "fix" this into a divergent stricter form.
    if (!this.#allowlist.allows(host)) return undefined;
    // Fresh-exit policy: a host on BGW_WARM_FRESH_EXIT_HOSTS replays its login through a FRESH clean
    // residential exit instead of re-pinning the captured (decaying) one. Resolved from the host-set on
    // the SAME host string used for the vault lookup (subdomain-inclusive suffix match, like force-proxy),
    // so first-open and reopen-after-reap agree and the captured stickyExitId is bypassed for these.
    const freshExit = hostForcesProxy(host, this.#freshExitHosts);
    return (
      buildWarmOverride(this.#vault, this.#secrets, {
        consumerId: this.#consumerId,
        host,
        onDatacenterIp: this.#onDatacenterIp,
        ...(this.#stickySuffix !== undefined ? { stickySuffix: this.#stickySuffix } : {}),
        ...(freshExit ? { freshExit: true } : {}),
      }) ?? undefined
    );
  }

  /**
   * Open a WARM (logged-in) session from a vault-built override and record its owner host so an idle
   * reap re-warms (via {@link #ensureOpen}) rather than silently reopening cold. `#proxiedSession` is
   * derived from the override's PROXY posture — NOT merely "an override is present" — because a
   * direct-captured warm override carries `restoreState` but no proxy, and mis-flagging it proxied
   * would make reopen-after-reap wrongly resolve a fresh proxy exit. The owner host comes from the
   * sealed `restoreState.ownerHost` (the authoritative, vault-derived value), never a caller input.
   */
  async #openSessionWarm(override: BrowserCoreOptions): Promise<void> {
    this.#handle = await this.#openConsumerSession(override);
    this.#proxiedSession = override.proxy !== undefined;
    this.#warmHost = override.restoreState?.ownerHost;
  }

  /**
   * Open a warm session and run the first navigate. The override is sealed and carries its own exit
   * posture (R3), so this path does NOT escalate or re-roll on failure: a warm replay that lands
   * blocked or logged-out means the stored login is stale/expired — operator-refresh territory
   * (re-rolling would break the captured-exit re-pin). On failure we discard and surface a clean,
   * actionable error rather than silently falling back to a cold (unauthenticated) session, which
   * would mask the staleness. On success the session is pinned.
   */
  async #openWarmAndNavigate(url: string, override: BrowserCoreOptions): Promise<PageSnapshot> {
    await this.#openSessionWarm(override);
    // Warm-up navigation (PerimeterX deep-URL-first fix): on an opted-in owner host, navigate a shallow
    // same-owner page FIRST so the edge WAF issues a clearance token into this live session — then the
    // target navigate carries it instead of hard-403'ing a logged-in-looking request to a deep page with
    // no clearance. Runs on the SAME sealed, exit-pinned session (R3) opened just above.
    await this.#warmUpForTarget(url);
    const snap = await this.#run((s) =>
      s.core.navigate(url, override.proxy ? { clearanceTimeoutMs: PROXY_CLEARANCE_TIMEOUT_MS } : {}),
    );
    if (navFailed(snap)) {
      await this.#discardSession();
      throw attachFailure(this.#warmError(url, snap.status ?? null), this.#failure(snap));
    }
    this.#pinned = true;
    return snap;
  }

  /**
   * Prepare an open, exit-pinned, warmed-up warm session for the target navigate — the SINGLE warm-up
   * entry point, shared by first warm-open and reopen-after-reap so the two paths can't diverge. Runs
   * {@link #runWarmup}; if a warm-up hop lost the session to a reap ({@link #run} cleared #handle),
   * REOPEN (re-pin the captured exit, R3, via {@link #ensureOpen}) and warm the FRESH session ONCE more —
   * a reopened session has no clearance token, so skipping its warm-up would regress to deep-URL-first
   * (the PX 403 this feature fixes) and surface a misleading stale-login error. Bounded to a single
   * re-warm retry, then a final {@link #ensureOpen} guarantees a live re-pinned handle for the target
   * (never the raw "no active drive session"); a revoked entry still fails LOUD inside #ensureOpen. The
   * bound means a pathologically-reaping session can't loop — at most two reopens, two warm-ups.
   */
  async #warmUpForTarget(url: string): Promise<void> {
    await this.#runWarmup(url);
    if (this.#handle === undefined) {
      // A warm-up hop lost the session to a reap: reopen (re-pin R3) and warm the FRESH session once, so
      // it carries a clearance token before the deep target rather than regressing to deep-URL-first.
      await this.#ensureOpen();
      await this.#runWarmup(url);
    }
    // Pathological double-loss: guarantee a live re-pinned handle for the target navigate (best-effort
    // warm-up is already done; the target navigate stays the authoritative gate).
    if (this.#handle === undefined) await this.#ensureOpen();
  }

  /**
   * Warm-up navigation: before the consumer's real (possibly deep, authed) target, navigate one or more
   * SHALLOW same-owner-host paths on the SAME already-open warm session, so a behavioral/edge WAF issues
   * a clearance token into the live session. Only fires for owner hosts on {@link #warmupHosts}; a
   * no-match owner runs ZERO warm-up navigations (non-regression). Reads the warm session's owner host
   * and proxy posture from instance state ({@link #warmHost} / {@link #proxiedSession}), both set by
   * {@link #openSessionWarm}, so BOTH the first warm-open ({@link #openWarmAndNavigate}) and the
   * reopen-after-reap path can share it. Always runs AFTER the exit is pinned (R3) on the warm session.
   *
   * Invariants (load-bearing, from the warm-open security audit):
   *  - Every hop targets the OWNER host from the SEAL (`#warmHost`, set from `restoreState.ownerHost`) +
   *    a boot-validated relative path, so it passes the credential-owner-host nav-clamp: no off-owner
   *    hop, no clamp widening. A defensive host re-check skips any hop whose built URL isn't the owner
   *    (the live clamp would block it regardless — this just never attempts it).
   *  - Each hop is a second call through the SAME {@link #run}/`core.navigate` path with the SAME
   *    clearance budget as the target — it reuses the existing clearance detection/poll, adding none.
   *  - BEST-EFFORT: a blocked/failed hop is logged and aborts the remaining hops (so a bad exit isn't
   *    hammered), and NEVER discards the warm session. The target navigate stays the real gate, so a
   *    stale/blocked login still fails LOUD there — warm-up can only ever help, never mask staleness.
   */
  async #runWarmup(targetUrl: string): Promise<void> {
    const ownerHost = this.#warmHost;
    if (!ownerHost || !hostForcesProxy(ownerHost, this.#warmupHosts)) return; // feature off / host not opted in
    // Warm-up shares the target's ORIGIN — its scheme and port — so it hits the same server, but pins the
    // HOST to the SEALED owner (never the caller's URL host), which the nav-clamp then agrees with. The
    // target host equals ownerHost canonically (the seal derived it from the vault lookup keyed on the
    // navigated host), so this is the same site at a shallow path, defense-in-depth on top of that.
    const target = new URL(targetUrl);
    const portPart = target.port ? `:${target.port}` : "";
    // Same clearance posture the target uses — a proxied (bound/fresh-exit) warm session needs the
    // escalated budget to clear an interstitial; a direct one keeps the default.
    const clearance = this.#proxiedSession ? { clearanceTimeoutMs: PROXY_CLEARANCE_TIMEOUT_MS } : {};
    for (const path of this.#warmupPaths) {
      const warmupUrl: string = `${target.protocol}//${ownerHost}${portPart}${path}`;
      // Defense in depth on top of the boot-time path validation (parseWarmupPaths): never navigate a
      // warm-up URL whose HOST isn't the sealed owner — the credential nav-clamp would block it anyway.
      // Compare hostname (not host) so a non-default port on the origin doesn't false-trip this skip.
      if (new URL(warmupUrl).hostname !== ownerHost) continue;
      if (warmupUrl === targetUrl) continue; // the target IS this shallow page — its own navigate clears it
      let blocked: boolean;
      try {
        const snap = await this.#run((s) => s.core.navigate(warmupUrl, clearance));
        blocked = navFailed(snap);
      } catch {
        // A warm-up hop that threw (a transient core error, or a mid-warm-up reap that reset #handle).
        // Best-effort: stop warming up and let the target navigate below be the authoritative gate.
        blocked = true;
      }
      this.#log?.(`warm-up: ${warmupUrl} → ${blocked ? "blocked" : "ok"}`);
      if (blocked) break; // abort the remaining hops; don't hammer the exit's reputation
    }
  }

  /** The loud, actionable error for a warm replay that landed stale/blocked: the stored login is
   *  expired or blocked and only an operator re-capture can fix it (re-rolling the exit would break
   *  the R3 re-pin, and a bound entry re-pins the SAME captured exit on retry). Used on BOTH the
   *  first-navigate warm path and the reopen-after-reap warm path, so the "stale warm fails LOUD"
   *  guarantee does not depend on whether the session happened to be idle-reaped. */
  #warmStaleError(url: string, status: number | null): Error {
    // Structural sanitize at the source (issue #39 r5): the KNOWN requested url, spelling-proof.
    return new Error(
      `warm (logged-in) navigation to ${sanitizeUrlForError(url)} failed (status=${status ?? "n/a"}): the stored session ` +
        `is likely expired or blocked — ask the operator to re-capture this credential`,
    );
  }

  /** A FRESH-EXIT warm session that landed blocked means the freshly-minted residential exit was a dud
   *  (a burned/dead pool IP), NOT a stale credential — the stored login is fine and the next navigate
   *  re-warms with a DIFFERENT fresh exit. So tell the consumer to retry, not to re-capture (the wrong,
   *  alarming signal here). The pinned path keeps {@link #warmStaleError} (a re-pin retry is pointless). */
  #warmFreshError(url: string, status: number | null): Error {
    // Structural sanitize at the source (issue #39 r5): the KNOWN requested url, spelling-proof.
    return new Error(
      `warm (logged-in) navigation to ${sanitizeUrlForError(url)} was blocked (status=${status ?? "n/a"}): the fresh ` +
        `residential exit was likely burned or unreachable — retry navigate to draw a clean exit`,
    );
  }

  /** Pick the warm-failure error by the host's exit policy: a fresh-exit host (BGW_WARM_FRESH_EXIT_HOSTS)
   *  failed because the exit was a dud (retry); any other warm host failed because the captured exit /
   *  stored session is stale (re-capture). Derived from the URL host so it holds on BOTH the first-navigate
   *  and the reopen-after-reap path without a separate per-session flag (the host-set is the source of truth). */
  #warmError(url: string, status: number | null): Error {
    return hostForcesProxy(new URL(url).hostname, this.#freshExitHosts)
      ? this.#warmFreshError(url, status)
      : this.#warmStaleError(url, status);
  }

  /**
   * Escalation path: open a proxied session and navigate, retrying fresh exits until one lands the
   * page, then pin it. The override is resolved FRESH per attempt — with a sticky suffix configured
   * each attempt mints its own held exit (one stable IP for the attempt's whole challenge — a CF
   * interstitial cannot complete across rotating per-request IPs), while retries still draw fresh
   * exits past dead/dirty ones. The proxied navigate runs with the raised escalated clearance budget:
   * an interstitial clears in ~22s on a held exit, over the 15s drive default (probe, 2026-06-09) —
   * with the default, even a healthy exit timed out mid-challenge, was discarded as navFailed, and
   * the retry burned a fresh exit re-starting the challenge from zero. A dead/blocked exit still
   * fails fast (bounded proxy nav timeout); the per-consumer cap is respected because the unhealthy
   * session is discarded before the next opens. Worst case proxyMaxAttempts × (nav timeout +
   * clearance budget) — still under the idle-reaper TTL so an in-progress retry isn't reclaimed.
   */
  async #openHealthyAndNavigate(url: string, forced: boolean, budgetDeadlineMs: number): Promise<PageSnapshot> {
    let last: PageSnapshot | undefined;
    let attempts = 0;
    // #45: the drive twin of retrieve's #43 loop bound + burned-exit derivation.
    //  - budgetExceeded: the pre-attempt budget bail fired (a decisive `timeout`, outermost verdict).
    //  - sawLiveResponse: some proxied attempt REACHED the site (a live block/challenge, not a dead exit).
    //    If the loop exhausts with this still false, every exit died → a `burned-exit` (all-dead) verdict.
    let budgetExceeded = false;
    let sawLiveResponse = false;
    const maxAttempts = this.#timeouts.proxyMaxAttempts; // #45: env-overridable (was PROXY_OPEN_ATTEMPTS)
    // #42: per proxied-attempt wall-clock (session-open + navigate), 1:1 with `attempts`, surfaced on the
    // EscalationError diagnostics so an exhausted 3× re-roll is legible ("why 200s").
    const attemptMs: number[] = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // #45: STOP re-rolling once too little of the global call budget remains for a meaningful attempt — the
      // drive twin of retrieve.ts's pre-attempt bail. Bounds the ~200-255s stacking loop (each attempt is a
      // launch + nav + clearance + teardown) to ~callBudgetMs; the still-failing result classifies `timeout`.
      // Checked BEFORE `attempts = attempt`, so a bail before any proxied session opens claims zero attempts.
      if (budgetDeadlineMs - performance.now() <= MIN_ATTEMPT_BUDGET_MS) {
        budgetExceeded = true;
        break;
      }
      const override = this.#resolveProxyOverride();
      if (!override) {
        // Proxy secrets rotated away mid-retry: a distinct error, not the exhausted-exits message
        // below — so ops sees "config removed", not "all exits unhealthy".
        throw new Error(
          // Structural sanitize at the source (issue #39 r5): the KNOWN requested url, spelling-proof.
          `proxy escalation unavailable for ${sanitizeUrlForError(url)}: residential proxy configuration was removed mid-retry`,
        );
      }
      attempts = attempt;
      const attempt0 = performance.now();
      await this.#openSession(override);
      // #45: pass the shared per-call deadline into the core so this attempt's goto + clearance poll are
      // bounded by it too (parity with render) — a single attempt starting near the deadline can't overrun it.
      const snap = await this.#run((s) =>
        s.core.navigate(url, { clearanceTimeoutMs: this.#timeouts.proxyClearanceTimeoutMs, budgetDeadlineMs }),
      );
      if (!navFailed(snap)) {
        this.#pinned = true;
        attemptMs.push(performance.now() - attempt0); // the winning attempt has no teardown (it is pinned, not closed)
        // #42 SCOPED FOLLOW-UP: on a SUCCESS-after-retries the collected attemptMs is dropped — a drive
        // SUCCESS returns a bare PageSnapshot with no escalation-diagnostics channel (drive surfaces those
        // only on the EscalationError FAILURE, a pre-#42 asymmetry vs retrieve's result-level proxyDiagnostic).
        // The whole-verb totalMs (stamped by #timedSnap) DOES reflect the failed attempts; surfacing their
        // per-attempt breakdown on success needs a new PageSnapshot escalation surface — a follow-up.
        return snap;
      }
      last = snap;
      // #45: this attempt FAILED. If the exit REACHED the site (a live block/challenge — not a null-status /
      // chrome-error dead nav), the failure is site-attributable, so NOT an all-exits-dead burn.
      if (!isDeadExit(snap.status ?? null, snap.url)) sawLiveResponse = true;
      await this.#discardSession(); // close the unhealthy session so the next attempt draws a fresh exit
      // #42: record AFTER teardown so a FAILED attempt's session close (grace + kill-confirm, up to ~15s of
      // caller-visible latency) counts toward its attemptMs — else ~45s of three wedged teardowns would sit in
      // totalMs but in no attemptMs entry. Exactly one push per iteration keeps attemptMs 1:1 with `attempts`.
      attemptMs.push(performance.now() - attempt0);
    }
    // #45: an escalation that EXHAUSTED every attempt with a DEAD exit (none reached the site) is a burned
    // exit — our residential pool died. Gated on `attempts > 0` (a budget bail before any attempt is a timeout,
    // not a burn) and outranked by budgetExceeded. Diagnostic + a nav-failed refinement; behavior is unchanged.
    const burnedExit = attempts > 0 && !budgetExceeded && !sawLiveResponse;
    // #45: skip the opt-in egress probe when we bailed on budget — it is one more proxied request past an
    // already-exhausted deadline. On a real exit-exhaustion (not a budget bail) it still classifies the exit.
    const exitCheck = this.#verifyEgressEnabled && !budgetExceeded ? await this.#verifyEgress() : undefined;
    const dx = this.#escalationDiag({ proxyApplied: attempts > 0, forced, attempts, last, attemptMs, exitCheck, burnedExit });
    // Distinct headline per verdict so ops reads the real cause: a budget timeout, an all-exits-dead burn, or
    // a genuine per-exit exhaustion (site blocked every live exit). The typed FailureClass on #failure carries it.
    const headline = budgetExceeded
      ? `call budget exhausted escalating ${sanitizeUrlForError(url)} (${this.#timeouts.callBudgetMs}ms) after ${attempts} attempt(s)`
      : burnedExit
        ? `all ${attempts} proxied exit(s) died reaching ${sanitizeUrlForError(url)} (burned exits — none got a response)`
        : `could not land a working proxied exit for ${sanitizeUrlForError(url)} after ${attempts} attempts`;
    throw new EscalationError(
      // Structural sanitize at the source (issue #39 r5): the KNOWN requested url, spelling-proof.
      `${headline} (last status=${dx.lastStatus ?? "n/a"}, reason=${dx.reason ?? "unknown"}` +
        (exitCheck ? `, exit=${exitCheck.kind}` : "") +
        `)`,
      dx,
      this.#failure(last, { budgetExceeded, burnedExit }),
    );
  }

  /** Close and forget the current session and its committed exit/mode, so the next navigate re-runs
   *  the direct-first escalation. Used between retry attempts and on a committed-exit failure. */
  async #discardSession(): Promise<void> {
    const handle = this.#handle;
    this.#handle = undefined;
    this.#pinned = false;
    this.#proxiedSession = false;
    this.#warmHost = undefined; // a discarded session does not auto-re-warm
    if (handle) await this.#gateway.closeConsumerSession(this.#token, handle).catch(() => {});
  }

  #requireHandle(): string {
    if (!this.#handle) {
      throw new Error("no active drive session — call browser_navigate to start one");
    }
    return this.#handle;
  }

  /**
   * Run a mutating action, then return the post-action snapshot (the verb's observable result). A
   * navigation-producing action (submit click, type+submit, Enter) can land on an anti-bot
   * interstitial; the core waits out a client-side challenge first, but if the page is STILL blocked
   * we surface it rather than hand back the interstitial as a successful result. The session is left
   * intact (no discard) — a mid-flow block means the agent should close + reopen to restart the flow
   * (KTD-5), not lose its page state to an exit re-roll.
   */
  async #actAndSnap(act: (session: Session) => Promise<unknown>): Promise<PageSnapshot> {
    return this.#run(async (s) => {
      try {
        await act(s);
      } catch (err) {
        // The ACTION itself threw (a locator timeout, a detached element, a failed fill) BEFORE any
        // snapshot — otherwise the envelope is dropped and a drive action failure is opaque (issue #39).
        // Best-effort snapshot the current page so the failure still carries evidence; the page may be
        // wedged, so its OWN try/catch. Attach the redacted envelope and rethrow — #run's catch preserves
        // `.failure` across its redaction re-wrap.
        let failure: FailureDiagnostics | undefined;
        try {
          failure = this.#failure(await s.core.snapshot());
        } catch {
          // the page is unusable — no snapshot evidence; the action error still propagates with none
        }
        throw attachFailure(err instanceof Error ? err : new Error(String(err)), failure);
      }
      const snap = await s.core.snapshot();
      // The snapshot carries the active page's last navigation status, so navFailed catches a bare
      // reputation block (4xx + thin) reached by the action as well as a visible challenge — neither
      // is handed back as success.
      if (navFailed(snap)) {
        throw attachFailure(
          new Error(
            "the action landed on a blocked/challenge page that did not clear — close and reopen the " +
              "drive session, then retry the flow",
          ),
          this.#failure(snap),
        );
      }
      return snap;
    });
  }

  async #run<T>(fn: (session: Session) => Promise<T>): Promise<T> {
    const handle = this.#requireHandle();
    try {
      return await this.#gateway.useConsumerSession(this.#token, handle, (s) => fn(s));
    } catch (err) {
      // Session reaped/closed out from under us -> reset so the next navigate transparently reopens.
      if (!this.#gateway.sessions.get(handle)) this.#handle = undefined;
      const message = err instanceof Error ? err.message : String(err);
      // Preserve a failure envelope (issue #39) across the redaction re-wrap: an action that landed on a
      // blocked page throws `attachFailure(...)` INSIDE this #run turn (see #actAndSnap), and the fresh
      // Error below would otherwise drop the non-enumerable `.failure`. The envelope was already redacted
      // at #failure(), so re-attaching it is secret-safe.
      throw attachFailure(new Error(redactSecrets(message, this.#secrets)), failureOf(err));
    }
  }
}
