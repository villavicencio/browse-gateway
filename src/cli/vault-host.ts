#!/usr/bin/env node
/**
 * On-host vault entrypoint (U8) — the half of `obscura vault` that runs INSIDE the gateway container,
 * invoked over admin SSH as `docker exec -i <container> node dist/cli/vault-host.js <sub> ...`. It runs
 * in the container's environment, so it inherits exactly the gateway's vault config (BGW_VAULT_DIR +
 * the 0600 BGW_VAULT_KEY_FILE) and consumer manifest — the master key never leaves the box.
 *
 * Surface (U8a — no browser): `status` (keyless listing), `import` (store a hand-captured session +
 * creds), `revoke` (crypto-shred). `login` (drive a capture through a Gateway) is U8b.
 *
 * Wire discipline:
 *  - Non-secret routing (subcommand, consumer, host, exit id) arrives on ARGV; secret material
 *    (the captured session + credentials) arrives ONLY on STDIN — it never hits a process table.
 *  - stdout carries a single JSON result line with NO secret material; all logging goes to stderr.
 *  - Every thrown error is redacted through the SecretStore before it crosses the SSH boundary back
 *    to the operator's Mac (the KEK + any BYO secret + the just-handled creds are all folded in).
 */
import { readFileSync } from "node:fs";
import {
  openVault,
  VaultStore,
  loadVaultKey,
  listVaultEntries,
  canonicalizeHost,
  SecretStore,
  redactSecrets,
} from "../security/index.js";
import { importLoginToVault, getVaultEntry, revokeVaultEntry } from "../mcp/vault-login.js";
import type { VaultEntry } from "../mcp/vault-login.js";
import { parseConsumerManifest } from "../policy/index.js";
import type { StorageState } from "../browser/index.js";
import type { LoginCredentials } from "../verbs/index.js";

const log = (msg: string): void => void process.stderr.write(`[obscura-vault-host] ${msg}\n`);

// One redaction sink for the whole process: the KEK + any BYO env secret fold in on vault open, and
// the handled creds fold in during import — so the `.catch` below scrubs an error raised at any stage.
const secrets = new SecretStore();

/** Read `--name value` / `--name=value` from a flat argv tail. Returns the LAST occurrence. */
function readArg(argv: string[], name: string): string | undefined {
  let found: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === `--${name}`) {
      found = argv[i + 1];
      i++;
    } else if (a?.startsWith(`--${name}=`)) {
      found = a.slice(name.length + 3);
    }
  }
  return found === "" ? undefined : found;
}

function requireArg(argv: string[], name: string): string {
  const v = readArg(argv, name);
  if (v === undefined) throw new Error(`vault-host: --${name} is required`);
  return v;
}

/** Read all of stdin (the secret payload) to a string. Resolves "" on an empty/EOF stream. */
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

/**
 * Guard against filing an entry for a consumer the gateway doesn't know (a dead entry that could
 * never be replayed) — mirror `keys`' manifest-first discipline. The manifest path is always set in
 * the gateway container; if it isn't (an off-box exec), warn and proceed rather than block.
 */
function assertConsumerKnown(env: NodeJS.ProcessEnv, consumerId: string): void {
  const path = env.BGW_CONSUMERS_MANIFEST;
  if (!path) {
    log("BGW_CONSUMERS_MANIFEST unset — skipping the consumer-exists check (cannot verify off-box)");
    return;
  }
  const entries = parseConsumerManifest(readFileSync(path, "utf8"));
  if (!entries.some((e) => e.id === consumerId)) {
    throw new Error(
      `vault-host: consumer "${consumerId}" is not in the manifest — add it first (obscura keys new ${consumerId}); ` +
        `a vault entry for an unknown consumer can never be replayed`,
    );
  }
}

/**
 * Re-open the just-written entry in a FRESH VaultStore built from a freshly-loaded key — proves the
 * on-disk file decrypts under the on-disk master key (the env-ref false-negative lesson: never trust
 * the writing instance's in-memory state to confirm a provision). Throws on any mismatch.
 */
function freshDecryptVerify(
  env: NodeJS.ProcessEnv,
  secrets: SecretStore,
  consumerId: string,
  host: string,
  written: VaultEntry,
): void {
  const dir = env.BGW_VAULT_DIR;
  const key = loadVaultKey(env);
  if (!dir || !key) throw new Error("vault-host: master key/dir vanished between write and verify");
  const fresh = new VaultStore({ kek: key, dir, canonicalizeHost, redact: (v) => secrets.addRedactable(v) });
  const got = getVaultEntry(fresh, consumerId, host);
  if (!got) throw new Error("vault-host: entry was not readable immediately after write (torn write?)");
  const reread = (got.session.cookies ?? []).length;
  const wrote = (written.session.cookies ?? []).length;
  if (reread !== wrote) throw new Error(`vault-host: re-read cookie count ${reread} != written ${wrote}`);
}

