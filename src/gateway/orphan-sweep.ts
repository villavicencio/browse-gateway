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
 * An UNREADABLE proc root THROWS (codex r2): an empty result must always mean "scanned and found
 * nothing" — silently returning [] there would let the sweep false-confirm with zero scanning.
 */
export function findPidsByUserDataDir(dir: string, procRoot = "/proc"): number[] {
  const marker = `--user-data-dir=${dir}`;
  const out: number[] = [];
  const names = readdirSync(procRoot); // throws on an unreadable root — the sweep maps it to "unsupported"
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
  // Codex r2: a Linux host whose proc root is absent/unreadable (a misconfigured mount) must report
  // UNSUPPORTED — never "confirmed" off a scan that scanned nothing. One up-front probe; /proc does not
  // vanish mid-process, and a per-pid read failure inside the scan still means "that pid exited".
  try {
    readdirSync(procRoot);
  } catch {
    return "unsupported";
  }

  const marker = `--user-data-dir=${dir}`;
  const carriesMarker = (pid: number): boolean => {
    try {
      return readFileSync(join(procRoot, String(pid), "cmdline"), "utf8").split("\0").includes(marker);
    } catch {
      return false; // exited — no marker, nothing to signal
    }
  };

  /**
   * Generation-stamped kill of every current match; returns the stamps `{pid → {startTime, pgrp}}` the
   * group-confirm below polls. TOCTOU discipline (codex #54P2 r1): between the scan and the stat read a
   * matched pid can EXIT AND BE RECYCLED by an unrelated process (real under pids_limit=512) — signaling
   * the recycled pid's group would kill innocents. So per pid: read the stat (generation stamp), then
   * RE-READ the cmdline — only OUR launch's processes ever carry the mkdtemp-unique marker, so a marker
   * still present after the stat read proves the pid (and therefore the stamped pgrp) is ours at this
   * instant. A pid whose stat is unreadable or whose marker vanished is SKIPPED, never raw-signaled (the
   * confirm rescan re-decides). Residual: an exit-and-recycle in the microseconds between the re-read and
   * the SIGKILL is irreducible from userspace (no pidfd in Node; #50 avoids it only by holding the
   * launch-captured ChildProcess, which a never-resolved launch cannot provide) — documented, not fixable
   * at this layer.
   */
  const killMatches = (): Map<number, { startTime: string; pgrp: number }> => {
    const stamped = new Map<number, { startTime: string; pgrp: number }>();
    for (const pid of findPidsByUserDataDir(dir, procRoot)) {
      const stat = readProcStat(pid, procRoot);
      if (!stat) continue; // exited since the scan — never signal an unverifiable pid
      if (!carriesMarker(pid)) continue; // recycled between scan and stat — NOT ours; never signal
      stamped.set(pid, { startTime: stat.startTime, pgrp: stat.pgrp });
      try {
        // Group-SIGKILL (the #50 discipline): renderers/crashpad live in the leader's group without
        // carrying --user-data-dir themselves. ESRCH = already gone — success-shaped, swallowed.
        kill(-stat.pgrp, "SIGKILL");
      } catch {
        // ESRCH/EPERM: gone, or not ours to signal — either way the confirm pass below decides
      }
    }
    return stamped;
  };

  /**
   * A stamp's WHOLE GROUP is gone — the #50 `#ourGroupGone` rule, per stamp (codex #54P2 r1: confirming
   * only the marker-carrying pids would false-confirm past a surviving argless renderer/crashpad in the
   * group). Group probe `kill(-pgrp, 0)`: ESRCH = truly empty; EPERM = a member we can't signal — not our
   * same-uid Chrome, so our tree is gone. Probe-alive is GONE only for a provably RECYCLED group: our
   * stamped pid WAS the group leader (pid === pgrp) and the pid now present at that slot is a leader with
   * a DIFFERENT start-time (issue #50 r5 — a freed pgid recycled as an unrelated group's leader must never
   * read as "our tree survives"). Anything else — leader alive, a lingering child, an unprovable recycle —
   * stays NOT gone, so the sweep reports `unconfirmed` rather than freeing capacity over a live process.
   */
  const groupGone = (pid: number, stamp: { startTime: string; pgrp: number }): boolean => {
    try {
      kill(-stamp.pgrp, 0);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return code === "ESRCH" || code === "EPERM";
    }
    if (pid === stamp.pgrp) {
      const stat = readProcStat(stamp.pgrp, procRoot);
      if (stat && stat.pgrp === stamp.pgrp && stat.startTime !== stamp.startTime) return true; // recycled group
    }
    return false;
  };

  let stamped = killMatches();
  if (stamped.size === 0) return "confirmed"; // nothing lives under this profile RIGHT NOW (see OrphanDirOps
  // note: the CALLER must treat an empty-scan confirm on a still-PENDING launch as provisional — the
  // launcher may spawn later; the manager's watch-list covers that window.)
  const deadline = now() + confirmMs;
  for (;;) {
    const allGone = [...stamped].every(([pid, stamp]) => groupGone(pid, stamp));
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
