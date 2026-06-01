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
import { isHardBlock } from "../browser/index.js";
import type { BrowserCoreOptions, PageSnapshot } from "../browser/index.js";
import type { SecretStore } from "../security/index.js";
import { proxyFromSecrets } from "./retrieve.js";

/** Max fresh proxied sessions to try when landing a healthy exit for a drive session. */
export const PROXY_OPEN_ATTEMPTS = 3;

/**
 * The core overrides to open a drive session with: the residential proxy when one is configured AND
 * we're on a datacenter IP (matching retrieve's escalation gate). Otherwise undefined (direct).
 */
export function proxyOverrideFor(
  secrets: SecretStore,
  onDatacenterIp: boolean,
): BrowserCoreOptions | undefined {
  const proxy = proxyFromSecrets(secrets);
  return proxy && onDatacenterIp ? { proxy } : undefined;
}

/**
 * True when a navigation did not land real content: no response captured (dead exit / nav error /
 * off-allowlist block) or a hard block (4xx/5xx + thin page). Drives the retry-fresh-exit decision
 * on the first navigate, and the restart error on a pinned/direct session. A real page that returns
 * a 4xx but renders full content (rare) is NOT failed — mirrors retrieve's isHardBlock nuance.
 */
export function navFailed(snap: PageSnapshot): boolean {
  const status = snap.status ?? null;
  return status === null || isHardBlock({ text: snap.tree }, status);
}
