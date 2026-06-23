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
import { assistedLogin, coreLoginDriver, proxyOverrideFor } from "../verbs/index.js";
import type { LoginRunner } from "./vault-login.js";

/**
 * Build a {@link LoginRunner} bound to one consumer `token`. `opts` mirror the drive controller's
 * proxy posture (`onDatacenterIp` + the optional sticky suffix); the bound `stickyExitId` is pinned
 * per call so the captured session is tied to ONE residential exit IP (R3).
 */
export function makeGatewayLoginRunner(
  gateway: Gateway,
  secrets: SecretStore,
  token: string,
  opts: { onDatacenterIp: boolean; stickySuffix?: string },
): LoginRunner {
  return async ({ host, recipe, creds, stickyExitId }) => {
    // Guard against a recipe driving a login on a DIFFERENT host than the vault key it will be stored
    // under — otherwise a session captured on host B would be filed (and later replayed) as host A.
    const loginHost = canonicalizeHost(new URL(recipe.loginUrl).hostname);
    if (loginHost !== canonicalizeHost(host)) {
      throw new Error(`vault login: recipe loginUrl host (${loginHost}) does not match the entry host (${host})`);
    }
    // Pin the bound exit (proxied path); direct when no proxy is configured / not on a datacenter IP.
    const override = proxyOverrideFor(secrets, opts.onDatacenterIp, opts.stickySuffix, stickyExitId);
    const handle = await gateway.openConsumerSession(token, override);
    try {
      const { state } = await gateway.useConsumerSession(token, handle, (s) =>
        assistedLogin(coreLoginDriver(s.core), recipe, creds),
      );
      return state;
    } finally {
      // Always release the capture session — never leave a held login session occupying the pool.
      await gateway.closeConsumerSession(token, handle).catch(() => {});
    }
  };
}
