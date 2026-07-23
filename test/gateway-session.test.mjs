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
      groupAlive: true, // the "process group" — a clean close reaps it; kill() short-circuits once empty
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
        this.groupAlive = false; // a clean close reaps the whole process tree
      },
      async kill() {
        if (!this.groupAlive) return; // group already empty (clean close) → confirm without force-killing
        this.killed = true;
        this.closed = true;
        this.groupAlive = false;
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
    groupAlive: true, // the "process group": a clean close reaps it; kill() confirms-empty without a force-kill
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
        this.groupAlive = false; // clean close reaps the tree
        return;
      }
      if (this.closeMode === "reject") throw new Error("close boom");
      return new Promise((resolve, reject) => {
        closeRelease = (ok) => {
          if (ok) {
            this.closed = true;
            this.groupAlive = false;
            resolve();
          } else reject(new Error("close boom (late)"));
        };
      });
    },
    async kill() {
      this.killCalls++;
      if (!this.forceKillAvailable) throw new Error("force-kill unavailable"); // no PID captured
      if (!this.groupAlive) return; // group already empty (e.g. after a clean close) → confirmed, no SIGKILL
      if (this.killMode === "resolve") {
        this.killed = true;
        this.closed = true;
        this.groupAlive = false;
        return;
      }
      if (this.killMode === "reject") throw new Error("kill unconfirmed"); // group stays alive (unconfirmed)
      return new Promise((resolve, reject) => {
        killRelease = (ok) => {
          if (ok) {
            this.killed = true;
            this.closed = true;
            this.groupAlive = false;
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

test("teardown: a clean close frees the slot without force-killing (group already empty)", async () => {
  const { factory, cores } = makeControllableFactory({ closeMode: "resolve" });
  const mgr = teardownMgr(1, factory);
  const s = await mgr.acquire();
  await mgr.release(s.id);
  assert.equal(mgr.activeCount, 0, "slot freed on clean close");
  assert.equal(cores[0].closed, true);
  assert.equal(cores[0].killed, false, "a clean close never actually SIGKILLs");
  assert.equal(cores[0].killCalls, 1, "kill() is called to CONFIRM the group is empty, but short-circuits");
});

test("teardown: a clean close with a lingering child force-kills the survivor before freeing (codex #50 r4)", async () => {
  // close() resolves but the process group is NOT empty (a renderer survived) → the group-confirm must
  // escalate to a force-kill rather than free the slot with a live subprocess.
  const { factory, cores } = makeControllableFactory({ closeMode: "resolve", killMode: "resolve" });
  const mgr = teardownMgr(1, factory);
  const s = await mgr.acquire();
  cores[0].groupAlive = true; // simulate: close resolves but a child lingers in the group
  const origClose = cores[0].close.bind(cores[0]);
  cores[0].close = async function () {
    await origClose();
    this.groupAlive = true; // a renderer survived the "clean" close
  };
  await mgr.release(s.id);
  assert.equal(mgr.activeCount, 0, "slot freed only after the survivor was reaped");
  assert.equal(cores[0].killed, true, "the lingering child was force-killed before the slot freed");
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

// --- issue #54: acquire-side wedge — a never-settling factory launch must not pin its reserved slot -------

test("acquire: a launch that never settles fails as CORE_LAUNCH and releases its reserved slot within the deadline (issue #54)", async () => {
  const wedge = deferred(); // never resolved → the first factory launch hangs forever
  let hang = true;
  const factory = async () => {
    if (hang) {
      hang = false; // only the FIRST launch wedges; the recovery launch proceeds normally
      await wedge.promise; // never settles within this test
    }
    return makeControllableCore({ closeMode: "resolve" });
  };
  // Tiny launch deadline so the wedge is failed near-instantly (real default is minutes).
  const mgr = new SessionManager({ maxSessions: 1, coreFactory: factory, launchDeadlineMs: 30 });

  // The wedged launch must FAIL (not hang) — CORE_LAUNCH, surfaced within the deadline.
  await assert.rejects(
    mgr.acquire(),
    (e) => e instanceof SessionManagerError && e.code === "CORE_LAUNCH",
  );
  assert.equal(mgr.activeCount, 0, "the wedged launch registered no session");

  // The reserved slot was released by acquire's finally, so a fresh acquire is admitted despite
  // maxSessions: 1 — proving the hung launch did NOT pin capacity toward a permanent SESSION_LIMIT.
  const s = await mgr.acquire();
  assert.equal(mgr.activeCount, 1, "reserved slot freed → a replacement acquire succeeds past the cap");
  await mgr.release(s.id);
  assert.equal(mgr.activeCount, 0);
});

test("shutdown: returns instead of hanging when an in-flight launch never settles (issue #54)", async () => {
  const wedge = deferred(); // the launch wedges: the factory never resolves
  const factory = async () => {
    await wedge.promise;
    return makeControllableCore({ closeMode: "resolve" });
  };
  const mgr = new SessionManager({
    maxSessions: 1,
    coreFactory: factory,
    launchDeadlineMs: 30,
    closeGraceMs: 30,
    killConfirmMs: 30,
  });

  const acqP = mgr.acquire(); // enters #launchAndRegister and wedges on the factory
  const acqRejects = assert.rejects(acqP, (e) => e.code === "CORE_LAUNCH"); // attach the handler now
  await tick();

  // shutdown() must not hang on the never-settling #launching entry: the bounded launch/allSettled wait
  // lets it return. If either bound regressed, this await never resolves and the test times out.
  let done = false;
  await mgr.shutdown().then(() => {
    done = true;
  });
  assert.equal(done, true, "shutdown completed despite the wedged in-flight launch");
  assert.equal(mgr.activeCount, 0, "no session registered for the wedged launch");
  await acqRejects; // the wedged acquire settled as CORE_LAUNCH, not left dangling
});

test("acquire: a factory that throws SYNCHRONOUSLY surfaces CORE_LAUNCH and frees the slot (issue #54, codex r1)", async () => {
  // A custom factory (or a sync guard) that throws BEFORE returning its promise must be normalized to the
  // documented CORE_LAUNCH — the bounded-launch race only sees the async-rejection arm, so the synchronous
  // throw needs its own guard. It must also release the reserved slot (via acquire's finally).
  let first = true;
  const factory = () => {
    if (first) {
      first = false;
      throw new Error("synchronous launch boom"); // throws BEFORE returning a promise
    }
    return Promise.resolve(makeControllableCore({ closeMode: "resolve" }));
  };
  const mgr = new SessionManager({ maxSessions: 1, coreFactory: factory });

  await assert.rejects(
    mgr.acquire(),
    (e) => e instanceof SessionManagerError && e.code === "CORE_LAUNCH",
  );
  assert.equal(mgr.activeCount, 0, "the sync-throwing launch registered no session");

  // The reserved slot was released, so a working acquire is admitted under maxSessions: 1.
  const s = await mgr.acquire();
  assert.equal(mgr.activeCount, 1, "reserved slot freed after the sync throw → a replacement acquire succeeds");
  await mgr.release(s.id);
  assert.equal(mgr.activeCount, 0);
});

test("acquire: a launch that RESOLVES after the deadline is torn down, not leaked (cap-safe) (issue #54, codex r1)", async () => {
  const gate = deferred(); // holds the first launch open until AFTER the deadline has fired
  const late = makeControllableCore({ closeMode: "resolve" }); // the core the wedged launch eventually returns
  let first = true;
  const factory = async () => {
    if (first) {
      first = false;
      await gate.promise; // resolves LATE — after acquire already rejected on the deadline
      return late;
    }
    return makeControllableCore({ closeMode: "resolve" });
  };
  const mgr = new SessionManager({
    maxSessions: 1,
    coreFactory: factory,
    launchDeadlineMs: 30,
    closeGraceMs: 30,
    killConfirmMs: 30,
  });

  await assert.rejects(
    mgr.acquire(),
    (e) => e instanceof SessionManagerError && e.code === "CORE_LAUNCH",
  );
  assert.equal(late.closed, false, "the late core hasn't resolved yet");

  // Let the wedged launch resolve LATE with a real core. It must be confirmably torn down, never leaked.
  gate.resolve();
  for (let i = 0; i < 50 && !late.closed; i++) await tick();
  assert.equal(late.closed, true, "the late-resolving core was closed (not leaked)");

  // Capacity is intact: the reserved slot was freed AND the (confirmed-dead) late core consumed no slot, so a
  // fresh acquire is admitted under maxSessions: 1 (the late core did NOT pin capacity toward SESSION_LIMIT).
  const s = await mgr.acquire();
  assert.equal(mgr.activeCount, 1, "a replacement acquire succeeds — the confirmed-dead late core didn't pin capacity");
  await mgr.release(s.id);
  assert.equal(mgr.activeCount, 0);
});

test("acquire: a late-resolving core whose death CANNOT be confirmed is RETAINED as unconfirmed, not leaked (issue #54)", async () => {
  const gate = deferred();
  // close rejects AND no force-kill PID → teardown can't confirm death → retained as a possibly-alive zombie.
  const late = makeControllableCore({ closeMode: "reject", forceKillAvailable: false });
  let first = true;
  const factory = async () => {
    if (first) {
      first = false;
      await gate.promise; // resolves LATE with a core that can't be confirmed dead
      return late;
    }
    return makeControllableCore({ closeMode: "resolve" });
  };
  const mgr = new SessionManager({
    maxSessions: 1,
    coreFactory: factory,
    launchDeadlineMs: 30,
    closeGraceMs: 20,
    killConfirmMs: 20,
  });

  await assert.rejects(mgr.acquire(), (e) => e instanceof SessionManagerError && e.code === "CORE_LAUNCH");

  gate.resolve(); // the wedged launch resolves LATE with a core that can't be confirmed dead
  for (let i = 0; i < 50 && mgr.unconfirmedCount === 0; i++) await tick();
  // The late browser is not silently leaked: a best-effort SIGKILL was sent and it is RETAINED as unconfirmed
  // (surfaced via unconfirmedCount) for the reaper's reconfirm loop, mirroring the shutdown-orphan degrade.
  // COUNTING a still-alive late orphan against the RUNNING cap is deferred to #54 Part 2 (orphan reaping, HOLD #4).
  assert.equal(mgr.unconfirmedCount, 1, "the unconfirmable late core is retained (never erased), not leaked");
  assert.equal(late.killCalls > 0, true, "a best-effort force-kill was attempted on the late orphan");
});

// --- issue #54 Part 2: orphan ledger — wedged/late/failed launches counted until CONFIRMED reclaimed ------

/** Controllable fake OrphanDirOps: records mints/sweeps/removals. Per the OrphanDirOps contract a fake
 *  sweep must SETTLE (bounded) — model "can't confirm yet" with "unconfirmed", never a hanging promise;
 *  `nextSweep` (a deferred resolved by the test with a SweepResult) holds ONE sweep open observably. */
function makeFakeDirOps({ sweepResult = "confirmed" } = {}) {
  let n = 0;
  const ops = {
    made: [],
    swept: [],
    removed: [],
    sweepResult,
    nextSweep: undefined,
    async make() {
      const d = `/fake/profile-${n++}`;
      ops.made.push(d);
      return d;
    },
    async sweep(dir) {
      ops.swept.push(dir);
      if (ops.nextSweep) {
        const p = ops.nextSweep.promise;
        ops.nextSweep = undefined;
        return p; // the test resolves the deferred with a SweepResult
      }
      return ops.sweepResult;
    },
    async remove(dir) {
      ops.removed.push(dir);
    },
  };
  return ops;
}

/** A factory whose FIRST launch wedges (forever, or until `gate` opens → resolves `late`, or rejects
 *  when `mode: "reject"`); later launches resolve normal controllable cores. */
function makeWedgeFactory({ gate, lateConfig, mode = "resolve" } = {}) {
  const late = makeControllableCore(lateConfig ?? { closeMode: "resolve" });
  let first = true;
  const factory = async () => {
    if (first) {
      first = false;
      await (gate ? gate.promise : new Promise(() => {}));
      if (mode === "reject") throw new Error("wedged launch finally failed");
      return late;
    }
    return makeControllableCore({ closeMode: "resolve" });
  };
  return { factory, late };
}

test("orphans: a wedged launch is COUNTED (back-pressures acquire) until the sweep confirms; a PENDING launch's confirm parks on the watch list (#54 Part 2)", async () => {
  const ops = makeFakeDirOps();
  const held = deferred();
  ops.nextSweep = held; // hold the immediate post-timeout sweep open so the counted window is observable
  const { factory } = makeWedgeFactory();
  const mgr = new SessionManager({ maxSessions: 1, coreFactory: factory, launchDeadlineMs: 30, orphanDirOps: ops });

  await assert.rejects(mgr.acquire(), (e) => e.code === "CORE_LAUNCH");
  assert.equal(mgr.orphanCount, 1, "the wedged launch is a counted live orphan");
  assert.equal(mgr.activeCount, 1, "activeCount includes the orphan");
  assert.equal(ops.swept.length, 1, "the wedge kicked an immediate sweep over its owned dir");
  assert.equal(ops.swept[0], ops.made[0], "the sweep keys off the minted dir");
  // Truthful back-pressure: the possibly-live half-spawned Chromium holds the only slot.
  await assert.rejects(mgr.acquire(), (e) => e.code === "SESSION_LIMIT");

  held.resolve("confirmed"); // nothing lives under the dir RIGHT NOW…
  for (let i = 0; i < 50 && mgr.orphanCount > 0; i++) await tick();
  assert.equal(mgr.orphanCount, 0, "the empty-scan confirm freed the capacity slot (the Part-1 promise)");
  // …but the launch promise is STILL PENDING (codex r1): the launcher could spawn Chromium later, so the
  // dir is PARKED on the watch list — retained (not removed) and re-swept by the reaper, never finalized.
  assert.deepEqual(ops.removed, [], "a pending launch's dir is retained (watch), not removed");
  const s = await mgr.acquire(); // capacity is truly free again
  await mgr.release(s.id);
  await mgr.reapIdle(1_000); // a reaper tick keeps sweeping the watched dir
  assert.equal(ops.swept.length >= 2, true, "the watch list is re-swept on reaper ticks");
});

test("orphans: a watched wedge that finally REJECTS is finalized — swept clear and its dir removed (#54 Part 2, codex r1)", async () => {
  const gate = deferred();
  const ops = makeFakeDirOps(); // every sweep confirms-empty
  const { factory } = makeWedgeFactory({ gate, mode: "reject" });
  const mgr = new SessionManager({ maxSessions: 1, coreFactory: factory, launchDeadlineMs: 30, orphanDirOps: ops });

  await assert.rejects(mgr.acquire(), (e) => e.code === "CORE_LAUNCH");
  for (let i = 0; i < 50 && mgr.orphanCount > 0; i++) await tick();
  assert.deepEqual(ops.removed, [], "while pending: parked on watch, dir retained");

  gate.resolve(); // the wedged factory finally REJECTS — nothing can spawn from it anymore
  for (let i = 0; i < 50 && ops.removed.length === 0; i++) await tick();
  assert.deepEqual(ops.removed, [ops.made[0]], "the settled launch's confirm is FINAL — dir removed");
});

test("orphans: an unsupported-platform sweep degrades LOUDLY to Part-1 semantics (uncounted, dir retained) (#54 Part 2)", async () => {
  const ops = makeFakeDirOps({ sweepResult: "unsupported" });
  const { factory } = makeWedgeFactory();
  const mgr = new SessionManager({ maxSessions: 1, coreFactory: factory, launchDeadlineMs: 30, orphanDirOps: ops });

  await assert.rejects(mgr.acquire(), (e) => e.code === "CORE_LAUNCH");
  for (let i = 0; i < 50 && mgr.orphanCount > 0; i++) await tick();
  assert.equal(mgr.orphanCount, 0, "no /proc → the slot is released (cannot confirm on this platform)");
  assert.deepEqual(ops.removed, [], "the dir is NOT removed — a live process may still be writing it");
});

test("orphans: an unconfirmed sweep keeps the orphan counted; the reaper tick retries until confirmed (#54 Part 2)", async () => {
  const ops = makeFakeDirOps({ sweepResult: "unconfirmed" });
  const { factory } = makeWedgeFactory();
  const mgr = new SessionManager({ maxSessions: 2, coreFactory: factory, launchDeadlineMs: 30, orphanDirOps: ops });

  await assert.rejects(mgr.acquire(), (e) => e.code === "CORE_LAUNCH");
  for (let i = 0; i < 50 && ops.swept.length === 0; i++) await tick();
  assert.equal(mgr.orphanCount, 1, "an unconfirmed sweep never frees the slot (the #50 never-lie posture)");

  ops.sweepResult = "confirmed"; // the unkillable finally died
  await mgr.reapIdle(1_000); // the reaper tick retries the sweep
  for (let i = 0; i < 50 && mgr.orphanCount > 0; i++) await tick();
  assert.equal(mgr.orphanCount, 0, "the reaper's retry confirmed and freed the orphan slot");
  assert.equal(ops.swept.length >= 2, true, "the sweep was retried");
  // The launch promise never settled, so the confirm parks the dir on the watch list (retained).
  assert.deepEqual(ops.removed, [], "pending launch → dir watched, not removed");
});

test("orphans: a consumer's live orphans count against ITS per-consumer cap (#54 Part 2, codex r1)", async () => {
  const ops = makeFakeDirOps({ sweepResult: "unconfirmed" }); // the orphan never confirms — stays counted
  const { factory } = makeWedgeFactory();
  const mgr = new SessionManager({
    maxSessions: 4,
    perConsumerMax: 1,
    coreFactory: factory,
    launchDeadlineMs: 30,
    orphanDirOps: ops,
  });

  await assert.rejects(mgr.acquire(undefined, { consumerId: "atlas" }), (e) => e.code === "CORE_LAUNCH");
  for (let i = 0; i < 50 && ops.swept.length === 0; i++) await tick();
  assert.equal(mgr.orphanCount, 1, "atlas's wedge is a counted live orphan");
  // atlas is at its cap via the orphan — it must NOT be able to stack another launch on the global pool.
  await assert.rejects(mgr.acquire(undefined, { consumerId: "atlas" }), (e) =>
    e.code === "SESSION_LIMIT" && /per-consumer/.test(e.message),
  );
  // A DIFFERENT consumer is unaffected (global pool has room).
  const other = await mgr.acquire(undefined, { consumerId: "vault" });
  await mgr.release(other.id);
});

test("orphans: a SYNC-throwing factory's minted dir is enqueued and cleaned, not leaked (#54 Part 2, codex r1)", async () => {
  const ops = makeFakeDirOps();
  let first = true;
  const factory = () => {
    if (first) {
      first = false;
      throw new Error("synchronous launch boom"); // throws BEFORE returning a promise
    }
    return Promise.resolve(makeControllableCore({ closeMode: "resolve" }));
  };
  const mgr = new SessionManager({ maxSessions: 1, coreFactory: factory, orphanDirOps: ops });

  await assert.rejects(mgr.acquire(), (e) => e.code === "CORE_LAUNCH");
  for (let i = 0; i < 50 && ops.removed.length === 0; i++) await tick();
  assert.equal(ops.swept.length, 1, "the sync-throw's dir was swept for a spawn-before-throw straggler");
  assert.deepEqual(ops.removed, [ops.made[0]], "the settled (thrown) launch's confirm removed the dir");
  assert.equal(mgr.orphanCount, 0);
});

test("orphans: a late-resolving core stays COUNTED through its confirmable teardown, even past maxSessions (#54 Part 2)", async () => {
  // The codex #54-Part-1 r3 scenario: the wedge's slot was freed, a REPLACEMENT took it, and only then
  // did the wedged launch resolve a real browser. The late orphan must be COUNTED (activeCount exceeds
  // maxSessions — the truthful state) and back-pressure new acquires until its teardown confirms.
  const gate = deferred();
  const ops = makeFakeDirOps(); // the immediate sweep confirms fast (nothing spawned yet) — rec drops
  const { factory, late } = makeWedgeFactory({ gate });
  const mgr = new SessionManager({ maxSessions: 1, coreFactory: factory, launchDeadlineMs: 30, orphanDirOps: ops });

  await assert.rejects(mgr.acquire(), (e) => e.code === "CORE_LAUNCH");
  for (let i = 0; i < 50 && mgr.orphanCount > 0; i++) await tick();
  const replacement = await mgr.acquire(); // the freed slot is taken
  assert.equal(mgr.activeCount, 1);

  gate.resolve(); // the wedged launch NOW resolves a live browser
  for (let i = 0; i < 50 && mgr.orphanCount === 0; i++) await tick();
  // (the late teardown may confirm within the same window; assert via the transcript instead of racing it)
  for (let i = 0; i < 50 && !late.closed && !late.killed; i++) await tick();
  assert.equal(late.closed || late.killed, true, "the late core was torn down, not leaked");
  for (let i = 0; i < 50 && mgr.orphanCount > 0; i++) await tick();
  assert.equal(mgr.orphanCount, 0, "the late orphan left accounting only after its teardown confirmed");
  assert.equal(mgr.activeCount, 1, "back to the registered session only");
  assert.equal(ops.removed.includes(ops.made[0]), true, "the late orphan's dir was removed after confirmation");
  await mgr.release(replacement.id);
});

test("orphans: a late-resolving core that can't confirm death stays counted via the ledger until reconfirm succeeds (#54 Part 2)", async () => {
  const gate = deferred();
  const ops = makeFakeDirOps();
  const { factory, late } = makeWedgeFactory({ gate, lateConfig: { closeMode: "reject", killMode: "reject" } });
  const mgr = new SessionManager({
    maxSessions: 2,
    coreFactory: factory,
    launchDeadlineMs: 30,
    closeGraceMs: 30,
    killConfirmMs: 30,
    orphanDirOps: ops,
  });

  await assert.rejects(mgr.acquire(), (e) => e.code === "CORE_LAUNCH");
  for (let i = 0; i < 50 && mgr.orphanCount > 0; i++) await tick();
  gate.resolve();
  for (let i = 0; i < 50 && mgr.unconfirmedCount === 0; i++) await tick();
  assert.equal(mgr.unconfirmedCount, 1, "the unconfirmable late core entered the reconfirm loop");
  assert.equal(mgr.orphanCount, 1, "…and its ledger record stays COUNTED meanwhile");
  assert.equal(mgr.activeCount, 1, "activeCount reflects the possibly-live orphan");

  late.killMode = "resolve"; // the SIGKILL finally lands
  await mgr.reapIdle(1_000); // reconfirm drain
  assert.equal(mgr.unconfirmedCount, 0, "reconfirm confirmed death");
  assert.equal(mgr.orphanCount, 0, "…and finalized the ledger record");
  assert.deepEqual(ops.removed, [ops.made[0]], "dir removed only after the reconfirm confirmed");
});

test("orphans: a FAILED launch's dir is swept (a rejected launch is not proof the process died) (#54 Part 2)", async () => {
  const ops = makeFakeDirOps();
  const factory = async () => {
    throw new Error("chrome exited during startup");
  };
  const mgr = new SessionManager({ maxSessions: 1, coreFactory: factory, orphanDirOps: ops });

  await assert.rejects(mgr.acquire(), (e) => e.code === "CORE_LAUNCH");
  for (let i = 0; i < 50 && mgr.orphanCount > 0; i++) await tick();
  assert.equal(ops.swept.length, 1, "the failed launch's dir was swept for stragglers");
  assert.deepEqual(ops.removed, [ops.made[0]], "confirmed-clear → the dir was removed");
  assert.equal(mgr.orphanCount, 0);
});

test("dirs: a registered session's owned profile dir is removed ONLY after its teardown confirms (#54 Part 2)", async () => {
  const ops = makeFakeDirOps();
  const { factory } = makeControllableFactory({ closeMode: "resolve" });
  const mgr = new SessionManager({ maxSessions: 1, coreFactory: factory, orphanDirOps: ops });

  const s = await mgr.acquire();
  assert.equal(ops.made.length, 1, "the launch minted a gateway-owned dir");
  assert.deepEqual(ops.removed, [], "the dir survives while the browser lives");
  await mgr.release(s.id);
  for (let i = 0; i < 50 && ops.removed.length === 0; i++) await tick();
  assert.deepEqual(ops.removed, [ops.made[0]], "confirmed death removed the dir");
  assert.equal(ops.swept.length, 0, "a clean registered teardown never needs the sweep");
});

test("dirs: a caller-supplied userDataDir is respected — never minted over, swept, or removed (#54 Part 2)", async () => {
  const ops = makeFakeDirOps();
  const { factory } = makeControllableFactory({ closeMode: "resolve" });
  const mgr = new SessionManager({ maxSessions: 1, coreFactory: factory, orphanDirOps: ops });

  const s = await mgr.acquire({ userDataDir: "/custom/profile" });
  assert.deepEqual(ops.made, [], "no gateway dir minted over the caller's");
  await mgr.release(s.id);
  await tick();
  assert.deepEqual(ops.removed, [], "the caller's dir is never removed");
  assert.deepEqual(ops.swept, [], "…nor swept");
});

test("shutdown: drains in-flight orphan work and RETAINS an unconfirmable orphan loudly (#54 Part 2)", async () => {
  const ops = makeFakeDirOps({ sweepResult: "unconfirmed" }); // the wedge's tree never confirms dead
  const { factory } = makeWedgeFactory();
  const mgr = new SessionManager({ maxSessions: 1, coreFactory: factory, launchDeadlineMs: 30, orphanDirOps: ops });

  await assert.rejects(mgr.acquire(), (e) => e.code === "CORE_LAUNCH");
  for (let i = 0; i < 50 && ops.swept.length === 0; i++) await tick();

  let done = false;
  await mgr.shutdown().then(() => {
    done = true;
  });
  assert.equal(done, true, "shutdown completed despite the unconfirmable orphan (bounded sweep)");
  assert.equal(mgr.orphanCount, 1, "the possibly-live orphan is RETAINED in accounting, never erased");
  assert.deepEqual(ops.removed, [], "its dir is retained too (a live process may hold it)");
});
