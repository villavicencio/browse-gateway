/**
 * Issue #54 Part 2 — orphan sweep unit tests. The scan/parse/confirm logic runs against a FAKE proc
 * tree on disk (injectable procRoot) with an injected `kill`, so every branch — exact-arg matching,
 * group-kill targeting, the start-time generation discipline, mid-sweep forks, the unconfirmed
 * deadline — is exercised with zero real processes. The kill path's real-physics proof is the
 * in-container `scripts/validate-teardown.mjs` sweep leg.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findPidsByUserDataDir, sweepOrphanProcesses } from "../dist/gateway/orphan-sweep.js";

/** Write a fake /proc/<pid> entry: NUL-separated cmdline + a stat line readProcStat can parse
 *  (fields after the comm's closing paren: [state, ppid, pgrp, …, starttime@19]). `fdRefs` become
 *  fd/N symlinks (open-file targets) and `cwd` a cwd symlink — the r5 dir-reference discovery keys. */
function writeProc(root, pid, { args = [], pgrp = pid, startTime = "1000", fdRefs = [], cwd } = {}) {
  const dir = join(root, String(pid));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cmdline"), args.join("\0") + "\0");
  const after = ["S", "1", String(pgrp), "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "1", "0", startTime, "0"];
  writeFileSync(join(dir, "stat"), `${pid} (chrome) ${after.join(" ")}`);
  if (fdRefs.length > 0) {
    mkdirSync(join(dir, "fd"), { recursive: true });
    fdRefs.forEach((target, i) => symlinkSync(target, join(dir, "fd", String(i + 3))));
  }
  if (cwd) symlinkSync(cwd, join(dir, "cwd"));
}

function makeProcRoot() {
  const root = mkdtempSync(join(tmpdir(), "fake-proc-"));
  return root;
}

/** Deterministic clock: `sleep` advances fake time, `now` reads it — no wall-clock waits. */
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

/** True while any fake-proc entry sits in process group `pgid`. */
function groupAlive(root, pgid) {
  for (const name of readdirSync(root)) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(join(root, name, "stat"), "utf8");
      const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(after[2]) === pgid) return true;
    } catch {
      /* raced */
    }
  }
  return false;
}

/**
 * A probe-aware fake `kill` over the fake proc tree: signal 0 on a negative pid implements the REAL
 * group-liveness semantics (throws ESRCH once no entry sits in the group — what the sweep's
 * group-confirm polls), while SIGKILLs are recorded and delegated to `impl` (which mutates the tree).
 */
function makeKillFake(root, impl) {
  const kills = [];
  const kill = (pid, sig) => {
    if (sig === 0) {
      if (!groupAlive(root, -pid)) {
        const e = new Error("no such process group");
        e.code = "ESRCH";
        throw e;
      }
      return;
    }
    kills.push([pid, sig]);
    impl?.(pid, sig);
  };
  return { kill, kills };
}

test("findPidsByUserDataDir: exact NUL-separated arg match only (no substring/prefix over-match)", () => {
  const root = makeProcRoot();
  writeProc(root, 100, { args: ["/opt/chrome", "--user-data-dir=/tmp/bgw-a", "--type=zygote"] });
  writeProc(root, 101, { args: ["/opt/chrome", "--user-data-dir=/tmp/bgw-a-longer"] }); // prefix — must NOT match
  writeProc(root, 102, { args: ["/opt/chrome", "--flag=--user-data-dir=/tmp/bgw-a"] }); // embedded — must NOT match
  writeProc(root, 103, { args: ["grep", "--user-data-dir=/tmp/bgw-a"] }); // exact arg on another binary — matches (dir is unique per launch)
  mkdirSync(join(root, "not-a-pid"), { recursive: true }); // non-numeric entries skipped
  assert.deepEqual(findPidsByUserDataDir("/tmp/bgw-a", root).sort(), [100, 103]);
  assert.deepEqual(findPidsByUserDataDir("/tmp/bgw-none", root), []);
  rmSync(root, { recursive: true, force: true });
});

