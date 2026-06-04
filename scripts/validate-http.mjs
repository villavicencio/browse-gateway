#!/usr/bin/env node
/**
 * Shared HTTP surface proof (plan U7a). Run IN-CONTAINER (headful Chrome under Xvfb). Stands up the
 * REAL gateway + policy + Streamable-HTTP handler on loopback and drives it through real MCP clients
 * with NO mocks, proving the multi-consumer stack the per-consumer stdio launcher can't:
 *   1. two distinct consumers each open a consumer-bound drive session over HTTP and navigate a real
 *      allowlisted page (ref-annotated tree) — auth + per-connection binding + real browser;
 *   2. a session is bound to its consumer: replaying consumer A's session id with consumer B's bearer
 *      is rejected 403 (cross-consumer isolation);
 *   3. the navigation guard blocks an off-allowlist navigate over HTTP (same policy as stdio/retrieve);
 *   4. the per-consumer cap holds ACROSS MCP sessions: a consumer's 2nd concurrent drive session is
 *      refused (perConsumerMax) while its 1st is held;
 *   5. disconnect-WITHOUT-DELETE: a crashed client's session is idle-reaped and its browser released
 *      (the leak the SSE-drop path would otherwise cause — C1);
 *   6. clean teardown leaves no browser sessions.
 *
 * This is the kill-gate that must PASS before Atlas is cut over from stdio to HTTP (P6).
 */
process.env.BGW_MAX_SESSIONS ??= "3"; // 2 consumers × perConsumerMax 1 + 1 retrieve headroom (P0)

import { createServer } from "node:http";
import { Gateway, loadConfig } from "../dist/gateway/index.js";
import { PolicyEngine, ConsumerRegistry } from "../dist/policy/index.js";
import { SecretStore, redactSecrets } from "../dist/security/index.js";
import { createHttpHandler, createGatewayMcpServer } from "../dist/mcp/index.js";
import { GatewayDriveController } from "../dist/mcp/drive-controller.js";
import { retrieve } from "../dist/verbs/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Placeholder consumer ids/tokens/allowlists — PUBLIC repo, no fleet detail (real values in CUTOVER.local.md).
const CONSUMERS = [
  { id: "consumer-a", token: "tok-a", allow: ["example.com", "*.example.com"] },
  { id: "consumer-b", token: "tok-b", allow: ["example.com", "*.example.com"] },
];
const PAGE = "https://example.com/";
const OFF_ALLOWLIST = "https://www.google.com/"; // deliberately NOT in any allowlist

const secrets = new SecretStore(() => ({}));
secrets.addRedactable(CONSUMERS.map((c) => c.token));
const policy = new PolicyEngine({ registry: new ConsumerRegistry(CONSUMERS) });
const gateway = Gateway.create(loadConfig(), undefined, policy);
gateway.sessions.startReaper(5 * 60_000, 60_000);
const onDatacenterIp = process.env.BGW_ON_DATACENTER_IP === "1";

let failures = 0;
let notes = 0;
const check = (label, ok) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};
const note = (label) => {
  console.log(`  ~~~~  ${label}`);
  notes++;
};

// Built after listen() so allowedHosts can pin the actual loopback host:port — DNS-rebind protection
// is ON for the gate, proving the legitimate Host passes and (via the unit tests) a foreign one fails.
let handler;
const makeHandler = (allowedHosts) =>
  createHttpHandler({
    authenticate: (token) => policy.authenticate(token),
    buildServer: (consumer) => {
      const drive = new GatewayDriveController(gateway, secrets, consumer.token, { onDatacenterIp });
      const server = createGatewayMcpServer({
        drive,
        retrieve: async ({ url }) => {
          try {
            return await retrieve(gateway, secrets, { token: consumer.token, url, escalation: { onDatacenterIp } });
          } catch (err) {
            throw new Error(redactSecrets(err instanceof Error ? err.message : String(err), secrets));
          }
        },
      });
      return { server, dispose: () => drive.close() };
    },
    allowedHosts,
    log: () => {},
  });

const httpServer = createServer((req, res) => {
  if (!handler) {
    res.writeHead(503);
    res.end();
    return;
  }
  handler.handle(req, res).catch(() => {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    }
  });
});

const connect = async (port, token) => {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "validate-http", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
};

console.log("=== browse-gateway :: shared HTTP surface proof (U7a) ===");

try {
  const port = await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve(httpServer.address().port)));
  handler = makeHandler([`127.0.0.1:${port}`, `localhost:${port}`]);

  // 1) two distinct consumers each drive a real page over HTTP.
  const a = await connect(port, "tok-a");
  const b = await connect(port, "tok-b");
  const navA = await a.client.callTool({ name: "browser_navigate", arguments: { url: PAGE } });
  const navB = await b.client.callTool({ name: "browser_navigate", arguments: { url: PAGE } });
  check("consumer A navigates a real page over HTTP (ref tree)", !navA.isError && /\[ref=/.test(navA.content[0].text));
  check("consumer B navigates a real page over HTTP (ref tree)", !navB.isError && /\[ref=/.test(navB.content[0].text));
  check("both consumers hold a live session concurrently", handler.sessionCount() === 2);

  // 2) cross-consumer isolation: A's session id + B's bearer -> 403.
  const sidA = a.transport.sessionId;
  const foreign = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-session-id": sidA,
      Authorization: "Bearer tok-b",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  check("a foreign token cannot drive another consumer's session (403)", foreign.status === 403);

  // 3) off-allowlist navigate is blocked over HTTP (same policy as stdio).
  const off = await a.client.callTool({ name: "browser_navigate", arguments: { url: OFF_ALLOWLIST } });
  check("an off-allowlist navigate is blocked over HTTP", off.isError === true);

  // 4) per-consumer cap holds across MCP sessions: A opens a 2nd MCP session and tries a 2nd drive.
  const a2 = await connect(port, "tok-a");
  const navA2 = await a2.client.callTool({ name: "browser_navigate", arguments: { url: PAGE } });
  check("a consumer's 2nd concurrent drive session is refused (per-consumer cap)", navA2.isError === true && /limit/i.test(navA2.content[0].text));
  await a2.client.close().catch(() => {});

  // 5) disconnect-without-DELETE: B "crashes" (no close); force the idle reaper -> session reaped + browser freed.
  const beforeReap = gateway.sessions.activeCount;
  const reaped = await handler.reapIdle(Date.now() + 10 * 60_000);
  check("a crashed client's session is idle-reaped (no DELETE)", reaped.length >= 1);
  check("reaping released the browser session(s)", gateway.sessions.activeCount < beforeReap);

  // 6) clean teardown.
  await a.client.close().catch(() => {});
  await handler.closeAll();
  check("clean teardown leaves no live MCP sessions", handler.sessionCount() === 0);
  check("clean teardown leaves no browser sessions", gateway.sessions.activeCount === 0);
} catch (err) {
  console.log(`  FAIL  threw: ${err instanceof Error ? err.message : String(err)}`);
  failures++;
} finally {
  await new Promise((r) => httpServer.close(r));
  httpServer.closeAllConnections?.();
  await gateway.shutdown();
}

const verdict = failures === 0 ? (notes ? "PASS (with notes) ⚠️" : "PASS ✅") : "FAIL ❌";
console.log(`\n=== HTTP GATE: ${verdict} (${failures} failure(s), ${notes} note(s)) ===`);
process.exit(failures === 0 ? 0 : 1);
