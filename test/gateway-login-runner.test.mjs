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
const PROXY_SECRETS = () => new SecretStore(() => ({ BGW_PROXY_URL: "http://p:1", BGW_PROXY_PASSWORD: "pwd" }));

// Navigate snapshots: a cleared page, a Cloudflare managed challenge (escalatable), and a dead/
// unreachable nav (null status — NOT escalatable, a fresh exit won't fix it).
const clean = (url = "https://ex.com/login") => ({ url, title: "t", tree: "AUTHENTICATED " + "x".repeat(200), status: 200 });
const blockedCF = (url = "https://ex.com/login") => ({ url, title: "Just a moment...", tree: "", status: 403, cfHint: true });
const dead = (url = "https://ex.com/login") => ({ url, title: "", tree: "", status: null });
// VIL-137: a thin page on a status no fresh exit can change, and a LIVE CF challenge served on one.
const thinStatus = (status) => (url = "https://ex.com/login") => ({ url, title: "Not Found", tree: "nope", status, responseReceived: true });
const liveCF429 = (url = "https://ex.com/login") => ({ url, title: "Just a moment...", tree: "", status: 429, cfHint: true, responseReceived: true });

/** A fake core: navigate() pops scripted snapshots (then falls back to `defaultNav`); the
 *  assisted-login surface always succeeds. */
