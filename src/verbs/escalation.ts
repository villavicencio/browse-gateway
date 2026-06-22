/**
 * Scoped proxy-escalation decision (R7). The residential proxy is engaged from the datacenter
 * IP on two block kinds the local IP cannot clear: a Cloudflare *managed challenge*, or a *hard
 * block* — a 4xx/5xx IP/WAF-reputation block with no real content (F1, 2026-06-01; see
 * `isHardBlock`). It is NOT engaged for soft targets or DataDome (the spike showed those pass
 * direct from the datacenter). Pure logic.
 */
import { assess, isHardBlock, CF_BLOCK_PHRASES, CF_VENDOR_HINTS } from "../browser/index.js";
import type { PageSignal } from "../browser/index.js";

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
  if (!value) return [];
  return value
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/** True when `host` matches a force-proxy suffix — an exact match or a dotted subdomain of it
 *  (`totalwine.com` covers `www.totalwine.com` but NOT `nottotalwine.com`). */
export function hostForcesProxy(host: string, suffixes: readonly string[]): boolean {
  const h = host.toLowerCase();
  return suffixes.some((s) => h === s || h.endsWith(`.${s}`));
}
