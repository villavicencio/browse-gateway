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
import type { BrowserCoreOptions, DriveTarget, PageSnapshot, WaitCondition } from "../browser/index.js";
import {
  proxyOverrideFor,
  navFailed,
  shouldEscalateDrive,
  PROXY_OPEN_ATTEMPTS,
  PROXY_CLEARANCE_TIMEOUT_MS,
} from "../verbs/index.js";
import type { DriveController } from "./server.js";

export class GatewayDriveController implements DriveController {
  #handle?: string;
  /** True once the current session's first navigate landed a page — its exit/mode is committed. */
  #pinned = false;
  /** Whether the current session was opened proxied (vs direct) — drives reopen-after-reap + messaging. */
  #proxiedSession = false;
  readonly #gateway: Gateway;
  readonly #secrets: SecretStore;
  readonly #token: string;
  /** Whether we run on a datacenter IP — the gate (with a configured proxy) for proxied sessions. */
  readonly #onDatacenterIp: boolean;
  /** Sticky-session suffix template (deployment config) — each resolve mints a fresh held exit. */
  readonly #stickySuffix?: string;

  constructor(
    gateway: Gateway,
    secrets: SecretStore,
    token: string,
    opts: { onDatacenterIp?: boolean; stickySuffix?: string } = {},
  ) {
    this.#gateway = gateway;
    this.#secrets = secrets;
    this.#token = token;
    this.#onDatacenterIp = opts.onDatacenterIp ?? false;
    this.#stickySuffix = opts.stickySuffix;
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

  async navigate(url: string): Promise<PageSnapshot> {
    return this.#serialize(() => this.#navigate(url));
  }

  async #navigate(url: string): Promise<PageSnapshot> {
    // Scheme allowlist (R14-adjacent): only http(s), rejected before any session/navigation —
    // mirrors retrieve(), so a non-http target can't slip past the host-based guard.
    if (!isHttpUrl(url)) {
      throw new Error(`unsupported URL scheme: only http(s) is allowed (${url})`);
    }
    // First navigate of a session: try direct, escalate to a proxied exit only on a block.
    if (!this.#pinned) {
      return this.#firstNavigate(url);
    }
    // Pinned session (direct or proxied): one shot. Reopen first if an idle reap closed it (same
    // mode). A failed nav means the committed exit/IP went bad, so discard it — the next navigate
    // re-runs the direct-first escalation rather than stranding the caller on a known-bad exit. We
    // surface the failure rather than swap the exit live under the page (that would lose state, KTD-5).
    await this.#ensureOpen();
    const snap = await this.#run((s) => s.core.navigate(url));
    if (navFailed(snap)) {
      await this.#discardSession();
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
  async #firstNavigate(url: string): Promise<PageSnapshot> {
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
      return this.#openHealthyAndNavigate(url);
    }
    throw new Error(
      `navigation failed (status=${direct.status ?? "n/a"}): the page was blocked or could not be reached`,
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
      const handle = this.#handle;
      if (!handle) return;
      this.#handle = undefined;
      await this.#gateway.closeConsumerSession(this.#token, handle).catch(() => {});
    });
  }

  /** Reopen the pinned session if an idle reap closed it, with the mode it committed to (direct or
   *  proxied; rotation-safe for the proxied case). Used on the pinned one-shot path. */
  async #ensureOpen(): Promise<void> {
    if (!this.#handle) {
      await this.#openSession(this.#proxiedSession ? this.#resolveProxyOverride() : undefined);
    }
  }

  /** Open a consumer session with the given core override (a proxied exit, or undefined for direct),
   *  recording whether it is proxied for reopen-after-reap and failure messaging. */
  async #openSession(override: BrowserCoreOptions | undefined): Promise<void> {
    this.#handle = await this.#gateway.openConsumerSession(this.#token, override);
    this.#proxiedSession = override !== undefined;
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
  async #openHealthyAndNavigate(url: string): Promise<PageSnapshot> {
    let last: PageSnapshot | undefined;
    for (let attempt = 1; attempt <= PROXY_OPEN_ATTEMPTS; attempt++) {
      const override = this.#resolveProxyOverride();
      if (!override) break; // proxy secrets rotated away mid-retry — surface the failure below
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
    throw new Error(
      `could not land a working proxied exit for ${url} after ${PROXY_OPEN_ATTEMPTS} attempts ` +
        `(last status=${last?.status ?? "n/a"})`,
    );
  }

  /** Close and forget the current session and its committed exit/mode, so the next navigate re-runs
   *  the direct-first escalation. Used between retry attempts and on a committed-exit failure. */
  async #discardSession(): Promise<void> {
    const handle = this.#handle;
    this.#handle = undefined;
    this.#pinned = false;
    this.#proxiedSession = false;
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
