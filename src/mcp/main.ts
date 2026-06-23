/**
 * stdio MCP entry — the command the fleet launcher runs (mirrors the prior browser MCP launcher).
 * Wires a real gateway + policy + secrets behind the `retrieve` tool, scoped to one consumer
 * agent. stdout is the MCP protocol channel, so all logging goes to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Gateway, loadConfig } from "../gateway/index.js";
import { PolicyEngine, ConsumerRegistry, InMemoryAuditSink, RedactingAuditSink, OriginationBoundary } from "../policy/index.js";
import { SecretStore, redactSecrets } from "../security/index.js";
import { retrieve, stickySuffixBootError, parseForceProxyHosts, hostForcesProxy, httpCaptchaSolverFromSecrets, DEFAULT_CAPTCHA_BUDGET } from "../verbs/index.js";
import { createGatewayMcpServer } from "./server.js";
import { GatewayDriveController } from "./drive-controller.js";

const log = (msg: string): void => void process.stderr.write(`[browse-gateway-mcp] ${msg}\n`);

/** Cap on the in-memory audit trail for this long-lived process (most-recent-N ring buffer). */
const AUDIT_MAX_RECORDS = 10_000;
/** Idle drive sessions are reaped after this long; the reaper scans on this interval. (U7-tunable.) */
const DRIVE_IDLE_TTL_MS = 5 * 60_000;
const DRIVE_REAPER_INTERVAL_MS = 60_000;

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
    // Origination boundary (R4): public deny set + any BGW_ORIGINATION_DENY_HOSTS/_PATHS extensions.
    originationBoundary: OriginationBoundary.fromEnv(process.env),
  });
  const config = loadConfig();
  // Wire the interactive-CAPTCHA solver onto the drive path when BYO config is present (key in the
  // SecretStore, endpoint in BGW_CAPTCHA_API_URL). Absent = a detected CAPTCHA is left to fail. The
  // solver is shared across the consumer's drive sessions; render() (retrieve) never invokes it.
  config.core.solver = httpCaptchaSolverFromSecrets(secrets, process.env.BGW_CAPTCHA_API_URL, {
    budget: DEFAULT_CAPTCHA_BUDGET,
  });
  const gateway = Gateway.create(config, undefined, policy);
  const onDatacenterIp = process.env.BGW_ON_DATACENTER_IP === "1";
  // Sticky-session suffix template for proxied escalation (parity with http-main; see there).
  const stickySuffix = process.env.BGW_PROXY_STICKY_SUFFIX || undefined;
  const forceProxyHosts = parseForceProxyHosts(process.env.BGW_FORCE_PROXY_HOSTS);
  const verifyEgress = process.env.BGW_DIAG_VERIFY_EGRESS === "1";
  const stickyErr = stickySuffixBootError(stickySuffix);
  if (stickyErr) throw new Error(stickyErr); // fail closed: a no-{id} suffix silently kills rotation
  // Reap idle held drive sessions so a forgotten session never pins a browser indefinitely.
  gateway.sessions.startReaper(DRIVE_IDLE_TTL_MS, DRIVE_REAPER_INTERVAL_MS);
  // The interactive `drive` surface: a persistent, consumer-bound session driven via browser_* tools.
  // Proxied (with healthy-exit retry) when a residential proxy is configured and we're on a DC IP.
  const drive = new GatewayDriveController(gateway, secrets, consumer.token, { onDatacenterIp, stickySuffix, forceProxyHosts, verifyEgress });

  const server = createGatewayMcpServer({
    version: "0.1.0",
    drive,
    retrieve: async ({ url, forceProxy }) => {
      try {
        const forced = (forceProxy ?? false) || hostForcesProxy(new URL(url).hostname, forceProxyHosts);
        return await retrieve(gateway, secrets, { token: consumer.token, url, escalation: { onDatacenterIp }, stickySuffix, forceProxy: forced });
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
  log(`connected over stdio — consumer=${consumer.id} allow=[${consumer.allow.join(", ")}] datacenter=${onDatacenterIp} sticky=${stickySuffix !== undefined}`);
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
