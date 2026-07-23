/**
 * Shared HTTP MCP surface (U7a): one long-lived service that many consumers dial into over the
 * Tailnet, replacing the per-consumer stdio launcher. `createHttpHandler` is the testable core —
 * deps (authenticate, per-consumer server builder) are injected so the auth/routing/lifecycle can
 * be exercised over a real loopback socket with a fake retrieve/drive, no browser. `http-main`
 * binds the real gateway + policy.
 *
 * Design notes (from the U7a critique):
 *  - Auth routes through the injected `authenticate` (== `PolicyEngine.authenticate`), the SINGLE
 *    policy point — the transport never re-implements an allowlist/credential check (CLAUDE.md
 *    "policy in one place"). The bearer is re-checked on EVERY request and must still resolve to
 *    the consumer that opened the session, so a FOREIGN token (one that maps to a different
 *    consumer, or none) can't ride an open session → 403/401. Note this is foreign-token
 *    rejection, NOT live revocation: the registry is built once at startup (no hot reload, by
 *    design), so revoking a leaked token takes a process restart — which ends every session anyway.
 *  - The Authorization header / token is NEVER logged (R9): logs carry the consumer id only.
 *  - Stateful, session-id keyed: a `drive` session is stateful, so each MCP session maps to one
 *    consumer-bound `McpServer` + controller. The Streamable-HTTP transport fires `onsessionclosed`
 *    only on an explicit DELETE — a crashed client (SSE drop / TCP reset) does NOT, so an idle-MCP
 *    reaper closes abandoned sessions and disposes their controller (releasing the browser session).
 */
import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Consumer } from "../policy/index.js";

/** A per-consumer MCP server plus a teardown that releases any resources it holds (drive session). */
export interface ConsumerServer {
  server: McpServer;
  dispose: () => Promise<void>;
}

/**
 * The liveness/health payload the `GET /health` route returns to a CONSUMER token (issue #47). A cheap,
 * browser-session-free signal a client-side breaker re-probes instead of blind-cooling. Deliberately
 * minimal: pool internals are cross-tenant telemetry and are NOT exposed at this tier (issue #53 — the
 * operator tier below carries them).
 */
export interface HealthReport {
  status: "ok";
}

/**
 * The OPERATOR-tier health payload (issue #53): the #50/#54 pool-degradation counters, returned by
 * `GET /health` ONLY to the dedicated operator health token (`BGW_HEALTH_TOKEN` — NOT a consumer key;
 * it grants nothing but this read). Counters only — no session metadata, no consumer ids, no URLs —
 * so the body is secrets-free by construction. `status: "degraded"` when force-kill is unavailable
 * (a wedged close would zombie), an unconfirmed browser may be alive, or a live orphan holds capacity;
 * `watchedCount` is informational (a pending wedge under sweep — normal transient state).
 */
export interface OperatorHealthReport {
  status: "ok" | "degraded";
  forceKillAvailable: boolean;
  unconfirmedCount: number;
  orphanCount: number;
  watchedCount: number;
  activeCount: number;
  /** In-flight acquire reservations (codex r3): the admission gate refuses on active + reserved, so
   *  health must reflect the same occupancy the gate sees. */
  reservedCount: number;
  maxSessions: number;
}

/** The pool getters the operator health report projects — structurally `SessionManager`'s surface,
 *  kept as a type so the builder is pure and unit-testable off a fake. */
export interface PoolHealthSource {
  forceKillAvailable: boolean;
  unconfirmedCount: number;
  orphanCount: number;
  watchedCount: number;
  activeCount: number;
  reservedCount: number;
  maxSessions: number;
}

/** Project the pool getters into the operator health body (issue #53). Pure — the degraded verdict is
 *  derived here, in ONE place, so the CLI and any future consumer read the same semantics. */
export function buildOperatorHealth(pool: PoolHealthSource): OperatorHealthReport {
  const degraded = !pool.forceKillAvailable || pool.unconfirmedCount > 0 || pool.orphanCount > 0;
  return {
    status: degraded ? "degraded" : "ok",
    forceKillAvailable: pool.forceKillAvailable,
    unconfirmedCount: pool.unconfirmedCount,
    orphanCount: pool.orphanCount,
    watchedCount: pool.watchedCount,
    activeCount: pool.activeCount,
    reservedCount: pool.reservedCount,
    maxSessions: pool.maxSessions,
  };
}