test("sweep: nothing under the dir → confirmed immediately (no kills)", async () => {
  const root = makeProcRoot();
  const kills = [];
  const r = await sweepOrphanProcesses("/tmp/bgw-x", 1_000, {
    platform: "linux",
    procRoot: root,
    kill: (pid, sig) => kills.push([pid, sig]),
    ...fakeClock(),
  });
  assert.equal(r.result, "confirmed");
  assert.deepEqual(kills, []);
  rmSync(root, { recursive: true, force: true });
});

test("sweep: an UNREADABLE proc root on Linux → unsupported, never a false confirm (codex r2)", async () => {
  const r = await sweepOrphanProcesses("/tmp/bgw-x", 500, {
    platform: "linux",
    procRoot: "/nonexistent-proc-root-for-test",
    ...fakeClock(),
  });
  assert.equal(r.result, "unsupported", "no scan happened, so nothing was 'confirmed'");
  assert.throws(
    () => findPidsByUserDataDir("/tmp/bgw-x", "/nonexistent-proc-root-for-test"),
    "an unreadable root throws — an empty result always means 'scanned and found nothing'",
  );
});

test("sweep: non-Linux platform → unsupported (never scans or kills)", async () => {
  const kills = [];
  const r = await sweepOrphanProcesses("/tmp/bgw-x", 1_000, {
    platform: "darwin",
    kill: (pid, sig) => kills.push([pid, sig]),
  });
  assert.equal(r.result, "unsupported");
  assert.deepEqual(kills, []);
});

test("sweep: group-SIGKILLs the match's process group and confirms once the WHOLE group is gone", async () => {
  const root = makeProcRoot();
  const dir = "/tmp/bgw-wedge";
  writeProc(root, 200, { args: ["chrome", `--user-data-dir=${dir}`], pgrp: 200 });
  writeProc(root, 201, { args: ["chrome", "--type=renderer"], pgrp: 200 }); // group member w/o the arg
  const { kill, kills } = makeKillFake(root, (pid) => {
    if (pid === -200) {
      // group-SIGKILL reaps the whole group, arg-carrying or not
      rmSync(join(root, "200"), { recursive: true, force: true });
      rmSync(join(root, "201"), { recursive: true, force: true });
    }
  });
  const r = await sweepOrphanProcesses(dir, 1_000, { platform: "linux", procRoot: root, kill, ...fakeClock() });
  assert.equal(r.result, "confirmed");
  assert.deepEqual(kills, [[-200, "SIGKILL"]], "one group-SIGKILL at the leader's pgid, renderers rode along");
  rmSync(root, { recursive: true, force: true });
});

test("sweep: a surviving ARGLESS group member (D-state renderer) blocks the confirm — unconfirmed, never false-freed (codex r1)", async () => {
  const root = makeProcRoot();
  const dir = "/tmp/bgw-renderer-survives";
  writeProc(root, 210, { args: ["chrome", `--user-data-dir=${dir}`], pgrp: 210 });
  writeProc(root, 211, { args: ["chrome", "--type=renderer"], pgrp: 210 }); // no marker — invisible to the rescan
  const { kill } = makeKillFake(root, (pid) => {
    if (pid === -210) rmSync(join(root, "210"), { recursive: true, force: true }); // ONLY the leader dies
  });
  const r = await sweepOrphanProcesses(dir, 500, { platform: "linux", procRoot: root, kill, ...fakeClock() });
  assert.equal(r.result, "unconfirmed", "the group probe sees the lingering renderer — capacity is not freed over it");
  rmSync(root, { recursive: true, force: true });
});

