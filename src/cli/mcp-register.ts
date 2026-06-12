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

  if (existing.code === 0) {
    // `claude mcp get` prints the URL and headers; when both match exactly there is nothing to do.
    if (existing.stdout.includes(opts.url) && existing.stdout.includes(opts.token)) return "unchanged";
    const removed = await exec("claude", ["mcp", "remove", name]);
    if (removed.code !== 0) {
      throw new Error(`claude mcp remove ${name} failed (exit ${removed.code}): ${removed.stderr.trim() || removed.stdout.trim()}`);
    }
  }

  const added = await exec("claude", [
    "mcp",
    "add",
    "--transport",
    "http",
    name,
    opts.url,
    "--header",
    `Authorization: Bearer ${opts.token}`,
  ]);
  if (added.code !== 0) {
    throw new Error(`claude mcp add ${name} failed (exit ${added.code}): ${added.stderr.trim() || added.stdout.trim()}`);
  }
  return existing.code === 0 ? "updated" : "added";
}
