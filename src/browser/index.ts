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
  FieldState,
  NavigationDecision,
  NavigationGuard,
  NavigationRequest,
  PageSnapshot,
  ProxyConfig,
  RenderOptions,
  RenderResult,
  RestoreState,
  StorageState,
  StorageStateCookie,
  StorageStateOrigin,
  WaitCondition,
} from "./types.js";
export { sealRestoreState, isSealedRestore } from "./types.js";
export { createBrowserCore, PatchrightBrowserCore, restoreOrClose, targetToSelector } from "./patchright-core.js";
export {
  assess,
  isCleared,
  isVisiblyBlocked,
  isCloudflareVisible,
  hasCloudflareHint,
  isPerimeterXVisible,
  hasPerimeterXHint,
  isPerimeterXChallenge,
  hasPerimeterXChallengeCopy,
  isHardBlock,
  matchedBlockPhrases,
  vendorHints,
  BLOCK_PHRASES,
  CF_BLOCK_PHRASES,
  PX_BLOCK_PHRASES,
  VENDOR_SCRIPT_HINTS,
  CF_VENDOR_HINTS,
  PX_VENDOR_HINTS,
  MIN_CONTENT_LENGTH,
  STRONG_CONTENT_LENGTH,
  type Assessment,
  type PageSignal,
  type Verdict,
} from "./detect.js";
export {
  buildLaunchOptions,
  buildLocalStorageSeedScript,
  resolveCoreOptions,
  DEFAULT_CORE_OPTIONS,
  WEBRTC_IP_HANDLING_ARG,
  WEBGL_SWIFTSHADER_ARGS,
  type PatchrightLaunchOptions,
  type ResolvedCoreOptions,
} from "./launch-options.js";
export {
  detectCaptcha,
  NullCaptchaSolver,
  liveCaptchaToChallenge,
  liveCaptchaPendingRender,
  awaitSolvableCaptcha,
  injectTokenJs,
  DETECT_LIVE_CAPTCHA_JS,
  type CaptchaChallenge,
  type CaptchaKind,
  type CaptchaSolver,
  type LiveCaptcha,
} from "./captcha.js";
export {
  FINGERPRINT_COLLECTOR_JS,
  collectFingerprint,
  flattenFingerprint,
  classifyAxis,
  diffFingerprints,
  AXIS_SEVERITY,
  type FingerprintSnapshot,
  type FingerprintDiff,
  type AxisSeverity,
} from "./fingerprint.js";
