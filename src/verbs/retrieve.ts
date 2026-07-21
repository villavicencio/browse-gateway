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
import {
  isVisiblyBlocked,
  isHardBlock,
  isCloudflareVisible,
  isPerimeterXVisible,
  isPerimeterXChallenge,
  hasCloudflareHint,
  hasPerimeterXHint,
  hasDataDomeHint,
  hasPerimeterXChallengeCopy,
  MIN_CONTENT_LENGTH,
} from "../browser/index.js";
import type { ProxyConfig, RenderOptions, RenderResult } from "../browser/index.js";
import { redactFailureDiagnostics, sanitizeUrlForError } from "../observability/index.js";
import type { FailureDiagnostics, WafVendor } from "../observability/index.js";
export type { WafVendor } from "../observability/index.js";
import type { Gateway } from "../gateway/index.js";
import { isHttpUrl } from "../security/index.js";
import type { SecretStore } from "../security/index.js";
import { extractMarkdown } from "./extract.js";
import { shouldEscalateToProxy } from "./escalation.js";
import type { EscalationContext } from "./escalation.js";
import { detectCaptcha } from "./captcha.js";
import type { CaptchaSolver, CaptchaKind } from "./captcha.js";

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
 * escalated attempts were timing out mid-challenge even on a healthy exit. A page that renders real
 * content returns as soon as it clears (the poll exits on cleared content, not at the deadline); a
 * still-blocked, thin, or dead exit consumes the budget — so the worst case is PROXY_MAX_ATTEMPTS x
 * (nav timeout + this) ≈ 210s, bounded under the 5-min drive idle-reaper TTL.
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
  /** Force residential from the FIRST render (skip the direct attempt) for a known-hostile host
   *  (issue #21). The MCP layer resolves this from the {forceProxy} option + BGW_FORCE_PROXY_HOSTS. */
  forceProxy?: boolean;
}

/**
 * Why the final render counts as blocked — a diagnostic surfaced to the caller so a failure says
 * WHY instead of a silent "blocked": `nav-failed` (no response — off-allowlist/unreachable),
 * `captcha` (an interactive CAPTCHA widget — needs a solver, not wired in v1), `cf-challenge`
 * (a Cloudflare managed challenge), `perimeterx-challenge` (a PerimeterX/HUMAN "Press & Hold"
 * behavioral interstitial — classified for diagnostics, NOT solved by the token CAPTCHA tier),
 * `datadome-challenge` (a DataDome/HUMAN block — classified for diagnostics via the persistent DataDome
 * markers; behavioral, NOT solved by the token CAPTCHA tier, and NOT escalated — see escalation.ts),
 * `hard-block` (4xx/5xx + thin body — IP/WAF reputation), `blocked` (some other visible block
 * phrase). `null` when not blocked.
 */
export type BlockReason =
  | "nav-failed"
  | "captcha"
  | "cf-challenge"
  | "perimeterx-challenge"
  | "datadome-challenge"
  | "hard-block"
  | "blocked";

/**
 * The single retrieve-FAILURE predicate, shared by {@link retrieve} (to attach + redact the
 * failure-diagnostics envelope, #39) and the MCP surface (`server.ts`, to fail the tool call) so the
 * two can never disagree — a page the MCP layer errors on must always carry evidence. A retrieve failed
 * when it was `blocked`, produced empty/whitespace `markdown` (empty extraction — the status-200 +
 * blank-body case that `blocked` alone misses), OR the navigation never landed (null status + thin
 * body — an off-allowlist/unreachable target whose thin error page must not be handed back as content).
 */
