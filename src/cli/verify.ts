/**
 * Gateway liveness verify (KTD7): probe `/mcp` through the tunnel with an explicit
 * `Host: <gatewayHost>` header — the gateway's DNS-rebind guard 403s any other Host, which is
 * why the tunnel's local port must stay 8080 (KTD5). There is no /health endpoint; an
 * unauthenticated 401 IS the liveness signal. The probe retries through the ~10–20s window a
 * prod redeploy needs to recreate the container, so a verify launched mid-deploy still lands.
 */
import { request } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

export type VerifyState = "healthy" | "host-or-token-mismatch" | "tunnel-down" | "unexpected";

export interface VerifyResult {
  state: VerifyState;
  /** The final HTTP status as curl-style text ("000" = no connection). */
  code: string;
}

/** Returns the HTTP status of one GET /mcp attempt, "000" when nothing answers. */
export type VerifyProbe = () => Promise<string>;

const PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_WINDOW_MS = 30_000;
const DEFAULT_POLL_MS = 2_000;

export function classifyProbeCode(code: string): VerifyState {
  switch (code) {
    case "401":
      return "healthy"; // reached the gateway; it correctly demands auth
    case "403":
      return "host-or-token-mismatch"; // the DNS-rebind Host check (or auth scope) rejected us
    case "000":
      return "tunnel-down"; // nothing listening / connection refused — no forward
    default:
      return "unexpected";
  }
}

/**
 * One real GET against the local tunnel mouth, Host header spoofed to what prod whitelists.
 * With `bearerToken` the probe authenticates: the gateway answers 401 to a REJECTED bearer and
 * something else (typically 400, missing mcp-session-id) to an accepted one — which is exactly
 * the signal `connect` needs to catch a stale/revoked key instead of printing a false ✓.
 */
export function httpProbe(localPort: number, hostHeader: string, bearerToken?: string): VerifyProbe {
  return () =>
    new Promise((resolve) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: localPort,
          path: "/mcp",
          method: "GET",
          headers: {
            Host: hostHeader,
            ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
          },
          timeout: PROBE_TIMEOUT_MS,
        },
        (res) => {
          res.resume(); // drain so the socket frees
          resolve(String(res.statusCode ?? 0).padStart(3, "0"));
        },
      );
      req.on("timeout", () => req.destroy());
      req.on("error", () => resolve("000"));
      req.end();
    });
}

/** One authed `GET /health` read (issue #53): the HTTP status plus the parsed JSON body (undefined on
 *  a non-200 / unparseable body). The operator token yields the pool counters; a network failure
 *  resolves `{ code: "000" }` — the caller renders "unavailable", never throws. */
export interface HealthProbeResult {
  code: string;
  body?: Record<string, unknown>;
}

export function healthProbe(localPort: number, hostHeader: string, bearerToken: string): () => Promise<HealthProbeResult> {
  return () =>
    new Promise((resolve) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: localPort,
          path: "/health",
          method: "GET",
          headers: { Host: hostHeader, Authorization: `Bearer ${bearerToken}` },
          timeout: PROBE_TIMEOUT_MS,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const code = String(res.statusCode ?? 0).padStart(3, "0");
            let body: Record<string, unknown> | undefined;
            if (res.statusCode === 200) {
              try {
                const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                if (parsed !== null && typeof parsed === "object") body = parsed as Record<string, unknown>;
              } catch {
                /* unparseable → body stays undefined; the caller renders "unavailable" */
              }
            }
            resolve({ code, ...(body !== undefined ? { body } : {}) });
          });
        },
      );
      req.on("timeout", () => req.destroy());
      req.on("error", () => resolve({ code: "000" }));
      req.end();
    });
}

export interface VerifyOptions {
  probe: VerifyProbe;
  /** Total retry window; defaults ride out a container recreate. */
  timeoutMs?: number;
  pollMs?: number;
  wait?: (ms: number) => Promise<void>;
}

/**
 * Poll until healthy, terminally mismatched, or the window closes. 403 returns immediately —
 * it is a deterministic config error (wrong Host/allowed-hosts), not something retries fix.
 * 000 and unexpected codes keep retrying (both happen transiently while a container recreates).
 */
export async function verifyGateway(opts: VerifyOptions): Promise<VerifyResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WINDOW_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const wait = opts.wait ?? sleep;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const code = await opts.probe();
    const state = classifyProbeCode(code);
    if (state === "healthy" || state === "host-or-token-mismatch") return { state, code };
    if (Date.now() >= deadline) return { state, code };
    await wait(pollMs);
  }
}
