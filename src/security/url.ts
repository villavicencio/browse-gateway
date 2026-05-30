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
