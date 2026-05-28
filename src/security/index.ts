/**
 * Security boundary (U4): browser CDP stays local, container egress is filtered away from
 * metadata/internal ranges, and BYO secrets are isolated and never logged.
 */
export { isBlockedEgressHost, EGRESS_DENY_REASON } from "./egress.js";
export { assertLocalCdpOnly } from "./cdp.js";
export {
  SecretStore,
  redactSecrets,
  SECRET_KEYS,
  type SecretSource,
  type SecretKey,
} from "./secrets.js";
