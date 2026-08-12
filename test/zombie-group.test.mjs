/**
 * Issue #131 — a zombie process group must read as GONE.
 *
 * The defect: `kill(-pgid, 0)` succeeds on a group whose every member is a zombie, because a zombie
 * keeps its process-table entry until reaped. In a container whose PID 1 does not reap reparented
 * orphans, the group-empty confirmation therefore never confirmed, sessions were retained in
 * `#unconfirmed` forever, and the pool saturated at maxSessions with zero live browsers.
 *
 * This file covers the DECISION LOGIC only, against a fake proc tree (injectable `procRoot`), so every
 * branch runs with zero real processes.
 *
 * THE REAL-PHYSICS PROOF IS NOT HERE, DELIBERATELY. That a zombie answers signal 0 — the kernel fact
 * the old confirmation assumed away — needs a persistently-all-zombie group, which requires a PID 1
 * that does not reap. That cannot be manufactured reliably from a unit test: whether orphans are
 * reaped depends on what PID 1 happens to be, and under `node --test` that varies with how the suite
 * is invoked (a `sh -c` wrapper reaps via its own `wait`; a bare `node` does not). A physics check
 * that silently skips or races depending on invocation is worse than none — it reads green while
 * verifying nothing, which is exactly how this bug survived a green suite for days.
 *
 * So the physics lives in `scripts/validate-zombie-confirm.mjs`, run in-container WITHOUT an init
 * shim, which builds a real all-zombie group, demonstrates signal 0 lying about it, and FAILS LOUDLY
 * if it detects a reaping PID 1 rather than reporting a hollow pass. Same split as the orphan sweep,
 * whose kill path is proved by `scripts/validate-teardown.mjs` rather than by its unit tests.
 *
 * On its own, a fake /proc proves nothing about the kernel — see
 * docs/solutions/best-practices/a-test-whose-stub-guarantees-the-assertion-proves-nothing.md.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { groupIsAllZombies, readProcStat } from "../dist/browser/index.js";

/** Fake /proc/<pid>/stat. Fields after the comm's closing paren: [state, ppid, pgrp, …, starttime@19]. */
function writeProc(root, pid, { state = "S", pgrp = pid, startTime = "1000" } = {}) {
  const dir = join(root, String(pid));
  mkdirSync(dir, { recursive: true });
  // Real /proc/<pid>/stat carries ~52 fields, so starttime@19 is never the last one. Pad past it or the
  // fixture's trailing newline lands in the parsed value and the test measures the fixture, not the parse.
  const after = [state, "1", String(pgrp)];
  while (after.length < 24) after.push("0");
  after[19] = startTime;
  writeFileSync(join(dir, "stat"), `${pid} (chrome) ${after.join(" ")}\n`);
}

function fakeProc() {
  return mkdtempSync(join(tmpdir(), "bgw-zombie-proc-"));
}

// ── tier 1: decision logic ────────────────────────────────────────────────────────────────────────

test("a group whose every member is a zombie reads as gone", () => {
  const root = fakeProc();
  try {
    writeProc(root, 100, { state: "Z", pgrp: 100 });
    writeProc(root, 101, { state: "Z", pgrp: 100 });
    writeProc(root, 102, { state: "Z", pgrp: 100 });
    assert.equal(groupIsAllZombies(100, root), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ONE live member keeps the group alive — the conservative direction must not regress", () => {
  const root = fakeProc();
  try {
    writeProc(root, 100, { state: "Z", pgrp: 100 });
    writeProc(root, 101, { state: "Z", pgrp: 100 });
    writeProc(root, 102, { state: "S", pgrp: 100 }); // a real, sleeping renderer
    assert.equal(
      groupIsAllZombies(100, root),
      false,
      "a group with any living member must never be freed — that would double-book a live browser",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a group with no discoverable members says nothing (false), it does not claim gone", () => {
  const root = fakeProc();
  try {
    writeProc(root, 200, { state: "Z", pgrp: 200 }); // a DIFFERENT group
    assert.equal(
      groupIsAllZombies(100, root),
      false,
      "no members found is not evidence of zombies; the ESRCH path already owns the empty case",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("other groups' zombies are not counted", () => {
  const root = fakeProc();
  try {
    writeProc(root, 100, { state: "S", pgrp: 100 }); // ours: alive
    writeProc(root, 300, { state: "Z", pgrp: 300 }); // someone else's zombie
    writeProc(root, 301, { state: "Z", pgrp: 300 });
    assert.equal(groupIsAllZombies(100, root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable proc root reports false rather than guessing", () => {
  assert.equal(groupIsAllZombies(100, join(tmpdir(), "bgw-does-not-exist-zombie")), false);
});

test("readProcStat surfaces the process state alongside pgrp and generation", () => {
  const root = fakeProc();
  try {
    writeProc(root, 100, { state: "Z", pgrp: 42, startTime: "777" });
    const stat = readProcStat(100, root);
    assert.deepEqual(stat, { pgrp: 42, startTime: "777", state: "Z" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
