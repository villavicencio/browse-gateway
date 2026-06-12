/**
 * One subprocess helper for the whole CLI: argv-array execution (never a shell string from our
 * side — KTD4's no-shell-history rule), captured output, optional stdin. Secrets travel via
 * stdin or argv-to-a-trusted-binary, never through a shell interpolation we compose.
 */
import { spawn } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** The injectable subprocess seam every side-effecting CLI module accepts. */
export type Exec = (cmd: string, args: string[]) => Promise<ExecResult>;

/** Default watchdog: generous for SSH round-trips, far below "operator walks away confused". */
const DEFAULT_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 5_000;

/**
 * Run `cmd` with `args` (no shell), feeding `input` on stdin when given. Resolves with the exit
 * code rather than throwing on nonzero — callers decide what a failure means. Rejects only when
 * the process can't start at all (e.g. the binary is missing). Every call is bounded by a
 * watchdog (`timeoutMs`, default 30s): a hung ssh/claude/security child resolves `code: -1`
 * with a synthesized stderr instead of hanging the CLI forever.
 */
export function execCapture(
  cmd: string,
  args: string[],
  opts: { input?: string; timeoutMs?: number } = {},
): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
    }, timeoutMs);
    killTimer.unref();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (stdout += d));
    child.stderr.on("data", (d: string) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(killTimer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      if (timedOut) {
        resolve({ code: -1, stdout, stderr: `${stderr}${stderr ? "\n" : ""}${cmd} timed out after ${timeoutMs}ms` });
      } else {
        resolve({ code: code ?? -1, stdout, stderr });
      }
    });
    child.stdin.on("error", () => {}); // a dead child mid-write must surface as its exit code, not EPIPE
    child.stdin.end(opts.input ?? "");
  });
}