export function isRetrieveFailure(r: { blocked: boolean; markdown: string; status: number | null }): boolean {
  const navFailed = r.status === null && r.markdown.length < MIN_CONTENT_LENGTH;
  return r.blocked || r.markdown.trim().length === 0 || navFailed;
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
  /** Why it was blocked (diagnostic); `null` when not blocked. See {@link BlockReason}. */
  reason: BlockReason | null;
  /** The residential proxy was engaged (scoped escalation fired). */
  proxyUsed: boolean;
  /** A CAPTCHA was detected and handed to the solver. */
  captchaSolved: boolean;
  /** Structured proxy-escalation diagnostics when escalation ran (issue #21); absent otherwise. */
  proxyDiagnostic?: EscalationDiagnostics;
  /**
   * Failure-evidence envelope (issue #39): finalUrl (post-redirect) / title / status / redirect chain /
   * bounded console + network / optional screenshot — surfaced ONLY on a blocked/failed retrieve, and
   * REDACTED (secret set scrubbed + cookie/authorization stripped) before it reaches here. Absent on a
   * successful retrieve, so the success shape is unchanged. Distinct from {@link proxyDiagnostic} (the
   * proxy-escalation tally) — this is the page-evidence bundle the site-compat epic (#38) reports through.
   */
  diagnostics?: FailureDiagnostics;
}

/**
 * The reduced signal surface block classification reads: title + visible text + final status + the
 * HTML-derived vendor hints carried as booleans. retrieve passes hints computed from the full render
 * HTML; drive passes the booleans its {@link PageSnapshot} already carries (cfHint/pxHint) — so both
 * paths classify a block identically on one shared surface (the drive↔retrieve detection-parity
 * invariant).
 */
export interface BlockSignal {
  title: string;
  text: string;
  status: number | null;
  cfHint?: boolean;
  pxHint?: boolean;
  /** DataDome HTML marker (`datadome`/`captcha-delivery`/`dd_cookie`) is present — the DataDome sibling
   * of {@link cfHint}. Attribution only (issue #40): like cfHint/pxHint it PERSISTS after a clear, so it
   * re-labels an ALREADY-blocked page's reason to `datadome-challenge` but is never itself a `blocked`
   * input. retrieve computes it from the render HTML; drive carries it on its {@link PageSnapshot}. */
  ddHint?: boolean;
  /** PerimeterX challenge COPY ("Press & Hold") is present in the page source — the iframe-served
   * challenge whose phrase reaches the HTML but not the innerText `text`. retrieve computes it from
   * the render HTML (drive's snapshot carries no HTML, so it leaves this unset and relies on
   * pxHint+thin). Absent on a cleared page, so it never false-positives a success. */
  pxCopy?: boolean;
}

/**
 * Classify WHY a page is blocked, most-actionable-first, or `null` when it is not blocked. The
 * single source of truth for vendor/hard-block attribution shared by retrieve and drive.
 * Interactive-CAPTCHA-widget detection is NOT covered here (it needs raw HTML + sitekey — that stays
 * in retrieve's {@link detectCaptcha}).
 */
export function classifyBlock(sig: BlockSignal): BlockReason | null {
  // PerimeterX press-&-hold, served either as a thin iframe (no content) or — the case that slipped
  // #24 — a boundary-length 200 whose challenge copy is in the source but not the innerText. Both
  // gated by pxHint so a non-PX page can't false-positive.
  const pxChallenge =
    isPerimeterXChallenge(sig, sig.pxHint === true) || (sig.pxHint === true && sig.pxCopy === true);
  const blocked =
    sig.status === null || isVisiblyBlocked(sig) || pxChallenge || isHardBlock(sig, sig.status);
  if (!blocked) return null;
  if (sig.status === null) return "nav-failed";
  if (isCloudflareVisible(sig) || sig.cfHint === true) return "cf-challenge";
  if (isPerimeterXVisible(sig) || sig.pxHint === true) return "perimeterx-challenge";
  // DataDome: re-label an already-blocked page carrying a DataDome marker (issue #40) so it stops
  // falling through to a generic `hard-block`/`blocked`. Mirrors the cfHint branch exactly — a
  // persistent-marker attribution gated by the outer `!blocked` guard, so a cleared DataDome page
  // (200, fat content) is never reached. Placed AFTER cf/px (which also have a visible-phrase arm) so
  // a page tripping overlapping markers attributes to the same vendor `reason` reports first.
  if (sig.ddHint === true) return "datadome-challenge";
  if (isHardBlock(sig, sig.status)) return "hard-block";
  return "blocked";
}

