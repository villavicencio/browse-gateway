/**
 * Gateway session-lifecycle tests. A fake browser core is injected so the lifecycle is
 * exercised with zero real browsers — fast, deterministic, no network. The real
 * end-to-end (gateway → core → public page) runs in-container via src/gateway/main.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Gateway, SessionManager, SessionManagerError, MAX_INFLIGHT_MS } from "../dist/gateway/index.js";
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
      killed: false,
      forceKillAvailable: true,
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
      async kill() {
        this.killed = true;
        this.closed = true;
      },
    };
    cores.push(core);
    return core;
  };
  return { factory, cores };
}

/**
 * A fully controllable fake core for the issue #50 teardown/force-kill tests. `close()` and `kill()`
 * behaviors are mutable per-core: "resolve" (settles cleanly), "reject" (fails fast), or "hang" (never
 * settles until `releaseClose()`/`releaseKill()`). Records call counts so a test can assert close was
 * NOT re-run on the reconfirm path, etc.
 */
function makeControllableCore({ closeMode = "resolve", killMode = "resolve", forceKillAvailable = true } = {}) {
  let closeRelease;
  let killRelease;
  const core = {
    kind: "fake",
    closed: false,
    killed: false,
    forceKillAvailable,
    closeCalls: 0,
    killCalls: 0,
    closeMode,
    killMode,
    async render(url) {
      return { url, status: 200, title: "t", text: "x".repeat(1000), html: "<main/>", clearanceWaitedMs: 0 };
    },
    async setNavigationGuard(guard) {
      this.guard = guard;
    },
    async close() {
      this.closeCalls++;
      if (this.closeMode === "resolve") {
        this.closed = true;
        return;
      }
      if (this.closeMode === "reject") throw new Error("close boom");
      return new Promise((resolve, reject) => {
        closeRelease = (ok) => {
          if (ok) {
            this.closed = true;
            resolve();
          } else reject(new Error("close boom (late)"));
        };
      });
    },
    async kill() {
      this.killCalls++;
      if (this.killMode === "resolve") {
        this.killed = true;
        this.closed = true;
        return;
      }
      if (this.killMode === "reject") throw new Error("kill unconfirmed");
      return new Promise((resolve, reject) => {
        killRelease = (ok) => {
          if (ok) {
            this.killed = true;
            this.closed = true;
            resolve();
          } else reject(new Error("kill unconfirmed (late)"));
        };
      });
    },
    releaseClose(ok = true) {
      closeRelease?.(ok);
    },
    releaseKill(ok = true) {
      killRelease?.(ok);
    },
  };
  return core;
}

/** A factory yielding controllable cores; per-acquire config comes from `configs` (array = one per
 *  acquire, last repeats; object = same for all). `cores` collects each built core for assertions. */
function makeControllableFactory(configs = {}) {
  const cores = [];
  let i = 0;
  const factory = async () => {
    const cfg = Array.isArray(configs) ? configs[Math.min(i, configs.length - 1)] : configs;
    i++;
    const core = makeControllableCore(cfg);
    cores.push(core);
    return core;
  };
  return { factory, cores };
}

/** A promise plus its resolver — a launch gate for the acquire⇄shutdown race test. */
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Yield to the event loop so pending microtasks/timers settle. */
const tick = () => new Promise((r) => setTimeout(r, 5));

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
  await gw.openConsumerSession("tok", undefined, { diagnostics: true });
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

test("reapIdle: an in-flight session (inFlight > 0) is NOT reaped for being idle within the max-in-flight deadline; it is reaped once inFlight returns to 0", async () => {
  const { factory, cores } = makeFactory();
  const policy = policyFor([{ id: "a", token: "tok-a", allow: ["example.com"] }]);
  const gw = Gateway.create(config(3), factory, policy);
  const handle = await gw.openConsumerSession("tok-a");
  const session = gw.sessions.get(handle);

  session.beginActivity(); // a normal long navigate is now in flight on this session
  assert.equal(session.inFlight, 1);
  // Past the idle TTL by wall-clock but WELL within the max-in-flight deadline -> the reaper MUST
  // skip it (mirrors http-server:249; the idle branch requires inFlight === 0).
  assert.deepEqual(await gw.sessions.reapIdle(1_000, Date.now() + 1_000), [], "in-flight within ceiling -> not reaped");
  assert.equal(gw.sessions.activeCount, 1, "in-flight session survived the reaper");
  assert.equal(cores[0].closed, false, "core stayed open during the in-flight navigate");

  session.endActivity(); // navigate completed; activity re-stamped, inFlight back to 0
  assert.equal(session.inFlight, 0);
  // Genuinely idle now: past the TTL of the completion stamp -> reaped (non-regression).
  assert.deepEqual(await gw.sessions.reapIdle(1_000, Date.now() + 600_000), [handle], "idle -> reaped");
  assert.equal(gw.sessions.activeCount, 0);
  assert.equal(cores[0].closed, true, "genuinely-idle session's core closed");
});

