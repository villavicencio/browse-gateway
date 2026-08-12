/**
 * Issue #131 runtime gate — a process group of nothing but zombies must read as GONE.
 *
 * This is the only place the defect can be reproduced end-to-end, because it needs a PID 1 that does
 * NOT reap reparented orphans. On a normal machine init reaps them within milliseconds and no
 * all-zombie group can persist — which is exactly why this bug lived in production for days while every
 * unit test stayed green.
 *
 * RUN IT WITH A NON-REAPING PID 1. Any reaping init collects the zombies, and the gate then cannot see
 * the thing it exists to check. It DETECTS that case and exits non-zero rather than reporting a
 * meaningless pass — a gate that silently self-neuters in the environment we actually ship is worse
 * than no gate (see
 * docs/solutions/best-practices/a-test-whose-stub-guarantees-the-assertion-proves-nothing.md).
 *
 * SINCE #131 PIECE 2 THE IMAGE BAKES tini AS ITS ENTRYPOINT, so overriding the entrypoint is now
 * MANDATORY — omitting `--init` is no longer enough:
 *
 *   docker run --rm --platform linux/amd64 \
 *     --entrypoint /usr/local/bin/entrypoint.sh <img> node scripts/validate-zombie-confirm.mjs
 *
 * This gate and `validate-container-init.mjs` have OPPOSITE PID-1 requirements by design — one proves
 * the accounting survives a broken reaper, the other proves the shipped image has a working one. That
 * is satisfied per-invocation, not per-image; do not "fix" either by relaxing its detection.
 *
 * INVOKE IT AS PID 1 DIRECTLY — `node scripts/…`, never `sh -c 'node scripts/…'`. A shell wrapper
 * becomes PID 1 itself and reaps adopted orphans through its own `wait`, so the zombies vanish and the
 * gate reports inconclusive. Same failure as a reaping init, different cause; the detection below
 * catches both, but the wrapper is the easier mistake to make.
 */
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { readdirSync } from "node:fs";
import { groupIsAllZombies, readProcStat } from "../dist/browser/index.js";

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

if (process.platform !== "linux") fail("this gate needs /proc — run it in the container");

// A reaping PID 1 makes the scenario unbuildable. Detect it up front so a --init run reports
// "cannot test" rather than a hollow pass.
const pid1 = readProcStat(1, "/proc");
console.log(`PID 1 state=${pid1?.state ?? "?"} — reaping shim detection follows`);

// Build a group whose every member has exited and been orphaned: a detached shell (the group leader)
// backgrounds three short sleeps and exits immediately. Node reaps the shell (its direct child); the
// sleeps reparent to PID 1. With no reaper there, they stay zombies and the GROUP still exists.
const leader = spawn("sh", ["-c", "sleep 0.3 & sleep 0.3 & sleep 0.3 & exit 0"], {
  detached: true,
  stdio: "ignore",
});
const pgid = leader.pid;
leader.unref();
await delay(2000); // well past the sleeps' exit, and past any reaper's reaction time

// Enumerate the group directly, so the report says what was actually observed.
const members = [];
for (const name of readdirSync("/proc")) {
  if (!/^\d+$/.test(name)) continue;
  const stat = readProcStat(Number(name), "/proc");
  if (stat?.pgrp === pgid) members.push({ pid: Number(name), state: stat.state });
}
console.log(`group ${pgid}: ${members.length} member(s) — ${JSON.stringify(members)}`);

if (members.length === 0) {
  fail(
    "the group was fully reaped, so the all-zombie scenario could not be built. " +
      "This container has a reaping PID 1. Since #131 piece 2 the image bakes tini, so re-run with "
      + "--entrypoint /usr/local/bin/entrypoint.sh (omitting --init is no longer sufficient). " +
      "Reporting inconclusive rather than passing.",
  );
}
if (!members.every((m) => m.state === "Z")) {
  fail(`expected every member to be a zombie, got ${JSON.stringify(members)}`);
}

// LEG 1 — the defect, demonstrated against the kernel. This is what the old confirmation relied on,
// and it reads an already-exited tree as alive. If this ever throws ESRCH, #131's premise changed.
let signalZeroSucceeded = false;
try {
  process.kill(-pgid, 0);
  signalZeroSucceeded = true;
} catch (err) {
  fail(
    `signal 0 on an all-zombie group raised ${err.code} — #131's premise was that it SUCCEEDS. ` +
      "The old confirmation would have worked here, so this gate is testing nothing.",
  );
}
console.log(`leg 1 OK — kill(-${pgid}, 0) succeeded on a group of pure zombies (the old probe says ALIVE)`);

// LEG 2 — the fix. Same group, same instant, correct answer.
if (!groupIsAllZombies(pgid, "/proc")) {
  fail("groupIsAllZombies returned false for a group whose every member is a zombie — the fix is inert");
}
console.log(`leg 2 OK — groupIsAllZombies(${pgid}) === true (the new check says GONE)`);

// LEG 3 — the conservative direction must not regress: a group with ONE live member stays alive.
const live = spawn("sh", ["-c", "true & sleep 5"], { detached: true, stdio: "ignore" });
await delay(400);
if (groupIsAllZombies(live.pid, "/proc")) {
  try { process.kill(-live.pid, "SIGKILL"); } catch { /* best effort */ }
  fail("a group with a LIVING member read as all-zombies — this would double-book a live browser");
}
console.log(`leg 3 OK — group ${live.pid} has a live member and correctly reads NOT gone`);
try { process.kill(-live.pid, "SIGKILL"); } catch { /* best effort */ }

console.log(`\nPASS — signal 0 lies about zombies (${signalZeroSucceeded}); the /proc state check does not.`);
process.exit(0);
