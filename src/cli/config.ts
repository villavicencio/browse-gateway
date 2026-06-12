/**
 * Local fleet configuration (KTD8). Every fleet identifier — prod host, admin SSH destination,
 * consumer id, remote file paths — comes from a gitignored local file (`~/.config/obscura/
 * config.json`) or an `OBSCURA_*` env override. NOTHING fleet-specific is baked into committed
 * source; the only defaults here are protocol constants that are already public in this repo
 * (the gateway loopback host:port, the tunnel alias name, the container name).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ObscuraConfig {
  /** Admin SSH destination (alias or user@host) used by `keys` to mutate prod files. */
  adminSsh?: string;
  /** HostName for the generated tunnel ssh alias (the prod box, by whatever name the Mac resolves). */
  tunnelHostName?: string;
  /** The consumer id this Mac connects as (`connect` registers + verifies as this identity). */
  consumer?: string;
  /** Prod path to the non-secret consumers.json manifest. */
  remoteManifest?: string;
  /** Prod path to the `BGW_*` env file holding consumer tokens. */
  remoteEnvFile?: string;
  /** Gateway bind as the prod loopback sees it — also the Host header the rebind guard expects. */
  gatewayHost: string;
  /** ssh_config alias the tunnel artifacts are generated under. */
  tunnelAlias: string;
  /** Gateway container name on prod (for the activation check and the stealth gate). */
  container: string;
  /**
   * The on-host command `keys --apply` runs (over admin SSH) to RE-CREATE the gateway container.
   * It must re-read the env file and manifest — e.g. a wrapper around scripts/deploy/launch-http.sh.
   * A plain `docker restart` can NOT do this (container env is frozen at `docker run`), which is
   * why there is no default: without this key, `--apply` refuses rather than faking a reload.
   */
  applyCmd?: string;
  /** LaunchAgent label prefix for generated tunnel artifacts (reverse-DNS style). */
  labelPrefix: string;
  /**
   * Optional literal consumer token — a fallback discovery source for `connect` when the
   * Keychain has no copy (KTD4). The Keychain is the preferred home; this exists so a token can
   * also live in the gitignored config file or `OBSCURA_TOKEN`.
   */
  token?: string;
}

/** Keys that may appear in the config file, with their env override. */
const ENV_OVERRIDES = {
  adminSsh: "OBSCURA_ADMIN_SSH",
  tunnelHostName: "OBSCURA_TUNNEL_HOSTNAME",
  consumer: "OBSCURA_CONSUMER",
  remoteManifest: "OBSCURA_REMOTE_MANIFEST",
  remoteEnvFile: "OBSCURA_REMOTE_ENV_FILE",
  gatewayHost: "OBSCURA_GATEWAY_HOST",
  tunnelAlias: "OBSCURA_TUNNEL_ALIAS",
  container: "OBSCURA_CONTAINER",
  applyCmd: "OBSCURA_APPLY_CMD",
  labelPrefix: "OBSCURA_LABEL_PREFIX",
  token: "OBSCURA_TOKEN",
} as const satisfies Record<keyof ObscuraConfig, string>;

type ConfigKey = keyof typeof ENV_OVERRIDES;

/**
 * Protocol constants, not fleet values: every literal here is already public in this repo
 * (the label prefix appears verbatim in the committed HANDOFF's launchctl runbook — it leaks
 * nothing new, and defaulting to it lets ensureTunnel ADOPT the live hand-built LaunchAgent
 * instead of double-binding the port under a fresh label).
 */
const DEFAULTS: Pick<ObscuraConfig, "gatewayHost" | "tunnelAlias" | "container" | "labelPrefix"> = {
  gatewayHost: "127.0.0.1:8080",
  tunnelAlias: "browse-gateway-tunnel",
  container: "browse-gateway-http",
  labelPrefix: "com.dvillavicencio",
};

export function defaultConfigPath(): string {
  return join(homedir(), ".config", "obscura", "config.json");
}

/**
 * Load file + env into one config. A missing file is fine (env can carry everything); a malformed
 * or typo'd file is not — unknown keys and non-string values fail loudly rather than being
 * silently ignored into a half-configured CLI.
 */
export function loadObscuraConfig(
  env: Record<string, string | undefined> = process.env,
  path: string = defaultConfigPath(),
): ObscuraConfig {
  const fromFile: Partial<Record<ConfigKey, string>> = {};
  let text: string | undefined;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    // no config file — env may still provide everything required
  }
  if (text !== undefined) {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new Error(`obscura config ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`obscura config ${path} must be a JSON object`);
    }
    for (const [key, value] of Object.entries(raw)) {
      if (!(key in ENV_OVERRIDES)) {
        throw new Error(`obscura config ${path} has unknown key "${key}" (known: ${Object.keys(ENV_OVERRIDES).join(", ")})`);
      }
      if (typeof value !== "string" || !value.trim()) {
        throw new Error(`obscura config ${path} key "${key}" must be a non-empty string`);
      }
      fromFile[key as ConfigKey] = value;
    }
  }

  const config: ObscuraConfig = { ...DEFAULTS };
  for (const key of Object.keys(ENV_OVERRIDES) as ConfigKey[]) {
    // A set-but-blank env var falls through to the file value rather than masking it.
    const fromEnv = env[ENV_OVERRIDES[key]];
    const value = (fromEnv !== undefined && fromEnv.trim() ? fromEnv : undefined) ?? fromFile[key];
    if (value !== undefined && value.trim()) config[key] = value;
  }
  return config;
}

/**
 * Fetch a required key or fail with an error that names both the key and how to set it. Commands
 * call this for what they actually need, so `status` doesn't demand `connect`'s config.
 */
export function requireConfig<K extends ConfigKey>(
  config: ObscuraConfig,
  key: K,
): NonNullable<ObscuraConfig[K]> {
  const value = config[key];
  if (value === undefined || value === "") {
    throw new Error(
      `missing config "${key}" — set it in ${defaultConfigPath()} or env ${ENV_OVERRIDES[key]}`,
    );
  }
  return value;
}
