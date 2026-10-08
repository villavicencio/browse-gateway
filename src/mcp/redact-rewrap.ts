/**
 * The ONE redaction re-wrap every entrypoint uses before an error reaches a consumer (VIL-110).
 *
 * Errors from the browser/session layer can quote BYO secret material (R9), so each entrypoint re-throws
 * a fresh Error carrying only the redacted message. That fresh Error must still carry the session-failure
 * kind, or the MCP layer cannot tell a capacity refusal from a browser crash. Four call sites (both
 * launchers' `retrieve`, and the drive controller's open and run paths) used to hand-roll this; one
 * helper means a test of the helper covers them all, and a source test pins that each still uses it.
 */
import { carrySessionFailureKind } from "../gateway/session-manager.js";
import { redactSecrets } from "../security/index.js";

export function rewrapRedacted(err: unknown, secrets: { redactableValues(): readonly string[] }): Error {
  const message = err instanceof Error ? err.message : String(err);
  return carrySessionFailureKind(new Error(redactSecrets(message, secrets)), err);
}
