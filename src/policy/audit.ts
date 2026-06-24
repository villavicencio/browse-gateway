/**
 * Per-consumer audit trail (R18). Every authentication outcome and every navigation
 * decision is recorded attributably so a consumer's actions can be reconstructed.
 */
import { redactSecrets } from "../security/secrets.js";
import type { SecretStore } from "../security/secrets.js";

export type AuditDecision = "auth-ok" | "auth-reject" | "allow" | "block" | "open";

export interface AuditRecord {
  ts: number;
  /** The consumer the action is attributed to, or `null` for a rejected authentication. */
  consumerId: string | null;
  /**
   * `session-open` marks a CREDENTIALED session (R4/R18) — one opened with a stored credential
   * RESTORED into the cookie jar (warm replay) — attributable on the trail by consumer + owning host.
   * Cold (stateless) sessions do not emit it, and neither does the cold login-CAPTURE session, which
   * MINTS auth rather than restoring it (its login navigation is audited as a `navigate`).
   */
  action: "authenticate" | "navigate" | "session-open";
  decision: AuditDecision;
  host?: string;
  url?: string;
  reason?: string;
}

export interface AuditSink {
  record(entry: AuditRecord): void;
}

/** Keeps records in memory — the default sink and the one tests assert against. */
export class InMemoryAuditSink implements AuditSink {
  readonly records: AuditRecord[] = [];
  readonly #max: number;

  /**
   * `maxRecords > 0` keeps only the most recent N records (ring buffer) so a long-lived
   * server — e.g. the stdio MCP process — can't grow this array without bound. `0` (default)
   * is unbounded, for tests and short-lived use.
   */
  constructor(maxRecords = 0) {
    this.#max = maxRecords;
  }

  record(entry: AuditRecord): void {
    this.records.push(entry);
    if (this.#max > 0 && this.records.length > this.#max) this.records.shift();
  }
  /** Records attributed to a given consumer id. */
  forConsumer(consumerId: string): AuditRecord[] {
    return this.records.filter((r) => r.consumerId === consumerId);
  }
}

/**
 * Emits structured JSON lines to **stdout**. Do NOT wire this into the stdio MCP server —
 * stdout there is the JSON-RPC protocol channel and these lines would corrupt it; log to
 * stderr or a file sink instead. Wrap with {@link RedactingAuditSink} if any field could
 * carry a secret.
 */
export const consoleAuditSink: AuditSink = {
  record(entry: AuditRecord): void {
    console.log(`[audit] ${JSON.stringify(entry)}`);
  },
};

/**
 * Wraps a sink and scrubs every known secret value out of the free-text fields (url, reason,
 * host) before they are recorded — so BYO proxy/CAPTCHA material can never surface in the
 * audit trail or any downstream log/observability output (R9).
 */
export class RedactingAuditSink implements AuditSink {
  readonly #inner: AuditSink;
  readonly #secrets: SecretStore;

  constructor(inner: AuditSink, secrets: SecretStore) {
    this.#inner = inner;
    this.#secrets = secrets;
  }

  record(entry: AuditRecord): void {
    const scrub = (s: string | undefined): string | undefined =>
      s === undefined ? undefined : redactSecrets(s, this.#secrets);
    this.#inner.record({
      ...entry,
      host: scrub(entry.host),
      url: scrub(entry.url),
      reason: scrub(entry.reason),
    });
  }
}
