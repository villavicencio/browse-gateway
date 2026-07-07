/**
 * Scoped proxy-escalation decision (R7). The residential proxy is engaged from the datacenter
 * IP on two block kinds the local IP cannot clear: a Cloudflare *managed challenge*, or a *hard
 * block* — a 4xx/5xx IP/WAF-reputation block with no real content (F1, 2026-06-01; see
 * `isHardBlock`). It is NOT engaged for soft targets or DataDome (the spike showed those pass
 * direct from the datacenter). Pure logic.
 */
import { assess, isHardBlock, CF_BLOCK_PHRASES, CF_VENDOR_HINTS } from "../browser/index.js";
import type { PageSignal } from "../browser/index.js";
import { parseHostSuffixList, hostMatchesAnySuffix } from "../security/index.js";

/**
 * True when the page is blocked AND the block is specifically a Cloudflare challenge
 * (phrase in the visible title/text, or a CF challenge script in the HTML). A *cleared*
 * CF page is not blocked, so it returns false even though its HTML still carries CF scripts.
 * CF signatures come from detect.ts (single source of truth) so this gate can't drift from
 * detection.
 */
export function isCloudflareBlock(signal: PageSignal): boolean {
  if (!assess(signal).blocked) return false;
  const visible = `${signal.title}\n${signal.text}`;
  if (CF_BLOCK_PHRASES.some((re) => re.test(visible))) return true;
  return CF_VENDOR_HINTS.some((re) => re.test(signal.html));
}

export interface EscalationContext {
  /** Whether the gateway is running from a datacenter IP (the R7 trigger condition). */
  onDatacenterIp: boolean;
  /** Whether a residential proxy is configured/available to escalate to. */
  proxyAvailable: boolean;
}

/**
 * Engage the proxy from a datacenter IP, with a proxy available, on either block the local IP
 * cannot clear: a CF managed challenge, or a hard 4xx/5xx-with-thin-body block. `status` is the
 * final-render HTTP status (`isHardBlock` ignores it when `null` or < 400).
 */
export function shouldEscalateToProxy(
  signal: PageSignal,
  status: number | null,
  ctx: EscalationContext,
): boolean {
  if (!ctx.onDatacenterIp || !ctx.proxyAvailable) return false;
  return isCloudflareBlock(signal) || isHardBlock(signal, status);
}

/**
 * Parse `BGW_FORCE_PROXY_HOSTS` — a comma-separated list of host suffixes (e.g.
 * "totalwine.com,www.example.com") — into a normalized lowercase list. A target whose host matches
 * one skips the direct-first attempt and goes residential from the FIRST request (issue #21): for a
 * known-hostile WAF (PerimeterX et al.) the direct attempt only burns time and trips reputation.
 */
export function parseForceProxyHosts(value: string | undefined): string[] {
  // Delegates to the shared parser (security/url) so force-proxy, fresh-exit, and windows-UA host
  // lists parse identically and can never drift.
  return parseHostSuffixList(value);
}

/** True when `host` matches a force-proxy suffix — an exact match or a dotted subdomain of it
 *  (`totalwine.com` covers `www.totalwine.com` but NOT `nottotalwine.com`). Both sides are
 *  {@link canonicalizeHost}-normalized so a trailing-dot FQDN (`www.totalwine.com.`) cannot slip past
 *  the match — the same canonical host the vault lookup / nav clamp use, so a force-proxy / fresh-exit
 *  policy decision can't be bypassed by caller URL spelling. */
export function hostForcesProxy(host: string, suffixes: readonly string[]): boolean {
  // Delegates to the shared matcher (security/url) — one suffix-match implementation across the
  // force-proxy / fresh-exit / windows-UA / warm-up per-host policies.
  return hostMatchesAnySuffix(host, suffixes);
}

/**
 * Parse `BGW_WARMUP_PATHS` — the shallow same-origin path(s) a warm-open navigates FIRST so a
 * behavioral/edge WAF (PerimeterX) issues a clearance token into the live session, before the
 * consumer's real (possibly deep, authed) target. A logged-in-looking first request straight to a
 * deep page carries no clearance and is hard-403'd; landing a shallow page first mints the token, and
 * the target navigate then carries it (solution 2026-06-28). Comma-separated; empty/unset → the host
 * root (`["/"]`), the proven default.
 *
 * FAIL-CLOSED at boot: a value that is not a same-host ABSOLUTE PATH — it must start with a single
 * `/` and carry no scheme or authority — THROWS, so a config typo can't silently point a warm-up hop
 * off the credential's owner host. (The owner host is always supplied by the sealed vault override at
 * nav time, never from here, and the warm session's nav-clamp would block an off-owner request anyway;
 * this parser just refuses to even express one.) A protocol-relative `//host` or a full `scheme://…`
 * is rejected precisely because those are the two shapes that could re-introduce an authority.
 */
export function parseWarmupPaths(value: string | undefined): string[] {
  const paths = (value ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (paths.length === 0) return ["/"]; // proven default: warm up on the host root
  for (const p of paths) {
    if (!p.startsWith("/") || p.startsWith("//") || p.includes("://")) {
      throw new Error(
        `BGW_WARMUP_PATHS: "${p}" is not a same-host absolute path — each warm-up path must start with ` +
          `a single "/" and carry no scheme or host (the owner host comes from the sealed vault entry)`,
      );
    }
  }
  return paths;
}
