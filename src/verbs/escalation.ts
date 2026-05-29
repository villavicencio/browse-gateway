/**
 * Scoped proxy-escalation decision (R7). The residential proxy is engaged ONLY when a
 * Cloudflare *managed challenge* fails to clear from the datacenter IP — never for soft
 * targets or DataDome (the spike showed those pass direct from the datacenter). Pure logic.
 */
import { assess, CF_BLOCK_PHRASES, CF_VENDOR_HINTS } from "../browser/index.js";
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

/** Engage the proxy only on a CF managed challenge, from a datacenter IP, with a proxy available. */
export function shouldEscalateToProxy(signal: PageSignal, ctx: EscalationContext): boolean {
  return ctx.onDatacenterIp && ctx.proxyAvailable && isCloudflareBlock(signal);
}
