/**
 * `obscura vault status|import|revoke` (U8) — the Mac-side half of the vault front door. It owns NO
 * crypto and NO browser: it marshals a request, ships it over the admin-SSH spine to the on-host
 * entrypoint (`docker exec -i <container> node dist/cli/vault-host.js …`, which runs in the gateway's
 * environment with the master key the operator's Mac never sees), and renders the JSON result.
 *
 * Wire discipline (mirrors `keys`/`writeRemoteFileAtomic`): secret material (the captured session +
 * credentials) travels on STDIN, never in the SSH command line / argv — only non-secret routing
 * (consumer, host, sticky-exit id) is interpolated into the script, and those are shQuote'd.
 */
import { readFileSync } from "node:fs";
import { ok, fail, note } from "./brand.js";
import type { RemoteShell } from "./prod-ssh.js";
import { shQuote } from "./prod-ssh.js";

/** Dockerfile WORKDIR + the built entrypoint inside the image — protocol constants, already public. */
const VAULT_HOST_WORKDIR = "/app";
const VAULT_HOST_ENTRY = "dist/cli/vault-host.js";
/** A vault op is a single docker-exec round-trip; give it a generous leash over the default ssh watchdog. */
const VAULT_EXEC_TIMEOUT_MS = 60_000;
/** `login` drives a real browser on-host (navigate + assisted login + 2FA + possible proxy retries) — far longer. */
const LOGIN_EXEC_TIMEOUT_MS = 180_000;

export interface VaultDeps {
  shell: RemoteShell;
  /** Gateway container name to `docker exec` into. */
  container: string;
  out: (line: string) => void;
  /** Read a local file (creds/session JSON); injectable for tests. Defaults to fs.readFileSync. */
  readLocalFile?: (path: string) => string;
  timeoutMs?: number;
}

/** Build the on-host script: set rootless DOCKER_HOST, then exec the entrypoint with non-secret flags. */
function execScript(deps: VaultDeps, sub: string, flags: Record<string, string | undefined>): string {
  const flagArgs = Object.entries(flags)
    .filter((pair): pair is [string, string] => pair[1] !== undefined)
    .map(([k, v]) => `--${k} ${shQuote(v)}`)
    .join(" ");
  return [
    `export DOCKER_HOST="\${DOCKER_HOST:-unix:///run/user/$(id -u)/docker.sock}"`,
    `exec docker exec -i -w ${shQuote(VAULT_HOST_WORKDIR)} ${shQuote(deps.container)} ` +
      `node ${shQuote(VAULT_HOST_ENTRY)} ${shQuote(sub)} ${flagArgs}`.trimEnd(),
  ].join("\n");
}

/** Run the entrypoint and return its parsed JSON result. stdout is the result; logs go to stderr. */
async function runHost(
  deps: VaultDeps,
  sub: string,
  flags: Record<string, string | undefined>,
  stdin?: string,
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  const r = await deps.shell.run(execScript(deps, sub, flags), stdin, { timeoutMs: timeoutMs ?? deps.timeoutMs ?? VAULT_EXEC_TIMEOUT_MS });
  if (r.code !== 0) {
    throw new Error(`vault ${sub} failed (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim() || "no output from the on-host entrypoint"}`);
  }
  // stderr carries the entrypoint's logs; stdout is the single JSON result line.
  const line = r.stdout.trim().split("\n").filter(Boolean).pop();
  if (!line) throw new Error(`vault ${sub}: the on-host entrypoint returned no result`);
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    throw new Error(`vault ${sub}: unparseable result from the on-host entrypoint: ${line}`);
  }
}

interface VaultEntryMetaView {
  consumerId: string;
  host: string;
  updatedAt: number;
  bytes: number;
}

/** List stored entries (consumer + host + freshness). Never prints secret material. */
export async function vaultStatus(deps: VaultDeps): Promise<void> {
  const res = await runHost(deps, "status", {});
  if (res.vaultEnabled !== true) {
    deps.out(note("vault is not enabled on this gateway (BGW_VAULT_DIR is unset)"));
    return;
  }
  const entries = (res.entries as VaultEntryMetaView[]) ?? [];
  if (res.bootBlocked) {
    deps.out(fail(`${entries.length} encrypted entr${entries.length === 1 ? "y" : "ies"} on disk but NO master key — the gateway will refuse to boot (set BGW_VAULT_KEY_FILE)`));
  } else if (res.hasKey !== true) {
    deps.out(note("vault dir is set but no master key is loaded yet (dormant — set BGW_VAULT_KEY_FILE to activate)"));
  }
  if (typeof res.keyError === "string") deps.out(fail(`vault key problem: ${res.keyError}`));
  if (entries.length === 0) {
    deps.out(note("no stored login entries"));
    return;
  }
  for (const e of entries) {
    deps.out(note(`${e.consumerId}  ${e.host}  updated=${new Date(e.updatedAt).toISOString()}  ${e.bytes}B`));
  }
}

