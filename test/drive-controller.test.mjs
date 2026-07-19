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
import { isSealedRestore } from "../dist/browser/index.js";
import { Allowlist } from "../dist/policy/index.js";

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

test("controller: a post-action block preserves the failure envelope across #run's redaction re-wrap (issue #39)", async () => {
  // #actAndSnap throws attachFailure(...) INSIDE #run, whose catch re-wraps into a fresh redacted Error —
  // the non-enumerable `.failure` must be carried over, or the drive envelope is lost on this path.
  const { failureOf } = await import("../dist/observability/index.js");
  const { gateway } = makePostActionBlockGateway({
    url: "https://blocked.example/final", title: "403 Forbidden", tree: "Forbidden", status: 403,
    diagnostics: { finalUrl: "https://blocked.example/final", title: "403 Forbidden", status: 403,
      consoleErrors: ["error: waf blocked"], redirectChain: ["https://blocked.example/final"] },
  });
  const c = new GatewayDriveController(gateway, noSecrets(), "tok");
  await c.navigate("https://example.com/");
  let caught;
  try { await c.click({ target: "e1" }); } catch (err) { caught = err; }
  assert.ok(caught, "the action must throw");
  const env = failureOf(caught);
  assert.ok(env, "the failure envelope survives #run's redaction re-wrap");
  assert.equal(env.finalUrl, "https://blocked.example/final");
  assert.equal(env.status, 403);
});

/** A fake whose first navigate succeeds, then the next ACTION throws; snapshot returns `currentSnap`
 *  (or throws when `snapshotThrows`) so the best-effort action-exception snapshot can be exercised. */
