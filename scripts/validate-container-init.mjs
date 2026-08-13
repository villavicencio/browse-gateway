/**
 * Issue #131 piece 2 runtime gate — the IMAGE carries a reaping PID 1, and reaping actually works.
 *
 * Piece 1 made the session accounting correct even when reaping is broken (a zombie group reads as
 * gone). This gate asserts the stronger, structural property: that reaping is not broken in the first
 * place, because the image supplies its own init rather than depending on whoever creates the
 * container remembering `--init`. A hand-written `docker run` dropped that flag once and wedged
 * production for ~2.5 days.
 *
 *   docker run --rm --platform linux/amd64 <img> node scripts/validate-container-init.mjs
 *
 * TO WATCH IT FAIL (leg 1 and leg 2), bypass the baked init by overriding the entrypoint:
 *
 *   docker run --rm --platform linux/amd64 \
 *     --entrypoint /usr/local/bin/entrypoint.sh <img> node scripts/validate-container-init.mjs
 *
 * That reproduces the incident topology exactly — node as PID 1, orphans never reaped.
 */
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { readdirSync } from "node:fs";
import { readPid1Comm, classifyInit } from "../dist/gateway/init-identity.js";
import { readProcStat } from "../dist/browser/index.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

if (process.platform !== "linux") {
  console.error("FAIL: this gate needs /proc — run it in the container");
  process.exit(1);
}

// ── leg 1: PID 1 is an init that reaps, and it is not us ─────────────────────────────────────────
const comm = readPid1Comm("/proc");
const posture = classifyInit(comm);
check("PID 1 is a reaping init", posture === "reaping", `/proc/1/comm=${comm ?? "?"} posture=${posture}`);
check(
  "the gateway process is NOT PID 1",
  process.pid !== 1,
  `own pid=${process.pid}`,
);

// ── leg 2: reaping demonstrably WORKS — the assertion that separates "tini exists" from "tini runs"
// Same fixture the piece-1 zombie gate builds: a detached shell backgrounds sleeps and exits,
// orphaning them. Under a reaping PID 1 they are collected; under node-as-PID-1 they persist as
// zombies forever, which is precisely the production failure.
const leader = spawn("sh", ["-c", "sleep 0.3 & sleep 0.3 & sleep 0.3 & exit 0"], {
  detached: true,
  stdio: "ignore",
});
const pgid = leader.pid;
leader.unref();
await delay(2500); // well past the sleeps' exit and any reaper's reaction time

const survivors = [];
for (const name of readdirSync("/proc")) {
  if (!/^\d+$/.test(name)) continue;
  const stat = readProcStat(Number(name), "/proc");
  if (stat?.pgrp === pgid) survivors.push({ pid: Number(name), state: stat.state });
}
check(
  "orphaned exited children are reaped, not left as zombies",
  survivors.length === 0,
  survivors.length === 0 ? `group ${pgid} empty` : `group ${pgid} still holds ${JSON.stringify(survivors)}`,
);

// ── leg 3: the Xvfb this entrypoint backgrounds is ALIVE, not a zombie ────────────────────────────
// Steady state only: a display process exists and has not died. That is ALL this leg guards.
//
// It is explicitly NOT a detector for `tini -g`, despite the temptation to claim so. `-g` changes
// signal FORWARDING, and this script never sends a signal — so under `-g` every leg here is green and
// Xvfb only dies later, mid-drain, after this process has exited. Leg 4 covers `-g` directly.
let xvfb;
for (const name of readdirSync("/proc")) {
  if (!/^\d+$/.test(name)) continue;
  const stat = readProcStat(Number(name), "/proc");
  if (!stat) continue;
  try {
    const { readFileSync } = await import("node:fs");
    const cmd = readFileSync(`/proc/${name}/cmdline`, "utf8");
    if (cmd.includes("Xvfb")) {
      xvfb = { pid: Number(name), state: stat.state };
      break;
    }
  } catch {
    /* raced exit — skip */
  }
}
// Only meaningful when the entrypoint started a display (it always does in the shipped image, but a
// bare `--entrypoint node` run would not) — so absence is reported, never silently passed.
check(
  "Xvfb is running and not a zombie",
  xvfb !== undefined && xvfb.state !== "Z",
  xvfb === undefined ? "no Xvfb process found (entrypoint bypassed?)" : `pid=${xvfb.pid} state=${xvfb.state}`,
);

