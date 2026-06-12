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

/**
 * Run `cmd` with `args` (no shell), feeding `input` on stdin when given. Resolves with the exit
 * code rather than throwing on nonzero — callers decide what a failure means. Rejects only when
 * the process can't start at all (e.g. the binary is missing).
 */
export function execCapture(cmd: string, args: string[], opts: { input?: string } = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (stdout += d));
    child.stderr.on("data", (d: string) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.on("error", () => {}); // a dead child mid-write must surface as its exit code, not EPIPE
    child.stdin.end(opts.input ?? "");
  });
}
