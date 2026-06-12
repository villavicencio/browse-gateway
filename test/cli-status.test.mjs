/**
 * Obscura status tests (U6) — state composition across tunnel × gateway × consumers × stealth,
 * with the failure-mode distinctions pinned: gateway-down-tunnel-up ≠ tunnel-down, 403 ≠ down,
 * self-disabled surfaces the keeper's reason. Tokens never appear.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { status, tunnelSpec, SELF_DISABLE_MARKER } from "../dist/cli/index.js";

function makeDeps(over = {}) {
  const lines = [];
  const spec = tunnelSpec({ alias: "browse-gateway-tunnel", hostName: "prod-host.example", home: "/tmp/unused" });
  const deps = {
    spec,
    gatewayHost: "127.0.0.1:8080",
    out: (line) => lines.push(line),
    state: async () => ({ agent: "running", port: "ours" }),
    probe: async () => "401",
    wait: async () => {},
    verifyTimeoutMs: 50,
    verifyPollMs: 1,
    consumers: async () => ({
      consumers: [
        { id: "consumer-1", allow: ["*"], tokenSet: true, tags: ["prod"] },
        { id: "consumer-2", allow: ["x.com"], tokenSet: false },
      ],
      orphanEnvKeys: [],
    }),
    ...over,
  };
  return { deps, lines };
}

test("all green: tunnel up + 401 → connected owl header, healthy report", async () => {
  const { deps, lines } = makeDeps();
  const report = await status(deps);
  assert.equal(report.healthy, true);
  assert.equal(report.owl, "connected");
  assert.equal(lines[0], "(^,o)  obscura status", "connected owl drives the header");
  assert.ok(lines.some((l) => l.startsWith("✓ tunnel up")));
  assert.ok(lines.some((l) => l.startsWith("✓ gateway healthy")));
});

test("tunnel up + 000 → 'gateway down, tunnel up' — NOT 'tunnel down'", async () => {
  const { deps, lines } = makeDeps({ probe: async () => "000" });
  const report = await status(deps);
  assert.equal(report.healthy, false);
  assert.equal(report.owl, "down");
  assert.equal(lines[0], "(-,-)  obscura status", "down owl in the header");
  assert.ok(lines.some((l) => l.includes("gateway down") && l.includes("tunnel forward is up")), `got: ${lines.join(" | ")}`);
  assert.ok(!lines.some((l) => l.includes("tunnel down")), "must not claim the tunnel is down");
});

test("no forward → 'tunnel down' with the agent state", async () => {
  const { deps, lines } = makeDeps({
    state: async () => ({ agent: "running", port: "none" }),
    probe: async () => "000",
  });
  const report = await status(deps);
  assert.equal(report.healthy, false);
  assert.ok(lines.some((l) => l.includes("tunnel down")));
  assert.ok(lines.some((l) => l.includes("gateway unreachable — no tunnel")));
});

test("self-disabled surfaces the keeper-log reason + the re-enable hint", async () => {
  const { deps, lines } = makeDeps({
    state: async () => ({
      agent: "self-disabled",
      port: "none",
      selfDisableReason: `*** 10 consecutive fast failures — ${SELF_DISABLE_MARKER} the tunnel LaunchAgent. ***\n    Likely cause: prod VPS gone/replaced...`,
    }),
    probe: async () => "000",
  });
  const report = await status(deps);
  assert.equal(report.healthy, false);
  assert.ok(lines.some((l) => l.includes("self-disabled")));
  assert.ok(lines.some((l) => l.includes("Likely cause")), "keeper's why is shown");
  assert.ok(lines.some((l) => l.includes("launchctl bootstrap") && l.includes(".plist")), "re-enable hint");
});

test("clean install (not-bootstrapped, no forward) points at obscura connect", async () => {
  const { deps, lines } = makeDeps({
    state: async () => ({ agent: "not-bootstrapped", port: "none" }),
    probe: async () => "000",
  });
  const report = await status(deps);
  assert.equal(report.healthy, false);
  assert.ok(lines.some((l) => l.includes("tunnel not set up") && l.includes("run: obscura connect")));
});

test("tunnel up + gateway down hints at a possible mid-deploy recreate", async () => {
  const { deps, lines } = makeDeps({ probe: async () => "000" });
  await status(deps);
  assert.ok(lines.some((l) => l.includes("mid-recreate") && l.includes("recheck")));
});

test("403 surfaces as Host/token mismatch, not as down", async () => {
  const { deps, lines } = makeDeps({ probe: async () => "403" });
  const report = await status(deps);
  assert.equal(report.gateway, "host-or-token-mismatch");
  assert.ok(lines.some((l) => l.includes("REJECTED") && l.includes("mismatch")));
  assert.ok(!lines.some((l) => l.includes("gateway down") || l.includes("unreachable")));
});

test("foreign binder is flagged and makes the report unhealthy even with a 401", async () => {
  // A foreign process answering 401 on 8080 must not read as healthy.
  const { deps, lines } = makeDeps({ state: async () => ({ agent: "not-bootstrapped", port: "foreign" }) });
  const report = await status(deps);
  assert.equal(report.healthy, false);
  assert.ok(lines.some((l) => l.includes("FOREIGN process")));
});

test("configured consumers listed from the manifest; tokens never shown; desync flagged", async () => {
  const { deps, lines } = makeDeps({
    consumers: async () => ({
      consumers: [{ id: "consumer-1", allow: ["*"], tokenSet: true }],
      orphanEnvKeys: ["BGW_CONSUMER_TOKEN_GHOST"],
    }),
  });
  await status(deps);
  assert.ok(lines.some((l) => l.includes("consumer consumer-1") && l.includes("token=set")));
  assert.ok(lines.some((l) => l.includes("BGW_CONSUMER_TOKEN_GHOST") && l.includes("desync")));
  assert.ok(!lines.some((l) => /[0-9a-f]{40,}/.test(l)), "no token-shaped value anywhere");
});

test("consumers section degrades gracefully: no admin config → skipped; SSH failure → unavailable", async () => {
  const skipped = makeDeps({ consumers: undefined });
  await status(skipped.deps);
  assert.ok(skipped.lines.some((l) => l.includes("consumers: skipped")));

  const failing = makeDeps({
    consumers: async () => {
      throw new Error("ssh: connection refused");
    },
  });
  const report = await status(failing.deps);
  assert.ok(failing.lines.some((l) => l.includes("consumers: unavailable")));
  assert.equal(report.healthy, true, "consumer listing trouble does not flip gateway health");
});

test("--stealth runs the gate and folds into health; default omits it", async () => {
  let ran = false;
  const green = makeDeps({ stealth: async () => (ran = true) });
  const greenReport = await status(green.deps, { stealth: true });
  assert.equal(ran, true);
  assert.equal(greenReport.stealthGreen, true);
  assert.ok(green.lines.some((l) => l.includes("stealth green")));

  const red = makeDeps({ stealth: async () => false });
  const redReport = await status(red.deps, { stealth: true });
  assert.equal(redReport.healthy, false, "red stealth flips overall health");
  assert.ok(red.lines.some((l) => l.includes("stealth RED")));

  const off = makeDeps({ stealth: async () => true });
  const offReport = await status(off.deps);
  assert.equal(offReport.stealthGreen, undefined);
  assert.ok(!off.lines.some((l) => l.includes("stealth")), "default omits the stealth line");
});
