/**
 * U6 MCP surface tests — drive the server through a real MCP client over an in-memory
 * transport with an injected fake `retrieve`. Covers tools/list, a retrieve round-trip, the
 * blocked-page error, and the gateway-down clean error (no hang). No real browser.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createGatewayMcpServer, ERROR_KIND_META_KEY } from "../dist/mcp/index.js";
import { EscalationError } from "../dist/verbs/index.js";
import { attachFailure } from "../dist/observability/index.js";

const outcome = (over = {}) => ({
  markdown: "# Title\n\nbody",
  title: "Title",
  status: 200,
  blocked: false,
  reason: null,
  degraded: false,
  proxyUsed: false,
  captchaSolved: false,
  ...over,
});

async function connect(retrieve) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createGatewayMcpServer({ retrieve });
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

test("tools/list exposes exactly the retrieve tool", async () => {
  const client = await connect(async () => outcome());
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ["retrieve"]);
  assert.match(tools[0].description, /markdown/i);
});

test("retrieve round-trips markdown content", async () => {
  const client = await connect(async ({ url }) => outcome({ markdown: `content for ${url}` }));
  const res = await client.callTool({ name: "retrieve", arguments: { url: "https://example.com/" } });
  assert.equal(res.isError ?? false, false);
  assert.equal(res.content[0].type, "text");
  assert.equal(res.content[0].text, "content for https://example.com/");
});

test("blocked page surfaces a clean tool error with reason + escalation diagnostics", async () => {
  const client = await connect(async () =>
    outcome({ blocked: true, markdown: "", reason: "hard-block", status: 403, proxyUsed: true }));
  const res = await client.callTool({ name: "retrieve", arguments: { url: "https://blocked/" } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Could not retrieve/i);
  assert.match(res.content[0].text, /reason=hard-block/);
  assert.match(res.content[0].text, /status=403/);
  assert.match(res.content[0].text, /proxyUsed=true/);
});

test("a CAPTCHA block names the reason and hints the missing solver", async () => {
  const client = await connect(async () =>
    outcome({ blocked: true, markdown: "", reason: "captcha", status: 403 }));
  const res = await client.callTool({ name: "retrieve", arguments: { url: "https://captcha/" } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /reason=captcha/);
  assert.match(res.content[0].text, /no solver configured/i);
});

test("failed navigation (null status + thin content) surfaces a clean error, not the browser error page", async () => {
  // Off-allowlist / unreachable: goto threw -> status null, only the browser's thin error page.
  const client = await connect(async () => outcome({ status: null, markdown: "This site can't be reached", blocked: false }));
  const res = await client.callTool({ name: "retrieve", arguments: { url: "https://off-allowlist.example/" } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Could not retrieve/i);
});

test("empty extraction with a typed failure class names reason=<failureClass> (#41 formalizes empty-content)", async () => {
  // The real retrieve path ALWAYS attaches a #39 envelope on a failure and #41 always sets a failureClass,
  // so a non-blocked empty-markdown 200 surfaces the typed class (here empty-shell) via
  // `why = result.reason ?? result.diagnostics?.failureClass ?? "empty-content"` — not the opaque literal.
  const client = await connect(async () =>
    outcome({ status: 200, markdown: "", blocked: false, reason: null, diagnostics: { failureClass: "empty-shell", finalUrl: "https://empty.example/", status: 200 } }));
  const res = await client.callTool({ name: "retrieve", arguments: { url: "https://empty.example/" } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /reason=empty-shell/);
});

test("empty extraction with NO envelope falls back to reason=empty-content (defensive last resort)", async () => {
  // The bare literal remains only for an outcome that carries no #39 envelope at all (production-unreachable
  // on the real retrieve path, where render() always builds one) — the last leg of the fallback chain.
  const client = await connect(async () => outcome({ status: 200, markdown: "", blocked: false, reason: null }));
  const res = await client.callTool({ name: "retrieve", arguments: { url: "https://empty.example/" } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /reason=empty-content/);
});

test("short-but-valid page (real status, thin content) is returned, not errored", async () => {
  const client = await connect(async () => outcome({ status: 200, markdown: "A short but legitimate page.", blocked: false }));
  const res = await client.callTool({ name: "retrieve", arguments: { url: "https://small.example/" } });
  assert.equal(res.isError ?? false, false);
  assert.equal(res.content[0].text, "A short but legitimate page.");
});

test("gateway-down surfaces a clean MCP error, not a hang", async () => {
  const client = await connect(async () => {
    throw new Error("gateway unreachable");
  });
  const res = await client.callTool({ name: "retrieve", arguments: { url: "https://x/" } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /browse-gateway error: gateway unreachable/);
});

test("invalid arguments (missing url) do not silently succeed", async () => {
  const client = await connect(async () => outcome());
  let errored = false;
  try {
    const res = await client.callTool({ name: "retrieve", arguments: {} });
    errored = res.isError === true; // SDK may surface validation as an error result rather than a throw
  } catch {
    errored = true;
  }
  assert.equal(errored, true, "missing required url must be an error, not a success");
});

// --- U3: the browser_* drive tool surface --------------------------------------------------

function makeFakeDrive() {
  const calls = [];
  const snap = (over = {}) => ({ url: "https://example.com/", title: "Example", tree: '- button "Go" [ref=e4]', ...over });
  const drive = {
    async open() { calls.push(["open"]); },
    async navigate(url) { calls.push(["navigate", url]); if (url === "https://boom/") throw new Error("nav boom"); return snap({ url }); },
    async snapshot() { calls.push(["snapshot"]); return snap(); },
    async click(target) { calls.push(["click", target]); return snap(); },
    async type(target, text, submit) { calls.push(["type", target, text, submit]); return snap(); },
    async selectOption(target, values) { calls.push(["selectOption", target, values]); return snap(); },
    async pressKey(key) { calls.push(["pressKey", key]); return snap(); },
    async waitFor(cond) { calls.push(["waitFor", cond]); return snap(); },
    async screenshot() { calls.push(["screenshot"]); return "QUJD"; },
    async close() { calls.push(["close"]); },
  };
  return { drive, calls };
}

async function connectWithDrive(drive, retrieve = async () => outcome()) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createGatewayMcpServer({ retrieve, drive });
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

const DRIVE_TOOLS = [
  "browser_open", "browser_navigate", "browser_snapshot", "browser_click", "browser_type",
  "browser_select_option", "browser_press_key", "browser_wait_for", "browser_take_screenshot", "browser_close",
];

test("tools/list includes the browser_* drive tools when a controller is injected", async () => {
  const { drive } = makeFakeDrive();
  const client = await connectWithDrive(drive);
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("retrieve"));
  for (const n of DRIVE_TOOLS) assert.ok(names.includes(n), `missing ${n}`);
});

test("drive tools are absent on a retrieve-only server (no controller injected)", async () => {
  const client = await connect(async () => outcome());
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.deepEqual(names, ["retrieve"]);
  assert.ok(!names.some((n) => n.startsWith("browser_")));
});

test("browser_navigate returns a formatted snapshot; browser_click maps to the controller", async () => {
  const { drive, calls } = makeFakeDrive();
  const client = await connectWithDrive(drive);
  const nav = await client.callTool({ name: "browser_navigate", arguments: { url: "https://example.com/" } });
  assert.equal(nav.isError ?? false, false);
  assert.match(nav.content[0].text, /url: https:\/\/example\.com\//);
  assert.match(nav.content[0].text, /\[ref=e4\]/);
  await client.callTool({ name: "browser_click", arguments: { target: "e4", element: "Go button" } });
  const clickCall = calls.find((c) => c[0] === "click");
  assert.equal(clickCall[1].target, "e4");
  assert.equal(clickCall[1].element, "Go button");
});

test("browser_type passes text + submit through to the controller", async () => {
  const { drive, calls } = makeFakeDrive();
  const client = await connectWithDrive(drive);
  await client.callTool({ name: "browser_type", arguments: { target: "e5", text: "hi", submit: true } });
  const typeCall = calls.find((c) => c[0] === "type");
  assert.equal(typeCall[1].target, "e5");
  assert.equal(typeCall[2], "hi");
  assert.equal(typeCall[3], true);
});

test("browser_take_screenshot returns an image content block", async () => {
  const { drive } = makeFakeDrive();
  const client = await connectWithDrive(drive);
  const res = await client.callTool({ name: "browser_take_screenshot", arguments: {} });
  assert.equal(res.content[0].type, "image");
  assert.equal(res.content[0].mimeType, "image/png");
  assert.equal(res.content[0].data, "QUJD");
});

test("a drive verb error surfaces a clean MCP error, not a hang", async () => {
  const { drive } = makeFakeDrive();
  const client = await connectWithDrive(drive);
  const res = await client.callTool({ name: "browser_navigate", arguments: { url: "https://boom/" } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /browse-gateway error: nav boom/);
});

test("browser_close invokes the controller's close", async () => {
  const { drive, calls } = makeFakeDrive();
  const client = await connectWithDrive(drive);
  await client.callTool({ name: "browser_close", arguments: {} });
  assert.ok(calls.some((c) => c[0] === "close"));
});

// --- #47: client-breaker affordances (error-kind _meta + idempotent tag) ---------------------

const kindOf = (res) => res._meta?.[ERROR_KIND_META_KEY];
// A genuine drive block/nav-failure carries a failureClass on its envelope (the drive layer sets it only
// when navFailed); a healthy-page action error or a config failure carries none. The classifier keys off
// this, NOT the wrapper (codex r1).
const blockEnvelope = { finalUrl: "https://blocked/", status: 403, failureClass: "hard-block" };
const healthyPageEnvelope = { finalUrl: "https://ok/", status: 200 }; // enveloped but NO failureClass

test("#47: a retrieve in-band failure (block/empty/unreachable) tags error-kind=in-band", async () => {
  const client = await connect(async () =>
    outcome({ blocked: true, markdown: "", reason: "hard-block", status: 403, proxyUsed: true }));
  const res = await client.callTool({ name: "retrieve", arguments: { url: "https://blocked/" } });
  assert.equal(res.isError, true);
  assert.equal(kindOf(res), "in-band");
});

test("#47: a retrieve gateway-down throw tags error-kind=internal (alive, not a transport failure)", async () => {
  const client = await connect(async () => {
    throw new Error("gateway unreachable");
  });
  const res = await client.callTool({ name: "retrieve", arguments: { url: "https://x/" } });
  assert.equal(res.isError, true);
  assert.equal(kindOf(res), "internal");
});

test("#47: a successful retrieve carries no error-kind (_meta clean on success)", async () => {
  const client = await connect(async () => outcome({ markdown: "content" }));
  const res = await client.callTool({ name: "retrieve", arguments: { url: "https://ok/" } });
  assert.equal(res.isError ?? false, false);
  assert.equal(kindOf(res), undefined);
});

test("#47: a drive block (envelope carries a failureClass) tags error-kind=in-band", async () => {
  const { drive } = makeFakeDrive();
  drive.navigate = async () => {
    throw new EscalationError("navigation failed via proxy", { attempts: 3, proxyUsed: true }, blockEnvelope);
  };
  const client = await connectWithDrive(drive);
  const res = await client.callTool({ name: "browser_navigate", arguments: { url: "https://blocked/" } });
  assert.equal(res.isError, true);
  assert.equal(kindOf(res), "in-band");
  // The structured escalation diagnostics still ride the human-readable text (unchanged by #47).
  assert.match(res.content[0].text, /diagnostics/);
});

test("#47: a config EscalationError with NO block envelope (e.g. force-proxy, no proxy) tags internal", async () => {
  // codex r1 regression: the presence of an EscalationError wrapper must NOT imply a page block — a
  // configuration failure is thrown with no failure envelope (no failureClass) and is genuinely internal.
  const { drive } = makeFakeDrive();
  drive.navigate = async () => {
    throw new EscalationError("force-proxy requested but no residential proxy is available", { attempts: 0, proxyUsed: false });
  };
  const client = await connectWithDrive(drive);
  const res = await client.callTool({ name: "browser_navigate", arguments: { url: "https://forced/" } });
  assert.equal(res.isError, true);
  assert.equal(kindOf(res), "internal");
});

test("#47: a healthy-page action error that got a best-effort envelope (no failureClass) tags internal", async () => {
  // codex r1 regression: #actAndSnap attaches a best-effort envelope to a locator timeout on a HEALTHY
  // page — that envelope has no failureClass, so it must classify internal, not in-band.
  const { drive } = makeFakeDrive();
  drive.click = async () => {
    throw attachFailure(new Error("locator timed out"), healthyPageEnvelope);
  };
  const client = await connectWithDrive(drive);
  const res = await client.callTool({ name: "browser_click", arguments: { target: "e4" } });
  assert.equal(res.isError, true);
  assert.equal(kindOf(res), "internal");
});

test("#47: a plain drive error with no envelope at all tags error-kind=internal", async () => {
  const { drive } = makeFakeDrive();
  const client = await connectWithDrive(drive);
  const res = await client.callTool({ name: "browser_navigate", arguments: { url: "https://boom/" } });
  assert.equal(res.isError, true);
  assert.equal(kindOf(res), "internal");
});

test("#47: browser_close is advertised idempotent (annotations.idempotentHint)", async () => {
  const { drive } = makeFakeDrive();
  const client = await connectWithDrive(drive);
  const close = (await client.listTools()).tools.find((t) => t.name === "browser_close");
  assert.ok(close, "browser_close must be listed");
  assert.equal(close.annotations?.idempotentHint, true);
  assert.match(close.description, /idempotent/i);
});

// --- #48 silent home-fallback: surface at the client boundary ------------------------------------

test("#48: a SUCCESS-shaped home-fallback surfaces homeFallback via structuredContent, markdown stays PURE", async () => {
  // A fat-homepage fallback carries no failure envelope, so structuredContent is the SOLE carrier of the
  // flag to an MCP consumer. The returned text must be byte-for-byte the page markdown (content purity).
  const client = await connect(async () => outcome({ markdown: "# Home\n\nwelcome", homeFallback: true }));
  const res = await client.callTool({ name: "retrieve", arguments: { url: "https://store/search?q=milk" } });
  assert.equal(res.isError ?? false, false, "a fat-homepage fallback is still a SUCCESS");
  assert.equal(res.content[0].text, "# Home\n\nwelcome", "markdown is pure — no gateway chrome injected");
  assert.equal(res.structuredContent?.homeFallback, true, "the flag rides the structuredContent channel");
});

test("#48: a clean success carries NO structuredContent key (omit-when-false)", async () => {
  const client = await connect(async () => outcome({ markdown: "# Real\n\npage" }));
  const res = await client.callTool({ name: "retrieve", arguments: { url: "https://store/deep" } });
  assert.equal(res.isError ?? false, false);
  assert.equal(res.structuredContent, undefined, "no home-fallback → no structuredContent");
});

test("#48: a FAILURE-shaped home-fallback renders homeFallback in the failure envelope text", async () => {
  const client = await connect(async () =>
    outcome({ blocked: false, markdown: "", status: 200, homeFallback: true, diagnostics: { finalUrl: "https://store/", failureClass: "empty-shell", homeFallback: true } }));
  const res = await client.callTool({ name: "retrieve", arguments: { url: "https://store/search?q=milk" } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /homeFallback":true/, "the envelope carries the flag alongside the class");
  assert.match(res.content[0].text, /empty-shell/, "the per-signal class rides alongside, not replaced");
});

test("#48: drive browser_navigate renders a homeFallback header line when annotated", async () => {
  const calls = [];
  const snap = (over = {}) => ({ url: "https://store/", title: "Home", tree: '- link "x" [ref=e1]', ...over });
  const drive = {
    async open() {}, async close() {},
    async navigate(url) { calls.push(url); return snap({ homeFallback: true }); },
    async snapshot() { return snap(); }, async click() { return snap(); }, async type() { return snap(); },
    async selectOption() { return snap(); }, async pressKey() { return snap(); }, async waitFor() { return snap(); },
    async screenshot() { return "QUJD"; },
  };
  const client = await connectWithDrive(drive);
  const nav = await client.callTool({ name: "browser_navigate", arguments: { url: "https://store/search?q=milk" } });
  assert.equal(nav.isError ?? false, false, "a home page is a returnable snapshot, not a drive error");
  assert.match(nav.content[0].text, /homeFallback: true/, "the header surfaces the annotation to the in-loop agent");
});

test("#48: drive browser_navigate has NO homeFallback header on a normal landing", async () => {
  const { drive } = makeFakeDrive();
  const client = await connectWithDrive(drive);
  const nav = await client.callTool({ name: "browser_navigate", arguments: { url: "https://example.com/" } });
  assert.doesNotMatch(nav.content[0].text, /homeFallback/, "omitted when not detected");
});
