/**
 * Evidence-driven warm-failure advice (#81). The operator message on a WARM (logged-in) navigation failure
 * was previously chosen by HOST CONFIG alone (fresh-exit host → "retry"; else → "re-capture"), ignoring the
 * rich {@link import("./failure-diagnostics.js").FailureDiagnostics} attached to the very same throw — so a
 * live behavioral challenge was mis-messaged as a fresh-exit dud or a stale credential. This maps the
 * failure EVIDENCE to the advice so the message matches what actually happened.
 *
 * A pure, unit-testable projection (like the rest of the failure-diagnostics layer). It branches ONLY on the
 * CLOSED-vocab typed fields (failureClass / wafVendor) + the fresh-exit host flag — NEVER free page text (the
 * R9 redaction invariant). Kept in this low-level module (next to {@link FailureClass}/{@link WafVendor}) so
 * the drive controller delegates to one testable seam.
 */
import type { FailureClass, WafVendor } from "./failure-diagnostics.js";

/** The distilled evidence a warm-failure advice decision needs — the closed-vocab typed fields + the
 *  fresh-exit host flag, never free page text. */
export interface WarmFailureEvidence {
  /** The typed failure class from the attached envelope (issue #41), when one was classified. */
  failureClass?: FailureClass;
  /** The attributed WAF/CAPTCHA vendor (issue #40), when attributable. */
  wafVendor?: WafVendor;
  /** Whether the owner host is on the fresh-exit set (BGW_WARM_FRESH_EXIT_HOSTS) — its warm-open mints a
   *  FRESH residential exit each time rather than re-pinning the captured one, so a block there is more
   *  likely a dud exit than a stale credential. */
  freshExitHost: boolean;
}

/**
 * Map a warm-failure's evidence to the operator advice string (#81). Precedence (most-specific first):
 *
 *   1. `policy-blocked` — a self-inflicted policy block (off-allowlist / off-owner). NORMALLY pre-empted by
 *      R2 (#80) before this seam (surfaced as its own policy error that preserves the session), but handled
 *      DEFENSIVELY here so a warm policy-block can never be mis-advised as stale/fresh: fix the scope/policy,
 *      NOT the credential — a fresh exit can never reach it.
 *   2. a LIVE behavioral challenge that reached the site — `anti-bot-block` + `wafVendor: perimeterx` (a
 *      press-&-hold): a fresh exit will NOT clear it and a retry RE-TRIGGERS it; the stored login is fine.
 *      This is the advice half of finding #4 — the case host config alone mis-messaged as a fresh-exit dud
 *      ("retry to draw a clean exit") or a stale credential ("re-capture"), both actively wrong for a
 *      behavioral challenge PerimeterX serves on ANY exit.
 *   3. a FRESH-EXIT host — the freshly-minted residential exit was a dud (a burned/dead pool IP), NOT a stale
 *      credential: retry to draw a clean exit (the prior `#warmFreshError`).
 *   4. otherwise — a genuinely stale / logged-out replay: re-capture the credential (the prior
 *      `#warmStaleError`), the load-bearing default the fresh/behavioral branches sit in front of.
 *
 * The stale-vs-fresh split is PRESERVED (per the R3 guardrail — a bound re-pinned entry must not be told to
 * "retry", a fresh-exit host should); the policy + behavioral branches are added ALONGSIDE, not collapsing them.
 */
export function warmFailureAdvice(ev: WarmFailureEvidence): string {
  if (ev.failureClass === "policy-blocked") {
    return "the target or a redirect hop is off the allowlist / owner-host — fix the scope/policy, not the credential (a fresh exit cannot reach it)";
  }
  if (ev.failureClass === "anti-bot-block" && ev.wafVendor === "perimeterx") {
    return "a behavioral challenge (press-&-hold) reached the site — a fresh exit will not clear it and a retry re-triggers it; the stored login is fine";
  }
  if (ev.freshExitHost) {
    return "the fresh residential exit was likely burned or unreachable — retry navigate to draw a clean exit";
  }
  return "the stored session is likely expired or blocked — ask the operator to re-capture this credential";
}
