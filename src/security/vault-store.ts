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
  lstatSync,
} from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { sealJson, openJson, decodeMasterKey, assertSlotField, type SealedRecord } from "./vault-crypto.js";

const ENTRY_SUFFIX = ".vault.json";
/** Generic leaf values fold for redaction only inside this length window (skip noise + huge blobs). */
const REDACT_MIN = 8;
const REDACT_MAX = 4096;
/** A credential-grade value (under a SENSITIVE_KEY, or a `{name,value}` pair's value) folds across a
 *  WIDER window than a generic leaf: down to 3 chars (a TOTP/PIN the generic floor would drop) AND up to
 *  REDACT_SENSITIVE_MAX — covering a long JWT / big session cookie the generic 4KB blob-guard would drop.
 *  A credential-grade value LARGER than the ceiling is NOT silently dropped from redaction (that would
 *  leave an unredactable secret in the payload): `put` REFUSES to persist such an entry (audit #4), so a
 *  stored credential is always redactable. The ceiling both admits every realistic credential and bounds
 *  each folded value's length, keeping redactSecrets' O(set) per-call cost in check. */
const REDACT_SENSITIVE_MIN = 3;
const REDACT_SENSITIVE_MAX = 65536;
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

/** Result of scanning a payload's string leaves for redaction folding. `oversized` counts credential-
 *  grade values too large to fold (> REDACT_SENSITIVE_MAX); `put` refuses to persist any such entry so
 *  an unredactable secret is never silently stored (audit #4). */
interface LeafScan {
  redactable: Set<string>;
  oversized: number;
}

/**
 * Scan the string leaf values of a decrypted payload for redaction. Generic values fold within a length
 * window (skip noise + huge blobs). A credential-grade value — under a SENSITIVE_KEY
 * (password/totp/pin/cvv/…), or the `value` of a `{name,value}` pair (the storageState cookie/localStorage
 * shape) — folds across a WIDER window: down to 3 chars (a 6-digit code / 4-char PIN the generic floor
 * would drop) and up to REDACT_SENSITIVE_MAX. A credential-grade value BEYOND that ceiling is NOT added
 * to the set AND is counted in `oversized` — never silently dropped: the caller (`put`) refuses to
 * persist it rather than store a secret it cannot guarantee is redactable.
 */
function scanLeaves(value: unknown): LeafScan {
  const redactable = new Set<string>();
  let oversized = 0;
  const walk = (v: unknown, sensitive: boolean): void => {
    if (typeof v === "string") {
      if (sensitive) {
        if (v.length < REDACT_SENSITIVE_MIN) return; // too short to be a distinguishable secret
        if (v.length > REDACT_SENSITIVE_MAX) {
          oversized++; // an unredactable credential-grade leaf → put() will refuse the whole entry
          return;
        }
        redactable.add(v);
      } else if (v.length >= REDACT_MIN && v.length <= REDACT_MAX) {
        redactable.add(v);
      }
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, sensitive); // an array inherits its key's sensitivity (e.g. tokens: [...])
    } else if (v && typeof v === "object") {
      // Sensitivity RESETS per immediate key (a container key doesn't drag short siblings in). The
      // sibling `name` of a `{name,value}` pair must NOT fold (it would over-redact ordinary logs);
      // only its `value` is credential-grade.
      const isNameValuePair = "name" in v && "value" in v;
      for (const [k, val] of Object.entries(v)) {
        walk(val, SENSITIVE_KEY.test(k) || (isNameValuePair && k === "value"));
      }
    }
  };
  walk(value, false);
  return { redactable, oversized };
}

/**
 * The canonical on-disk filename for a `(consumerId, canonicalHost)` slot. Rejects control chars (so the
 * same slot-validity rule governs the filename and the AAD), then hashes an INJECTIVE length-prefixed
 * encoding — a plain `host \0 consumer` join would collide if a field contained a NUL, silently
 * overwriting another slot. Shared by the store's writes AND {@link rotateVaultKey}'s every-file
 * canonical-path check (so a copied/duplicate entry can't survive rotation under the old key).
 */
