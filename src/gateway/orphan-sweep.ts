/**
 * Reap of a WEDGED launch's half-spawned Chromium by its gateway-owned userDataDir (issue #54 Part 2).
 *
 * A `launchPersistentContext` that never resolves hands back no context and no PID, so the #50
 * force-kill primitive (post-resolve capture) cannot reach whatever Chromium it half-spawned. But the
 * GATEWAY minted the profile dir (`mkdtemp`, unique per launch), and Chromium carries the exact
 * `--user-data-dir=<dir>` argument on its command line — so the dir is a unique, launch-scoped process
 * key that needs no patchright internals. The sweep scans `/proc/<pid>/cmdline` for that exact
 * NUL-separated argument, group-SIGKILLs each match's process group (the #50 group discipline — child
 * renderers/crashpad live in the leader's group and rarely carry the argument themselves), and confirms
 * death per ORIGINALLY-MATCHED pid via the #50 generation marker (`/proc/<pid>/stat` start-time): a pid
 * that vanished OR was recycled with a different start-time is gone. Each confirm poll also RESCANS the
 * cmdline key so a process forked mid-sweep under the same profile is killed too.
 *
 * Linux-only by design (`/proc` is the mechanism): elsewhere the sweep reports `unsupported` and the
 * caller degrades LOUDLY to Part-1 semantics (macOS is dev-only; prod is the Linux container, where
 * pids_limit pressure is the reason this exists). Pure scan/parse pieces take an injectable `procRoot`
 * and `kill` so they are unit-testable against a fake proc tree without real processes; the kill path's
 * real-physics proof is the in-container `scripts/validate-teardown.mjs` sweep leg.
 */
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProcStat } from "../browser/index.js";

/** Outcome of one sweep attempt over a profile dir. */
export type SweepResult = "confirmed" | "unconfirmed" | "unsupported";

/** Injection surface for the sweep's OS interactions, so every branch is unit-testable. */
export interface SweepEnv {
  procRoot?: string;
  platform?: NodeJS.Platform;
  /** SIGKILL/probe sender; defaults to `process.kill`. Receives negative pids for group signals. */
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  /** Poll sleep; injectable so tests don't wait wall-clock. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const SWEEP_POLL_MS = 100;

/**
 * Pids whose `/proc/<pid>/cmdline` carries the EXACT `--user-data-dir=<dir>` argument (NUL-separated
 * exact-arg match — never a substring, so a dir that happens to prefix another can't over-match; the
 * mkdtemp'd dir is unique per launch regardless). A pid that exits mid-scan is skipped, never an error.
 */
export function findPidsByUserDataDir(dir: string, procRoot = "/proc"): number[] {
  const marker = `--user-data-dir=${dir}`;
  const out: number[] = [];
  let names: string[];
  try {
    names = readdirSync(procRoot);
  } catch {
    return out; // no proc tree readable → nothing findable (the caller's platform gate reports unsupported)
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const cmdline = readFileSync(join(procRoot, name, "cmdline"), "utf8");
      if (cmdline.split("\0").includes(marker)) out.push(Number(name));
    } catch {
      // raced exit between readdir and read — skip
    }
  }
  return out;
}

/**
 * Kill-and-confirm every process launched under `dir` (see the module doc for the mechanism), bounded
 * by `confirmMs`. Returns:
 *  - `"confirmed"` — no process carries the dir on its cmdline AND every originally-matched pid is gone
 *    or recycled (start-time generation changed). Includes the trivial case (nothing ever matched).
 *  - `"unconfirmed"` — something still lives at the deadline (e.g. a D-state unkillable); the caller
 *    keeps the orphan COUNTED and retries on its next tick (the #50 never-lie posture).
 *  - `"unsupported"` — not Linux / no proc tree; the caller degrades loudly.
 */
export async function sweepOrphanProcesses(
  dir: string,
  confirmMs: number,
  env: SweepEnv = {},
): Promise<SweepResult> {
  const platform = env.platform ?? process.platform;
  if (platform !== "linux") return "unsupported";
  const procRoot = env.procRoot ?? "/proc";
  const kill = env.kill ?? ((pid: number, sig: NodeJS.Signals | 0) => process.kill(pid, sig));
  const sleep = env.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = env.now ?? (() => Date.now());

  /** Generation-stamped kill of every current match; returns the stamped pids for the confirm below. */
  const killMatches = (): Map<number, string | undefined> => {
    const stamped = new Map<number, string | undefined>();
    for (const pid of findPidsByUserDataDir(dir, procRoot)) {
      const stat = readProcStat(pid, procRoot);
      stamped.set(pid, stat?.startTime);
      // Group-SIGKILL (the #50 discipline): renderers/crashpad live in the leader's group without
      // carrying --user-data-dir themselves. Fall back to the pid itself when the group read failed
      // (already-exiting process). ESRCH = already gone — success-shaped, swallowed.
      const target = stat ? -stat.pgrp : pid;
      try {
        kill(target, "SIGKILL");
      } catch {
        // ESRCH/EPERM: gone, or not ours to signal — either way the confirm pass below decides
      }
    }
    return stamped;
  };

  /** A stamped pid is gone when its stat vanished OR its start-time changed (pid recycled — issue #50 r5). */
  const gone = (pid: number, startTime: string | undefined): boolean => {
    const stat = readProcStat(pid, procRoot);
    if (!stat) return true;
    return startTime !== undefined && stat.startTime !== startTime;
  };

  let stamped = killMatches();
  if (stamped.size === 0) return "confirmed"; // nothing lives under this profile
  const deadline = now() + confirmMs;
  for (;;) {
    const allGone = [...stamped].every(([pid, st]) => gone(pid, st));
    if (allGone) {
      // Rescan for a process forked under the profile mid-sweep; kill it and keep polling if found.
      const fresh = killMatches();
      if (fresh.size === 0) return "confirmed";
      stamped = fresh;
    }
    if (now() >= deadline) return "unconfirmed";
    await sleep(SWEEP_POLL_MS);
  }
}

/**
 * The session manager's injection surface for gateway-owned profile-dir lifecycle (issue #54 Part 2):
 * mint an ephemeral dir per launch, sweep a wedged launch's processes by dir, remove a dir after
 * CONFIRMED death. Only dirs minted by `make` are ever swept or removed — a caller-supplied
 * `userDataDir` is never touched.
 *
 * CONTRACT: every op must SETTLE in bounded time — `shutdown()` awaits in-flight orphan work, so a
 * never-settling `sweep` would hang it. The default sweep is internally bounded by its `confirmMs`
 * (returning `"unconfirmed"` rather than waiting forever); an injected test fake must do the same.
 */
export interface OrphanDirOps {
  make(): Promise<string>;
  sweep(dir: string, confirmMs: number): Promise<SweepResult>;
  remove(dir: string): Promise<void>;
}

export const defaultOrphanDirOps: OrphanDirOps = {
  make: () => mkdtemp(join(tmpdir(), "bgw-profile-")),
  sweep: (dir, confirmMs) => sweepOrphanProcesses(dir, confirmMs),
  remove: (dir) => rm(dir, { recursive: true, force: true }),
};
