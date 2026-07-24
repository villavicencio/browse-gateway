/**
 * Observability — evidence surfaced from the browser core to the caller.
 *
 * Seeds with the failure-diagnostics envelope (issue #39): the stable, slot-based bundle that carries
 * finalUrl / title / status / redirect chain / console + network / screenshot on every failure of both
 * the retrieve and drive paths, and that the rest of the site-compat epic (#38) reports through.
 */
export {
  buildFailureDiagnostics,
  redactFailureDiagnostics,
  summarizeFailureDiagnostics,
  sanitizeUrlForError,
  sanitizeUrlsInErrorText,
  attachFailure,
  failureOf,
  assembleTiming,
  FAILURE_DIAGNOSTICS_CAP,
} from "./failure-diagnostics.js";
export type { FailureDiagnostics, FailureDiagnosticsInput, FailureCarrier, WafVendor, FailureClass, SelfBlockedNav, Timing } from "./failure-diagnostics.js";
export { warmFailureAdvice } from "./warm-advice.js";
export type { WarmFailureEvidence } from "./warm-advice.js";
