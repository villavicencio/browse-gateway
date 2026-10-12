/**
 * VIL-292 — BGW_ESCALATE_HOSTS limits the AUTOMATIC escalate-on-block path to named hosts. On a
 * residential prod host direct-first already clears what the datacenter IP could not, so a paid
 * proxied session is reserved for the hosts that still need one. `BGW_ON_DATACENTER_IP=1` stays set
 * there because the vault's pinned/fresh-exit replay needs it, so the narrowing must leave force-proxy
 * and the vault untouched. Unset keeps the pre-VIL-292 behavior: every host may escalate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseEscalateHosts,
  describeEscalateHosts,
  hostMayEscalate,
  shouldEscalateToProxy,
  retrieve,
  EscalationError,
} from "../dist/verbs/index.js";
import { SecretStore } from "../dist/security/index.js";
import { GatewayDriveController } from "../dist/mcp/drive-controller.js";

const REAL = "real accessibility tree ".repeat(60);
const PROXY_SECRETS = () => ({ BGW_PROXY_URL: "http://proxy:8080", BGW_PROXY_PASSWORD: "pwd" });
const CF_SIGNAL = {
  title: "Just a moment...",
  text: "Enable JavaScript and cookies to continue",
  html: "<div class='cf-chl-opt' id='challenge-platform'></div>",
};
const ON = { onDatacenterIp: true, proxyAvailable: true };

// --- parsing -----------------------------------------------------------------------------------

test("parseEscalateHosts: unset or blank → undefined (every host, the old behavior)", () => {
  assert.equal(parseEscalateHosts(undefined), undefined);
  assert.equal(parseEscalateHosts(""), undefined);
  assert.equal(parseEscalateHosts(" , "), undefined);
});

test("parseEscalateHosts: `none` (any case) → [] (nothing escalates automatically)", () => {
  assert.deepEqual(parseEscalateHosts("none"), []);
  assert.deepEqual(parseEscalateHosts(" NONE "), []);
});

test("parseEscalateHosts: a host list is canonicalized like force-proxy", () => {
  assert.deepEqual(parseEscalateHosts("TotalWine.com, www.example.com."), ["totalwine.com", "www.example.com"]);
});

test("parseEscalateHosts: `none` mixed with hosts fails closed at boot", () => {
  assert.throws(() => parseEscalateHosts("none,totalwine.com"), /BGW_ESCALATE_HOSTS: "none" cannot be combined/);
});

test("describeEscalateHosts renders the boot-line value", () => {
  assert.equal(describeEscalateHosts(undefined), "all");
  assert.equal(describeEscalateHosts([]), "none");
  assert.equal(describeEscalateHosts(["totalwine.com", "a.example"]), "totalwine.com,a.example");
});

test("hostMayEscalate: undefined list → any host; [] → no host; suffix match, not substring", () => {
  assert.equal(hostMayEscalate("anything.example", undefined), true);
  assert.equal(hostMayEscalate("www.totalwine.com", []), false);
  assert.equal(hostMayEscalate("www.totalwine.com", ["totalwine.com"]), true);
  assert.equal(hostMayEscalate("nottotalwine.com", ["totalwine.com"]), false);
});

// --- the pure decision ---------------------------------------------------------------------------

test("shouldEscalateToProxy: no list → a CF challenge escalates exactly as before", () => {
  assert.equal(shouldEscalateToProxy(CF_SIGNAL, 403, ON, "www.indexxx.com"), true);
  assert.equal(shouldEscalateToProxy(CF_SIGNAL, 403, ON), true, "host is optional without a list");
});

test("shouldEscalateToProxy: with a list, only a listed host escalates", () => {
  const ctx = { ...ON, escalateHosts: ["totalwine.com"] };
  assert.equal(shouldEscalateToProxy(CF_SIGNAL, 403, ctx, "www.totalwine.com"), true);
  assert.equal(shouldEscalateToProxy(CF_SIGNAL, 403, ctx, "www.indexxx.com"), false);
  assert.equal(shouldEscalateToProxy(CF_SIGNAL, 403, ctx), false, "no host cannot be checked against a list");
  assert.equal(shouldEscalateToProxy(CF_SIGNAL, 403, { ...ON, escalateHosts: [] }, "www.totalwine.com"), false);
});

// --- retrieve ------------------------------------------------------------------------------------

function makeRenderGateway(results) {
  const calls = [];
  let i = 0;
  const gateway = {
    async withConsumerSession(_token, fn, override) {
      const result = results[Math.min(i, results.length - 1)];
      i += 1;
      calls.push({ override });
      return fn({ core: { async render() { return result; }, async setNavigationGuard() {}, async close() {} } }, { id: "a" });
    },
  };
  return { gateway, calls };
}
const cfRender = { url: "u", status: 403, ...CF_SIGNAL, clearanceWaitedMs: 0 };
const okRender = { url: "u", status: 200, title: "OK", text: REAL, html: `<main>${REAL}</main>`, clearanceWaitedMs: 0 };

test("retrieve: a CF block on an unlisted host does NOT open a proxied render", async () => {
  const { gateway, calls } = makeRenderGateway([cfRender, okRender]);
  const r = await retrieve(gateway, new SecretStore(PROXY_SECRETS), {
    token: "t",
    url: "https://www.indexxx.com/",
    escalation: { onDatacenterIp: true, escalateHosts: ["totalwine.com"] },
  });
  assert.equal(calls.length, 1, "the direct render only");
  assert.equal(calls[0].override, undefined);
  assert.equal(r.proxyUsed, false);
  assert.equal(r.reason, "cf-challenge");
});

test("retrieve: the same block on a listed host still escalates (the list narrows, it doesn't disable)", async () => {
  const { gateway, calls } = makeRenderGateway([cfRender, okRender]);
  const r = await retrieve(gateway, new SecretStore(PROXY_SECRETS), {
    token: "t",
    url: "https://www.totalwine.com/",
    escalation: { onDatacenterIp: true, escalateHosts: ["totalwine.com"] },
  });
  assert.equal(r.proxyUsed, true);
  assert.equal(calls.length, 2, "direct, then one proxied render that cleared");
  assert.ok(calls[1].override?.proxy);
});

test("retrieve: forceProxy ignores the list — `none` still lets an explicit force through", async () => {
  const { gateway, calls } = makeRenderGateway([okRender]);
  const r = await retrieve(gateway, new SecretStore(PROXY_SECRETS), {
    token: "t",
    url: "https://www.indexxx.com/",
    escalation: { onDatacenterIp: true, escalateHosts: [] },
    forceProxy: true,
  });
  assert.equal(r.proxyUsed, true);
  assert.ok(calls[0].override?.proxy, "the first render was proxied");
});

// --- drive ---------------------------------------------------------------------------------------

function makeDriveGateway(navs) {
  let ni = 0;
  let nextId = 1;
  const open = new Map();
  const opened = [];
  const gateway = {
    sessions: { get: (h) => open.get(h) },
    async openConsumerSession(_token, overrides) {
      const id = "h" + nextId++;
      open.set(id, {
        core: {
          async navigate(url) {
            const out = navs[Math.min(ni, navs.length - 1)];
            ni += 1;
            return { url, ...out };
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
const cfSnap = { title: "Just a moment...", tree: "Verifying you are human", status: 403, cfHint: true };
const okSnap = { title: "ok", tree: REAL, status: 200 };

test("drive: a CF block on an unlisted host fails without opening a proxied session, and says why", async () => {
  const { gateway, opened } = makeDriveGateway([cfSnap, okSnap]);
  const drive = new GatewayDriveController(gateway, new SecretStore(PROXY_SECRETS), "tok", {
    onDatacenterIp: true,
    stickySuffix: "_s-{id}",
    escalateHosts: ["totalwine.com"],
  });
  await assert.rejects(drive.navigate("https://www.indexxx.com/"), (err) => {
    assert.ok(err instanceof EscalationError);
    assert.equal(err.diagnostics.proxyApplied, false);
    assert.match(err.message, /automatic proxy escalation is not enabled for this host — BGW_ESCALATE_HOSTS/);
    return true;
  });
  assert.equal(opened.length, 1, "the direct session only");
  assert.equal(opened[0].overrides, undefined);
});

test("drive: the same block on a listed host still escalates", async () => {
  const { gateway, opened } = makeDriveGateway([cfSnap, okSnap]);
  const drive = new GatewayDriveController(gateway, new SecretStore(PROXY_SECRETS), "tok", {
    onDatacenterIp: true,
    stickySuffix: "_s-{id}",
    escalateHosts: ["totalwine.com"],
  });
  const snap = await drive.navigate("https://www.totalwine.com/");
  assert.equal(snap.status, 200);
  assert.equal(opened.length, 2, "direct, then one proxied session");
  assert.ok(opened[1].overrides?.proxy);
});

test("drive: a force-proxy host ignores the list — `none` doesn't block BGW_FORCE_PROXY_HOSTS", async () => {
  const { gateway, opened } = makeDriveGateway([okSnap]);
  const drive = new GatewayDriveController(gateway, new SecretStore(PROXY_SECRETS), "tok", {
    onDatacenterIp: true,
    stickySuffix: "_s-{id}",
    forceProxyHosts: ["totalwine.com"],
    escalateHosts: [],
  });
  await drive.navigate("https://www.totalwine.com/p/1");
  assert.equal(opened.length, 1);
  assert.ok(opened[0].overrides?.proxy, "proxied from the first request");
});

// --- review round 1 (MergeWren ae79f0b) ---------------------------------------------------------

test("IDN: a Unicode entry matches the punycode host new URL() hands the matcher", () => {
  const hosts = parseEscalateHosts("bücher.example");
  assert.deepEqual(hosts, ["xn--bcher-kva.example"], "stored in the encoding requests arrive in");
  assert.equal(hostMayEscalate(new URL("https://www.bücher.example/").hostname, hosts), true);
  assert.equal(hostMayEscalate("www.bücher.example", hosts), true, "a Unicode host is folded too");
});

test("drive: a non-escalatable failure on an unlisted host doesn't blame BGW_ESCALATE_HOSTS", async () => {
  const notFound = { title: "Not Found", tree: "404", status: 404 };
  const { gateway, opened } = makeDriveGateway([notFound]);
  const drive = new GatewayDriveController(gateway, new SecretStore(PROXY_SECRETS), "tok", {
    onDatacenterIp: true,
    stickySuffix: "_s-{id}",
    escalateHosts: ["totalwine.com"],
  });
  await assert.rejects(drive.navigate("https://www.indexxx.com/missing"), (err) => {
    assert.ok(err instanceof EscalationError);
    assert.doesNotMatch(err.message, /BGW_ESCALATE_HOSTS/, "a 404 would not have escalated on any host");
    return true;
  });
  assert.equal(opened.length, 1);
});

// --- review round 2 (MergeWren 401eed9) ---------------------------------------------------------

test("parseEscalateHosts: an entry with URL-authority delimiters fails closed instead of folding to another host", () => {
  for (const entry of ["trusted.example@other.example", "a.example/path", "a.example:8443", "https://a.example", "a.example?x", "a.example#f", "[::1]"]) {
    assert.throws(() => parseEscalateHosts(entry), /BGW_ESCALATE_HOSTS: ".*" is not a host suffix/, entry);
  }
  assert.deepEqual(parseEscalateHosts("a.example,bücher.example"), ["a.example", "xn--bcher-kva.example"], "bare hosts still parse");
});

test("parseEscalateHosts: an entry the ASCII fold would rewrite fails closed (percent, fullwidth, zero-width, wildcard, empty label)", () => {
  for (const entry of ["evil%2ecom", "a%40b.example", "good.example＠evil.example", "a．example", "a​b.example", "*.a.example", "a..b", ".a.example"]) {
    assert.throws(() => parseEscalateHosts(entry), /BGW_ESCALATE_HOSTS: ".*" is not a host suffix/, JSON.stringify(entry));
  }
  assert.deepEqual(parseEscalateHosts("a.example.,a_b.example,1.2.3.4"), ["a.example", "a_b.example", "1.2.3.4"], "valid forms still parse");
  assert.deepEqual(parseEscalateHosts("xn--bcher-kva.example"), ["xn--bcher-kva.example"], "an IDN already in punycode parses (MergeWren d39d9b5#1)");
});
