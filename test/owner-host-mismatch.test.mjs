/**
 * R1 (#79) keystone — owner-host contract. A WARM drive session is security-clamped to ONE owner host
 * (the credential owner). A cross-host navigation must be refused BEFORE the wire with a typed
 * `owner-host-mismatch` result that PRESERVES the session — never the old behavior where the pinned
 * handler read the clamp's self-refusal (ERR_BLOCKED_BY_CLIENT → null status → navFailed) as a dead exit
 * and #discardSession'd a still-valid session (with its live WAF clearance). These tests exercise the
 * pre-flight with a fake gateway/core (no real browser); the live sequence is proven in-container by
 * scripts/validate-owner-host.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { GatewayDriveController } from "../dist/mcp/drive-controller.js";
import { SecretStore } from "../dist/security/index.js";
import { failureOf } from "../dist/observability/index.js";
import { Allowlist } from "../dist/policy/index.js";

const SUFFIX = "_country-us_session-{id}_lifetime-30m";
const HOST = "www.totalwine.com";
const SESSION = {
  cookies: [{ name: "sid", value: "x".repeat(40), domain: "totalwine.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }],
  origins: [{ origin: "https://www.totalwine.com", localStorage: [{ name: "k", value: "v" }] }],
};
// An UNBOUND entry (no stickyExitId) replays DIRECT — a warm-open that needs no proxy, so the fixture pins
// a warm session with no residential wiring. #warmHost is set from the sealed restoreState.ownerHost = HOST.
const ENTRY = { session: SESSION, creds: { username: "u", password: "p".repeat(20) }, updatedAt: 1 };
const vaultOf = (entry) => ({ get: () => entry, has: () => !!entry, put() {}, remove: () => false });
const proxySecrets = () => new SecretStore(() => ({ BGW_PROXY_URL: "http://proxy.test:8080", BGW_PROXY_USERNAME: "puser", BGW_PROXY_PASSWORD: "ppass" }));

/** A fake gateway/core that returns a healthy 200 for every nav and records open/close/navigate events.
 *  Only OWNER-host navigates ever reach core.navigate — a cross-host nav is refused before the wire. */
function makeGateway() {
  let n = 1;
  const open = new Map();
  const events = [];
  const page = (url) => ({ url, title: "ok", tree: "real content ".repeat(12), status: 200 });
  const core = {
    async navigate(url) { events.push(["navigate", url]); return page(url); },
    async snapshot() { events.push(["snapshot"]); return page(`https://${HOST}/`); },
  };
  const gateway = {
    sessions: { get: (h) => open.get(h) },
    async openConsumerSession() { const id = "h" + n++; open.set(id, { core }); events.push(["open", id]); return id; },
    async useConsumerSession(_t, h, fn) { const s = open.get(h); if (!s) throw new Error("no session"); return fn(s); },
    async closeConsumerSession(_t, h) { open.delete(h); events.push(["close", h]); },
  };
  return { gateway, events, open };
}

const warmCtl = (g, allowlistHosts) =>
  new GatewayDriveController(g.gateway, proxySecrets(), "tok", {
    onDatacenterIp: true, stickySuffix: SUFFIX,
    vault: vaultOf(ENTRY), consumerId: "atlas", allowlist: new Allowlist(allowlistHosts),
  });

const counts = (events) => ({
  opens: events.filter((e) => e[0] === "open").length,
  closes: events.filter((e) => e[0] === "close").length,
  navs: events.filter((e) => e[0] === "navigate").map((e) => e[1]),
});

test("R1: warm cross-host nav to an OFF-SCOPE host → typed refusal, session PRESERVED, no wire", async () => {
  const g = makeGateway();
  const c = warmCtl(g, ["totalwine.com"]); // costco is NOT in scope
  const first = await c.navigate(`https://${HOST}/account`);
  assert.equal(first.status, 200, "warm-open pins on the owner host");
  assert.equal(g.open.size, 1, "one warm session open");
  const before = counts(g.events);

  const err = await c.navigate("https://www.costco.com/deals").then(() => null, (e) => e);
  assert.ok(err, "cross-host nav rejects");
  assert.match(err.message, /owner-host mismatch/i, "typed owner-host-mismatch message");
  assert.match(err.message, /out of this consumer's scope/i, "off-scope sub-case advice");
  assert.equal(failureOf(err)?.failureClass, "owner-host-mismatch", "own failure class — NOT nav-failed");

  const after = counts(g.events);
  assert.equal(g.open.size, 1, "session PRESERVED — not discarded");
  assert.equal(after.closes, before.closes, "no #discardSession (no close) on the refused nav");
  assert.equal(after.opens, before.opens, "no new session opened for the refused nav");
  assert.ok(!after.navs.some((u) => u.includes("costco")), "the cross-host nav NEVER reached the wire");
});

test("R1: warm cross-host nav to an IN-SCOPE non-owner host → 'open a separate drive session'", async () => {
  const g = makeGateway();
  const c = warmCtl(g, ["totalwine.com", "example.com"]); // example.com IS in scope, but not the owner
  await c.navigate(`https://${HOST}/account`);

  const err = await c.navigate("https://example.com/x").then(() => null, (e) => e);
  assert.ok(err, "cross-host nav rejects");
  assert.match(err.message, /open a separate drive session/i, "in-scope sub-case advice");
  assert.match(err.message, /pinned to www\.totalwine\.com/i, "names the current owner host");
  assert.equal(failureOf(err)?.failureClass, "owner-host-mismatch", "own failure class");
  assert.equal(g.open.size, 1, "session preserved");
});

test("R1: after a refused cross-host nav, returning to the OWNER host reuses the SAME warm session", async () => {
  const g = makeGateway();
  const c = warmCtl(g, ["totalwine.com"]);
  await c.navigate(`https://${HOST}/account`);
  const opensAfterWarm = counts(g.events).opens;

  await assert.rejects(() => c.navigate("https://www.costco.com/"), /owner-host mismatch/i);
  const back = await c.navigate(`https://${HOST}/cart`); // same owner, different path
  assert.equal(back.status, 200, "return to the owner host succeeds");
  assert.equal(counts(g.events).opens, opensAfterWarm, "reused the warm session — NO re-open (clearance intact)");
});

test("R1: a same-owner nav to a different PATH is NOT refused (host-level check only)", async () => {
  const g = makeGateway();
  const c = warmCtl(g, ["totalwine.com"]);
  await c.navigate(`https://${HOST}/`);
  const deep = await c.navigate(`https://${HOST}/product/12345`);
  assert.equal(deep.status, 200, "same-owner different-path proceeds normally");
});

test("R1: the refusal is WARM-ONLY — a COLD pinned session's cross-host nav is not owner-host-refused", async () => {
  // A cold session has no #warmHost, so R1's pre-flight never fires; the off-owner nav is a separate case
  // (R2's post-wire policy-block capture), NOT an owner-host mismatch. Here the fake has no clamp, so it
  // simply proceeds — the point is only that R1 does not misfire on a cold session.
  const g = makeGateway();
  const c = new GatewayDriveController(g.gateway, proxySecrets(), "tok"); // no vault → cold
  const first = await c.navigate("https://example.com/"); // direct, pins cold
  assert.equal(first.status, 200);
  const err = await c.navigate("https://other.example/").then(() => null, (e) => e);
  assert.equal(err, null, "cold cross-host nav is NOT refused by R1's warm-only owner-host check");
  assert.notEqual(failureOf(err ?? {})?.failureClass, "owner-host-mismatch");
});