/**
 * The shared HTTP launcher's fail-closed DNS-rebinding boot check. `BGW_ALLOWED_HOSTS` is MANDATORY:
 * MCP clients are non-browser, so they send no `Origin` header, and the SDK only validates the `Host`
 * header when `allowedHosts` is non-empty. `allowedOrigins` is therefore ADDITIVE (browser-origin
 * defense), never a substitute — an origins-only config would leave `Host` unvalidated. By not even
 * accepting origins here, it is structurally impossible for them to satisfy the guard. Returns an
 * error message when `allowedHosts` is empty, else null. Pure, so the launcher's guard is testable.
 */
export function dnsRebindBootError(allowedHosts: string[]): string | null {
  if (allowedHosts.length === 0) {
    return (
      "BGW_ALLOWED_HOSTS is required (the host:port the service is reached at over the Tailnet): MCP " +
      "clients send no Origin, so Host validation is the DNS-rebinding guard. Refusing to boot."
    );
  }
  return null;
}

export interface HttpHandlerDeps {
  /** Resolve a bearer token to a consumer; MUST throw on an unknown/empty credential. */
  authenticate: (token: string) => Consumer;
  /** Build the per-connection, consumer-bound MCP server (fresh drive controller + retrieve). */
  buildServer: (consumer: Consumer) => ConsumerServer;
  /** DNS-rebinding protection: enabled iff at least one allowed host/origin is configured. */
  allowedHosts?: string[];
  allowedOrigins?: string[];
  /** Idle MCP sessions older than this are reaped (covers disconnect-without-DELETE). Default 6m. */
  sessionIdleTtlMs?: number;
  /** How long a reaper/shutdown cleanup BLOCKS on the browser teardown before proceeding (so a hung drive
   *  op serialized behind the controller lock can't deadlock shutdown before gateway.shutdown() force-kills).
   *  Default {@link DEFAULT_CLEANUP_AWAIT_MS}; overridable for tests. */
  cleanupAwaitMs?: number;
  /** Max request body bytes accepted on POST. Default 4 MiB. */
  maxBodyBytes?: number;
  /** Liveness/health producer for the `GET /health` route's CONSUMER tier (issue #47). Cheap +
   *  browser-session-free — it must NOT acquire a browser or block. Absent → a bare `{ status: "ok" }`. */
  health?: () => HealthReport;
  /** The dedicated OPERATOR health token (issue #53, `BGW_HEALTH_TOKEN`). NOT a consumer key: it is
   *  checked ONLY on `GET /health` (timing-safe), grants nothing else, and never reaches the MCP
   *  routes. Absent/empty → the operator tier is off (every caller gets the consumer tier). */
  healthToken?: string;
  /** Producer for the operator-tier body (issue #53) — typically `() =>
   *  buildOperatorHealth(gateway.sessions)`. Same cheap/non-blocking contract as `health`. Absent →
   *  the operator token (if any) receives the consumer tier. */
  operatorHealth?: () => OperatorHealthReport;
  log?: (msg: string) => void;
  now?: () => number;
  /** Injectable session-id generator (tests). Default `randomUUID`. */
  generateSessionId?: () => string;
}

export interface HttpHandler {
  /** Node `http.createServer` request listener. */
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  /** Reap MCP sessions idle beyond the TTL; returns the reaped session ids. `now` injectable. */
  reapIdle: (now?: number) => Promise<string[]>;
  startReaper: (intervalMs?: number) => void;
  stopReaper: () => void;
  /** Wait (up to `timeoutMs`) for in-flight requests to settle. Used to drain before shutdown. */
  drain: (timeoutMs: number) => Promise<void>;
  /** Graceful shutdown: close every transport and dispose every controller. */
  closeAll: () => Promise<void>;
  sessionCount: () => number;
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  consumerId: string;
  dispose: () => Promise<void>;
  lastActivity: number;
  /** Count of POST requests (tool calls) currently executing on this session. The idle reaper never
   *  closes a session with an in-flight call, so a long-running verb (e.g. browser_wait_for) can't
   *  have its transport reaped out from under it mid-response. */
  inFlight: number;
}

