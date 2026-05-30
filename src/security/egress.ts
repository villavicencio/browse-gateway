/**
 * Egress host classification (R19) — pure, no I/O. Blocks requests to cloud metadata and
 * internal/private address space at the browser layer (defense in depth; the container
 * network filter in compose is the complementary layer that also catches DNS-resolved
 * private IPs). IP-literal ranges are matched with node:net.BlockList, which canonicalizes
 * IPv4-mapped IPv6 (e.g. `::ffff:7f00:1`) against the IPv4 rules — closing the alternate-
 * encoding bypasses (mapped-IPv6 hex form, decimal/octal IPv4) a hand-rolled regex misses.
 * Hostnames are canonicalized first so a trailing-dot FQDN (`metadata.google.internal.`)
 * can't evade the internal-name checks.
 */
import { BlockList, isIP } from "node:net";
import { canonicalizeHostForIp } from "./url.js";

export const EGRESS_DENY_REASON = "egress: private/internal/metadata address blocked";

const PRIVATE = new BlockList();
// IPv4 — "this"/unspecified, private-A/B/C, loopback, link-local (incl. 169.254.169.254
// metadata), and CGNAT 100.64/10.
PRIVATE.addSubnet("0.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("127.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("169.254.0.0", 16, "ipv4");
PRIVATE.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE.addSubnet("100.64.0.0", 10, "ipv4");
// IPv6 — loopback, unspecified, unique-local (fc00::/7), link-local (fe80::/10), and
// site-local (fec0::/10; deprecated but still routable on some hosts).
PRIVATE.addAddress("::1", "ipv6");
PRIVATE.addAddress("::", "ipv6");
PRIVATE.addSubnet("fc00::", 7, "ipv6");
PRIVATE.addSubnet("fe80::", 10, "ipv6");
PRIVATE.addSubnet("fec0::", 10, "ipv6");

/**
 * True when `rawHost` is a metadata/internal/private destination that must never be
 * reachable from the sandbox, regardless of any consumer allowlist.
 */
export function isBlockedEgressHost(rawHost: string): boolean {
  const host = canonicalizeHostForIp(rawHost);
  if (!host) return false;

  // Internal hostnames (canonicalized, so a trailing-dot FQDN can't slip past).
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "metadata" || host === "metadata.google.internal" || host === "metadata.goog") return true;
  if (host.endsWith(".internal") || host.endsWith(".local")) return true;

  // IP literals — BlockList covers every private range plus IPv4-mapped IPv6.
  const family = isIP(host);
  if (family === 4) return PRIVATE.check(host, "ipv4");
  if (family === 6) return PRIVATE.check(host, "ipv6");
  return false;
}
