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
// The specific detector for the one tempting wrong flag: `tini -g` forwards SIGTERM to the whole
// process group, which includes Xvfb, killing it mid-drain and manufacturing #129's symptom from a
// new cause. Here we only assert the steady state — a live display process, no zombie — which `-g`
// would break at shutdown and which a missing display would break immediately.
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

console.log(
  failures === 0
    ? `\nPASS — PID 1 is ${comm}, reaping confirmed by an orphan fixture, display process healthy.`
    : `\nFAIL — ${failures} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
