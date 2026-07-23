/**
 * `obscura status` (R5) — the health doctor: one at-a-glance read of tunnel / gateway /
 * (opt-in) stealth health plus the CONFIGURED consumers (live "who's connected now" is
 * north-star and needs a gateway endpoint that doesn't exist yet — KTD12).
 *
 * The load-bearing distinction: "tunnel up + gateway down" (the ssh forward answers but /mcp
 * doesn't — prod container down) is NOT "tunnel down" (no local forward at all), and a 403 is
 * a Host/token mismatch, not unreachability. Each gets its own line and its own fix.
 */
import { owl, ok, fail, note } from "./brand.js";
import type { OwlState } from "./brand.js";
import type { KeysListResult } from "./keys.js";
import { formatConsumerLine } from "./keys.js";
import type { TunnelSpec, TunnelState } from "./tunnel.js";
import { tunnelState } from "./tunnel.js";
import type { HealthProbeResult, VerifyProbe, VerifyState } from "./verify.js";
import { verifyGateway, httpProbe } from "./verify.js";

/** Status should be snappy: a short window still rides out a blip without feeling hung. */
const STATUS_VERIFY_WINDOW_MS = 6_000;
const STATUS_VERIFY_POLL_MS = 2_000;

export interface StatusDeps {
  spec: TunnelSpec;
  gatewayHost: string;
  out: (line: string) => void;
  /** Seams for tests; defaults are the real implementations. */
  state?: (spec: TunnelSpec) => Promise<TunnelState>;
  probe?: VerifyProbe;
  wait?: (ms: number) => Promise<void>;
  verifyTimeoutMs?: number;
  verifyPollMs?: number;
  /** Configured-consumer inspection over admin SSH; absent = that section is skipped. */
  consumers?: () => Promise<KeysListResult>;
  /** The 1/1 stealth gate; wired only when --stealth is requested. */
  stealth?: () => Promise<boolean>;
  /** Operator-token `GET /health` read (issue #53); absent = no healthToken configured — the pool
   *  section is skipped with a hint. Wired from `healthProbe(...)` with the config's healthToken. */
  poolHealth?: () => Promise<HealthProbeResult>;
}

export interface StatusOptions {
  stealth?: boolean;
}

export interface StatusReport {
  tunnel: TunnelState;
  gateway: VerifyState;
  /** Overall: gateway reachable + port ours + (when requested) stealth green + pool not degraded. */
  healthy: boolean;
  owl: OwlState;
  consumers?: KeysListResult;
  stealthGreen?: boolean;
  /** The pool-degradation verdict from the operator /health read (issue #53): "ok" | "degraded" |
   *  "unavailable" (probe failed / rejected) — absent when no healthToken is configured. */
  pool?: "ok" | "degraded" | "unavailable";
}

