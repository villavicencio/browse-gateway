/**
 * Issue #133 — display-to-socket path derivation.
 *
 * Pure and CI-runnable. The behavioural half (does the probe tell a live X server from a leftover
 * socket) needs a real X server and lives in `scripts/validate-xvfb-readiness.mjs`, run in-container.
 *
 * This is worth its own tests because getting it wrong is SILENT: the shell expression the entrypoint
 * used, `${DISPLAY#*:}`, yields "99.0" for DISPLAY=":99.0" and points at /tmp/.X11-unix/X99.0, a path
 * that never exists. A cleanup keyed off it removes nothing and a probe keyed off it never connects —
 * and neither failure announces itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { socketPathFor } from "../scripts/xdisplay-probe.mjs";

test("a bare display maps to its socket", () => {
  assert.equal(socketPathFor(":99"), "/tmp/.X11-unix/X99");
  assert.equal(socketPathFor(":0"), "/tmp/.X11-unix/X0");
  assert.equal(socketPathFor(":1234"), "/tmp/.X11-unix/X1234");
});

test("the screen suffix is stripped — ':99' and ':99.0' are the same display", () => {
  assert.equal(socketPathFor(":99.0"), "/tmp/.X11-unix/X99");
  assert.equal(socketPathFor(":99.1"), socketPathFor(":99"));
});

test("surrounding whitespace does not change the answer", () => {
  assert.equal(socketPathFor("  :99\n"), "/tmp/.X11-unix/X99");
});

test("a REMOTE display is refused, not silently mapped to a local socket", () => {
  // `host:0` is served over TCP by another machine. Mapping it to /tmp/.X11-unix/X0 would probe an
  // unrelated local server and could report a display that this container cannot actually use.
  assert.equal(socketPathFor("host:0"), undefined);
  assert.equal(socketPathFor("192.168.1.5:0"), undefined);
  assert.equal(socketPathFor("localhost:10.0"), undefined);
});

test("malformed input is refused rather than guessed at", () => {
  assert.equal(socketPathFor(""), undefined);
  assert.equal(socketPathFor("99"), undefined); // no colon at all
  assert.equal(socketPathFor(":"), undefined);
  assert.equal(socketPathFor(":abc"), undefined);
  assert.equal(socketPathFor(undefined), "/tmp/.X11-unix/X99"); // documented default
});
