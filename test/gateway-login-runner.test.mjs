/**
 * Unit tests for the production vault login-runner glue (U6d). The browser/gateway integration is
 * thin, so it is exercised against a fake gateway + a fake core whose navigate() returns scripted
 * snapshots (clean / CF-blocked / dead) to drive the DIRECT-FIRST, escalate-on-block proxy decision
 * (R7). The live path is proven by scripts/validate-vault-login.mjs. Also asserts the assisted-login
 * surface is never wired into the MCP server (so it can never become an agent tool — KTD-5).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeGatewayLoginRunner } from "../dist/mcp/gateway-login-runner.js";
import { SecretStore } from "../dist/security/index.js";
import { PROXY_OPEN_ATTEMPTS } from "../dist/verbs/index.js";

const STATE = {
  cookies: [{ name: "sid", value: "v", domain: "ex.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }],
  origins: [],
};
const RECIPE = { loginUrl: "https://ex.com/login", usernameField: "#u", passwordField: "#p", submit: "#s", successText: "AUTHENTICATED" };
const CREDS = { username: "u", password: "p" };
const PROXY_SECRETS = () => new SecretStore(() => ({ BGW_PROXY_URL: "http://p:1", BGW_PROXY_PASSWORD: "pw" }));

// Navigate snapshots: a cleared page, a Cloudflare managed challenge (escalatable), and a dead/
// unreachable nav (null status — NOT escalatable, a fresh exit won't fix it).
const clean = (url = "https://ex.com/login") => ({ url, title: "t", tree: "AUTHENTICATED " + "x".repeat(200), status: 200 });
const blockedCF = (url = "https://ex.com/login") => ({ url, title: "Just a moment...", tree: "", status: 403, cfHint: true });
const dead = (url = "https://ex.com/login") => ({ url, title: "", tree: "", status: null });

/** A fake core: navigate() pops scripted snapshots (then falls back to `defaultNav`); the
 *  assisted-login surface always succeeds. */
function fakeCore({ navQueue = [], defaultNav = clean, state = STATE, throwOnCapture = false } = {}) {
  const q = [...navQueue];
  return {
    async navigate(url) { return q.shift() ?? defaultNav(url); },
    async readField() { return { present: true, value: "" }; },
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
    async openConsumerSession(token, override) { opened.push(override); return `h${opened.length}`; },
    async useConsumerSession(token, handle, fn) { return fn({ core }, { id: "atlas" }); },
    async closeConsumerSession(token, handle) { closed.push(handle); },
  };
  return { gateway, opened, closed };
}

test("direct-first: a login that clears direct is NOT proxied, even with a proxy on a datacenter IP (R7)", async () => {
  const { gateway, opened } = fakeGateway(fakeCore({ navQueue: [clean()] }));
  const runner = makeGatewayLoginRunner(gateway, PROXY_SECRETS(), "tok", { onDatacenterIp: true, stickySuffix: "_s-{id}" });
  const res = await runner({ host: "ex.com", recipe: RECIPE, creds: CREDS });
  assert.equal(opened.length, 1, "only the direct session opened");
  assert.equal(opened[0], undefined, "first request is DIRECT (no proxy override)");
  assert.equal(res.stickyExitId, undefined, "a direct capture binds no exit");
  assert.deepEqual(res.state, STATE);
});

test("escalate-on-block: a CF managed challenge escalates to a pinned residential exit, recording the bound id", async () => {
  const { gateway, opened } = fakeGateway(fakeCore({ navQueue: [blockedCF(), clean()] }));
  const runner = makeGatewayLoginRunner(gateway, PROXY_SECRETS(), "tok", { onDatacenterIp: true, stickySuffix: "_s-{id}" });
  const res = await runner({ host: "ex.com", recipe: RECIPE, creds: CREDS });
  assert.equal(opened.length, 2, "direct then escalated (landed on the first proxied exit)");
  assert.equal(opened[0], undefined, "first DIRECT");
  assert.match(opened[1].proxy.password, /_s-[0-9a-f]{8}$/, "escalated to a pinned sticky exit");
  assert.match(res.stickyExitId, /^[0-9a-f]{8}$/);
  assert.ok(opened[1].proxy.password.endsWith(res.stickyExitId), "the recorded id matches the pinned exit");
});

