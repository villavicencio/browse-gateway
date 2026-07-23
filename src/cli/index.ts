/** Public surface of the obscura CLI module (the bin entry `obscura.ts` is not re-exported). */
export { parseCliArgs, usage } from "./args.js";
export type { Invocation, ParseResult, OwlCommand, KeysSubcommand, VaultSubcommand, Subcommand } from "./args.js";
export { owl, owlArt, banner, ok, fail, note, redactTokenLike } from "./brand.js";
export type { OwlState } from "./brand.js";
export { loadObscuraConfig, requireConfig, defaultConfigPath } from "./config.js";
export type { ObscuraConfig } from "./config.js";
export { execCapture } from "./exec.js";
export type { ExecResult, Exec } from "./exec.js";
export { sshShell, localShell, shQuote, readRemoteFile, writeRemoteFileAtomic } from "./prod-ssh.js";
export type { RemoteShell } from "./prod-ssh.js";
export { mintToken, tokenEnvKey, envKeyCollision } from "./token.js";
export { macKeychain, memoryKeychain, KEYCHAIN_SERVICE } from "./keychain.js";
export type { Keychain } from "./keychain.js";
export { keysNew, keysList, keysRevoke, inspectConsumers, formatConsumerLine } from "./keys.js";
export type { KeysDeps, KeysNewOptions, KeysRevokeOptions, KeysListResult, KeysListEntry, ProdFilesDeps } from "./keys.js";
export { vaultStatus, vaultImport, vaultRevoke, vaultLogin } from "./vault.js";
export type { VaultDeps, VaultImportArgs, VaultLoginArgs } from "./vault.js";
export { status } from "./status.js";
export type { StatusDeps, StatusOptions, StatusReport } from "./status.js";
export {
  tunnelSpec,
  keeperScript,
  launchAgentPlist,
  sshConfigBlock,
  authorizedKeysLine,
  classifyAgentState,
  classifyPortOwner,
  parsePortListeners,
  sshDestination,
  tunnelState,
  ensureTunnel,
  bootoutTunnel,
  SELF_DISABLE_MARKER,
} from "./tunnel.js";
export type { TunnelSpec, TunnelSpecOptions, TunnelState, AgentState, PortOwner, PortListener, EnsureResult } from "./tunnel.js";
export { classifyProbeCode, httpProbe, healthProbe, verifyGateway } from "./verify.js";
export type { VerifyState, VerifyResult, VerifyProbe, VerifyOptions, HealthProbeResult } from "./verify.js";
export { registerMcp, MCP_SERVER_NAME } from "./mcp-register.js";
export type { RegisterOutcome, RegisterOptions } from "./mcp-register.js";
export { connect, discoverToken, sshStealthGate } from "./connect.js";
export type { ConnectDeps, ConnectOptions, TokenDiscovery } from "./connect.js";
