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
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProcStat } from "../browser/index.js";

/** Outcome of one sweep attempt over a profile dir. */
export type SweepResult = "confirmed" | "unconfirmed" | "unsupported";

/** One stamped PROCESS GROUP from a sweep attempt — keyed per group, ONE stamp each (codex r4: a
 *  per-matching-pid ledger let a non-leader entry, whose recycle check can never fire, retain a
 *  reclaimed group forever once its pgid was reused). `pid` is the stamped representative — the group
 *  LEADER whenever its stat was readable (then `pid === pgrp` and `startTime` is the group's generation,
 *  so a recycled pgid is provable); a leaderless group keeps a member representative (recycle stays
 *  unprovable — documented residual, same shape as #50's). OPAQUE to the manager — it only round-trips
 *  these into the next attempt (codex r3): the stamps are what let a retry keep blocking on a surviving
 *  ARGLESS group member after the marker-carrying leader died. */
export interface SweepStamp {
  pid: number;
  startTime: string;
  pgrp: number;
}

/** A sweep attempt's result plus the stamps the NEXT attempt must keep confirming against. */
export interface SweepOutcome {
  result: SweepResult;
  /** Present on "unconfirmed": every group still owed a confirm (prior ∪ this attempt's matches). */
  stamps?: SweepStamp[];
}

/** Injection surface for the sweep's OS interactions, so every branch is unit-testable. */
export interface SweepEnv {
  procRoot?: string;
  platform?: NodeJS.Platform;
  /** SIGKILL/probe sender; defaults to `process.kill`. Receives negative pids for group signals. */
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  /** Poll sleep; injectable so tests don't wait wall-clock. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** The sweeping process's own pid, excluded from the dir-reference discovery scan. Injectable. */
  selfPid?: number;
}

const SWEEP_POLL_MS = 100;

/**
 * Pids whose `/proc/<pid>/cmdline` carries the EXACT `--user-data-dir=<dir>` argument (NUL-separated
 * exact-arg match — never a substring, so a dir that happens to prefix another can't over-match; the
 * mkdtemp'd dir is unique per launch regardless). A pid that exits mid-scan is skipped, never an error.
 * An UNREADABLE proc root THROWS (codex r2): an empty result must always mean "scanned and found
 * nothing" — silently returning [] there would let the sweep false-confirm with zero scanning.
 */
/** Errno triage for a per-pid proc read (codex r9): ENOENT/ESRCH = the process GENUINELY vanished
 *  (skip it); EACCES = not ours to inspect (another uid / hidepid — ours are same-uid readable, so
 *  skip); anything else (EMFILE/ENFILE fd exhaustion IN THE GATEWAY, EIO…) is OUR failure to scan —
 *  treating it as "exited" would let a resource-exhausted sweep false-confirm over a live Chrome, so
 *  it PROPAGATES (the sweep rejects; the manager retries with the orphan retained). */
function vanishedOrForeign(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ESRCH" || code === "EACCES";
}

export function findPidsByUserDataDir(dir: string, procRoot = "/proc"): number[] {
  const marker = `--user-data-dir=${dir}`;
  const out: number[] = [];
  const names = readdirSync(procRoot); // throws on an unreadable root — the sweep maps it to "unsupported"
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const cmdline = readFileSync(join(procRoot, name, "cmdline"), "utf8");
      if (cmdline.split("\0").includes(marker)) out.push(Number(name));
    } catch (err) {
      if (!vanishedOrForeign(err)) throw err; // codex r9: fail closed on a scan-side failure
      // raced exit / foreign pid — skip
    }
  }
  return out;
}

/**
 * Kill-and-confirm every process launched under `dir` (see the module doc for the mechanism), bounded
 * by `confirmMs`. Returns an outcome whose `result` is:
 *  - `"confirmed"` — no process carries the dir on its cmdline AND every owed group (this attempt's
 *    matches ∪ `priorStamps` from earlier attempts, codex r3) is gone or provably recycled. Includes
 *    the trivial case (nothing ever matched and nothing was owed).
 *  - `"unconfirmed"` — something still lives at the deadline (e.g. a D-state unkillable); the caller
 *    keeps the orphan COUNTED, holds the returned `stamps`, and retries with them on its next tick
 *    (the #50 never-lie posture — the stamps stop a marker-less survivor from false-confirming later).
 *  - `"unsupported"` — not Linux / no readable proc tree; the caller degrades loudly.
 */