function emit(result: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function doStatus(env: NodeJS.ProcessEnv): Promise<void> {
  const dir = env.BGW_VAULT_DIR;
  if (!dir) {
    emit({ command: "status", ok: true, vaultEnabled: false, entries: [] });
    return;
  }
  const entries = listVaultEntries(dir); // keyless — never trips the boot guard
  let hasKey = false;
  let keyError: string | undefined;
  try {
    hasKey = loadVaultKey(env) !== null;
  } catch (e) {
    keyError = (e as Error).message; // a misconfigured key (bad perms/material) — surfaced, not thrown
  }
  emit({
    command: "status",
    ok: true,
    vaultEnabled: true,
    hasKey,
    ...(keyError ? { keyError } : {}),
    bootBlocked: entries.length > 0 && !hasKey, // gateway would refuse to boot in this state
    entries,
  });
}

async function doImport(env: NodeJS.ProcessEnv, argv: string[], vault: VaultStore, secrets: SecretStore): Promise<void> {
  const consumerId = requireArg(argv, "consumer");
  const host = requireArg(argv, "host");
  const exit = readArg(argv, "exit");

  const raw = await readStdin();
  if (!raw.trim()) throw new Error("vault-host: import expects a JSON payload {session, creds} on stdin");
  let payload: { session?: unknown; creds?: unknown };
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    throw new Error(`vault-host: import payload is not valid JSON: ${(e as Error).message}`);
  }
  const session = payload.session as StorageState | undefined;
  const creds = payload.creds as LoginCredentials | undefined;
  if (!session || typeof session !== "object") throw new Error("vault-host: import payload missing `session` (storageState JSON)");
  if (!creds || typeof creds.username !== "string" || typeof creds.password !== "string") {
    throw new Error("vault-host: import payload missing valid `creds` (username + password strings)");
  }
  // Fold the secret material into the redaction set BEFORE anything below can throw with it in scope.
  secrets.addRedactable([creds.username, creds.password, ...(creds.totpSeed ? [creds.totpSeed] : [])]);

  assertConsumerKnown(env, consumerId);
  const before = (session.cookies ?? []).length;
  // importLoginToVault validates the TOTP seed + strips IP-bound challenge cookies before sealing.
  const entry = importLoginToVault(vault, { consumerId, host, session, creds, ...(exit ? { stickyExitId: exit } : {}) });
  freshDecryptVerify(env, secrets, consumerId, host, entry);

  const cookieNames = (entry.session.cookies ?? []).map((c) => c.name);
  emit({
    command: "import",
    ok: true,
    consumerId,
    host,
    updatedAt: entry.updatedAt,
    cookieNames,
    strippedCount: before - cookieNames.length,
    bound: entry.stickyExitId !== undefined,
    verified: true,
  });
}

async function doRevoke(argv: string[], vault: VaultStore): Promise<void> {
  const consumerId = requireArg(argv, "consumer");
  const host = requireArg(argv, "host");
  const removed = revokeVaultEntry(vault, consumerId, host);
  emit({ command: "revoke", ok: true, removed });
}

async function main(): Promise<void> {
  const [sub, ...argv] = process.argv.slice(2);
  const env = process.env;

  if (sub === "status") {
    await doStatus(env);
    return;
  }

  // import/revoke need an open vault (the master key). openVault folds the KEK into the redaction set
  // and runs the fail-closed boot guard; null means dir-set-but-dormant or feature-off.
  if (!env.BGW_VAULT_DIR) {
    throw new Error("vault-host: the vault is not enabled on this gateway (BGW_VAULT_DIR is unset)");
  }
  const vault = openVault({ env, canonicalizeHost, redact: (v) => secrets.addRedactable(v) });
  if (!vault) {
    throw new Error("vault-host: the vault has no master key configured (set BGW_VAULT_KEY_FILE) — cannot store or shred entries");
  }

  switch (sub) {
    case "import":
      await doImport(env, argv, vault, secrets);
      return;
    case "revoke":
      await doRevoke(argv, vault);
      return;
    case "login":
      throw new Error("vault-host: `login` is not available yet (U8b) — use `import` for a hand-captured session");
    default:
      throw new Error(`vault-host: unknown subcommand "${sub ?? ""}" (status|import|revoke)`);
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  log(redactSecrets(message, secrets)); // never let a stored value / KEK / creds leak back over SSH
  process.exit(1);
});
