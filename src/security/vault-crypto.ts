/**
 * Vault crypto (B1) — the correctness-critical core of the credential/session-state vault. The
 * repo's FIRST encryption-at-rest surface. Dependency-free: `node:crypto` AES-256-GCM only.
 *
 * Envelope scheme: a master key (KEK) wraps a fresh random 32-byte data key (DEK) per entry; the DEK
 * encrypts the payload. Why envelope on a single host: the format ENABLES cheap key rotation (re-wrap
 * the DEK only) and per-entry crypto-shredding (drop the wrapped DEK). Note the current
 * `rotateVaultKey` takes the simpler full-reseal path — decrypt each entry under the old KEK and
 * re-seal it afresh (new DEK, payload re-encrypted) under the new — NOT a DEK-only re-wrap; the
 * envelope still permits the cheaper form if a future rotation needs it. The KEK is never used as a
 * cipher key directly — an HKDF step derives a domain-separated wrapping key from it.
 *
 * AAD binds every ciphertext to its (version, consumerId, host) slot via an INJECTIVE encoding: a
 * record sealed for one (consumer, host) cannot be decrypted under another (the GCM tag won't
 * verify), so a stored session can't be transplanted between consumers/hosts by moving bytes around.
 * Authentication is mandatory — a wrong key, wrong AAD, or any tampering throws (fail closed); nothing
 * decrypts unauthenticated.
 */
import { randomBytes, createCipheriv, createDecipheriv, hkdfSync, timingSafeEqual } from "node:crypto";

/** Bumped only on a breaking record-format change; `open` refuses any other version (fail closed). */
export const VAULT_SCHEMA_VERSION = 1;
/** AES-256 key length. */
const KEY_LEN = 32;
/** GCM nonce length — 12 bytes is the standard/efficient choice; drawn at random per encryption, so
 *  its collision risk is probabilistically bounded (per-layer analysis on `seal()`), not zero. */
const NONCE_LEN = 12;
/** GCM auth tag length. */
const TAG_LEN = 16;
/** HKDF info for the DEK-wrapping subkey — domain-separates the KEK from any other future use. */
const WRAP_INFO = "browse-gateway/vault/dek-wrap/v1";

/** One AES-256-GCM ciphertext: base64 nonce + ciphertext + auth tag. */
export interface GcmBox {
  nonce: string;
  ct: string;
  tag: string;
}

/** An encrypted vault entry: the wrapped DEK + the payload encrypted under it, plus the schema version. */
export interface SealedRecord {
  v: number;
  /** The per-entry data key, AES-256-GCM-wrapped under the HKDF-derived wrapping key. */
  dek: GcmBox;
  /** The payload, AES-256-GCM-encrypted under the (unwrapped) data key. */
  blob: GcmBox;
}

/** Binding context: the master key plus the (consumer, host) tuple the record is scoped to. */
export interface VaultContext {
  /** 32-byte master key (KEK). */
  kek: Buffer;
  consumerId: string;
  host: string;
}

function assertKek(kek: Buffer): void {
  if (!Buffer.isBuffer(kek) || kek.length !== KEY_LEN) {
    throw new Error(`vault: master key must be ${KEY_LEN} bytes, got ${Buffer.isBuffer(kek) ? kek.length : typeof kek}`);
  }
}

/**
 * Validate a slot identity field (consumerId / host): reject empty + any control character (incl.
 * NUL) so a field can't smuggle a separator into the slot identity, and the store's filename and the
 * AAD agree on what a legal slot is. Exported for the store to reuse on its key path.
 */
export function assertSlotField(name: string, value: string): void {
  if (typeof value !== "string" || value.length === 0) throw new Error(`vault: ${name} must be a non-empty string`);
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error(`vault: ${name} contains control characters`);
  // Reject ill-formed UTF-16 (a lone/unpaired surrogate). `aad()` binds the slot via
  // `Buffer.from(value, "utf8")`, and UTF-8 encoding collapses EVERY lone surrogate to the SAME
  // replacement bytes (EF BF BD) — so distinct fields (e.g. consumerId U+D800 vs U+D801) would produce
  // an IDENTICAL AAD, breaking the injective (consumer, host) binding the no-transplant guarantee rests
  // on (a record sealed under one could open under the other). A UTF-8 round-trip is lossless iff the
  // string is well-formed, so it detects exactly this — equivalent to String.prototype.isWellFormed(),
  // which is ES2024, beyond this project's ES2022 lib.
  if (Buffer.from(value, "utf8").toString("utf8") !== value) {
    throw new Error(`vault: ${name} contains ill-formed Unicode (a lone surrogate)`);
  }
}

/**
 * AAD = an INJECTIVE (collision-free) encoding of (version, consumerId, host): a length-prefixed
 * concatenation, so two distinct slots can never share an authenticated context. A naive separator
 * (a space, or even NUL) is NOT injective when a field can contain that separator, and the whole
 * slot-binding (a record can't be transplanted to another consumer/host) rests on injectivity.
 * Injectivity holds over the ACCEPTED field domain: `assertSlotField` rejects control chars AND
 * ill-formed Unicode (lone surrogates), so each field's UTF-8 encoding is itself lossless/injective and
 * the byte-length prefixes let the concatenation be split back apart unambiguously. Authenticated, not
 * encrypted.
 */
function aad(v: number, consumerId: string, host: string): Buffer {
  assertSlotField("consumerId", consumerId);
  assertSlotField("host", host);
  const c = Buffer.from(consumerId, "utf8");
  const h = Buffer.from(host, "utf8");
  const head = Buffer.alloc(12);
  head.writeUInt32BE(v >>> 0, 0);
  head.writeUInt32BE(c.length, 4);
  head.writeUInt32BE(h.length, 8);
  return Buffer.concat([head, c, h]);
}

