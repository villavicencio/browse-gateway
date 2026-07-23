/**
 * Obscura verify tests (U5, test-first) — the /mcp probe's code→state mapping and the retry
 * window that rides out a container recreate. This mapping is the most error-prone surface in
 * `connect` (the Host-header and env-ref gotchas both bite here), so it is pinned exhaustively.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyProbeCode, verifyGateway, healthProbe } from "../dist/cli/index.js";

/** A probe that returns each code in sequence, then repeats the last forever. */
function scriptedProbe(codes) {
  let i = 0;
  const probe = async () => {
    const code = codes[Math.min(i, codes.length - 1)];
    i++;
    return code;
  };
  probe.count = () => i;
  return probe;
}

const fast = { timeoutMs: 200, pollMs: 1, wait: async () => {} };

test("code→state mapping: 401 healthy, 403 host/token mismatch, 000 tunnel down", () => {
  assert.equal(classifyProbeCode("401"), "healthy");
  assert.equal(classifyProbeCode("403"), "host-or-token-mismatch");
  assert.equal(classifyProbeCode("000"), "tunnel-down");
  // Anything else is reported as what it is, not shoehorned into a wrong bucket.
  assert.equal(classifyProbeCode("502"), "unexpected");
  assert.equal(classifyProbeCode("404"), "unexpected");
});

test("401 → healthy immediately, no spurious retries", async () => {
  const probe = scriptedProbe(["401"]);
  const result = await verifyGateway({ probe, ...fast });
  assert.equal(result.state, "healthy");
  assert.equal(result.code, "401");
  assert.equal(probe.count(), 1);
});

test("403 → mismatch is terminal (deterministic config error, retrying can't fix it)", async () => {
  const probe = scriptedProbe(["403"]);
  const result = await verifyGateway({ probe, ...fast });
  assert.equal(result.state, "host-or-token-mismatch");
  assert.equal(probe.count(), 1);
});

test("000-then-401 inside the window → healthy (covers the ~10–20s redeploy race)", async () => {
  const probe = scriptedProbe(["000", "000", "000", "401"]);
  const result = await verifyGateway({ probe, ...fast });
  assert.equal(result.state, "healthy");
  assert.equal(probe.count(), 4, "kept retrying through the refused window");
});

test("persistent 000 exhausts the window → tunnel-down", async () => {
  const probe = scriptedProbe(["000"]);
  const result = await verifyGateway({ probe, timeoutMs: 10, pollMs: 1, wait: async () => {} });
  assert.equal(result.state, "tunnel-down");
  assert.equal(result.code, "000");
});

test("unexpected codes are retried (transient 502 during recreate) then reported honestly", async () => {
  const recovered = await verifyGateway({ probe: scriptedProbe(["502", "401"]), ...fast });
  assert.equal(recovered.state, "healthy");

  const stuck = await verifyGateway({ probe: scriptedProbe(["502"]), timeoutMs: 10, pollMs: 1, wait: async () => {} });
  assert.equal(stuck.state, "unexpected");
  assert.equal(stuck.code, "502");
});

test("#53 r8: healthProbe with a malformed token (illegal header char) resolves 000, never throws", async () => {
  // A token with a newline makes node's request() throw ERR_INVALID_CHAR synchronously; the probe must
  // swallow it into the {code:'000'} contract so obscura status renders 'unavailable', not a crash.
  const result = await healthProbe(59999, "127.0.0.1:8080", "bad\ntoken")();
  assert.equal(result.code, "000");
  assert.equal(result.body, undefined);
});

test("#53 r8: healthProbe against a dead port resolves 000 (network failure contract)", async () => {
  const result = await healthProbe(1, "127.0.0.1:8080", "fine-token")();
  assert.equal(result.code, "000");
});
