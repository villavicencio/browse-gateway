/**
 * Outcome verbs (U5). v1 ships `retrieve(url) -> clean markdown`; `synthesize()` and the
 * low-level `drive()` escape hatch are v1.1.
 */
export { retrieve, classifyBlock, wafVendorFromReason, escalationDiagnostics, EscalationError, isRetrieveFailure, classifyExitOrg, parseExitOrg, proxyFromSecrets, mintStickyProxy, newStickyExitId, stickySuffixBootError, stickySuffixRedactables, PROXY_CLEARANCE_TIMEOUT_MS } from "./retrieve.js";
export type { RetrieveOptions, RetrieveResult, BlockReason, BlockSignal, WafVendor, EscalationDiagnostics, EgressCheck } from "./retrieve.js";
// WafVendor is defined in observability (so the FailureDiagnostics slot can be typed to it); re-exported
// above via retrieve.js for callers that reach it through the verbs barrel.
export { extractMarkdown } from "./extract.js";
export type { Extraction } from "./extract.js";
export { isCloudflareBlock, shouldEscalateToProxy, parseForceProxyHosts, hostForcesProxy, parseWarmupPaths } from "./escalation.js";
export type { EscalationContext } from "./escalation.js";
export { proxyOverrideFor, proxyOverrideForPinned, proxyOverrideForFresh, navFailed, shouldEscalateDrive, PROXY_OPEN_ATTEMPTS } from "./drive.js";
export { generateTotp, verifyTotp, isValidTotpSeed, normalizeTotpSeed, MIN_TOTP_SEED_BYTES } from "./totp.js";
export { assistedLogin, coreLoginDriver, DEFAULT_FIELD_TIMEOUT_MS, DEFAULT_FIELD_POLL_MS } from "./assisted-login.js";
export type { LoginRecipe, LoginCredentials, LoginDriver, AssistedLoginOptions, AssistedLoginResult } from "./assisted-login.js";
export { detectCaptcha, NullCaptchaSolver } from "./captcha.js";
export type { CaptchaChallenge, CaptchaKind, CaptchaSolver } from "./captcha.js";
export { HttpCaptchaSolver, CaptchaSolveError, httpCaptchaSolverFromSecrets, DEFAULT_CAPTCHA_BUDGET } from "./captcha-solver.js";
export type { HttpCaptchaSolverConfig, CaptchaSolveErrorCode } from "./captcha-solver.js";