/**
 * Project a {@link BlockReason} (+ the CAPTCHA kind, when the block is an interactive widget) onto a
 * {@link WafVendor}, or `undefined` when no vendor is attributable (a generic/hard block or a failed nav).
 * Deriving vendor FROM the reason — rather than a second parallel classifier — makes the surfaced vendor
 * and reason STRUCTURALLY unable to disagree: {@link classifyBlock} stays the single source of truth for
 * vendor attribution. `undefined` (absence) is the sole empty state, which keeps the #39 nav-failed gate
 * green (a failed nav has no vendor) and avoids a `none`/`unknown` sentinel.
 */
export function wafVendorFromReason(
  reason: BlockReason | null,
  captchaKind?: CaptchaKind,
): WafVendor | undefined {
  switch (reason) {
    case "cf-challenge":
      return "cloudflare";
    case "perimeterx-challenge":
      return "perimeterx";
    case "datadome-challenge":
      return "datadome";
    case "captcha":
      // The specific interactive widget kind (detectCaptcha only ever yields recaptcha/hcaptcha/turnstile);
      // an `unknown`/absent kind leaves the vendor unattributed rather than mislabeling it.
      return captchaKind && captchaKind !== "unknown" ? captchaKind : undefined;
    default:
      // nav-failed / hard-block / blocked / null → no attributable vendor.
      return undefined;
  }
}

/**
 * Structured diagnostics for a proxy-escalation outcome — caller-visible (issue #21) so a failure
 * says WHY (was the proxy applied? which exit? what blocked it?) instead of an opaque "last
 * status=403". Secrets-free BY CONSTRUCTION: no credentials, no proxy host — only booleans, a count,
 * a status, a {@link BlockReason}, and (opt-in, U4) an ASN/org verdict.
 */
export interface EscalationDiagnostics {
  /** A residential proxy is configured in the secret store. */
  proxyConfigured: boolean;
  /** A proxied exit was actually opened/used for this navigation (vs direct-only). */
  proxyApplied: boolean;
  /** The proxied path was forced from the first request (force-proxy host/option), not reached via escalation. */
  forced: boolean;
  /** Proxied attempts made (0 when the proxy was never engaged). */
  attempts: number;
  /** HTTP status of the last (failed) navigation, or null when none was captured. */
  lastStatus: number | null;
  /** Vendor/hard-block classification of the last failed page; null when it was not blocked. */
  reason: BlockReason | null;
  /** Residential-vs-datacenter exit verification (opt-in egress probe, U4); absent unless requested. */
  exitCheck?: EgressCheck;
}

/** Build {@link EscalationDiagnostics} from the escalation tally and the last failed signal. */
export function escalationDiagnostics(opts: {
  proxyConfigured: boolean;
  proxyApplied: boolean;
  forced: boolean;
  attempts: number;
  last: BlockSignal | null;
  exitCheck?: EscalationDiagnostics["exitCheck"];
}): EscalationDiagnostics {
  return {
    proxyConfigured: opts.proxyConfigured,
    proxyApplied: opts.proxyApplied,
    forced: opts.forced,
    attempts: opts.attempts,
    lastStatus: opts.last?.status ?? null,
    reason: opts.last ? classifyBlock(opts.last) : null,
    ...(opts.exitCheck ? { exitCheck: opts.exitCheck } : {}),
  };
}

/**
 * A proxy-escalation failure carrying structured {@link EscalationDiagnostics} for the MCP caller.
 * Thrown on the drive path; the diagnostics survive to the MCP `fail()` surface because the throw is
 * outside the controller's `#run` redaction re-wrap, and the message itself carries no secret material.
 */
