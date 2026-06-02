/**
 * Orchestration helpers for the stateful `drive` path's proxy posture (R7). A rotating residential
 * proxy fixes its exit IP per session/connection, and a fraction of exits are dead or slow — so a
 * proxied drive session must land a healthy exit at the start and then pin it. The drive controller
 * retries the FIRST navigate across fresh sessions (each a fresh exit) until it lands, reusing the
 * rotating-exit insight from retrieve (see
 * docs/solutions/runtime-errors/residential-proxy-rotating-exit-retry). Once pinned, a mid-flow
 * failure is surfaced as a restart-the-session error rather than swapping exits live (which would
 * lose page state). Pure helpers — no I/O.
 */
import { isHardBlock, isVisiblyBlocked, isCloudflareVisible } from "../browser/index.js";
import type { BrowserCoreOptions, PageSnapshot } from "../browser/index.js";
import type { SecretStore } from "../security/index.js";
import { proxyFromSecrets, PROXY_MAX_ATTEMPTS, PROXY_NAV_TIMEOUT_MS } from "./retrieve.js";

/**
 * Max fresh proxied sessions to try when landing a healthy exit for a drive session. Sourced from
 * retrieve's attempt budget so the two proxy-retry surfaces share one value and can't drift apart.
 */
export const PROXY_OPEN_ATTEMPTS = PROXY_MAX_ATTEMPTS;

/**
 * The core overrides to open a drive session with: the residential proxy when one is configured AND
 * we're on a datacenter IP (matching retrieve's escalation gate). Otherwise undefined (direct). The
 * nav timeout is bounded (same value as retrieve) so a dead/slow exit fails fast and one hung exit
 * can't eat the whole retry budget.
 */
export function proxyOverrideFor(
  secrets: SecretStore,
  onDatacenterIp: boolean,
): BrowserCoreOptions | undefined {
  const proxy = proxyFromSecrets(secrets);
  return proxy && onDatacenterIp
    ? { proxy, navigationTimeoutMs: PROXY_NAV_TIMEOUT_MS }
    : undefined;
}

/**
 * True when a navigation did not land real content: no response captured (`status === null`), a
 * Chrome error page (`chrome-error://…` — a dead exit / reset socket / unreachable host that
 * produced no response, so the snapshot can inherit a stale status), a still-visible anti-bot
 * interstitial (a CF/WAF challenge that did NOT clear within navigate()'s poll — a 200, non-thin page
 * that is nonetheless blocked), or a hard block (4xx/5xx + thin page). Drives the failed-nav decision
 * on the first navigate, the pinned/direct restart error, and the post-action block check. A real
 * page that returns a 4xx but renders full content (rare) is NOT failed — mirrors retrieve's
 * isHardBlock nuance.
 */
export function navFailed(snap: PageSnapshot): boolean {
  const status = snap.status ?? null;
  return (
    status === null ||
    snap.url.startsWith("chrome-error://") ||
    isVisiblyBlocked({ title: snap.title, text: snap.tree }) ||
    isHardBlock({ text: snap.tree }, status)
  );
}

/**
 * Whether a failed first navigate warrants escalating to a residential proxy: a *Cloudflare* visible
 * challenge or a hard block (4xx/5xx + thin) — exactly retrieve's `shouldEscalateToProxy` scope (CF
 * challenge OR hard block), on the drive snapshot (title + accessibility tree + status). Narrower
 * than {@link navFailed} on purpose: a bare null-status / Chrome-error failure (off-allowlist abort,
 * unreachable host, reset socket) and a generic non-CF WAF block (e.g. "access denied" on a 200) are
 * NOT escalated — a fresh residential exit won't reliably fix those, so they're surfaced directly
 * instead of spending proxy budget.
 */
export function shouldEscalateDrive(snap: PageSnapshot): boolean {
  const status = snap.status ?? null;
  return (
    isCloudflareVisible({ title: snap.title, text: snap.tree }) || isHardBlock({ text: snap.tree }, status)
  );
}
