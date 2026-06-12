/**
 * BYO proxy/CAPTCHA secret isolation (R9). Secrets load from a source (env by default,
 * readable only by the gateway process user in deployment) into an in-memory store that
 * never stringifies its values. `redactSecrets` scrubs secret material out of any text
 * bound for logs, audit records, or session/observability output. `reload()` supports
 * rotation without a full redeploy.
 */

export type SecretSource = () => Record<string, string | undefined>;

/** The BYO secret env keys the gateway recognizes. */
export const SECRET_KEYS = [
  "BGW_PROXY_URL",
  "BGW_PROXY_USERNAME",
  "BGW_PROXY_PASSWORD",
  "BGW_CAPTCHA_API_KEY",
] as const;

export type SecretKey = (typeof SECRET_KEYS)[number];

export class SecretStore {
  readonly #source: SecretSource;
  #values = new Map<SecretKey, string>();
  /**
   * Every secret value ever loaded, across reloads. Redaction scrubs against THIS set, not just the
   * current values: after a rotation a retired credential can still be in flight — held by an open
   * session opened before the rotation, or already embedded in an error in transit — and must stay
   * redactable so it can never surface in logs/audit/consumer-facing output (R9).
   */
  #redactable = new Set<string>();

  constructor(source: SecretSource = () => process.env) {
    this.#source = source;
    this.reload();
  }

  /** Re-read secrets from the source. Use for rotation without restarting the process. */
  reload(): void {
    const env = this.#source();
    const next = new Map<SecretKey, string>();
    for (const key of SECRET_KEYS) {
      const value = env[key];
      if (value) {
        next.set(key, value);
        this.#redactable.add(value); // never forget a value, so rotation can't un-redact it
      }
    }
    this.#values = next;
  }

  /**
   * Register additional secret-grade values for redaction WITHOUT widening the typed key enum.
   * Consumer bearer tokens (loaded from the manifest at startup, R18) are not BYO proxy/CAPTCHA
   * keys, but they are credentials: this folds them into the same ever-loaded redaction set so a
   * token can never surface in a log, audit record, or consumer-facing error (R9). Idempotent;
   * values are never forgotten (rotation-safe, like {@link reload}). Keep the set bounded — register
   * only durable consumer tokens, not ephemeral per-request values.
   */
  addRedactable(values: Iterable<string>): void {
    for (const v of values) if (v) this.#redactable.add(v);
  }

  get(key: SecretKey): string | undefined {
    return this.#values.get(key);
  }

  has(key: SecretKey): boolean {
    return this.#values.has(key);
  }

  /** Present secret values. */
  secretValues(): string[] {
    return [...this.#values.values()];
  }

  /**
   * Every secret value ever loaded — the set `redactSecrets` scrubs. Includes values rotated out of
   * the store so a retired-but-in-flight credential is never leaked. (Process-lifetime set; a handful
   * of values plus rotations — bounded.)
   */
  redactableValues(): string[] {
    return [...this.#redactable];
  }

  /** Stringifies to redacted placeholders so a store can never leak via logging. */
  toJSON(): Record<string, string> {
    return Object.fromEntries([...this.#values.keys()].map((k) => [k, "[REDACTED]"]));
  }
}

/** Escape a literal string for embedding in a RegExp. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace every known secret value in `text` with `[REDACTED]`. Scrubs against every value the store
 * has EVER loaded (see {@link SecretStore.redactableValues}) so a credential rotated out of the store
 * but still in flight cannot leak. Each secret is matched both verbatim and in its URL-encoded form
 * (proxy creds frequently surface percent-encoded in driver error messages), and longer values are
 * replaced first so a secret that contains another isn't partially revealed. Values shorter than
 * 3 chars are skipped so a 1–2 char secret can't blanket-redact ordinary output.
 */
export function redactSecrets(text: string, store: SecretStore): string {
  let out = text;
  const variants = new Set<string>();
  for (const value of store.redactableValues()) {
    if (value.length < 3) continue;
    variants.add(value);
    const encoded = encodeURIComponent(value);
    if (encoded !== value) variants.add(encoded);
  }
  const ordered = [...variants].sort((a, b) => b.length - a.length);
  for (const value of ordered) {
    out = out.replace(new RegExp(escapeRegExp(value), "g"), "[REDACTED]");
  }
  return out;
}