export class EscalationError extends Error {
  readonly diagnostics: EscalationDiagnostics;
  /**
   * The page-evidence envelope (issue #39) for this failure — a DISTINCT field from {@link diagnostics}
   * (the proxy-escalation tally), deliberately NOT overloading it. Carries finalUrl / title / status /
   * redirect chain / console + network / optional screenshot, already REDACTED by the drive layer that
   * threw. Absent when no snapshot was captured (e.g. a force-proxy request with no proxy available).
   */
  readonly failure?: FailureDiagnostics;
  constructor(message: string, diagnostics: EscalationDiagnostics, failure?: FailureDiagnostics) {
    super(message);
    this.name = "EscalationError";
    this.diagnostics = diagnostics;
    if (failure) this.failure = failure;
  }
}

/** Result of the opt-in egress-verification probe (U4): did the proxy give a residential exit? */
export interface EgressCheck {
  kind: "datacenter" | "residential" | "unknown";
  /** The exit's ASN/org string, when the probe could read it (sanitized — a public org name). */
  org?: string;
}

/**
 * ASN/org name fragments that mark a DATACENTER/hosting exit (not residential). Curated, not
 * exhaustive — an org that matches none but is present is treated as residential; an absent org is
 * unknown. Used only for the opt-in diagnostic verdict, never to gate behavior.
 */
const DATACENTER_ORG_PATTERNS: readonly RegExp[] = [
  /hetzner/i,
  /amazon|aws/i,
  /google|gcp/i,
  /microsoft|azure/i,
  /digitalocean/i,
  /linode/i,
  /vultr|choopa/i,
  /\bovh\b/i,
  /contabo/i,
  /oracle/i,
  /leaseweb/i,
  /scaleway/i,
  /m247/i,
  /cloudflare/i,
  /akamai/i,
  /fastly/i,
  /\bdata\s*cent(?:er|re)\b/i,
  /hosting/i,
  /\bcolo\b/i,
  /\bvps\b/i,
];

/**
 * Classify an exit by its ASN/org string: a known datacenter/hosting org → "datacenter"; a present
 * org with no datacenter match → "residential"; absent/empty → "unknown". Pure.
 */
export function classifyExitOrg(org: string | undefined): EgressCheck["kind"] {
  if (!org || !org.trim()) return "unknown";
  return DATACENTER_ORG_PATTERNS.some((re) => re.test(org)) ? "datacenter" : "residential";
}

/**
 * Extract the `org` field from an ip-info JSON body (e.g. ipinfo.io/json) — regex, not JSON.parse, so
 * it survives the body being wrapped in a browser JSON-viewer's HTML. Returns undefined when absent.
 */
export function parseExitOrg(body: string): string | undefined {
  return body.match(/"org"\s*:\s*"([^"]*)"/)?.[1] || undefined;
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
  // 4 bytes → 8 hex chars: IPRoyal requires the `_session-` value be PRECISELY 8 alphanumeric
  // (verified against IPRoyal's rotation docs); a 16-char id is out of spec and may be truncated/ignored.
  id: string = randomBytes(4).toString("hex"),
): ProxyConfig {
  if (!suffixTemplate || !proxy.password) return proxy;
  return { ...proxy, password: proxy.password + suffixTemplate.replaceAll("{id}", id) };
}

/**
 * Mint a fresh, STABLE sticky-exit id — 8 hex chars, the IPRoyal `_session-` quantum (see
 * {@link mintStickyProxy}). The vault stores this with an entry at capture and re-pins it on warm
 * replay (via `proxyOverrideFor(..., stickyExitId)`), so a logged-in session returns to the SAME
 * residential exit IP (R3): an IP-bound login cookie replayed from a different exit is a tell.
 */
export function newStickyExitId(): string {
  return randomBytes(4).toString("hex");
}

/**
 * Boot-time validation for `BGW_PROXY_STICKY_SUFFIX`: a non-empty template MUST contain the `{id}`
 * placeholder, or {@link mintStickyProxy}'s `replaceAll` is a no-op and every escalation attempt
 * pins the SAME sticky exit — silently collapsing the rotate-across-retries property with no runtime
 * error. Returns an error string so entrypoints fail closed at startup (matching the gateway's other
 * boot guards), or null when the suffix is absent or valid.
 */
