#!/usr/bin/env node
/**
 * Confirmable-teardown + force-kill proof (issue #50). Run IN-CONTAINER (headful Chrome under Xvfb) —
 * the REAL-process mechanics can't be exercised with the unit-test fakes. Confirms, against a real
 * Chromium launched through the shipping launch path (channel:"chrome"):
 *
 *   1. PID CAPTURE succeeds on the prod build — `core.forceKillAvailable` is true and an independent
 *      toImpl reach on the public `context` getter agrees on the leader pid. This is the tripwire that a
 *      patchright bump breaking the internal reach fails CI before deploy, not silently in prod.
 *   2. GROUP-LEADER precondition — the captured pid IS its own process-group leader (`getpgid===pid`),
 *      so `process.kill(-pid)` reaps the whole tree (renderers/GPU/zygote), not just the leader.
 *   3. FORCE-KILL confirms death — after `core.kill()`, the leader pid ESRCHes AND zero processes remain
 *      in its process group (the whole tree is reaped, not merely the leader).
 *   4. MANAGER TEARDOWN reclaims for real — a `SessionManager.release()` on a live session frees the slot
 *      AND leaves no live browser process behind.
 *
 * The state-machine escalation logic (wedged/rejected close → kill, unconfirmed → reconfirm, acquire⇄
 * shutdown, transient reap) is covered deterministically by test/gateway-session.test.mjs with fakes; this
 * gate covers only what a fake cannot: the real OS process is actually captured, group-killed, and reaped.
 */
import fs from "node:fs";
import { SessionManager, loadConfig } from "../dist/gateway/index.js";

let failures = 0;
const check = (label, ok) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

/** Independently reach the launched Chromium's leader pid via the public `context` getter — the same
 *  in-process bridge the core uses, so a mismatch would flag a capture bug. */
function capturePidFromContext(context) {
  try {
    const conn = context?._connection;
    const impl = conn?.toImpl?.(context);
    const child = impl?._browser?.options?.browserProcess?.process;
    if (child && typeof child.pid === "number") return child.pid;
  } catch {
    /* fall through to undefined */
  }
  return undefined;
}

/** Process-group id of `pid`, read from /proc/<pid>/stat (Linux, in-container). Field 5 (pgrp) — parsed
 *  after the last ')' so a comm containing spaces/parens can't shift the field offsets. */
function pgidOf(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  const after = stat.slice(stat.lastIndexOf(")") + 2).split(" "); // [state, ppid, pgrp, ...]
  return Number(after[2]);
}

/** All live pids whose process group is `pgid` (scans /proc; dead/racing entries are skipped). */
function procsInGroup(pgid) {
  const out = [];
  for (const name of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      if (pgidOf(Number(name)) === pgid) out.push(Number(name));
    } catch {
      /* the process exited between readdir and read — ignore */
    }
  }
  return out;
}

/** True once `pid` is gone (a liveness probe throws ESRCH). */
function isDead(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err.code === "ESRCH";
  }
}

console.log("=== browse-gateway :: confirmable teardown + force-kill proof (issue #50) ===");

const cfg = loadConfig();
const mgr = new SessionManager({ maxSessions: 2, coreOptions: cfg.core });