test("reapIdle: a WEDGED verb (in-flight past the max-in-flight deadline) IS reaped so its slot can't leak forever", async () => {
  const { factory, cores } = makeFactory();
  const policy = policyFor([{ id: "a", token: "tok-a", allow: ["example.com"] }]);
  const gw = Gateway.create(config(3), factory, policy);
  const handle = await gw.openConsumerSession("tok-a");
  const session = gw.sessions.get(handle);

  // Simulate a hung browser/CDP: a verb enters but its finally never runs, so endActivity never fires.
  session.beginActivity();
  assert.equal(session.inFlight, 1);
  // Still within the deadline -> held (would leak nothing yet).
  assert.deepEqual(await gw.sessions.reapIdle(1_000, Date.now() + MAX_INFLIGHT_MS - 10_000), [], "within deadline -> held");
  assert.equal(gw.sessions.activeCount, 1);
  // Past inFlightSince + MAX_INFLIGHT_MS -> reclaimed despite inFlight still > 0, and the browser closed.
  const reaped = await gw.sessions.reapIdle(1_000, Date.now() + MAX_INFLIGHT_MS + 60_000);
  assert.deepEqual(reaped, [handle], "wedged in-flight verb past the deadline is reaped");
  assert.equal(gw.sessions.activeCount, 0, "the leaked slot was reclaimed");
  assert.equal(cores[0].closed, true, "the hung browser was closed");
});

test("useConsumerSession: holds a session in-flight for the whole verb, so a navigate crossing the TTL survives", async () => {
  const { factory, cores } = makeFactory();
  const policy = policyFor([{ id: "a", token: "tok-a", allow: ["example.com"] }]);
  const gw = Gateway.create(config(3), factory, policy);
  const handle = await gw.openConsumerSession("tok-a");

  // Start a long verb and hold it in-flight on a promise we control (a stand-in for a multi-second
  // navigate). beginActivity() runs synchronously before the first await, so inFlight is already 1.
  let release;
  const gate = new Promise((r) => { release = r; });
  const inflight = gw.useConsumerSession("tok-a", handle, async () => {
    await gate;
    return "done";
  });
  assert.equal(gw.sessions.get(handle).inFlight, 1, "verb marked the session in-flight");

  // The reaper fires while the verb is still awaiting, past the idle TTL but within the max-in-flight
  // deadline — the session must survive (a normal long navigate is nowhere near the ceiling).
  assert.deepEqual(await gw.sessions.reapIdle(1_000, Date.now() + 1_000), [], "in-flight verb not reaped");
  assert.equal(gw.sessions.activeCount, 1);
  assert.equal(cores[0].closed, false);

  release();
  assert.equal(await inflight, "done", "the long verb still resolved to its caller");
  assert.equal(gw.sessions.get(handle).inFlight, 0, "in-flight count released on completion");
});

