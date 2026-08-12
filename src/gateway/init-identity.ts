/**
 * Who is PID 1, and will it reap? (issue #131 piece 2.)
 *
 * A container whose PID 1 does not reap reparented orphans turns every exited Chrome child into a
 * permanent zombie. A zombie still answers `kill(-pgid, 0)`, so the teardown's group-empty
 * confirmation can never confirm, sessions are retained in `#unconfirmed` forever, and the pool
 * saturates with zero live browsers. That happened in production for ~2.5 days.
 *
 * The image now bakes tini as its ENTRYPOINT, so the condition should be structurally impossible —
 * but "should be impossible" is exactly the kind of claim this project measures rather than asserts.
 * The gateway reads PID 1's identity at boot and says what it found, so an off-path container (one
 * created with `--entrypoint` overridden, or from an older image) is visible in the log rather than
 * discovered days later through a saturated pool.
 *
 * Deliberately NOT a `process.pid === 1` check. Under tini the gateway is never PID 1, so such an
 * assertion would be unfalsifiable-by-construction — it would pass forever regardless of whether a
 * reaper is present, which is the failure mode this whole ticket is about.
 *
 * Pure and `procRoot`-injectable so both branches are unit-testable without a container.
 */
import { readFileSync } from "node:fs";

/** Init programs known to reap reparented orphans: tini (baked into the image) and Docker's own. */
const REAPING_INITS = new Set(["tini", "docker-init", "systemd", "init", "dumb-init", "s6-svscan"]);

export type InitPosture = "reaping" | "not-reaping" | "unknown";

/** PID 1's executable name, or undefined when /proc is unavailable (macOS dev) or unreadable. */
export function readPid1Comm(procRoot = "/proc"): string | undefined {
  try {
    const comm = readFileSync(`${procRoot}/1/comm`, "utf8").trim();
    return comm.length > 0 ? comm : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Classify PID 1. `not-reaping` is reported only for a name we positively recognise as a
 * non-reaper — chiefly `node`, i.e. the gateway itself as PID 1, which is the exact #131 shape.
 * An unrecognised name is `unknown`, never `not-reaping`: guessing "broken" from an unfamiliar
 * init would cry wolf in every environment we have not enumerated.
 */
export function classifyInit(comm: string | undefined): InitPosture {
  if (comm === undefined) return "unknown";
  if (REAPING_INITS.has(comm)) return "reaping";
  if (comm === "node" || comm === "sh" || comm === "bash") return "not-reaping";
  return "unknown";
}

/** One log-ready token: `tini(reaping)`, `node(NOT-REAPING)`, `unknown`. */
export function describeInit(procRoot = "/proc"): string {
  const comm = readPid1Comm(procRoot);
  const posture = classifyInit(comm);
  if (comm === undefined) return "unknown";
  return posture === "not-reaping" ? `${comm}(NOT-REAPING)` : `${comm}(${posture})`;
}
