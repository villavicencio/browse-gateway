#!/usr/bin/env node
/**
 * `obscura` — the boutique front door over the browse-gateway plumbing. One command to mint a
 * consumer key (`keys`), one to connect a Mac to the gateway end-to-end (`connect`), one to read
 * the system's health at a glance (`status`). Dispatch only — each command lives in its module.
 */
import { parseCliArgs, usage } from "./args.js";
import type { Invocation } from "./args.js";
import { fail } from "./brand.js";
import { loadObscuraConfig, requireConfig } from "./config.js";
import type { ObscuraConfig } from "./config.js";
import { keysNew, keysList, keysRevoke, inspectConsumers } from "./keys.js";
import type { KeysDeps } from "./keys.js";
import { vaultStatus, vaultImport, vaultRevoke, vaultLogin } from "./vault.js";
import type { VaultDeps } from "./vault.js";
import { macKeychain } from "./keychain.js";
import { sshShell } from "./prod-ssh.js";
import { connect, sshStealthGate } from "./connect.js";
import type { ConnectDeps } from "./connect.js";
import { status } from "./status.js";
import type { StatusDeps } from "./status.js";
import { healthProbe } from "./verify.js";
import { tunnelSpec } from "./tunnel.js";

function keysDeps(): KeysDeps {
  const config = loadObscuraConfig();
  return {
    shell: sshShell(requireConfig(config, "adminSsh")),
    keychain: macKeychain(),
    manifestPath: requireConfig(config, "remoteManifest"),
    envFilePath: requireConfig(config, "remoteEnvFile"),
    container: config.container,
    gatewayHost: config.gatewayHost,
    ...(config.applyCmd ? { applyCmd: config.applyCmd } : {}),
    ...(config.smokeCmd ? { smokeCmd: config.smokeCmd } : {}),
    out: (line) => console.log(line),
  };
}

function onePositional(invocation: Invocation, what: string): string {
  const [id, ...extra] = invocation.positionals;
  if (id === undefined || extra.length > 0) {
    throw new Error(`obscura keys ${invocation.subcommand} takes exactly one ${what}`);
  }
  return id;
}

async function runConnect(invocation: Invocation): Promise<void> {
  const config = loadObscuraConfig();
  const spec = tunnelSpec({
    alias: config.tunnelAlias,
    hostName: requireConfig(config, "tunnelHostName"),
    gatewayHost: config.gatewayHost,
    labelPrefix: config.labelPrefix,
  });
  const deps: ConnectDeps = {
    consumer: requireConfig(config, "consumer"),
    spec,
    gatewayHost: config.gatewayHost,
    keychain: macKeychain(),
    ...(config.token ? { configToken: config.token } : {}),
    out: (line) => console.log(line),
    ...(invocation.flags.full
      ? { stealth: sshStealthGate(sshShell(requireConfig(config, "adminSsh")), config.container) }
      : {}),
  };
  await connect(deps, { full: invocation.flags.full });
}

async function runStatus(invocation: Invocation): Promise<void> {
  const config = loadObscuraConfig();
  const spec = tunnelSpec({
    alias: config.tunnelAlias,
    // status only READS state; the host name is needed solely when generating artifacts.
    hostName: config.tunnelHostName ?? "(unconfigured)",
    gatewayHost: config.gatewayHost,
    labelPrefix: config.labelPrefix,
  });
  const adminShell = config.adminSsh ? sshShell(config.adminSsh) : undefined;
  const { remoteManifest, remoteEnvFile } = config;
  const deps: StatusDeps = {
    spec,
    gatewayHost: config.gatewayHost,
    out: (line) => console.log(line),
    ...(adminShell && remoteManifest && remoteEnvFile
      ? {
          consumers: () =>
            inspectConsumers({ shell: adminShell, manifestPath: remoteManifest, envFilePath: remoteEnvFile }),
        }
      : {}),
    ...(invocation.flags.stealth
      ? { stealth: sshStealthGate(adminShell ?? sshShell(requireConfig(config, "adminSsh")), config.container) }
      : {}),
    // #53: the operator-token pool-health read, only when a healthToken is configured.
    ...(config.healthToken
      ? { poolHealth: healthProbe(spec.localPort, config.gatewayHost, config.healthToken) }
      : {}),
  };
  const report = await status(deps, { stealth: invocation.flags.stealth });
  if (!report.healthy) process.exitCode = 1;
}

function vaultDeps(config: ObscuraConfig): VaultDeps {
  return {
    shell: sshShell(requireConfig(config, "adminSsh")),
    container: config.container,
    out: (line) => console.log(line),
  };
}

async function runVault(invocation: Invocation): Promise<void> {
  const config = loadObscuraConfig();
  const deps = vaultDeps(config);
  const requireFlag = (name: "host" | "session" | "creds" | "recipe"): string => {
    const v = invocation.flags[name];
    if (v === undefined) throw new Error(`obscura vault ${invocation.subcommand} requires --${name}`);
    return v;
  };
  // The consumer defaults to the configured identity (this Mac usually operates as one consumer).
  const consumer = (): string => {
    const id = invocation.flags.consumer ?? config.consumer;
    if (id === undefined) throw new Error(`obscura vault ${invocation.subcommand} needs --consumer (or a configured "consumer")`);
    return id;
  };
  switch (invocation.subcommand) {
    case "status":
      return vaultStatus(deps);
    case "revoke":
      return vaultRevoke(deps, consumer(), requireFlag("host"));
    case "import":
      return vaultImport(deps, {
        consumerId: consumer(),
        host: requireFlag("host"),
        sessionPath: requireFlag("session"),
        credsPath: requireFlag("creds"),
        ...(invocation.flags.exit ? { exit: invocation.flags.exit } : {}),
      });
    case "login":
      return vaultLogin(deps, {
        consumerId: consumer(),
        host: requireFlag("host"),
        recipePath: requireFlag("recipe"),
        credsPath: requireFlag("creds"),
      });
    default:
      throw new Error("vault: missing subcommand");
  }
}

async function runKeys(invocation: Invocation): Promise<void> {
  const deps = keysDeps();
  switch (invocation.subcommand) {
    case "new":
      return keysNew(deps, onePositional(invocation, "consumer id"), {
        ...(invocation.flags.allow ? { allow: invocation.flags.allow } : {}),
        ...(invocation.flags.apply ? { apply: true } : {}),
      });
    case "list":
      await keysList(deps);
      return;
    case "revoke":
      return keysRevoke(deps, onePositional(invocation, "consumer id"), invocation.flags.apply ? { apply: true } : {});
    default:
      throw new Error("keys: missing subcommand");
  }
}

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (!parsed.ok) {
    if (parsed.error) console.error(fail(parsed.error));
    console.error(usage());
    process.exitCode = 1;
    return;
  }
  const { invocation } = parsed;
  switch (invocation.command) {
    case "keys":
      return runKeys(invocation);
    case "connect":
      return runConnect(invocation);
    case "status":
      return runStatus(invocation);
    case "vault":
      return runVault(invocation);
  }
}

main().catch((err) => {
  console.error(fail(err instanceof Error ? err.message : String(err)));
  process.exitCode = 1;
});
