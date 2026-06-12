/**
 * `obscura keys new|list|revoke` (R3) — the admin key lifecycle, orchestrated over admin SSH
 * against the prod manifest (`consumers.json`) + env file pair.
 *
 * Write discipline (KTD9): every file lands atomically (temp + rename), and on `new` the
 * MANIFEST is written before the ENV file — an interrupt between the two leaves a
 * manifest-entry-without-token, which the gateway refuses to boot on (loud), never an
 * env-token-without-manifest (silent live credential). Mutations stage by default; the gateway
 * only reloads consumers at restart, so `--apply` restarts and waits healthy.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { parseConsumerManifest } from "../policy/consumer-config.js";
import type { ConsumerManifestEntry } from "../policy/consumer-config.js";
import { ok, fail, note } from "./brand.js";
import type { Keychain } from "./keychain.js";
import type { RemoteShell } from "./prod-ssh.js";
import { readRemoteFile, writeRemoteFileAtomic, shQuote } from "./prod-ssh.js";
import { mintToken, tokenEnvKey, envKeyCollision } from "./token.js";

export interface KeysDeps {
  shell: RemoteShell;
  keychain: Keychain;
  /** Prod path to consumers.json. */
  manifestPath: string;
  /** Prod path to the BGW_* env file. */
  envFilePath: string;
  /** Gateway container name (for the post-apply activation check). */
  container: string;
  /** Gateway bind as prod loopback sees it — the `--apply` health probe target. */
  gatewayHost: string;
  /**
   * On-host command that RE-CREATES the gateway container, re-reading env + manifest (config
   * `applyCmd`). `docker restart` is NOT a substitute: container env is frozen at `docker run`,
   * so a restarted gateway boots the new manifest against the old env and crash-loops on the
   * fail-closed missing-token check — downing every consumer. Absent → `--apply` refuses.
   */
  applyCmd?: string;
  out: (line: string) => void;
  /** Injectable for tests; defaults to a real sleep. */
  wait?: (ms: number) => Promise<void>;
  /** Test seam for the post-apply health deadline. */
  applyTimeoutMs?: number;
}

const CONSUMER_ID_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const APPLY_TIMEOUT_MS = 60_000;
const APPLY_POLL_MS = 2_000;
/** The re-create command itself gets a longer leash than the default ssh watchdog. */
const APPLY_CMD_TIMEOUT_MS = 120_000;

/** Match this consumer's token line in the env file (with or without `export`). */
function tokenLineRe(envKey: string): RegExp {
  return new RegExp(`^(export[ \\t]+)?${envKey}=`, "m");
}

/** The read-only slice of {@link KeysDeps} that consumer inspection needs (shared with status). */
export type ProdFilesDeps = Pick<KeysDeps, "shell" | "manifestPath" | "envFilePath">;

interface ProdFiles {
  entries: ConsumerManifestEntry[];
  envText: string;
}

/** Read + validate both prod files. Fail-loud on absence: the fleet always has them. */
async function readProdFiles(deps: ProdFilesDeps): Promise<ProdFiles> {
  const manifestText = await readRemoteFile(deps.shell, deps.manifestPath);
  if (manifestText === null) throw new Error(`remote manifest not found at ${deps.manifestPath}`);
  const envText = await readRemoteFile(deps.shell, deps.envFilePath);
  if (envText === null) throw new Error(`remote env file not found at ${deps.envFilePath}`);
  return { entries: parseConsumerManifest(manifestText), envText };
}

function manifestJson(entries: ConsumerManifestEntry[]): string {
  return `${JSON.stringify(entries, null, 2)}\n`;
}

function restartInstruction(deps: KeysDeps): string {
  return (
    "staged only — the gateway loads consumers when the container is RE-CREATED " +
    "(a plain `docker restart` keeps the old env); re-run with --apply once `applyCmd` is configured, " +
    "or re-create via your launch script on the host"
  );
}

/**
 * Re-create the gateway container via the operator's `applyCmd`, wait for /mcp to answer 401
 * (the liveness signal), then confirm the consumer's token env actually changed inside the new
 * container — liveness alone can't tell a real reload from a stale-env no-op.
 */