test("escalation retries FRESH exits (new sticky id each) until one lands — a dead exit doesn't fail the capture", async () => {
  // direct blocked → first proxied exit is dead → second proxied exit lands.
  const { gateway, opened } = fakeGateway(fakeCore({ navQueue: [blockedCF(), dead(), clean()] }));
  const runner = makeGatewayLoginRunner(gateway, PROXY_SECRETS(), "tok", { onDatacenterIp: true, stickySuffix: "_s-{id}" });
  const res = await runner({ host: "ex.com", recipe: RECIPE, creds: CREDS });
  assert.equal(opened.length, 3, "direct + two proxied attempts");
  assert.notEqual(opened[1].proxy.password, opened[2].proxy.password, "each retry draws a FRESH exit (distinct id)");
  assert.ok(opened[2].proxy.password.endsWith(res.stickyExitId), "bound to the exit that actually landed");
});

test("escalation that exhausts all attempts throws after N tries (no false success)", async () => {
  // direct blocked, then every proxied exit is dead → exhaust PROXY_OPEN_ATTEMPTS.
  const { gateway, opened } = fakeGateway(fakeCore({ navQueue: [blockedCF()], defaultNav: dead }));
  const runner = makeGatewayLoginRunner(gateway, PROXY_SECRETS(), "tok", { onDatacenterIp: true, stickySuffix: "_s-{id}" });
  await assert.rejects(() => runner({ host: "ex.com", recipe: RECIPE, creds: CREDS }), new RegExp(`after ${PROXY_OPEN_ATTEMPTS} attempts`));
  assert.equal(opened.length, 1 + PROXY_OPEN_ATTEMPTS, "direct + one open per retry attempt");
});

test("a block with no residential proxy to escalate to fails clearly (no silent direct success)", async () => {
  const { gateway, opened } = fakeGateway(fakeCore({ navQueue: [blockedCF()] }));
  const runner = makeGatewayLoginRunner(gateway, new SecretStore(() => ({})), "tok", { onDatacenterIp: true });
  await assert.rejects(() => runner({ host: "ex.com", recipe: RECIPE, creds: CREDS }), /blocked and could not be cleared/);
  assert.deepEqual(opened, [undefined], "only the direct session was opened");
});

test("a non-escalatable failure (dead/unreachable, not a CF challenge) does NOT proxy", async () => {
  const { gateway, opened } = fakeGateway(fakeCore({ navQueue: [dead()] }));
  const runner = makeGatewayLoginRunner(gateway, PROXY_SECRETS(), "tok", { onDatacenterIp: true, stickySuffix: "_s-{id}" });
  await assert.rejects(() => runner({ host: "ex.com", recipe: RECIPE, creds: CREDS }), /blocked and could not be cleared/);
  assert.deepEqual(opened, [undefined], "never escalated for a non-qualifying block");
});

test("runner: closes the session even when the login throws after landing (no held capture session leaks)", async () => {
  const { gateway, closed } = fakeGateway(fakeCore({ navQueue: [clean()], throwOnCapture: true }));
  const runner = makeGatewayLoginRunner(gateway, new SecretStore(() => ({})), "tok", { onDatacenterIp: false });
  await assert.rejects(() => runner({ host: "ex.com", recipe: RECIPE, creds: CREDS }), /capture boom/);
  assert.deepEqual(closed, ["h1"]);
});

test("runner: rejects a recipe whose loginUrl host differs from the entry host, before opening a session", async () => {
  const { gateway, opened } = fakeGateway(fakeCore({ navQueue: [clean()] }));
  const runner = makeGatewayLoginRunner(gateway, new SecretStore(() => ({})), "tok", { onDatacenterIp: false });
  await assert.rejects(
    () => runner({ host: "other.com", recipe: RECIPE, creds: CREDS }),
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
