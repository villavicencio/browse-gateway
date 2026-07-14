/**
 * Security boundary (U4): browser CDP stays local, container egress is filtered away from
 * metadata/internal ranges, and BYO secrets are isolated and never logged.
 */
export { isBlockedEgressHost, EGRESS_DENY_REASON } from "./egress.js";
export { canonicalizeHost, canonicalizeHostForIp, hostFromUrl, isHttpUrl, cookieBelongsToHost, parseHostSuffixList, hostMatchesAnySuffix } from "./url.js";
export { assertLocalCdpOnly } from "./cdp.js";
export {
  SecretStore,
  redactSecrets,
  SECRET_KEYS,
  type SecretSource,
  type SecretKey,
} from "./secrets.js";
export {
  seal,
  open,
  sealJson,
  openJson,
  decodeMasterKey,
  secretEquals,
  VAULT_SCHEMA_VERSION,
  type SealedRecord,
  type GcmBox,
  type VaultContext,
} from "./vault-crypto.js";
export {
  VaultStore,
  openVault,
  loadVaultKey,
  listVaultEntries,
  countVaultEntries,
  vaultKeyBootError,
  rotateVaultKey,
  slotFileName,
  type VaultStoreOptions,
  type VaultEntryMeta,
  type OpenVaultDeps,
} from "./vault-store.js";
