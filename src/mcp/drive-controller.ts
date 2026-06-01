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
  /** Core overrides used at open — the residential proxy when configured + on a datacenter IP. */
  readonly #proxyOverride?: BrowserCoreOptions;

  constructor(
    gateway: Gateway,
    secrets: SecretStore,
    token: string,
    opts: { onDatacenterIp?: boolean } = {},
  ) {
    this.#gateway = gateway;
    this.#secrets = secrets;
    this.#token = token;
    this.#proxyOverride = proxyOverrideFor(secrets, opts.onDatacenterIp ?? false);
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
    // Proxied session, not yet pinned: retry across fresh exits until one lands the page (R7 / KTD-5).
    if (this.#proxyOverride && !this.#pinned) {
      return this.#openHealthyAndNavigate(url);
    }
    // Pinned proxied session or a direct session: one shot. A failed nav is surfaced cleanly rather
    // than returned as a blank page — for a proxied session the exit may have gone bad mid-flow, so
    // closing and reopening the drive session draws a fresh exit.
    await this.#ensureOpen();
    const snap = await this.#run((s) => s.core.navigate(url));
    if (navFailed(snap)) {
      throw new Error(
        `navigation failed (status=${snap.status ?? "n/a"}): the page was blocked or could not be ` +
          `reached${this.#proxyOverride ? " — close and reopen the drive session for a fresh exit" : ""}`,
      );
    }
    return snap;
  }

  async snapshot(): Promise<PageSnapshot> {
    return this.#run((s) => s.core.snapshot());
  }

  async click(target: DriveTarget): Promise<PageSnapshot> {
    return this.#run(async (s) => {
      await s.core.click(target);
      return s.core.snapshot();
    });
  }

  async type(target: DriveTarget, text: string, submit?: boolean): Promise<PageSnapshot> {
    return this.#run(async (s) => {
      await s.core.type(target, text, { submit });
      return s.core.snapshot();
    });
  }

  async selectOption(target: DriveTarget, values: string[]): Promise<PageSnapshot> {
    return this.#run(async (s) => {
      await s.core.selectOption(target, values);
      return s.core.snapshot();
    });
  }

  async pressKey(key: string): Promise<PageSnapshot> {
    return this.#run(async (s) => {
      await s.core.pressKey(key);
      return s.core.snapshot();
    });
  }

  async waitFor(condition: WaitCondition): Promise<PageSnapshot> {
    return this.#run(async (s) => {
      await s.core.waitFor(condition);
      return s.core.snapshot();
    });
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

  /** Open the session lazily on first use, with the proxy override when one is configured. */
  async #ensureOpen(): Promise<void> {
    if (!this.#handle) {
      this.#handle = await this.#gateway.openConsumerSession(this.#token, this.#proxyOverride);
    }
  }

  /**
   * First navigate of a proxied session: try fresh sessions (each a fresh rotating exit) until one
   * lands the page, then pin it. A dead/blocked exit fails fast, so retries stay cheap; the per-
   * consumer cap is respected because the unhealthy session is discarded before the next opens.
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
