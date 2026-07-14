/**
 * Host allowlist — pure, no I/O. A rule is one of:
 *   - an exact host (`example.com`, matched www-insensitively),
 *   - a subdomain wildcard (`*.example.com`, matching the apex and any subdomain), or
 *   - the bare allow-all sentinel `*`, which permits any (non-empty) host.
 * This is the matching half of the R14 navigation-layer allowlist. Allow-all only widens the
 * host gate; it does NOT bypass the scheme check or the egress deny-filter, both of which run
 * BEFORE the allowlist in {@link PolicyEngine.guardFor} (egress always wins). So a consumer with
 * `*` can reach any public host but still cannot navigate to a private/metadata IP literal.
 */
import { canonicalizeHost } from "../security/url.js";

/**
 * Canonicalize (lowercase, trim, strip a trailing FQDN-root dot) and drop a leading `www.`
 * so `www.x.com`, `x.com`, and `x.com.` all compare equal. Shares the canonicalization
 * primitive with the egress filter so the allow side and deny side agree on the host.
 */
export function normalizeHost(host: string): string {
  return canonicalizeHost(host).replace(/^www\./, "");
}

export class Allowlist {
  readonly #exact = new Set<string>();
  readonly #suffixes = new Set<string>();
  readonly #rules: string[] = [];
  #allowAll = false;

  constructor(rules: Iterable<string> = []) {
    for (const rule of rules) this.add(rule);
  }

  add(rule: string): void {
    const trimmed = rule.trim().toLowerCase();
    if (!trimmed) return;
    this.#rules.push(trimmed);
    // Bare `*` (no dot) is the allow-all sentinel. `*.x` remains a subdomain wildcard.
    if (trimmed === "*") {
      this.#allowAll = true;
    } else if (trimmed.startsWith("*.")) {
      // A wildcard suffix is canonicalized but kept www-SENSITIVE: `*.www.x.com` must stay scoped to
      // the www.x.com subtree, NOT be www-stripped into `*.x.com` — which would silently widen an
      // operator's rule to the entire domain (e.g. admit `mail.x.com`, `evil.x.com`; audit #6). An
      // ordinary `*.x.com` already matches `www.x.com` via the suffix-endsWith path below, so no
      // www-insensitivity is lost for the common case; only the interior-`www` footgun is closed.
      this.#suffixes.add(canonicalizeHost(trimmed.slice(2)));
    } else {
      this.#exact.add(normalizeHost(trimmed));
    }
  }

  /**
   * True when `host` is permitted by the allow-all sentinel, an exact rule, or a
   * subdomain-wildcard rule. An empty/host-less request is always denied (data:/about: etc.
   * have no meaningful host) — allow-all does not change that.
   */
  allows(host: string): boolean {
    // Two host forms from one canonicalization: `canon` is www-SENSITIVE (for wildcard-suffix
    // matching, so an interior `www` in a rule is honored — audit #6); `wwwless` drops a leading
    // `www.` (for exact rules, which stay www-insensitive as documented). `wwwless` is exactly
    // `normalizeHost(host)`, so exact matching is byte-for-byte unchanged.
    const canon = canonicalizeHost(host);
    if (!canon) return false;
    if (this.#allowAll) return true;
    const wwwless = canon.replace(/^www\./, "");
    if (this.#exact.has(wwwless)) return true;
    for (const suffix of this.#suffixes) {
      if (canon === suffix || canon.endsWith(`.${suffix}`)) return true;
    }
    return false;
  }

  /** The rules as configured (for audit/inspection). */
  get rules(): readonly string[] {
    return this.#rules;
  }
}
