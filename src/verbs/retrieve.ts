/**
 * `retrieve(url) -> clean markdown` (R10, R11) — the v1 outcome verb. Mechanics (stealth,
 * allowlist, proxy escalation, CAPTCHA) stay hidden from the caller, who just gets content.
 *
 * Flow: render direct through an authenticated session -> optional CAPTCHA solve ->
 * scoped proxy re-render on a CF managed challenge OR a hard IP/WAF-reputation block, from a
 * datacenter IP (R7), retried across fresh rotating exits -> extract readable markdown. Proxy
 * creds come from the U4 SecretStore; the CAPTCHA solver is injected (R8).
 */
import { randomBytes } from "node:crypto";
import { isVisiblyBlocked, isHardBlock, MIN_CONTENT_LENGTH } from "../browser/index.js";
import type { ProxyConfig, RenderOptions } from "../browser/index.js";
import type { Gateway } from "../gateway/index.js";
import { isHttpUrl } from "../security/index.js";
import type { SecretStore } from "../security/index.js";
import { extractMarkdown } from "./extract.js";
import { shouldEscalateToProxy, isCloudflareBlock } from "./escalation.js";
import type { EscalationContext } from "./escalation.js";
import { detectCaptcha } from "./captcha.js";
import type { CaptchaSolver } from "./captcha.js";

/**
 * Proxy-escalation retries (R7). A rotating residential proxy assigns a fresh exit IP per
 * session/connection, and a fraction of exits are dead or slow (verified 2026-06-01: ~83% good
 * per fresh session; dead exits fail fast with `net::ERR_EMPTY_RESPONSE`, good-but-slow exits up
 * to ~17s). Each retry re-acquires a fresh proxied SESSION — and therefore a fresh exit — so we
 * retry the whole session (never just a new page on the same context, which reuses the same bad
 * exit) until a real page lands or attempts run out. `PROXY_NAV_TIMEOUT_MS` bounds a hung exit
 * with margin over the slowest good exit observed, so a retry past a dead exit stays fast.
 */
export const PROXY_MAX_ATTEMPTS = 3;
export const PROXY_NAV_TIMEOUT_MS = 25_000;

/**
 * Clearance budget for PROXIED attempts (both verbs). A CF interstitial on a held residential exit
 * was measured clearing at ~22s (probe, 2026-06-09) — over both defaults (render 20s, drive 15s), so
 * escalated attempts were timing out mid-challenge even on a healthy exit. Cheap to raise: the
 * clearance poll only keeps waiting while a block phrase is visibly showing, so clean pages and
 * hard-403s still return immediately; only an in-progress challenge consumes this budget.
 */
export const PROXY_CLEARANCE_TIMEOUT_MS = 45_000;

export interface RetrieveOptions {
  token: string;
  url: string;
  /** Escalation context. Defaults: not on a datacenter IP (so escalation stays off). */
  escalation?: Partial<EscalationContext>;
  /** Injected CAPTCHA solver; omitted = no solving (a detected CAPTCHA is left to fail). */
  solver?: CaptchaSolver;
  clearanceTimeoutMs?: number;
  /**
   * Sticky-session suffix template for proxied attempts (deployment config,
   * `BGW_PROXY_STICKY_SUFFIX`; the provider-specific syntax lives only in the deployment env — see
   * {@link mintStickyProxy}). Absent = rotating exits (prior behavior), which cannot clear a CF
   * interstitial: the challenge binds to one IP and per-request rotation moves it mid-handshake.
   */
  stickySuffix?: string;
}

/**
 * Why the final render counts as blocked — a diagnostic surfaced to the caller so a failure says
 * WHY instead of a silent "blocked": `nav-failed` (no response — off-allowlist/unreachable),
 * `captcha` (an interactive CAPTCHA widget — needs a solver, not wired in v1), `cf-challenge`
 * (a Cloudflare managed challenge), `hard-block` (4xx/5xx + thin body — IP/WAF reputation),
 * `blocked` (some other visible block phrase). `null` when not blocked.
 */
export type BlockReason = "nav-failed" | "captcha" | "cf-challenge" | "hard-block" | "blocked";