async function applyRecreate(deps: KeysDeps, expectEnvKey: { key: string; present: boolean }): Promise<void> {
  if (!deps.applyCmd) {
    throw new Error(
      "--apply needs the `applyCmd` config key (or OBSCURA_APPLY_CMD): the on-host command that re-creates " +
        "the gateway container re-reading env + manifest (e.g. your launch-http.sh wrapper). " +
        "A plain `docker restart` cannot activate env changes, so obscura refuses to fake it. " +
        "The change is staged — apply it manually or configure applyCmd and re-run.",
    );
  }
  const wait = deps.wait ?? sleep;
  deps.out(note(`re-creating ${deps.container} via applyCmd — every consumer's session drops for ~10–20s`));
  const recreate = await deps.shell.run(
    `set -e; export DOCKER_HOST="\${DOCKER_HOST:-unix:///run/user/$(id -u)/docker.sock}"; ${deps.applyCmd}`,
    undefined,
    { timeoutMs: APPLY_CMD_TIMEOUT_MS },
  );
  if (recreate.code !== 0) {
    throw new Error(`applyCmd failed (exit ${recreate.code}): ${recreate.stderr.trim() || recreate.stdout.trim()}`);
  }
  const timeoutMs = deps.applyTimeoutMs ?? APPLY_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const probe = await deps.shell.run(
      `curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://${shQuote(deps.gatewayHost)}/mcp || echo 000`,
    );
    if (probe.stdout.trim() === "401") break;
    if (Date.now() >= deadline) {
      throw new Error(`gateway did not come back healthy within ${timeoutMs / 1000}s of the re-create`);
    }
    await wait(APPLY_POLL_MS);
  }
  // Activation check: the env var must be present (new) / gone (revoke) INSIDE the container.
  // printenv's exit code carries the answer; the value never leaves the container.
  const check = await deps.shell.run(
    `export DOCKER_HOST="\${DOCKER_HOST:-unix:///run/user/$(id -u)/docker.sock}"; ` +
      `docker exec ${shQuote(deps.container)} printenv ${expectEnvKey.key} >/dev/null 2>&1`,
  );
  const isPresent = check.code === 0;
  if (isPresent !== expectEnvKey.present) {
    throw new Error(
      expectEnvKey.present
        ? `gateway is up but ${expectEnvKey.key} is NOT in the container env — applyCmd did not re-read the env file`
        : `gateway is up but ${expectEnvKey.key} is STILL in the container env — applyCmd did not re-read the env file`,
    );
  }
  deps.out(ok(`gateway healthy after re-create — ${expectEnvKey.key} ${expectEnvKey.present ? "active" : "retired"}`));
}

export interface KeysNewOptions {
  allow?: string[];
  apply?: boolean;
}

/** Mint + install a consumer key: manifest entry, env token, Keychain copy, token printed ONCE. */
export async function keysNew(deps: KeysDeps, id: string, opts: KeysNewOptions = {}): Promise<void> {
  if (!CONSUMER_ID_RE.test(id)) {
    throw new Error(`invalid consumer id "${id}" (letters, digits, ".", "_", "-"; must start alphanumeric)`);
  }
  const { entries, envText } = await readProdFiles(deps);
  if (entries.some((e) => e.id === id)) throw new Error(`consumer "${id}" already exists in the manifest`);
  const collision = envKeyCollision(id, entries.map((e) => e.id));
  if (collision) {
    throw new Error(`"${id}" collides with existing consumer "${collision}" on token env key ${tokenEnvKey(id)} — pick a more distinct id`);
  }
  const envKey = tokenEnvKey(id);
  if (tokenLineRe(envKey).test(envText)) {
    throw new Error(`env file already carries ${envKey} but "${id}" is not in the manifest — desync; resolve on the host before minting`);
  }

  const allow = opts.allow && opts.allow.length > 0 ? opts.allow : ["*"];
  const token = mintToken();

  // KTD9 ordering: manifest first. An interrupt here fails the next gateway boot loudly.
  await writeRemoteFileAtomic(deps.shell, deps.manifestPath, manifestJson([...entries, { id, allow }]), "0644");
  const envBase = envText.endsWith("\n") || envText === "" ? envText : `${envText}\n`;
  await writeRemoteFileAtomic(deps.shell, deps.envFilePath, `${envBase}export ${envKey}=${token}\n`, "0600");
  await deps.keychain.set(id, token);

  deps.out(ok(`minted key for ${id} (allow: ${allow.join(", ")})`));
  // Deliberately NOT through ok/note (they redact token shapes): shown once, by design.
  deps.out(`  ${token}`);
  deps.out(note("shown once — also stored in the macOS Keychain for `obscura connect`"));
  if (opts.apply) await applyRecreate(deps, { key: envKey, present: true });
  else deps.out(note(restartInstruction(deps)));
}

