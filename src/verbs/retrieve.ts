/**
 * `retrieve(url) -> clean markdown` (R10, R11) — the v1 outcome verb. Mechanics (stealth,
 * allowlist, proxy escalation, CAPTCHA) stay hidden from the caller, who just gets content.
 *
 * Flow: render direct through an authenticated session -> optional CAPTCHA solve ->
 * scoped proxy re-render only on a CF managed challenge from a datacenter IP (R7) ->
 * extract readable markdown. Proxy creds come from the U4 SecretStore; the CAPTCHA solver
 * is injected (R8).
 */
import { isVisiblyBlocked, MIN_CONTENT_LENGTH } from "../browser/index.js";
import type { ProxyConfig, RenderOptions } from "../browser/index.js";
import type { Gateway } from "../gateway/index.js";
import { isHttpUrl } from "../security/index.js";
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
  // Scheme allowlist (R14-adjacent): only http(s). Rejects file:/data:/blob:/ftp:/view-source:
  // before any navigation, so a non-http target can't read local files or bypass the
  // host-based guard (whose host is empty for those schemes).
  if (!isHttpUrl(url)) {
    throw new Error(`unsupported URL scheme: only http(s) is allowed (${url})`);
  }
  // clearedTextLength: a page returns as soon as real content (>= MIN_CONTENT_LENGTH) renders
  // instead of polling to the full clearance timeout (the kill-gate keeps the strong-content
  // bar). MIN, not 0, so a CF page mid-reload — challenge phrase gone but content not yet
  // painted — isn't mistaken for cleared.
  const renderOpts: RenderOptions = { clearedTextLength: MIN_CONTENT_LENGTH };
  if (opts.clearanceTimeoutMs !== undefined) renderOpts.clearanceTimeoutMs = opts.clearanceTimeoutMs;
  const proxy = proxyFromSecrets(secrets);
  const escalation: EscalationContext = {
    onDatacenterIp: opts.escalation?.onDatacenterIp ?? false,
    proxyAvailable: opts.escalation?.proxyAvailable ?? Boolean(proxy),
  };

  let captchaSolved = false;
  let proxyUsed = false;

  // 1) Direct render through an authenticated, allowlist-guarded session.
  let render = await gateway.withConsumerSession(token, (s) => s.core.render(url, renderOpts));

  // 2) CAPTCHA hook — detect a widget and hand it to an injected solver. NOTE (v1): token
  //    injection and page-resume are NOT yet wired — the solver receives only the challenge
  //    descriptor (kind/url/siteKey), not the live page, so a returned token does not yet
  //    re-render the page. `captchaSolved` therefore means "detected and handed to the
  //    solver", not "challenge cleared". Full solve+inject+resume belongs in the browser
  //    core (which owns the page handle) and is tracked for v1.1.
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
    // A visible anti-bot block phrase — NOT merely thin content — marks the page as blocked,
    // so a legitimately short page isn't reported as a block/error to the consumer.
    blocked: isVisiblyBlocked(render),
    proxyUsed,
    captchaSolved,
  };
}
