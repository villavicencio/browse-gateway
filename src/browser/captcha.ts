/**
 * CAPTCHA seam — lives in the browser layer because the core owns the live page where a challenge
 * is detected, solved, and resumed. Detection is pure; solving is delegated to an injectable
 * {@link CaptchaSolver} (a real vendor is wired in `verbs/captcha-solver`), so the core stays
 * vehicle/vendor-agnostic and an un-configured deployment simply leaves a detected CAPTCHA to fail
 * rather than silently dead-ending.
 *
 * Two detection surfaces:
 *  - {@link detectCaptcha} — pure, HTML-string based. Used by `retrieve` for its block-reason
 *    diagnostic (it has no live page, only a rendered snapshot).
 *  - {@link DETECT_LIVE_CAPTCHA_JS} + {@link liveCaptchaToChallenge} — for the stateful drive path,
 *    where the core CAN read the live DOM: it extracts the real sitekey and checks whether the
 *    response-token field is still empty (i.e. unsolved/blocking), so we only spend a solve on a
 *    genuine, blocking widget — never speculatively.
 */
import type { PageSignal } from "./detect.js";

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

/** Identify an interactive CAPTCHA widget in the rendered HTML, or null if none (pure, HTML-based). */
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

/** A live, in-DOM CAPTCHA widget read off the active page (drive path). */
export interface LiveCaptcha {
  kind: Exclude<CaptchaKind, "unknown">;
  siteKey: string;
  /** The widget's response-token field exists and is empty — i.e. rendered but not yet solved. */
  responseEmpty: boolean;
}

/**
 * In-page script (evaluated on the live page) that returns a {@link LiveCaptcha} or null. Detects the
 * three interactive token-CAPTCHA families by their widget container's `data-sitekey`, and reports
 * whether the response field is present-and-empty. `responseEmpty` is true ONLY when the field exists
 * and is empty (=== 0 length) — a missing field (-1) means the widget hasn't rendered yet, so we skip
 * rather than spend a solve on a half-loaded page; a non-empty field means it already self-solved.
 */
export const DETECT_LIVE_CAPTCHA_JS = `(() => {
  const tokLen = (sel) => { const e = document.querySelector(sel); return e ? (e.value || '').length : -1; };
  const re = document.querySelector('.g-recaptcha[data-sitekey]');
  if (re) return { kind: 'recaptcha', siteKey: re.getAttribute('data-sitekey') || '', responseEmpty: tokLen('[name="g-recaptcha-response"]') === 0 };
  const ts = document.querySelector('.cf-turnstile[data-sitekey]');
  if (ts) return { kind: 'turnstile', siteKey: ts.getAttribute('data-sitekey') || '', responseEmpty: tokLen('[name="cf-turnstile-response"]') === 0 };
  const hc = document.querySelector('.h-captcha[data-sitekey]');
  if (hc) return { kind: 'hcaptcha', siteKey: hc.getAttribute('data-sitekey') || '', responseEmpty: tokLen('[name="h-captcha-response"]') === 0 };
  return null;
})()`;

/**
 * Pure decision: turn a {@link LiveCaptcha} reading into a solvable {@link CaptchaChallenge}, or null
 * when there's nothing worth solving (no widget, already solved, or no sitekey to solve against).
 * Keeping the gate pure makes the "never speculatively solve" rule unit-testable without a browser.
 */
export function liveCaptchaToChallenge(live: LiveCaptcha | null, url: string): CaptchaChallenge | null {
  if (!live || !live.responseEmpty || !live.siteKey) return null;
  return { kind: live.kind, url, siteKey: live.siteKey };
}

/**
 * In-page script that injects a solved `token` into the widget's response field and best-effort
 * triggers the site's continuation. The field-set covers the common "captcha gates a form the agent
 * then submits" case; the reCAPTCHA callback traversal handles sites that wait on the JS callback.
 * Best-effort by design (the resume path varies wildly per integration) — exotic callback-only
 * integrations may still need the agent's own submit action to complete. Returns true.
 */
export function injectTokenJs(kind: CaptchaKind, token: string): string {
  const t = JSON.stringify(token);
  const setVal = (sel: string) => `document.querySelectorAll(${JSON.stringify(sel)}).forEach((e) => { e.value = ${t}; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); });`;
  let resume = "";
  if (kind === "recaptcha") {
    // Set the response field, then invoke the site's data-callback so a callback-driven flow advances
    // on its own. grecaptcha nests the callback at a version-dependent depth, so walk the config tree
    // RECURSIVELY (depth-capped, cycle-guarded) rather than at a fixed depth — a fixed walk misses it,
    // which both fails callback-driven sites AND defeats the caller's "did it advance?" replay guard.
    resume = `${setVal('[name="g-recaptcha-response"], #g-recaptcha-response')}
    try {
      var __seen = [];
      (function fire(o, d) {
        if (!o || typeof o !== 'object' || d > 6 || __seen.indexOf(o) !== -1) return;
        __seen.push(o);
        for (var k in o) {
          var v; try { v = o[k]; } catch (e) { continue; }
          if (k === 'callback' && typeof v === 'function') { try { v(${t}); } catch (e) {} }
          else if (v && typeof v === 'object') fire(v, d + 1);
        }
      })(window.___grecaptcha_cfg && window.___grecaptcha_cfg.clients, 0);
    } catch (e) {}`;
  } else if (kind === "turnstile") {
    resume = setVal('[name="cf-turnstile-response"], #cf-turnstile-response');
  } else {
    resume = setVal('[name="h-captcha-response"], #h-captcha-response, [name="g-recaptcha-response"]');
  }
  return `(() => { ${resume} return true; })()`;
}