function makeActionThrowsGateway(currentSnap, { snapshotThrows = false } = {}) {
  let nextId = 1;
  const open = new Map();
  const core = {
    async navigate() { return { url: "u", title: "ok", tree: "form [ref=e1]", status: 200 }; },
    async click() { throw new Error("locator.click: Timeout 10000ms exceeded"); },
    async type() { throw new Error("locator.fill: Element is not attached to the DOM"); },
    async snapshot() { if (snapshotThrows) throw new Error("page crashed"); return currentSnap; },
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

test("controller: a THROWING click attaches a best-effort failure envelope (issue #39, action-exception)", async () => {
  const { failureOf } = await import("../dist/observability/index.js");
  const { gateway } = makeActionThrowsGateway({
    url: "https://cur.example/", title: "current", tree: "form [ref=e1]", status: 200,
    diagnostics: { finalUrl: "https://cur.example/", title: "current", status: 200, consoleErrors: ["error: boom"] },
  });
  const c = new GatewayDriveController(gateway, noSecrets(), "tok");
  await c.navigate("https://example.com/");
  let caught;
  try { await c.click({ target: "e1" }); } catch (e) { caught = e; }
  assert.ok(caught, "the throwing action propagates");
  assert.match(caught.message, /Timeout/, "the original action error is preserved");
  const env = failureOf(caught);
  assert.ok(env, "the action-exception path attaches an envelope from a best-effort snapshot");
  assert.equal(env.finalUrl, "https://cur.example/");
});

test("controller: a THROWING type also carries the envelope", async () => {
  const { failureOf } = await import("../dist/observability/index.js");
  const { gateway } = makeActionThrowsGateway({
    url: "https://cur.example/", title: "current", tree: "form [ref=e1]", status: 200,
    diagnostics: { finalUrl: "https://cur.example/", status: 200 },
  });
  const c = new GatewayDriveController(gateway, noSecrets(), "tok");
  await c.navigate("https://example.com/");
  let caught;
  try { await c.type({ target: "e1" }, "hi"); } catch (e) { caught = e; }
  assert.ok(caught && failureOf(caught), "the throwing type attaches an envelope");
});

test("controller: a throwing action whose best-effort snapshot ALSO fails still propagates cleanly (no envelope)", async () => {
  const { failureOf } = await import("../dist/observability/index.js");
  const { gateway } = makeActionThrowsGateway(undefined, { snapshotThrows: true });
  const c = new GatewayDriveController(gateway, noSecrets(), "tok");
  await c.navigate("https://example.com/");
  let caught;
  try { await c.click({ target: "e1" }); } catch (e) { caught = e; }
  assert.ok(caught, "the action error still propagates when the recovery snapshot also fails");
  assert.match(caught.message, /Timeout/);
  assert.equal(failureOf(caught), undefined, "no envelope when no snapshot could be taken");
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
  const secrets = new SecretStore(() => ({ BGW_PROXY_URL: "http://proxy:8080", BGW_PROXY_PASSWORD: "pwd" }));
  const c = new GatewayDriveController(gateway, secrets, "tok", { onDatacenterIp: true, stickySuffix: "_s-{id}" });
  const snap = await c.navigate("https://hard.example/");
  assert.equal(snap.status, 200, "escalation landed the page");
  assert.equal(opens.length, 3, "1 direct open + 2 proxied attempts");
  assert.equal(opens[0], undefined, "first open is direct (no override)");
  const proxiedPw = opens.slice(1).map((o) => o?.proxy?.password);
  for (const pw of proxiedPw) assert.match(pw, /^pwd_s-[0-9a-f]+$/, "sticky suffix applied per proxied open");
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
  const secrets = new SecretStore(() => ({ BGW_PROXY_URL: "http://proxy:8080", BGW_PROXY_PASSWORD: "pwd" }));
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
      if (key === "BGW_PROXY_PASSWORD") return "pwd";
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

test("controller: a session-OPEN error carrying proxy credentials is redacted too (audit #2)", async () => {
  // The open path (launch + warm-cookie restore + proxy connect) throws OUTSIDE #run's scrub. It must
  // redact at the open boundary too, not lean on the session-manager's static CORE_LAUNCH re-wrap.
  const proxyUrl = "http://user:sup3r-secret-proxy-pass@proxy.example:8080";
  const secrets = new SecretStore(() => ({ BGW_PROXY_URL: proxyUrl }));
  const gateway = {
    sessions: { get: () => undefined },
    // Simulate a launch/proxy failure AT OPEN whose message embeds the BYO proxy credentials.
    async openConsumerSession() {
      throw new Error(`net::ERR_PROXY_CONNECTION_FAILED launching via ${proxyUrl}`);
    },
    async useConsumerSession() {
      throw new Error("unreached: open failed first");
    },
    async closeConsumerSession() {},
  };
  const c = new GatewayDriveController(gateway, secrets, "tok");
  const assertRedacted = (label) => (e) => {
    assert.ok(!e.message.includes("sup3r-secret-proxy-pass"), `raw secret must not survive ${label}`);
    assert.ok(!e.message.includes(proxyUrl), `the proxy URL must be redacted from ${label}`);
    return true;
  };
  // Both entries into the open path: the explicit open(), and the lazy open on the first navigate.
  await assert.rejects(c.open(), assertRedacted("open()"));
  await assert.rejects(c.navigate("https://example.com/"), assertRedacted("the navigate open path"));
});

test("controller: a WARM session-open error carrying a secret is redacted (audit #2 warm-restore vector)", async () => {
  // The warm open path (vault-restored cookies + proxy connect) is the audit's named vector. It routes
  // through the SAME redaction helper as the cold open, so a secret in a warm-open throw is scrubbed too.
  const proxyUrl = "http://user:sup3r-secret-proxy-pass@proxy.example:8080";
  const secrets = new SecretStore(() => ({ BGW_PROXY_URL: proxyUrl }));
  const gateway = {
    sessions: { get: () => undefined },
    async openConsumerSession() {
      throw new Error(`net::ERR_TUNNEL_CONNECTION_FAILED restoring warm session via ${proxyUrl}`);
    },
    async useConsumerSession() {
      throw new Error("unreached: warm open failed first");
    },
    async closeConsumerSession() {},
  };
  const vault = makeVault("vault", "example.com", warmEntry("example.com"));
  const c = new GatewayDriveController(gateway, secrets, "tok", {
    vault, consumerId: "vault", allowlist: allowAll,
  });
  await assert.rejects(c.navigate("https://example.com/dashboard"), (e) => {
    assert.ok(!e.message.includes("sup3r-secret-proxy-pass"), "raw secret must not survive warm open");
    assert.ok(!e.message.includes(proxyUrl), "the proxy URL must be redacted from the warm open path");
    return true;
  });
});

// --- U9 warm-open (consumer-facing trigger) --------------------------------------------------------

/** A recording gateway that captures every open's coreOverrides + navigate opts + closed handles, and
 *  returns a controllable sequence of navigate snapshots (default: a 200 OK page). */
function makeRecordingGateway(navSeq) {
  let nextId = 1;
  const open = new Map();
  const opens = []; // coreOverrides per openConsumerSession (undefined = cold)
  const navOpts = [];
  const closed = [];
  let navs = 0;
  const ok = (url) => ({ url, title: "ok", tree: "- x [ref=e1]", status: 200 });
  const gateway = {
    sessions: { get: (h) => open.get(h) },
    async openConsumerSession(_t, override) {
      opens.push(override);
      const id = "h" + nextId++;
      open.set(id, {
        core: {
          async navigate(url, opts) {
            navOpts.push(opts);
            const seq = navSeq ? navSeq[Math.min(navs, navSeq.length - 1)] : undefined;
            navs++;
            return seq ? { ...ok(url), ...seq } : ok(url);
          },
          async snapshot() { return ok("u"); },
        },
      });
      return id;
    },
    async useConsumerSession(_t, handle, fn) {
      const s = open.get(handle);
      if (!s) throw new Error(`no open session for handle ${handle}`);
      return fn(s);
    },
    async closeConsumerSession(_t, h) { if (open.delete(h)) closed.push(h); },
  };
  return { gateway, open, opens, navOpts, closed };
}

/** A duck-typed VaultEntryStore returning a captured entry for exactly the given (consumerId, host). */
function makeVault(consumerId, host, entry) {
  return {
    get(cid, h) { return cid === consumerId && h === host ? entry : null; },
    has(cid, h) { return cid === consumerId && h === host; },
    put() {},
    remove() { return false; },
  };
}

/** A captured vault entry whose durable cookie belongs to `host`. A bound `stickyExitId` makes warm
 *  replay re-pin a residential exit (R3); absent = a direct capture (replays direct). */
function warmEntry(host, opts = {}) {
  return {
    session: { cookies: [{ name: "sid", value: "logged-in", domain: host, path: "/" }], origins: [] },
    creds: { username: "u", password: "p" },
    ...(opts.stickyExitId ? { stickyExitId: opts.stickyExitId } : {}),
    updatedAt: 1,
  };
}

const allowAll = new Allowlist(["*"]);
const proxySecrets = () => new SecretStore(() => ({ BGW_PROXY_URL: "http://proxy:8080", BGW_PROXY_PASSWORD: "pwd" }));

test("warm-open: an approved host with a vault entry opens a SEALED, host-scoped warm session", async () => {
  const { gateway, opens, open } = makeRecordingGateway();
  const vault = makeVault("vault", "example.com", warmEntry("example.com"));
  const c = new GatewayDriveController(gateway, noSecrets(), "tok", {
    vault, consumerId: "vault", allowlist: allowAll,
  });
  const snap = await c.navigate("https://example.com/dashboard");
  assert.equal(snap.status, 200, "warm navigate landed");
  assert.equal(opens.length, 1, "exactly one session opened (no cold pre-open)");
  const ov = opens[0];
  assert.ok(ov?.restoreState, "the open carried a restoreState (warm), not a cold open");
  assert.ok(isSealedRestore(ov.restoreState), "the restoreState is SEALED (gateway will accept it)");
  assert.equal(ov.restoreState.ownerHost, "example.com", "owner host is the vault-keyed host");
  assert.equal(
    ov.restoreState.state.cookies.length, 1,
    "only the owner-host cookie survived host-scoping",
  );
  assert.equal(ov.proxy, undefined, "a direct-captured entry replays DIRECT (no proxy)");
  assert.equal(open.size, 1);
});

test("warm-open: a host NOT on the consumer's allowlist opens COLD (no credential injected)", async () => {
  const { gateway, opens } = makeRecordingGateway();
  const vault = makeVault("vault", "example.com", warmEntry("example.com"));
  const c = new GatewayDriveController(gateway, noSecrets(), "tok", {
    vault, consumerId: "vault", allowlist: new Allowlist(["other.test"]),
  });
  await c.navigate("https://example.com/");
  assert.equal(opens[0], undefined, "cold open (no restoreState) — host is not approved");
});

test("warm-open: vault dormant (null) opens COLD", async () => {
  const { gateway, opens } = makeRecordingGateway();
  const c = new GatewayDriveController(gateway, noSecrets(), "tok", {
    vault: null, consumerId: "vault", allowlist: allowAll,
  });
  await c.navigate("https://example.com/");
  assert.equal(opens[0], undefined, "cold open when the vault feature is off");
});

test("warm-open: no entry for the host opens COLD (graceful fallthrough)", async () => {
  const { gateway, opens } = makeRecordingGateway();
  const vault = makeVault("vault", "other.com", warmEntry("other.com")); // entry exists, but not for example.com
  const c = new GatewayDriveController(gateway, noSecrets(), "tok", {
    vault, consumerId: "vault", allowlist: allowAll,
  });
  await c.navigate("https://example.com/");
  assert.equal(opens[0], undefined, "cold open when no entry matches the navigated host");
});

test("warm-open: a pre-opened cold session is discarded before the warm open (no double-acquire)", async () => {
  const { gateway, opens, closed, open } = makeRecordingGateway();
  const vault = makeVault("vault", "example.com", warmEntry("example.com"));
  const c = new GatewayDriveController(gateway, noSecrets(), "tok", {
    vault, consumerId: "vault", allowlist: allowAll,
  });
  await c.open(); // pre-opens a cold direct session (handle h1)
  assert.equal(open.size, 1);
  await c.navigate("https://example.com/"); // must discard h1, then open warm
  assert.equal(opens[0], undefined, "first open was the cold pre-open");
  assert.ok(opens[1]?.restoreState, "second open is the warm session");
  assert.deepEqual(closed, ["h1"], "the pre-opened cold session was closed before warming");
  assert.equal(open.size, 1, "exactly one live session (no leak against the per-consumer cap)");
});

test("warm-open: a stale/blocked warm replay surfaces a re-capture error and does NOT fall back to cold", async () => {
  // The warm navigate lands a hard block (the stored login expired). The path must NOT silently
  // re-open cold (which would mask the staleness) — it surfaces an actionable operator-refresh error.
  const { gateway, opens, open } = makeRecordingGateway([{ status: 403, title: "Forbidden", tree: "Forbidden" }]);
  const vault = makeVault("vault", "example.com", warmEntry("example.com"));
  const c = new GatewayDriveController(gateway, noSecrets(), "tok", {
    vault, consumerId: "vault", allowlist: allowAll,
  });
  await assert.rejects(c.navigate("https://example.com/"), /warm.*failed|re-capture/i);
  assert.equal(opens.length, 1, "no cold fallback open after the warm failure");
  assert.equal(open.size, 0, "the failed warm session was discarded");
});

test("warm-open: a reaped DIRECT warm session re-warms on reopen (stays logged-in, never proxied)", async () => {
  const { gateway, opens, open } = makeRecordingGateway();
  const vault = makeVault("vault", "example.com", warmEntry("example.com")); // direct capture (no exit)
  const c = new GatewayDriveController(gateway, noSecrets(), "tok", {
    vault, consumerId: "vault", allowlist: allowAll,
  });
  await c.navigate("https://example.com/"); // warm-open, pinned
  const first = [...open.keys()][0];
  open.delete(first); // idle reap closes the held session out from under us
  await assert.rejects(c.navigate("https://example.com/"), /no open session/); // gone-session resets the handle
  await c.navigate("https://example.com/again"); // pinned-reopen path
  const reopen = opens[opens.length - 1];
  assert.ok(reopen?.restoreState && isSealedRestore(reopen.restoreState), "reopen re-warmed (sealed restore), not cold");
  assert.equal(reopen.restoreState.ownerHost, "example.com");
  assert.equal(reopen.proxy, undefined, "a direct warm session reopens DIRECT — #proxiedSession stayed false");
});

test("warm-open: a reaped BOUND warm session re-pins the SAME captured exit on reopen (R3)", async () => {
  const { gateway, opens, open } = makeRecordingGateway();
  const vault = makeVault("vault", "example.com", warmEntry("example.com", { stickyExitId: "abcd1234" }));
  const c = new GatewayDriveController(gateway, proxySecrets(), "tok", {
    vault, consumerId: "vault", allowlist: allowAll, onDatacenterIp: true, stickySuffix: "_s-{id}",
  });
  await c.navigate("https://example.com/"); // warm-open, re-pinned residential exit
  assert.ok(opens[0]?.proxy?.password, "bound entry replays through a re-pinned proxied exit");
  const pinnedPw = opens[0].proxy.password;
  const first = [...open.keys()][0];
  open.delete(first);
  await assert.rejects(c.navigate("https://example.com/"), /no open session/);
  await c.navigate("https://example.com/again");
  const reopen = opens[opens.length - 1];
  assert.ok(reopen?.restoreState, "reopen re-warmed");
  assert.equal(reopen.proxy?.password, pinnedPw, "reopen re-pinned the SAME captured exit (R3 stability)");
});

test("warm-open: a reaped warm session that re-warms STALE fails LOUD with the recapture error (reopen path)", async () => {
  // The loud-failure guarantee must hold on the reopen-after-reap path too, not just first-navigate —
  // and must NOT be the generic "retry for a fresh exit" (wrong for a bound entry that re-pins the same exit).
  const { gateway, open } = makeRecordingGateway([undefined, { status: 403, title: "Forbidden", tree: "Forbidden" }]);
  const vault = makeVault("vault", "example.com", warmEntry("example.com"));
  const c = new GatewayDriveController(gateway, noSecrets(), "tok", {
    vault, consumerId: "vault", allowlist: allowAll,
  });
  await c.navigate("https://example.com/"); // warm-open succeeds, pinned
  open.delete([...open.keys()][0]); // idle reap
  await assert.rejects(c.navigate("https://example.com/"), /no open session/); // gone-session resets handle
  await assert.rejects(c.navigate("https://example.com/again"), (e) => {
    assert.match(e.message, /re-capture this credential/);
    assert.doesNotMatch(e.message, /retry navigate for a fresh exit/);
    return true;
  });
});

test("warm-open: a foreign-host cookie in the entry is DROPPED from the restored override (R4 filter)", async () => {
  const { gateway, opens } = makeRecordingGateway();
  const entry = warmEntry("example.com");
  entry.session.cookies.push({ name: "evil", value: "x", domain: "other.test", path: "/" }); // not owner-host
  const vault = makeVault("vault", "example.com", entry);
  const c = new GatewayDriveController(gateway, noSecrets(), "tok", {
    vault, consumerId: "vault", allowlist: allowAll,
  });
  await c.navigate("https://example.com/");
  const cookies = opens[0].restoreState.state.cookies;
  assert.ok(cookies.some((ck) => ck.name === "sid"), "owner-host cookie survives host-scoping");
  assert.ok(!cookies.some((ck) => ck.name === "evil"), "foreign-host cookie is filtered out (no exfil jar)");
});

test("warm-open: a reaped warm session whose entry was REVOKED fails LOUD on reopen (no silent cold downgrade)", async () => {
  const { gateway, opens, open } = makeRecordingGateway();
  let live = warmEntry("example.com", { stickyExitId: "abcd1234" });
  const vault = {
    get(cid, h) { return cid === "vault" && h === "example.com" ? live : null; },
    has(cid, h) { return cid === "vault" && h === "example.com" && live !== null; },
    put() {}, remove() { return false; },
  };
  const c = new GatewayDriveController(gateway, proxySecrets(), "tok", {
    vault, consumerId: "vault", allowlist: allowAll, onDatacenterIp: true, stickySuffix: "_s-{id}",
  });
  await c.navigate("https://example.com/"); // bound warm-open (proxied), pinned
  assert.ok(opens[0]?.proxy, "bound warm session opened proxied");
  open.delete([...open.keys()][0]); // reap
  live = null; // entry revoked while the session was reaped
  await assert.rejects(c.navigate("https://example.com/"), /no open session/); // gone-session resets handle
  // Reopen finds no entry → must fail LOUD (a logged-in session must not silently become anonymous),
  // NOT silently reopen cold.
  await assert.rejects(c.navigate("https://example.com/again"), /revoked or is no longer available|session ended/);
  // State is reset, so a DELIBERATE subsequent navigate opens cold (entry is gone).
  await c.navigate("https://example.com/cold");
  assert.equal(opens[opens.length - 1], undefined, "after the loud error, a fresh navigate opens cold");
});

test("warm-open: a BOUND entry whose exit can't be re-pinned fails the navigate LOUD (fail-closed, no cold/wrong-exit)", async () => {
  // noSecrets → no proxy → a bound (residential-exit) entry cannot re-pin → buildWarmOverride throws →
  // the navigate rejects loudly rather than silently replaying the login from the wrong exit or going cold.
  const { gateway, opens } = makeRecordingGateway();
  const vault = makeVault("vault", "example.com", warmEntry("example.com", { stickyExitId: "abcd1234" }));
  const c = new GatewayDriveController(gateway, noSecrets(), "tok", {
    vault, consumerId: "vault", allowlist: allowAll, onDatacenterIp: true,
  });
  await assert.rejects(c.navigate("https://example.com/"), /cannot be re-pinned|wrong network posture/i);
  assert.equal(opens.length, 0, "fail-closed before any session opened (no cold fallback, no wrong-exit replay)");
});

test("warm-open: warm takes precedence over forceProxy (replays its captured posture, not a fresh exit)", async () => {
  // A direct-captured entry on a forceProxy host still replays DIRECT — warm posture is authoritative
  // (R3); it must not be overridden onto a fresh residential exit the login was never minted on.
  const { gateway, opens } = makeRecordingGateway();
  const vault = makeVault("vault", "example.com", warmEntry("example.com"));
  const c = new GatewayDriveController(gateway, proxySecrets(), "tok", {
    vault, consumerId: "vault", allowlist: allowAll, onDatacenterIp: true, stickySuffix: "_s-{id}",
  });
  const snap = await c.navigate("https://example.com/", { forceProxy: true });
  assert.equal(snap.status, 200);
  assert.ok(opens[0]?.restoreState, "warm-open won over forceProxy");
  assert.equal(opens[0].proxy, undefined, "direct-captured warm entry replays direct despite forceProxy");
});
