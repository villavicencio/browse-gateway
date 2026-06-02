/**
 * U4 drive proxy-posture tests — the proxyOverrideFor/navFailed helpers, plus the controller's
 * first-navigate retry across fresh rotating exits, pinning, and pinned/direct failure surfacing.
 * Exercised with a fake gateway (no real browser); the live path is proven by scripts/validate-drive.mjs (U5).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { proxyOverrideFor, navFailed } from "../dist/verbs/index.js";
import { GatewayDriveController } from "../dist/mcp/drive-controller.js";
import { SecretStore } from "../dist/security/index.js";

const withProxy = () => new SecretStore(() => ({ BGW_PROXY_URL: "http://p:1" }));
const noSecrets = () => new SecretStore(() => ({}));
const REAL = "x".repeat(500); // a "real content" accessibility tree (above the thin-page threshold)

test("proxyOverrideFor: {proxy} only with a proxy configured AND on a datacenter IP", () => {
  assert.ok(proxyOverrideFor(withProxy(), true)?.proxy, "proxy + DC -> override");
  assert.equal(proxyOverrideFor(withProxy(), false), undefined, "not on a DC IP -> no override");
  assert.equal(proxyOverrideFor(noSecrets(), true), undefined, "no proxy -> no override");
});

test("navFailed: fails on null status, a 4xx+thin page, or a visible interstitial; a real cleared page does not", () => {
  assert.equal(navFailed({ url: "u", title: "t", tree: "", status: null }), true);
  assert.equal(navFailed({ url: "u", title: "t", tree: "Forbidden", status: 403 }), true);
  // CF interstitial: 200 + non-thin content, but a visible block phrase -> still failed, so a
  // proxied first navigate rotates past the blocked exit instead of pinning it.
  assert.equal(navFailed({ url: "u", title: "Just a moment...", tree: REAL, status: 200 }), true);
  assert.equal(navFailed({ url: "u", title: "t", tree: REAL, status: 200 }), false);
  assert.equal(navFailed({ url: "u", title: "t", tree: REAL, status: 403 }), false);
});

/** Fake gateway: opened session N navigates through sessionNavLists[N] (each nav consumes the next). */
function makeProxyGateway(sessionNavLists) {
  let si = -1;
  let nextId = 1;
  const open = new Map();
  const opened = [];
  const gateway = {
    sessions: { get: (h) => open.get(h) },
    async openConsumerSession(token, overrides) {
      si++;
      const navs = sessionNavLists[Math.min(si, sessionNavLists.length - 1)] ?? [{}];
      let ni = 0;
      const id = "h" + nextId++;
      open.set(id, {
        core: {
          async navigate(url) {
            const out = navs[Math.min(ni, navs.length - 1)] ?? {};
            ni++;
            // Preserve an explicit `status: null` (a dead exit); only fill in defaults when omitted.
            return {
              url,
              title: "t",
              tree: out.tree === undefined ? REAL : out.tree,
              status: out.status === undefined ? 200 : out.status,
            };
          },
          async snapshot() { return { url: "u", title: "t", tree: REAL, status: 200 }; },
        },
      });
      opened.push({ id, overrides });
      return id;
    },
    async useConsumerSession(token, handle, fn) {
      const s = open.get(handle);
      if (!s) throw new Error(`no open session for handle ${handle}`);
      return fn(s);
    },
    async closeConsumerSession(token, handle) { open.delete(handle); },
  };
  return { gateway, open, opened };
}

test("controller: proxied first navigate retries fresh sessions until a healthy exit lands, then pins", async () => {
  const { gateway, open, opened } = makeProxyGateway([[{ status: null, tree: "" }], [{ status: 200, tree: REAL }]]);
  const c = new GatewayDriveController(gateway, withProxy(), "tok", { onDatacenterIp: true });
  const snap = await c.navigate("https://example.com/");
  assert.equal(snap.status, 200, "landed a healthy exit");
  assert.equal(opened.length, 2, "retried with a second fresh session");
  assert.ok(opened[0].overrides?.proxy, "opened with the proxy override");
  assert.equal(open.size, 1, "only the healthy session remains open");
  await c.navigate("https://example.com/next"); // pinned -> no re-roll
  assert.equal(opened.length, 2, "no re-open after pinning");
});

test("controller: proxied open throws when no exit lands within the attempt budget", async () => {
  const { gateway, opened } = makeProxyGateway([[{ status: null, tree: "" }]]); // every session dead
  const c = new GatewayDriveController(gateway, withProxy(), "tok", { onDatacenterIp: true });
  await assert.rejects(c.navigate("https://example.com/"), /could not land a working proxied exit/);
  assert.equal(opened.length, 3, "tried the full attempt budget");
});

test("controller: a direct session surfaces a failed navigation as an error, not blank content", async () => {
  const { gateway } = makeProxyGateway([[{ status: null, tree: "" }]]);
  const c = new GatewayDriveController(gateway, noSecrets(), "tok", { onDatacenterIp: true }); // no proxy -> direct
  await assert.rejects(c.navigate("https://example.com/"), /navigation failed/);
});

test("controller: a pinned proxied session that fails mid-flow discards, so the next navigate re-rolls a fresh exit", async () => {
  // session 1: first nav healthy (pins), second nav fails (exit went bad mid-flow);
  // session 2: a fresh healthy exit on the auto-reopened navigate.
  const { gateway, opened } = makeProxyGateway([
    [{ status: 200, tree: REAL }, { status: null, tree: "" }],
    [{ status: 200, tree: REAL }],
  ]);
  const c = new GatewayDriveController(gateway, withProxy(), "tok", { onDatacenterIp: true });
  const first = await c.navigate("https://example.com/");
  assert.equal(first.status, 200);
  await assert.rejects(c.navigate("https://example.com/2"), /retry navigate for a fresh exit/);
  assert.equal(opened.length, 1, "the failing navigate does not re-roll within the same call (no live swap)");
  // The session was discarded + unpinned, so the next navigate transparently re-rolls a fresh exit.
  const recovered = await c.navigate("https://example.com/3");
  assert.equal(recovered.status, 200, "auto-reopened on a fresh exit");
  assert.equal(opened.length, 2, "exactly one fresh session opened on recovery");
});
