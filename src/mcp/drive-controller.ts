/**
 * Concrete {@link DriveController}: binds the stateful drive verbs to the gateway and one consumer
 * token, tracking the current session handle. It lazily opens the session on the first navigate/open,
 * reuses it across verbs, and closes it on demand. Errors are scrubbed of BYO secret material (R9);
 * a session that was idle-reaped out from under us is detected and the handle reset so the next
 * navigate transparently reopens. Action verbs return the post-action snapshot.
 */
import { isHttpUrl, redactSecrets } from "../security/index.js";
import type { SecretStore } from "../security/index.js";
import type { Gateway, Session } from "../gateway/index.js";
import { isVisiblyBlocked } from "../browser/index.js";
import type { BrowserCoreOptions, DriveTarget, PageSnapshot, WaitCondition } from "../browser/index.js";
import { proxyOverrideFor, navFailed, PROXY_OPEN_ATTEMPTS } from "../verbs/index.js";
import type { DriveController } from "./server.js";

export class GatewayDriveController implements DriveController {
  #handle?: string;
  /** True once a (proxied) session has landed a healthy exit; pinned exits are not re-rolled. */
  #pinned = false;
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
    await this.#ensureOpen();
  }

  async navigate(url: string): Promise<PageSnapshot> {
    // Scheme allowlist (R14-adjacent): only http(s), rejected before any session/navigation —
    // mirrors retrieve(), so a non-http target can't slip past the host-based guard.
    if (!isHttpUrl(url)) {
      throw new Error(`unsupported URL scheme: only http(s) is allowed (${url})`);
    }
    const proxied = this.#resolveProxyOverride() !== undefined;
    // Proxied session, not yet pinned: retry across fresh exits until one lands the page (R7 / KTD-5).
    if (proxied && !this.#pinned) {
      return this.#openHealthyAndNavigate(url);
    }
    // Pinned proxied session or a direct session: one shot. A failed nav is surfaced cleanly rather
    // than returned as a blank page. For a proxied session a mid-flow failure also discards the
    // session (below) so the next navigate auto-draws a fresh exit; a direct session is left intact.
    await this.#ensureOpen();
    const snap = await this.#run((s) => s.core.navigate(url));
    if (navFailed(snap)) {
      if (proxied) {
        // The pinned exit went bad (or the page stayed blocked): discard + unpin so the NEXT
        // navigate transparently draws a fresh exit instead of stranding the caller on the known-bad
        // pinned exit. We still surface the failure rather than swap the exit live under the current
        // page — that would lose page state (KTD-5).
        await this.#discardSession();
        this.#pinned = false;
      }
      throw new Error(
        `navigation failed (status=${snap.status ?? "n/a"}): the page was blocked or could not be ` +
          `reached${proxied ? " — retry navigate for a fresh exit" : ""}`,
      );
    }
    return snap;
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
    const handle = this.#handle;
    if (!handle) return;
    this.#handle = undefined;
    await this.#gateway.closeConsumerSession(this.#token, handle).catch(() => {});
  }

  /** Open the session lazily on first use, with a freshly-resolved proxy override (rotation-safe). */
  async #ensureOpen(): Promise<void> {
    if (!this.#handle) {
      this.#handle = await this.#gateway.openConsumerSession(this.#token, this.#resolveProxyOverride());
    }
  }

  /**
   * First navigate of a proxied session: try fresh sessions (each a fresh rotating exit) until one
   * lands the page, then pin it. A dead/blocked exit fails fast, so retries stay cheap; the per-
   * consumer cap is respected because the unhealthy session is discarded before the next opens.
   * Worst case is PROXY_OPEN_ATTEMPTS × the bounded proxy nav timeout (~25s each) — kept well under
   * the idle-reaper TTL so an in-progress retry isn't reclaimed mid-flight.
   */
  async #openHealthyAndNavigate(url: string): Promise<PageSnapshot> {
    let last: PageSnapshot | undefined;
    for (let attempt = 1; attempt <= PROXY_OPEN_ATTEMPTS; attempt++) {
      await this.#ensureOpen();
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

  /** Close and forget the current session (used between retry attempts to force a fresh exit). */
  async #discardSession(): Promise<void> {
    const handle = this.#handle;
    this.#handle = undefined;
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
      if (isVisiblyBlocked({ title: snap.title, text: snap.tree })) {
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