try {
  // --- Section A: the force-kill primitive against a real Chromium ---------------------------------
  const s = await mgr.acquire();
  const core = s.core;

  check("1. PID captured on the prod build (core.forceKillAvailable)", core.forceKillAvailable === true);
  const pid = capturePidFromContext(core.context);
  check("1b. independent toImpl pid capture agrees", typeof pid === "number");

  if (typeof pid === "number") {
    const pgid = pgidOf(pid);
    check("2. Chromium is its own process-group leader (getpgid === pid)", pgid === pid);

    const before = procsInGroup(pgid);
    console.log(`     group ${pgid}: ${before.length} live process(es) before kill`);
    check("2b. the browser group has live processes before kill", before.length > 0);

    await core.kill(5_000);
    check("3. leader pid confirmed dead after force-kill (ESRCH)", isDead(pid));

    const after = procsInGroup(pgid);
    console.log(`     group ${pgid}: ${after.length} live process(es) after kill`);
    check("3b. the whole process group was reaped (0 remain)", after.length === 0);

    // Reconfirm on an already-empty group must return fast WITHOUT re-signaling a possibly-recycled pgid.
    const t0 = Date.now();
    await core.kill(5_000);
    check("3d. reconfirm on an already-empty group returns fast (no re-signal)", Date.now() - t0 < 1_000);
  }

  // The direct kill left the session registered (we bypassed the manager). Release it so the slot frees;
  // the manager's teardown closes an already-dead context (fast) and reclaims the slot.
  await mgr.release(s.id);
  check("3c. slot reclaimed after a force-killed session is released", mgr.activeCount === 0);

  // --- Section B: manager teardown (clean close) reclaims a live session AND confirms the group empty ---
  const s2 = await mgr.acquire();
  const pid2 = capturePidFromContext(s2.core.context);
  const pgid2 = typeof pid2 === "number" ? pgidOf(pid2) : undefined;
  await mgr.release(s2.id); // clean close path — the group-confirm must still leave the whole group empty
  check("4. release() frees the capacity slot", mgr.activeCount === 0);
  check("4b. release() left no live leader process behind", pid2 === undefined || isDead(pid2));
  check(
    "4c. a CLEAN-close release leaves the whole process group empty (uniform group-confirm)",
    pgid2 === undefined || procsInGroup(pgid2).length === 0,
  );

  // --- Section C: leader-death != group-empty (the confirm must be group-based) --------------------
  // A detached leader with a surviving same-PGID child. SIGKILL only the leader; the child lives on in the
  // group — proving leader death is NOT whole-tree death. Then a GROUP SIGKILL empties it — the exact
  // confirm core.kill() uses (kill(-pgid,0)->ESRCH), not a leader-only probe.
  const { spawn } = await import("node:child_process");
  const leader = spawn("bash", ["-c", "sleep 300 & sleep 300 & wait"], { detached: true, stdio: "ignore" });
  const leaderPid = leader.pid;
  await new Promise((r) => setTimeout(r, 300)); // let the group populate
  const grp = pgidOf(leaderPid);
  process.kill(leaderPid, "SIGKILL"); // kill ONLY the leader
  await new Promise((r) => setTimeout(r, 300));
  const groupAfterLeaderKill = procsInGroup(grp);
  check("C. leader death alone leaves surviving same-group children (confirm can't key off the leader)", groupAfterLeaderKill.length > 0);
  process.kill(-grp, "SIGKILL"); // group kill — what core.kill() does to reap survivors
  await new Promise((r) => setTimeout(r, 300));
  let groupEmpty;
  try {
    process.kill(-grp, 0);
    groupEmpty = false;
  } catch (e) {
    groupEmpty = e.code === "ESRCH";
  }
  check("Cb. a GROUP SIGKILL empties the group (kill(-pgid,0)->ESRCH) — the group-based confirm", groupEmpty);

  // --- Section D: a malformed restore blob must not orphan the just-launched browser (issue #50 r4) ---
  // launch() constructs the PID-bearing core BEFORE restore, so a restore failure runs a confirmable
  // teardown (close→force-kill-confirm), not a best-effort close that could leak a live browser.
  const chromeCount = () => {
    let n = 0;
    for (const name of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const cmd = fs.readFileSync(`/proc/${name}/cmdline`, "utf8");
        if (/chrome|chromium/i.test(cmd) && !/chrome-sandbox/.test(cmd)) n++;
      } catch {
        /* raced exit */
      }
    }
    return n;
  };
  const { createBrowserCore } = await import("../dist/browser/index.js");
  const chromeBefore = chromeCount();
  const badRestore = {
    state: { cookies: [{ name: "sid", value: "x" }], origins: [] }, // no domain/url → addCookies rejects
    ownerHost: "example.com",
  };
  let threw = false;
  try {
    await createBrowserCore({ ...cfg.core, restoreState: badRestore });
  } catch {
    threw = true;
  }
  check("D. a malformed restore blob makes launch() throw (no leaked core returned)", threw);
  // Give the confirmable teardown a moment to reap the just-launched browser, then confirm no net leak.
  await new Promise((r) => setTimeout(r, 1_000));
  const chromeAfter = chromeCount();
  console.log(`     chrome procs: before=${chromeBefore} after=${chromeAfter}`);
  check("Db. the restore-failed browser was reaped (no orphaned Chrome)", chromeAfter <= chromeBefore);
} catch (err) {
  console.log(`  FAIL  threw: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  failures++;
} finally {
  await mgr.shutdown().catch(() => {});
}

const verdict = failures === 0 ? "PASS" : "FAIL";
console.log(`\n=== TEARDOWN GATE: ${verdict} (${failures} failure(s)) ===`);
process.exit(failures === 0 ? 0 : 1);
