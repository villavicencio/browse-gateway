/**
 * Per-consumer audit trail (R18). Every authentication outcome and every navigation
 * decision is recorded attributably so a consumer's actions can be reconstructed.
 */
import { redactSecrets } from "../security/secrets.js";
import type { SecretStore } from "../security/secrets.js";

export type AuditDecision = "auth-ok" | "auth-reject" | "allow" | "block";

export interface AuditRecord {
  ts: number;
  /** The consumer the action is attributed to, or `null` for a rejected authentication. */
  consumerId: string | null;
  action: "authenticate" | "navigate";
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
  record(entry: AuditRecord): void {
    this.records.push(entry);
  }
  /** Records attributed to a given consumer id. */
  forConsumer(consumerId: string): AuditRecord[] {
    return this.records.filter((r) => r.consumerId === consumerId);
  }
}

/** Emits structured JSON lines. Wrap with {@link RedactingAuditSink} if any field could carry a secret. */
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