const DEFAULT_IDLE_TTL_MS = 6 * 60_000; // a touch above the browser idle reaper, so Chrome frees first
const DEFAULT_MAX_BODY = 4 * 1024 * 1024;
/**
 * How long a reaper/shutdown cleanup blocks awaiting the browser teardown before PROCEEDING (issue #50
 * follow-up). A normal teardown (close→group-confirm, force-kill included) settles well under this; the
 * bound exists so a HUNG drive tool call — which holds the controller `#lock` and thus stalls
 * `drive.close()` → the gateway release indefinitely — can't deadlock `closeAll` and prevent http-main from
 * ever reaching `gateway.shutdown()` (the authoritative force-kill). gateway.shutdown() then reclaims the
 * stalled browser directly. Generous enough that a clean teardown always completes first.
 */
const DEFAULT_CLEANUP_AWAIT_MS = 8_000;

/** Await `p`, but give up after `ms` so a hung cleanup can't block a caller (the timer is cleared the
 *  instant `p` settles, so a normal fast cleanup incurs no delay). NOT unref'd: it must fire to unblock.
 *  Rejection-safe: `p.then(settle, settle)` OBSERVES both outcomes, so a rejecting `p` neither propagates
 *  nor leaves a discarded derived promise to surface as an unhandledRejection (codex r4). Exported for test. */
export function awaitBounded(p: Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    const settle = (): void => {
      clearTimeout(timer);
      resolve();
    };
    p.then(settle, settle);
  });
}

