/**
 * The CAPTCHA seam moved DOWN to the browser layer (`src/browser/captcha.ts`) — the core owns the
 * live page where a challenge is detected, solved, and resumed. This module re-exports it so existing
 * verb-layer imports (`retrieve`, the verbs barrel, the vendor solver) keep working unchanged.
 */
export { detectCaptcha, NullCaptchaSolver, isSolvableCaptchaKind } from "../browser/captcha.js";
export type { CaptchaChallenge, CaptchaKind, CaptchaSolver } from "../browser/captcha.js";
