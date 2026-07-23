/**
 * Issue #54 Part 2 — orphan sweep unit tests. The scan/parse/confirm logic runs against a FAKE proc
 * tree on disk (injectable procRoot) with an injected `kill`, so every branch — exact-arg matching,
 * group-kill targeting, the start-time generation discipline, mid-sweep forks, the unconfirmed
 * deadline — is exercised with zero real processes. The kill path's real-physics proof is the
 * in-container `scripts/validate-teardown.mjs` sweep leg.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findPidsByUserDataDir, sweepOrphanProcesses } from "../dist/gateway/orphan-sweep.js";

/** Write a fake /proc/<pid> entry: NUL-separated cmdline + a stat line readProcStat can parse
 *  (fields after the comm's closing paren: [state, ppid, pgrp, …, starttime@19]). */
function writeProc(root, pid, { args = [], pgrp = pid, startTime = "1000" } = {}) {
  const dir = join(root, String(pid));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cmdline"), args.join("\0") + "\0");
  const after = ["S", "1", String(pgrp), "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "1", "0", startTime, "0"];
  writeFileSync(join(dir, "stat"), `${pid} (chrome) ${after.join(" ")}`);
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
  assert.equal(r, "confirmed");
  assert.deepEqual(kills, []);
  rmSync(root, { recursive: true, force: true });
});

test("sweep: non-Linux platform → unsupported (never scans or kills)", async () => {
  const kills = [];
  const r = await sweepOrphanProcesses("/tmp/bgw-x", 1_000, {
    platform: "darwin",
    kill: (pid, sig) => kills.push([pid, sig]),
  });
  assert.equal(r, "unsupported");
  assert.deepEqual(kills, []);
});

test("sweep: group-SIGKILLs the match's process group and confirms once the entries vanish", async () => {
  const root = makeProcRoot();
  const dir = "/tmp/bgw-wedge";
  writeProc(root, 200, { args: ["chrome", `--user-data-dir=${dir}`], pgrp: 200 });
  writeProc(root, 201, { args: ["chrome", "--type=renderer"], pgrp: 200 }); // group member w/o the arg
  const kills = [];
  const kill = (pid, sig) => {
    kills.push([pid, sig]);
    if (pid === -200) {
      // group-SIGKILL reaps the whole group, arg-carrying or not
      rmSync(join(root, "200"), { recursive: true, force: true });
      rmSync(join(root, "201"), { recursive: true, force: true });
    }
  };
  const r = await sweepOrphanProcesses(dir, 1_000, { platform: "linux", procRoot: root, kill, ...fakeClock() });
  assert.equal(r, "confirmed");
  assert.deepEqual(kills, [[-200, "SIGKILL"]], "one group-SIGKILL at the leader's pgid, renderers rode along");
  rmSync(root, { recursive: true, force: true });
});

test("sweep: a RECYCLED pid (same number, new start-time) counts as gone — the #50 generation discipline", async () => {
  const root = makeProcRoot();
  const dir = "/tmp/bgw-recycled";
  writeProc(root, 300, { args: ["chrome", `--user-data-dir=${dir}`], pgrp: 300, startTime: "1000" });
  const kill = (pid) => {
    if (pid === -300) {
      // the SIGKILL lands, and an UNRELATED process immediately reuses pid 300 (small pid space)
      rmSync(join(root, "300"), { recursive: true, force: true });
      writeProc(root, 300, { args: ["sshd"], pgrp: 300, startTime: "9999" });
    }
  };
  const r = await sweepOrphanProcesses(dir, 1_000, { platform: "linux", procRoot: root, kill, ...fakeClock() });
  assert.equal(r, "confirmed", "the recycled pid's changed start-time proves OUR process is gone");
  rmSync(root, { recursive: true, force: true });
});

test("sweep: a process forked under the profile MID-SWEEP is killed too before confirming", async () => {
  const root = makeProcRoot();
  const dir = "/tmp/bgw-fork";
  writeProc(root, 400, { args: ["chrome", `--user-data-dir=${dir}`], pgrp: 400 });
  const kills = [];
  const kill = (pid, sig) => {
    kills.push([pid, sig]);
    if (pid === -400) {
      rmSync(join(root, "400"), { recursive: true, force: true });
      // …but the wedged launcher had already forked a second chrome under the SAME profile
      writeProc(root, 500, { args: ["chrome", `--user-data-dir=${dir}`], pgrp: 500 });
    }
    if (pid === -500) rmSync(join(root, "500"), { recursive: true, force: true });
  };
  const r = await sweepOrphanProcesses(dir, 1_000, { platform: "linux", procRoot: root, kill, ...fakeClock() });
  assert.equal(r, "confirmed");
  assert.deepEqual(kills, [[-400, "SIGKILL"], [-500, "SIGKILL"]], "the rescan caught and killed the fork");
  rmSync(root, { recursive: true, force: true });
});

test("sweep: a survivor at the deadline → unconfirmed (never a false confirm)", async () => {
  const root = makeProcRoot();
  const dir = "/tmp/bgw-dstate";
  writeProc(root, 600, { args: ["chrome", `--user-data-dir=${dir}`], pgrp: 600 });
  const kills = [];
  // The SIGKILL is sent but the process never dies (D-state unkillable) — entries stay put.
  const r = await sweepOrphanProcesses(dir, 500, {
    platform: "linux",
    procRoot: root,
    kill: (pid, sig) => kills.push([pid, sig]),
    ...fakeClock(),
  });
  assert.equal(r, "unconfirmed");
  assert.equal(kills.length >= 1, true, "the kill was attempted");
  rmSync(root, { recursive: true, force: true });
});