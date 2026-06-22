/**
 * Gateway session-lifecycle tests. A fake browser core is injected so the lifecycle is
 * exercised with zero real browsers — fast, deterministic, no network. The real
 * end-to-end (gateway → core → public page) runs in-container via src/gateway/main.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Gateway, SessionManager, SessionManagerError } from "../dist/gateway/index.js";
import { PolicyEngine, ConsumerRegistry } from "../dist/policy/index.js";

/** A configurable fake BrowserCore factory that records created cores. */
function makeFactory({ failTimes = 0, failGuard = false } = {}) {
  const cores = [];
  let fails = failTimes;
  const factory = async () => {
    if (fails > 0) {
      fails--;
      throw new Error("boom: chrome won't start");
    }
    const core = {
      kind: "fake",
      closed: false,
      renderCalls: [],
      guardCalls: 0,
      async render(url) {
        this.renderCalls.push(url);
        if (url === "THROW") throw new Error("render boom");
        return { url, status: 200, title: "t", text: "x".repeat(1000), html: "<main/>", clearanceWaitedMs: 0 };
      },
      async setNavigationGuard(guard) {
        if (failGuard) throw new Error("guard install boom");
        this.guard = guard;
        this.guardCalls++;
      },
      async close() {
        this.closed = true;
      },
    };
    cores.push(core);
    return core;
  };
  return { factory, cores };
}

const config = (maxSessions) => ({ maxSessions, core: {} });

test("withSession: runs fn, releases the session, and closes the core", async () => {
  const { factory, cores } = makeFactory();
  const gateway = Gateway.create(config(2), factory);
  const result = await gateway.withSession((s) => s.core.render("https://example.com/"));
  assert.equal(result.status, 200);
  assert.equal(gateway.sessions.activeCount, 0, "session released");
  assert.equal(cores.length, 1);
  assert.equal(cores[0].closed, true, "core closed on release");
});

test("openConsumerSession: diagnosticsHost installs a diagnostics-only guard, independent of the consumer allowlist (issue #21 egress probe)", async () => {
  const { factory, cores } = makeFactory();
  const policy = new PolicyEngine({ registry: new ConsumerRegistry([{ id: "c", token: "tok", allow: ["totalwine.com"] }]) });
  const gw = Gateway.create(config(3), factory, policy);
  await gw.openConsumerSession("tok", undefined, { diagnosticsHost: "ipinfo.io" });
  const guard = cores[0].guard;
  const nav = (host) => ({ url: `https://${host}/json`, host, resourceType: "document", isNavigationRequest: true });
  // Restrictive consumer allowlist (totalwine.com only) — yet the diagnostics probe still reaches
  // ipinfo.io (the bug was that the consumer guard blocked it)...
  assert.equal(guard(nav("ipinfo.io")), "allow");
  // ...and the probe session is constrained to ONLY that host — not even the consumer's own host.
  assert.equal(guard(nav("totalwine.com")), "block");
  assert.equal(guard(nav("evil.example")), "block");
});

test("withSession: releases the session even when fn throws", async () => {
  const { factory, cores } = makeFactory();
  const gateway = Gateway.create(config(2), factory);
  await assert.rejects(
    gateway.withSession((s) => s.core.render("THROW")),
    /render boom/,
  );
  assert.equal(gateway.sessions.activeCount, 0, "no leaked session after error");
  assert.equal(cores[0].closed, true, "core closed despite error");
});

test("acquire: rejects with SESSION_LIMIT past the ceiling, recovers after release", async () => {
  const { factory } = makeFactory();
  const mgr = new SessionManager({ maxSessions: 1, coreFactory: factory });
  const s1 = await mgr.acquire();
  await assert.rejects(mgr.acquire(), (e) => e instanceof SessionManagerError && e.code === "SESSION_LIMIT");
  await mgr.release(s1.id);
  const s2 = await mgr.acquire(); // slot freed
  assert.equal(mgr.activeCount, 1);
  await mgr.release(s2.id);
});

test("acquire: concurrent requests never overshoot the ceiling", async () => {
  const { factory } = makeFactory();
  const mgr = new SessionManager({ maxSessions: 2, coreFactory: factory });
  const results = await Promise.allSettled([mgr.acquire(), mgr.acquire(), mgr.acquire(), mgr.acquire()]);
  const ok = results.filter((r) => r.status === "fulfilled");
  const limited = results.filter(
    (r) => r.status === "rejected" && r.reason?.code === "SESSION_LIMIT",
  );
  assert.equal(ok.length, 2, "exactly maxSessions acquired");
  assert.equal(limited.length, 2, "the rest hit SESSION_LIMIT");
  assert.equal(mgr.activeCount, 2);
  await mgr.shutdown();
});

