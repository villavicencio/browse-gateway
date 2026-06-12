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
  /** Gateway container name (for `--apply` and the restart instruction). */
  container: string;
  /** Gateway bind as prod loopback sees it — the `--apply` health probe target. */
  gatewayHost: string;
  out: (line: string) => void;
  /** Injectable for tests; defaults to a real sleep. */
  wait?: (ms: number) => Promise<void>;
}

const CONSUMER_ID_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const APPLY_TIMEOUT_MS = 60_000;
const APPLY_POLL_MS = 2_000;

/** Match this consumer's token line in the env file (with or without `export`). */
function tokenLineRe(envKey: string): RegExp {
  return new RegExp(`^(export[ \\t]+)?${envKey}=`, "m");
}

interface ProdFiles {
  entries: ConsumerManifestEntry[];
  envText: string;
}

/** Read + validate both prod files. Fail-loud on absence: the fleet always has them. */
async function readProdFiles(deps: KeysDeps): Promise<ProdFiles> {
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
  return `staged only — the gateway loads consumers at restart; re-run with --apply, or restart ${deps.container} on the host`;
}

/** Restart the gateway container and wait for /mcp to answer 401 again (the liveness signal). */
async function applyRestart(deps: KeysDeps): Promise<void> {
  const wait = deps.wait ?? sleep;
  deps.out(note(`restarting ${deps.container} — every consumer's session drops for ~10–20s while it recreates`));
  // Mirror launch-http.sh: default DOCKER_HOST to the rootless socket when the login shell lacks it.
  const restart = await deps.shell.run(
    `set -e; export DOCKER_HOST="\${DOCKER_HOST:-unix:///run/user/$(id -u)/docker.sock}"; docker restart ${shQuote(deps.container)} >/dev/null`,
  );
  if (restart.code !== 0) {
    throw new Error(`docker restart ${deps.container} failed (exit ${restart.code}): ${restart.stderr.trim()}`);
  }
  const deadline = Date.now() + APPLY_TIMEOUT_MS;
  for (;;) {
    const probe = await deps.shell.run(
      `curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://${deps.gatewayHost}/mcp || echo 000`,
    );
    if (probe.stdout.trim() === "401") {
      deps.out(ok("gateway healthy after restart"));
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`gateway did not come back healthy within ${APPLY_TIMEOUT_MS / 1000}s of the restart`);
    }
    await wait(APPLY_POLL_MS);
  }
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
  if (opts.apply) await applyRestart(deps);
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

/** Configured consumers — ids, scopes, and a token-present flag. Never a token value. */
export async function keysList(deps: KeysDeps): Promise<KeysListResult> {
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

  for (const c of consumers) {
    const tags = c.tags?.length ? `  tags=${c.tags.join(",")}` : "";
    deps.out(note(`${c.id}  allow=${c.allow.join(",")}  token=${c.tokenSet ? "set" : "MISSING"}${tags}`));
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
    const kept = envText.split("\n").filter((line) => !tokenLineRe(envKey).test(line));
    await writeRemoteFileAtomic(deps.shell, deps.envFilePath, kept.join("\n"), "0600");
  }
  await deps.keychain.remove(id);
  deps.out(ok(`revoked ${id}`));
  deps.out(note("the old token stays valid until the gateway restarts (static registry)"));
  if (opts.apply) await applyRestart(deps);
  else deps.out(note(restartInstruction(deps)));
}
