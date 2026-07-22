/**
 * stdio MCP entry — the command the fleet launcher runs (mirrors the prior browser MCP launcher).
 * Wires a real gateway + policy + secrets behind the `retrieve` tool, scoped to one consumer
 * agent. stdout is the MCP protocol channel, so all logging goes to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Gateway, loadConfig } from "../gateway/index.js";
import { PolicyEngine, ConsumerRegistry, InMemoryAuditSink, RedactingAuditSink, OriginationBoundary, Allowlist } from "../policy/index.js";
import { SecretStore, redactSecrets, openVault, canonicalizeHost } from "../security/index.js";
import { retrieve, stickySuffixBootError, stickySuffixRedactables, parseForceProxyHosts, parseWarmupPaths, hostForcesProxy, httpCaptchaSolverFromSecrets, DEFAULT_CAPTCHA_BUDGET } from "../verbs/index.js";
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
  // The bearer token is a credential — register it in the redaction set (guarded, so a too-short/marker
  // token fails closed) so it can never surface in an audit URL / error (R9, audit #3). runtime.ts folds
  // manifest tokens the same way; this stdio launcher must not diverge.
  secrets.addRedactableCredential([consumer.token]);
  // Credential/session-state vault (B1) for U9 warm-open: off unless BGW_VAULT_DIR is set. Mirror the
  // http-main/runtime construction so this stdio rollback launcher doesn't silently diverge (cold-only
  // while prod is warm). Constructing it here runs the fail-closed boot guard (entries on disk but no
  // master key → refuse to boot) and folds the KEK into the redaction set.
  const vault = openVault({ env: process.env, canonicalizeHost, redact: (vals) => secrets.addRedactable(vals) });
  if (vault) log("vault: ready (encrypted credential store enabled)");
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
    // #43: env-overridable + CLAMPED to the global call budget so a stalled solve can't run past it (codex r3).
    timeoutMs: Math.min(config.timeouts.captchaSolveTimeoutMs, config.timeouts.callBudgetMs),
  });
  // R9: the browser core's own stderr diagnostics (errCode) scrub the known-secret set via this store —
  // not just URL-strip — so a bare proxy password can't surface in a core diagnostic line (audit #3).
  config.core.secrets = secrets;
  const gateway = Gateway.create(config, undefined, policy);
  const onDatacenterIp = process.env.BGW_ON_DATACENTER_IP === "1";
  // Sticky-session suffix template for proxied escalation (parity with http-main; see there).
  const stickySuffix = process.env.BGW_PROXY_STICKY_SUFFIX || undefined;
  const forceProxyHosts = parseForceProxyHosts(process.env.BGW_FORCE_PROXY_HOSTS);
  // Parsed standalone here (the stdio launcher does not use buildGatewayRuntime), mirroring forceProxyHosts.
  const freshExitHosts = parseForceProxyHosts(process.env.BGW_WARM_FRESH_EXIT_HOSTS);
  // Warm-up navigation (PX deep-URL-first fix): mirror runtime.ts so the stdio rollback launcher doesn't
  // diverge (cold-deep-first while prod warms up). parseWarmupPaths fails closed on a non-relative path.
  const warmupHosts = parseForceProxyHosts(process.env.BGW_WARMUP_HOSTS);
  const warmupPaths = parseWarmupPaths(process.env.BGW_WARMUP_PATHS);
  const verifyEgress = process.env.BGW_DIAG_VERIFY_EGRESS === "1";
  const stickyErr = stickySuffixBootError(stickySuffix);
  if (stickyErr) throw new Error(stickyErr); // fail closed: a no-{id} suffix silently kills rotation
  // Fold the suffix's provider-param fragments into the redaction set (parity with runtime.ts; R9) so a
  // driver error echoing a minted sticky password can't leak the exit geo/session/lifetime structure.
  secrets.addRedactable(stickySuffixRedactables(stickySuffix));
  // Reap idle held drive sessions so a forgotten session never pins a browser indefinitely.
  gateway.sessions.startReaper(DRIVE_IDLE_TTL_MS, DRIVE_REAPER_INTERVAL_MS);
  // The interactive `drive` surface: a persistent, consumer-bound session driven via browser_* tools.
  // Proxied (with healthy-exit retry) when a residential proxy is configured and we're on a DC IP.
  const drive = new GatewayDriveController(gateway, secrets, consumer.token, {
    onDatacenterIp,
    stickySuffix,
    forceProxyHosts,
    freshExitHosts,
    warmupHosts,
    warmupPaths,
    log,
    verifyEgress,
    timeouts: config.timeouts, // #45: the drive escalation loop now consumes the #43 per-call budget
    // U9 warm-open: a navigate to an approved host with a stored login opens a logged-in session
    // (vault dormant → null → cold-only). The allowlist here is the same scope the gateway guard clamps to.
    vault,
    consumerId: consumer.id,
    allowlist: new Allowlist(consumer.allow),
  });

  const server = createGatewayMcpServer({
    version: "0.1.0",
    drive,
    retrieve: async ({ url, forceProxy }) => {
      try {
        const forced = (forceProxy ?? false) || hostForcesProxy(new URL(url).hostname, forceProxyHosts);
        return await retrieve(gateway, secrets, { token: consumer.token, url, escalation: { onDatacenterIp }, stickySuffix, forceProxy: forced, timeouts: config.timeouts });
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