// ── leg 4: no init in this container is configured to signal the process GROUP ────────────────────
// `tini -g` (equivalently TINI_KILL_PROCESS_GROUP) forwards SIGTERM to the whole group, which includes
// the Xvfb the entrypoint backgrounds: measured, Xvfb goes S -> Z at T+0 while node is still draining,
// manufacturing #129's in-flight-work-dies-instantly symptom from a brand new cause. It buys nothing —
// it never reaches Chrome, which patchright spawns detached as its own group leader.
//
// Checked as CONFIGURATION rather than by delivering a signal: observing the effect needs a real
// SIGTERM plus a mid-drain sample, i.e. docker-in-docker, which is disproportionate here. The two ways
// `-g` can arrive are both visible in /proc without sending anything — an edited Dockerfile (cmdline)
// and the env var (environ), the latter being a CREATE-time setting no image-level check could ever
// see if we only inspected the image.
//
// EVERY tini is scanned, not just PID 1: the deploy path passes `--init`, which puts docker-init at
// PID 1 and the baked tini one level below it. A PID-1-only check would look right and see nothing.
const groupSignalling = [];
for (const name of readdirSync("/proc")) {
  if (!/^\d+$/.test(name)) continue;
  let cmdline = "";
  let environ = "";
  try {
    const { readFileSync } = await import("node:fs");
    cmdline = readFileSync(`/proc/${name}/cmdline`, "utf8");
    if (!/(^|\/)(tini|docker-init)\0/.test(cmdline)) continue;
    environ = readFileSync(`/proc/${name}/environ`, "utf8");
  } catch {
    continue; // raced exit / unreadable — not evidence of anything
  }
  // Only tini's OWN options count. Its option list ends at the first `--` or the first non-option
  // argument; everything after that belongs to the child. Scanning past that boundary false-trips on a
  // child's own flag — verified: `node scripts/validate-container-init.mjs -g` failed this leg while
  // tini carried nothing but `-s`. A gate that cries wolf is a gate that gets disabled.
  const argv = cmdline.split("\0").slice(1).filter((a) => a.length > 0);
  const ownArgs = [];
  for (const a of argv) {
    if (a === "--" || !a.startsWith("-")) break;
    ownArgs.push(a);
  }
  const hasG = ownArgs.some((a) => /^-[a-z]+$/.test(a) && a.includes("g")); // -g, and bundles like -sg

  // PRESENCE, not truthiness. `tini -h` documents TINI_VERBOSITY as taking a value ("default: 1") and
  // TINI_KILL_PROCESS_GROUP as taking none — it is a presence flag (tini tests getenv() != NULL), so
  // `TINI_KILL_PROCESS_GROUP=0` ENABLES group signalling rather than disabling it. Treating `=0` as
  // safe would be a false negative in a safety guard, which is the dangerous direction; an earlier
  // draft of this check did exactly that.
  const envG = /(^|\0)TINI_KILL_PROCESS_GROUP=/.test(environ);
  if (hasG || envG) {
    groupSignalling.push(`pid=${name}${hasG ? " cmdline:-g" : ""}${envG ? " env:TINI_KILL_PROCESS_GROUP" : ""}`);
  }
}
check(
  "no init is configured to signal the process group (-g / TINI_KILL_PROCESS_GROUP)",
  groupSignalling.length === 0,
  groupSignalling.length === 0 ? "none found" : groupSignalling.join("; "),
);

console.log(
  failures === 0
    ? `\nPASS — PID 1 is ${comm}, reaping confirmed by an orphan fixture, display healthy, no group-signalling init.`
    : `\nFAIL — ${failures} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
