/**
 * U3 GatewayDriveController tests — the handle lifecycle + scheme guard + stale-session recovery,
 * exercised with a fake gateway/core (no real browser). The live drive path is proven in-container
 * by scripts/validate-drive.mjs (plan U5).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { GatewayDriveController } from "../dist/mcp/drive-controller.js";
import { PROXY_CLEARANCE_TIMEOUT_MS } from "../dist/verbs/index.js";
import { SecretStore } from "../dist/security/index.js";

function makeFakeGateway() {
  let nextId = 1;
  const open = new Map(); // handle -> session
  const events = [];
  const core = {
    async navigate(url) { events.push(["navigate", url]); return { url, title: "t", tree: "- x [ref=e1]", status: 200 }; },
    async snapshot() { events.push(["snapshot"]); return { url: "u", title: "t", tree: "- x [ref=e1]", status: 200 }; },
    async click(t) { events.push(["click", t]); },
    async type(t, text, opts) { events.push(["type", t, text, opts]); },
    async selectOption(t, v) { events.push(["selectOption", t, v]); },
    async pressKey(k) { events.push(["pressKey", k]); },
    async waitFor(c) { events.push(["waitFor", c]); },
    async screenshot() { events.push(["screenshot"]); return "QUJD"; },
  };
  const gateway = {
    sessions: { get: (h) => open.get(h) },
    async openConsumerSession(token) {
      const id = "h" + nextId++;
      open.set(id, { core });
      events.push(["open", token, id]);
      return id;
    },
    async useConsumerSession(token, handle, fn) {
      const s = open.get(handle);
      if (!s) throw new Error(`no open session for handle ${handle}`);
      return fn(s);
    },
    async closeConsumerSession(token, handle) {
      open.delete(handle);
      events.push(["close", handle]);
    },
  };
  return { gateway, events, open };
}

const noSecrets = () => new SecretStore(() => ({}));

test("controller: lazily opens on navigate, reuses the session across verbs, closes on close", async () => {
  const { gateway, events, open } = makeFakeGateway();
  const c = new GatewayDriveController(gateway, noSecrets(), "tok");
  const snap = await c.navigate("https://example.com/");
  assert.match(snap.url, /example\.com/);
  assert.equal(open.size, 1, "one session opened");
  await c.snapshot();
  await c.click({ target: "e1", element: "x" });
  assert.equal(open.size, 1, "same session reused (no re-open)");
  assert.equal(events.filter((e) => e[0] === "open").length, 1, "opened exactly once");
  await c.close();
  assert.equal(open.size, 0, "session closed");
});

test("controller: navigate rejects non-http(s) before opening a session", async () => {
  const { gateway, open } = makeFakeGateway();
  const c = new GatewayDriveController(gateway, noSecrets(), "tok");
  await assert.rejects(c.navigate("file:///etc/passwd"), /unsupported URL scheme/);
  assert.equal(open.size, 0, "no session opened for a rejected scheme");
});

test("controller: acting before navigate errors clearly (no active session)", async () => {
  const { gateway } = makeFakeGateway();
  const c = new GatewayDriveController(gateway, noSecrets(), "tok");
  await assert.rejects(c.snapshot(), /no active drive session/);
  await assert.rejects(c.click({ target: "e1" }), /no active drive session/);
});

/** A fake whose first navigate succeeds, then the next action's snapshot returns `blockedSnap`. */
function makePostActionBlockGateway(blockedSnap) {
  let nextId = 1;
  const open = new Map();
  const core = {
    async navigate() { return { url: "u", title: "ok", tree: "form [ref=e1]", status: 200 }; },
    async click() {}, // the click triggers a navigation into a blocked page
    async snapshot() { return blockedSnap; },
  };
  const gateway = {
    sessions: { get: (h) => open.get(h) },
    async openConsumerSession() { const id = "h" + nextId++; open.set(id, { core }); return id; },
    async useConsumerSession(_t, h, fn) {
      const s = open.get(h);
      if (!s) throw new Error(`no open session for handle ${h}`);
      return fn(s);
    },
    async closeConsumerSession(_t, h) { open.delete(h); },
  };
  return { gateway };
}

test("controller: a navigating action that lands on a visible challenge surfaces an error, not a blocked snapshot", async () => {
  const { gateway } = makePostActionBlockGateway({
    url: "u", title: "Just a moment...", tree: "Verifying you are human [ref=e1]", status: 200,
  });
  const c = new GatewayDriveController(gateway, noSecrets(), "tok");
  await c.navigate("https://example.com/"); // opens; post-nav snapshot is a real page
  await assert.rejects(c.click({ target: "e1" }), /blocked\/challenge page|did not clear/);
});

test("controller: a navigating action that lands on a bare reputation block (4xx + thin) surfaces an error", async () => {
  // No visible challenge phrase — only a hard-block status + thin body. The status the snapshot
  // carries is what lets navFailed catch it (the bug was checking visible phrases alone).
  const { gateway } = makePostActionBlockGateway({
    url: "u", title: "403 Forbidden", tree: "Forbidden", status: 403,
  });
  const c = new GatewayDriveController(gateway, noSecrets(), "tok");
  await c.navigate("https://example.com/");
  await assert.rejects(c.click({ target: "e1" }), /blocked\/challenge page|did not clear/);
});

