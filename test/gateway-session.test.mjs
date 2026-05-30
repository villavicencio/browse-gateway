/**
 * Gateway session-lifecycle tests. A fake browser core is injected so the lifecycle is
 * exercised with zero real browsers — fast, deterministic, no network. The real
 * end-to-end (gateway → core → public page) runs in-container via src/gateway/main.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Gateway, SessionManager, SessionManagerError } from "../dist/gateway/index.js";

/** A configurable fake BrowserCore factory that records created cores. */
function makeFactory({ failTimes = 0 } = {}) {
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
      async render(url) {
        this.renderCalls.push(url);
        if (url === "THROW") throw new Error("render boom");
        return { url, status: 200, title: "t", text: "x".repeat(1000), html: "<main/>", clearanceWaitedMs: 0 };
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
