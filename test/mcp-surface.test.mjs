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