test("useConsumerSession: a synchronously-throwing verb still runs endActivity (no leaked in-flight count)", async () => {
  const { factory } = makeFactory();
  const policy = policyFor([{ id: "a", token: "tok-a", allow: ["example.com"] }]);
  const gw = Gateway.create(config(3), factory, policy);
  const handle = await gw.openConsumerSession("tok-a");
  const session = gw.sessions.get(handle);

  await assert.rejects(
    gw.useConsumerSession("tok-a", handle, () => { throw new Error("sync boom"); }),
    /sync boom/,
  );
  // finally ran despite the synchronous throw: inFlight is back to 0 (no underflow, no stuck slot)...
  assert.equal(session.inFlight, 0, "in-flight count released after a throwing verb");
  assert.equal(session.inFlightMs(Date.now() + 600_000), 0, "in-flight-burst clock cleared");
  // ...so the session is a normal idle session again: reaped when genuinely idle, not before.
  assert.deepEqual(await gw.sessions.reapIdle(1_000, Date.now()), [], "not reaped while fresh");
  assert.deepEqual(await gw.sessions.reapIdle(1_000, Date.now() + 600_000), [handle], "reaped once idle");
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

// --- issue #50: confirmable teardown + force-kill -------------------------------------------------

const teardownMgr = (maxSessions, factory, perConsumerMax) =>
  new SessionManager({
    maxSessions,
    coreFactory: factory,
    closeGraceMs: 30,
    killConfirmMs: 30,
    ...(perConsumerMax ? { perConsumerMax } : {}),
  });

test("teardown: a clean close frees the slot without force-killing (non-regression)", async () => {
  const { factory, cores } = makeControllableFactory({ closeMode: "resolve" });
  const mgr = teardownMgr(1, factory);
  const s = await mgr.acquire();
  await mgr.release(s.id);
  assert.equal(mgr.activeCount, 0, "slot freed on clean close");
  assert.equal(cores[0].closed, true);
  assert.equal(cores[0].killed, false, "a clean close never force-kills");
  assert.equal(cores[0].killCalls, 0);
});

test("teardown: a wedged close escalates to force-kill (grace path) and reclaims the slot", async () => {
  const { factory, cores } = makeControllableFactory({ closeMode: "hang", killMode: "resolve" });
  const mgr = teardownMgr(1, factory);
  const s = await mgr.acquire();
  await mgr.release(s.id); // close hangs → grace elapses → kill resolves
  assert.equal(mgr.activeCount, 0, "slot reclaimed after force-kill");
  assert.equal(cores[0].killed, true, "the wedged browser was force-killed");
  assert.equal(cores[0].closeCalls, 1);
  assert.equal(cores[0].killCalls, 1);
});

test("teardown: a rejected close escalates to force-kill and reclaims the slot", async () => {
  const { factory, cores } = makeControllableFactory({ closeMode: "reject", killMode: "resolve" });
  const mgr = teardownMgr(1, factory);
  const s = await mgr.acquire();
  await mgr.release(s.id);
  assert.equal(mgr.activeCount, 0);
  assert.equal(cores[0].killed, true, "a rejected close is not mistaken for a dead browser — it force-kills");
  assert.equal(cores[0].killCalls, 1);
});

test("teardown: a wedged close keeps the slot COUNTED until the kill confirms (cap-safe)", async () => {
  // A failed close whose force-kill is still in flight must NOT free capacity for a replacement while
  // the browser may still be alive.
  const { factory, cores } = makeControllableFactory({ closeMode: "reject", killMode: "hang" });
  const mgr = teardownMgr(1, factory);
  const s = await mgr.acquire();
  const relP = mgr.release(s.id); // close rejects → kill called → hangs (unconfirmed so far)
  await tick();
  assert.equal(mgr.activeCount, 1, "slot stays counted while the kill is unconfirmed");
  await assert.rejects(mgr.acquire(), (e) => e.code === "SESSION_LIMIT", "no replacement admitted past the cap");
  cores[0].releaseKill(true); // kill confirms → dead
  await relP;
  assert.equal(mgr.activeCount, 0, "slot reclaimed only after the kill confirms");
  assert.equal(cores[0].killed, true);
});

test("teardown: per-consumer cap counts a session mid-teardown too", async () => {
  const { factory, cores } = makeControllableFactory({ closeMode: "reject", killMode: "hang" });
  const mgr = teardownMgr(3, factory, 1); // per-consumer cap 1, global headroom
  const s = await mgr.acquire(undefined, { consumerId: "a" });
  const relP = mgr.release(s.id);
  await tick();
  await assert.rejects(
    mgr.acquire(undefined, { consumerId: "a" }),
    (e) => e.code === "SESSION_LIMIT",
    "a wedged-teardown session still counts against its consumer's cap",
  );
  cores[0].releaseKill(true);
  await relP;
});

test("teardown: an unconfirmed force-kill stays counted, then self-heals on the next reap (kill-only)", async () => {
  const { factory, cores } = makeControllableFactory({ closeMode: "reject", killMode: "reject" });
  const mgr = teardownMgr(1, factory);
  const s = await mgr.acquire();
  await mgr.release(s.id); // close rejects → kill rejects (unconfirmed) → zombie, still counted
  assert.equal(mgr.activeCount, 1, "an unconfirmed kill keeps the session counted (cap-safe zombie)");
  await assert.rejects(mgr.acquire(), (e) => e.code === "SESSION_LIMIT");
  assert.equal(cores[0].closeCalls, 1, "close was attempted once");
  // The process is now reapable; the reconfirm loop must retry the KILL only — never re-run close.
  cores[0].killMode = "resolve";
  await mgr.reapIdle(60_000, Date.now());
  assert.equal(mgr.activeCount, 0, "slot reclaimed once the reconfirm confirms death");
  assert.equal(cores[0].killed, true);
  assert.equal(cores[0].closeCalls, 1, "reconfirm is KILL-ONLY — core.close() was never re-run");
  assert.ok(cores[0].killCalls >= 2, "the kill was retried");
});

test("reapIdle: a never-settling transient (untagged) wedged past the deadline IS reaped (issue #49)", async () => {
  const { factory, cores } = makeControllableFactory({ closeMode: "resolve" });
  const mgr = teardownMgr(1, factory);
  const s = await mgr.acquire(); // untagged transient (no consumerId)
  s.beginActivity(); // withSession stamps this around a hung render
  const future = Date.now() + MAX_INFLIGHT_MS + 1_000;
  const reaped = await mgr.reapIdle(60_000, future, MAX_INFLIGHT_MS);
  assert.deepEqual(reaped, [s.id], "the wedged untagged transient was reclaimed");
  assert.equal(mgr.activeCount, 0);
  assert.equal(cores[0].closed, true);
});

test("reapIdle: a healthy in-flight transient is NOT reaped (non-regression)", async () => {
  const { factory } = makeControllableFactory({ closeMode: "resolve" });
  const mgr = teardownMgr(1, factory);
  const s = await mgr.acquire();
  s.beginActivity();
  const reaped = await mgr.reapIdle(60_000, Date.now(), MAX_INFLIGHT_MS);
  assert.deepEqual(reaped, [], "an in-flight transient within the deadline survives");
  assert.equal(mgr.activeCount, 1);
});

test("reapIdle: an idle untagged transient is NOT idle-reaped (idle branch is consumer-only)", async () => {
  const { factory } = makeControllableFactory({ closeMode: "resolve" });
  const mgr = teardownMgr(1, factory);
  await mgr.acquire(); // untagged, inFlight 0
  const future = Date.now() + 10_000_000;
  const reaped = await mgr.reapIdle(0, future, MAX_INFLIGHT_MS); // ttl 0 → everything is "idle"
  assert.deepEqual(reaped, [], "an untagged transient is invisible to the idle-TTL branch");
  assert.equal(mgr.activeCount, 1);
});

test("reapIdle: skips a session already tearing down (no double close)", async () => {
  const { factory, cores } = makeControllableFactory({ closeMode: "reject", killMode: "hang" });
  const mgr = teardownMgr(1, factory);
  const s = await mgr.acquire(undefined, { consumerId: "a" });
  s.beginActivity();
  const relP = mgr.release(s.id); // teardown in flight (in #closing); kill hangs
  await tick();
  const future = Date.now() + MAX_INFLIGHT_MS + 1_000;
  const reaped = await mgr.reapIdle(60_000, future, MAX_INFLIGHT_MS);
  assert.equal(reaped.includes(s.id), false, "a session mid-teardown is not re-selected");
  assert.equal(cores[0].closeCalls, 1, "close was not run a second time");
  cores[0].releaseKill(true);
  await relP;
});

test("shutdown: refuses new acquires and AWAITS a pending teardown", async () => {
  const { factory, cores } = makeControllableFactory({ closeMode: "reject", killMode: "hang" });
  const mgr = teardownMgr(1, factory);
  const s = await mgr.acquire();
  const relP = mgr.release(s.id); // teardown pending on the hanging kill
  await tick();
  let shutDone = false;
  const shutP = mgr.shutdown().then(() => {
    shutDone = true;
  });
  await tick();
  assert.equal(shutDone, false, "shutdown blocks on the pending teardown");
  await assert.rejects(mgr.acquire(), (e) => e.code === "SESSION_LIMIT", "acquire refused mid-shutdown");
  cores[0].releaseKill(true);
  await relP;
  await shutP;
  assert.equal(shutDone, true, "shutdown completes once the teardown confirms");
  assert.equal(mgr.activeCount, 0);
  assert.equal(cores[0].killed, true);
});

test("acquire racing shutdown: the launched core is torn down and never registered", async () => {
  const gate = deferred();
  const built = [];
  const factory = async () => {
    await gate.promise; // hold the launch open until the test releases it
    const core = makeControllableCore({ closeMode: "resolve" });
    built.push(core);
    return core;
  };
  const mgr = teardownMgr(2, factory);
  const acqP = mgr.acquire(); // enters #launchAndRegister, blocks on the gate
  await tick();
  const shutP = mgr.shutdown(); // flips #shuttingDown, awaits #launching (this acquire)
  await tick();
  gate.resolve(); // factory resolves → re-check sees shutting down → self-teardown the orphan, throw
  await assert.rejects(acqP, (e) => e.code === "SESSION_LIMIT");
  await shutP;
  assert.equal(built.length, 1, "the core did launch");
  assert.equal(built[0].closed, true, "the shutdown-racing orphan was torn down");
  assert.equal(mgr.activeCount, 0, "the orphan was never registered as a session");
});

test("forceKillAvailable: surfaces false when a core cannot capture its PID (health signal)", async () => {
  const { factory } = makeControllableFactory({ forceKillAvailable: false });
  const mgr = teardownMgr(1, factory);
  const s = await mgr.acquire();
  assert.equal(mgr.forceKillAvailable, false, "manager reports force-kill degraded");
  assert.equal(s.info.forceKillAvailable, false, "session info surfaces the degradation");
});

test("teardown: with force-kill unavailable, a wedged close stays a counted zombie (documented degrade)", async () => {
  // No PID captured → kill() rejects immediately ("unavailable"). A wedged close then has no recourse and
  // stays counted (reverts to pre-#50 behavior) rather than false-freeing a slot.
  const { factory } = makeControllableFactory({ closeMode: "reject", killMode: "reject", forceKillAvailable: false });
  const mgr = teardownMgr(1, factory);
  const s = await mgr.acquire();
  await mgr.release(s.id);
  assert.equal(mgr.activeCount, 1, "no PID → no confirmed death → slot stays counted (never false-freed)");
});

test("shutdown: RETAINS a session whose death cannot be confirmed (never erases a possibly-live browser)", async () => {
  // close rejects and every kill rejects → shutdown must not report a clean, empty manager while the
  // browser may still be alive (issue #50 invariant; caught by Codex adversarial review).
  const { factory } = makeControllableFactory({ closeMode: "reject", killMode: "reject" });
  const mgr = teardownMgr(1, factory);
  const s = await mgr.acquire();
  await mgr.shutdown();
  assert.equal(mgr.activeCount, 1, "an unconfirmed-dead session is retained, not erased");
  assert.equal(mgr.unconfirmedCount, 1, "the unconfirmed browser is observable via unconfirmedCount");
});

test("shutdown: a shutdown-racing orphan whose kill keeps failing is retained (not silently dropped)", async () => {
  const gate = deferred();
  const factory = async () => {
    await gate.promise;
    return makeControllableCore({ closeMode: "reject", killMode: "reject" });
  };
  const mgr = teardownMgr(2, factory);
  const acqP = mgr.acquire();
  await tick();
  const shutP = mgr.shutdown();
  await tick();
  gate.resolve(); // orphan launches into a shutting-down manager → self-teardown fails to confirm
  await assert.rejects(acqP, (e) => e.code === "SESSION_LIMIT");
  await shutP;
  assert.equal(mgr.unconfirmedCount, 1, "the unconfirmed orphan core is retained for observation");
});

test("shutdown: confirmed teardowns leave the manager empty (no retained accounting)", async () => {
  const { factory } = makeControllableFactory({ closeMode: "resolve" });
  const mgr = teardownMgr(2, factory);
  await mgr.acquire();
  await mgr.acquire();
  await mgr.shutdown();
  assert.equal(mgr.activeCount, 0, "clean closes fully drain the registry");
  assert.equal(mgr.unconfirmedCount, 0);
});

test("reconfirm is single-flight: overlapping drains issue exactly one kill per session (codex #50 r2)", async () => {
  const { factory, cores } = makeControllableFactory({ closeMode: "reject", killMode: "reject" });
  const mgr = teardownMgr(1, factory);
  const s = await mgr.acquire();
  await mgr.release(s.id); // close rejects, kill rejects → #unconfirmed, killCalls = 1
  assert.equal(cores[0].killCalls, 1);
  cores[0].killMode = "hang"; // the reconfirm's kill hangs until released, holding the single-flight window open
  const r1 = mgr.reapIdle(60_000, Date.now()); // → #drainUnconfirmed → reconfirm
  const r2 = mgr.reapIdle(60_000, Date.now()); // concurrent second drain
  await tick();
  assert.equal(cores[0].killCalls, 2, "one reconfirm kill despite two concurrent drains (1 initial + 1 shared)");
  assert.equal(cores[0].closeCalls, 1, "reconfirm never re-ran close");
  cores[0].releaseKill(true);
  await Promise.all([r1, r2]);
  assert.equal(mgr.activeCount, 0, "the shared reconfirm reclaimed the slot");
});
