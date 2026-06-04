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
 *    the consumer that opened the session, so a rotated/foreign token can't ride an open session.
 *  - The Authorization header / token is NEVER logged (R9): logs carry the consumer id only.
 *  - Stateful, session-id keyed: a `drive` session is stateful, so each MCP session maps to one
 *    consumer-bound `McpServer` + controller. The Streamable-HTTP transport fires `onsessionclosed`
 *    only on an explicit DELETE — a crashed client (SSE drop / TCP reset) does NOT, so an idle-MCP
 *    reaper closes abandoned sessions and disposes their controller (releasing the browser session).
 */
import { randomUUID } from "node:crypto";
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
  /** Max request body bytes accepted on POST. Default 4 MiB. */
  maxBodyBytes?: number;
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
  /** Graceful shutdown: close every transport and dispose every controller. */
  closeAll: () => Promise<void>;
  sessionCount: () => number;
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  consumerId: string;
  dispose: () => Promise<void>;
  lastActivity: number;
}

const DEFAULT_IDLE_TTL_MS = 6 * 60_000; // a touch above the browser idle reaper, so Chrome frees first
const DEFAULT_MAX_BODY = 4 * 1024 * 1024;

export function createHttpHandler(deps: HttpHandlerDeps): HttpHandler {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? (() => Date.now());
  const genId = deps.generateSessionId ?? (() => randomUUID());
  const allowedHosts = deps.allowedHosts ?? [];
  const allowedOrigins = deps.allowedOrigins ?? [];
  const dnsRebindProtection = allowedHosts.length > 0 || allowedOrigins.length > 0;
  const idleTtlMs = deps.sessionIdleTtlMs ?? DEFAULT_IDLE_TTL_MS;
  const maxBodyBytes = deps.maxBodyBytes ?? DEFAULT_MAX_BODY;

  const sessions = new Map<string, SessionEntry>();
  let reaperTimer: ReturnType<typeof setInterval> | undefined;

  async function cleanup(sessionId: string): Promise<void> {
    const entry = sessions.get(sessionId);
    if (!entry) return; // idempotent: onclose + onsessionclosed + reaper can all race to clean
    sessions.delete(sessionId);
    await entry.dispose().catch(() => {}); // release the drive session; never throw from teardown
    log(`session ${sessionId} closed (consumer=${entry.consumerId}); ${sessions.size} live`);
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
        sessions.set(sid, { transport, consumerId: consumer.id, dispose: built.dispose, lastActivity: now() });
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
    await built.server.connect(transport);
    await transport.handleRequest(req, res, body);
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
      return sendError(res, 405, -32000, "method not allowed");
    }

    // Auth FIRST, through the single policy point. Never log the header or the token.
    let consumer: Consumer;
    try {
      consumer = deps.authenticate(parseBearer(req.headers["authorization"]));
    } catch {
      res.setHeader("WWW-Authenticate", "Bearer");
      return sendError(res, 401, -32001, "unauthorized");
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
        entry.lastActivity = now();
        return entry.transport.handleRequest(req, res, body);
      }
      if (!isInitializeRequest(body)) {
        return sendError(res, 400, -32000, "missing mcp-session-id header (and not an initialize request)");
      }
      return openSession(consumer, req, res, body);
    }

    // GET (open the SSE stream) or DELETE (terminate the session) — both require an owned session.
    if (!sessionId) return sendError(res, 400, -32000, "missing mcp-session-id header");
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
      // consumers' sessions. Re-auth on every request is what revokes a rotated token mid-session.
      sendError(res, 403, -32003, "session does not belong to this consumer");
      return null;
    }
    return entry;
  }

  async function reapIdle(nowTs: number = now()): Promise<string[]> {
    const stale = [...sessions.entries()].filter(([, e]) => nowTs - e.lastActivity > idleTtlMs);
    for (const [sid, entry] of stale) {
      await entry.transport.close().catch(() => {}); // fires onclose -> cleanup
      if (sessions.has(sid)) await cleanup(sid); // belt-and-suspenders if onclose didn't fire
    }
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

  async function closeAll(): Promise<void> {
    stopReaper();
    for (const sid of [...sessions.keys()]) {
      const entry = sessions.get(sid);
      if (!entry) continue;
      await entry.transport.close().catch(() => {});
      if (sessions.has(sid)) await cleanup(sid);
    }
  }

  return { handle, reapIdle, startReaper, stopReaper, closeAll, sessionCount: () => sessions.size };
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
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve());
    req.on("error", reject);
  });
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return undefined;
  return JSON.parse(text);
}
