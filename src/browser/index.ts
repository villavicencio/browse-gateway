/**
 * Browser core — engine adapter for the gateway.
 *
 * Public surface is the vehicle-agnostic `BrowserCore` plus the `createBrowserCore`
 * factory; the Patchright implementation is the only vehicle today. Pure detection and
 * launch-option helpers are re-exported for the kill-gate and tests.
 */
export type {
  BrowserCore,
  BrowserCoreOptions,
  Category,
  NavigationDecision,
  NavigationGuard,
  NavigationRequest,
  ProxyConfig,
  RenderOptions,
  RenderResult,
} from "./types.js";
export { createBrowserCore, PatchrightBrowserCore } from "./patchright-core.js";
export {
  assess,
  isCleared,
  matchedBlockPhrases,
  vendorHints,
  BLOCK_PHRASES,
  VENDOR_SCRIPT_HINTS,
  MIN_CONTENT_LENGTH,
  STRONG_CONTENT_LENGTH,
  type Assessment,
  type PageSignal,
  type Verdict,
} from "./detect.js";
export {
  buildLaunchOptions,
  resolveCoreOptions,
  DEFAULT_CORE_OPTIONS,
  type PatchrightLaunchOptions,
  type ResolvedCoreOptions,
} from "./launch-options.js";
