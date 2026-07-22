/**
 * HTTP MCP entry (U7a) — the shared service the fleet launcher runs in place of the per-consumer
 * stdio launcher (`main.ts`, kept for one release as the rollback). Stands up one gateway + policy
 * with ALL consumers loaded from the manifest, and serves them over Streamable HTTP. stdout is not
 * the protocol channel here (HTTP is), but all logging still goes to stderr for parity.
 *
 * Reachability is Tailnet-only by deployment: the listener binds `BGW_HTTP_BIND` (default loopback,
 * fail-closed) and is reached over the Tailnet — NOT published to the public internet. CDP stays
 * over a pipe (R13/R17); this port is the MCP surface, not CDP.
 */
import { createServer } from "node:http";
import type { Consumer } from "../policy/index.js";
import { redactSecrets } from "../security/index.js";
import { retrieve, hostForcesProxy } from "../verbs/index.js";
import { buildGatewayRuntime } from "./runtime.js";
import { createGatewayMcpServer } from "./server.js";
import { GatewayDriveController } from "./drive-controller.js";
import { createHttpHandler, dnsRebindBootError } from "./http-server.js";
import type { ConsumerServer } from "./http-server.js";

const log = (msg: string): void => void process.stderr.write(`[browse-gateway-http] ${msg}\n`);

// The Obscura wordmark, inlined: the gateway must not depend on the CLI subtree (layer
// direction), and one banner string doesn't justify a shared module.
const OBSCURA_BOOT_BANNER = "(o,o) OBSCURA — see without being seen";

const DRIVE_IDLE_TTL_MS = 5 * 60_000; // browser-session idle reap (frees Chrome)
const DRIVE_REAPER_INTERVAL_MS = 60_000;
const MCP_SESSION_REAPER_INTERVAL_MS = 60_000;
const SHUTDOWN_DRAIN_MS = 5_000; // bounded wait for in-flight tool calls before force-closing
const DEFAULT_PORT = 8080;
const DEFAULT_BIND = "127.0.0.1"; // fail-closed: deployment sets the Tailnet address explicitly

function splitCsv(value: string | undefined): string[] {
  return (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

async function main(): Promise<void> {
  log(OBSCURA_BOOT_BANNER); // the brand on the experiential surface only — env/ports/tool names unchanged
  // Build the shared gateway runtime (config, secrets, vault, consumers, policy, gateway, escalation
  // posture) with every fail-closed boot guard. Identical construction is used by the on-host
  // `obscura vault login` capture (cli/vault-host.ts) so the two never drift.
  const { gateway, secrets, policy, specs, config, vault, onDatacenterIp, stickySuffix, forceProxyHosts, freshExitHosts, warmupHosts, warmupPaths, verifyEgress } =
    buildGatewayRuntime(process.env, { log });
  gateway.sessions.startReaper(DRIVE_IDLE_TTL_MS, DRIVE_REAPER_INTERVAL_MS);

  // Fail-closed (R13/R17 posture): the shared HTTP surface refuses to boot without Host-based
  // DNS-rebinding protection. The listener is reachable over the Tailnet and MCP clients send no
  // Origin, so Host validation is the load-bearing guard; BGW_ALLOWED_ORIGINS is additive only.
  const allowedHosts = splitCsv(process.env.BGW_ALLOWED_HOSTS);
  const allowedOrigins = splitCsv(process.env.BGW_ALLOWED_ORIGINS);
  const rebindError = dnsRebindBootError(allowedHosts);
  if (rebindError) throw new Error(rebindError);

  const handler = createHttpHandler({
    authenticate: (token: string) => policy.authenticate(token),
    buildServer: (consumer: Consumer): ConsumerServer => {
      // One consumer-bound graph per connection: a fresh stateful drive controller + a retrieve
      // closure pinned to this consumer's token. The session pool / per-consumer cap / reaper stay
      // GLOBAL on the gateway (do not reintroduce the e431101 per-consumer-cap race). The vault +
      // this consumer's id + allowlist enable U9 warm-open: a navigate to an approved host that has a
      // stored login transparently opens a logged-in session (vault dormant → vault null → cold-only).
      const drive = new GatewayDriveController(gateway, secrets, consumer.token, {
        onDatacenterIp,
        stickySuffix,
        forceProxyHosts,
        freshExitHosts,
        warmupHosts,
        warmupPaths,
        log,
        verifyEgress,
        vault,
        consumerId: consumer.id,
        allowlist: consumer.allowlist,
      });
      const server = createGatewayMcpServer({
        version: "0.1.0",
        drive,
        retrieve: async ({ url, forceProxy }) => {
          try {
            const forced = (forceProxy ?? false) || hostForcesProxy(new URL(url).hostname, forceProxyHosts);
            return await retrieve(gateway, secrets, { token: consumer.token, url, escalation: { onDatacenterIp }, stickySuffix, forceProxy: forced, timeouts: config.timeouts });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(redactSecrets(message, secrets)); // never leak BYO secret material (R9)
          }
        },
      });
      return { server, dispose: () => drive.close() };
    },
    allowedHosts,
    allowedOrigins,
    // Liveness/health for a client-side breaker (issue #47): a cheap, browser-session-free signal.
    // Minimal today; issue #53 folds in the gateway's pool-degradation counters (gateway.sessions).
    health: () => ({ status: "ok" as const }),
    log,
  });
  handler.startReaper(MCP_SESSION_REAPER_INTERVAL_MS);

  const httpServer = createServer((req, res) => {
    handler.handle(req, res).catch((err) => {
      log(`handler error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null }));
      }
    });
  });

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    httpServer.close(); // refuse new connections
    await handler.drain(SHUTDOWN_DRAIN_MS); // let in-flight tool calls settle before force-closing
    await handler.closeAll().catch(() => {}); // close transports + dispose drive controllers
    httpServer.closeAllConnections?.(); // drop any lingering sockets (e.g. idle SSE) so close() completes
    await gateway.shutdown().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const port = Number(process.env.BGW_HTTP_PORT) || DEFAULT_PORT;
  const bind = process.env.BGW_HTTP_BIND || DEFAULT_BIND;
  httpServer.listen(port, bind, () => {
    log(
      `listening on ${bind}:${port} — consumers=[${specs.map((s) => s.id).join(", ")}] ` +
        `maxSessions=${config.maxSessions} perConsumerMax=${config.perConsumerMax} datacenter=${onDatacenterIp} ` +
        `sticky=${stickySuffix !== undefined} ` +
        `dnsRebindProtection=${allowedHosts.length > 0 || allowedOrigins.length > 0}`,
    );
  });
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
