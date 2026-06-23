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
  hostForcesProxy,
  PROXY_OPEN_ATTEMPTS,
  PROXY_CLEARANCE_TIMEOUT_MS,
} from "../verbs/index.js";
import type { LoginRunner } from "./vault-login.js";

/**
 * Build a {@link LoginRunner} bound to one consumer `token`. `opts` mirror the drive controller's
 * proxy posture (`onDatacenterIp`, the optional sticky suffix, and the force-proxy host list).
 *
 * Proxy posture matches the drive/retrieve flows exactly:
 *  - **Force-proxy (issue #21):** when the login host is on `forceProxyHosts`, skip the direct attempt
 *    and go residential from the FIRST request — a known-hostile WAF must never see the on-host login
 *    attempt from the datacenter IP. Forced-but-no-proxy fails loud (never a silent direct fallback).
 *  - **Otherwise DIRECT-FIRST / escalate-on-block (R7):** never proxy a login the direct datacenter IP
 *    can clear; open direct, probe-navigate, and re-open pinned to a fresh held exit only on a
 *    QUALIFYING block (CF managed challenge / hard reputation block) when a proxy is available.
 *
 * The captured session is bound to whichever exit landed the page, so `stickyExitId` is reported back
 * ONLY when a proxied exit was used (forced OR escalated) — a direct capture binds no exit and replays
 * direct; a forced/escalated one replays re-pinned (R3).
 */
export function makeGatewayLoginRunner(
  gateway: Gateway,
  secrets: SecretStore,
  token: string,
  opts: { onDatacenterIp: boolean; stickySuffix?: string; forceProxyHosts?: readonly string[] },
): LoginRunner {
  return async ({ host, recipe, creds }) => {
    // Guard against a recipe driving a login on a DIFFERENT host than the vault key it will be stored
    // under — otherwise a session captured on host B would be filed (and later replayed) as host A.
    const loginHost = canonicalizeHost(new URL(recipe.loginUrl).hostname);
    if (loginHost !== canonicalizeHost(host)) {
      throw new Error(`vault login: recipe loginUrl host (${loginHost}) does not match the entry host (${host})`);
    }
    const forced = hostForcesProxy(loginHost, opts.forceProxyHosts ?? []);
    // A proxied capture is only meaningful if it can be RE-PINNED on warm replay (R3). Pinning needs a
    // sticky-exit suffix: with BGW_PROXY_STICKY_SUFFIX unset, mintStickyProxy ignores the id and the
    // exit ROTATES, so a stored stickyExitId would be a lie (warm replay can't return to the capture
    // IP — and a rotating exit can't clear a CF interstitial in the first place). So a proxied capture
    // requires a PINNABLE proxy: proxy creds + onDatacenterIp + a sticky suffix. We refuse rather than
    // store a session falsely presented as R3-bound.
    const proxyConfigured = proxyOverrideFor(secrets, opts.onDatacenterIp, opts.stickySuffix) !== undefined;
    const canPin = proxyConfigured && opts.stickySuffix !== undefined;

    let handle: string | undefined;
    let stickyExitId: string | undefined; // set whenever a proxied exit lands the page (forced or escalated)
    try {
      if (forced) {
        // Force-proxy: do NOT open a direct session at all — a forced host must never receive the
        // login attempt from the datacenter IP (mirrors drive's #firstNavigate forced path).
        if (!proxyConfigured) {
          throw new Error(
            `vault login: force-proxy is configured for ${loginHost} but no residential proxy is available ` +
              `(set BGW_PROXY_* + BGW_ON_DATACENTER_IP, or drop the host from BGW_FORCE_PROXY_HOSTS)`,
          );
        }
        if (!canPin) {
          throw new Error(
            `vault login: force-proxy is configured for ${loginHost} but BGW_PROXY_STICKY_SUFFIX is unset — ` +
              `a forced capture must bind a re-pinnable sticky exit so warm replay returns to the same ` +
              `residential IP (R3). Set BGW_PROXY_STICKY_SUFFIX, or drop the host from BGW_FORCE_PROXY_HOSTS.`,
          );
        }
        // handle stays undefined → the pinned-exit loop below opens proxied from the first request.
      } else {
        // Direct-first: the first request goes out on the datacenter IP with no proxy (R7 — trigger-only).
        handle = await gateway.openConsumerSession(token, undefined);
        const directSnap = await gateway.useConsumerSession(token, handle, (s) => s.core.navigate(recipe.loginUrl));
        if (navFailed(directSnap)) {
          // Escalate ONLY on a block a clean residential exit can clear, and only to a RE-PINNABLE exit
          // (proxy + sticky suffix). Without a suffix the escalated exit rotates → it couldn't be bound
          // for warm replay (and a rotating exit can't clear a CF interstitial), so fail loud instead.
          if (!shouldEscalateDrive(directSnap) || !canPin) {
            throw new Error(
              `vault login: ${recipe.loginUrl} was blocked and could not be cleared on a direct exit ` +
                `(no re-pinnable residential exit to escalate to — needs a residential proxy + BGW_PROXY_STICKY_SUFFIX)`,
            );
          }
          await gateway.closeConsumerSession(token, handle).catch(() => {});
          handle = undefined; // fall through to the pinned-exit loop
        }
      }

      // Pinned-exit loop — runs when FORCED from the first request OR after a direct block escalated.
      // Retry FRESH held exits (a new sticky id + fresh session each) until one lands the page: a
      // residential exit is intermittently dead/dirty, so one bad exit must not fail the capture. This
      // is the pre-login GET only, so retrying is safe (no page state to lose); each proxied navigate
      // gets the raised clearance budget. Bind the entry to whichever exit landed (R3).
      if (!handle) {
        for (let attempt = 1; attempt <= PROXY_OPEN_ATTEMPTS; attempt++) {
          const id = newStickyExitId();
          const pinned = proxyOverrideFor(secrets, opts.onDatacenterIp, opts.stickySuffix, id);
          if (!pinned) throw new Error("vault login: residential proxy configuration was removed mid-capture");
          const h = await gateway.openConsumerSession(token, pinned);
          let promoted = false;
          try {
            const proxiedSnap = await gateway.useConsumerSession(token, h, (s) =>
              s.core.navigate(recipe.loginUrl, { clearanceTimeoutMs: PROXY_CLEARANCE_TIMEOUT_MS }),
            );
            if (!navFailed(proxiedSnap)) {
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