test("acquire: a core-launch failure surfaces CORE_LAUNCH and leaks no session", async () => {
  const { factory } = makeFactory({ failTimes: 1 });
  const mgr = new SessionManager({ maxSessions: 2, coreFactory: factory });
  await assert.rejects(mgr.acquire(), (e) => e instanceof SessionManagerError && e.code === "CORE_LAUNCH");
  assert.equal(mgr.activeCount, 0, "failed launch left no session");
  const s = await mgr.acquire(); // factory recovers on the next call
  assert.equal(mgr.activeCount, 1);
  await mgr.release(s.id);
});

test("shutdown: closes every session and clears the registry", async () => {
  const { factory, cores } = makeFactory();
  const mgr = new SessionManager({ maxSessions: 3, coreFactory: factory });
  await mgr.acquire();
  await mgr.acquire();
  assert.equal(mgr.activeCount, 2);
  await mgr.shutdown();
  assert.equal(mgr.activeCount, 0);
  assert.ok(cores.every((c) => c.closed), "all cores closed");
});

test("session.core throws once the session is closed", async () => {
  const { factory } = makeFactory();
  const mgr = new SessionManager({ maxSessions: 1, coreFactory: factory });
  const s = await mgr.acquire();
  await mgr.release(s.id);
  assert.throws(() => s.core, /is closed/);
  assert.equal(s.state, "closed");
});

// --- U2: persistent, consumer-bound drive sessions -----------------------------------------

const policyFor = (consumers) => new PolicyEngine({ registry: new ConsumerRegistry(consumers) });

test("openConsumerSession: persists across use calls, installs the guard once, releases on close", async () => {
  const { factory, cores } = makeFactory();
  const policy = policyFor([{ id: "a", token: "tok-a", allow: ["example.com"] }]);
  const gw = Gateway.create(config(3), factory, policy);
  const handle = await gw.openConsumerSession("tok-a");
  assert.equal(gw.sessions.activeCount, 1);
  assert.equal(cores.length, 1);
  assert.equal(cores[0].guardCalls, 1, "consumer guard installed at open");
  const r1 = await gw.useConsumerSession("tok-a", handle, (s) => s.core.render("https://example.com/1"));
  const r2 = await gw.useConsumerSession("tok-a", handle, (s) => s.core.render("https://example.com/2"));
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(cores.length, 1, "same session/core reused across use calls (no re-acquire)");
  assert.deepEqual(cores[0].renderCalls, ["https://example.com/1", "https://example.com/2"]);
  await gw.closeConsumerSession("tok-a", handle);
  assert.equal(gw.sessions.activeCount, 0, "released on close");
  assert.equal(cores[0].closed, true);
});

test("useConsumerSession / closeConsumerSession: a consumer cannot touch another's session", async () => {
  const { factory } = makeFactory();
  const policy = policyFor([
    { id: "a", token: "tok-a", allow: ["example.com"] },
    { id: "b", token: "tok-b", allow: ["example.com"] },
  ]);
  const gw = Gateway.create(config(3), factory, policy);
  const handle = await gw.openConsumerSession("tok-a");
  await assert.rejects(gw.useConsumerSession("tok-b", handle, async () => "nope"), /no open session/);
  await gw.closeConsumerSession("tok-b", handle); // foreign close is a no-op
  assert.equal(gw.sessions.activeCount, 1, "B's close did not affect A's session");
  await gw.closeConsumerSession("tok-a", handle);
  assert.equal(gw.sessions.activeCount, 0);
});

test("openConsumerSession: an unknown token is rejected before any session opens", async () => {
  const { factory, cores } = makeFactory();
  const policy = policyFor([{ id: "a", token: "tok-a", allow: ["example.com"] }]);
  const gw = Gateway.create(config(3), factory, policy);
  await assert.rejects(gw.openConsumerSession("not-a-token"));
  assert.equal(gw.sessions.activeCount, 0);
  assert.equal(cores.length, 0, "no core launched for an unauthenticated open");
});

test("reapIdle: closes sessions idle past the TTL; a fresh one survives; reaped handle is gone", async () => {
  const { factory, cores } = makeFactory();
  const policy = policyFor([{ id: "a", token: "tok-a", allow: ["example.com"] }]);
  const gw = Gateway.create(config(3), factory, policy);
  const handle = await gw.openConsumerSession("tok-a");
  assert.deepEqual(await gw.sessions.reapIdle(60_000), [], "recently-opened session is not reaped");
  assert.equal(gw.sessions.activeCount, 1);
  const reaped = await gw.sessions.reapIdle(1_000, Date.now() + 10_000); // injected future 'now'
  assert.deepEqual(reaped, [handle]);
  assert.equal(gw.sessions.activeCount, 0);
  assert.equal(cores[0].closed, true, "reaped session's core closed");
  await assert.rejects(gw.useConsumerSession("tok-a", handle, async () => "x"), /no open session/);
});