test("sweep: prior stamps keep a marker-less survivor blocking the confirm ACROSS attempts (codex r3)", async () => {
  const root = makeProcRoot();
  const dir = "/tmp/bgw-cross-attempt";
  writeProc(root, 230, { args: ["chrome", `--user-data-dir=${dir}`], pgrp: 230 });
  writeProc(root, 231, { args: ["chrome", "--type=renderer"], pgrp: 230 }); // argless, same group
  const { kill } = makeKillFake(root, (pid) => {
    if (pid === -230) rmSync(join(root, "230"), { recursive: true, force: true }); // only the leader dies
  });
  const env = { platform: "linux", procRoot: root, kill, ...fakeClock() };

  // Attempt 1: leader killed, renderer survives → unconfirmed WITH the owed group stamps.
  const a1 = await sweepOrphanProcesses(dir, 500, env);
  assert.equal(a1.result, "unconfirmed");
  assert.equal(a1.stamps?.length, 1, "the owed group is stamped for the next attempt");

  // Attempt 2 (a fresh sweep, no marker anywhere): WITHOUT prior stamps this would false-confirm over
  // the live renderer; WITH them the owed group keeps blocking.
  const a2 = await sweepOrphanProcesses(dir, 500, { platform: "linux", procRoot: root, kill, ...fakeClock() }, a1.stamps);
  assert.equal(a2.result, "unconfirmed", "the prior stamps block a false confirm over the argless survivor");

  // The renderer finally dies → attempt 3 with the carried stamps confirms.
  rmSync(join(root, "231"), { recursive: true, force: true });
  const a3 = await sweepOrphanProcesses(dir, 500, { platform: "linux", procRoot: root, kill, ...fakeClock() }, a2.stamps);
  assert.equal(a3.result, "confirmed");
  rmSync(root, { recursive: true, force: true });
});

test("sweep: stamps are deduped per GROUP (leader generation), so a recycled pgid frees the orphan on retry (codex r4)", async () => {
  const root = makeProcRoot();
  const dir = "/tmp/bgw-group-dedupe";
  // TWO marker-carrying pids in ONE group (leader 240 + a marker-carrying utility 241). A per-pid ledger
  // would keep a non-leader stamp whose recycle check can never fire.
  writeProc(root, 240, { args: ["chrome", `--user-data-dir=${dir}`], pgrp: 240, startTime: "1000" });
  writeProc(root, 241, { args: ["chrome", "--utility", `--user-data-dir=${dir}`], pgrp: 240, startTime: "1001" });
  const { kill } = makeKillFake(root); // SIGKILL does nothing — the tree survives attempt 1 (D-state)
  const a1 = await sweepOrphanProcesses(dir, 500, { platform: "linux", procRoot: root, kill, ...fakeClock() });
  assert.equal(a1.result, "unconfirmed");
  assert.equal(a1.stamps?.length, 1, "one stamp per GROUP, not per matching pid");
  assert.equal(a1.stamps?.[0].pid, a1.stamps?.[0].pgrp, "the group is stamped by its LEADER's generation");

  // Between attempts: the whole tree finally dies AND the pgid is recycled by an unrelated group.
  rmSync(join(root, "240"), { recursive: true, force: true });
  rmSync(join(root, "241"), { recursive: true, force: true });
  writeProc(root, 240, { args: ["sshd"], pgrp: 240, startTime: "9999" }); // recycled leader, new generation
  const a2 = await sweepOrphanProcesses(dir, 500, { platform: "linux", procRoot: root, kill, ...fakeClock() }, a1.stamps);
  assert.equal(a2.result, "confirmed", "the leader-generation stamp proves the recycle — capacity frees");
  rmSync(root, { recursive: true, force: true });
});

test("sweep: an ARGLESS survivor holding a profile fd is DISCOVERED after its marker-carrier died (codex r5)", async () => {
  const root = makeProcRoot();
  const dir = "/tmp/bgw-fd-survivor";
  // The marker-carrying leader already EXITED before the first sweep; only crashpad-shaped pid 260
  // survives — no marker on its cmdline, but it holds an open fd into the profile dir.
  writeProc(root, 260, { args: ["chrome_crashpad_handler", "--no-rate-limit"], pgrp: 260, fdRefs: [`${dir}/Crash Reports/pending.lock`] });
  const { kill, kills } = makeKillFake(root, (pid) => {
    if (pid === -260) rmSync(join(root, "260"), { recursive: true, force: true });
  });
  const r = await sweepOrphanProcesses(dir, 1_000, { platform: "linux", procRoot: root, kill, selfPid: 1, ...fakeClock() });
  assert.equal(r.result, "confirmed", "the dir-reference scan found and reaped the marker-less survivor");
  assert.deepEqual(kills, [[-260, "SIGKILL"]], "it was killed by its own group");
  rmSync(root, { recursive: true, force: true });
});

