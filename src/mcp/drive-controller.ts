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
import type { DriveTarget, PageSnapshot, WaitCondition } from "../browser/index.js";
import type { DriveController } from "./server.js";

export class GatewayDriveController implements DriveController {
  #handle?: string;
  readonly #gateway: Gateway;
  readonly #secrets: SecretStore;
  readonly #token: string;

  constructor(gateway: Gateway, secrets: SecretStore, token: string) {
    this.#gateway = gateway;
    this.#secrets = secrets;
    this.#token = token;
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
    await this.#ensureOpen();
    return this.#run((s) => s.core.navigate(url));
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
    const handle = this.#handle;
    if (!handle) return;
    this.#handle = undefined;
    await this.#gateway.closeConsumerSession(this.#token, handle).catch(() => {});
  }

  /** Open the session lazily on first use. */
  async #ensureOpen(): Promise<void> {
    if (!this.#handle) {
      this.#handle = await this.#gateway.openConsumerSession(this.#token);
    }
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