export interface RetrieveResult {
  url: string;
  status: number | null;
  title: string;
  markdown: string;
  /** Readability found no article and we degraded to a direct conversion. */
  degraded: boolean;
  /** The final rendered page still looked blocked/challenged. */
  blocked: boolean;
  /** Why it was blocked (diagnostic); `null` when not blocked. See {@link BlockReason}. */
  reason: BlockReason | null;
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

/**
 * Derive a STICKY-session proxy from a base config: append `suffixTemplate` (with `{id}` replaced by
 * a fresh random token) to the password. Residential providers encode stickiness in the password, so
 * this stays provider-neutral — the literal suffix syntax is deployment config, never in source
 * (public repo). One sticky id = one held exit IP: a fresh id per ATTEMPT preserves the
 * rotate-across-retries property the reputation-403 path needs, while each attempt keeps the single
 * stable IP a CF challenge requires to complete (cf_clearance is IP-bound; per-request rotation
 * moves the IP mid-challenge, which is why rotating exits can never clear an interstitial).
 * No template or no password → the base config unchanged (prior rotating behavior).
 */
export function mintStickyProxy(
  proxy: ProxyConfig,
  suffixTemplate: string | undefined,
  id: string = randomBytes(4).toString("hex"),
): ProxyConfig {
  if (!suffixTemplate || !proxy.password) return proxy;
  return { ...proxy, password: proxy.password + suffixTemplate.replaceAll("{id}", id) };
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

  // 2) CAPTCHA hook (retrieve path) — detect a widget for the block-reason diagnostic. Full
  //    solve→inject→resume now lives in the browser core's DRIVE path (`#trySolveCaptcha`), which
  //    owns the live page; the stateless render path here has no page to inject into, so a solved
  //    token can't be applied. NO production caller wires `opts.solver` into retrieve — and it should
  //    stay that way: wiring one here would spend (and bill) a solve with no effect on the page.
  //    `captchaSolved` therefore stays false in production. (Removing `opts.solver` + `captchaSolved`
  //    outright is a follow-up — it changes retrieve's result contract + the mcp surface.)
  const captcha = detectCaptcha(render, url);
  if (captcha && opts.solver) {
    await opts.solver.solve(captcha);
    captchaSolved = true;
  }

  // 3) Scoped proxy escalation — a CF managed challenge OR a hard IP/WAF-reputation block
  //    (4xx/5xx + thin body), from a datacenter IP. The proxy's clean residential IP is what
  //    clears a reputation block; the local datacenter IP cannot (F1, 2026-06-01). Each attempt
  //    mints a fresh STICKY session (when configured) => a fresh exit per retry that is then HELD
  //    for the whole attempt — a CF challenge needs one stable IP to complete, while the retry
  //    still rotates past dead/slow/dirty exits (see PROXY_MAX_ATTEMPTS note above). The clearance
  //    budget is raised on proxied attempts: an interstitial clears in ~22s on a held exit, over
  //    the 20s default (probe, 2026-06-09).
  if (proxy && shouldEscalateToProxy(render, render.status, escalation)) {
    proxyUsed = true;
    const proxiedRenderOpts: RenderOptions = {
      ...renderOpts,
      clearanceTimeoutMs: opts.clearanceTimeoutMs ?? PROXY_CLEARANCE_TIMEOUT_MS,
    };
    for (let attempt = 1; attempt <= PROXY_MAX_ATTEMPTS; attempt++) {
      render = await gateway.withConsumerSession(
        token,
        (s) => s.core.render(url, proxiedRenderOpts),
        { proxy: mintStickyProxy(proxy, opts.stickySuffix), navigationTimeoutMs: PROXY_NAV_TIMEOUT_MS },
      );
      // A fresh exit landed a real page -> done. Retry on a failed nav (null status) or a
      // still-blocked result (dead exit / proxy error page); a thin-but-OK 200 is not retried.
      if (render.status !== null && !isVisiblyBlocked(render) && !isHardBlock(render, render.status)) {
        break;
      }
    }
  }

  const extraction = extractMarkdown(render.html, url);
  // Blocked = a failed navigation (no response captured), a visible anti-bot phrase, or a hard
  // block (4xx/5xx + thin body) on the FINAL render — so a reputation 403, or an exhausted proxy
  // retry where every exit was dead, is reported as blocked instead of returning the error/empty
  // body as content (F1 finding #2). A thin *200* is still NOT blocked, so a legitimately short
  // page isn't flagged.
  const blocked = render.status === null || isVisiblyBlocked(render) || isHardBlock(render, render.status);
  // Diagnostic reason for the block, most-actionable-first: nav-failed (off-allowlist/unreachable),
  // then captcha (an interactive widget — needs a solver, the v1 gap), then cf-challenge, then a
  // bare hard-block, else a generic visible block. Surfaced so a caller (and the agent) sees WHY a
  // page failed rather than a silent "blocked". `null` when the page is not blocked.
  const reason: BlockReason | null = !blocked
    ? null
    : render.status === null
      ? "nav-failed"
      : detectCaptcha(render, url)
        ? "captcha"
        : isCloudflareBlock(render)
          ? "cf-challenge"
          : isHardBlock(render, render.status)
            ? "hard-block"
            : "blocked";
  return {
    url,
    status: render.status,
    title: extraction.title || render.title,
    markdown: extraction.markdown,
    degraded: extraction.degraded,
    blocked,
    reason,
    proxyUsed,
    captchaSolved,
  };
}