test("sweep: dir-prefix discipline — a ref to a SIBLING dir sharing the prefix is NOT ours (codex r5)", async () => {
  const root = makeProcRoot();
  const dir = "/tmp/bgw-prefix";
  writeProc(root, 265, { args: ["something-else"], pgrp: 265, fdRefs: ["/tmp/bgw-prefix-other/file"], cwd: "/tmp/bgw-prefixed" });
  const { kill, kills } = makeKillFake(root);
  const r = await sweepOrphanProcesses(dir, 500, { platform: "linux", procRoot: root, kill, selfPid: 1, ...fakeClock() });
  assert.equal(r.result, "confirmed", "nothing of ours found");
  assert.deepEqual(kills, [], "a sibling-prefix dir reference is never treated as ours");
  rmSync(root, { recursive: true, force: true });
});

test("sweep: the leader generation is captured BEFORE the kill, so a wrapper-shaped group frees after pgid reuse (codex r5)", async () => {
  const root = makeProcRoot();
  const dir = "/tmp/bgw-wrapper";
  // Wrapper shape: the group LEADER (270) carries no marker and no refs; only member 271 carries the
  // marker. The leader's generation must be stamped pre-kill — post-kill it may already be dead.
  writeProc(root, 270, { args: ["chrome-wrapper"], pgrp: 270, startTime: "1000" });
  writeProc(root, 271, { args: ["chrome", `--user-data-dir=${dir}`], pgrp: 270, startTime: "1001" });
  writeProc(root, 272, { args: ["chrome", "--type=renderer"], pgrp: 270, startTime: "1002" }); // invisible survivor
  const { kill } = makeKillFake(root, (pid) => {
    if (pid === -270) {
      rmSync(join(root, "270"), { recursive: true, force: true }); // leader dies
      rmSync(join(root, "271"), { recursive: true, force: true }); // marker-carrier dies
      // 272 survives (D-state) — attempt 1 must stay unconfirmed
    }
  });
  const a1 = await sweepOrphanProcesses(dir, 500, { platform: "linux", procRoot: root, kill, selfPid: 1, ...fakeClock() });
  assert.equal(a1.result, "unconfirmed");
  assert.equal(a1.stamps?.[0].pid, 270, "the stamp is the LEADER's, captured before the kill");
  assert.equal(a1.stamps?.[0].startTime, "1000");

  // Between attempts: the survivor dies and pgid 270 is recycled by an unrelated group.
  rmSync(join(root, "272"), { recursive: true, force: true });
  writeProc(root, 270, { args: ["sshd"], pgrp: 270, startTime: "9999" });
  const a2 = await sweepOrphanProcesses(dir, 500, { platform: "linux", procRoot: root, kill, selfPid: 1, ...fakeClock() }, a1.stamps);
  assert.equal(a2.result, "confirmed", "the pre-kill leader generation proves the recycle — capacity frees");
  rmSync(root, { recursive: true, force: true });
});

test("sweep: a group forked while an owed group still blocks is stamped+killed on the NEXT POLL, not deferred (codex r8)", async () => {
  const root = makeProcRoot();
  const dir = "/tmp/bgw-mid-fork";
  writeProc(root, 280, { args: ["chrome", `--user-data-dir=${dir}`], pgrp: 280 }); // unkillable — blocks throughout
  const { kill, kills } = makeKillFake(root, (pid) => {
    if (pid === -280 && kills.filter(([p]) => p === -280).length === 1) {
      // The wedged launcher forks a SECOND group right as the first kill lands. Its marker-carrier
      // would exit soon — only a per-poll rescan can stamp it while the marker is still visible.
      writeProc(root, 290, { args: ["chrome", `--user-data-dir=${dir}`], pgrp: 290 });
      writeProc(root, 291, { args: ["chrome", "--type=renderer"], pgrp: 290 });
    }
    if (pid === -290) {
      rmSync(join(root, "290"), { recursive: true, force: true });
      rmSync(join(root, "291"), { recursive: true, force: true });
    }
  });
  const r = await sweepOrphanProcesses(dir, 500, { platform: "linux", procRoot: root, kill, selfPid: 1, ...fakeClock() });
  assert.equal(r.result, "unconfirmed", "the unkillable original group still blocks");
  assert.equal(kills.some(([p]) => p === -290), true, "the mid-sweep fork was stamped and killed on a poll, not deferred until allGone");
  rmSync(root, { recursive: true, force: true });
});

