/** Public surface of the obscura CLI module (the bin entry `obscura.ts` is not re-exported). */
export { parseCliArgs, usage } from "./args.js";
export type { Invocation, ParseResult, OwlCommand, KeysSubcommand } from "./args.js";
export { owl, owlArt, banner, bootBannerLine, ok, fail, note, redactTokenLike } from "./brand.js";
export type { OwlState } from "./brand.js";
export { loadObscuraConfig, requireConfig, defaultConfigPath } from "./config.js";
export type { ObscuraConfig } from "./config.js";
export { execCapture } from "./exec.js";
export type { ExecResult } from "./exec.js";
export { sshShell, localShell, shQuote, readRemoteFile, writeRemoteFileAtomic } from "./prod-ssh.js";
export type { RemoteShell } from "./prod-ssh.js";
export { mintToken, tokenEnvKey, envKeyCollision } from "./token.js";
export { macKeychain, memoryKeychain, KEYCHAIN_SERVICE } from "./keychain.js";
export type { Keychain } from "./keychain.js";
export { keysNew, keysList, keysRevoke } from "./keys.js";
export type { KeysDeps, KeysNewOptions, KeysRevokeOptions, KeysListResult, KeysListEntry } from "./keys.js";
