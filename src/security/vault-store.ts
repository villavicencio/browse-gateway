/**
 * Vault store (B1) — per-`(consumer, host)` encrypted entries on disk, sealed via the U3 envelope
 * crypto. Entries decrypt only in-process into the owning session; the store never logs a payload.
 *
 * Layout: one JSON file per entry, named by sha256 of an INJECTIVE length-prefixed encoding of
 * (canonicalHost, consumerId) — filesystem-safe, traversal-proof, and collision-free even if a field
 * contains odd bytes. The file carries the `(consumerId, host)` tuple in PLAINTEXT (neither is secret
 * — both are also in the record's AAD) so `list()`/`vault status` can enumerate without a key, plus
 * the sealed record. Security rides on the AAD binding inside the record, not on the filename or the
 * stored tuple: a swapped/misfiled file fails to open under the requested (consumer, host).
 *
 * Redaction: decrypted secret leaf values fold into the ever-loaded redaction set (sensitive-key
 * values fold even when short). The set is an idempotent Set, so re-reading an entry never grows it;
 * growth is bounded by the count of DISTINCT secret values across all entries (small for one operator).
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
import { sealJson, openJson, decodeMasterKey, assertSlotField, type SealedRecord } from "./vault-crypto.js";

const ENTRY_SUFFIX = ".vault.json";
/** Generic leaf values fold for redaction only inside this length window (skip noise + huge blobs). */
const REDACT_MIN = 8;
const REDACT_MAX = 4096;
/** Values under a sensitive-looking JSON key fold regardless of length (down to redactSecrets' 3-char floor). */
const REDACT_SENSITIVE_MIN = 3;
/** JSON keys whose values are credential-grade — fold them even when short (TOTP code, PIN, CVV, short password). */
const SENSITIVE_KEY = /pass|secret|token|totp|otp|pin|cvv|cvc|key|credential|cookie|auth|bearer/i;

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

/**
 * Collect string leaf values from a decrypted payload for redaction. Generic values fold within a
 * length window (skip noise + huge blobs); values under a SENSITIVE_KEY (password/totp/pin/cvv/…) fold
 * even when short, since a 6-digit code or 4-char PIN is exactly the kind of credential that must not
 * surface in a log — the plain length floor would silently drop it.
 */
