/**
 * `obscura connect` (R4) — the one-command onboarding: discover the consumer key, raise the
 * durable hardened tunnel, register the MCP endpoint, verify end-to-end.
 *
 * Invariants: tunnel-ensure is idempotent; the only non-idempotent step is the `claude` config
 * write — when it (or anything after it) fails, connect reports the partial state and exits
 * non-zero with the tunnel deliberately LEFT UP. It never prints a false "connected".
 */
import { ok, fail, note } from "./brand.js";
import type { Keychain } from "./keychain.js";
import type { RemoteShell } from "./prod-ssh.js";
import { shQuote } from "./prod-ssh.js";
import type { TunnelSpec, TunnelState, EnsureResult } from "./tunnel.js";
import { ensureTunnel, tunnelState } from "./tunnel.js";
import type { RegisterOutcome } from "./mcp-register.js";
import { registerMcp } from "./mcp-register.js";
import type { VerifyProbe, VerifyResult } from "./verify.js";
import { verifyGateway, httpProbe } from "./verify.js";

export interface TokenDiscovery {
  token: string;
  source: "keychain" | "config";
  warning?: string;
}

/**
 * Discovery priority: Keychain → config/env (the config loader already folds `OBSCURA_TOKEN`
 * in). Disagreeing sources warn rather than silently picking; a missing key points at the
 * command that mints one.
 */
export async function discoverToken(keychain: Keychain, consumer: string, configToken?: string): Promise<TokenDiscovery> {
  const fromKeychain = await keychain.get(consumer);
  if (fromKeychain && configToken && fromKeychain !== configToken) {
    return {
      token: fromKeychain,
      source: "keychain",
      warning: "the Keychain and the config disagree on the token — using the Keychain copy",
    };
  }
  if (fromKeychain) return { token: fromKeychain, source: "keychain" };
  if (configToken) return { token: configToken, source: "config" };
  throw new Error(`no key found for "${consumer}" — run: obscura keys new ${consumer}`);
}

/** The opt-in stealth gate: the 1/1 validate-stealth run inside the prod container (KTD10). */
export function sshStealthGate(shell: RemoteShell, container: string): () => Promise<boolean> {
  return async () => {
    // BGW_ATTEMPTS=1 alone false-FAILs the gate — BGW_REQUIRED=1 must ride along (documented).
    // The gate drives a real browser through a live target: give it a long leash.
    const r = await shell.run(
      `set -e; export DOCKER_HOST="\${DOCKER_HOST:-unix:///run/user/$(id -u)/docker.sock}"; ` +
        `docker exec -e BGW_ATTEMPTS=1 -e BGW_REQUIRED=1 ${shQuote(container)} node scripts/validate-stealth.mjs`,
      undefined,
      { timeoutMs: 180_000 },
    );
    return r.code === 0;
  };
}

export interface ConnectDeps {
  consumer: string;
  spec: TunnelSpec;
  /** Host header the gateway's rebind guard whitelists — also why local port must be 8080 (KTD5). */
  gatewayHost: string;
  keychain: Keychain;
  configToken?: string;
  out: (line: string) => void;
  /** Seams for tests; defaults are the real implementations. */
  ensure?: (spec: TunnelSpec) => Promise<EnsureResult>;
  state?: (spec: TunnelSpec) => Promise<TunnelState>;
  register?: (opts: { url: string; token: string }) => Promise<RegisterOutcome>;
  probe?: VerifyProbe;
  /** Token-bearing probe for the key-acceptance check; defaults to httpProbe with the bearer. */
  authedProbe?: VerifyProbe;
  wait?: (ms: number) => Promise<void>;
  verifyTimeoutMs?: number;
  verifyPollMs?: number;
  /** Runs the prod stealth gate; wired only when --full is requested. */
  stealth?: () => Promise<boolean>;
}

export interface ConnectOptions {
  full?: boolean;
}

