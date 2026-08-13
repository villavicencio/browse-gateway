/**
 * Issue #133 runtime gate — the display readiness probe tells a live X server from a dead socket.
 *
 * The entrypoint used to test `[ -S /tmp/.X11-unix/X99 ]`, which a leftover socket file from the
 * previous run satisfies. After a restart Xvfb would refuse to start ("Server is already active for
 * display 99"), the check passed anyway, and the container served HTTP with no display while every
 * browser launch failed.
 *
 *   docker run --rm --platform linux/amd64 <img> node scripts/validate-xvfb-readiness.mjs
 *
 * Each leg is constructed so it can only pass for the right reason: leg 2 is the exact leftover the
 * old check accepted, and leg 3 is a socket that exists and accepts connections but is not an X
 * server — the two ways "there is a socket here" lies.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, rmSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { probeOnce, socketPathFor, waitForDisplay } from "./xdisplay-probe.mjs";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

if (process.platform !== "linux") {
  console.error("FAIL: this gate needs a real X socket — run it in the container");
  process.exit(1);
}

const TEST_DISPLAY = ":95"; // not :99 — never fight the entrypoint's own display
const SOCK = socketPathFor(TEST_DISPLAY);
const LOCK = "/tmp/.X95-lock";

const cleanup = () => {
  for (const p of [SOCK, LOCK]) {
    try {
      rmSync(p, { force: true });
    } catch {
      /* best effort */
    }
  }
};

// ── leg 1: path derivation — the screen suffix is not part of the socket name ─────────────────────
// `${DISPLAY#*:}` in shell yields "99.0" for ":99.0" and points at a file that never exists, so a
// cleanup keyed off it removes nothing and a probe keyed off it never connects. Silent when wrong.
check("':95' and ':95.0' derive the same socket path", socketPathFor(":95") === socketPathFor(":95.0"), socketPathFor(":95.0"));
check("a non-local display is refused rather than guessed at", socketPathFor("host:0") === undefined);

// ── leg 2: a leftover socket from a SIGKILLed server reads as DEAD ────────────────────────────────
// This is precisely the file the old `[ -S ]` check accepted.
cleanup();
const xvfb = spawn("Xvfb", [TEST_DISPLAY, "-screen", "0", "640x480x24", "-ac", "-nolisten", "tcp"], { stdio: "ignore" });
await delay(2000);
const cameUp = (await waitForDisplay(TEST_DISPLAY, 4000)) === null;
check("a genuinely live Xvfb reads as LIVE (the positive control)", cameUp, cameUp ? SOCK : "Xvfb never came up — cannot test the rest");

xvfb.kill("SIGKILL");
await delay(1200);
const leftoverExists = existsSync(SOCK);
const deadReason = await probeOnce(SOCK);
check(
  "the socket file SURVIVES a SIGKILLed server (the premise of the bug)",
  leftoverExists,
  leftoverExists ? `${SOCK} still present` : "socket vanished — this environment cannot reproduce the bug",
);
check(
  "a leftover socket from a dead server reads as DEAD",
  deadReason !== null,
  deadReason ?? "probe wrongly reported it live",
);

// ── leg 3: a socket that is NOT an X server reads as DEAD ─────────────────────────────────────────
// Existence and even accepting a connection are not evidence of an X server.
cleanup();
const held = new Set();
const impostor = createServer((c) => {
  // Accept, then say nothing — the shape a non-X listener has. Sockets are tracked so close() below
  // cannot hang on them: awaiting close() with a live connection held leaves the event loop non-empty
  // and the gate stops mid-run without a verdict, which is how the first version of this file behaved.
  held.add(c);
  c.on("close", () => held.delete(c));
});
await new Promise((r) => impostor.listen(SOCK, r));
const impostorReason = await probeOnce(SOCK, 800);
check(
  "a live non-X listener reads as DEAD (handshake, not existence)",
  impostorReason !== null,
  impostorReason ?? "probe accepted a non-X server as a display",
);
for (const c of held) c.destroy();
await new Promise((r) => impostor.close(r));
cleanup();

// ── leg 4: nothing at all reads as DEAD, with a bounded wait ──────────────────────────────────────
const t0 = Date.now();
const absentReason = await waitForDisplay(TEST_DISPLAY, 700);
const waited = Date.now() - t0;
check("an absent display reads as DEAD", absentReason !== null, absentReason ?? "probe invented a display");
check("the wait is bounded", waited < 3000, `${waited}ms for a 700ms budget`);

console.log(
  failures === 0
    ? "\nPASS — the probe separates a live X server from a leftover socket and from a non-X listener."
    : `\nFAIL — ${failures} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
