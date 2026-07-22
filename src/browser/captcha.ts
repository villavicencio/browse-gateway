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
import { stripInertHtml } from "./detect.js";

export type CaptchaKind = "recaptcha" | "hcaptcha" | "turnstile" | "unknown";

/**
 * The CAPTCHA kinds the solver architecture can (in principle) solve (issue #44) — the SINGLE SOURCE for
 * eligibility, kept here in the browser layer so both the core (`#snapshotOf`) and the verbs layer can read
 * it without a verbs→browser→verbs cycle. It MUST match the kinds `verbs/captcha-solver.ts`'s `TASK_TYPE`
 * maps to a task-type string (currently reCAPTCHA v2 / Turnstile / hCaptcha; `unknown` is not); a unit test
 * (`captcha-solver.test`) locks the two together so eligibility can never contradict what the solver
 * actually attempts. Adding/removing a solvable vendor means updating BOTH plus that test.
 */
export const SOLVABLE_CAPTCHA_KINDS = ["recaptcha", "turnstile", "hcaptcha"] as const;

/** Whether the solver architecture can (in principle) solve this kind — a pure property of the kind,
 *  independent of whether a solver instance is wired or has budget.
 *
 *  DEFERRED (issue #44, HOLD): finer eligibility for a Turnstile widget that co-fires with a Cloudflare
 *  hint. #40 attributes such a page `cf-challenge` → `wafVendor=cloudflare` (WAF-first) and can leave
 *  `captchaKind` unset, so eligibility reads as a generic CF block rather than the (solvable) Turnstile
 *  widget it is. Promoting `turnstile` over `cf-challenge` is BLOCKED on a captured CF *managed-challenge*
 *  fixture: without ground truth on whether the Under-Attack interstitial itself carries a
 *  `cf-turnstile-response` / `class="cf-turnstile"` container, promoting it risks mislabeling managed
 *  challenges. Capture the fixture, then decide precedence. (Codex #40 r8.) */
export function isSolvableCaptchaKind(kind: CaptchaKind): boolean {
  return (SOLVABLE_CAPTCHA_KINDS as readonly string[]).includes(kind);
}

/**
 * The closed vocabulary for {@link resolveCaptchaSolveReason} / the `captchaSolveReason` envelope slot
 * (issue #44): the solver's typed error codes plus the allowlist-collapse fallback `error`. Typed as a
 * UNION (not a bare string) so the envelope slot has the SAME closed-vocabulary safety basis as
 * `wafVendor`/`failureClass` — the redactor passes it through untouched, which is safe ONLY because the
 * value is one of these secret-free markers, never free text from a page or a solver message (R9, codex #44).
 */
export type CaptchaSolveReason = (typeof CAPTCHA_SOLVE_ERROR_CODES)[number] | "error";

/**
 * Resolve the closed-vocabulary `captchaSolveReason` for a snapshot (issue #44) — pure, so the derivation
 * is unit-testable off the real browser core. Precedence:
 *   - no CAPTCHA detected            → undefined (nothing to report);
 *   - an actual attempt FAILED       → its typed code (`attemptReason`: vendor-error / timeout /
 *                                      budget-exhausted / missing-sitekey / error), which wins;
 *   - no solver wired                → `not-configured`;
 *   - solver wired, kind unsolvable  → `unsupported-kind`;
 *   - solver wired, kind solvable, no attempt-failure → undefined (a solve may have succeeded or not run).
 */
export function resolveCaptchaSolveReason(opts: {
  captchaKind: CaptchaKind | undefined;
  solverPresent: boolean;
  attemptReason?: CaptchaSolveReason;
}): CaptchaSolveReason | undefined {
  const { captchaKind, solverPresent, attemptReason } = opts;
  if (!captchaKind) return undefined;
  if (attemptReason) return attemptReason;
  if (!solverPresent) return "not-configured";
  return isSolvableCaptchaKind(captchaKind) ? undefined : "unsupported-kind";
}

export interface CaptchaChallenge {
  kind: CaptchaKind;
  url: string;
  siteKey?: string;
}