export function createHttpHandler(deps: HttpHandlerDeps): HttpHandler {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? (() => Date.now());
  const genId = deps.generateSessionId ?? (() => randomUUID());
  const allowedHosts = deps.allowedHosts ?? [];
  const allowedOrigins = deps.allowedOrigins ?? [];
  const dnsRebindProtection = allowedHosts.length > 0 || allowedOrigins.length > 0;
  const idleTtlMs = deps.sessionIdleTtlMs ?? DEFAULT_IDLE_TTL_MS;
  const cleanupAwaitMs = deps.cleanupAwaitMs ?? DEFAULT_CLEANUP_AWAIT_MS;
  const maxBodyBytes = deps.maxBodyBytes ?? DEFAULT_MAX_BODY;

  const sessions = new Map<string, SessionEntry>();
  /** In-flight cleanups, keyed by session id. Makes cleanup SINGLE-FLIGHT so the fire-and-forget callers
   *  (`onsessionclosed` / `transport.onclose`) and the AWAITING callers (`closeSession` via the reaper /
   *  `closeAll`) share ONE dispose — the awaiting caller then reliably waits for the browser teardown to
   *  COMPLETE (the gateway release resolves after close→group-confirm), not just for the transport to
   *  close. Load-bearing since #50 made the gateway teardown async-confirmed: without this a reaper/shutdown
   *  would return before the teardown even ran (it was fire-and-forget).
   *
   *  Note the layering: this waits for the teardown to COMPLETE, not for the browser slot to be
   *  confirmed reclaimed. A force-kill that can't confirm death does not free the slot — SessionManager
   *  deliberately RETAINS that browser in its counted `#unconfirmed` set and its own reaper/`shutdown`
   *  reconfirms it. The gateway (`activeCount`/`unconfirmedCount`) is the source of truth for browser
   *  slots; this MCP layer owns only the transport + controller lifecycle and must not duplicate that. */
  const cleanups = new Map<string, Promise<void>>();
  let reaperTimer: ReturnType<typeof setInterval> | undefined;

  function cleanup(sessionId: string): Promise<void> {
    const existing = cleanups.get(sessionId);
    if (existing) return existing; // a cleanup is already in flight → share it (onclose + reaper race)
    const entry = sessions.get(sessionId);
    if (!entry) return Promise.resolve(); // idempotent: nothing (left) to clean
    sessions.delete(sessionId);
    const done = entry
      .dispose()
      // dispose (drive.close → gateway.closeConsumerSession → release) never rejects: an unconfirmed
      // force-kill is a RETAINED counted slot in the gateway, not a rejection. The catch is belt-and-braces.
      .catch(() => {})
      .then(() => {
        cleanups.delete(sessionId);
        log(`session ${sessionId} transport closed (consumer=${entry.consumerId}); ${sessions.size} live`);
      })
      // `done` MUST NOT reject: the fire-and-forget callers (`void cleanup(sid)` in onclose/onsessionclosed)
      // discard it, so a late throw (e.g. an injected logger that throws) would surface as an
      // unhandledRejection. Absorb it here so every caller — voided or awaited — is rejection-safe (codex r4).
      .catch(() => {
        cleanups.delete(sessionId);
      });
    cleanups.set(sessionId, done);
    return done;
  }

  async function openSession(
    consumer: Consumer,
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
  ): Promise<void> {
    const built = deps.buildServer(consumer);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: genId,
      enableDnsRebindingProtection: dnsRebindProtection,
      allowedHosts,
      allowedOrigins,
      onsessioninitialized: (sid) => {
        sessions.set(sid, { transport, consumerId: consumer.id, dispose: built.dispose, lastActivity: now(), inFlight: 0 });
        log(`session ${sid} open (consumer=${consumer.id}); ${sessions.size} live`);
      },
      onsessionclosed: (sid) => void cleanup(sid), // explicit DELETE
    });
    // SSE-drop / TCP-reset does NOT fire onsessionclosed; onclose is the catch-all for a transport
    // that ends without a clean DELETE (alongside the idle reaper).
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) void cleanup(sid);
    };
    try {
      await built.server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      // A throw from connect()/handleRequest() bypasses the orphan check below, so dispose here too —
      // otherwise the per-consumer controller (and any browser session) leaks. If the session DID get
      // registered before the throw, cleanup() owns disposal; only dispose the still-orphaned case.
      if (!transport.sessionId) await built.dispose().catch(() => {});
      await transport.close().catch(() => {});
      throw err;
    }
    // If the initialize was rejected (e.g. DNS-rebind block), no session id was assigned and no
    // entry was registered — dispose the orphaned controller/server so nothing leaks.
    if (!transport.sessionId) {
      await built.dispose().catch(() => {});
      await transport.close().catch(() => {});
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    if (method !== "POST" && method !== "GET" && method !== "DELETE") {
      res.setHeader("Allow", "GET, POST, DELETE"); // RFC 9110 §15.5.6; matches the SDK's own 405
      return sendError(res, 405, -32600, "method not allowed");
    }

    // Liveness/health (issue #47/#53): a cheap, browser-session-free signal. Session-INDEPENDENT (no
    // MCP initialize handshake) and handled BEFORE the consumer-auth policy point because the OPERATOR
    // health token (#53) is deliberately NOT a consumer credential — it must never authenticate toward
    // the MCP routes, and consumer auth would 401 it before this route could see it. The tier order is
    // fail-closed: (1) the DNS-rebinding Host/Origin validation the SDK transport enforces on the MCP
    // routes applies here FIRST (this route bypasses the transport; the Host allowlist is load-bearing —
    // codex #47 r2 — doubly so now that pool internals ride the operator body); (2) the operator token
    // (timing-safe compare) gets the counters; (3) a valid CONSUMER token gets the bare liveness body
    // (unchanged #47 contract); (4) anything else gets the same 401 as before.
    if (method === "GET" && requestPath(req) === "/health") {
      if (dnsRebindProtection && dnsRebindRequestError(req, allowedHosts, allowedOrigins)) {
        return sendError(res, 403, -32003, "forbidden");
      }
      const bearer = parseBearer(req.headers["authorization"]);
      if (
        deps.healthToken !== undefined &&
        deps.healthToken !== "" &&
        deps.operatorHealth !== undefined &&
        timingSafeTokenEqual(bearer, deps.healthToken)
      ) {
        return sendHealth(res, deps.operatorHealth);
      }
      try {
        deps.authenticate(bearer);
      } catch {
        res.setHeader("WWW-Authenticate", "Bearer");
        return sendError(res, 401, -32002, "unauthorized");
      }
      return sendHealth(res, deps.health);
    }

    // Auth FIRST for everything else, through the single policy point. Never log the header or the
    // token. 401 carries a distinct JSON-RPC code from the 404 session-not-found case (-32001) so
    // clients can tell "re-provision the token" apart from "re-initialize the session".
    let consumer: Consumer;
    try {
      consumer = deps.authenticate(parseBearer(req.headers["authorization"]));
    } catch {
      res.setHeader("WWW-Authenticate", "Bearer");
      return sendError(res, 401, -32002, "unauthorized");
    }

    const sessionId = headerValue(req.headers["mcp-session-id"]);

    if (method === "POST") {
      let body: unknown;
      try {
        body = await readJsonBody(req, maxBodyBytes);
      } catch (err) {
        const tooBig = err instanceof Error && err.message === "body too large";
        return sendError(res, tooBig ? 413 : 400, -32700, tooBig ? "request body too large" : "invalid JSON body");
      }

      if (sessionId) {
        const entry = requireOwnedSession(sessionId, consumer, res);
        if (!entry) return;
        // Mark the call in-flight so the idle reaper won't close this session mid-response (a long
        // tool call can outlive the idle TTL); re-stamp activity on completion so a just-finished
        // long call isn't reaped on the next tick.
        entry.lastActivity = now();
        entry.inFlight++;
        try {
          await entry.transport.handleRequest(req, res, body);
        } finally {
          entry.inFlight--;
          entry.lastActivity = now();
        }
        return;
      }
      if (!isInitializeRequest(body)) {
        return sendError(res, 400, -32600, "missing mcp-session-id header (and not an initialize request)");
      }
      return openSession(consumer, req, res, body);
    }

    // GET (open the SSE stream) or DELETE (terminate the session) — both require an owned session.
    if (!sessionId) return sendError(res, 400, -32600, "missing mcp-session-id header");
    const entry = requireOwnedSession(sessionId, consumer, res);
    if (!entry) return;
    entry.lastActivity = now();
    return entry.transport.handleRequest(req, res);
  }

  /** Look up a session and enforce that THIS consumer owns it; writes the error + returns null if not. */
  function requireOwnedSession(sessionId: string, consumer: Consumer, res: ServerResponse): SessionEntry | null {
    const entry = sessions.get(sessionId);
    if (!entry) {
      sendError(res, 404, -32001, "unknown or expired session");
      return null;
    }
    if (entry.consumerId !== consumer.id) {
      // Don't distinguish "foreign" from "unknown" beyond the status — leak nothing about other
      // consumers' sessions. This rejects a token that maps to a DIFFERENT consumer; it is not live
      // revocation (the registry is static until restart — see the header note).
      sendError(res, 403, -32003, "session does not belong to this consumer");
      return null;
    }
    return entry;
  }

  /** Close a session's transport (fires onclose -> cleanup) and AWAIT the cleanup — including the browser
   *  teardown COMPLETING. `transport.close()` fires `onclose` which kicks off `cleanup` fire-and-forget;
   *  awaiting `cleanup(sid)` here returns that same in-flight dispose (single-flight), so the reaper /
   *  shutdown wait for the gateway teardown to complete, not just for the transport to close (load-bearing
   *  since #50 made the gateway teardown async-confirmed). Confirmation/retention of a browser slot that
   *  can't be confirmed dead is the gateway's job (its `#unconfirmed` set) — see `cleanup`. Also a
   *  belt-and-suspenders cleanup if onclose didn't fire. */
  async function closeSession(sid: string, entry: SessionEntry): Promise<void> {
    await entry.transport.close().catch(() => {});
    // Bounded: a hung drive tool call holds the controller lock, so the cleanup's dispose (drive.close →
    // gateway release) can stall indefinitely. Don't let that deadlock the reaper tick / shutdown — proceed
    // after the bound and let gateway.shutdown() reclaim the stalled browser (codex #50-followup r3).
    await awaitBounded(cleanup(sid), cleanupAwaitMs);
  }

  async function reapIdle(nowTs: number = now()): Promise<string[]> {
    // Never reap a session with an in-flight tool call — closing its transport mid-response would
    // make the McpServer's send() throw and hand the consumer a corrupt/hung reply.
    const stale = [...sessions.entries()].filter(([, e]) => e.inFlight === 0 && nowTs - e.lastActivity > idleTtlMs);
    for (const [sid, entry] of stale) await closeSession(sid, entry);
    return stale.map(([sid]) => sid);
  }

  function startReaper(intervalMs = 60_000): void {
    stopReaper();
    const timer = setInterval(() => void reapIdle(), intervalMs);
    timer.unref?.();
    reaperTimer = timer;
  }

  function stopReaper(): void {
    if (reaperTimer) {
      clearInterval(reaperTimer);
      reaperTimer = undefined;
    }
  }

  /** Wait up to `timeoutMs` for in-flight tool calls to settle (polling), so shutdown can drain
   *  before force-closing transports. Resolves early once nothing is in flight. */
  async function drain(timeoutMs: number): Promise<void> {
    const deadline = now() + timeoutMs;
    const busy = () => [...sessions.values()].some((e) => e.inFlight > 0);
    while (busy() && now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  async function closeAll(): Promise<void> {
    stopReaper();
    // Close every transport (each fires onclose → cleanup) and dispose every controller CONCURRENTLY, then
    // await ALL cleanups — the ones just kicked off plus any already in flight (a fire-and-forget onclose /
    // overlapping reap) — under ONE shared deadline. Concurrency + a single bound is load-bearing: awaiting
    // sessions sequentially would COMPOUND the bound (N hung sessions → N×cleanupAwaitMs) and could exceed
    // the shutdown budget before http-main reaches gateway.shutdown() (codex r4). With this, a hung dispose
    // (or several) delays closeAll by at most cleanupAwaitMs total. gateway.shutdown() then reclaims any
    // stalled browser directly (SessionManager `#sessions`, bypassing the controller lock) — the gateway,
    // not this handler, owns browser-slot confirmation/retention (its `#unconfirmed`).
    const perSession = [...sessions.entries()].map(async ([sid, entry]) => {
      await entry.transport.close().catch(() => {});
      await cleanup(sid);
    });
    const drain = Promise.all([...perSession, ...cleanups.values()]).then(() => {});
    await awaitBounded(drain, cleanupAwaitMs);
  }

  return { handle, reapIdle, startReaper, stopReaper, drain, closeAll, sessionCount: () => sessions.size };
}

/** Extract the bearer token from an Authorization header; "" when absent/malformed. */
function parseBearer(header: string | string[] | undefined): string {
  const value = headerValue(header);
  if (!value) return "";
  const match = /^Bearer (.+)$/i.exec(value.trim());
  return match && match[1] ? match[1].trim() : "";
}

function headerValue(header: string | string[] | undefined): string | undefined {
  return Array.isArray(header) ? header[0] : header;
}

/**
 * The SDK transport's DNS-rebinding check, mirrored for routes that bypass it (the `/health` route —
 * issue #47, codex r2). Same semantics as `StreamableHTTPServerTransport.validateRequestHeaders`: with an
 * `allowedHosts` allowlist, the `Host` header MUST be on it; with `allowedOrigins`, a present `Origin` MUST
 * be on it. Callers gate on `dnsRebindProtection` first, so this assumes protection is on. Returns an error
 * string when the request should be rejected, else null. Kept in lockstep with the SDK so `/health` and the
 * MCP routes never diverge on which requests the Host guard blocks.
 */
function dnsRebindRequestError(req: IncomingMessage, allowedHosts: string[], allowedOrigins: string[]): string | null {
  if (allowedHosts.length > 0) {
    const host = headerValue(req.headers.host);
    if (!host || !allowedHosts.includes(host)) return `Invalid Host header: ${host ?? ""}`;
  }
  if (allowedOrigins.length > 0) {
    const origin = headerValue(req.headers.origin);
    if (origin && !allowedOrigins.includes(origin)) return `Invalid Origin header: ${origin}`;
  }
  return null;
}

/** The request path (pathname only, query stripped) from an origin-form request-target. A missing/odd
 *  target falls back to "/", so it never throws and can't accidentally match "/health". */
function requestPath(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    return "/";
  }
}

