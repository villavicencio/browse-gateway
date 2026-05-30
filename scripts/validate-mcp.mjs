#!/usr/bin/env node
/**
 * U6 MCP end-to-end proof (F1, local). Spawns the real stdio MCP launcher
 * (`dist/mcp/main.js`) as a subprocess and drives it with an MCP client over stdio —
 * the same protocol a consumer agent uses. Confirms, through the full stack with a real
 * headful browser:
 *   1. the `retrieve` tool is exposed
 *   2. an allowlisted hard (Cloudflare) target round-trips to readable markdown
 *   3. an off-allowlist host does not leak real content (allowlist holds end-to-end)
 *   4. a non-http(s) scheme (file://) is refused (the scheme gate)
 * Run in-container (headful under Xvfb).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TARGET = process.env.BGW_MCP_SMOKE_URL ?? "https://www.udemy.com/";
const CALL_TIMEOUT_MS = 120_000;

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
};
const textOf = (res) => res.content?.[0]?.text ?? "";

console.log("=== browse-gateway :: MCP end-to-end proof (U6 / F1-local) ===");
console.log(`[mcp] launcher=dist/mcp/main.js consumer=smoke allow=[udemy.com, *.udemy.com] target=${TARGET}`);

// The launcher is the server; the client spawns it and talks over its stdio. Pass the full
// env so DISPLAY (Xvfb) + BGW_CHANNEL/NO_SANDBOX propagate to the spawned browser.
const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/mcp/main.js"],
  env: {
    ...process.env,
    BGW_MCP_CONSUMER_ID: "smoke",
    BGW_MCP_CONSUMER_TOKEN: "smoke-token",
    BGW_MCP_ALLOWLIST: "udemy.com,*.udemy.com",
  },
  stderr: "inherit",
});
const client = new Client({ name: "mcp-smoke", version: "1.0.0" });

try {
  await client.connect(transport);

  const { tools } = await client.listTools();
  check("retrieve tool exposed", tools.length === 1 && tools[0]?.name === "retrieve", tools.map((t) => t.name).join(","));

  // 1) allowlisted hard (CF) target -> readable markdown
  const ok = await client.callTool({ name: "retrieve", arguments: { url: TARGET } }, undefined, { timeout: CALL_TIMEOUT_MS });
  const okText = textOf(ok);
  check("allowlisted CF target round-trips to markdown", ok.isError !== true && okText.length > 200, `isError=${ok.isError ?? false} len=${okText.length}`);
  if (okText) console.log(`      head: ${JSON.stringify(okText.slice(0, 80))}`);

  // 2) off-allowlist host -> refused with a clean error (navigation blocked, no content leaked)
  const off = await client.callTool({ name: "retrieve", arguments: { url: "https://www.iana.org/" } }, undefined, { timeout: CALL_TIMEOUT_MS });
  const offText = textOf(off);
  check(
    "off-allowlist host refused with a clean error (no real content)",
    off.isError === true && !/internet assigned numbers/i.test(offText),
    `isError=${off.isError ?? false} len=${offText.length}`,
  );

  // 3) non-http scheme -> refused by the scheme gate
  const scheme = await client.callTool({ name: "retrieve", arguments: { url: "file:///etc/passwd" } }, undefined, { timeout: CALL_TIMEOUT_MS });
  const schemeText = textOf(scheme);
  check("file:// scheme refused", scheme.isError === true && /scheme/i.test(schemeText), JSON.stringify(schemeText).slice(0, 90));
} catch (err) {
  console.error("  harness error:", err);
  failures++;
} finally {
  await client.close().catch(() => {});
}

console.log(`\n=== MCP GATE: ${failures === 0 ? "PASS ✅" : "FAIL ❌"} (${failures} failure(s)) ===`);
process.exit(failures === 0 ? 0 : 1);
