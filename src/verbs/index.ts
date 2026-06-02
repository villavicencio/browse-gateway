/**
 * Outcome verbs (U5). v1 ships `retrieve(url) -> clean markdown`; `synthesize()` and the
 * low-level `drive()` escape hatch are v1.1.
 */
export { retrieve, proxyFromSecrets } from "./retrieve.js";
export type { RetrieveOptions, RetrieveResult } from "./retrieve.js";
export { extractMarkdown } from "./extract.js";
export type { Extraction } from "./extract.js";
export { isCloudflareBlock, shouldEscalateToProxy } from "./escalation.js";
export type { EscalationContext } from "./escalation.js";
export { proxyOverrideFor, navFailed, shouldEscalateDrive, PROXY_OPEN_ATTEMPTS } from "./drive.js";
export { detectCaptcha, NullCaptchaSolver } from "./captcha.js";
export type { CaptchaChallenge, CaptchaKind, CaptchaSolver } from "./captcha.js";
