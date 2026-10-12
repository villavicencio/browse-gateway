/**
 * Scoped proxy-escalation decision (R7). The residential proxy is engaged from the datacenter
 * IP on two block kinds the local IP cannot clear: a Cloudflare *managed challenge*, or a *hard
 * block* — a 4xx/5xx IP/WAF-reputation block with no real content (F1, 2026-06-01; see
 * `isHardBlock`). It is NOT engaged for soft targets or DataDome (the spike showed those pass
 * direct from the datacenter). Pure logic.
 */
import { assess, isExitClearableHardBlock, isTerminalUnclearableRender, CF_BLOCK_PHRASES, CF_VENDOR_HINTS } from "../browser/index.js";
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
  /**
   * VIL-292: host suffixes AUTOMATIC escalation may fire for (`BGW_ESCALATE_HOSTS`, see
   * {@link parseEscalateHosts}). `undefined` = every host (the pre-VIL-292 behavior); `[]` = none.
   */
  escalateHosts?: readonly string[];
}

/**
 * Parse `BGW_ESCALATE_HOSTS` (VIL-292): which hosts the AUTOMATIC escalate-on-block path may spend a
 * residential session on. Unset or blank → `undefined`, every host escalates as before. `none` → `[]`,
 * nothing escalates automatically. Otherwise a comma-separated host-suffix list, matched like
 * force-proxy. Only the automatic decision reads it: force-proxy (`forceProxy` / `BGW_FORCE_PROXY_HOSTS`),
 * vault login capture, and vault warm-open keep their own proxy rules. FAIL-CLOSED at boot on `none`
 * mixed with hosts, which has no single reading.
 *
 * Why it exists: on a residential prod host direct-first already clears what the datacenter IP could
 * not, while `BGW_ON_DATACENTER_IP=1` must stay set because the vault's pinned/fresh-exit replay needs
 * it. This narrows the paid fallback without touching the vault.
 */
export function parseEscalateHosts(value: string | undefined): string[] | undefined {
  const hosts = parseHostSuffixList(value);
  if (hosts.length === 0) return undefined;
  if (!hosts.includes("none")) return hosts;
  if (hosts.length > 1) {
    throw new Error(
      `BGW_ESCALATE_HOSTS: "none" cannot be combined with hosts (got "${value}") — set "none" to turn ` +
        `automatic escalation off, or list only the hosts that may escalate`,
    );
  }
  return [];
}

/** Boot-line rendering of {@link parseEscalateHosts}'s result: `all`, `none`, or the host list. */
export function describeEscalateHosts(hosts: readonly string[] | undefined): string {
  if (hosts === undefined) return "all";
  return hosts.length === 0 ? "none" : hosts.join(",");
}

/** True when automatic escalation may fire for `host` under `escalateHosts` (undefined = any host). */
export function hostMayEscalate(host: string, escalateHosts: readonly string[] | undefined): boolean {
  return escalateHosts === undefined || hostMatchesAnySuffix(host, escalateHosts);
}

/**
 * Engage the proxy from a datacenter IP, with a proxy available, on either block the local IP
 * cannot clear: a CF managed challenge, or a hard 4xx/5xx-with-thin-body block. `status` is the
 * final-render HTTP status (`isHardBlock` ignores it when `null` or < 400).
 *
 * VIL-121: the hard-block arm is {@link isExitClearableHardBlock}, not bare `isHardBlock` — a thin
 * 404/410/429 is still a hard block (still reported blocked, still a failure) but a fresh exit
 * cannot change it, so spending a residential session on one is pure burn.
 *
 * VIL-137 item 2: the CF arm now uses the SAME liveness rule the re-roll loop does, but only where the two
 * disagreed. A CF marker (`challenge-platform` etc.) PERSISTS on ordinary pages, so a thin 404 from any
 * Cloudflare-fronted origin used to open one paid proxied session that the re-roll rule then stopped.
 * Now: on a 404/410/429 the CF arm needs a VISIBLE challenge phrase (a live managed challenge on such a
 * status still escalates — screenshot-proven to clear); on every other status a hint-only CF page still
 * escalates exactly as before, so the hint-only interstitial path (403/503 + marker, no phrase) is kept.
 * Full unification (phrase required everywhere) was rejected for that reason.
 *
 * VIL-292: `host` is the requested target's host. With `ctx.escalateHosts` set, a host outside the list
 * never escalates, and a missing `host` cannot be checked against it, so it doesn't escalate either.
 */
export function shouldEscalateToProxy(
  signal: PageSignal,
  status: number | null,
  ctx: EscalationContext,
  host?: string,
): boolean {
  if (!ctx.onDatacenterIp || !ctx.proxyAvailable) return false;
  if (ctx.escalateHosts !== undefined && (host === undefined || !hostMayEscalate(host, ctx.escalateHosts))) return false;
  return (isCloudflareBlock(signal) && !isTerminalUnclearableRender(signal, status)) || isExitClearableHardBlock(signal, status);
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
