/**
 * U3 GatewayDriveController tests — the handle lifecycle + scheme guard + stale-session recovery,
 * exercised with a fake gateway/core (no real browser). The live drive path is proven in-container
 * by scripts/validate-drive.mjs (plan U5).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { GatewayDriveController } from "../dist/mcp/drive-controller.js";
import { SecretStore } from "../dist/security/index.js";

function makeFakeGateway() {
  let nextId = 1;
  const open = new Map(); // handle -> session
  const events = [];
  const core = {
    async navigate(url) { events.push(["navigate", url]); return { url, title: "t", tree: "- x [ref=e1]" }; },
    async snapshot() { events.push(["snapshot"]); return { url: "u", title: "t", tree: "- x [ref=e1]" }; },
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
