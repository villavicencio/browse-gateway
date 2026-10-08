/**
 * scripts/run-gate.sh (VIL-294) — the amd64 start-up guard, exercised for real: the script runs under
 * bash with a stub `docker` first on PATH, so both the refusal and the pass-through are observed rather
 * than asserted structurally. The stub records every call, which is how the tests prove the refusal
 * happens BEFORE the gate container is started, and lets each test decide whether the image's
 * `tini -s` probe succeeds (Rosetta) or fails (QEMU's PR_SET_CHILD_SUBREAPER refusal).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// fileURLToPath, not URL#pathname: pathname keeps percent-encoding, so a checkout path with a space
// would hand bash a nonexistent script (MergeWren on #158).
const SCRIPT = fileURLToPath(new URL("../scripts/run-gate.sh", import.meta.url));

// Every stub directory is removed when the file finishes (MergeWren on #158).
const stubDirs = [];
after(() => {
  for (const d of stubDirs) rmSync(d, { recursive: true, force: true });
});

function stubs({ context = "colima", probeOk = true, probeError = "[FATAL tini (1)] PR_SET_CHILD_SUBREAPER is unavailable on this platform." }) {
  const dir = mkdtempSync(join(tmpdir(), "run-gate-"));
  stubDirs.push(dir);
  const log = join(dir, "calls.log");
  writeFileSync(
    join(dir, "docker"),
    `#!/bin/sh
echo "docker $*" >> "${log}"
if [ "$1 $2" = "context show" ]; then echo "${context}"; exit 0; fi
case "$*" in
  *"--entrypoint /usr/bin/tini"*)
    ${probeOk ? "exit 0" : `echo "${probeError}" >&2; exit 1`} ;;
esac
exit 0
`,
  );
  chmodSync(join(dir, "docker"), 0o755);
  return { dir, calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []) };
}

function run(stub, args = ["browse-gateway:dev", "validate-http.mjs"]) {
  return spawnSync("bash", [SCRIPT, ...args], { env: { ...process.env, PATH: `${stub.dir}:/usr/bin:/bin` }, encoding: "utf8" });
}

const probeCall = "docker run --rm --platform linux/amd64 --entrypoint /usr/bin/tini browse-gateway:dev -s -- true";
const gateCall = "docker run --rm --platform linux/amd64 --shm-size=1g --init browse-gateway:dev node scripts/validate-http.mjs";
/** Every `docker run` the script made. A refusal must have made exactly one: the probe itself, nothing else,
 *  with no substring filter that a probe-like extra run could slip through (MergeWren on #158). */
const runs = (calls) => calls.filter((c) => c.startsWith("docker run"));

test("the image's tini -s cannot start as amd64 (QEMU fallback): refuses with exit 3 and never starts the gate", () => {
  const s = stubs({ probeOk: false });
  const r = run(s);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /REFUSING — the start-up probe/);
  assert.match(r.stderr, /amd64 refuses PR_SET_CHILD_SUBREAPER here/);
  assert.match(r.stderr, /One known cause \(not established by this probe\)/, "named as a possible cause, not asserted");
  assert.match(r.stderr, /PR_SET_CHILD_SUBREAPER/, "the probe's own output is shown");
  assert.match(r.stderr, /Likely fix: colima stop && colima start/, "on Colima, the likely fix is named");
  assert.ok(s.calls().includes(probeCall), "the probe ran");
  assert.deepEqual(runs(s.calls()), [probeCall], "the probe is the only container started");
});

test("the probe succeeds: the gate runs with the documented flags, after the probe", () => {
  const s = stubs({ probeOk: true });
  const r = run(s);
  assert.equal(r.status, 0, r.stderr);
  const calls = s.calls();
  assert.ok(calls.indexOf(probeCall) !== -1 && calls.indexOf(gateCall) > calls.indexOf(probeCall), calls.join("\n"));
});

test("the guard does not depend on the runtime: a failing probe refuses on a non-Colima context too", () => {
  const s = stubs({ context: "orbstack", probeOk: false });
  const r = run(s);
  assert.equal(r.status, 3);
  assert.doesNotMatch(r.stderr, /colima stop/, "the Colima-specific hint only appears on Colima");
  assert.deepEqual(runs(s.calls()), [probeCall]);
});

test("extra docker args are passed through to the gate, before the image", () => {
  const s = stubs({ probeOk: true });
  run(s, ["img:tag", "validate-teardown.mjs", "-e", "BGW_X=1"]);
  assert.ok(s.calls().includes("docker run --rm --platform linux/amd64 --shm-size=1g --init -e BGW_X=1 img:tag node scripts/validate-teardown.mjs"));
});

test("missing arguments print usage and exit 2", () => {
  const s = stubs({});
  const r = run(s, ["only-an-image"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/);
});

test("a probe that fails for another reason (missing image) refuses WITHOUT the QEMU/Colima diagnosis", () => {
  const s = stubs({ probeOk: false, probeError: "Unable to find image 'browse-gateway:dev' locally" });
  const r = run(s);
  assert.equal(r.status, 3, "still fail closed");
  assert.match(r.stderr, /could not run at all/);
  assert.doesNotMatch(r.stderr, /QEMU|colima stop/, "no translator advice for an unrelated failure");
  assert.deepEqual(runs(s.calls()), [probeCall]);
});

test("the QEMU diagnosis needs tini's own fatal line, not the word anywhere in Docker's output", () => {
  const s = stubs({ probeOk: false, probeError: "Error response from daemon: container references PR_SET_CHILD_SUBREAPER in its name" });
  const r = run(s);
  assert.equal(r.status, 3, "still fail closed");
  assert.match(r.stderr, /could not run at all/);
  assert.doesNotMatch(r.stderr, /QEMU|colima stop/);
});

test("both observed forms of tini's fatal line get the QEMU diagnosis (with and without the pid)", () => {
  for (const line of ["[FATAL tini (1)] PR_SET_CHILD_SUBREAPER is unavailable on this platform. Are you using Linux >= 3.4?", "[FATAL tini] PR_SET_CHILD_SUBREAPER is unavailable on this platform"]) {
    const r = run(stubs({ probeOk: false, probeError: line }));
    assert.equal(r.status, 3);
    assert.match(r.stderr, /amd64 refuses PR_SET_CHILD_SUBREAPER here/, line);
  }
});