export function slotFileName(dir: string, consumerId: string, canonicalHost: string): string {
  assertSlotField("consumerId", consumerId);
  assertSlotField("host", canonicalHost);
  const c = Buffer.from(consumerId, "utf8");
  const h = Buffer.from(canonicalHost, "utf8");
  const head = Buffer.alloc(8);
  head.writeUInt32BE(h.length, 0);
  head.writeUInt32BE(c.length, 4);
  const name = createHash("sha256").update(Buffer.concat([head, h, c])).digest("hex");
  return join(dir, `${name}${ENTRY_SUFFIX}`);
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
    return slotFileName(this.#dir, consumerId, canonicalHost);
  }

  /** Fold a payload's foldable leaf values into the redaction set (best-effort; no-op without a hook). */
  #fold(scan: LeafScan): void {
    if (this.#redact && scan.redactable.size) this.#redact(scan.redactable);
  }

  /**
   * Seal `value` for `(consumerId, host)` and write it atomically (temp + rename, 0600). By default a
   * NEW capture is REFUSED if it carries a credential-grade value too large to fold — it would be stored
   * but unredactable (audit #4), and silently dropping it is not an option for a secret. `allowOversize`
   * (rotation ONLY) skips that refusal: {@link rotateVaultKey} re-seals EXISTING entries — including a
   * legacy oversized one written before this guard — and must never reject mid-run, which would split a
   * rotation across the old and new keys. An oversized leaf is not folded on either path; only the
   * refusal differs.
   */
  put(consumerId: string, host: string, value: unknown, opts: { allowOversize?: boolean } = {}): void {
    const ch = this.#canon(host);
    // Scan BEFORE any write, so a rejected put leaves nothing on disk (atomic refusal).
    const scan = scanLeaves(value);
    if (scan.oversized > 0 && !opts.allowOversize) {
      throw new Error(
        `vault: refusing to store an entry with a credential-grade value larger than ${REDACT_SENSITIVE_MAX} ` +
          `bytes — it cannot be guaranteed redactable (audit #4); shrink or omit the oversized field before capture`,
      );
    }
    const record = sealJson(value, { kek: this.#kek, consumerId, host: ch });
    const file: EntryFile = { consumerId, host: ch, record };
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    const target = this.#fileFor(consumerId, ch);
    const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(file)}\n`, { mode: 0o600 });
    renameSync(tmp, target); // atomic publish — no torn file is ever visible
    this.#fold(scan);
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
    // Fold LENIENTLY on read: a pre-existing entry with an oversized credential-grade leaf (written
    // before the put-time guard, or hand-crafted) is still opened — refusing here would break warm-open
    // for a legitimately stored session. Only NEW writes are rejected (at put); its oversized leaf is
    // simply not folded. `oversized` is ignored on this path.
    this.#fold(scanLeaves(value));
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
 * Rotate the master key: re-seal every entry under `newKek` (decrypt, encrypt afresh — a new DEK +
 * nonces per entry). After this returns, point BGW_VAULT_KEY_FILE at the new key. Returns the number of
 * entries rotated.
 *
 * OFFLINE OPERATION: run this with the gateway STOPPED. It takes no lock and is not safe against a live
 * `put`/`get` racing it — the caller must guarantee exclusive access to `dir` for the rotation's
 * duration (the gateway process is the only writer, so stopping it is the exclusivity boundary).
 *
 * INVENTORY BOUNDARY: the entry set is the TOP-LEVEL, plain, single-linked `*.vault.json` files the
 * store itself writes, each at its canonical slot path. Rotation rejects (fail closed) any that isn't —
 * a symlink/hard link, a non-regular file, a non-canonical host, a file at a non-canonical name, or an
 * ORPHANED atomic-write temp (`*.vault.json.<hex>.tmp` from a crashed write, which holds old-key
 * ciphertext) — so no copy/alias/temp can survive under the old key. Entry ciphertext the operator has
 * copied OUT of this set (renamed off the `.vault.json` suffix, or into a subdirectory) is out of the
 * store's scope; the caller must not leave such copies in `dir`.
 *
 * Two phases so a single bad entry can't leave a half-rotated split-brain vault: STRICTLY enumerate +
 * decrypt EVERY `*.vault.json` FIRST — any file that won't parse or decrypt throws before a single file
 * is rewritten. This does NOT use `list()` (which SKIPS malformed files for the lenient `vault status`
 * path — rotation must not, or a corrupt entry would be left behind under the old key while the rest
 * flips). Only once the whole set is verified do we re-seal in place.
 *
 * RESUMABLE: Phase 1 decrypts each file under `newKek` OR `oldKek` (new first). So a rotation interrupted
 * mid-write (some files already flipped to `newKek`, the rest still `oldKek`) is completed simply by
 * re-running with the same (old, new) pair — already-flipped entries open under `newKek`, the rest under
 * `oldKek`, and all are re-sealed under `newKek`. A file that opens under NEITHER key is corrupt/foreign
 * → throw (fail closed, no partial write). `newKek` must differ from `oldKek` (a no-op "rotation" that
 * doesn't change the key is rejected).
 */
export function rotateVaultKey(
  dir: string,
  oldKek: Buffer,
  newKek: Buffer,
  canonicalizeHost: (host: string) => string,
): number {
  if (oldKek.equals(newKek)) {
    throw new Error("vault: rotateVaultKey requires a DIFFERENT new key — old and new master keys are identical");
  }
  const allNames = existsSync(dir) ? readdirSync(dir) : [];
  // A crashed atomic write (put writes `<slot>.vault.json.<hex>.tmp` then renames) can orphan a `.tmp`
  // holding OLD-key ciphertext. It is not a `*.vault.json` entry, so Phase 1 would not rotate it — a
  // "successful" rotation would then leave old-key ciphertext behind, defeating key-compromise recovery.
  // Fail CLOSED: the operator must remove orphaned temps (incomplete writes, safe to delete) first.
  const orphanTemp = allNames.find((n) => /\.vault\.json\.[0-9a-f]+\.tmp$/.test(n));
  if (orphanTemp) {
    throw new Error(
      `vault: an orphaned atomic-write temp exists (${orphanTemp}) — a crashed write left old-key ` +
        `ciphertext; remove the *.vault.json.*.tmp file(s) from the vault dir before rotating`,
    );
  }
  const files = allNames.filter((n) => n.endsWith(ENTRY_SUFFIX));
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
    const consumerId = file.consumerId;
    const host = file.host;
    const record = file.record as SealedRecord;
    // Reject a filesystem ALIAS before any write: `readFileSync` follows a symlink and Phase 2's rename
    // replaces the LINK (leaving the target's old-key ciphertext), and a hard-linked file keeps the old
    // inode reachable under its other name. `lstat` (not `stat`) sees the symlink itself; a subdir named
    // `*.vault.json` also fails `isFile()`.
    const st = lstatSync(join(dir, name));
    if (!st.isFile() || st.nlink > 1) {
      throw new Error(`vault: ${name} is not a plain single-linked file (symlink / hard link / non-regular) — refusing to rotate`);
    }
    // The stored host must ALREADY be canonical: Phase 1 derives the expected path from the stored host,
    // but Phase 2's put() canonicalizes it — a raw host (e.g. "A.COM.") would pass here yet be rewritten
    // to the "a.com" slot, leaving the raw-host file decryptable under the OLD key. Reject the mismatch.
    if (canonicalizeHost(host) !== host) {
      throw new Error(`vault: ${name} has a non-canonical host — refusing to rotate (would leave an old-key file behind)`);
    }
    // Every enumerated file MUST be at its canonical slot path. A valid entry COPIED to a different
    // *.vault.json name (or a duplicate slot) would otherwise be decrypted + counted but NOT rewritten
    // by Phase 2's put() (which writes the CANONICAL path) — leaving an old-key-decryptable copy behind.
    // Reject BEFORE any write so the every-file rotation guarantee (key-compromise recovery) holds.
    if (slotFileName(dir, consumerId, host) !== join(dir, name)) {
      throw new Error(
        `vault: ${name} is not at its canonical slot path — refusing to rotate (a copied or duplicate ` +
          `entry would leave old-key ciphertext decryptable after rotation)`,
      );
    }
    // Decrypt under EITHER key so an interrupted rotation resumes: try newKek first (a file already
    // flipped by a crashed prior run), then oldKek (a not-yet-rotated file). openJson fails closed (GCM
    // tag) on a wrong key, so the fallback is safe — a file is sealed under exactly one key. If NEITHER
    // opens it, the file is corrupt/foreign and oldKek's throw propagates → Phase 1 aborts, no writes.
    let value: unknown;
    try {
      value = openJson(record, { kek: newKek, consumerId, host });
    } catch {
      value = openJson(record, { kek: oldKek, consumerId, host });
    }
    return { consumerId, host, value };
  });
  // Phase 2 — re-seal under the new key (pure) and write each in place (atomic temp + rename per file).
  // allowOversize: rotation re-seals EXISTING entries, so a legacy oversized credential (written before
  // put's audit-#4 guard) must NOT make put throw mid-loop — that would leave earlier files flipped to
  // the new key while the rest stay on the old (split-brain). Its leaf simply isn't folded, as on get().
  const newStore = new VaultStore({ kek: newKek, dir, canonicalizeHost });
  for (const e of decrypted) newStore.put(e.consumerId, e.host, e.value, { allowOversize: true });
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