export async function sweepOrphanProcesses(
  dir: string,
  confirmMs: number,
  env: SweepEnv = {},
  priorStamps: SweepStamp[] = [],
): Promise<SweepOutcome> {
  const platform = env.platform ?? process.platform;
  if (platform !== "linux") return { result: "unsupported" };
  const procRoot = env.procRoot ?? "/proc";
  const kill = env.kill ?? ((pid: number, sig: NodeJS.Signals | 0) => process.kill(pid, sig));
  const sleep = env.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = env.now ?? (() => Date.now());
  // Codex r2: a Linux host whose proc root is absent/unreadable (a misconfigured mount) must report
  // UNSUPPORTED — never "confirmed" off a scan that scanned nothing. One up-front probe. Codex r10:
  // triage the failure — only a GENUINELY-absent root (ENOENT/ENOTDIR: no proc mount) degrades to
  // unsupported (which UNCOUNTS the orphan); a transient resource failure (EMFILE/ENFILE/EIO) REJECTS,
  // so the manager keeps the orphan counted and retries instead of dropping it over fd pressure.
  try {
    readdirSync(procRoot);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { result: "unsupported" };
    throw err;
  }

  const marker = `--user-data-dir=${dir}`;
  const selfPid = env.selfPid ?? process.pid;
  const carriesMarker = (pid: number): boolean => {
    try {
      return readFileSync(join(procRoot, String(pid), "cmdline"), "utf8").split("\0").includes(marker);
    } catch (err) {
      if (!vanishedOrForeign(err)) throw err; // codex r9: our own scan failure must not read as "exited"
      return false; // exited/foreign — no marker, nothing to signal
    }
  };

  /**
   * Whether `pid` holds a live REFERENCE into the profile dir — its cwd or any open fd resolves under
   * it (codex r5 P1): the discovery key for an ARGLESS survivor whose marker-carrying parent already
   * died before the first scan (crashpad holding the crash db, any profile-fd holder). Only our
   * launch's processes can reference the mkdtemp-unique dir, so a match is ours by construction; the
   * sweeping gateway process itself is excluded. Sandboxed renderers hold no profile references — a
   * parentless surviving renderer stays a DOCUMENTED residual (pure anonymous memory, no dir handle to
   * find it by; the container's pids_limit/namespace teardown is the backstop).
   */
  const dirPrefix = dir.endsWith("/") ? dir : `${dir}/`;
  const holdsDirRef = (pid: number): boolean => {
    const base = join(procRoot, String(pid));
    const refs = (target: string): boolean => target === dir || target.startsWith(dirPrefix);
    // Codex r9 errno triage throughout: EACCES here is ROUTINE (another uid's cwd/fd table — cannot be
    // our same-uid Chrome) and ENOENT is a raced exit — both skip; a gateway-side failure (EMFILE…)
    // propagates so a resource-exhausted scan can't false-confirm.
    try {
      if (refs(readlinkSync(join(base, "cwd")))) return true;
    } catch (err) {
      if (!vanishedOrForeign(err) && (err as NodeJS.ErrnoException).code !== "EINVAL") throw err;
      /* no cwd link readable — fall through to fds */
    }
    try {
      for (const fd of readdirSync(join(base, "fd"))) {
        try {
          if (refs(readlinkSync(join(base, "fd", fd)))) return true;
        } catch (err) {
          if (!vanishedOrForeign(err) && (err as NodeJS.ErrnoException).code !== "EINVAL") throw err;
          /* fd closed mid-scan */
        }
      }
    } catch (err) {
      if (!vanishedOrForeign(err)) throw err;
      /* no fd table readable (foreign/exited) */
    }
    return false;
  };

  const belongsToLaunch = (pid: number): boolean => carriesMarker(pid) || holdsDirRef(pid);

  /** Every live pid provably belonging to this launch: the cmdline-marker matches PLUS dir-reference
   *  holders (codex r5 P1). Bounded by the container's pid space; the fd scan runs only while a sweep
   *  is active (an orphan exists), never on the hot path. */
  const findLaunchPids = (): number[] => {
    const out = new Set<number>(findPidsByUserDataDir(dir, procRoot));
    for (const name of readdirSync(procRoot)) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      if (pid === selfPid || out.has(pid)) continue;
      if (holdsDirRef(pid)) out.add(pid);
    }
    return [...out];
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
  /** Errno-aware stat for the phase-1a EXISTENCE decision (codex r10): a transiently-unreadable stat
   *  (EMFILE/EIO in the gateway) must not read as "exited" — when it is the only match, that skip would
   *  leave `stamped` empty and false-confirm. Vanish/foreign → undefined; gateway-side → throw. The
   *  confirm-side reads (leader upgrade, revalidation, recycle check) stay LENIENT — a failure there
   *  skips a signal or keeps a group owed, both fail-safe. */
  const statOf = (pid: number): { pgrp: number; startTime: string } | undefined => {
    const stat = readProcStat(pid, procRoot);
    if (stat) return stat;
    try {
      readFileSync(join(procRoot, String(pid), "stat"), "utf8");
    } catch (err) {
      if (!vanishedOrForeign(err)) throw err;
      return undefined; // genuinely gone / not ours to read
    }
    return undefined; // readable but unparseable — a malformed entry, not our Chrome
  };

  const mergeStamp = (into: Map<number, { pid: number; startTime: string }>, pgrp: number, rep: { pid: number; startTime: string }): void => {
    const existing = into.get(pgrp);
    if (existing === undefined || rep.pid === pgrp) into.set(pgrp, rep);
  };

  const killMatches = (into: Map<number, { pid: number; startTime: string }>): number => {
    // Keyed by PROCESS GROUP, one stamp each (codex r4) — see {@link SweepStamp}. TWO PHASES (codex r5
    // P2): observe-and-stamp EVERYTHING — including the leader-generation upgrade — BEFORE the first
    // signal. Upgrading after the kill races it: a wrapper-shaped group (only a non-leader carries the
    // marker) whose leader dies first would retain a non-leader stamp, and a later pgid reuse could then
    // never be proven (permanently pinned capacity for an already-gone tree). Codex r10: every
    // observation merges into the caller's DURABLE ledger `into` IMMEDIATELY, so a scan failure later in
    // the same pass (EMFILE mid-scan) cannot lose a group that was already observed — and possibly
    // already signaled; the caller converts the throw into `unconfirmed` + the accumulated stamps.
    // Returns the number of groups DISCOVERABLE this pass (known or new — the confirm gate needs
    // "nothing is discoverable right now", not "nothing new").
    const observed = new Map<number, { pid: number; startTime: string }>();
    // Phase 1a — stamp every launch-owned pid (marker + dir-reference discovery), leader-preferred.
    for (const pid of findLaunchPids()) {
      const stat = statOf(pid);
      if (!stat) continue; // genuinely exited/foreign — never signal an unverifiable pid
      if (!belongsToLaunch(pid)) continue; // recycled between scan and stat — NOT ours; never signal
      mergeStamp(observed, stat.pgrp, { pid, startTime: stat.startTime });
      mergeStamp(into, stat.pgrp, observed.get(stat.pgrp) as { pid: number; startTime: string });
    }
    // Phase 1b — upgrade any non-leader representative to the group leader's own generation when
    // readable (the leader need not carry the marker; its stat is the group's identity). Pre-signal, so
    // the read cannot race our own kill. Codex r12: adopt the leader ONLY while the ORIGINAL member
    // still exists with its stamped generation and group — the member's whole group can exit and have
    // its pgid reused between phase 1a and this read (the OS is concurrent even across two synchronous
    // reads), and adopting the UNRELATED new leader would pass phase-2 revalidation and SIGKILL
    // innocents. A member that vanished keeps its member stamp, whose phase-2 revalidation then
    // fail-safes (skip); a group that dies+recycles AFTER adoption is caught by phase 2's generation
    // compare against the adopted (old-leader) stamp.
    for (const [pgrp, rep] of observed) {
      if (rep.pid === pgrp) continue;
      const leader = readProcStat(pgrp, procRoot);
      if (!leader || leader.pgrp !== pgrp) continue;
      const member = readProcStat(rep.pid, procRoot);
      if (!member || member.startTime !== rep.startTime || member.pgrp !== pgrp) continue;
      const up = { pid: pgrp, startTime: leader.startTime };
      observed.set(pgrp, up);
      mergeStamp(into, pgrp, up);
    }
    // Phase 2 — one group-SIGKILL per group observed THIS PASS (the #50 discipline: renderers/crashpad
    // live in the leader's group without carrying the marker themselves). Codex r6: REVALIDATE each
    // group's representative immediately before its signal — the two-phase split widened the
    // stamp→signal window (it now spans the whole scan), and under the small pid space a stamped group
    // can exit and have its pgid reused inside it. A representative that vanished or changed generation
    // ⇒ skip the signal (the confirm loop re-decides; a still-live group re-matches on the next rescan).
    // This narrows the race back to the irreducible microsecond TOCTOU documented on phase 1. ESRCH =
    // already gone — swallowed.
    for (const [pgrp, rep] of observed) {
      const s = readProcStat(rep.pid, procRoot);
      if (!s || s.startTime !== rep.startTime || s.pgrp !== pgrp) continue; // not provably ours anymore
      try {
        kill(-pgrp, "SIGKILL");
      } catch {
        // ESRCH/EPERM: gone, or not ours to signal — either way the confirm pass below decides
      }
    }
    return observed.size;
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
  const groupGone = (pgrp: number, rep: { pid: number; startTime: string }): boolean => {
    try {
      kill(-pgrp, 0);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return code === "ESRCH" || code === "EPERM";
    }
    if (rep.pid === pgrp) {
      const stat = readProcStat(pgrp, procRoot);
      if (stat && stat.pgrp === pgrp && stat.startTime !== rep.startTime) return true; // recycled group
    }
    return false;
  };

  // Codex r3: seed from the PRIOR attempt's stamps (keyed per group, leader-preferred — codex r4). After
  // a first attempt kills the marker-carrying leader but a surviving ARGLESS group member forces
  // "unconfirmed", a fresh scan alone would find no marker and false-confirm over that live member — the
  // stamped groups are the memory that keeps every owed group blocking the confirm across attempts. A
  // prior group that is now gone (or provably recycled) simply confirms.
  const stamped = new Map<number, { pid: number; startTime: string }>();
  for (const s of priorStamps) {
    const existing = stamped.get(s.pgrp);
    if (existing === undefined || s.pid === s.pgrp) stamped.set(s.pgrp, { pid: s.pid, startTime: s.startTime });
  }
  const owedStamps = (): SweepStamp[] => [...stamped].map(([pgrp, rep]) => ({ pid: rep.pid, startTime: rep.startTime, pgrp }));
  try {
    killMatches(stamped);
  } catch (err) {
    // Codex r10: a scan failure after groups were observed (and possibly signaled) must not lose them —
    // return them as OWED so the retry keeps confirming. With nothing owed at all, reject plainly (the
    // manager's error arm retries with nothing lost).
    if (stamped.size === 0) throw err;
    return { result: "unconfirmed", stamps: owedStamps() };
  }
  if (stamped.size === 0) return { result: "confirmed" }; // nothing lives under this profile RIGHT NOW (see
  // OrphanDirOps note: the CALLER must treat an empty-scan confirm on a still-PENDING launch as
  // provisional — the launcher may spawn later; the manager's watch-list covers that window.)
  // Codex r9: RE-SIGNAL owed groups once per attempt — killMatches signals only DISCOVERABLE (marker/
  // ref-carrying) pids, so a group whose carriers all died while an argless member survives would be
  // probed forever but never re-SIGKILLed (a permanent pin). Safety mirrors the #50 reconfirm: only a
  // LEADER-stamped group (rep.pid === pgrp) is re-signaled, and only while groupGone() is false — a pgid
  // cannot be recycled while any member lives, and a provably-recycled leader already reads as gone. A
  // non-leader-stamped owed group stays probe-only (ownership unprovable — documented residual).
  for (const [pgrp, rep] of stamped) {
    if (rep.pid !== pgrp || groupGone(pgrp, rep)) continue;
    try {
      kill(-pgrp, "SIGKILL");
    } catch {
      // ESRCH/EPERM — the confirm loop decides
    }
  }
  const deadline = now() + confirmMs;
  for (;;) {
    // Codex r8: rescan-and-merge on EVERY poll — not only once the owed groups are gone. While an owed
    // group still blocks, the pending launcher can fork a NEW group whose marker/ref-carrying members
    // exit before the owed group clears; deferring the rescan until allGone would let that group escape
    // stamping entirely and a later attempt confirm over its argless survivor. A per-poll rescan stamps
    // (and kills) every group at its earliest observable moment. Bounded: one scan per poll for at most
    // confirmMs, only while a sweep is active.
    let discoverable: number;
    try {
      discoverable = killMatches(stamped);
    } catch {
      // Codex r10: a rescan failure mid-confirm keeps every accumulated stamp OWED (an already-killed
      // carrier group must not vanish from the ledger because a later scan hit fd pressure).
      return { result: "unconfirmed", stamps: owedStamps() };
    }
    const allGone = [...stamped].every(([pgrp, rep]) => groupGone(pgrp, rep));
    if (allGone && discoverable === 0) return { result: "confirmed" };
    if (now() >= deadline) return { result: "unconfirmed", stamps: owedStamps() };
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
 * `sweep` takes the PRIOR attempt's `stamps` (codex r3) and the manager round-trips the returned ones —
 * the cross-attempt memory that keeps a surviving argless group member blocking the confirm after the
 * marker-carrying leader died.
 */
export interface OrphanDirOps {
  make(): Promise<string>;
  sweep(dir: string, confirmMs: number, priorStamps?: SweepStamp[]): Promise<SweepOutcome>;
  remove(dir: string): Promise<void>;
}

export const defaultOrphanDirOps: OrphanDirOps = {
  make: () => mkdtemp(join(tmpdir(), "bgw-profile-")),
  sweep: (dir, confirmMs, priorStamps) => sweepOrphanProcesses(dir, confirmMs, {}, priorStamps ?? []),
  remove: (dir) => rm(dir, { recursive: true, force: true }),
};
