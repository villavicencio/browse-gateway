/**
 * BYO proxy/CAPTCHA secret isolation (R9). Secrets load from a source (env by default,
 * readable only by the gateway process user in deployment) into an in-memory store that
 * never stringifies its values. `redactSecrets` scrubs secret material out of any text
 * bound for logs, audit records, or session/observability output. `reload()` supports
 * rotation without a full redeploy.
 */
import { inspect } from "node:util";

export type SecretSource = () => Record<string, string | undefined>;

/** Shortest value `redactSecrets` will scrub — a 1–2 char value is skipped so it can't blanket-redact
 *  ordinary output. A credential shorter than this is UNREDACTABLE, so it is rejected at ingress. */
const MIN_REDACTABLE_LEN = 3;
/** Reserved output markers redaction emits; a secret equal to one would be re-introduced post-scrub. */
const RESERVED_REDACTION_MARKERS = new Set(["[REDACTED]", "<url>"]);

/**
 * Fail CLOSED on a credential that {@link redactSecrets} could not hide: a 1–2 char value it skips (to
 * avoid blanket-redacting ordinary text), or a value equal to an output marker (re-introduced post-scrub).
 * Enforced at EVERY redaction ingress (typed SECRET_KEYS + {@link SecretStore.addRedactable}) so no
 * un-redactable credential can enter the set. `label` names the source (a key / "a registered secret") —
 * the rejected VALUE is NEVER interpolated, so the boot/registration error can't itself leak the secret.
 */
function assertRedactableSecret(value: string, label: string): void {
  if (value.length < MIN_REDACTABLE_LEN) {
    throw new Error(`${label} is too short (<${MIN_REDACTABLE_LEN} chars) to be redactable — it would leak in logs; use a longer value`);
  }
  if (RESERVED_REDACTION_MARKERS.has(value)) {
    throw new Error(`${label} collides with a reserved redaction marker — use a different value`);
  }
}

/** The BYO secret env keys the gateway recognizes. */
export const SECRET_KEYS = [
  "BGW_PROXY_URL",
  "BGW_PROXY_USERNAME",
  "BGW_PROXY_PASSWORD",
  "BGW_CAPTCHA_API_KEY",
  // Raw base64 vault master key (the fallback to BGW_VAULT_KEY_FILE) — folded in so it's never
  // stringified and is auto-redacted. The FILE-path variant is not secret and stays out of this set.
  "BGW_VAULT_KEY",
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
        assertRedactableSecret(value, `secret ${key}`); // fail closed on an un-redactable credential (audit #3)
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
  /**
   * Register PERMISSIVE, possibly-short values for redaction — sticky-suffix STRUCTURE fragments and
   * non-secret usernames, where a <3 value is legitimate and redactSecrets' <3 skip is the intended
   * behavior. Rejects only a reserved-marker collision (never legitimate, would be re-introduced
   * post-scrub). For CREDENTIALS that MUST be redactable (tokens, passwords, TOTP seeds, sensitive vault
   * leaves), use {@link addRedactableCredential}, which additionally rejects an unredactable <3 value.
   */
  addRedactable(values: Iterable<string>): void {
    for (const v of values) {
      if (!v) continue;
      if (RESERVED_REDACTION_MARKERS.has(v)) {
        throw new Error("a registered secret collides with a reserved redaction marker — use a different value");
      }
      this.#redactable.add(v);
    }
  }

  /**
   * Register CREDENTIAL-grade values (consumer tokens, vault passwords / TOTP seeds, sensitive vault
   * leaves) for redaction, enforcing the FULL redactability invariant at this ingress: a value too
   * short to redact (<3, which redactSecrets skips) or equal to an output marker is REJECTED — fail
   * closed, so an unredactable credential can never be persisted/used and then leak in a log. The error
   * names only the source, never the value.
   */
  addRedactableCredential(values: Iterable<string>): void {
    for (const v of values) {
      if (!v) continue;
      assertRedactableSecret(v, "a credential");
      this.#redactable.add(v);
    }
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
 * but still in flight cannot leak. Each secret is matched in several forms: verbatim, URL-encoded
 * (proxy creds frequently surface percent-encoded in driver errors), and the two common Node serializer
 * escapings, which diverge: JSON.stringify escapes a quote as backslash-quote and control chars as
 * `\uNNNN`, while util.inspect uses single-quote style and escapes control chars as `\xNN` — since a
 * secret containing a quote/backslash/control char is transformed by whichever
 * serializer a log path uses. Longer values replace first so a secret containing another isn't partially
 * revealed; values under 3 chars are skipped so they can't blanket-redact ordinary output.
 *
 * This variant set is BEST-EFFORT defense-in-depth, NOT a completeness guarantee — literal matching
 * cannot cover every possible serialization/encoding of a value. The AUTHORITATIVE guarantee is
 * redact-BEFORE-serialize: scrub the raw string before any escaping transform (see how the smoke logger
 * `gateway/smoke-log.ts` redacts each raw leaf before it serializes).
 */
export function redactSecrets(text: string, store: { redactableValues(): readonly string[] }): string {
  let out = text;
  const variants = new Set<string>();
  for (const value of store.redactableValues()) {
    if (value.length < 3) continue;
    variants.add(value);
    const encoded = encodeURIComponent(value);
    if (encoded !== value) variants.add(encoded);
    // The two common Node serializer escapings, inner content only (strip the 1-char delimiter each adds).
    const jsonEscaped = JSON.stringify(value).slice(1, -1);
    if (jsonEscaped !== value) variants.add(jsonEscaped);
    const inspectEscaped = inspect(value, { maxStringLength: Infinity }).slice(1, -1);
    if (inspectEscaped !== value) variants.add(inspectEscaped);
  }
  const ordered = [...variants].sort((a, b) => b.length - a.length);
  for (const value of ordered) {
    // Literal replace (not a compiled RegExp): a secret is matched verbatim, so replaceAll is exactly
    // equivalent to a global replace of the escaped literal — but it avoids the per-call regex
    // COMPILATION cost and, critically, never throws V8's "regular expression too large" at execution
    // on a big folded value (e.g. a long session token / JWT), which `new RegExp(escapeRegExp(value))`
    // does. (`escapeRegExp` stays exported for callers that build actual patterns, e.g. cli/tunnel.)
    out = out.replaceAll(value, "[REDACTED]");
  }
  return out;
}
