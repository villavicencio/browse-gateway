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
import {
  proxyFromSecrets,
  mintStickyProxy,
  newStickyExitId,
  PROXY_MAX_ATTEMPTS,
  PROXY_NAV_TIMEOUT_MS,
} from "./retrieve.js";

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
 *
 * When `stickySuffix` is configured, EACH CALL mints a fresh sticky session — a fresh exit that is
 * then HELD for that session's lifetime (a CF challenge needs one stable IP to complete). Callers
 * must therefore resolve a NEW override per attempt/reopen, never reuse one across attempts: reuse
 * would pin every retry to the same possibly-dirty exit and defeat the rotate-across-retries
 * property the reputation-403 path needs.
 */
export function proxyOverrideFor(
  secrets: SecretStore,
  onDatacenterIp: boolean,
  stickySuffix?: string,
  stickyExitId?: string,
): BrowserCoreOptions | undefined {
  const proxy = proxyFromSecrets(secrets);
  // `stickyExitId` PINS a specific held exit (vault warm-replay re-pins the exit bound at capture, R3);
  // omitted, mintStickyProxy mints a fresh id per call (the escalation-retry rotate behavior). Passing
  // `undefined` through triggers mintStickyProxy's own fresh-id default, so existing 3-arg callers are
  // unchanged.
  return proxy && onDatacenterIp
    ? { proxy: mintStickyProxy(proxy, stickySuffix, stickyExitId), navigationTimeoutMs: PROXY_NAV_TIMEOUT_MS }
    : undefined;
}

/**
 * Shared STRUCTURAL gate for a HELD residential exit, consumed by BOTH the bound-entry re-pin
 * ({@link proxyOverrideForPinned}) and the fresh-exit warm-open ({@link proxyOverrideForFresh}) so the
 * two fail-closed paths can NEVER drift. Returns the override ONLY when the exit is VERIFIABLY held: on a
 * datacenter IP, the sticky suffix is present AND carries the `{id}` placeholder, a base proxy password
 * exists, and the minted password equals EXACTLY `basePassword + suffix-with-id`. A bare `includes(exitId)`
 * could be fooled by a base password (or static suffix) that incidentally contains the id — NOT a real
 * pin — so the check is structural. `proxyOverrideFor` ALONE is not enough: via `mintStickyProxy` it
 * returns the BASE proxy UNCHANGED (a rotating, unverified exit) when the suffix is absent / has no
 * `{id}` / has no password, so a caller that only checked for `undefined` would FAIL OPEN — replaying a
 * logged-in session through an uncontrolled exit, the exact wrong-network-posture replay R3 forbids.
 */
function verifiedHeldExit(
  secrets: SecretStore,
  onDatacenterIp: boolean,
  stickySuffix: string | undefined,
  exitId: string,
): BrowserCoreOptions | undefined {
  if (!onDatacenterIp) return undefined;
  if (!stickySuffix || !stickySuffix.includes("{id}")) return undefined;
  const base = proxyFromSecrets(secrets);
  if (!base?.password) return undefined;
  const expected = base.password + stickySuffix.replaceAll("{id}", exitId);
  const override = proxyOverrideFor(secrets, onDatacenterIp, stickySuffix, exitId);
  return override?.proxy?.password === expected ? override : undefined;
}

/**
 * Like {@link proxyOverrideFor}, but for a BOUND vault entry that MUST re-pin a SPECIFIC captured exit
 * (R3 warm replay): returns the override ONLY when the exit is VERIFIABLY pinned (see
 * {@link verifiedHeldExit}), else `undefined`. The caller ({@link buildWarmOverride}) fails closed.
 */
export function proxyOverrideForPinned(
  secrets: SecretStore,
  onDatacenterIp: boolean,
  stickySuffix: string | undefined,
  stickyExitId: string,
): BrowserCoreOptions | undefined {
  return verifiedHeldExit(secrets, onDatacenterIp, stickySuffix, stickyExitId);
}

