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
import { proxyOverrideFor, navFailed, shouldEscalateDrive, PROXY_OPEN_ATTEMPTS } from "../verbs/index.js";
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

  constructor(
    gateway: Gateway,
    secrets: SecretStore,
    token: string,
    opts: { onDatacenterIp?: boolean } = {},
  ) {
    this.#gateway = gateway;
    this.#secrets = secrets;
    this.#token = token;
    this.#onDatacenterIp = opts.onDatacenterIp ?? false;
  }

  /**
   * Resolve the proxy override fresh from the (possibly rotated) secret store on every session open,
   * so a `SecretStore.reload()` takes effect on the next session instead of being frozen at
   * construction. Returns the residential-proxy override when one is configured AND we're on a
   * datacenter IP, else undefined (direct).
   */
  #resolveProxyOverride(): BrowserCoreOptions | undefined {
    return proxyOverrideFor(this.#secrets, this.#onDatacenterIp);
  }

  async open(): Promise<void> {
    // Open a direct session lazily; escalation to a proxied exit (if needed) happens on the first
    // navigate — the only point we know whether the target blocks the direct IP.
    if (!this.#handle) await this.#openSession(undefined);
  }

  async navigate(url: string): Promise<PageSnapshot> {
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
    const override = this.#resolveProxyOverride();
    await this.#discardSession(); // drop the blocked direct session before escalating
    if (override && shouldEscalateDrive(direct)) {
      return this.#openHealthyAndNavigate(url, override);
    }
    throw new Error(
      `navigation failed (status=${direct.status ?? "n/a"}): the page was blocked or could not be reached`,
    );
  }

  async snapshot(): Promise<PageSnapshot> {
    return this.#run((s) => s.core.snapshot());
  }

  async click(target: DriveTarget): Promise<PageSnapshot> {
    return this.#actAndSnap((s) => s.core.click(target));
  }

  async type(target: DriveTarget, text: string, submit?: boolean): Promise<PageSnapshot> {
    return this.#actAndSnap((s) => s.core.type(target, text, { submit }));
  }

  async selectOption(target: DriveTarget, values: string[]): Promise<PageSnapshot> {
    return this.#actAndSnap((s) => s.core.selectOption(target, values));
  }

  async pressKey(key: string): Promise<PageSnapshot> {
    return this.#actAndSnap((s) => s.core.pressKey(key));
  }

  async waitFor(condition: WaitCondition): Promise<PageSnapshot> {
    return this.#actAndSnap((s) => s.core.waitFor(condition));
  }

  async screenshot(): Promise<string> {
    return this.#run((s) => s.core.screenshot());
  }

  async close(): Promise<void> {
    this.#pinned = false;
    this.#proxiedSession = false;
    const handle = this.#handle;
    if (!handle) return;
    this.#handle = undefined;
    await this.#gateway.closeConsumerSession(this.#token, handle).catch(() => {});
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
   * Escalation path: open a proxied session (each a fresh rotating exit) and navigate, retrying fresh
   * exits until one lands the page, then pin it. A dead/blocked exit fails fast (bounded proxy nav
   * timeout), so retries stay cheap; the per-consumer cap is respected because the unhealthy session
   * is discarded before the next opens. Worst case PROXY_OPEN_ATTEMPTS × the bounded proxy nav timeout
   * (~25s) — well under the idle-reaper TTL so an in-progress retry isn't reclaimed mid-flight.
   */
  async #openHealthyAndNavigate(url: string, override: BrowserCoreOptions): Promise<PageSnapshot> {
    let last: PageSnapshot | undefined;
    for (let attempt = 1; attempt <= PROXY_OPEN_ATTEMPTS; attempt++) {
      await this.#openSession(override);
      const snap = await this.#run((s) => s.core.navigate(url));
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
