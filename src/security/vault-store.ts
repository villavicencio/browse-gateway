/**
 * Vault store (B1) — per-`(consumer, host)` encrypted entries on disk, sealed via the U3 envelope
 * crypto. Entries decrypt only in-process into the owning session; the store never logs a payload.
 *
 * Layout: one JSON file per entry, named by `sha256(canonicalHost \0 consumerId)` so the filename is
 * filesystem-safe and traversal-proof. The file carries the `(consumerId, host)` tuple in PLAINTEXT
 * (neither is secret — both are also in the record's AAD) so `list()`/`vault status` can enumerate
 * without a key, plus the sealed record. Security rides on the AAD binding inside the record, not on
 * the filename or the stored tuple: a swapped/misfiled file fails to open under the requested
 * (consumer, host) because its tag won't verify.
 *
 * Master key: host-held key FILE (`BGW_VAULT_KEY_FILE`, chmod 600), or a raw base64 key in
 * `BGW_VAULT_KEY` as a fallback. On a single box the blast radius is irreducible (the process must
 * reach the key to decrypt unattended); we optimize exposure + rotation, not an illusory reduction.
 * Boot guard (fail closed): if entries exist on disk but no key loads, the gateway refuses to boot.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { sealJson, openJson, decodeMasterKey, type SealedRecord } from "./vault-crypto.js";

const ENTRY_SUFFIX = ".vault.json";
/** Length window for folding a decrypted leaf value into the redaction set (skip noise + huge blobs). */
const REDACT_MIN = 8;
const REDACT_MAX = 4096;

/** What lands on disk per entry: the plaintext lookup tuple + the sealed payload. */
interface EntryFile {
  consumerId: string;
  host: string;
  record: SealedRecord;
}

/** Listing metadata — never includes payload material (no decryption needed). */
export interface VaultEntryMeta {
  consumerId: string;
  host: string;
  updatedAt: number;
  bytes: number;
}

export interface VaultStoreOptions {
  /** 32-byte master key (KEK). */
  kek: Buffer;
  /** Directory holding the encrypted entries (created 0700 if absent). */
  dir: string;
  /** Single source of truth for host keys — share the gateway's canonicalizeHost. */
  canonicalizeHost: (host: string) => string;
  /** Fold decrypted secret values into the ever-loaded redaction set (e.g. SecretStore.addRedactable). */
  redact?: (values: Iterable<string>) => void;
}

/** Collect string leaf values from an arbitrary decrypted payload, length-filtered, for redaction. */
function leafSecrets(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    if (value.length >= REDACT_MIN && value.length <= REDACT_MAX) out.add(value);
  } else if (Array.isArray(value)) {
    for (const v of value) leafSecrets(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) leafSecrets(v, out);
  }
}

export class VaultStore {
  readonly #kek: Buffer;
  readonly #dir: string;
  readonly #canon: (host: string) => string;
  readonly #redact?: (values: Iterable<string>) => void;

  constructor(opts: VaultStoreOptions) {
    this.#kek = opts.kek;
    this.#dir = opts.dir;
    this.#canon = opts.canonicalizeHost;
    this.#redact = opts.redact;
  }

  #fileFor(consumerId: string, canonicalHost: string): string {
    const name = createHash("sha256").update(`${canonicalHost}\0${consumerId}`).digest("hex");
    return join(this.#dir, `${name}${ENTRY_SUFFIX}`);
  }

  #foldRedaction(value: unknown): void {
    if (!this.#redact) return;
    const secrets = new Set<string>();
    leafSecrets(value, secrets);
    if (secrets.size) this.#redact(secrets);
  }

