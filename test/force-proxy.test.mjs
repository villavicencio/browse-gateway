/**
 * U5 (issue #21) — force-proxy-from-first-request. A known-hostile host (BGW_FORCE_PROXY_HOSTS or a
 * per-call {forceProxy}) skips the direct attempt and goes residential from the first navigation,
 * instead of burning a direct round-trip that only trips the WAF.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseForceProxyHosts, hostForcesProxy, retrieve, EscalationError } from "../dist/verbs/index.js";
import { SecretStore } from "../dist/security/index.js";
import { GatewayDriveController } from "../dist/mcp/drive-controller.js";

const REAL = "real accessibility tree ".repeat(60); // not blocked
const PROXY_SECRETS = () => ({ BGW_PROXY_URL: "http://proxy:8080", BGW_PROXY_PASSWORD: "pw" });

// --- pure helpers ----------------------------------------------------------------------------

test("parseForceProxyHosts: comma-splits, trims, lowercases; empty/unset → []", () => {
  assert.deepEqual(parseForceProxyHosts("totalwine.com, WWW.Example.com ,, foo.io"), ["totalwine.com", "www.example.com", "foo.io"]);
  assert.deepEqual(parseForceProxyHosts(""), []);
  assert.deepEqual(parseForceProxyHosts(undefined), []);
});

test("hostForcesProxy: exact + dotted-subdomain match; not a bare substring; empty list → false", () => {
  const list = ["totalwine.com"];
  assert.equal(hostForcesProxy("totalwine.com", list), true);
  assert.equal(hostForcesProxy("www.totalwine.com", list), true);
  assert.equal(hostForcesProxy("nottotalwine.com", list), false, "suffix, not substring");
  assert.equal(hostForcesProxy("totalwine.com.evil.com", list), false);
  assert.equal(hostForcesProxy("totalwine.com", []), false);
});

// --- drive path ------------------------------------------------------------------------------

function makeProxyGateway(sessionNavLists) {
  let si = -1;
  let nextId = 1;
  const open = new Map();
  const opened = [];
  const gateway = {
    sessions: { get: (h) => open.get(h) },
    async openConsumerSession(_token, overrides) {
      si += 1;
      const navs = sessionNavLists[Math.min(si, sessionNavLists.length - 1)] ?? [{}];
      let ni = 0;
      const id = "h" + nextId++;
      open.set(id, {
        core: {
          async navigate(url) {
            const out = navs[Math.min(ni, navs.length - 1)] ?? {};
            ni += 1;
            return { url, title: "t", tree: out.tree ?? REAL, status: out.status ?? 200, cfHint: out.cfHint, pxHint: out.pxHint };
          },
          async snapshot() {
            return { url: "u", title: "t", tree: REAL, status: 200 };
          },
        },
      });
      opened.push({ id, overrides });
      return id;
    },
    async useConsumerSession(_token, handle, fn) {
      const s = open.get(handle);
      if (!s) throw new Error("session not found");
      return fn(s);
    },
    async closeConsumerSession(_token, handle) {
      open.delete(handle);
    },
  };
  return { gateway, opened };
}

test("drive: a forced host goes proxied on the FIRST navigate — no direct attempt", async () => {
  const { gateway, opened } = makeProxyGateway([[{ status: 200, tree: REAL }]]); // first opened session lands a page
  const drive = new GatewayDriveController(gateway, new SecretStore(PROXY_SECRETS), "tok", {
    onDatacenterIp: true,
    forceProxyHosts: ["totalwine.com"],
  });
  await drive.navigate("https://www.totalwine.com/p/1");
  assert.equal(opened.length, 1, "only one session opened (no direct-first attempt)");
  assert.ok(opened[0].overrides?.proxy, "the first/only session was proxied");
});

test("drive: the {forceProxy} option forces even when the host is not on the list", async () => {
  const { gateway, opened } = makeProxyGateway([[{ status: 200, tree: REAL }]]);
  const drive = new GatewayDriveController(gateway, new SecretStore(PROXY_SECRETS), "tok", { onDatacenterIp: true });
  await drive.navigate("https://anything.example/", { forceProxy: true });
  assert.equal(opened.length, 1);
  assert.ok(opened[0].overrides?.proxy, "proxied from the first request via the option");
});

test("drive: a non-forced host keeps direct-first (regression)", async () => {
  const { gateway, opened } = makeProxyGateway([[{ status: 200, tree: REAL }]]);
  const drive = new GatewayDriveController(gateway, new SecretStore(PROXY_SECRETS), "tok", {
    onDatacenterIp: true,
    forceProxyHosts: ["totalwine.com"],
  });
  await drive.navigate("https://example.com/");
  assert.equal(opened.length, 1);
  assert.equal(opened[0].overrides, undefined, "direct session (no proxy override)");
});

test("drive: forced but no proxy available → loud EscalationError, not a silent direct attempt", async () => {
  const { gateway, opened } = makeProxyGateway([[{ status: 200, tree: REAL }]]);
  const drive = new GatewayDriveController(gateway, new SecretStore(() => ({})), "tok", {
    onDatacenterIp: true,
    forceProxyHosts: ["totalwine.com"],
  });
  await assert.rejects(drive.navigate("https://totalwine.com/"), (err) => {
    assert.ok(err instanceof EscalationError);
    assert.equal(err.diagnostics.forced, true);
    assert.equal(err.diagnostics.proxyConfigured, false);
    assert.match(err.message, /force-proxy requested/);
    return true;
  });
  assert.equal(opened.length, 0, "no session opened — failed before any navigation");
});

// --- retrieve path ---------------------------------------------------------------------------

function makeRenderGateway(result) {
  const calls = [];
  const gateway = {
    async withConsumerSession(_token, fn, override) {
      calls.push({ override });
      return fn({ core: { async render() { return result; }, async setNavigationGuard() {}, async close() {} } }, { id: "a" });
    },
  };
  return { gateway, calls };
}

test("retrieve: forceProxy skips the direct render — the first render is proxied", async () => {
  const { gateway, calls } = makeRenderGateway({ url: "u", status: 200, title: "OK", text: REAL, html: `<main>${REAL}</main>`, clearanceWaitedMs: 0 });
  const r = await retrieve(gateway, new SecretStore(PROXY_SECRETS), {
    token: "t",
    url: "https://www.totalwine.com/p/1",
    escalation: { onDatacenterIp: true },
    forceProxy: true,
  });
  assert.equal(r.proxyUsed, true);
  assert.equal(calls.length, 1, "no direct render — straight to a proxied render");
  assert.ok(calls[0].override?.proxy, "the first render used a proxy override");
  assert.equal(r.proxyDiagnostic?.forced, true);
});

test("retrieve: forceProxy with no proxy configured degrades to a direct render (best-effort)", async () => {
  const { gateway, calls } = makeRenderGateway({ url: "u", status: 200, title: "OK", text: REAL, html: `<main>${REAL}</main>`, clearanceWaitedMs: 0 });
  const r = await retrieve(gateway, new SecretStore(() => ({})), { token: "t", url: "https://totalwine.com/", escalation: { onDatacenterIp: true }, forceProxy: true });
  assert.equal(r.proxyUsed, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].override, undefined, "direct render — nothing to force to");
});
