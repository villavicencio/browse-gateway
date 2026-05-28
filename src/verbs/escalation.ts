/**
 * Scoped proxy-escalation decision (R7). The residential proxy is engaged ONLY when a
 * Cloudflare *managed challenge* fails to clear from the datacenter IP — never for soft
 * targets or DataDome (the spike showed those pass direct from the datacenter). Pure logic.
 */
import { assess } from "../browser/index.js";
import type { PageSignal } from "../browser/index.js";

const CF_CHALLENGE_PHRASES = [
  /just a moment/i,
  /verifying you are human/i,
  /checking your browser/i,
  /attention required/i,
];
const CF_CHALLENGE_HINTS = [/cf-chl/i, /challenge-platform/i, /cf_chl_opt/i];

/**
 * True when the page is blocked AND the block is specifically a Cloudflare challenge
 * (phrase in the visible title/text, or a CF challenge script in the HTML). A *cleared*
 * CF page is not blocked, so it returns false even though its HTML still carries CF scripts.
 */
export function isCloudflareBlock(signal: PageSignal): boolean {
  if (!assess(signal).blocked) return false;
  const visible = `${signal.title}\n${signal.text}`;
  if (CF_CHALLENGE_PHRASES.some((re) => re.test(visible))) return true;
  return CF_CHALLENGE_HINTS.some((re) => re.test(signal.html));
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
