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
import { DIAGNOSTICS_EGRESS_HOSTS } from "../policy/index.js";
import type { BrowserCoreOptions, DriveTarget, PageSnapshot, WaitCondition } from "../browser/index.js";
import {
  proxyOverrideFor,
  navFailed,
  shouldEscalateDrive,
  proxyFromSecrets,
  escalationDiagnostics,
  EscalationError,
  hostForcesProxy,
  classifyExitOrg,
  parseExitOrg,
  PROXY_OPEN_ATTEMPTS,
  PROXY_CLEARANCE_TIMEOUT_MS,
} from "../verbs/index.js";
import type { EscalationDiagnostics, EgressCheck } from "../verbs/index.js";
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
  /** Opt-in: on an escalation failure, probe the proxy's exit and classify residential vs datacenter. */
  readonly #verifyEgressEnabled: boolean;
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
      verifyEgress?: boolean;
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
    this.#verifyEgressEnabled = opts.verifyEgress ?? false;
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
   * Build structured escalation diagnostics from the last failed snapshot, reading proxy-configured
   * straight from the (possibly rotated) secret store. The drive snapshot's accessibility `tree` is
   * the reduced text surface classification reads; cfHint/pxHint are carried booleans. Secrets-free
   * by construction (no creds, no proxy host).
   */
  #escalationDiag(opts: {
    proxyApplied: boolean;
    forced: boolean;
    attempts: number;
    last?: PageSnapshot;
    exitCheck?: EgressCheck;
  }): EscalationDiagnostics {
    return escalationDiagnostics({
      proxyConfigured: proxyFromSecrets(this.#secrets) !== undefined,
      proxyApplied: opts.proxyApplied,
      forced: opts.forced,
      attempts: opts.attempts,
      last: opts.last
        ? { title: opts.last.title, text: opts.last.tree, status: opts.last.status ?? null, cfHint: opts.last.cfHint, pxHint: opts.last.pxHint }
        : null,
      ...(opts.exitCheck ? { exitCheck: opts.exitCheck } : {}),
    });
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

  async open(): Promise<void> {
    return this.#serialize(async () => {
      // Open a direct session lazily; escalation to a proxied exit (if needed) happens on the first
      // navigate — the only point we know whether the target blocks the direct IP.
      if (!this.#handle) await this.#openSession(undefined);
    });
  }

  async navigate(url: string, opts: { forceProxy?: boolean } = {}): Promise<PageSnapshot> {
    return this.#serialize(() => this.#navigate(url, opts));
  }

  async #navigate(url: string, opts: { forceProxy?: boolean }): Promise<PageSnapshot> {
    // Scheme allowlist (R14-adjacent): only http(s), rejected before any session/navigation —
    // mirrors retrieve(), so a non-http target can't slip past the host-based guard.
    if (!isHttpUrl(url)) {
      throw new Error(`unsupported URL scheme: only http(s) is allowed (${url})`);
    }
    // Force residential from the first request when the caller asks (forceProxy) or the host is on
    // the configured force-proxy list — for a known-hostile WAF the direct attempt only wastes a
    // round-trip and trips reputation (issue #21).
    const forced = (opts.forceProxy ?? false) || hostForcesProxy(new URL(url).hostname, this.#forceProxyHosts);
    // First navigate of a session: try direct, escalate to a proxied exit only on a block.
    if (!this.#pinned) {
      return this.#firstNavigate(url, forced);
    }
    // Pinned session (direct or proxied): one shot. Reopen first if an idle reap closed it (same
    // mode). A failed nav means the committed exit/IP went bad, so discard it — the next navigate
    // re-runs the direct-first escalation rather than stranding the caller on a known-bad exit. We
    // surface the failure rather than swap the exit live under the page (that would lose state, KTD-5).
    await this.#ensureOpen();
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
      if (warm) throw this.#warmStaleError(url, snap.status ?? null);
      const proxyAvailable = this.#resolveProxyOverride() !== undefined;
      throw new Error(
        `navigation failed (status=${snap.status ?? "n/a"}): the page was blocked or could not be ` +
          `reached${proxyAvailable ? " — retry navigate for a fresh exit" : ""}`,
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
  async #firstNavigate(url: string, forced: boolean): Promise<PageSnapshot> {
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
          `force-proxy requested for ${url} but no residential proxy is available ` +
            `(proxy configured=${dx.proxyConfigured}, on datacenter IP=${this.#onDatacenterIp}) — ` +
            `set BGW_PROXY_* + BGW_ON_DATACENTER_IP, or drop the host from BGW_FORCE_PROXY_HOSTS`,
          dx,
        );
      }
      await this.#discardSession(); // drop any pre-opened direct session before going proxied
      return this.#openHealthyAndNavigate(url, true);
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
      return this.#openHealthyAndNavigate(url, false);
    }
    const dx = this.#escalationDiag({ proxyApplied: false, forced: false, attempts: 0, last: direct });
    throw new EscalationError(
      `navigation failed (status=${dx.lastStatus ?? "n/a"}, reason=${dx.reason ?? "unknown"}): ` +
        `the page was blocked or could not be reached` +
        (dx.proxyConfigured ? "" : " (no residential proxy configured to escalate to)"),
      dx,
    );
  }

  async snapshot(): Promise<PageSnapshot> {
    return this.#serialize(() => this.#run((s) => s.core.snapshot()));
  }

  async click(target: DriveTarget): Promise<PageSnapshot> {
    return this.#serialize(() => this.#actAndSnap((s) => s.core.click(target)));
  }

  async type(target: DriveTarget, text: string, submit?: boolean): Promise<PageSnapshot> {
    return this.#serialize(() => this.#actAndSnap((s) => s.core.type(target, text, { submit })));
  }

  async selectOption(target: DriveTarget, values: string[]): Promise<PageSnapshot> {
    return this.#serialize(() => this.#actAndSnap((s) => s.core.selectOption(target, values)));
  }

  async pressKey(key: string): Promise<PageSnapshot> {
    return this.#serialize(() => this.#actAndSnap((s) => s.core.pressKey(key)));
  }

  async waitFor(condition: WaitCondition): Promise<PageSnapshot> {
    return this.#serialize(() => this.#actAndSnap((s) => s.core.waitFor(condition)));
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

  /** Open a consumer session with the given core override (a proxied exit, or undefined for direct),
   *  recording whether it is proxied for reopen-after-reap and failure messaging. */
  async #openSession(override: BrowserCoreOptions | undefined): Promise<void> {
    this.#handle = await this.#gateway.openConsumerSession(this.#token, override);
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
    return (
      buildWarmOverride(this.#vault, this.#secrets, {
        consumerId: this.#consumerId,
        host,
        onDatacenterIp: this.#onDatacenterIp,
        ...(this.#stickySuffix !== undefined ? { stickySuffix: this.#stickySuffix } : {}),
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
    this.#handle = await this.#gateway.openConsumerSession(this.#token, override);
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
    const snap = await this.#run((s) =>
      s.core.navigate(url, override.proxy ? { clearanceTimeoutMs: PROXY_CLEARANCE_TIMEOUT_MS } : {}),
    );
    if (navFailed(snap)) {
      await this.#discardSession();
      throw this.#warmStaleError(url, snap.status ?? null);
    }
    this.#pinned = true;
    return snap;
  }

  /** The loud, actionable error for a warm replay that landed stale/blocked: the stored login is
   *  expired or blocked and only an operator re-capture can fix it (re-rolling the exit would break
   *  the R3 re-pin, and a bound entry re-pins the SAME captured exit on retry). Used on BOTH the
   *  first-navigate warm path and the reopen-after-reap warm path, so the "stale warm fails LOUD"
   *  guarantee does not depend on whether the session happened to be idle-reaped. */
  #warmStaleError(url: string, status: number | null): Error {
    return new Error(
      `warm (logged-in) navigation to ${url} failed (status=${status ?? "n/a"}): the stored session ` +
        `is likely expired or blocked — ask the operator to re-capture this credential`,
    );
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
   * session is discarded before the next opens. Worst case PROXY_OPEN_ATTEMPTS × (nav timeout +
   * clearance budget) — still under the idle-reaper TTL so an in-progress retry isn't reclaimed.
   */
  async #openHealthyAndNavigate(url: string, forced: boolean): Promise<PageSnapshot> {
    let last: PageSnapshot | undefined;
    let attempts = 0;
    for (let attempt = 1; attempt <= PROXY_OPEN_ATTEMPTS; attempt++) {
      const override = this.#resolveProxyOverride();
      if (!override) {
        // Proxy secrets rotated away mid-retry: a distinct error, not the exhausted-exits message
        // below — so ops sees "config removed", not "all exits unhealthy".
        throw new Error(
          `proxy escalation unavailable for ${url}: residential proxy configuration was removed mid-retry`,
        );
      }
      attempts = attempt;
      await this.#openSession(override);
      const snap = await this.#run((s) =>
        s.core.navigate(url, { clearanceTimeoutMs: PROXY_CLEARANCE_TIMEOUT_MS }),
      );
      if (!navFailed(snap)) {
        this.#pinned = true;
        return snap;
      }
      last = snap;
      await this.#discardSession(); // close the unhealthy session so the next attempt draws a fresh exit
    }
    const exitCheck = this.#verifyEgressEnabled ? await this.#verifyEgress() : undefined;
    const dx = this.#escalationDiag({ proxyApplied: true, forced, attempts, last, exitCheck });
    throw new EscalationError(
      `could not land a working proxied exit for ${url} after ${PROXY_OPEN_ATTEMPTS} attempts ` +
        `(last status=${dx.lastStatus ?? "n/a"}, reason=${dx.reason ?? "unknown"}` +
        (exitCheck ? `, exit=${exitCheck.kind}` : "") +
        `)`,
      dx,
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
      await act(s);
      const snap = await s.core.snapshot();
      // The snapshot carries the active page's last navigation status, so navFailed catches a bare
      // reputation block (4xx + thin) reached by the action as well as a visible challenge — neither
      // is handed back as success.
      if (navFailed(snap)) {
        throw new Error(
          "the action landed on a blocked/challenge page that did not clear — close and reopen the " +
            "drive session, then retry the flow",
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
      throw new Error(redactSecrets(message, this.#secrets));
    }
  }
}
