/**
 * Shared URL/host canonicalization for the policy, egress, and navigation-guard layers.
 * One source of truth so the allowlist (allow side) and the egress filter (deny side) agree
 * on what "the host" is — divergent normalization is exactly how a host slips past one check
 * but not the other (e.g. a trailing-dot FQDN). Pure, no I/O.
 */

/** Lowercase, trim, and strip a single trailing FQDN-root dot (`example.com.` === `example.com`). */
export function canonicalizeHost(rawHost: string): string {
  let host = rawHost.trim().toLowerCase();
  if (host.length > 1 && host.endsWith(".")) host = host.slice(0, -1);
  return host;
}

/** Canonical host with IPv6 brackets stripped, for IP-literal classification. */
export function canonicalizeHostForIp(rawHost: string): string {
  const host = canonicalizeHost(rawHost);
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

const HTTP_SCHEMES = new Set(["http:", "https:"]);

/**
 * True only for http(s) URLs. Everything else — file:, data:, blob:, ftp:, view-source:,
 * chrome: — is rejected, so a non-http target can't slip past the host-based policy (whose
 * host is empty for those schemes) or read local files via `file://`.
 */
export function isHttpUrl(url: string): boolean {
  try {
    return HTTP_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** Canonical host for a URL, or "" if it can't be parsed. Used by the navigation guard. */
export function hostFromUrl(url: string): string {
  try {
    return canonicalizeHost(new URL(url).hostname);
  } catch {
    return "";
  }
}

/**
 * Canonicalize a host AND fold it to ASCII/punycode, so a Unicode IDN host (`bücher.example`) and its
 * punycode form (`xn--bcher-kva.example`, which is what Chrome emits in a cookie `domain`) compare
 * equal. Falls back to the plain canonical form when the host can't be parsed as a URL authority (an
 * IP literal, or already-degenerate input). Used only by {@link cookieBelongsToHost} so both sides of
 * the host-scope comparison are in the same encoding.
 */
function asciiHost(rawHost: string): string {
  const canon = canonicalizeHost(rawHost);
  if (!canon) return canon;
  try {
    return canonicalizeHost(new URL(`https://${canon}`).hostname);
  } catch {
    return canon;
  }
}

/**
 * True when a cookie/origin `domain` belongs to a vault entry's owning `ownerHost` — the host-scope
 * test for warm-replay no-exfil (R4). A stored entry keyed on host-A must only ever inject cookies
 * scoped to host-A, never a third-party (analytics/CDN) or smuggled host-B cookie that `storageState()`
 * also captured. "Belongs" means one of:
 *   - same host (`d === h`);
 *   - the cookie domain is a subdomain of the owner (`sub.h` belongs to `h`);
 *   - the cookie domain is a DOTTED parent of the owner (the SSO/apex case: an `accounts.example.com`
 *     login that sets a `.example.com` cookie).
 * A SINGLE-LABEL owner (a bare TLD like `com`, or an unqualified intranet name) can only ever match
 * EXACTLY — both walks below require the owner to be a real dotted host. Otherwise `com` would "own"
 * every `*.com` cookie and the filter would be a near-no-op against the exact exfil class it exists to
 * stop. Both sides are folded to ASCII (punycode) and have leading cookie dots / trailing FQDN dots
 * normalized away first. Dependency-free by design (no Public Suffix List): multi-label suffixes like
 * `co.uk` are out of scope — vault entries are operator-captured and AAD-bound to `(consumer, host)`,
 * so the realistic threat is a mis-filed blob (third-party cookies in the jar), not an adversarial one.
 */
export function cookieBelongsToHost(domain: string, ownerHost: string): boolean {
  const d = asciiHost(domain.startsWith(".") ? domain.slice(1) : domain);
  const h = asciiHost(ownerHost);
  if (!d || !h) return false;
  if (d === h) return true;
  // A single-label owner (bare TLD / unqualified host) never owns anything beyond the exact match
  // above — without this, a dotless `h` would claim every cookie ending in `.h` via the subdomain walk.
  if (!h.includes(".")) return false;
  // Cookie domain is a subdomain of the owner host: d = "sub." + h.
  if (d.endsWith("." + h)) return true;
  // Cookie domain is a dotted parent of the owner host (apex/SSO): h = "sub." + d, and d has a dot
  // (so a bare TLD like "com" is rejected on this side too).
  if (h.endsWith("." + d) && d.includes(".")) return true;
  return false;
}