/**
 * For a FRESH-EXIT warm-open (the durable fix for exit-reputation-gated hosts, e.g. a PerimeterX retail
 * site): restore a stored login but route it through a FRESH, server-minted held residential exit
 * instead of re-pinning the captured one (an IPRoyal sticky decays/burns past its lifetime → 403).
 * Mints a fresh {@link newStickyExitId} and runs it through the SAME structural gate as the re-pin
 * ({@link verifiedHeldExit}), so it FAILS CLOSED (returns `undefined`) on exactly the cases the re-pin
 * does — no residential proxy, not on a datacenter IP, or a sticky suffix that can't mint a held exit.
 * It NEVER returns a rotating/unverified exit; the caller fails closed and never downgrades a logged-in
 * replay to a direct (datacenter) exit. The captured `stickyExitId` is deliberately NOT consulted — the
 * bound exit being stale is the whole reason this mode exists. Safe to not re-pin because the IP-bound
 * clearance tokens were stripped at capture ({@link import("../mcp/vault-login.js").stripIpBoundTokens}),
 * so the restored auth is not IP-bound and a fresh exit presents no stale-clearance tell.
 */
export function proxyOverrideForFresh(
  secrets: SecretStore,
  onDatacenterIp: boolean,
  stickySuffix: string | undefined,
): BrowserCoreOptions | undefined {
  return verifiedHeldExit(secrets, onDatacenterIp, stickySuffix, newStickyExitId());
}

/**
 * True when a navigation did not land real content: no response captured (`status === null`), a
 * Chrome error page (`chrome-error://…` — a dead exit / reset socket / unreachable host that
 * produced no response, so the snapshot can inherit a stale status), a still-visible anti-bot
 * interstitial (a CF/WAF challenge that did NOT clear within navigate()'s poll — a 200, non-thin page
 * that is nonetheless blocked), a hard block (4xx/5xx + thin page), or a nav the core marked
 * DEADLINE-TRUNCATED (issue #66: a budget/nav-timeout-cut goto whose headers arrived first pins a
 * partial 200 that every other arm here reads as healthy — the core sets the flag only when the page
 * is thin and unblocked, so a cleared-CF fat 200 never carries it). Drives the failed-nav decision
 * on the first navigate, the pinned/direct restart error, and the post-action block check. A real
 * page that returns a 4xx but renders full content (rare) is NOT failed — mirrors retrieve's
 * isHardBlock nuance.
 */
export function navFailed(snap: PageSnapshot): boolean {
  const status = snap.status ?? null;
  return (
    status === null ||
    snap.deadlineTruncated === true ||
    snap.url.startsWith("chrome-error://") ||
    isVisiblyBlocked({ title: snap.title, text: snap.tree }) ||
    isHardBlock({ text: snap.tree }, status)
  );
}

/**
 * Whether a failed first navigate warrants escalating to a residential proxy: a *Cloudflare* signal
 * — a visible CF challenge phrase OR a CF vendor hint in the page HTML (carried as the scrubbed
 * {@link PageSnapshot.cfHint} boolean, so a CF interstitial that shows no visible CF phrase is still
 * recognized) — or a hard block (4xx/5xx + thin). This is exactly retrieve's
 * `shouldEscalateToProxy`/`isCloudflareBlock` scope (CF challenge OR hard block), on the drive
 * snapshot. Narrower than {@link navFailed} on purpose: a bare null-status / Chrome-error failure
 * (off-allowlist abort, unreachable host, reset socket) and a generic non-CF WAF block (e.g. "access
 * denied" on a 200) are NOT escalated — a fresh residential exit won't reliably fix those.
 */
export function shouldEscalateDrive(snap: PageSnapshot): boolean {
  const status = snap.status ?? null;
  return (
    isCloudflareVisible({ title: snap.title, text: snap.tree }) ||
    snap.cfHint === true ||
    isHardBlock({ text: snap.tree }, status)
  );
}
