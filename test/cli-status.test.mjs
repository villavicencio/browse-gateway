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

// --- issue #53: the pool-health section ------------------------------------------------------------

const POOL_OK_BODY = { status: "ok", forceKillAvailable: true, unconfirmedCount: 0, orphanCount: 0, watchedCount: 0, activeCount: 1, maxSessions: 2 };
const POOL_DEGRADED_BODY = { status: "degraded", forceKillAvailable: false, unconfirmedCount: 1, orphanCount: 1, watchedCount: 1, activeCount: 2, maxSessions: 2 };

test("#53: a healthy pool renders its counters and stays healthy", async () => {
  const { deps, lines } = makeDeps({ poolHealth: async () => ({ code: "200", body: POOL_OK_BODY }) });
  const report = await status(deps);
  assert.equal(report.healthy, true);
  assert.equal(report.pool, "ok");
  assert.ok(lines.some((l) => l.includes("pool healthy") && l.includes("1/2 sessions")), `got: ${lines.join(" | ")}`);
});

test("#53: a DEGRADED pool flips overall health and names each degradation", async () => {
  const { deps, lines } = makeDeps({ poolHealth: async () => ({ code: "200", body: POOL_DEGRADED_BODY }) });
  const report = await status(deps);
  assert.equal(report.healthy, false, "a degraded pool is UNHEALTHY even though /mcp answers");
  assert.equal(report.owl, "down");
  assert.equal(report.pool, "degraded");
  assert.ok(lines.some((l) => l.includes("pool DEGRADED")));
  assert.ok(lines.some((l) => l.includes("force-kill unavailable")));
  assert.ok(lines.some((l) => l.includes("1 browser teardown(s) unconfirmed")));
  assert.ok(lines.some((l) => l.includes("1 live orphaned launch(es)")));
  assert.ok(lines.some((l) => l.includes("1 pending wedge(s) under watch")));
});

test("#53: a rejected/unreadable health read renders 'unavailable' without failing overall health", async () => {
  const { deps, lines } = makeDeps({ poolHealth: async () => ({ code: "401" }) });
  const report = await status(deps);
  assert.equal(report.pool, "unavailable");
  assert.equal(report.healthy, true, "a token/rollout mismatch is surfaced, not a health failure");
  assert.ok(lines.some((l) => l.includes("pool health: unavailable")), `got: ${lines.join(" | ")}`);
});

test("#53: no healthToken configured → the pool section is skipped with the enable hint", async () => {
  const { deps, lines } = makeDeps(); // no poolHealth dep
  const report = await status(deps);
  assert.equal(report.pool, undefined);
  assert.ok(lines.some((l) => l.includes("pool health: skipped") && l.includes("healthToken")), `got: ${lines.join(" | ")}`);
});

test("#53: a pool at capacity renders the amber note but stays healthy", async () => {
  const { deps, lines } = makeDeps({
    poolHealth: async () => ({ code: "200", body: { ...POOL_OK_BODY, activeCount: 2 } }),
  });
  const report = await status(deps);
  assert.equal(report.healthy, true);
  assert.ok(lines.some((l) => l.includes("pool is at capacity")), `got: ${lines.join(" | ")}`);
});

test("#53 end-to-end: a degraded live core flips external health through the REAL http route + probe (the AC)", async () => {
  const { createServer } = await import("node:http");
  const { createHttpHandler } = await import("../dist/mcp/index.js");
  const { buildOperatorHealth } = await import("../dist/mcp/http-server.js");
  const { healthProbe } = await import("../dist/cli/index.js");

  // A fake pool in the degraded shape #50/#54 produce (a markerless / force-kill-unavailable core).
  const pool = { forceKillAvailable: false, unconfirmedCount: 1, orphanCount: 0, watchedCount: 0, activeCount: 1, maxSessions: 2 };
  const handler = createHttpHandler({
    authenticate: () => { throw new Error("no consumers in this test"); },
    buildServer: () => { throw new Error("never"); },
    healthToken: "op-secret",
    operatorHealth: () => buildOperatorHealth(pool),
  });
  const server = createServer((req, res) => void handler.handle(req, res).catch(() => res.end()));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const { deps, lines } = makeDeps({
      poolHealth: healthProbe(port, "127.0.0.1:8080", "op-secret"),
    });
    const report = await status(deps);
    assert.equal(report.pool, "degraded", "the degraded core surfaced through the real route + real probe");
    assert.equal(report.healthy, false, "external health flipped end to end");
    assert.ok(lines.some((l) => l.includes("force-kill unavailable")));

    // And the fix side: the pool recovers → external health goes green through the same path.
    pool.forceKillAvailable = true;
    pool.unconfirmedCount = 0;
    const { deps: deps2 } = makeDeps({ poolHealth: healthProbe(port, "127.0.0.1:8080", "op-secret") });
    const report2 = await status(deps2);
    assert.equal(report2.pool, "ok");
    assert.equal(report2.healthy, true);
  } finally {
    await new Promise((r) => server.close(r));
    server.closeAllConnections?.();
  }
});

test("#53 r1: a bare consumer-tier body (healthToken misconfigured to a consumer key) reads as UNAVAILABLE, never healthy", async () => {
  const { deps, lines } = makeDeps({ poolHealth: async () => ({ code: "200", body: { status: "ok" } }) });
  const report = await status(deps);
  assert.equal(report.pool, "unavailable", "a counters-free body must not claim the pool is verified healthy");
  assert.ok(lines.some((l) => l.includes("pool health: unavailable")), `got: ${lines.join(" | ")}`);
});
