/** Public surface of the obscura CLI module (the bin entry `obscura.ts` is not re-exported). */
export { parseCliArgs, usage } from "./args.js";
export type { Invocation, ParseResult, OwlCommand, KeysSubcommand } from "./args.js";
export { owl, owlArt, banner, bootBannerLine, ok, fail, note, redactTokenLike } from "./brand.js";
export type { OwlState } from "./brand.js";
export { loadObscuraConfig, requireConfig, defaultConfigPath } from "./config.js";
export type { ObscuraConfig } from "./config.js";
