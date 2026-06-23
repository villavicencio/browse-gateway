/**
 * Production {@link LoginRunner} for the vault capture path (U6d) — the real seam U6c injected as a
 * fake. It opens a consumer-bound, allowlist-guarded session pinned to the bound sticky exit, drives
 * the assisted-login primitive over that session's browser core, and returns the captured state.
 *
 * Host-scoping + the no-raw-CDP guarantee come for free: the login runs through `openConsumerSession`,
 * which installs the consumer's allowlist guard below the verb layer before any navigation (KTD-5) —
 * so the capture can only ever navigate within the consumer's approved hosts. This runner is plain
 * operator-side glue; it is never reachable as an MCP tool (it is not on the `DriveController`
 * interface the MCP server maps tools from).
 */
import type { Gateway } from "../gateway/index.js";
import type { SecretStore } from "../security/index.js";
import { canonicalizeHost } from "../security/index.js";
import {
  assistedLogin,
  coreLoginDriver,
  proxyOverrideFor,
  newStickyExitId,
  navFailed,
  shouldEscalateDrive,
  PROXY_OPEN_ATTEMPTS,
  PROXY_CLEARANCE_TIMEOUT_MS,
} from "../verbs/index.js";
import type { LoginRunner } from "./vault-login.js";

/**
 * Build a {@link LoginRunner} bound to one consumer `token`. `opts` mirror the drive controller's
 * proxy posture (`onDatacenterIp` + the optional sticky suffix).
 *
 * Proxy posture is DIRECT-FIRST / escalate-on-block (R7), exactly like the drive flow — never proxy a
 * login that the direct datacenter IP can clear. We open direct and probe-navigate the login URL;
 * only if a QUALIFYING block is observed (a Cloudflare managed challenge or a hard reputation block)
 * AND a residential proxy is available do we re-open pinned to a fresh held exit. The captured session
 * is bound to whichever exit landed the page, so `stickyExitId` is reported back ONLY when we
 * escalated (a direct capture binds no exit and replays direct).
 */
export function makeGatewayLoginRunner(
  gateway: Gateway,
  secrets: SecretStore,
  token: string,
  opts: { onDatacenterIp: boolean; stickySuffix?: string },
): LoginRunner {
  return async ({ host, recipe, creds }) => {
    // Guard against a recipe driving a login on a DIFFERENT host than the vault key it will be stored
    // under — otherwise a session captured on host B would be filed (and later replayed) as host A.
    const loginHost = canonicalizeHost(new URL(recipe.loginUrl).hostname);
    if (loginHost !== canonicalizeHost(host)) {
      throw new Error(`vault login: recipe loginUrl host (${loginHost}) does not match the entry host (${host})`);
    }

    // Direct-first: the first request goes out on the datacenter IP with no proxy, regardless of
    // onDatacenterIp/proxy config (R7 — proxy is trigger-only).
    let handle: string | undefined = await gateway.openConsumerSession(token, undefined);
    let stickyExitId: string | undefined; // set ONLY if we escalate
    try {
      let snap = await gateway.useConsumerSession(token, handle, (s) => s.core.navigate(recipe.loginUrl));
      if (navFailed(snap)) {
        // Escalate ONLY on a block a clean residential exit can clear (CF managed challenge / hard
        // block), and only if a proxy is actually available.
        if (!shouldEscalateDrive(snap) || proxyOverrideFor(secrets, opts.onDatacenterIp, opts.stickySuffix) === undefined) {
          throw new Error(
            `vault login: ${recipe.loginUrl} was blocked and could not be cleared on a direct exit ` +
              `(no residential proxy available to escalate to)`,
          );
        }
        await gateway.closeConsumerSession(token, handle).catch(() => {});
        handle = undefined;
        // Retry FRESH held exits — a new sticky id + fresh session each attempt — until one lands the
        // page, mirroring the drive flow: residential exits are intermittently dead/dirty, so one bad
        // exit must not fail the capture. This is the pre-login GET only, so retrying is safe (no page
        // state to lose). Each proxied navigate gets the raised clearance budget (a fresh exit re-hits
        // the interstitial). Bind the entry to whichever exit landed (R3).
        for (let attempt = 1; attempt <= PROXY_OPEN_ATTEMPTS; attempt++) {
          const id = newStickyExitId();
          const pinned = proxyOverrideFor(secrets, opts.onDatacenterIp, opts.stickySuffix, id);
          if (!pinned) throw new Error("vault login: residential proxy configuration was removed mid-capture");
          const h = await gateway.openConsumerSession(token, pinned);
          let promoted = false;
          try {
            snap = await gateway.useConsumerSession(token, h, (s) =>
              s.core.navigate(recipe.loginUrl, { clearanceTimeoutMs: PROXY_CLEARANCE_TIMEOUT_MS }),
            );
            if (!navFailed(snap)) {
              handle = h;
              stickyExitId = id;
              promoted = true;
              break;
            }
          } finally {
            // Close this exit unless it was promoted to the committed handle — so a dead/dirty exit OR
            // a navigate that THROWS never leaks a held session occupying the per-consumer slot (the
            // outer finally only owns the committed handle).
            if (!promoted) await gateway.closeConsumerSession(token, h).catch(() => {});
          }
        }
        if (!handle) {
          throw new Error(
            `vault login: could not land ${recipe.loginUrl} on a healthy proxied exit after ` +
              `${PROXY_OPEN_ATTEMPTS} attempts — retry the capture`,
          );
        }
      }
      // On a committed exit with the login page landed: drive the flow WITHOUT re-navigating (we own
      // the navigate above so the escalation decision + clearance budget are applied exactly once).
      const { state } = await gateway.useConsumerSession(token, handle, (s) =>
        assistedLogin(coreLoginDriver(s.core), recipe, creds, { skipInitialNavigate: true }),
      );
      return { state, ...(stickyExitId ? { stickyExitId } : {}) };
    } finally {
      // Always release the capture session — never leave a held login session occupying the pool.
      if (handle) await gateway.closeConsumerSession(token, handle).catch(() => {});
    }
  };
}
