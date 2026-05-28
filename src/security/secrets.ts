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
      if (value) next.set(key, value);
    }
    this.#values = next;
  }

  get(key: SecretKey): string | undefined {
    return this.#values.get(key);
  }

  has(key: SecretKey): boolean {
    return this.#values.has(key);
  }

  /** Present secret values, for redaction. */
  secretValues(): string[] {
    return [...this.#values.values()];
  }

  /** Stringifies to redacted placeholders so a store can never leak via logging. */
  toJSON(): Record<string, string> {
    return Object.fromEntries([...this.#values.keys()].map((k) => [k, "[REDACTED]"]));
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace every known secret value in `text` with `[REDACTED]`. Values shorter than 4 chars
 * are skipped to avoid over-matching, and longer secrets are replaced first so a secret that
 * contains another isn't partially revealed.
 */
export function redactSecrets(text: string, store: SecretStore): string {
  let out = text;
  const values = store
    .secretValues()
    .filter((v) => v.length >= 4)
    .sort((a, b) => b.length - a.length);
  for (const value of values) {
    out = out.replace(new RegExp(escapeRegExp(value), "g"), "[REDACTED]");
  }
  return out;
}
