/**
 * VIL-110: a refusal and a crash must not be the same signal to a consumer.
 *
 * Every raise site in the session manager is FORCED for real (no stubbed error objects), and the kind is
 * asserted at the session-manager level AND at the MCP tool-result `_meta` level, on both the retrieve
 * path and the drive path — a tag that is correct in the manager and lost in a re-wrap is not shipped.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  Gateway,
  SessionManager,
  SessionManagerError,
  SESSION_FAILURE_KINDS,
  sessionFailureKindOf,
  carrySessionFailureKind,
} from "../dist/gateway/index.js";
import { PolicyEngine, ConsumerRegistry } from "../dist/policy/index.js";
import { SecretStore } from "../dist/security/index.js";
import { GatewayDriveController } from "../dist/mcp/drive-controller.js";
import { createGatewayMcpServer, ERROR_KIND_META_KEY, SESSION_FAILURE_META_KEY } from "../dist/mcp/index.js";

const tick = () => new Promise((r) => setTimeout(r, 5));

/** A minimal healthy fake core. */
function fakeCore() {
  return {
    closed: false,
    groupAlive: true,
    forceKillAvailable: true,
    async render(url) {
      return { url, status: 200, title: "t", text: "x".repeat(1000), html: "<main/>", clearanceWaitedMs: 0 };
    },
    async navigate(url) {
      return { url, title: "t", tree: "- x", status: 200 };
    },
    async setNavigationGuard() {},
    async close() {
      this.closed = true;
      this.groupAlive = false;
    },
    async kill() {
      this.groupAlive = false;
    },
  };
}

/** Force each raise site and return the error it produced. */
async function forced(site) {
  switch (site) {
    case "sync-throw": {
      // A NON-async factory that throws before returning a promise.
      const mgr = new SessionManager({ maxSessions: 2, coreFactory: () => { throw new Error("boom"); } });
      return mgr.acquire().catch((e) => e);
    }
    case "rejection": {
      const mgr = new SessionManager({ maxSessions: 2, coreFactory: async () => { throw new Error("chrome exited"); } });
      return mgr.acquire().catch((e) => e);
    }
    case "deadline": {
      const mgr = new SessionManager({ maxSessions: 2, coreFactory: () => new Promise(() => {}), launchDeadlineMs: 20, closeGraceMs: 20, killConfirmMs: 20 });
      return mgr.acquire().catch((e) => e);
    }
    case "global-cap": {
      const mgr = new SessionManager({ maxSessions: 1, coreFactory: async () => fakeCore() });
      await mgr.acquire();
      const err = await mgr.acquire().catch((e) => e);
      await mgr.shutdown(); // release the held session and its profile dir (MergeWren #161)
      return err;
    }
    case "consumer-cap": {
      const policy = new PolicyEngine({ registry: new ConsumerRegistry([{ id: "a", token: "tok-a", allow: ["example.com"] }]) });
      const gw = Gateway.create({ maxSessions: 5, core: {} }, async () => fakeCore(), policy);
      const held = await gw.openConsumerSession("tok-a");
      const err = await gw.openConsumerSession("tok-a").catch((e) => e);
      await gw.closeConsumerSession("tok-a", held); // release it (MergeWren #161)
      return err;
    }
    case "shutdown-before": {
      const mgr = new SessionManager({ maxSessions: 2, coreFactory: async () => fakeCore() });
      await mgr.shutdown();
      return mgr.acquire().catch((e) => e);
    }
    case "shutdown-mid-launch": {
      // Shutdown begins WHILE a launch is in flight; the launch then lands and must not register.
      let release;
      const gate = new Promise((r) => { release = r; });
      const mgr = new SessionManager({ maxSessions: 2, coreFactory: async () => { await gate; return fakeCore(); }, closeGraceMs: 20, killConfirmMs: 20 });
      const p = mgr.acquire().catch((e) => e);
      await tick();
      const down = mgr.shutdown();
      release();
      const err = await p;
      await down;
      return err;
    }
  }
  throw new Error(`unknown site ${site}`);
}

const EXPECTED = {
  "sync-throw": ["CORE_LAUNCH", "launch-failed"],
  rejection: ["CORE_LAUNCH", "launch-failed"],
  deadline: ["CORE_LAUNCH", "launch-timeout"],
  "global-cap": ["SESSION_LIMIT", "at-capacity-global"],
  "consumer-cap": ["SESSION_LIMIT", "at-capacity-consumer"],
  "shutdown-before": ["SESSION_LIMIT", "shutting-down"],
  "shutdown-mid-launch": ["SESSION_LIMIT", "shutting-down"],
};

