/**
 * `claude mcp add` wrapper (KTD4): registers the gateway with the LITERAL bearer token passed
 * as execFile args — never a composed shell string (no shell-history leak; the brief
 * process-table presence is accepted for a local single-operator tool, R-Risk3). The literal
 * token deliberately avoids the documented env-ref inline-verify false-negative
 * (docs/solutions/integration-issues/mcp-client-env-ref-bearer-false-negative.md).
 *
 * The server name stays `browse-gateway` — consumers already speak `mcp__browse-gateway__*`
 * and the technical handle does not rename in the first cut (R1).
 */
import type { Exec } from "./exec.js";
import { execCapture } from "./exec.js";

export const MCP_SERVER_NAME = "browse-gateway";

export type RegisterOutcome = "added" | "updated" | "unchanged";

export interface RegisterOptions {
  url: string;
  token: string;
  serverName?: string;
  exec?: Exec;
}

/** Map a spawn failure to the one actionable cause: the `claude` binary isn't there. */
function claudeMissing(err: unknown): Error {
  const detail = err instanceof Error ? err.message : String(err);
  return new Error(`the \`claude\` CLI is not available (${detail}) — install Claude Code, then re-run obscura connect`);
}

/**
 * Idempotent register: same name + same token already present → skip; present with a different
 * token (or unreadable detail) → remove + re-add; absent → add. Throws on any failure — the
 * caller reports partial state and leaves the tunnel up.
 */
export async function registerMcp(opts: RegisterOptions): Promise<RegisterOutcome> {
  const exec = opts.exec ?? execCapture;
  const name = opts.serverName ?? MCP_SERVER_NAME;

  let existing;
  try {
    existing = await exec("claude", ["mcp", "get", name]);
  } catch (err) {
    throw claudeMissing(err);
  }

  const addArgs = (url: string, token: string) => [
    "mcp",
    "add",
    "--transport",
    "http",
    name,
    url,
    "--header",
    `Authorization: Bearer ${token}`,
  ];

  if (existing.code === 0) {
    // `claude mcp get` prints the URL and headers; when both match exactly there is nothing to do.
    // (If a future claude version redacts the header value, this never matches and every connect
    // takes the remove+add path below — churn, but the restore guard keeps it non-destructive.)
    if (existing.stdout.includes(opts.url) && existing.stdout.includes(opts.token)) return "unchanged";
    // Capture what we're about to destroy so a failed add can put it back.
    const oldUrl = existing.stdout.match(/URL:\s*(\S+)/)?.[1];
    const oldToken = existing.stdout.match(/Bearer\s+([A-Za-z0-9._~+/=-]+)/)?.[1];
    const removed = await exec("claude", ["mcp", "remove", name]);
    if (removed.code !== 0) {
      throw new Error(`claude mcp remove ${name} failed (exit ${removed.code}): ${removed.stderr.trim() || removed.stdout.trim()}`);
    }
    const added = await exec("claude", addArgs(opts.url, opts.token));
    if (added.code !== 0) {
      // The old registration is gone and the new one failed — try to restore the old one so a
      // previously-working setup isn't destroyed by a failed update.
      let restoreNote = "the previous registration could not be parsed for restore — re-run obscura connect once the cause is fixed";
      if (oldUrl && oldToken) {
        const restored = await exec("claude", addArgs(oldUrl, oldToken));
        restoreNote =
          restored.code === 0
            ? "the previous registration was RESTORED — the gateway connection is unchanged"
            : "restoring the previous registration ALSO failed — no registration exists; re-run obscura connect";
      }
      throw new Error(
        `claude mcp add ${name} failed (exit ${added.code}): ${added.stderr.trim() || added.stdout.trim()}; ${restoreNote}`,
      );
    }
    return "updated";
  }

  const added = await exec("claude", addArgs(opts.url, opts.token));
  if (added.code !== 0) {
    throw new Error(`claude mcp add ${name} failed (exit ${added.code}): ${added.stderr.trim() || added.stdout.trim()}`);
  }
  return "added";
}
