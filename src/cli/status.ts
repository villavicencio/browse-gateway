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
import type { VerifyProbe, VerifyState } from "./verify.js";
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
}

export interface StatusOptions {
  stealth?: boolean;
}

export interface StatusReport {
  tunnel: TunnelState;
  gateway: VerifyState;
  /** Overall: gateway reachable + port ours + (when requested) stealth green. */
  healthy: boolean;
  owl: OwlState;
  consumers?: KeysListResult;
  stealthGreen?: boolean;
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

  const healthy = gateway === "healthy" && tunnel.port === "ours" && stealthGreen !== false;
  const face: OwlState = healthy ? "connected" : "down";
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
      out(
        tunnel.port === "ours"
          ? fail("gateway down — the tunnel forward is up but nothing answered /mcp on the far side")
          : fail("gateway unreachable — no tunnel to carry the probe"),
      );
      break;
    case "unexpected":
      out(fail(`gateway answered /mcp with HTTP ${verify.code} — unexpected; check the gateway logs`));
      break;
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
  };
}