for (const [site, [code, kind]] of Object.entries(EXPECTED)) {
  test(`raise site ${site}: code=${code}, kind=${kind}`, async () => {
    const err = await forced(site);
    assert.ok(err instanceof SessionManagerError, `${site} produced ${err}`);
    assert.equal(err.code, code);
    assert.equal(err.kind, kind);
  });
}

test("the six conditions map onto five DISTINCT kinds, and shutting-down differs from both capacity kinds", async () => {
  const kinds = {};
  for (const site of Object.keys(EXPECTED)) kinds[site] = (await forced(site)).kind;
  assert.equal(new Set(Object.values(kinds)).size, 5);
  assert.notEqual(kinds["shutdown-before"], kinds["global-cap"]);
  assert.notEqual(kinds["shutdown-before"], kinds["consumer-cap"]);
  assert.notEqual(kinds.deadline, kinds.rejection);
  assert.deepEqual([...SESSION_FAILURE_KINDS].sort(), [...new Set(Object.values(kinds))].sort(), "the exported vocabulary is exactly what the raise sites produce");
});

test("the sync-throw and rejection paths no longer share a byte-identical message (but keep the classified prefix)", async () => {
  const a = (await forced("sync-throw")).message;
  const b = (await forced("rejection")).message;
  assert.notEqual(a, b);
  for (const m of [a, b]) assert.match(m, /^browser core failed to launch/);
});

test("carrySessionFailureKind survives a redaction re-wrap, invisibly; an unknown value is ignored", async () => {
  const original = await forced("global-cap");
  const wrapped = carrySessionFailureKind(new Error("redacted"), original);
  assert.equal(sessionFailureKindOf(wrapped), "at-capacity-global");
  assert.equal(JSON.stringify(wrapped), "{}", "non-enumerable: never serialized into an error dump");
  assert.equal(sessionFailureKindOf(carrySessionFailureKind(new Error("x"), new Error("plain"))), undefined);
  const forged = Object.assign(new Error("x"), { sessionFailureKind: "not-a-kind" });
  assert.equal(sessionFailureKindOf(forged), undefined, "an unrecognised value is not trusted");
});

// --- The full boundary: the tag reaches the MCP tool result ------------------------------------------

async function connect(deps) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = createGatewayMcpServer({ retrieve: async () => { throw new Error("unused"); }, ...deps });
  await server.connect(st);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(ct);
  return client;
}

test("retrieve path: a refused session reaches _meta as its kind, beside the unchanged error-kind", async () => {
  for (const site of ["global-cap", "deadline", "shutdown-before"]) {
    const err = await forced(site);
    // The launchers re-wrap retrieve errors for redaction exactly like this.
    const client = await connect({ retrieve: async () => { throw carrySessionFailureKind(new Error(err.message), err); } });
    const res = await client.callTool({ name: "retrieve", arguments: { url: "https://example.com/" } });
    assert.equal(res.isError, true);
    assert.equal(res._meta[ERROR_KIND_META_KEY], "internal", "the coarse two-value kind is unchanged (additive wire shape)");
    assert.equal(res._meta[SESSION_FAILURE_META_KEY], EXPECTED[site][1]);
  }
});

test("drive path: a refused open travels the REAL controller's redaction re-wrap and reaches _meta", async () => {
  for (const site of ["consumer-cap", "rejection", "shutdown-mid-launch"]) {
    const err = await forced(site);
    const gateway = {
      sessions: { get: () => undefined },
      async openConsumerSession() { throw err; },
      async useConsumerSession() { throw new Error("unreachable"); },
      async closeConsumerSession() {},
    };
    const drive = new GatewayDriveController(gateway, new SecretStore(() => ({})), "tok");
    const client = await connect({ drive });
    const res = await client.callTool({ name: "browser_open", arguments: {} });
    assert.equal(res.isError, true);
    assert.equal(res._meta[ERROR_KIND_META_KEY], "internal");
    assert.equal(res._meta[SESSION_FAILURE_META_KEY], EXPECTED[site][1], `${site} lost its kind on the drive path`);
  }
});

test("an error that is NOT a session failure carries no session-failure key", async () => {
  const client = await connect({ retrieve: async () => { throw new Error("some other failure"); } });
  const res = await client.callTool({ name: "retrieve", arguments: { url: "https://example.com/" } });
  assert.equal(res._meta[SESSION_FAILURE_META_KEY], undefined);
});