test("openConsumerSession: enforces the per-consumer cap (default 1) independent of the global cap", async () => {
  const { factory } = makeFactory();
  const policy = policyFor([{ id: "a", token: "tok-a", allow: ["example.com"] }]);
  const gw = Gateway.create(config(5), factory, policy); // global cap generous; per-consumer cap is the limit
  const h1 = await gw.openConsumerSession("tok-a");
  await assert.rejects(
    gw.openConsumerSession("tok-a"),
    (e) => e instanceof SessionManagerError && e.code === "SESSION_LIMIT",
  );
  await gw.closeConsumerSession("tok-a", h1);
  const h2 = await gw.openConsumerSession("tok-a"); // slot freed
  assert.equal(gw.sessions.activeCount, 1);
  await gw.closeConsumerSession("tok-a", h2);
});

test("openConsumerSession: concurrent opens for one consumer never overshoot the per-consumer cap", async () => {
  const { factory } = makeFactory();
  const policy = policyFor([{ id: "a", token: "tok-a", allow: ["example.com"] }]);
  const gw = Gateway.create(config(5), factory, policy); // global cap generous; per-consumer cap is the limit
  const results = await Promise.allSettled([
    gw.openConsumerSession("tok-a"),
    gw.openConsumerSession("tok-a"),
  ]);
  const ok = results.filter((r) => r.status === "fulfilled");
  const limited = results.filter((r) => r.status === "rejected" && r.reason?.code === "SESSION_LIMIT");
  assert.equal(ok.length, 1, "exactly one concurrent open for the consumer succeeded");
  assert.equal(limited.length, 1, "the second concurrent open hit the per-consumer cap");
  assert.equal(gw.sessions.activeCount, 1, "no per-consumer overshoot");
  await gw.shutdown();
});

test("shutdown: closes open interactive sessions (no orphaned browsers)", async () => {
  const { factory, cores } = makeFactory();
  const policy = policyFor([{ id: "a", token: "tok-a", allow: ["example.com"] }]);
  const gw = Gateway.create(config(3), factory, policy);
  await gw.openConsumerSession("tok-a");
  assert.equal(gw.sessions.activeCount, 1);
  await gw.shutdown();
  assert.equal(gw.sessions.activeCount, 0);
  assert.equal(cores[0].closed, true);
});

test("touch() advances lastActivityAt so a freshly-used session survives the reaper", async () => {
  const { factory } = makeFactory();
  const policy = policyFor([{ id: "a", token: "tok-a", allow: ["example.com"] }]);
  const gw = Gateway.create(config(3), factory, policy);
  const handle = await gw.openConsumerSession("tok-a");
  const session = gw.sessions.get(handle);
  const created = session.lastActivityAt;
  await new Promise((r) => setTimeout(r, 5)); // let the wall clock advance a few ms
  session.touch();
  assert.ok(session.lastActivityAt > created, "touch advanced lastActivityAt past creation");
  const t = session.lastActivityAt;
  // The reaper keys off lastActivityAt, which touch() just refreshed: a now within the TTL of the
  // last touch spares the session even though it is older than the TTL by its creation time.
  assert.deepEqual(await gw.sessions.reapIdle(1_000, t + 500), [], "within TTL of last touch -> survives");
  assert.deepEqual(await gw.sessions.reapIdle(1_000, t + 2_000), [handle], "past TTL of last touch -> reaped");
});

test("per-consumer cap counts only consumer-bound sessions, not transient retrieve sessions", async () => {
  const { factory } = makeFactory();
  const policy = policyFor([{ id: "a", token: "tok-a", allow: ["example.com"] }]);
  const gw = Gateway.create(config(5), factory, policy); // global cap generous; per-consumer cap is 1
  const handle = await gw.openConsumerSession("tok-a"); // tok-a now at its per-consumer cap
  const r = await gw.withSession((s) => s.core.render("https://example.com/"));
  assert.equal(r.status, 200, "a transient session still runs while a drive session is held");
  assert.equal(gw.sessions.activeCount, 1, "transient released; only the held drive session remains");
  await gw.closeConsumerSession("tok-a", handle);
  assert.equal(gw.sessions.activeCount, 0);
});

test("openConsumerSession: releases the half-open session if guard install fails (no leak)", async () => {
  const { factory, cores } = makeFactory({ failGuard: true });
  const policy = policyFor([{ id: "a", token: "tok-a", allow: ["example.com"] }]);
  const gw = Gateway.create(config(3), factory, policy);
  await assert.rejects(gw.openConsumerSession("tok-a"), /guard install boom/);
  assert.equal(gw.sessions.activeCount, 0, "no half-open session left after guard-install failure");
  assert.equal(cores[0].closed, true, "the half-open session's core was closed");
});
