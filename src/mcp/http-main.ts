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
import { loadArtifactConfig, buildArtifactRuntime } from "../artifacts/runtime-builder.js";
import type { ArtifactRuntime } from "../artifacts/index.js";
import { createGatewayMcpServer } from "./server.js";
import { GatewayDriveController } from "./drive-controller.js";
import { createHttpHandler, dnsRebindBootError, buildOperatorHealth } from "./http-server.js";
import type { ConsumerServer } from "./http-server.js";
import {
  createConsumerGraphDisposer,
  closeArtifactRuntimeBounded,
  runShutdownSequence,
  SHUTDOWN_DRAIN_MS,
  ARTIFACT_CLOSE_TIMEOUT_MS,
} from "./artifact-graph-lifecycle.js";
import { describeInit } from "../gateway/init-identity.js";

const log = (msg: string): void => void process.stderr.write(`[browse-gateway-http] ${msg}\n`);

// The Obscura wordmark, inlined: the gateway must not depend on the CLI subtree (layer
// direction), and one banner string doesn't justify a shared module.
const OBSCURA_BOOT_BANNER = "(o,o) OBSCURA — see without being seen";

const DRIVE_IDLE_TTL_MS = 5 * 60_000; // browser-session idle reap (frees Chrome)
const DRIVE_REAPER_INTERVAL_MS = 60_000;
const MCP_SESSION_REAPER_INTERVAL_MS = 60_000;
// The shutdown budgets live with `runShutdownSequence` (which they parametrize) so a test can assert
// the container's stop grace actually covers them — see `worstCaseShutdownMs`.
const DEFAULT_PORT = 8080;
const DEFAULT_BIND = "127.0.0.1"; // fail-closed: deployment sets the Tailnet address explicitly

