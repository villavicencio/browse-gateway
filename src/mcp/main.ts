/**
 * stdio MCP entry — the command the fleet launcher runs (mirrors the prior browser MCP launcher).
 * Wires a real gateway + policy + secrets behind the `retrieve` tool, scoped to one consumer
 * agent. stdout is the MCP protocol channel, so all logging goes to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Gateway, loadConfig } from "../gateway/index.js";
import { PolicyEngine, ConsumerRegistry, InMemoryAuditSink, RedactingAuditSink } from "../policy/index.js";
import { SecretStore, redactSecrets } from "../security/index.js";
import { retrieve } from "../verbs/index.js";
import { createGatewayMcpServer } from "./server.js";

const log = (msg: string): void => void process.stderr.write(`[browse-gateway-mcp] ${msg}\n`);

/** Cap on the in-memory audit trail for this long-lived process (most-recent-N ring buffer). */
const AUDIT_MAX_RECORDS = 10_000;

function loadConsumer(env: NodeJS.ProcessEnv = process.env) {
  const id = env.BGW_MCP_CONSUMER_ID ?? "consumer";
  const token = env.BGW_MCP_CONSUMER_TOKEN ?? "";
  const allow = (env.BGW_MCP_ALLOWLIST ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return { id, token, allow };
}

async function main(): Promise<void> {
  const consumer = loadConsumer();
  if (!consumer.token) throw new Error("BGW_MCP_CONSUMER_TOKEN is required");
  if (consumer.allow.length === 0) throw new Error("BGW_MCP_ALLOWLIST is required (no hosts allowed)");

  const secrets = new SecretStore();
  const policy = new PolicyEngine({
    registry: new ConsumerRegistry([{ id: consumer.id, token: consumer.token, allow: consumer.allow }]),
    // Durable-trail default for the live path: bounded in-memory store wrapped in the
    // secret-scrubbing sink (R9) so BYO proxy/CAPTCHA material can never reach the audit log.
    audit: new RedactingAuditSink(new InMemoryAuditSink(AUDIT_MAX_RECORDS), secrets),
  });
  const gateway = Gateway.create(loadConfig(), undefined, policy);
  const onDatacenterIp = process.env.BGW_ON_DATACENTER_IP === "1";

  const server = createGatewayMcpServer({
    version: "0.1.0",
    retrieve: async ({ url }) => {
      try {
        return await retrieve(gateway, secrets, { token: consumer.token, url, escalation: { onDatacenterIp } });
      } catch (err) {
        // Never let a proxy/browser error message carry BYO secret material to the consumer (R9).
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(redactSecrets(message, secrets));
      }
    },
  });

  const shutdown = async (): Promise<void> => {
    await gateway.shutdown().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.connect(new StdioServerTransport());
  log(`connected over stdio — consumer=${consumer.id} allow=[${consumer.allow.join(", ")}] datacenter=${onDatacenterIp}`);
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