export function stickySuffixBootError(suffix: string | undefined): string | null {
  if (!suffix) return null;
  if (!suffix.includes("{id}")) {
    return "BGW_PROXY_STICKY_SUFFIX must contain the '{id}' placeholder, else every escalation attempt pins one exit and rotation is silently lost";
  }
  return null;
}

/**
 * The literal, non-`{id}` fragments of a sticky-suffix template, for folding into the SecretStore's
 * redaction set at boot (R9 defense-in-depth). {@link mintStickyProxy} appends
 * `suffix.replaceAll("{id}", <8hex>)` to the BASE proxy password: the base is already redactable
 * (loaded from `BGW_PROXY_PASSWORD`), but the appended suffix — the residential provider's param
 * structure (geo/session/lifetime) — is not, so a driver error that echoed the full minted password
 * would leak it past `redactSecrets` (`[REDACTED]_country-us_session-<id>_lifetime-30m`). Registering
 * the fragments around `{id}` scrubs that structure; only the ephemeral per-attempt 8-hex id remains
 * (opaque, non-credential). BOUNDED on purpose: fixed config split ONCE at boot, never per-request —
 * folding every minted password would grow the redaction set for the process lifetime AND is not
 * R3-safe, since {@link import("./drive.js").proxyOverrideForPinned} byte-compares the minted password
 * to re-pin a held exit. Fragments < 3 chars are harmless: `redactSecrets` skips them, so a short
 * fragment can never blanket-redact ordinary output.
 */
export function stickySuffixRedactables(suffix: string | undefined): string[] {
  if (!suffix) return [];
  return suffix.split("{id}").filter((fragment) => fragment.length > 0);
}

/**
 * PerimeterX press-&-hold copy present in the rendered page — the top-document HTML OR a child
 * frame's HTML. The challenge renders in a cross-origin `px-captcha-modal` iframe, which
 * `page.content()` (top frame only) never serializes; the core captures the child frames as
 * `render.frameHtml` (only when a PX marker is present), so the copy is recoverable either way.
 */