export async function connect(deps: ConnectDeps, opts: ConnectOptions = {}): Promise<void> {
  const { spec, out } = deps;

  // 1 — key discovery (cheap and read-only; nothing is touched when no key exists).
  const discovery = await discoverToken(deps.keychain, deps.consumer, deps.configToken);
  if (discovery.warning) out(note(discovery.warning));

  // 2 — tunnel: create what's absent, re-enable a self-disabled agent, adopt a running one.
  const ensure = deps.ensure ?? ensureTunnel;
  const ensured = await ensure(spec);
  for (const path of ensured.created) out(note(`created ${path}`));
  for (const drift of ensured.drift ?? []) out(fail(`tunnel artifact drift: ${drift}`));
  if (ensured.action === "re-enabled") out(note("tunnel LaunchAgent was self-disabled — re-enabled"));
  if (ensured.action === "bootstrapped") out(note("tunnel LaunchAgent bootstrapped"));
  if (ensured.newKeypair && ensured.installLine) {
    out(fail("a NEW tunnel keypair was generated — prod does not trust it yet"));
    out(note("pin it on the prod bgwtunnel user (~bgwtunnel/.ssh/authorized_keys):"));
    out(`  ${ensured.installLine}`);
  }

  // 3 — the port must be ours: registering against a foreign binder would hand the token's
  // requests to an unknown local process.
  const state = deps.state ?? tunnelState;
  const tunnel = await state(spec);
  if (tunnel.port === "foreign") {
    throw new Error(
      `local port ${spec.localPort} is bound by another process (not our ssh tunnel) — free it before connecting`,
    );
  }

  // 4 — register (the one non-idempotent step). On failure: report partial, leave the tunnel up.
  const register = deps.register ?? registerMcp;
  const url = `http://127.0.0.1:${spec.localPort}/mcp`;
  let outcome: RegisterOutcome;
  try {
    outcome = await register({ url, token: discovery.token });
  } catch (err) {
    out(fail(err instanceof Error ? err.message : String(err)));
    out(note("the tunnel is left up — fix the registration and re-run obscura connect"));
    throw new Error("connect incomplete: MCP registration failed");
  }
  out(note(`mcp registration: ${outcome} (server "browse-gateway", key from ${discovery.source})`));

  // 5 — verify end-to-end, riding out a possible container recreate.
  const result: VerifyResult = await verifyGateway({
    probe: deps.probe ?? httpProbe(spec.localPort, deps.gatewayHost),
    ...(deps.wait ? { wait: deps.wait } : {}),
    ...(deps.verifyTimeoutMs !== undefined ? { timeoutMs: deps.verifyTimeoutMs } : {}),
    ...(deps.verifyPollMs !== undefined ? { pollMs: deps.verifyPollMs } : {}),
  });
  switch (result.state) {
    case "healthy":
      break;
    case "host-or-token-mismatch":
      throw new Error(
        `gateway rejected the probe (403 with Host: ${deps.gatewayHost}) — host/token mismatch: ` +
          `check BGW_ALLOWED_HOSTS on prod and that the tunnel's local port is ${spec.localPort}`,
      );
    case "tunnel-down":
      throw new Error(
        `tunnel down — nothing answered on 127.0.0.1:${spec.localPort} ` +
          `(the LaunchAgent may still be establishing, self-disabled, or the new key isn't on prod yet; try obscura status)`,
      );
    case "unexpected":
      throw new Error(`gateway answered /mcp with HTTP ${result.code} — unexpected; check the gateway logs`);
  }

  // 5b — key acceptance: liveness 401 says the gateway is up, not that OUR token works. An
  // authenticated probe answering 401 means the bearer was rejected (stale/revoked key) — the
  // exact case that must not print a false ✓. Any non-401 (typically 400, missing session id)
  // means the token was accepted.
  const authedProbe = deps.authedProbe ?? httpProbe(spec.localPort, deps.gatewayHost, discovery.token);
  const authedCode = await authedProbe();
  if (authedCode === "401") {
    throw new Error(
      `the gateway rejected the ${discovery.source} key for "${deps.consumer}" — it is stale or revoked; ` +
        `re-mint with: obscura keys new ${deps.consumer} (after revoking the old entry)`,
    );
  }

  const connected = `connected as ${deps.consumer} · gateway healthy`;
  if (!opts.full) {
    out(ok(connected));
    return;
  }

  // 6 — opt-in stealth: appended ONLY on a passing gate; a red gate fails the full connect.
  if (!deps.stealth) throw new Error("--full requires the admin SSH config for the stealth gate");
  const green = await deps.stealth();
  if (green) {
    out(ok(`${connected} · stealth green`));
  } else {
    out(ok(connected));
    out(fail("stealth gate RED — the gateway is reachable but the 1/1 validate-stealth run failed"));
    throw new Error("connect --full: stealth gate failed");
  }
}