test("sweep: a matched pid whose stat vanished (exited between scan and stat) is never signaled (codex r1)", async () => {
  const root = makeProcRoot();
  const dir = "/tmp/bgw-exited";
  // cmdline present but NO stat file — the process exited between readdir/cmdline and the stat read.
  const pdir = join(root, "220");
  mkdirSync(pdir, { recursive: true });
  writeFileSync(join(pdir, "cmdline"), ["chrome", `--user-data-dir=${dir}`].join("\0") + "\0");
  const { kill, kills } = makeKillFake(root);
  const r = await sweepOrphanProcesses(dir, 500, { platform: "linux", procRoot: root, kill, ...fakeClock() });
  assert.equal(r.result, "confirmed", "an unverifiable (exited) pid is skipped, not treated as alive");
  assert.deepEqual(kills, [], "no signal was ever sent on an unverifiable pid (recycle-safety)");
  rmSync(root, { recursive: true, force: true });
});

test("sweep: a RECYCLED pid (same number, new start-time) counts as gone — the #50 generation discipline", async () => {
  const root = makeProcRoot();
  const dir = "/tmp/bgw-recycled";
  writeProc(root, 300, { args: ["chrome", `--user-data-dir=${dir}`], pgrp: 300, startTime: "1000" });
  const { kill } = makeKillFake(root, (pid) => {
    if (pid === -300) {
      // the SIGKILL lands, and an UNRELATED process immediately reuses pid 300 (small pid space)
      rmSync(join(root, "300"), { recursive: true, force: true });
      writeProc(root, 300, { args: ["sshd"], pgrp: 300, startTime: "9999" });
    }
  });
  const r = await sweepOrphanProcesses(dir, 1_000, { platform: "linux", procRoot: root, kill, ...fakeClock() });
  assert.equal(r.result, "confirmed", "the recycled pid's changed start-time proves OUR process is gone");
  rmSync(root, { recursive: true, force: true });
});

test("sweep: a process forked under the profile MID-SWEEP is killed too before confirming", async () => {
  const root = makeProcRoot();
  const dir = "/tmp/bgw-fork";
  writeProc(root, 400, { args: ["chrome", `--user-data-dir=${dir}`], pgrp: 400 });
  const { kill, kills } = makeKillFake(root, (pid) => {
    if (pid === -400) {
      rmSync(join(root, "400"), { recursive: true, force: true });
      // …but the wedged launcher had already forked a second chrome under the SAME profile
      writeProc(root, 500, { args: ["chrome", `--user-data-dir=${dir}`], pgrp: 500 });
    }
    if (pid === -500) rmSync(join(root, "500"), { recursive: true, force: true });
  });
  const r = await sweepOrphanProcesses(dir, 1_000, { platform: "linux", procRoot: root, kill, ...fakeClock() });
  assert.equal(r.result, "confirmed");
  assert.deepEqual(kills, [[-400, "SIGKILL"], [-500, "SIGKILL"]], "the rescan caught and killed the fork");
  rmSync(root, { recursive: true, force: true });
});

test("sweep: a survivor at the deadline → unconfirmed (never a false confirm)", async () => {
  const root = makeProcRoot();
  const dir = "/tmp/bgw-dstate";
  writeProc(root, 600, { args: ["chrome", `--user-data-dir=${dir}`], pgrp: 600 });
  // The SIGKILL is sent but the process never dies (D-state unkillable) — entries stay put.
  const { kill, kills } = makeKillFake(root); // no impl: the tree never changes
  const r = await sweepOrphanProcesses(dir, 500, {
    platform: "linux",
    procRoot: root,
    kill,
    ...fakeClock(),
  });
  assert.equal(r.result, "unconfirmed");
  assert.equal(kills.length >= 1, true, "the kill was attempted");
  rmSync(root, { recursive: true, force: true });
});