/** Write the liveness payload (issue #47/#53): a small JSON body, no-store, consuming no browser
 *  session. `no-store` so an intermediary can't serve a stale "ok" for a since-degraded gateway —
 *  load-bearing now that the operator tier carries degradation counters. */
function sendHealth(res: ServerResponse, health?: () => HealthReport | OperatorHealthReport): void {
  const body = JSON.stringify(health ? health() : { status: "ok" });
  res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(body);
}

/** Constant-time bearer compare for the operator health token (issue #53): both sides are hashed to a
 *  fixed length first, so neither content nor LENGTH differences leak timing. */
function timingSafeTokenEqual(candidate: string, expected: string): boolean {
  const a = createHash("sha256").update(candidate).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Write a JSON-RPC 2.0 error envelope with an HTTP status, so MCP clients parse it cleanly. */
function sendError(res: ServerResponse, status: number, code: number, message: string): void {
  if (res.headersSent) return;
  const body = JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null });
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

/** Read + JSON-parse a request body, rejecting bodies over `maxBytes` ("body too large"). */
async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  await new Promise<void>((resolve, reject) => {
    // Guard against a double settle: on overflow we reject AND destroy the request, which then emits
    // 'error' — without the flag that 'error' handler would reject a second time. (The Promise
    // executor ignores the duplicate today; the flag makes the contract explicit and refactor-safe.)
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      err ? reject(err) : resolve();
    };
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        // Reject and stop buffering, but do NOT destroy the socket — the caller still needs to write
        // the 413 response. Late 'data'/'error' events after this are no-ops via the `settled` guard.
        done(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => done());
    req.on("error", done);
  });
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return undefined;
  return JSON.parse(text);
}
