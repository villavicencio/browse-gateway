/**
 * Egress host classification (R19) — pure, no I/O. Blocks requests to cloud metadata and
 * internal/private address space at the browser layer (defense in depth; the container
 * network filter in compose is the complementary layer that also catches DNS-resolved
 * private IPs). Matches literal IP hosts and well-known internal hostnames.
 */

export const EGRESS_DENY_REASON = "egress: private/internal/metadata address blocked";

function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const octets = m.slice(1, 5).map(Number);
  if (octets.some((n) => n > 255)) return false;
  const [a = -1, b = -1] = octets;
  if (a === 0 || a === 10 || a === 127) return true; // "this", private-A, loopback
  if (a === 169 && b === 254) return true; // link-local — incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private-B
  if (a === 192 && b === 168) return true; // private-C
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  return false;
}

/**
 * True when `rawHost` is a metadata/internal/private destination that must never be
 * reachable from the sandbox, regardless of any consumer allowlist.
 */
export function isBlockedEgressHost(rawHost: string): boolean {
  let host = rawHost.trim().toLowerCase();
  if (!host) return false;
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1); // strip IPv6 brackets

  // Internal hostnames
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "metadata" || host === "metadata.google.internal" || host === "metadata.goog") return true;
  if (host.endsWith(".internal") || host.endsWith(".local")) return true;

  // IPv4 literals
  if (isPrivateIpv4(host)) return true;

  // IPv6 literals
  if (host === "::1" || host === "::") return true; // loopback / unspecified
  if (/^fe[89ab]/.test(host)) return true; // fe80::/10 link-local
  if (/^f[cd]/.test(host)) return true; // fc00::/7 unique-local
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
  if (mapped) return isPrivateIpv4(mapped[1] ?? "");

  return false;
}
