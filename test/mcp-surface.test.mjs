/**
 * U6 MCP surface tests — drive the server through a real MCP client over an in-memory
 * transport with an injected fake `retrieve`. Covers tools/list, a retrieve round-trip, the
 * blocked-page error, and the gateway-down clean error (no hang). No real browser.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createGatewayMcpServer } from "../dist/mcp/index.js";

const outcome = (over = {}) => ({
  markdown: "# Title\n\nbody",
  title: "Title",
  status: 200,
  blocked: false,
  degraded: false,
  proxyUsed: false,
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

test("blocked page surfaces a clean tool error (not empty content)", async () => {
  const client = await connect(async () => outcome({ blocked: true, markdown: "" }));
  const res = await client.callTool({ name: "retrieve", arguments: { url: "https://blocked/" } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Could not retrieve/i);
});

test("failed navigation (null status + thin content) surfaces a clean error, not the browser error page", async () => {
  // Off-allowlist / unreachable: goto threw -> status null, only the browser's thin error page.
  const client = await connect(async () => outcome({ status: null, markdown: "This site can't be reached", blocked: false }));
  const res = await client.callTool({ name: "retrieve", arguments: { url: "https://off-allowlist.example/" } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Could not retrieve/i);
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