function leafSecrets(value: unknown, out: Set<string>, sensitiveKey = false): void {
  if (typeof value === "string") {
    const min = sensitiveKey ? REDACT_SENSITIVE_MIN : REDACT_MIN;
    if (value.length >= min && value.length <= REDACT_MAX) out.add(value);
  } else if (Array.isArray(value)) {
    // An array inherits its key's sensitivity (e.g. `tokens: ["a","b"]`).
    for (const v of value) leafSecrets(v, out, sensitiveKey);
  } else if (value && typeof value === "object") {
    // Sensitivity RESETS per immediate key (a container key doesn't drag short siblings in). Two
    // sensitivity sources: a SENSITIVE_KEY name, OR the `value` of a `{name, value}` pair — the
    // storageState cookie/localStorage shape, whose value is credential-grade even when short (a 4-char
    // session token) while the sibling `name` ("sid") must NOT fold (it would over-redact ordinary logs).
    const isNameValuePair = "name" in value && "value" in value;
    for (const [k, v] of Object.entries(value)) {
      leafSecrets(v, out, SENSITIVE_KEY.test(k) || (isNameValuePair && k === "value"));
    }
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
    // Reject control chars (so the same slot validity rule governs the filename and the AAD), then
    // hash an INJECTIVE length-prefixed encoding — a plain `host \0 consumer` join would collide if a
    // field itself contained a NUL, silently overwriting another slot's entry.
    assertSlotField("consumerId", consumerId);
    assertSlotField("host", canonicalHost);
    const c = Buffer.from(consumerId, "utf8");
    const h = Buffer.from(canonicalHost, "utf8");
    const head = Buffer.alloc(8);
    head.writeUInt32BE(h.length, 0);
    head.writeUInt32BE(c.length, 4);
    const name = createHash("sha256").update(Buffer.concat([head, h, c])).digest("hex");
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
    return listVaultEntries(this.#dir);
  }
}

/**
 * Keyless enumeration of entries (consumer + host + freshness + size) from a vault dir — reads only
 * the PLAINTEXT lookup tuple + the file's mtime/size, never the sealed payload, so it needs no master
 * key. Backs `vault status` (which must list entries even when the key is absent/misconfigured, to
 * surface the fail-closed boot state instead of hiding it). A corrupt/foreign file is skipped rather
 * than crashing the listing. Sorted (consumer, host) for a stable display.
 */
export function listVaultEntries(dir: string): VaultEntryMeta[] {
  if (!existsSync(dir)) return [];
  const out: VaultEntryMeta[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(ENTRY_SUFFIX)) continue;
    const path = join(dir, name);
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

/**
 * Rotate the master key: re-seal every entry under `newKek` (decrypt with `oldKek`, encrypt afresh —
 * a new DEK + nonces per entry). After this returns, point BGW_VAULT_KEY_FILE at the new key; the old
 * key no longer opens anything. Returns the number of entries rotated.
 *
 * Two phases so a single bad entry can't leave a half-rotated split-brain vault: STRICTLY enumerate +
 * decrypt EVERY `*.vault.json` under `oldKek` FIRST — any file that won't parse or decrypt throws
 * before a single file is rewritten, so the old key still opens everything. This does NOT use `list()`
 * (which SKIPS malformed files for the lenient `vault status` path — rotation must not, or a corrupt
 * entry would be left behind under the old key while the rest flips). Only once the whole set is
 * verified do we re-seal in place. (Residual: a process crash during the write phase can leave a
 * partial rotation; re-run with the old key — already-flipped entries fail phase 1, surfacing it.)
 */
export function rotateVaultKey(
  dir: string,
  oldKek: Buffer,
  newKek: Buffer,
  canonicalizeHost: (host: string) => string,
): number {
  const files = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(ENTRY_SUFFIX)) : [];
  // Phase 1 — strict: parse + decrypt the specific file (via its stored tuple's AAD), no skipping.
  const decrypted = files.map((name) => {
    const raw = readFileSync(join(dir, name), "utf8");
    let file: { consumerId?: unknown; host?: unknown; record?: unknown };
    try {
      file = JSON.parse(raw);
    } catch (e) {
      throw new Error(`vault: ${name} is not valid JSON — refusing to rotate (${(e as Error).message})`);
    }
    if (typeof file.consumerId !== "string" || typeof file.host !== "string" || file.record == null) {
      throw new Error(`vault: ${name} is not a valid entry (missing consumerId/host/record) — refusing to rotate`);
    }
    // openJson throws on a malformed record, a wrong key, or an AAD mismatch — fail closed, no write yet.
    const value = openJson(file.record as SealedRecord, { kek: oldKek, consumerId: file.consumerId, host: file.host });
    return { consumerId: file.consumerId, host: file.host, value };
  });
  // Phase 2 — re-seal under the new key (pure) and write each in place (atomic temp + rename per file).
  const newStore = new VaultStore({ kek: newKek, dir, canonicalizeHost });
  for (const e of decrypted) newStore.put(e.consumerId, e.host, e.value);
  return decrypted.length;
}

/**
 * Count entries on disk without a key — used by the boot guard. Throws a clear error when BGW_VAULT_DIR
 * exists but isn't a readable directory (a file, a permission problem), so the caller fails closed with
 * a message instead of a raw ENOTDIR stack trace.
 */
export function countVaultEntries(dir: string): number {
  if (!existsSync(dir)) return 0;
  if (!statSync(dir).isDirectory()) throw new Error(`BGW_VAULT_DIR is not a directory: ${dir}`);
  return readdirSync(dir).filter((n) => n.endsWith(ENTRY_SUFFIX)).length;
}

/**
 * Load the master key: `BGW_VAULT_KEY_FILE` (a path to a base64 key, the recommended host-held form),
 * else `BGW_VAULT_KEY` (raw base64, a convenience fallback), else null (no key configured). Throws if
 * a configured key file is unreadable, NOT a regular file, GROUP/WORLD-ACCESSIBLE, or the material
 * isn't a 32-byte key — the boot guard turns that into a fail-closed boot when entries exist. The KEK
 * is the crown jewel; a 0644 file would expose it to any local user, so the perms are ENFORCED, not
 * just recommended (KTD-2: chmod 600).
 */
export function loadVaultKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const file = env.BGW_VAULT_KEY_FILE;
  if (file) {
    let st;
    try {
      st = statSync(file);
    } catch (e) {
      throw new Error(`BGW_VAULT_KEY_FILE not readable (${file}): ${(e as Error).message}`);
    }
    if (!st.isFile()) throw new Error(`BGW_VAULT_KEY_FILE is not a regular file: ${file}`);
    if (st.mode & 0o077) {
      const mode = (st.mode & 0o777).toString(8).padStart(3, "0");
      throw new Error(
        `BGW_VAULT_KEY_FILE is group/world-accessible (mode 0${mode}) — the vault master key must be ` +
          `owner-only. Run: chmod 600 ${file}`,
      );
    }
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
  let entryCount: number;
  try {
    entryCount = countVaultEntries(dir); // throws on a mis-set dir (a file / unreadable)
  } catch (e) {
    throw new Error(`vault: ${(e as Error).message} — refusing to boot (fix BGW_VAULT_DIR)`);
  }
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
