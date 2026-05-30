/**
 * CDP exposure guardrail (R13, R17). The Patchright core controls Chromium over a pipe and
 * never opens a public debugging port; this assertion is a regression guard so a future
 * change can't accidentally bind CDP to a non-local address.
 */
const LOCAL_ADDRESSES = new Set(["127.0.0.1", "localhost", "::1"]);

/** Throw if any launch arg would expose the CDP debugging interface off-localhost. */
export function assertLocalCdpOnly(args: readonly string[]): void {
  for (const arg of args) {
    const m = /^--remote-debugging-address=(.*)$/.exec(arg);
    if (m && !LOCAL_ADDRESSES.has((m[1] ?? "").trim())) {
      throw new Error(`refusing to expose browser CDP on a non-local address: "${m[1]}"`);
    }
  }
}