function splitCsv(value: string | undefined): string[] {
  return (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** What `shutdown` needs once the runtime exists. Late-bound: the handlers are armed before it does. */
interface ShutdownTarget {
  httpServer: { close: () => unknown; closeAllConnections?: () => void };
  handler: { drain: (ms: number) => Promise<void>; closeAll: () => Promise<void>; sessionCount: () => number };
  gateway: { shutdown: () => Promise<void>; sessions: { activeCount: number } };
  /** Task 2 §6 — the process-owned runtime, present iff artifact capture is enabled. Absent = the
   *  shutdown sequence's artifact-close step is a no-op (disabled mode, unchanged behavior). */
  artifactRuntime?: ArtifactRuntime;
}

/**
 * Arm SIGINT/SIGTERM immediately and return the attach function for the runtime that does not exist
 * yet (issue #131 piece 2, C7).
 *
 * These handlers used to be registered near the END of boot, after the runtime, the fail-closed boot
 * guards and the reaper. That was survivable only by accident: with node as PID 1 the kernel discards
 * default-disposition signals sent to init, so a SIGTERM arriving during the boot window did nothing
 * and the container stayed up. Baking in a reaping PID 1 removes that accidental shield — the same
 * signal now terminates the process immediately, exit 143, with `gateway.shutdown()` never called and
 * any half-launched browser left behind. So the handlers move to the top, and the pre-runtime case
 * exits deliberately and says why.
 */
function armShutdown(): (target: ShutdownTarget) => void {
  let target: ShutdownTarget | undefined;
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (!target) {
      // Signalled inside the boot window. Nothing is listening and no browser has been handed out,
      // so there is nothing to drain — but say so, or this reads as an unexplained exit 143.
      log(`${signal} during boot, before the runtime existed — exiting; nothing to drain`);
      process.exit(0);
    }
    // #129: the drain was entirely silent, so a swap could not be told apart from a crash after the
    // fact. Name what is in flight, the budget, and the outcome.
    const t0 = Date.now();
    log(
      `${signal} — draining: mcpSessions=${target.handler.sessionCount()} ` +
        `browserSessions=${target.gateway.sessions.activeCount} budgetMs=${SHUTDOWN_DRAIN_MS}`,
    );
    // Task 2 §6 "HTTP process" step 5, exactly ordered: refuse new HTTP -> drain in-flight tool calls
    // (and any active artifact response lease, which keeps a session's inFlight elevated until its
    // tracker settles — see http-server.ts) -> close every consumer graph (each graph's dispose
    // synchronously fences its lineage, closes its drive session, THEN discards its committed
    // drive-scoped artifacts) -> bounded-close the artifact runtime -> gateway.shutdown().
    await runShutdownSequence(
      { httpServer: target.httpServer, handler: target.handler, gateway: target.gateway, artifactRuntime: target.artifactRuntime },
      { drainMs: SHUTDOWN_DRAIN_MS, artifactCloseTimeoutMs: ARTIFACT_CLOSE_TIMEOUT_MS, log },
    );
    log(`shutdown complete after ${Date.now() - t0}ms — mcpSessions=${target.handler.sessionCount()}`);
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  return (t) => {
    target = t;
  };
}

async function main(): Promise<void> {
  // FIRST, before any boot guard that can throw or block: see armShutdown's note.
  const attachShutdown = armShutdown();
  log(OBSCURA_BOOT_BANNER); // the brand on the experiential surface only — env/ports/tool names unchanged
  // Build the shared gateway runtime (config, secrets, vault, consumers, policy, gateway, escalation
  // posture) with every fail-closed boot guard. Identical construction is used by the on-host
  // `obscura vault login` capture (cli/vault-host.ts) so the two never drift.
  // Task G — read the artifact configuration BEFORE the gateway exists. The store is still built
  // below, inside the guard that owns releasing its lock; this read is pure (one env lookup, no
  // filesystem, no lock) and nothing has been constructed yet, so its fail-closed throw for an
  // enabled-without-root configuration still leaks nothing. It has to happen here because artifact
  // capture is a construction-time property of every browser core the gateway is about to pool — see
  // BuildRuntimeOptions.captureEnabled.
  const artifactConfig = loadArtifactConfig(process.env);
  const { gateway, secrets, policy, specs, config, vault, onDatacenterIp, stickySuffix, forceProxyHosts, freshExitHosts, warmupHosts, warmupPaths, verifyEgress } =
    buildGatewayRuntime(process.env, { log, captureEnabled: artifactConfig.enabled });
  gateway.sessions.startReaper(DRIVE_IDLE_TTL_MS, DRIVE_REAPER_INTERVAL_MS);

  // Task 2 §4.3/§6 — the HTTP process is the SOLE owner of the artifact runtime and its exclusive root
  // lock (see GatewayRuntime.artifactRuntime: the shared builder never takes it, so `obscura vault
  // login` and the on-host scripts can run against the same artifact env without contending for, or
  // leaking, the lock). It is constructed as the FIRST statement INSIDE this guard, deliberately:
  //   - every fail-closed guard inside buildGatewayRuntime (manifest, pool sizing, vault key, sticky
  //     suffix) has already run above, so an ordinary config typo can no longer abandon a lock that
  //     nothing reclaims and then mask itself as artifact-root-locked on every later boot; and
  //   - every guard that can still throw below (DNS-rebind, health-token collision, an invalid artifact
  //     root itself) is inside this try, so the catch bounded-closes the lock before the process exits.
  // `closeArtifactRuntimeBounded` is the same bound `runShutdownSequence` uses on the normal shutdown
  // path, so both cases are diagnosable the same way.
  // Declared OUTSIDE the try so the catch (and the listen-error handler) can still release the lock;
  // `artifacts` is the `const` alias the per-connection closures below capture, since narrowing on a
  // `let` does not survive into a deferred callback.
  let artifactRuntime: ArtifactRuntime | undefined;
  try {
    artifactRuntime = buildArtifactRuntime(artifactConfig);
    const artifacts = artifactRuntime;
    // Fail-closed (R13/R17 posture): the shared HTTP surface refuses to boot without Host-based
    // DNS-rebinding protection. The listener is reachable over the Tailnet and MCP clients send no
    // Origin, so Host validation is the load-bearing guard; BGW_ALLOWED_ORIGINS is additive only.
    const allowedHosts = splitCsv(process.env.BGW_ALLOWED_HOSTS);
    const allowedOrigins = splitCsv(process.env.BGW_ALLOWED_ORIGINS);
    const rebindError = dnsRebindBootError(allowedHosts);
    if (rebindError) throw new Error(rebindError);

    // #53 (codex r1): the operator health token must never COLLIDE with a consumer credential — the
    // /health route checks it BEFORE consumer auth, so a collision would hand that consumer the
    // cross-tenant pool counters, breaking the operator-only boundary. Fail closed at boot (the message
    // names neither token — R9).
    const healthToken = process.env.BGW_HEALTH_TOKEN;
    if (healthToken && specs.some((s) => s.token === healthToken)) {
      throw new Error("BGW_HEALTH_TOKEN collides with a consumer token — the operator health token must be a distinct credential. Refusing to boot.");
    }

    const handler = createHttpHandler({
    authenticate: (token: string) => policy.authenticate(token),
    buildServer: (consumer: Consumer): ConsumerServer => {
      // One consumer-bound graph per connection: a fresh stateful drive controller + a retrieve
      // closure pinned to this consumer's token. The session pool / per-consumer cap / reaper stay
      // GLOBAL on the gateway (do not reintroduce the e431101 per-consumer-cap race). The vault +
      // this consumer's id + allowlist enable U9 warm-open: a navigate to an approved host that has a
      // stored login transparently opens a logged-in session (vault dormant → vault null → cold-only).
      // Task 2 §6 — this graph's artifact identity, present iff the process-owned runtime is enabled.
      // `drive.controllerId` (below) is the SAME primitive GatewayDriveController mints for its own
      // capture operations and what GatewayMcpDeps.artifacts.controllerId is snapshotted from, so
      // drive-side capture and MCP-side retrieval can never disagree on which lineage they mean.
      const artifactCapture = artifacts ? { runtime: artifacts, consumerId: consumer.id } : undefined;
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
        vault,
        consumerId: consumer.id,
        allowlist: consumer.allowlist,
        artifacts: artifactCapture,
      });
      const server = createGatewayMcpServer({
        version: "0.1.0",
        drive,
        retrieve: async ({ url, forceProxy }) => {
          try {
            const forced = (forceProxy ?? false) || hostForcesProxy(new URL(url).hostname, forceProxyHosts);
            return await retrieve(gateway, secrets, {
              token: consumer.token,
              url,
              escalation: { onDatacenterIp },
              stickySuffix,
              forceProxy: forced,
              timeouts: config.timeouts,
              artifactCapture,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(redactSecrets(message, secrets)); // never leak BYO secret material (R9)
          }
        },
        // Task 2 §4.2 — the server-scoped, IMMUTABLE artifact-retrieval dependency, present only when
        // this graph's runtime is enabled. `consumerId`/`controllerId` are snapshotted ONCE here, by
        // value, from server-minted identities never reachable from MCP input; `consumeForServer` is
        // the runtime's own `acquireResponseLease`, closed over nothing else.
        ...(artifacts
          ? {
              artifacts: {
                consumerId: consumer.id,
                controllerId: drive.controllerId,
                consumeForServer: (input: { artifactId: string; consumerId: string; controllerId?: string }) =>
                  artifacts.acquireResponseLease(input),
              },
            }
          : {}),
      });
      // Task 2 §6 — ONE idempotent dispose promise per graph, used identically whether it is reached
      // via an explicit DELETE, the idle MCP reaper, `closeAll()` (session teardown/process shutdown),
      // or http-server.ts's failed-session-open cleanup: synchronously fence this exact
      // {consumerId, controllerId} lineage, close the drive/browser session, THEN discard this
      // lineage's committed drive-scoped artifacts. Consumer-scoped (transient) artifacts are never
      // touched here (`discardController` only ever looks at drive-scoped entries).
      const dispose = createConsumerGraphDisposer({
        drive,
        artifactRuntime: artifacts,
        consumerId: consumer.id,
        controllerId: drive.controllerId,
      });
      return { server, dispose };
    },
    allowedHosts,
    allowedOrigins,
    // Final-review blocker: gates the artifact batch-rejection + tracker/context install in
    // http-server.ts. `Boolean(artifactRuntime)` so a deployment with no runtime (disabled) gets the
    // exact pre-Task-2 dispatch path, unchanged.
    artifactsEnabled: artifactRuntime !== undefined,
    // Liveness/health for a client-side breaker (issue #47): a cheap, browser-session-free signal —
    // the CONSUMER tier stays this bare body. The OPERATOR tier (issue #53) surfaces the #50/#54
    // pool-degradation counters behind the dedicated BGW_HEALTH_TOKEN — a token that is NOT a consumer
    // key (never in the manifest, never counted toward pool sizing, grants only this read). It is
    // compared, never logged; absent/empty → the operator tier is simply off.
    health: () => ({ status: "ok" as const }),
    healthToken,
    operatorHealth: () => buildOperatorHealth(gateway.sessions),
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

    attachShutdown({ httpServer, handler, gateway, artifactRuntime });

    const port = Number(process.env.BGW_HTTP_PORT) || DEFAULT_PORT;
    const bind = process.env.BGW_HTTP_BIND || DEFAULT_BIND;
    // Task 2 §4.3/§6 — a bind failure is emitted as an 'error' event on a LATER tick, so it is never
    // thrown INTO the try above and the catch's bounded close cannot see it. With no listener Node
    // rethrows it as an uncaught exception and the process dies still holding the artifact root lock,
    // which nothing reclaims — the exact leak this guard exists to prevent, on the likeliest late-boot
    // failure there is: EADDRNOTAVAIL when BGW_HTTP_BIND names a Tailnet address the sidecar has not
    // assigned yet, or EADDRINUSE on a restart race. Release the lock here too, then exit non-zero.
    httpServer.on("error", (err: NodeJS.ErrnoException) => {
      void (async () => {
        log(`listen failed on ${bind}:${port} — ${err.code ?? "error"}: ${err.message}`);
        await closeArtifactRuntimeBounded(artifactRuntime, ARTIFACT_CLOSE_TIMEOUT_MS, log);
        process.exit(1);
      })();
    });
    httpServer.listen(port, bind, () => {
      log(
        `listening on ${bind}:${port} — consumers=[${specs.map((s) => s.id).join(", ")}] ` +
          `maxSessions=${config.maxSessions} perConsumerMax=${config.perConsumerMax} datacenter=${onDatacenterIp} ` +
          `sticky=${stickySuffix !== undefined} ` +
          `dnsRebindProtection=${allowedHosts.length > 0 || allowedOrigins.length > 0} ` +
          `init=${describeInit()}`,
      );
    });
  } catch (err) {
    // Task 2 §4.3/§6: this boot guard failed AFTER the artifact runtime (if enabled) was already
    // constructed and holding its root lock — release it, bounded, before the top-level handler logs
    // and exits. Never abandon lock/root authority for a container's whole remaining lifetime over a
    // guard that has nothing to do with artifacts.
    await closeArtifactRuntimeBounded(artifactRuntime, ARTIFACT_CLOSE_TIMEOUT_MS, log);
    throw err;
  }
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
