/**
 * Admin-SSH orchestration (KTD3): `keys` mutates prod files over the operator's existing admin
 * SSH trust — there is deliberately NO gateway enroll/admin HTTP API (it would add a privileged
 * surface to a public-IP box). This module abstracts "run a script on the prod host" behind
 * {@link RemoteShell} so every file operation is unit-testable against a local `sh` fake.
 */
import type { ExecResult } from "./exec.js";
import { execCapture } from "./exec.js";

export interface RemoteShell {
  /** Run a POSIX-sh script on the host, feeding `input` on stdin. Resolves with the exit code. */
  run(script: string, input?: string): Promise<ExecResult>;
}

/** The real thing: scripts run on the prod host over the operator's admin SSH destination. */
export function sshShell(destination: string): RemoteShell {
  return {
    run: (script, input) => execCapture("ssh", ["-o", "BatchMode=yes", destination, script], { input }),
  };
}

/** Test/integration fake: the same scripts against the local `sh` (loopback semantics). */
export function localShell(): RemoteShell {
  return {
    run: (script, input) => execCapture("sh", ["-c", script], { input }),
  };
}

/** Single-quote a value for embedding in a POSIX-sh script. */
export function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Read a remote file; `null` when it doesn't exist (any other failure also reads as absent). */
export async function readRemoteFile(shell: RemoteShell, path: string): Promise<string | null> {
  const r = await shell.run(`cat ${shQuote(path)} 2>/dev/null`);
  return r.code === 0 ? r.stdout : null;
}

/**
 * Atomic remote write (KTD9): stream contents over stdin to a same-directory temp file, set the
 * mode, then `mv` into place — a reader (or an interrupt) sees the old file or the new file,
 * never a torn one. Contents travel on stdin, not in argv, so they never hit a process table.
 */
export async function writeRemoteFileAtomic(
  shell: RemoteShell,
  path: string,
  contents: string,
  mode: string,
): Promise<void> {
  const q = shQuote(path);
  const script = [
    "set -eu",
    "umask 077",
    `tmp=${shQuote(`${path}.obscura-tmp`)}`,
    'cat > "$tmp"',
    `chmod ${mode} "$tmp"`,
    `mv "$tmp" ${q}`,
  ].join("\n");
  const r = await shell.run(script, contents);
  if (r.code !== 0) {
    throw new Error(`remote write of ${path} failed (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
  }
}
