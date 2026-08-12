/**
 * Issue #131 piece 2 — PID-1 identity detection.
 *
 * The image bakes tini as ENTRYPOINT so a non-reaping PID 1 should be structurally impossible. This
 * detection exists because "should be impossible" is the kind of claim this project measures: an
 * off-path container (entrypoint overridden, or an older image tag) shows up in the boot log instead
 * of being discovered days later through a saturated pool.
 *
 * Note what is deliberately NOT tested, because it cannot be: a `process.pid === 1` assertion. Under
 * tini the gateway is never PID 1, so that check would pass forever regardless of whether a reaper is
 * present — unfalsifiable by construction, and the exact shape of the bug it would claim to catch.
 * The real end-to-end proof is `scripts/validate-container-init.mjs`, which builds an orphan fixture
 * and asserts it gets reaped.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPid1Comm, classifyInit, describeInit } from "../dist/gateway/init-identity.js";

function fakeProcWithPid1(comm) {
  const root = mkdtempSync(join(tmpdir(), "bgw-init-proc-"));
  mkdirSync(join(root, "1"), { recursive: true });
  if (comm !== null) writeFileSync(join(root, "1", "comm"), `${comm}\n`);
  return root;
}

test("tini as PID 1 reads as reaping", () => {
  const root = fakeProcWithPid1("tini");
  try {
    assert.equal(readPid1Comm(root), "tini");
    assert.equal(classifyInit("tini"), "reaping");
    assert.equal(describeInit(root), "tini(reaping)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("docker-init (a container created with --init) also reads as reaping", () => {
  const root = fakeProcWithPid1("docker-init");
  try {
    assert.equal(describeInit(root), "docker-init(reaping)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("node as PID 1 — the #131 production topology — reads as NOT-REAPING", () => {
  const root = fakeProcWithPid1("node");
  try {
    assert.equal(classifyInit("node"), "not-reaping");
    assert.equal(
      describeInit(root),
      "node(NOT-REAPING)",
      "this is the string an operator must be able to spot in a boot log",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a shell as PID 1 also reads as NOT-REAPING", () => {
  // `sh -c '<cmd>'` as the container command is an easy mistake and reaps only via its own wait.
  assert.equal(classifyInit("sh"), "not-reaping");
  assert.equal(classifyInit("bash"), "not-reaping");
});

test("an UNRECOGNISED init is unknown, never not-reaping", () => {
  // Crying wolf on every init we have not enumerated would train operators to ignore the field.
  assert.equal(classifyInit("supervisord"), "unknown");
  assert.equal(classifyInit("my-custom-init"), "unknown");
});

test("no /proc (macOS dev) is unknown, not a false alarm", () => {
  assert.equal(readPid1Comm(join(tmpdir(), "bgw-no-such-proc")), undefined);
  assert.equal(classifyInit(undefined), "unknown");
  assert.equal(describeInit(join(tmpdir(), "bgw-no-such-proc")), "unknown");
});

test("an empty or whitespace-only comm is treated as unreadable", () => {
  const root = fakeProcWithPid1("");
  try {
    assert.equal(readPid1Comm(root), undefined);
    assert.equal(describeInit(root), "unknown");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