export async function status(deps: StatusDeps, opts: StatusOptions = {}): Promise<StatusReport> {
  const { spec, out } = deps;
  const state = deps.state ?? tunnelState;
  const tunnel = await state(spec);
  const verify = await verifyGateway({
    probe: deps.probe ?? httpProbe(spec.localPort, deps.gatewayHost),
    timeoutMs: deps.verifyTimeoutMs ?? STATUS_VERIFY_WINDOW_MS,
    pollMs: deps.verifyPollMs ?? STATUS_VERIFY_POLL_MS,
    ...(deps.wait ? { wait: deps.wait } : {}),
  });
  const gateway = verify.state;

  let stealthGreen: boolean | undefined;
  if (opts.stealth) {
    if (!deps.stealth) throw new Error("--stealth requires the admin SSH config for the gate");
    stealthGreen = await deps.stealth();
  }

  // — pool health (issue #53): the operator-token /health read, only meaningful when the gateway answers —
  let pool: StatusReport["pool"];
  let poolBody: Record<string, unknown> | undefined;
  if (deps.poolHealth && gateway === "healthy") {
    const read = await deps.poolHealth();
    poolBody = read.body;
    // Codex #53 r1: require the FULL operator shape before trusting the verdict — a healthToken
    // mistakenly set to a valid CONSUMER token gets the bare `{status:"ok"}` liveness body, which must
    // read as "unavailable" (misconfigured), never as "pool healthy, force-kill armed".
    const b = read.body;
    const isOperatorShape =
      b !== undefined &&
      (b.status === "ok" || b.status === "degraded") &&
      typeof b.forceKillAvailable === "boolean" &&
      typeof b.unconfirmedCount === "number" &&
      typeof b.orphanCount === "number" &&
      typeof b.watchedCount === "number" && // codex r2: a skewed body missing it must not read as verified
      typeof b.activeCount === "number" &&
      typeof b.reservedCount === "number" && // codex r3: the admission gate counts reservations too
      typeof b.maxSessions === "number";
    pool = !isOperatorShape ? "unavailable" : b.status === "ok" ? "ok" : "degraded";
  }

  // A DEGRADED pool is unhealthy (a wedged core could zombie / a browser may be alive uncounted) but
  // it is NOT an outage — the gateway answers; the pool is impaired. Codex #53 r4: keep the states
  // visually distinct (squinting owl, nonzero exit) so ops can tell "restart/debug the pool" apart
  // from "the service is dead". An UNAVAILABLE read is a config/rollout mismatch, surfaced but not a
  // health failure by itself.
  const reachable = gateway === "healthy" && tunnel.port === "ours" && stealthGreen !== false;
  const healthy = reachable && pool !== "degraded";
  const face: OwlState = healthy ? "connected" : reachable && pool === "degraded" ? "degraded" : "down";
  out(`${owl(face)}  obscura status`);

  // — tunnel line —
  if (tunnel.port === "foreign") {
    out(fail(`local port ${spec.localPort} is bound by a FOREIGN process — that listener is not our tunnel`));
  } else if (tunnel.agent === "self-disabled") {
    out(fail("tunnel self-disabled — the keeper gave up after repeated fast-fails:"));
    for (const line of (tunnel.selfDisableReason ?? "").split("\n").filter(Boolean)) out(`    ${line}`);
    out(note(`re-enable once fixed: launchctl bootstrap gui/$(id -u) ${spec.plistPath}`));
  } else if (tunnel.agent === "not-bootstrapped") {
    out(fail("tunnel not set up on this Mac — run: obscura connect"));
  } else if (tunnel.port === "ours") {
    out(ok(`tunnel up — LaunchAgent ${tunnel.agent}, forward on 127.0.0.1:${spec.localPort}`));
  } else {
    // Agent loaded but no local forward yet (establishing, or the link just dropped).
    out(fail(`tunnel down — LaunchAgent ${tunnel.agent} but no forward on 127.0.0.1:${spec.localPort}`));
  }

  // — gateway line —
  switch (gateway) {
    case "healthy":
      out(ok("gateway healthy — /mcp answers 401 through the tunnel"));
      break;
    case "host-or-token-mismatch":
      out(fail(`gateway REJECTED the probe (403 with Host: ${deps.gatewayHost}) — Host/allowed-hosts mismatch, not an outage`));
      break;
    case "tunnel-down":
      if (tunnel.port === "ours") {
        out(fail("gateway down — the tunnel forward is up but nothing answered /mcp on the far side"));
        // A deploy/apply re-create takes ~10–20s, longer than this probe window — don't read a
        // mid-restart blip as an outage without a second look.
        out(note("if a deploy or keys --apply just ran, the container may be mid-recreate — recheck in ~20s"));
      } else {
        out(fail("gateway unreachable — no tunnel to carry the probe"));
      }
      break;
    case "unexpected":
      out(fail(`gateway answered /mcp with HTTP ${verify.code} — unexpected; check the gateway logs`));
      break;
  }

  // — pool line (issue #53) —
  if (pool !== undefined) {
    const n = (k: string): number | undefined => (typeof poolBody?.[k] === "number" ? (poolBody[k] as number) : undefined);
    const active = n("activeCount");
    const reserved = n("reservedCount") ?? 0;
    const max = n("maxSessions");
    // Codex r3: occupancy is what the ADMISSION GATE sees — active + in-flight reservations. A slow
    // launch holding the last slot must not render as "0/1 sessions" while acquires are refused.
    const occupied = active !== undefined ? active + reserved : undefined;
    const sessions =
      occupied !== undefined && max !== undefined
        ? `${occupied}/${max} sessions${reserved > 0 ? ` (${reserved} launching)` : ""}`
        : "sessions n/a";
    const watched = n("watchedCount") ?? 0;
    if (pool === "ok") {
      out(ok(`pool healthy — force-kill armed, 0 unconfirmed, ${sessions}`));
      if (occupied !== undefined && max !== undefined && occupied >= max) {
        out(note("pool is at capacity — new sessions will be refused until one frees"));
      }
      // Codex r3: watched wedges are informational but must be VISIBLE on the healthy branch too —
      // hiding them until something else degrades would mask a recurring launch-wedge pattern.
      if (watched > 0) out(note(`${watched} pending wedge(s) under watch (uncounted; being swept)`));
    } else if (pool === "degraded") {
      out(fail(`pool DEGRADED (${sessions}):`));
      if (poolBody?.forceKillAvailable === false) {
        out(fail("  force-kill unavailable — a wedged close can only zombie (check launch-time stderr)"));
      }
      const unconfirmed = n("unconfirmedCount") ?? 0;
      if (unconfirmed > 0) out(fail(`  ${unconfirmed} browser teardown(s) unconfirmed — a browser may still be alive`));
      const orphans = n("orphanCount") ?? 0;
      if (orphans > 0) out(fail(`  ${orphans} live orphaned launch(es) holding capacity (wedged/late launches)`));
      const watched = n("watchedCount") ?? 0;
      if (watched > 0) out(note(`  ${watched} pending wedge(s) under watch (uncounted; being swept)`));
    } else {
      out(note("pool health: unavailable — the health token was rejected or the body was unreadable (is BGW_HEALTH_TOKEN deployed and matching?)"));
    }
  } else if (deps.poolHealth === undefined) {
    out(note("pool health: skipped (no healthToken in config — set healthToken/OBSCURA_HEALTH_TOKEN to enable)"));
  }

  // — configured consumers (KTD12: configured, not live) —
  let consumers: KeysListResult | undefined;
  if (deps.consumers) {
    try {
      consumers = await deps.consumers();
      for (const c of consumers.consumers) {
        out(note(formatConsumerLine(c, "consumer ")));
      }
      for (const orphan of consumers.orphanEnvKeys) {
        out(fail(`env token ${orphan} has no manifest entry (desync)`));
      }
      if (consumers.consumers.length === 0) out(note("no consumers configured"));
    } catch (err) {
      out(note(`consumers: unavailable (${err instanceof Error ? err.message : String(err)})`));
    }
  } else {
    out(note("consumers: skipped (no admin SSH configured)"));
  }

  // — opt-in stealth —
  if (stealthGreen !== undefined) {
    out(stealthGreen ? ok("stealth green (1/1 gate)") : fail("stealth RED — the 1/1 validate-stealth run failed"));
  }

  return {
    tunnel,
    gateway,
    healthy,
    owl: face,
    ...(consumers ? { consumers } : {}),
    ...(stealthGreen !== undefined ? { stealthGreen } : {}),
    ...(pool !== undefined ? { pool } : {}),
  };
}