function fakeCore({ navQueue = [], defaultNav = clean, state = STATE, throwOnCapture = false } = {}) {
  const q = [...navQueue];
  return {
    async navigate(url) { const n = q.length ? q.shift() : defaultNav(url); if (n instanceof Error) throw n; return n; },
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

test("a retry session whose navigate THROWS is closed, not leaked (PR #32 P1 round 3)", async () => {
  // direct blocked → escalate → the proxied navigate REJECTS (e.g. session reaped). The opened retry
  // session must be closed by the per-attempt cleanup; before the fix it leaked (only the direct
  // session was closed).
  const { gateway, opened, closed } = fakeGateway(fakeCore({ navQueue: [blockedCF(), new Error("nav boom")] }));
  const runner = makeGatewayLoginRunner(gateway, PROXY_SECRETS(), "tok", { onDatacenterIp: true, stickySuffix: "_s-{id}" });
  await assert.rejects(() => runner({ host: "ex.com", recipe: RECIPE, creds: CREDS }), /nav boom/);
  assert.equal(opened.length, 2, "direct + one proxied retry opened");
  assert.deepEqual(closed, ["h1", "h2"], "BOTH the direct and the retry session were closed — no leak");
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

test("force-proxy host: begins on a PINNED residential exit — no direct session is ever opened (issue #21)", async () => {
  const { gateway, opened } = fakeGateway(fakeCore({ navQueue: [clean()] }));
  const runner = makeGatewayLoginRunner(gateway, PROXY_SECRETS(), "tok", { onDatacenterIp: true, stickySuffix: "_s-{id}", forceProxyHosts: ["ex.com"] });
  const res = await runner({ host: "ex.com", recipe: RECIPE, creds: CREDS });
  assert.equal(opened.length, 1, "exactly one session — the proxied one (no wasted direct attempt)");
  assert.ok(opened[0]?.proxy, "first request is PROXIED, not direct");
  assert.match(opened[0].proxy.password, /_s-[0-9a-f]{8}$/, "pinned to a sticky exit");
  assert.ok(opened.every((o) => o !== undefined), "NO direct (undefined-override) session is ever opened for a forced host");
  assert.ok(opened[0].proxy.password.endsWith(res.stickyExitId), "entry bound to the forced exit (warm replay re-pins it)");
});

test("force-proxy host with no residential proxy fails LOUD — never falls back to a direct login", async () => {
  const { gateway, opened } = fakeGateway(fakeCore({ navQueue: [clean()] }));
  const runner = makeGatewayLoginRunner(gateway, new SecretStore(() => ({})), "tok", { onDatacenterIp: true, forceProxyHosts: ["ex.com"] });
  await assert.rejects(() => runner({ host: "ex.com", recipe: RECIPE, creds: CREDS }), /force-proxy is configured.*no residential proxy is available/);
  assert.equal(opened.length, 0, "no session opened at all — never a direct fallback");
});

test("force-proxy by subdomain suffix (totalwine.com covers www.totalwine.com)", async () => {
  const recipe = { ...RECIPE, loginUrl: "https://www.shop.test/login" };
  const { gateway, opened } = fakeGateway(fakeCore({ navQueue: [clean("https://www.shop.test/login")] }));
  const runner = makeGatewayLoginRunner(gateway, PROXY_SECRETS(), "tok", { onDatacenterIp: true, stickySuffix: "_s-{id}", forceProxyHosts: ["shop.test"] });
  const res = await runner({ host: "www.shop.test", recipe, creds: CREDS });
  assert.ok(opened[0]?.proxy, "subdomain of a forced suffix is proxied from the first request");
  assert.ok(res.stickyExitId, "bound to the forced exit");
});

test("a non-forced host is unaffected — still DIRECT-first even with a force list set for OTHER hosts", async () => {
  const { gateway, opened } = fakeGateway(fakeCore({ navQueue: [clean()] }));
  const runner = makeGatewayLoginRunner(gateway, PROXY_SECRETS(), "tok", { onDatacenterIp: true, stickySuffix: "_s-{id}", forceProxyHosts: ["other.test"] });
  const res = await runner({ host: "ex.com", recipe: RECIPE, creds: CREDS });
  assert.deepEqual(opened, [undefined], "ex.com is not on the list → first request is DIRECT");
  assert.equal(res.stickyExitId, undefined, "direct capture binds no exit");
});

test("force-proxy with a proxy but NO sticky suffix fails LOUD — never stores a falsely R3-bound entry (PR #34 P1)", async () => {
  // Rotating-exit config (BGW_PROXY_STICKY_SUFFIX unset): a stored stickyExitId could not re-pin the
  // capture IP, so a forced capture must refuse rather than mint a meaningless id.
  const { gateway, opened } = fakeGateway(fakeCore({ navQueue: [clean()] }));
  const runner = makeGatewayLoginRunner(gateway, PROXY_SECRETS(), "tok", { onDatacenterIp: true, forceProxyHosts: ["ex.com"] });
  await assert.rejects(() => runner({ host: "ex.com", recipe: RECIPE, creds: CREDS }), /BGW_PROXY_STICKY_SUFFIX is unset/);
  assert.equal(opened.length, 0, "no proxied session opened — never a rotating capture mislabeled as pinned");
});

test("escalation with a proxy but NO sticky suffix fails LOUD — no false-bound entry (PR #34 P1)", async () => {
  // Direct gets a CF block, but with no suffix the escalated exit would rotate (and couldn't clear the
  // interstitial anyway) — so refuse instead of opening a rotating exit and storing a bogus id.
  const { gateway, opened } = fakeGateway(fakeCore({ navQueue: [blockedCF()] }));
  const runner = makeGatewayLoginRunner(gateway, PROXY_SECRETS(), "tok", { onDatacenterIp: true });
  await assert.rejects(() => runner({ host: "ex.com", recipe: RECIPE, creds: CREDS }), /no re-pinnable residential exit/);
  assert.deepEqual(opened, [undefined], "only the direct probe opened; no rotating exit was pinned + stored");
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

// --- VIL-137: the unclearable-status rule reaches the login runner's proxied loop ----------------------

for (const status of [404, 410, 429]) {
  test(`forced host whose login URL answers a thin ${status}: ONE exit, then a clear stop (not ${PROXY_OPEN_ATTEMPTS} exits)`, async () => {
    const { gateway, opened, closed } = fakeGateway(fakeCore({ defaultNav: thinStatus(status) }));
    const runner = makeGatewayLoginRunner(gateway, PROXY_SECRETS(), "tok", { onDatacenterIp: true, stickySuffix: "_s-{id}", forceProxyHosts: ["ex.com"] });
    await assert.rejects(
      () => runner({ host: "ex.com", recipe: RECIPE, creds: CREDS }),
      new RegExp(`answered HTTP ${status} on a residential exit .* stopped after 1 of ${PROXY_OPEN_ATTEMPTS} attempts`),
    );
    assert.equal(opened.length, 1, "a fresh exit cannot change this status, so only one was drawn");
    assert.deepEqual(closed, ["h1"], "the one proxied session is closed, not leaked");
  });
}

test("escalated capture whose proxied exit lands a thin 404: stops after that exit", async () => {
  const { gateway, opened } = fakeGateway(fakeCore({ navQueue: [blockedCF()], defaultNav: thinStatus(404) }));
  const runner = makeGatewayLoginRunner(gateway, PROXY_SECRETS(), "tok", { onDatacenterIp: true, stickySuffix: "_s-{id}" });
  await assert.rejects(() => runner({ host: "ex.com", recipe: RECIPE, creds: CREDS }), /answered HTTP 404/);
  assert.equal(opened.length, 2, "direct + exactly one proxied exit");
});

test("a LIVE Cloudflare challenge on a 429 keeps its full exit budget (a clean exit can clear it)", async () => {
  const { gateway, opened } = fakeGateway(fakeCore({ defaultNav: liveCF429 }));
  const runner = makeGatewayLoginRunner(gateway, PROXY_SECRETS(), "tok", { onDatacenterIp: true, stickySuffix: "_s-{id}", forceProxyHosts: ["ex.com"] });
  await assert.rejects(() => runner({ host: "ex.com", recipe: RECIPE, creds: CREDS }), new RegExp(`after ${PROXY_OPEN_ATTEMPTS} attempts`));
  assert.equal(opened.length, PROXY_OPEN_ATTEMPTS);
});

test("DECIDED POLICY: a hint-only CF page (marker, no visible phrase) on a 429 stops after one exit", async () => {
  // On 404/410/429 a Cloudflare marker without the visible challenge phrase is treated as a persistent
  // residue, not a live challenge — the same rule the entry gates use (VIL-137 item 2, operator decision
  // 2026-10-07, PR #163) and the shared re-roll predicate isTerminalUnclearableRender. A live challenge
  // on those statuses (visible phrase) keeps its full exit budget; see the liveCF429 test above.
  const hintOnly429 = (url = "https://ex.com/login") => ({ url, title: "Too Many Requests", tree: "slow down", status: 429, cfHint: true, responseReceived: true });
  const { gateway, opened } = fakeGateway(fakeCore({ defaultNav: hintOnly429 }));
  const runner = makeGatewayLoginRunner(gateway, PROXY_SECRETS(), "tok", { onDatacenterIp: true, stickySuffix: "_s-{id}", forceProxyHosts: ["ex.com"] });
  await assert.rejects(() => runner({ host: "ex.com", recipe: RECIPE, creds: CREDS }), /answered HTTP 429/);
  assert.equal(opened.length, 1);
});

test("a DEAD exit carrying a stale 404 is not read as the site's answer — the next exit is still tried", async () => {
  const staleDead = (url = "https://ex.com/login") => ({ url, title: "", tree: "", status: 404, responseReceived: false });
  const { gateway, opened } = fakeGateway(fakeCore({ navQueue: [staleDead(), clean()] }));
  const runner = makeGatewayLoginRunner(gateway, PROXY_SECRETS(), "tok", { onDatacenterIp: true, stickySuffix: "_s-{id}", forceProxyHosts: ["ex.com"] });
  const res = await runner({ host: "ex.com", recipe: RECIPE, creds: CREDS });
  assert.equal(opened.length, 2);
  assert.ok(opened[1].proxy.password.endsWith(res.stickyExitId));
});