/** Crypto-shred a stored entry by dropping its sealed file (the wrapped DEK goes with it). */
export async function vaultRevoke(deps: VaultDeps, consumerId: string, host: string): Promise<void> {
  const res = await runHost(deps, "revoke", { consumer: consumerId, host });
  if (res.removed === true) deps.out(ok(`crypto-shredded the vault entry for ${consumerId} @ ${host}`));
  else deps.out(note(`no vault entry for ${consumerId} @ ${host} — nothing to shred`));
}

export interface VaultImportArgs {
  consumerId: string;
  host: string;
  /** Local path to the captured storageState JSON. */
  sessionPath: string;
  /** Local path to the credentials JSON ({username, password, totpSeed?}). */
  credsPath: string;
  /** Optional sticky-exit id to bind the imported session to (warm replay re-pins it). */
  exit?: string;
}

/**
 * Store an operator-provided session + creds. The two local files are read on the Mac, validated, and
 * shipped as ONE JSON payload over stdin — never on the command line. The on-host entrypoint strips
 * IP-bound challenge cookies and verifies the entry decrypts in a fresh instance before reporting.
 */
export async function vaultImport(deps: VaultDeps, args: VaultImportArgs): Promise<void> {
  const read = deps.readLocalFile ?? ((p: string) => readFileSync(p, "utf8"));
  let session: unknown;
  let creds: { username?: unknown; password?: unknown };
  try {
    session = JSON.parse(read(args.sessionPath));
  } catch (e) {
    throw new Error(`--session ${args.sessionPath}: not readable as JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  try {
    creds = JSON.parse(read(args.credsPath));
  } catch (e) {
    throw new Error(`--creds ${args.credsPath}: not readable as JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  if (typeof creds.username !== "string" || typeof creds.password !== "string") {
    throw new Error(`--creds ${args.credsPath}: must contain string "username" and "password" fields`);
  }
  const payload = JSON.stringify({ session, creds });
  const res = await runHost(
    deps,
    "import",
    { consumer: args.consumerId, host: args.host, ...(args.exit ? { exit: args.exit } : {}) },
    payload,
  );
  const cookieNames = (res.cookieNames as string[]) ?? [];
  deps.out(
    ok(
      `imported login for ${res.consumerId} @ ${res.host} — ${cookieNames.length} durable cookie(s), ` +
        `${res.strippedCount ?? 0} IP-bound stripped, decrypt-verified`,
    ),
  );
  if (res.bound === true) deps.out(note("bound to a sticky exit — warm replay re-pins the same residential IP"));
}

export interface VaultLoginArgs {
  consumerId: string;
  host: string;
  /** Local path to the login recipe JSON (selectors + success condition). */
  recipePath: string;
  /** Local path to the credentials JSON ({username, password, totpSeed?}). */
  credsPath: string;
}

/**
 * Capture a live login on-host into the vault. The recipe + creds are read on the Mac, validated, and
 * shipped as ONE JSON payload over stdin (never the command line); the on-host runner drives a real
 * browser (direct-first, escalating to a residential exit only on a block), captures the
 * authenticated session, strips IP-bound tokens, and seals it. A longer watchdog covers the live
 * browser flow; the second headful Chrome is transient (operator runs this at low load).
 */
export async function vaultLogin(deps: VaultDeps, args: VaultLoginArgs): Promise<void> {
  const read = deps.readLocalFile ?? ((p: string) => readFileSync(p, "utf8"));
  let recipe: Record<string, unknown>;
  let creds: { username?: unknown; password?: unknown };
  try {
    recipe = JSON.parse(read(args.recipePath));
  } catch (e) {
    throw new Error(`--recipe ${args.recipePath}: not readable as JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  try {
    creds = JSON.parse(read(args.credsPath));
  } catch (e) {
    throw new Error(`--creds ${args.credsPath}: not readable as JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  // Validate locally for fast feedback before a ~minute-long on-host capture (the runner re-checks too).
  for (const field of ["loginUrl", "usernameField", "passwordField", "submit"]) {
    if (typeof recipe[field] !== "string" || !recipe[field]) {
      throw new Error(`--recipe ${args.recipePath}: missing the "${field}" selector`);
    }
  }
  if (!recipe.successText && !recipe.successSelector) {
    throw new Error(`--recipe ${args.recipePath}: needs a success condition (successText or successSelector)`);
  }
  if (typeof creds.username !== "string" || typeof creds.password !== "string") {
    throw new Error(`--creds ${args.credsPath}: must contain string "username" and "password" fields`);
  }
  const payload = JSON.stringify({ recipe, creds });
  deps.out(note("capturing the login on-host — launches a second headful Chrome in the gateway container for ~10–40s (run when gateway load is low)"));
  const res = await runHost(deps, "login", { consumer: args.consumerId, host: args.host }, payload, LOGIN_EXEC_TIMEOUT_MS);
  const cookieNames = (res.cookieNames as string[]) ?? [];
  deps.out(ok(`captured login for ${res.consumerId} @ ${res.host} — ${cookieNames.length} durable cookie(s), decrypt-verified`));
  if (res.escalated === true) {
    deps.out(note("escalated past a block to a residential exit — entry bound to that sticky exit (warm replay re-pins it)"));
  } else {
    deps.out(note("captured on the direct datacenter exit (no proxy needed) — warm replay stays direct"));
  }
}