test("controller: a navigating action that lands on a dead nav (chrome-error, stale status) surfaces an error", async () => {
  // The reset-socket case: the navigation got no response, so the snapshot inherited the prior
  // page's 200 status. The chrome-error:// url must still mark it failed (not returned as success).
  const { gateway } = makePostActionBlockGateway({
    url: "chrome-error://chromewebdata/", title: "", tree: "ERR_EMPTY_RESPONSE", status: 200,
  });
  const c = new GatewayDriveController(gateway, noSecrets(), "tok");
  await c.navigate("https://example.com/");
  await assert.rejects(c.click({ target: "e1" }), /blocked\/challenge page|did not clear/);
});

test("controller: a reaped session resets the handle so the next navigate reopens", async () => {
  const { gateway, open } = makeFakeGateway();
  const c = new GatewayDriveController(gateway, noSecrets(), "tok");
  await c.navigate("https://example.com/");
  const firstHandle = [...open.keys()][0];
  open.delete(firstHandle); // simulate an idle reap out from under the controller
  await assert.rejects(c.snapshot(), /no open session/); // the gone-session error surfaces once
  await c.navigate("https://example.com/again"); // transparently reopens a fresh session
  assert.equal(open.size, 1);
  assert.notEqual([...open.keys()][0], firstHandle, "a new session handle");
});

test("controller: sticky escalation mints a FRESH held exit per proxied attempt + raised clearance", async () => {
  // Direct navigate lands a CF interstitial → escalate. First proxied attempt is still challenged
  // (discarded), second clears. Each proxied OPEN must carry a different sticky password (fresh
  // exit per attempt — reusing one would pin every retry to the same possibly-dirty exit), and the
  // proxied navigates must run with the escalated clearance budget (an interstitial clears at ~22s
  // on a held exit — over the 15s drive default, which timed out mid-challenge and burned exits).
  const cfSnap = { url: "https://hard.example/", title: "Just a moment...", tree: "Verifying you are human", status: 403, cfHint: true };
  const okSnap = { url: "https://hard.example/", title: "ok", tree: "- heading [ref=e1]", status: 200 };
  const opens = []; // coreOverrides per openConsumerSession
  const navOpts = []; // RenderOptions per navigate
  let navs = 0;
  let nextId = 1;
  const open = new Map();
  const gateway = {
    sessions: { get: (h) => open.get(h) },
    async openConsumerSession(_token, coreOverrides) {
      opens.push(coreOverrides);
      const id = "h" + nextId++;
      open.set(id, {
        core: {
          async navigate(_url, opts) {
            navOpts.push(opts);
            navs++;
            return navs === 1 ? cfSnap : navs === 2 ? cfSnap : okSnap; // direct CF, proxied CF, proxied ok
          },
        },
      });
      return id;
    },
    async useConsumerSession(_t, handle, fn) {
      const s = open.get(handle);
      if (!s) throw new Error(`no open session for handle ${handle}`);
      return fn(s);
    },
    async closeConsumerSession(_t, h) {
      open.delete(h);
    },
  };
  const secrets = new SecretStore(() => ({ BGW_PROXY_URL: "http://proxy:8080", BGW_PROXY_PASSWORD: "pw" }));
  const c = new GatewayDriveController(gateway, secrets, "tok", { onDatacenterIp: true, stickySuffix: "_s-{id}" });
  const snap = await c.navigate("https://hard.example/");
  assert.equal(snap.status, 200, "escalation landed the page");
  assert.equal(opens.length, 3, "1 direct open + 2 proxied attempts");
  assert.equal(opens[0], undefined, "first open is direct (no override)");
  const proxiedPw = opens.slice(1).map((o) => o?.proxy?.password);
  for (const pw of proxiedPw) assert.match(pw, /^pw_s-[0-9a-f]+$/, "sticky suffix applied per proxied open");
  assert.equal(new Set(proxiedPw).size, 2, "each proxied attempt minted its own sticky session");
  assert.equal(navOpts.length, 3, "1 direct + 2 proxied navigates fired (direct proves it ran)");
  assert.equal(navOpts[0], undefined, "direct navigate passes no opts → keeps the default clearance");
  for (const o of navOpts.slice(1)) {
    assert.equal(o?.clearanceTimeoutMs, PROXY_CLEARANCE_TIMEOUT_MS, "escalated clearance on proxied navigates");
  }
});