/** Derive the domain-separated DEK-wrapping key from the raw KEK (never cipher with the KEK directly). */
function wrappingKey(kek: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", kek, Buffer.alloc(0), WRAP_INFO, KEY_LEN));
}

function gcmSeal(key: Buffer, plaintext: Buffer, ad: Buffer): GcmBox {
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(ad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { nonce: nonce.toString("base64"), ct: ct.toString("base64"), tag: tag.toString("base64") };
}

function gcmOpen(key: Buffer, box: GcmBox, ad: Buffer): Buffer {
  const nonce = Buffer.from(box.nonce, "base64");
  const tag = Buffer.from(box.tag, "base64");
  if (nonce.length !== NONCE_LEN) throw new Error(`vault: bad nonce length ${nonce.length}`);
  if (tag.length !== TAG_LEN) throw new Error(`vault: bad auth-tag length ${tag.length} (unauthenticated record refused)`);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(ad);
  decipher.setAuthTag(tag);
  // final() throws on tag mismatch — wrong key, wrong AAD (transplant), or tampering all surface here.
  return Buffer.concat([decipher.update(Buffer.from(box.ct, "base64")), decipher.final()]);
}

/**
 * Encrypt `plaintext` into a sealed record bound to `ctx`'s (consumer, host). A fresh random DEK is
 * generated per call and wrapped under the KEK-derived key; both layers carry the same AAD binding.
 *
 * Nonce safety is probabilistic, not absolute, and differs by layer. The BLOB layer draws a fresh
 * random 256-bit DEK and a random 96-bit nonce per call, so a repeated (key, nonce) pair is
 * negligible: only a DEK collision — astronomically unlikely across the 256-bit space — could put two
 * nonces under one blob key. The DEK-WRAP layer reuses ONE key (the KEK-derived wrapping key,
 * deterministic in the KEK) across every seal with a random 96-bit nonce, so its nonce uniqueness is
 * birthday-bounded on that 96-bit space — NIST SP 800-38D caps random-IV GCM at 2^32 invocations per
 * key. That budget is spent by CUMULATIVE seals (every put / overwrite / rotation re-seal counts), not
 * by entry count; re-keying under a distinct KEK resets it. The gateway does not itself count
 * invocations or auto-rotate, so 2^32 is design headroom, not an enforced ceiling.
 */
export function seal(plaintext: Buffer | string, ctx: VaultContext): SealedRecord {
  assertKek(ctx.kek);
  const ad = aad(VAULT_SCHEMA_VERSION, ctx.consumerId, ctx.host);
  const pt = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
  const dek = randomBytes(KEY_LEN);
  try {
    const dekBox = gcmSeal(wrappingKey(ctx.kek), dek, ad);
    const blobBox = gcmSeal(dek, pt, ad);
    return { v: VAULT_SCHEMA_VERSION, dek: dekBox, blob: blobBox };
  } finally {
    dek.fill(0); // best-effort: don't leave the plaintext DEK lingering in the buffer after wrapping
  }
}

function assertShape(record: SealedRecord): void {
  const okBox = (b: unknown): b is GcmBox =>
    typeof b === "object" && b !== null && typeof (b as GcmBox).nonce === "string" && typeof (b as GcmBox).ct === "string" && typeof (b as GcmBox).tag === "string";
  if (typeof record !== "object" || record === null) throw new Error("vault: record is not an object");
  if (typeof record.v !== "number") throw new Error("vault: record missing numeric version");
  if (!okBox(record.dek) || !okBox(record.blob)) {
    throw new Error("vault: record missing dek/blob nonce+ct+tag — refusing (unauthenticated or malformed)");
  }
}

/**
 * Decrypt a sealed record under `ctx`. Throws if the version is unsupported, the structure is
 * malformed/unauthenticated, or the key/AAD doesn't match (wrong consumer/host, wrong KEK, tampering).
 * Returns the plaintext bytes; callers parse (e.g. JSON) from there.
 */
export function open(record: SealedRecord, ctx: VaultContext): Buffer {
  assertKek(ctx.kek);
  assertShape(record);
  if (record.v !== VAULT_SCHEMA_VERSION) {
    throw new Error(`vault: unsupported record version ${record.v} (this build seals/opens v${VAULT_SCHEMA_VERSION})`);
  }
  const ad = aad(record.v, ctx.consumerId, ctx.host);
  const dek = gcmOpen(wrappingKey(ctx.kek), record.dek, ad);
  try {
    if (dek.length !== KEY_LEN) throw new Error(`vault: unwrapped data key has wrong length ${dek.length}`);
    return gcmOpen(dek, record.blob, ad);
  } finally {
    dek.fill(0);
  }
}

/** Convenience: seal a JSON-serializable value. */
export function sealJson(value: unknown, ctx: VaultContext): SealedRecord {
  return seal(Buffer.from(JSON.stringify(value), "utf8"), ctx);
}

/** Convenience: open + JSON-parse. Throws (fail closed) on a decrypt failure or malformed JSON. */
export function openJson<T = unknown>(record: SealedRecord, ctx: VaultContext): T {
  return JSON.parse(open(record, ctx).toString("utf8")) as T;
}

/**
 * Validate + normalize a master key supplied as base64 (the on-disk/file form). Throws unless it
 * decodes to exactly 32 bytes. The value itself must be folded into the redaction set by the caller
 * (it never logs here).
 */
export function decodeMasterKey(b64: string): Buffer {
  const key = Buffer.from(b64.trim(), "base64");
  assertKek(key);
  return key;
}

/** Constant-time equality for two same-length secrets (e.g. comparing a re-derived key). */
export function secretEquals(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