export interface CaptchaSolver {
  /** Solve the challenge and return the response token to inject into the page. `deadlineMs` (#45) is an
   *  absolute `performance.now()`-domain ceiling from the caller's remaining per-call budget: the solve must
   *  not run past it even if the solver's own configured timeout is larger (the effective deadline is the
   *  MIN of the two). Omitted → the solver's own timeout governs. */
  solve(challenge: CaptchaChallenge, deadlineMs?: number): Promise<string>;
}

/**
 * The KNOWN, non-secret solver error codes (part of the CaptchaSolver contract; `verbs/captcha-solver`
 * derives its `CaptchaSolveErrorCode` type from this). An ALLOWLIST: the browser core logs a recognized
 * code in a solve-failure diagnostic but replaces any UNRECOGNIZED `code` from a custom/injected solver
 * with a generic marker, so an opaque solver can't smuggle a secret into stderr via `error.code` (R9).
 */
export const CAPTCHA_SOLVE_ERROR_CODES = [
  "not-configured", // no API key/URL — solver shouldn't have been constructed
  "unsupported-kind", // we don't map this CaptchaKind to a task type
  "missing-sitekey", // the challenge carried no siteKey (required by the task types)
  "budget-exhausted", // per-window solve cap hit — refuse rather than spend
  "vendor-error", // the service returned an error (createTask/getTaskResult errorId)
  "timeout", // the solve did not complete within the deadline
] as const;

export class NullCaptchaSolver implements CaptchaSolver {
  async solve(): Promise<string> {
    throw new Error("no CAPTCHA solver configured");
  }
}

const SITE_KEY = /data-sitekey=["']([^"']+)["']/i;

/** The first `data-sitekey` value in the HTML, or undefined if none (issue #44) — used to compare a stashed
 *  solve outcome's attempted site key against the widget in the final snapshot HTML, so a same-kind CAPTCHA
 *  rotation doesn't misattribute the reason. Best-effort on a multi-widget page (it reads the FIRST key). */
export function firstSiteKey(html: string): string | undefined {
  return SITE_KEY.exec(html)?.[1];
}

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

/**
 * A regex for a single ELEMENT that is a placed widget CONTAINER of class `cls` — the HTML-string form of
 * the live gate's `.<cls>[data-sitekey]` ({@link DETECT_LIVE_CAPTCHA_JS}): an opening tag carrying `cls` as
 * a whole CLASS-VALUE token (delimited by the attribute quote or whitespace — so a COMPOUND class
 * `g-recaptcha-wrapper` or a pseudo `g-recaptcha:disabled` does NOT match, codex #40 r5/r7) AND a real
 * `data-sitekey=` ATTRIBUTE (matched with a trailing `=`, so a `data-config="data-sitekey"` VALUE does not
 * satisfy it, r7), in either attribute order.
 */
function containerRe(cls: string): RegExp {
  return new RegExp(
    `<[a-z][a-z0-9]*(?=[^>]*\\sclass\\s*=\\s*["'][^"']*(?<=["'\\s])${cls}(?=["'\\s])[^"']*["'])(?=[^>]*\\sdata-sitekey\\s*=)`,
    "i",
  );
}

/** A response-field element (`name`/`id` = `<kind>-response`) — injected only when a widget RENDERS, so it
 *  is evidence of an active/explicit-render widget, never of a merely-loaded library. Matched as a REAL
 *  `name`/`id` attribute: the `(?<![-\w])` boundary rejects a `data-*` suffix, so dormant metadata such as
 *  `data-name="g-recaptcha-response"` does not count (codex #40 r8). */
function responseFieldRe(name: string): RegExp {
  return new RegExp(`(?<![-\\w])(?:name|id)\\s*=\\s*["']${name}["']`, "i");
}

/** A RENDERED-iframe `src` whose URL matches `urlRe` — real `src` attribute only (`(?<![-\w])` rejects a
 *  `data-src` suffix, codex #40 r8), so a dormant `data-src` template value isn't read as a live iframe. */
function iframeSrcRe(urlRe: string): RegExp {
  return new RegExp(`(?<![-\\w])src\\s*=\\s*["'][^"']*${urlRe}`, "i");
}