test("controller: a reaped PROXIED session reopens with the escalated clearance budget, not the 15s default", async () => {
  // The path the feature originally missed: after an idle reap, a pinned PROXIED session reopens a
  // fresh exit + empty profile and can re-hit CF — so the reopen navigate must carry the escalated
  // budget, or it times out mid-challenge (the very failure this feature fixes).
  const cfSnap = { url: "https://hard.example/", title: "Just a moment...", tree: "Verifying you are human", status: 403, cfHint: true };
  const okSnap = { url: "https://hard.example/", title: "ok", tree: "- heading [ref=e1]", status: 200 };
  const navOpts = [];
  let navs = 0;
  let nextId = 1;
  const open = new Map();
  const gateway = {
    sessions: { get: (h) => open.get(h) },
    async openConsumerSession(_t, _override) {
      const id = "h" + nextId++;
      open.set(id, {
        core: {
          async navigate(_url, opts) {
            navOpts.push(opts);
            navs++;
            return navs === 1 ? cfSnap : okSnap; // direct CF (escalate), then everything clears
          },
        },
      });
      return id;
    },
    async useConsumerSession(_t, handle, fn) {
      const s = open.get(handle);
      if (!s) throw new Error(`no open session for handle ${handle}`);
      return fn(s);
    },
    async closeConsumerSession(_t, h) { open.delete(h); },
  };
  const secrets = new SecretStore(() => ({ BGW_PROXY_URL: "http://proxy:8080", BGW_PROXY_PASSWORD: "pw" }));
  const c = new GatewayDriveController(gateway, secrets, "tok", { onDatacenterIp: true, stickySuffix: "_s-{id}" });
  await c.navigate("https://hard.example/"); // direct CF → escalate → pinned proxied
  const pinned = [...open.keys()][0];
  open.delete(pinned); // simulate the idle reaper closing the held proxied session
  await assert.rejects(c.navigate("https://hard.example/"), /no open session/); // gone-session surfaces, resets handle
  navOpts.length = 0; // focus on the reopen navigate
  await c.navigate("https://hard.example/"); // pinned-reopen path
  assert.equal(navOpts[0]?.clearanceTimeoutMs, PROXY_CLEARANCE_TIMEOUT_MS, "reopened proxied session uses the escalated budget");
});

test("controller: proxy config removed mid-escalation throws a distinct 'unavailable' error, not exhausted-exits", async () => {
  // If the proxy secret rotates away between escalation attempts, surface a config error — not the
  // misleading 'could not land a working proxied exit after N attempts'.
  const cfSnap = { url: "https://hard.example/", title: "Just a moment...", tree: "Verifying you are human", status: 403, cfHint: true };
  let urlGets = 0;
  // Duck-typed SecretStore: the proxy URL resolves for the first two reads (firstNavigate gate +
  // attempt 1) then disappears, so attempt 2's #resolveProxyOverride() returns undefined.
  const secrets = {
    get(key) {
      if (key === "BGW_PROXY_URL") { urlGets++; return urlGets <= 2 ? "http://proxy:8080" : ""; }
      if (key === "BGW_PROXY_PASSWORD") return "pw";
      return undefined;
    },
  };
  let nextId = 1;
  const open = new Map();
  const opens = [];
  const gateway = {
    sessions: { get: (h) => open.get(h) },
    async openConsumerSession(_t, override) {
      opens.push(override);
      const id = "h" + nextId++;
      open.set(id, { core: { async navigate() { return cfSnap; } } }); // never clears → keep retrying
      return id;
    },
    async useConsumerSession(_t, handle, fn) {
      const s = open.get(handle);
      if (!s) throw new Error(`no open session for handle ${handle}`);
      return fn(s);
    },
    async closeConsumerSession(_t, h) { open.delete(h); },
  };
  const c = new GatewayDriveController(gateway, secrets, "tok", { onDatacenterIp: true, stickySuffix: "_s-{id}" });
  await assert.rejects(c.navigate("https://hard.example/"), /proxy escalation unavailable.*removed mid-retry/);
  assert.equal(opens.length, 2, "direct + attempt 1 only; attempt 2 aborts before opening a session");
});

test("controller: a driver error carrying proxy credentials is redacted before reaching the consumer (R9)", async () => {
  // A BYO proxy URL with a real-length password; redactSecrets must scrub it from any error text.
  const proxyUrl = "http://user:sup3r-secret-proxy-pass@proxy.example:8080";
  const secrets = new SecretStore(() => ({ BGW_PROXY_URL: proxyUrl }));
  let nextId = 1;
  const handles = new Map();
  const gateway = {
    sessions: { get: (h) => handles.get(h) },
    async openConsumerSession() {
      const id = "h" + nextId++;
      handles.set(id, {});
      return id;
    },
    // Simulate a driver/proxy failure whose message embeds the BYO proxy credentials.
    async useConsumerSession() {
      throw new Error(`net::ERR_PROXY_CONNECTION_FAILED connecting via ${proxyUrl}`);
    },
    async closeConsumerSession(_t, h) {
      handles.delete(h);
    },
  };
  const c = new GatewayDriveController(gateway, secrets, "tok"); // direct path: navigate runs through #run
  await assert.rejects(c.navigate("https://example.com/"), (e) => {
    assert.ok(!e.message.includes("sup3r-secret-proxy-pass"), "raw secret must not survive");
    assert.ok(!e.message.includes(proxyUrl), "the proxy URL must be redacted");
    return true;
  });
});
