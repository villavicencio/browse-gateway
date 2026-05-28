/**
 * `retrieve(url) -> clean markdown` (R10, R11) — the v1 outcome verb. Mechanics (stealth,
 * allowlist, proxy escalation, CAPTCHA) stay hidden from the caller, who just gets content.
 *
 * Flow: render direct through an authenticated session -> optional CAPTCHA solve ->
 * scoped proxy re-render only on a CF managed challenge from a datacenter IP (R7) ->
 * extract readable markdown. Proxy creds come from the U4 SecretStore; the CAPTCHA solver
 * is injected (R8).
 */
import { assess } from "../browser/index.js";
import type { ProxyConfig } from "../browser/index.js";
import type { Gateway } from "../gateway/index.js";
import type { SecretStore } from "../security/index.js";
import { extractMarkdown } from "./extract.js";
import { shouldEscalateToProxy } from "./escalation.js";
import type { EscalationContext } from "./escalation.js";
import { detectCaptcha } from "./captcha.js";
import type { CaptchaSolver } from "./captcha.js";

export interface RetrieveOptions {
  token: string;
  url: string;
  /** Escalation context. Defaults: not on a datacenter IP (so escalation stays off). */
  escalation?: Partial<EscalationContext>;
  /** Injected CAPTCHA solver; omitted = no solving (a detected CAPTCHA is left to fail). */
  solver?: CaptchaSolver;
  clearanceTimeoutMs?: number;
}

export interface RetrieveResult {
  url: string;
  status: number | null;
  title: string;
  markdown: string;
  /** Readability found no article and we degraded to a direct conversion. */
  degraded: boolean;
  /** The final rendered page still looked blocked/challenged. */
  blocked: boolean;
  /** The residential proxy was engaged (scoped escalation fired). */
  proxyUsed: boolean;
  /** A CAPTCHA was detected and handed to the solver. */
  captchaSolved: boolean;
}

/** Assemble a ProxyConfig from BYO secrets, or undefined when no proxy is configured. */
export function proxyFromSecrets(secrets: SecretStore): ProxyConfig | undefined {
  const server = secrets.get("BGW_PROXY_URL");
  if (!server) return undefined;
  const username = secrets.get("BGW_PROXY_USERNAME");
  const password = secrets.get("BGW_PROXY_PASSWORD");
  return { server, ...(username ? { username } : {}), ...(password ? { password } : {}) };
}

export async function retrieve(
  gateway: Gateway,
  secrets: SecretStore,
  opts: RetrieveOptions,
): Promise<RetrieveResult> {
  const { token, url } = opts;
  const renderOpts = opts.clearanceTimeoutMs ? { clearanceTimeoutMs: opts.clearanceTimeoutMs } : {};
  const proxy = proxyFromSecrets(secrets);
  const escalation: EscalationContext = {
    onDatacenterIp: opts.escalation?.onDatacenterIp ?? false,
    proxyAvailable: opts.escalation?.proxyAvailable ?? Boolean(proxy),
  };

  let captchaSolved = false;
  let proxyUsed = false;

  // 1) Direct render through an authenticated, allowlist-guarded session.
  let render = await gateway.withConsumerSession(token, (s) => s.core.render(url, renderOpts));

  // 2) CAPTCHA hook — if one is present and a solver is configured, solve so the flow
  //    continues instead of dead-ending. (Token injection + resume is the solver impl's
  //    concern; this guarantees the path is exercised, not abandoned.)
  const captcha = detectCaptcha(render, url);
  if (captcha && opts.solver) {
    await opts.solver.solve(captcha);
    captchaSolved = true;
  }

  // 3) Scoped proxy escalation — ONLY a CF managed challenge from a datacenter IP.
  if (proxy && shouldEscalateToProxy(render, escalation)) {
    proxyUsed = true;
    render = await gateway.withConsumerSession(token, (s) => s.core.render(url, renderOpts), { proxy });
  }

  const extraction = extractMarkdown(render.html, url);
  return {
    url,
    status: render.status,
    title: extraction.title || render.title,
    markdown: extraction.markdown,
    degraded: extraction.degraded,
    blocked: assess(render).blocked,
    proxyUsed,
    captchaSolved,
  };
}
