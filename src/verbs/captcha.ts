/**
 * CAPTCHA detection + solver seam (R8). Detection is pure; solving is delegated to an
 * injectable {@link CaptchaSolver} so a real vendor (e.g. a 2captcha-style service) can be
 * wired later without touching the verb logic. The default solver refuses, so an
 * un-configured deployment fails loudly rather than silently dead-ending.
 */
import type { PageSignal } from "../browser/index.js";

export type CaptchaKind = "recaptcha" | "hcaptcha" | "turnstile" | "unknown";

export interface CaptchaChallenge {
  kind: CaptchaKind;
  url: string;
  siteKey?: string;
}

export interface CaptchaSolver {
  /** Solve the challenge and return the response token to inject into the page. */
  solve(challenge: CaptchaChallenge): Promise<string>;
}

export class NullCaptchaSolver implements CaptchaSolver {
  async solve(): Promise<string> {
    throw new Error("no CAPTCHA solver configured");
  }
}

const SITE_KEY = /data-sitekey=["']([^"']+)["']/i;

/** Identify an interactive CAPTCHA widget in the rendered HTML, or null if none. */
export function detectCaptcha(signal: PageSignal, url: string): CaptchaChallenge | null {
  const html = signal.html;
  const siteKey = SITE_KEY.exec(html)?.[1];
  if (/challenges\.cloudflare\.com\/turnstile|cf-turnstile/i.test(html)) {
    return { kind: "turnstile", url, ...(siteKey ? { siteKey } : {}) };
  }
  if (/h-captcha|hcaptcha\.com\/1\/api\.js/i.test(html)) {
    return { kind: "hcaptcha", url, ...(siteKey ? { siteKey } : {}) };
  }
  if (/g-recaptcha|recaptcha\/api\.js|grecaptcha/i.test(html)) {
    return { kind: "recaptcha", url, ...(siteKey ? { siteKey } : {}) };
  }
  return null;
}