  /** Seal `value` for `(consumerId, host)` and write it atomically (temp + rename, 0600). */
  put(consumerId: string, host: string, value: unknown): void {
    const ch = this.#canon(host);
    const record = sealJson(value, { kek: this.#kek, consumerId, host: ch });
    const file: EntryFile = { consumerId, host: ch, record };
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    const target = this.#fileFor(consumerId, ch);
    const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(file)}\n`, { mode: 0o600 });
    renameSync(tmp, target); // atomic publish — no torn file is ever visible
    this.#foldRedaction(value);
  }

  /** Decrypt the entry for `(consumerId, host)`, or null if absent. Throws (fail closed) on any
   * authentication failure — wrong key, tampering, or a misfiled record sealed for another slot. */
  get<T = unknown>(consumerId: string, host: string): T | null {
    const ch = this.#canon(host);
    const target = this.#fileFor(consumerId, ch);
    if (!existsSync(target)) return null;
    const file = JSON.parse(readFileSync(target, "utf8")) as EntryFile;
    // AAD binds to the REQUESTED (consumerId, ch) — a swapped file fails here, not on the stored tuple.
    const value = openJson<T>(file.record, { kek: this.#kek, consumerId, host: ch });
    this.#foldRedaction(value);
    return value;
  }

  /** True if an entry exists for the tuple (no decryption). */
  has(consumerId: string, host: string): boolean {
    return existsSync(this.#fileFor(consumerId, this.#canon(host)));
  }

  /** Crypto-shred an entry: deleting the file drops the wrapped DEK, making the payload unrecoverable. */
  remove(consumerId: string, host: string): boolean {
    const target = this.#fileFor(consumerId, this.#canon(host));
    if (!existsSync(target)) return false;
    unlinkSync(target);
    return true;
  }

  /** Enumerate entries (consumer + host + freshness) WITHOUT decrypting — backs `vault status`. */
  list(): VaultEntryMeta[] {
    if (!existsSync(this.#dir)) return [];
    const out: VaultEntryMeta[] = [];
    for (const name of readdirSync(this.#dir)) {
      if (!name.endsWith(ENTRY_SUFFIX)) continue;
      const path = join(this.#dir, name);
      try {
        const file = JSON.parse(readFileSync(path, "utf8")) as EntryFile;
        const st = statSync(path);
        out.push({ consumerId: file.consumerId, host: file.host, updatedAt: st.mtimeMs, bytes: st.size });
      } catch {
        // A corrupt/foreign file in the dir is skipped from listings rather than crashing status.
      }
    }
    return out.sort((a, b) => a.consumerId.localeCompare(b.consumerId) || a.host.localeCompare(b.host));
  }
}

/**
 * Rotate the master key: re-seal every entry under `newKek` (decrypt with `oldKek`, encrypt afresh —
 * a new DEK + nonces per entry). After this returns, point BGW_VAULT_KEY_FILE at the new key; the old
 * key no longer opens anything. Returns the number of entries rotated. Throws (and leaves the dir
 * untouched past the last successful write) if any entry fails to decrypt under `oldKek`.
 */
export function rotateVaultKey(
  dir: string,
  oldKek: Buffer,
  newKek: Buffer,
  canonicalizeHost: (host: string) => string,
): number {
  const store = new VaultStore({ kek: oldKek, dir, canonicalizeHost });
  const next = new VaultStore({ kek: newKek, dir, canonicalizeHost });
  let n = 0;
  for (const meta of store.list()) {
    const value = store.get(meta.consumerId, meta.host); // throws under a wrong oldKek (fail closed)
    next.put(meta.consumerId, meta.host, value);
    n++;
  }
  return n;
}

/** Count entries on disk without a key — used by the boot guard. */
export function countVaultEntries(dir: string): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((n) => n.endsWith(ENTRY_SUFFIX)).length;
}

/**
 * Load the master key: `BGW_VAULT_KEY_FILE` (a path to a base64 key, the recommended host-held form),
 * else `BGW_VAULT_KEY` (raw base64, a convenience fallback), else null (no key configured). Throws if
 * a configured key file is unreadable or the material isn't a 32-byte key — the boot guard turns that
 * into a fail-closed boot when entries exist.
 */
export function loadVaultKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const file = env.BGW_VAULT_KEY_FILE;
  if (file) {
    let contents: string;
    try {
      contents = readFileSync(file, "utf8");
    } catch (e) {
      throw new Error(`BGW_VAULT_KEY_FILE not readable (${file}): ${(e as Error).message}`);
    }
    return decodeMasterKey(contents);
  }
  const raw = env.BGW_VAULT_KEY;
  if (raw) return decodeMasterKey(raw);
  return null;
}

/**
 * Boot guard (pure): refuse to boot when encrypted entries exist but the master key didn't load — so
 * a vault can never be silently bypassed by removing/forgetting its key. Mirrors poolSizingError's
 * shape (pure fn → string|null, thrown at the launcher).
 */
export function vaultKeyBootError(entryCount: number, hasKey: boolean, keyError?: string): string | null {
  if (keyError) {
    return `vault: ${entryCount} encrypted entr${entryCount === 1 ? "y" : "ies"} on disk but the master key failed to load: ${keyError}`;
  }
  if (entryCount > 0 && !hasKey) {
    return (
      `vault: ${entryCount} encrypted entr${entryCount === 1 ? "y" : "ies"} on disk but no master key configured ` +
      `(set BGW_VAULT_KEY_FILE) — refusing to boot so the vault can't be silently bypassed`
    );
  }
  return null;
}

export interface OpenVaultDeps {
  env?: NodeJS.ProcessEnv;
  canonicalizeHost: (host: string) => string;
  redact?: (values: Iterable<string>) => void;
}

/**
 * Resolve the vault from env at boot. `BGW_VAULT_DIR` unset → feature off (null). Set → run the boot
 * guard, then return a ready store (key present) or null (dir set, no key, no entries → dormant).
 * Folds the loaded key into the redaction set so it can never surface in a log.
 */
export function openVault(deps: OpenVaultDeps): VaultStore | null {
  const env = deps.env ?? process.env;
  const dir = env.BGW_VAULT_DIR;
  if (!dir) return null;
  const entryCount = countVaultEntries(dir);
  let key: Buffer | null = null;
  let keyError: string | undefined;
  try {
    key = loadVaultKey(env);
  } catch (e) {
    keyError = (e as Error).message;
  }
  const guard = vaultKeyBootError(entryCount, key !== null, keyError);
  if (guard) throw new Error(guard);
  if (!key) return null; // dir set, no key, no entries → dormant; nothing to protect yet
  deps.redact?.([key.toString("base64")]); // the KEK must never surface in a log/audit/error
  return new VaultStore({ kek: key, dir, canonicalizeHost: deps.canonicalizeHost, redact: deps.redact });
}
