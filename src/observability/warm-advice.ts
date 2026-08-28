/**
 * Evidence-driven warm-failure advice (#81). The operator message on a WARM (logged-in) navigation failure
 * was previously chosen by HOST CONFIG alone (fresh-exit host → "retry"; else → "re-capture"), ignoring the
 * rich {@link import("./failure-diagnostics.js").FailureDiagnostics} attached to the very same throw — so a
 * live behavioral challenge was mis-messaged as a fresh-exit dud or a stale credential. This maps the
 * failure EVIDENCE to the advice so the message matches what actually happened.
 *
 * A pure, unit-testable projection (like the rest of the failure-diagnostics layer). It branches ONLY on the
 * CLOSED-vocab typed field ({@link FailureClass}) + derived booleans (a LIVE behavioral challenge, a genuine
 * transport failure, the fresh-exit host flag) — NEVER free page text (the R9 redaction invariant). Kept in
 * this low-level module (next to {@link FailureClass}) so the drive controller delegates to one testable seam.
 */
import type { FailureClass } from "./failure-diagnostics.js";

/** The distilled evidence a warm-failure advice decision needs — the closed-vocab typed field + derived
 *  booleans, never free page text. */
export interface WarmFailureEvidence {
  /** The typed failure class from the attached envelope (issue #41), when one was classified. */
  failureClass?: FailureClass;
  /** A LIVE behavioral challenge is present on the page — the `pxHint && pxCopy` shape (#82): the vendor
   *  marker AND the press-&-hold challenge copy, the latter ABSENT on a cleared page. This is what the
   *  behavioral advice gates on — NOT vendor attribution (`wafVendor === perimeterx`): the pxHint vendor
   *  marker PERSISTS on a burned-exit 403 (IP reputation), so vendor-gating would tell a fresh-exit host "a
   *  fresh exit won't clear it" when a fresh exit WOULD help. Only `pxCopy` distinguishes a live press-&-hold
   *  from a stale marker (finding: R3 behavioral mis-advice). */
  behavioralChallenge?: boolean;
  /** A GENUINE transport/network failure reached this warm nav ({@link
   *  import("../verbs/index.js").genuineNetworkFailure} over the envelope's networkFailures — a conn-reset /
   *  unreachable exit, not the gateway's own guard aborts or benign SPA cancellations). Distinguishes an
   *  unreachable target from a stale/logged-out replay so a nav-failed on a non-fresh host is advised
   *  "retry the transport", not "re-capture the credential" (finding: R3 transport failures). */
  genuineNetworkFailure?: boolean;
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
 *   1b. `rate-limited` (VIL-121) — the target threw a 429. Sits directly under `policy-blocked` and ABOVE the
 *      fresh-exit branch on purpose: branch 3 would advise "retry to draw a clean exit", which for a rate
 *      limit is both wrong and costly (a second residential session for the same 429). The credential is fine;
 *      the answer is to wait.
 *   2. a LIVE behavioral challenge that reached the site — the `pxHint && pxCopy` press-&-hold shape
 *      ({@link WarmFailureEvidence.behavioralChallenge}): a fresh exit will NOT clear it and a retry
 *      RE-TRIGGERS it; the stored login is fine. Gated on the LIVE-challenge signal, NOT vendor attribution
 *      (`wafVendor: perimeterx` PERSISTS on a burned-exit 403, which a fresh exit WOULD clear) — so a
 *      pxHint-only IP-reputation block correctly falls through to the fresh-exit / stale branches below.
 *   3. a FRESH-EXIT host — the freshly-minted residential exit was a dud (a burned/dead pool IP), NOT a stale
 *      credential: retry to draw a clean exit (the prior `#warmFreshError`).
 *   4. a genuine TRANSPORT failure on a non-fresh host — a `nav-failed` class WITH a real network failure
 *      (conn reset / unreachable), NOT a stale login: retry the transport; the stored session is fine. Gated
 *      on BOTH the nav-failed class AND the transport signal so a hard-block / CF block that merely had a
 *      failed subresource still defaults to re-capture (branch 5).
 *   5. otherwise — a genuinely stale / logged-out replay: re-capture the credential (the prior
 *      `#warmStaleError`), the load-bearing default the branches above sit in front of.
 *
 * The stale-vs-fresh split is PRESERVED (per the R3 guardrail — a bound re-pinned entry must not be told to
 * "retry", a fresh-exit host should); the policy / behavioral / transport branches are added ALONGSIDE, not
 * collapsing them.
 */
export function warmFailureAdvice(ev: WarmFailureEvidence): string {
  if (ev.failureClass === "policy-blocked") {
    return "the target or a redirect hop is off the allowlist / owner-host — fix the scope/policy, not the credential (a fresh exit cannot reach it)";
  }
  // VIL-121: a rate limit must be answered BEFORE the fresh-exit branch below, which would otherwise tell a
  // fresh-exit host to "retry to draw a clean exit" — the single worst response to a 429, since it both fails
  // and spends another residential session. Placed with `policy-blocked` because it shares that branch's
  // shape: the site gave a decisive verdict, the stored credential is irrelevant, and no exit changes it.
  if (ev.failureClass === "rate-limited") {
    return "the target is rate-limiting this client (HTTP 429) — wait before retrying; the stored login is fine and a fresh exit will not clear it";
  }
  if (ev.behavioralChallenge) {
    return "a behavioral challenge (press-&-hold) reached the site — a fresh exit will not clear it and a retry re-triggers it; the stored login is fine";
  }
  if (ev.freshExitHost) {
    return "the fresh residential exit was likely burned or unreachable — retry navigate to draw a clean exit";
  }
  if (ev.failureClass === "nav-failed" && ev.genuineNetworkFailure) {
    return "the navigation failed at the transport layer (a connection reset or unreachable exit), not at the login — retry navigate; the stored session is fine";
  }
  return "the stored session is likely expired or blocked — ask the operator to re-capture this credential";
}
