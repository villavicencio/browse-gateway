/**
 * Unit tests for the production vault login-runner glue (U6d). The browser/gateway integration is
 * thin — open (pinned to the bound exit) → drive assistedLogin → capture → close — so it is exercised
 * here against a fake gateway + a minimal always-succeeds fake core (no real browser; the live path
 * is proven by scripts/validate-vault-login.mjs). Also asserts the assisted-login surface is never
 * wired into the MCP server (so it can never become an agent tool — KTD-5).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeGatewayLoginRunner } from "../dist/mcp/gateway-login-runner.js";
import { SecretStore } from "../dist/security/index.js";

const STATE = {
  cookies: [{ name: "sid", value: "v", domain: "ex.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }],
  origins: [],
};
const RECIPE = { loginUrl: "https://ex.com/login", usernameField: "#u", passwordField: "#p", submit: "#s", successText: "AUTHENTICATED" };
const CREDS = { username: "u", password: "p" };

/** A fake core that drives any assistedLogin recipe straight to success and returns STATE. */
function fakeCore(state, { throwOnCapture = false } = {}) {
  return {
    async navigate() {},
    async readField() { return { present: true, value: "" }; }, // fields present + empty → filled once
    async type() {},
    async click() {},
    async snapshot() { return { url: "u", title: "t", tree: "AUTHENTICATED" }; },
    async captureStorageState() { if (throwOnCapture) throw new Error("capture boom"); return state; },
    async waitFor() {},
  };
}
function fakeGateway(core) {
  const opened = [], closed = [];
  const gateway = {
    async openConsumerSession(token, override) { opened.push({ token, override }); return "h1"; },
    async useConsumerSession(token, handle, fn) { return fn({ core }, { id: "atlas" }); },
    async closeConsumerSession(token, handle) { closed.push(handle); },
  };
  return { gateway, opened, closed };
}

test("runner: pins the bound sticky exit, drives the login, returns the captured state, closes the session", async () => {
  const { gateway, opened, closed } = fakeGateway(fakeCore(STATE));
  const secrets = new SecretStore(() => ({ BGW_PROXY_URL: "http://p:1", BGW_PROXY_PASSWORD: "pw" }));
  const runner = makeGatewayLoginRunner(gateway, secrets, "tok", { onDatacenterIp: true, stickySuffix: "_s-{id}" });
  const state = await runner({ host: "ex.com", recipe: RECIPE, creds: CREDS, stickyExitId: "abcd1234" });
  assert.deepEqual(state, STATE);
  assert.match(opened[0].override.proxy.password, /_s-abcd1234$/, "opened pinned to the bound exit");
  assert.deepEqual(closed, ["h1"], "capture session released");
});

test("runner: direct session (override undefined) when no proxy is configured", async () => {
  const { gateway, opened } = fakeGateway(fakeCore(STATE));
  const runner = makeGatewayLoginRunner(gateway, new SecretStore(() => ({})), "tok", { onDatacenterIp: false });
  await runner({ host: "ex.com", recipe: RECIPE, creds: CREDS, stickyExitId: "abcd1234" });
  assert.equal(opened[0].override, undefined);
});

test("runner: closes the session even when the login throws (no held capture session leaks)", async () => {
  const { gateway, closed } = fakeGateway(fakeCore(STATE, { throwOnCapture: true }));
  const runner = makeGatewayLoginRunner(gateway, new SecretStore(() => ({})), "tok", { onDatacenterIp: false });
  await assert.rejects(() => runner({ host: "ex.com", recipe: RECIPE, creds: CREDS, stickyExitId: "x" }), /capture boom/);
  assert.deepEqual(closed, ["h1"]);
});

test("runner: rejects a recipe whose loginUrl host differs from the entry host, before opening a session", async () => {
  const { gateway, opened } = fakeGateway(fakeCore(STATE));
  const runner = makeGatewayLoginRunner(gateway, new SecretStore(() => ({})), "tok", { onDatacenterIp: false });
  await assert.rejects(
    () => runner({ host: "other.com", recipe: RECIPE, creds: CREDS, stickyExitId: "x" }),
    /does not match the entry host/,
  );
  assert.equal(opened.length, 0, "no session opened on a host mismatch");
});

test("the assisted-login / vault-login surface is NEVER wired into the MCP server (not an agent tool)", () => {
  // Regression backstop for KTD-5: the server maps tools from the DriveController interface only,
  // which has no login method. Assert the compiled server module references none of the login
  // surface, so a future change can't accidentally registerTool the capture flow.
  const server = readFileSync(new URL("../dist/mcp/server.js", import.meta.url), "utf8");
  for (const ref of ["vault-login", "vaultLogin", "captureLogin", "assistedLogin", "gateway-login-runner"]) {
    assert.ok(!server.includes(ref), `dist/mcp/server.js must not reference "${ref}"`);
  }
});