function hasPxChallengeCopy(render: Pick<RenderResult, "html" | "frameHtml">): boolean {
  return hasPerimeterXChallengeCopy(render.html) || hasPerimeterXChallengeCopy(render.frameHtml ?? "");
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
    // Structural sanitize at the source (issue #39 r5): the KNOWN requested url is never interpolated
    // raw — sanitizeUrl (new URL) collapses a non-http scheme to `scheme:<redacted>`, spelling-proof.
    throw new Error(`unsupported URL scheme: only http(s) is allowed (${sanitizeUrlForError(url)})`);
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
  let proxyAttempts = 0;

  // force-proxy (issue #21): skip the direct attempt and go residential from the FIRST render for a
  // known-hostile host. Only honored when a proxy is available (configured + datacenter IP); else it
  // degrades to direct — retrieve is best-effort (the interactive drive path fails loud instead).
  const forced = (opts.forceProxy ?? false) && Boolean(proxy) && escalation.onDatacenterIp;
  const proxiedRenderOpts: RenderOptions = {
    ...renderOpts,
    clearanceTimeoutMs: opts.clearanceTimeoutMs ?? PROXY_CLEARANCE_TIMEOUT_MS,
  };

  // 1) Direct render through an authenticated, allowlist-guarded session — skipped when forcing proxy.
  let render: RenderResult | undefined;
  if (!forced) {
    render = await gateway.withConsumerSession(token, (s) => s.core.render(url, renderOpts));
  }

  // 2) CAPTCHA hook (retrieve path) — detect a widget for the block-reason diagnostic. Full
  //    solve→inject→resume now lives in the browser core's DRIVE path (`#trySolveCaptcha`), which
  //    owns the live page; the stateless render path here has no page to inject into, so a solved
  //    token can't be applied. NO production caller wires `opts.solver` into retrieve — and it should
  //    stay that way: wiring one here would spend (and bill) a solve with no effect on the page.
  //    `captchaSolved` therefore stays false in production. (Removing `opts.solver` + `captchaSolved`
  //    outright is a follow-up — it changes retrieve's result contract + the mcp surface.)
  if (render && opts.solver) {
    const captcha = detectCaptcha(render, url);
    if (captcha) {
      await opts.solver.solve(captcha);
      captchaSolved = true;
    }
  }

  // 3) Scoped proxy escalation — a CF managed challenge OR a hard IP/WAF-reputation block
  //    (4xx/5xx + thin body), from a datacenter IP. The proxy's clean residential IP is what
  //    clears a reputation block; the local datacenter IP cannot (F1, 2026-06-01). Each attempt
  //    mints a fresh STICKY session (when configured) => a fresh exit per retry that is then HELD
  //    for the whole attempt — a CF challenge needs one stable IP to complete, while the retry
  //    still rotates past dead/slow/dirty exits (see PROXY_MAX_ATTEMPTS note above). The clearance
  //    budget is raised on proxied attempts: an interstitial clears in ~22s on a held exit, over
  //    the 20s default (probe, 2026-06-09).
  if (proxy && (forced || (render !== undefined && shouldEscalateToProxy(render, render.status, escalation)))) {
    proxyUsed = true;
    for (let attempt = 1; attempt <= PROXY_MAX_ATTEMPTS; attempt++) {
      proxyAttempts = attempt;
      render = await gateway.withConsumerSession(
        token,
        (s) => s.core.render(url, proxiedRenderOpts),
        { proxy: mintStickyProxy(proxy, opts.stickySuffix), navigationTimeoutMs: PROXY_NAV_TIMEOUT_MS },
      );
      // A fresh exit landed a real page -> done. Retry on a failed nav (null status), a still-blocked
      // result (dead exit / proxy error page), or a PerimeterX press-&-hold (a 200 challenge whose
      // phrase reaches the HTML/iframe but not innerText — thin OR copy-in-source; #21/#24 follow-up);
      // a thin-but-OK 200 is not retried.
      const pxHintR = hasPerimeterXHint(render.html);
      if (
        render.status !== null &&
        !isVisiblyBlocked(render) &&
        !isPerimeterXChallenge(render, pxHintR) &&
        !(pxHintR && hasPxChallengeCopy(render)) &&
        !isHardBlock(render, render.status)
      ) {
        break;
      }
    }
  }

  // render is assigned by here: non-forced did a direct render; forced implies a proxy so it ran >=1
  // proxied attempt. This guard satisfies the type-checker and the impossible forced-without-proxy case.
  if (render === undefined) {
    render = await gateway.withConsumerSession(token, (s) => s.core.render(url, renderOpts));
  }
  const extraction = extractMarkdown(render.html, url);
  const cfHint = hasCloudflareHint(render.html);
  const pxHint = hasPerimeterXHint(render.html);
  // ddHint: a DataDome marker in the render HTML (issue #40). Attribution only — like cfHint/pxHint it
  // persists after a clear, so it re-labels an already-blocked page's `reason` to `datadome-challenge`
  // but is NOT a `blocked` input (a cleared DataDome page still returns content).
  const ddHint = hasDataDomeHint(render.html);
  // pxCopy: the press-&-hold challenge copy is in the page SOURCE but not the top-doc innerText
  // `render.text` — the widget is in a cross-origin px-captcha-modal iframe. We look at BOTH the
  // top-document HTML and the child-frame HTML the core captured (`render.frameHtml`), because
  // page.content() serializes only the top frame. This is the boundary-length 200 case #24's
  // thin-content test missed. Absent on a cleared page.
  const pxCopy = hasPxChallengeCopy(render);
  // The interactive-CAPTCHA widget (if any), computed ONCE and reused for both the block `reason` and
  // the surfaced vendor (issue #40) — detectCaptcha is the only thing that can yield a `captcha` reason.
  const captcha = detectCaptcha(render, url);
  // Blocked = a failed navigation (no response captured), a visible anti-bot phrase, a PerimeterX
  // press-&-hold (pxHint + EITHER thin content OR the challenge copy in source — a 200 challenge whose
  // phrase renders in a cross-origin iframe, never reaching render.text; #21/#24 follow-up), or a hard
  // block (4xx/5xx + thin body) on the FINAL render — so a reputation 403, or an exhausted proxy retry
  // where every exit was dead, is reported as blocked instead of returning the error/empty/challenge
  // body as content (F1 finding #2). A thin *200* with no PX marker is still NOT blocked, so a
  // legitimately short page isn't flagged.
  const blocked =
    render.status === null ||
    isVisiblyBlocked(render) ||
    isPerimeterXChallenge(render, pxHint) ||
    (pxHint && pxCopy) ||
    isHardBlock(render, render.status);
  // Diagnostic reason for the block, most-actionable-first: nav-failed (off-allowlist/unreachable),
  // then captcha (an interactive widget — needs a solver, the v1 gap), then cf-challenge, then a
  // bare hard-block, else a generic visible block. Surfaced so a caller (and the agent) sees WHY a
  // page failed rather than a silent "blocked". `null` when the page is not blocked.
  const reason: BlockReason | null = !blocked
    ? null
    : render.status === null
      ? "nav-failed"
      : captcha
        ? "captcha"
        : classifyBlock({
            title: render.title,
            text: render.text,
            status: render.status,
            cfHint,
            pxHint,
            ddHint,
            pxCopy,
          });
  // Surface escalation diagnostics whenever the proxy was engaged (success or failure): on a block
  // the reason says WHY; on success it shows the proxy was applied and at which attempt it landed.
  const proxyDiagnostic = proxyUsed
    ? escalationDiagnostics({
        proxyConfigured: Boolean(proxy),
        proxyApplied: true,
        forced,
        attempts: proxyAttempts,
        last: {
          title: render.title,
          text: render.text,
          status: render.status,
          cfHint,
          pxHint,
          ddHint,
          pxCopy,
        },
      })
    : undefined;
  // Failure-evidence envelope (issue #39): surface it on ANY retrieve failure (blocked, empty-content,
  // or a failed nav — the SHARED {@link isRetrieveFailure} predicate the MCP layer also fails on, so an
  // errored result always carries evidence), and REDACT it (URL params stripped + secret set scrubbed +
  // cookie/authorization stripped) before it leaves this seam. The core built the RAW envelope on
  // `render.diagnostics` (finalUrl = the post-redirect page.url(), the retrieve URL-bug fix). A successful
  // retrieve carries no envelope, so its shape is unchanged.
  const failed = isRetrieveFailure({ blocked, markdown: extraction.markdown, status: render.status });
  // Mitigation/CAPTCHA vendor (issue #40): a PROJECTION of the already-computed `reason` (never a second
  // classifier), so vendor and reason can't disagree. Attached to the #39 envelope at THIS redaction seam
  // — not via buildFailureDiagnostics in the core — because it is a hint-derived slot and the drive core
  // assembles its envelope without HTML (parity with how cfHint/pxHint attach post-assembly). `wafVendor`
  // is a closed vocabulary, so it passes redactFailureDiagnostics untouched and carries no secret. Absent
  // when unattributed (a nav-failed/hard-block), keeping the #39 nav-failed gate green.
  const wafVendor = wafVendorFromReason(reason, captcha?.kind);
  const diagnostics =
    failed && render.diagnostics
      ? redactFailureDiagnostics(wafVendor ? { ...render.diagnostics, wafVendor } : render.diagnostics, secrets)
      : undefined;
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
    ...(proxyDiagnostic ? { proxyDiagnostic } : {}),
    ...(diagnostics ? { diagnostics } : {}),
  };
}
