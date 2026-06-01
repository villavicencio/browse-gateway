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
  DriveTarget,
  NavigationDecision,
  NavigationGuard,
  NavigationRequest,
  PageSnapshot,
  ProxyConfig,
  RenderOptions,
  RenderResult,
  WaitCondition,
} from "./types.js";
export { createBrowserCore, PatchrightBrowserCore, targetToSelector } from "./patchright-core.js";
export {
  assess,
  isCleared,
  isVisiblyBlocked,
  isHardBlock,
  matchedBlockPhrases,
  vendorHints,
  BLOCK_PHRASES,
  CF_BLOCK_PHRASES,
  VENDOR_SCRIPT_HINTS,
  CF_VENDOR_HINTS,
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