export interface KeysListEntry {
  id: string;
  allow: string[];
  tags?: string[];
  tokenSet: boolean;
}

export interface KeysListResult {
  consumers: KeysListEntry[];
  /** BGW_CONSUMER_TOKEN_* keys present in the env file with no manifest entry (desync). */
  orphanEnvKeys: string[];
}

/** Quiet consumer inspection — the data without the printing (status composes this too). */
export async function inspectConsumers(deps: ProdFilesDeps): Promise<KeysListResult> {
  const { entries, envText } = await readProdFiles(deps);
  const consumers = entries.map((e) => ({
    id: e.id,
    allow: e.allow,
    ...(e.tags ? { tags: e.tags } : {}),
    tokenSet: tokenLineRe(tokenEnvKey(e.id)).test(envText),
  }));
  const knownKeys = new Set(entries.map((e) => tokenEnvKey(e.id)));
  const orphanEnvKeys = [...envText.matchAll(/^(?:export[ \t]+)?(BGW_CONSUMER_TOKEN_[A-Z0-9_]+)=/gm)]
    .map((m) => m[1])
    .filter((k): k is string => k !== undefined && !knownKeys.has(k));
  return { consumers, orphanEnvKeys };
}

/** One consumer as a display line — id, scope, token-present flag, never a token value. */
export function formatConsumerLine(c: KeysListEntry, prefix = ""): string {
  const tags = c.tags?.length ? `  tags=${c.tags.join(",")}` : "";
  return `${prefix}${c.id}  allow=${c.allow.join(",")}  token=${c.tokenSet ? "set" : "MISSING"}${tags}`;
}

/** Configured consumers — ids, scopes, and a token-present flag. Never a token value. */
export async function keysList(deps: KeysDeps): Promise<KeysListResult> {
  const { consumers, orphanEnvKeys } = await inspectConsumers(deps);

  for (const c of consumers) {
    deps.out(note(formatConsumerLine(c)));
  }
  for (const orphan of orphanEnvKeys) {
    deps.out(fail(`env token ${orphan} has no manifest entry (desync) — revoke or re-add it`));
  }
  if (consumers.length === 0) deps.out(note("no consumers configured"));
  return { consumers, orphanEnvKeys };
}

export interface KeysRevokeOptions {
  apply?: boolean;
}

/**
 * Remove a consumer from both files (manifest first — revocation lands even if interrupted;
 * the leftover env line is the harmless side and `list` reports it). A one-sided desync is
 * reported explicitly and then fully cleaned, never silently half-removed.
 */
export async function keysRevoke(deps: KeysDeps, id: string, opts: KeysRevokeOptions = {}): Promise<void> {
  const { entries, envText } = await readProdFiles(deps);
  const envKey = tokenEnvKey(id);
  const inManifest = entries.some((e) => e.id === id);
  const inEnv = tokenLineRe(envKey).test(envText);
  if (!inManifest && !inEnv) throw new Error(`unknown consumer "${id}" (not in the manifest, no ${envKey} in the env file)`);
  // Reverse of keysNew's collision guard: an id that merely NORMALIZES onto another consumer's
  // env key must not delete that consumer's token (which would brick the next gateway boot).
  if (!inManifest && inEnv) {
    const aliasOf = envKeyCollision(id, entries.map((e) => e.id));
    if (aliasOf) {
      throw new Error(`"${id}" is not a consumer, but env key ${envKey} belongs to "${aliasOf}" — did you mean: obscura keys revoke ${aliasOf}?`);
    }
  }
  if (inManifest !== inEnv) {
    deps.out(
      fail(
        `desync: "${id}" was ${inManifest ? "in the manifest with no env token" : `only an env token (${envKey}) with no manifest entry`} — removing what exists`,
      ),
    );
  }
  if (inManifest) {
    await writeRemoteFileAtomic(deps.shell, deps.manifestPath, manifestJson(entries.filter((e) => e.id !== id)), "0644");
  }
  if (inEnv) {
    const lineRe = tokenLineRe(envKey);
    const kept = envText.split("\n").filter((line) => !lineRe.test(line));
    await writeRemoteFileAtomic(deps.shell, deps.envFilePath, kept.join("\n"), "0600");
  }
  await deps.keychain.remove(id);
  deps.out(ok(`revoked ${id}`));
  deps.out(note("the old token stays valid until the gateway is re-created (static registry)"));
  if (opts.apply) await applyRecreate(deps, { key: envKey, present: false });
  else deps.out(note(restartInstruction(deps)));
}