/** Per-kind evidence of an ACTIVE/RENDERED widget — ANY of: a placed container, a RENDERED iframe
 *  (distinct from the library `api.js` URL — e.g. reCAPTCHA's `api2/anchor`, hCaptcha's asset host), or a
 *  response field. This catches BOTH declarative widgets AND `grecaptcha.render`/explicit-render
 *  integrations that inject into an arbitrary container (codex #40 r7), while a mere `<script src=…api.js>`
 *  matches none. Order mirrors {@link detectCaptcha} for determinism if kinds ever coexist. */
const WIDGET_EVIDENCE: readonly { kind: Exclude<CaptchaKind, "unknown">; res: readonly RegExp[] }[] = [
  { kind: "turnstile", res: [containerRe("cf-turnstile"), responseFieldRe("cf-turnstile-response")] },
  {
    kind: "hcaptcha",
    res: [containerRe("h-captcha"), responseFieldRe("h-captcha-response"), iframeSrcRe("newassets\\.hcaptcha\\.com")],
  },
  {
    kind: "recaptcha",
    res: [containerRe("g-recaptcha"), responseFieldRe("g-recaptcha-response"), iframeSrcRe("recaptcha\\/api2\\/(?:anchor|bframe)")],
  },
];

/**
 * The kind of an ACTIVE interactive CAPTCHA widget in the rendered HTML — evidenced by a placed container,
 * a rendered iframe, or a response field ({@link WIDGET_EVIDENCE}), read off the LIVE markup with inert
 * contexts stripped first ({@link stripInertHtml} — the shared strip, so a commented-out/templated
 * `<div class="g-recaptcha" data-sitekey>` isn't mistaken for an active challenge, codex #40 r6) — or
 * `undefined` when only a captcha LIBRARY is loaded, the marker appears in dormant/non-element text, or none
 * is present. Purpose-built for vendor attribution (issue #40): unlike {@link detectCaptcha} (which also
 * matches a bare library and pairs the first sitekey with any kind), the kind here is bound to real rendered
 * evidence, so it neither over-attributes (library-only r3, cross-label r4, compound-class/substring r5,
 * comment/template r6, pseudo-class/attr-value r7) nor under-attributes (it catches
 * `grecaptcha.render`/explicit-render widgets via their iframe/response field, r7).
 */
export function activeCaptchaKind(html: string): CaptchaKind | undefined {
  const live = stripInertHtml(html);
  return WIDGET_EVIDENCE.find(({ res }) => res.some((re) => re.test(live)))?.kind;
}

/**
 * The pre-attempt why-not for a supported CAPTCHA widget that was DETECTED but never became attemptable
 * (issue #44, codex r2) — classified from the final live-DOM read after {@link awaitSolvableCaptcha} gave
 * up, so the failure envelope reports WHY instead of omitting it while `solverEligible` is true. Pure +
 * unit-testable. `missing-sitekey` (no key to solve against) or `timeout` (the response field never
 * rendered within the render budget). An already-solved widget (`respLen > 0`), a solvable-now widget
 * (`respLen === 0` with a sitekey — a render race the poll just missed), or no live widget → undefined:
 * none of those is a pre-attempt failure to report.
 */
export function preAttemptSolveReason(live: LiveCaptcha | null): CaptchaSolveReason | undefined {
  if (!live) return undefined;
  if (!live.siteKey) return "missing-sitekey";
  return live.respLen < 0 ? "timeout" : undefined;
}

/** A live, in-DOM CAPTCHA widget read off the active page (drive path). */
export interface LiveCaptcha {
  kind: Exclude<CaptchaKind, "unknown">;
  siteKey: string;
  /**
   * Response-token field length, as a tri-state: `-1` the field is ABSENT (the widget's async script
   * hasn't injected it yet — i.e. not rendered), `0` present-and-EMPTY (rendered, unsolved → solvable),
   * `>0` present-and-FILLED (already self-solved). Distinguishing absent from filled is what lets the
   * caller wait out the render race instead of skipping a widget that just hasn't drawn its field yet.
   */
  respLen: number;
}

