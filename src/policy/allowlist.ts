/**
 * Host allowlist — pure, no I/O. A rule is either an exact host (`example.com`, matched
 * www-insensitively) or a subdomain wildcard (`*.example.com`, matching the apex and any
 * subdomain). This is the matching half of the R14 navigation-layer allowlist.
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

  constructor(rules: Iterable<string> = []) {
    for (const rule of rules) this.add(rule);
  }

  add(rule: string): void {
    const trimmed = rule.trim().toLowerCase();
    if (!trimmed) return;
    this.#rules.push(trimmed);
    if (trimmed.startsWith("*.")) {
      this.#suffixes.add(normalizeHost(trimmed.slice(2)));
    } else {
      this.#exact.add(normalizeHost(trimmed));
    }
  }

  /** True when `host` is permitted by an exact rule or a subdomain-wildcard rule. */
  allows(host: string): boolean {
    const h = normalizeHost(host);
    if (!h) return false;
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
