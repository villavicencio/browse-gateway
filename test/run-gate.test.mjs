/**
 * scripts/run-gate.sh (VIL-294) — the amd64-handler guard, exercised for real: the script runs under
 * bash with stub `docker` and `colima` binaries first on PATH, so both the refusal and the pass-through
 * are observed rather than asserted structurally. The stubs record every call, which is how the tests
 * prove the refusal happens BEFORE any container is started.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT = new URL("../scripts/run-gate.sh", import.meta.url).pathname;

function stubs({ context, handlers, colimaFails = false }) {
  const dir = mkdtempSync(join(tmpdir(), "run-gate-"));
  const log = join(dir, "calls.log");
  writeFileSync(
    join(dir, "docker"),
    `#!/bin/sh\necho "docker $*" >> "${log}"\nif [ "$1 $2" = "context show" ]; then echo "${context}"; fi\nexit 0\n`,
  );
  writeFileSync(
    join(dir, "colima"),
    `#!/bin/sh\necho "colima $*" >> "${log}"\n${colimaFails ? "exit 1" : `printf '%s\\n' ${handlers.map((h) => `'${h}'`).join(" ")}`}\n`,
  );
  chmodSync(join(dir, "docker"), 0o755);
  chmodSync(join(dir, "colima"), 0o755);
  return { dir, calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []) };
}

function run(stub, args = ["browse-gateway:dev", "validate-http.mjs"]) {
  return spawnSync("bash", [SCRIPT, ...args], { env: { ...process.env, PATH: `${stub.dir}:/usr/bin:/bin` }, encoding: "utf8" });
}

const ranGate = (calls) => calls.some((c) => c.startsWith("docker run"));

test("Colima WITHOUT the rosetta handler (QEMU fallback): refuses with exit 3 and never starts a container", () => {
  const s = stubs({ context: "colima", handlers: ["python3.12", "qemu-i386", "qemu-x86_64", "register", "status"] });
  const r = run(s);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /REFUSING — Colima has no 'rosetta' binfmt handler/);
  assert.match(r.stderr, /colima stop && colima start/);
  assert.ok(!ranGate(s.calls()), "no container may start on a QEMU-only handler");
});

test("Colima WITH rosetta: runs the gate with the documented flags", () => {
  const s = stubs({ context: "colima", handlers: ["python3.12", "qemu-x86_64", "register", "rosetta", "status"] });
  const r = run(s);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(
    s.calls().includes("docker run --rm --platform linux/amd64 --shm-size=1g --init browse-gateway:dev node scripts/validate-http.mjs"),
    s.calls().join("\n"),
  );
});

test("the match is EXACT: a handler merely containing the word does not count", () => {
  const s = stubs({ context: "colima", handlers: ["qemu-x86_64", "rosetta-old", "not-rosetta"] });
  assert.equal(run(s).status, 3);
});

test("an unreadable handler list (colima ssh failing) refuses rather than guessing", () => {
  const s = stubs({ context: "colima", handlers: [], colimaFails: true });
  assert.equal(run(s).status, 3);
  assert.ok(!ranGate(s.calls()));
});

test("a non-Colima runtime is not checked: no colima call, the gate runs", () => {
  const s = stubs({ context: "orbstack", handlers: [] });
  const r = run(s);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!s.calls().some((c) => c.startsWith("colima")));
  assert.ok(ranGate(s.calls()));
});

test("extra docker args are passed through before the image", () => {
  const s = stubs({ context: "orbstack", handlers: [] });
  run(s, ["img:tag", "validate-teardown.mjs", "-e", "BGW_X=1"]);
  assert.ok(s.calls().includes("docker run --rm --platform linux/amd64 --shm-size=1g --init -e BGW_X=1 img:tag node scripts/validate-teardown.mjs"));
});

test("missing arguments print usage and exit 2", () => {
  const s = stubs({ context: "orbstack", handlers: [] });
  const r = run(s, ["only-a-tag"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/);
});