/**
 * In-page script (evaluated on the live page) that returns a {@link LiveCaptcha} or null. Detects the
 * three interactive token-CAPTCHA families by their widget container's `data-sitekey` and reports the
 * response field's token length as a tri-state `respLen` (`-1` absent / `0` empty / `>0` filled) — see
 * {@link LiveCaptcha.respLen}. It reports `respLen` raw rather than collapsing it to a boolean so the
 * caller can tell "not rendered yet" (wait) from "already solved" (skip); collapsing the two is what
 * made an async-rendered widget look permanently unsolvable to a gate that runs at domcontentloaded.
 */
export const DETECT_LIVE_CAPTCHA_JS = `(() => {
  const tokLen = (sel) => { const e = document.querySelector(sel); return e ? (e.value || '').length : -1; };
  const re = document.querySelector('.g-recaptcha[data-sitekey]');
  if (re) return { kind: 'recaptcha', siteKey: re.getAttribute('data-sitekey') || '', respLen: tokLen('[name="g-recaptcha-response"]') };
  const ts = document.querySelector('.cf-turnstile[data-sitekey]');
  if (ts) return { kind: 'turnstile', siteKey: ts.getAttribute('data-sitekey') || '', respLen: tokLen('[name="cf-turnstile-response"]') };
  const hc = document.querySelector('.h-captcha[data-sitekey]');
  if (hc) return { kind: 'hcaptcha', siteKey: hc.getAttribute('data-sitekey') || '', respLen: tokLen('[name="h-captcha-response"]') };
  return null;
})()`;

/**
 * Pure decision: turn a {@link LiveCaptcha} reading into a solvable {@link CaptchaChallenge}, or null
 * when there's nothing worth solving (no widget, already solved, not rendered yet, or no sitekey to
 * solve against). Solvable means the response field is present and EMPTY (`respLen === 0`). Keeping the
 * gate pure makes the "never speculatively solve" rule unit-testable without a browser.
 */
export function liveCaptchaToChallenge(live: LiveCaptcha | null, url: string): CaptchaChallenge | null {
  if (!live || live.respLen !== 0 || !live.siteKey) return null;
  return { kind: live.kind, url, siteKey: live.siteKey };
}

/**
 * The widget container exists (sitekey known) but its response field has not rendered yet
 * (`respLen === -1`) — the widget's async script hasn't injected the field. This is the ONE state
 * worth waiting on: a gate that fires at `domcontentloaded` (before that script runs) sees exactly
 * this, and skipping it permanently is the render-race bug. A filled field (already solved), an empty
 * one (solvable now), no sitekey, or no widget at all are NOT pending — there's nothing to wait for.
 */
export function liveCaptchaPendingRender(live: LiveCaptcha | null): boolean {
  return !!live && !!live.siteKey && live.respLen === -1;
}

/**
 * Resolve a solvable challenge, polling out the widget's render race. `navigate()` resolves at
 * `domcontentloaded`, but reCAPTCHA/Turnstile/hCaptcha inject their response field from an async
 * script that runs LATER — so a one-shot detect right after settle sees the container with no field
 * (`respLen -1`) and {@link liveCaptchaToChallenge} returns null. The only other detect pass is the
 * next action, which for a submit re-navigates and re-races — so without this poll an async-rendered
 * widget is never solved. Returns as soon as the field renders empty (solvable); stops immediately
 * when there's no widget or it's already filled; gives up after `timeoutMs` if a container is present
 * but never draws its field. Pure: the I/O (`detect`/`urlOf`/`wait`) is injected, so it unit-tests
 * without a browser.
 */
export async function awaitSolvableCaptcha(
  detect: () => Promise<LiveCaptcha | null>,
  urlOf: () => string,
  wait: (ms: number) => Promise<void>,
  opts: { pollMs: number; timeoutMs: number },
): Promise<CaptchaChallenge | null> {
  let waited = 0;
  for (;;) {
    const live = await detect();
    const challenge = liveCaptchaToChallenge(live, urlOf());
    if (challenge) return challenge;
    if (!liveCaptchaPendingRender(live) || waited >= opts.timeoutMs) return null;
    await wait(opts.pollMs);
    waited += opts.pollMs;
  }
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
