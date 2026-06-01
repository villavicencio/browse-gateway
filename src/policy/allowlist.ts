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
      this.#suffixes.add(normalizeHost(trimmed.slice(2)));
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
    const h = normalizeHost(host);
    if (!h) return false;
    if (this.#allowAll) return true;
    if (this.#exact.has(h)) return true;
    for (const suffix of this.#suffixes) {
      if (h === suffix || h.endsWith(`.${suffix}`)) return true;
    }
    return false;
  }

  /** The rules as configured (for audit/inspection). */
  get rules(): readonly string[] {
    return this.#rules;
  }
}
