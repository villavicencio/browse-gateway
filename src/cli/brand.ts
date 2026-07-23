/**
 * The Obscura brand kernel (R1/R2) — the reactive owl mascot, the banner, and the shared output
 * helpers every command speaks through. The brand is experiential only: nothing here touches the
 * technical handle (`BGW_*`, the image name, the MCP prefix).
 *
 * Output discipline: `ok`/`fail`/`note` pass everything through {@link redactTokenLike}, so a
 * token that accidentally reaches an output path is masked rather than echoed. This is the last
 * line of defense — callers still must not put secrets in messages.
 */

export type OwlState = "rest" | "connected" | "degraded" | "down";

/** The one-line owl face: at rest, winking (connected), squinting (degraded — alive but impaired,
 *  issue #53), or eyes-shut (down). */
export function owl(state: OwlState): string {
  switch (state) {
    case "rest":
      return "(o,o)";
    case "connected":
      return "(^,o)";
    case "degraded":
      return "(o,~)";
    case "down":
      return "(-,-)";
  }
}

/** The full perched owl, eyes driven by state. */
export function owlArt(state: OwlState): string {
  return ["  ,___,", `  ${owl(state)}`, '  {`"\'}', '  -"-"-'].join("\n");
}

/** The Obscura wordmark banner with the owl perched beside it. */
export function banner(state: OwlState = "rest"): string {
  const art = owlArt(state).split("\n");
  const words = ["", "O B S C U R A", "see without being seen", ""];
  return art.map((line, i) => `${line.padEnd(10)}${words[i] ?? ""}`.trimEnd()).join("\n");
}

/**
 * Mask anything credential-shaped: long hex runs (our consumer tokens are 64 hex chars) and
 * bearer-credential phrases. Deliberately greedy — a false-positive mask in CLI output is
 * harmless; an echoed token is not.
 */
export function redactTokenLike(text: string): string {
  return text
    .replace(/\b[0-9a-f]{40,}\b/gi, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]");
}

export function ok(message: string): string {
  return `✓ ${redactTokenLike(message)}`;
}

export function fail(message: string): string {
  return `✗ ${redactTokenLike(message)}`;
}

export function note(message: string): string {
  return `· ${redactTokenLike(message)}`;
}
