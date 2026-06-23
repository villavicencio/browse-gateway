/**
 * Vault store (U4) — per-(consumer, host) encrypted entries: round-trip, host-key normalization,
 * AAD slot-binding, crypto-shred, key custody (file/env), the fail-closed boot guard, redaction
 * folding, and key rotation. Real temp dirs + real fs; placeholder consumer codenames.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  VaultStore,
  openVault,
  loadVaultKey,
  countVaultEntries,
  vaultKeyBootError,
  rotateVaultKey,
  canonicalizeHost,
} from "../dist/security/index.js";

function tmp() {
  return mkdtempSync(join(tmpdir(), "bgw-vault-"));
}
const KEK = randomBytes(32);
function store(dir, kek = KEK, redact) {
  return new VaultStore({ kek, dir, canonicalizeHost, redact });
}

const SESSION = { cookies: [{ name: "sid", value: "x".repeat(40) }], origins: [] };
const CREDS = { username: "atlas-user", password: "p".repeat(20), totpSeed: "JBSWY3DPEHPK3PXP" };

test("put/get round-trips storageState + credentials", () => {
  const dir = tmp();
  const s = store(dir);
  s.put("atlas", "example.com", { session: SESSION, creds: CREDS });
  assert.deepEqual(s.get("atlas", "example.com"), { session: SESSION, creds: CREDS });
  assert.equal(s.get("atlas", "nope.com"), null, "absent entry → null");
  assert.equal(s.has("atlas", "example.com"), true);
  rmSync(dir, { recursive: true, force: true });
});

test("host key is normalized via canonicalizeHost — one entry for Host-A.com and host-a.com", () => {
  const dir = tmp();
  const s = store(dir);
  s.put("atlas", "Host-A.com", { v: 1 });
  s.put("atlas", "host-a.com", { v: 2 }); // same canonical host → overwrites the same entry
  assert.deepEqual(s.get("atlas", "HOST-A.COM"), { v: 2 });
  assert.equal(s.list().length, 1, "one entry, not three");
  rmSync(dir, { recursive: true, force: true });
});

test("entries are 0600 JSON files; remove() crypto-shreds", () => {
  const dir = tmp();
  const s = store(dir);
  s.put("atlas", "example.com", CREDS);
  const files = readdirSync(dir).filter((n) => n.endsWith(".vault.json"));
  assert.equal(files.length, 1);
  assert.equal(s.remove("atlas", "example.com"), true);
  assert.equal(s.has("atlas", "example.com"), false, "file gone → wrapped DEK gone → unrecoverable");
  assert.equal(s.remove("atlas", "example.com"), false, "removing a missing entry → false");
  rmSync(dir, { recursive: true, force: true });
});

test("list() enumerates consumer+host+freshness without decrypting", () => {
  const dir = tmp();
  const s = store(dir);
  s.put("vault", "b.com", CREDS);
  s.put("atlas", "a.com", SESSION);
  const meta = s.list();
  assert.deepEqual(meta.map((m) => [m.consumerId, m.host]), [["atlas", "a.com"], ["vault", "b.com"]], "sorted, listed");
  assert.ok(meta.every((m) => m.updatedAt > 0 && m.bytes > 0));
  rmSync(dir, { recursive: true, force: true });
});

test("AAD slot-binding: a wrong key fails closed, and a swapped file can't be opened under another slot", () => {
  const dir = tmp();
  store(dir).put("atlas", "example.com", CREDS);
  const atlasFile = readdirSync(dir).find((n) => n.endsWith(".vault.json"));

  // A different consumer keys a DIFFERENT file → simply absent (can't even reach atlas's ciphertext).
  assert.equal(store(dir).get("vault", "example.com"), null, "different consumer → different file → null");

  // A wrong KEK can't read the legit entry.
  assert.throws(() => store(dir, randomBytes(32)).get("atlas", "example.com"), /authenticate|decrypt/i);

  // Attacker SWAPS atlas's sealed bytes into vault's filename — the AAD (bound to the REQUESTED
  // consumer/host, not the stored tuple) rejects it: a record can't be transplanted between slots.
  store(dir).put("vault", "example.com", { decoy: 1 });
  const vaultFile = readdirSync(dir).filter((n) => n.endsWith(".vault.json")).find((n) => n !== atlasFile);
  writeFileSync(join(dir, vaultFile), readFileSync(join(dir, atlasFile), "utf8"));
  assert.throws(() => store(dir).get("vault", "example.com"), /authenticate|decrypt/i, "swapped record fails the AAD check");
  rmSync(dir, { recursive: true, force: true });
});

test("redaction folding: stored secret leaf values are handed to the redact hook", () => {
  const dir = tmp();
  const folded = new Set();
  const s = store(dir, KEK, (vals) => { for (const v of vals) folded.add(v); });
  s.put("atlas", "example.com", { session: SESSION, creds: CREDS });
  assert.ok(folded.has(CREDS.password), "password folded for redaction");
  assert.ok(folded.has("x".repeat(40)), "long cookie value folded");
  assert.ok(!folded.has("sid"), "short noise (3 chars) not folded");
  // get() folds too (e.g. after a process restart that never saw the put).
  const folded2 = new Set();
  store(dir, KEK, (vals) => { for (const v of vals) folded2.add(v); }).get("atlas", "example.com");
  assert.ok(folded2.has(CREDS.password));
  rmSync(dir, { recursive: true, force: true });
});

test("loadVaultKey: file path, raw env, none, and unreadable file", () => {
  const dir = tmp();
  const keyB64 = randomBytes(32).toString("base64");
  const keyFile = join(dir, "vault.key");
  writeFileSync(keyFile, `${keyB64}\n`);
  assert.equal(loadVaultKey({ BGW_VAULT_KEY_FILE: keyFile }).toString("base64"), keyB64, "from file");
  assert.equal(loadVaultKey({ BGW_VAULT_KEY: keyB64 }).toString("base64"), keyB64, "from raw env");
  assert.equal(loadVaultKey({}), null, "no source → null");
  assert.throws(() => loadVaultKey({ BGW_VAULT_KEY_FILE: join(dir, "absent") }), /not readable/);
  assert.throws(() => loadVaultKey({ BGW_VAULT_KEY: randomBytes(16).toString("base64") }), /must be 32 bytes/);
  rmSync(dir, { recursive: true, force: true });
});

test("boot guard: entries-without-key fails closed; empty or keyed boots fine", () => {
  assert.equal(vaultKeyBootError(0, false), null, "no entries, no key → dormant, boots");
  assert.equal(vaultKeyBootError(3, true), null, "entries + key → boots");
  assert.match(vaultKeyBootError(2, false), /no master key configured.*refusing to boot/);
  assert.match(vaultKeyBootError(1, false, "unreadable"), /failed to load: unreadable/);
});

test("openVault: dir unset → off; dir+key → ready; dir+entries+no key → throws", () => {
  const dir = tmp();
  assert.equal(openVault({ env: {}, canonicalizeHost }), null, "no BGW_VAULT_DIR → feature off");

  const keyB64 = randomBytes(32).toString("base64");
  const env = { BGW_VAULT_DIR: dir, BGW_VAULT_KEY: keyB64 };
  const folded = new Set();
  const v = openVault({ env, canonicalizeHost, redact: (vals) => { for (const x of vals) folded.add(x); } });
  assert.ok(v instanceof VaultStore, "dir + key → ready store");
  assert.ok(folded.has(keyB64), "the KEK is folded into redaction");
  v.put("atlas", "example.com", CREDS);

  // Now an entry exists but the key is removed → fail closed.
  assert.equal(countVaultEntries(dir), 1);
  assert.throws(() => openVault({ env: { BGW_VAULT_DIR: dir }, canonicalizeHost }), /refusing to boot/);
  rmSync(dir, { recursive: true, force: true });
});

test("short sensitive values (TOTP code / PIN / short password) fold despite the length floor", () => {
  const dir = tmp();
  const folded = new Set();
  const s = store(dir, KEK, (vals) => { for (const v of vals) folded.add(v); });
  s.put("atlas", "example.com", { creds: { totp: "123456", pin: "4821", password: "hunter2" }, note: "ok" });
  assert.ok(folded.has("123456"), "6-digit TOTP under a sensitive key folds");
  assert.ok(folded.has("4821"), "4-digit PIN folds");
  assert.ok(folded.has("hunter2"), "7-char password folds");
  assert.ok(!folded.has("ok"), "a short value under a non-sensitive key is NOT folded (avoids over-redaction)");
  rmSync(dir, { recursive: true, force: true });
});

test("store rejects control characters in consumer/host (slot-field validation)", () => {
  const dir = tmp();
  const NUL = String.fromCharCode(0);
  assert.throws(() => store(dir).put("atlas", "a" + NUL + "b.com", { x: 1 }), /control characters/);
  rmSync(dir, { recursive: true, force: true });
});

test("openVault fails closed with a clear message when BGW_VAULT_DIR is a file", () => {
  const dir = tmp();
  const f = join(dir, "notadir");
  writeFileSync(f, "x");
  assert.throws(() => openVault({ env: { BGW_VAULT_DIR: f }, canonicalizeHost }), /not a directory.*refusing to boot/);
  rmSync(dir, { recursive: true, force: true });
});

test("rotateVaultKey aborts on a corrupt entry BEFORE rewriting any (no split-brain)", () => {
  const dir = tmp();
  const oldKek = randomBytes(32);
  const newKek = randomBytes(32);
  const s = store(dir, oldKek);
  const slots = [["atlas", "a.com"], ["vault", "b.com"], ["argus", "c.com"]];
  for (const [c, h] of slots) s.put(c, h, { c, h });
  // Corrupt one entry's ciphertext on disk.
  const victim = join(dir, readdirSync(dir).find((n) => n.endsWith(".vault.json")));
  const ef = JSON.parse(readFileSync(victim, "utf8"));
  const ct = Buffer.from(ef.record.blob.ct, "base64"); ct[0] ^= 0xff; ef.record.blob.ct = ct.toString("base64");
  writeFileSync(victim, JSON.stringify(ef));

  assert.throws(() => rotateVaultKey(dir, oldKek, newKek, canonicalizeHost), /authenticate|decrypt/i);

  // No entry was re-sealed: the non-corrupt ones still open under the OLD key, none under the new.
  const old = store(dir, oldKek);
  let openUnderOld = 0;
  for (const [c, h] of slots) { try { old.get(c, h); openUnderOld++; } catch { /* the corrupt one */ } }
  assert.ok(openUnderOld >= 2, "non-corrupt entries still open under the OLD key (rotation did not touch them)");
  const neu = store(dir, newKek);
  for (const [c, h] of slots) assert.throws(() => neu.get(c, h));
  rmSync(dir, { recursive: true, force: true });
});

test("rotateVaultKey: new key opens everything, old key no longer works", () => {
  const dir = tmp();
  const oldKek = randomBytes(32);
  const newKek = randomBytes(32);
  const s = store(dir, oldKek);
  s.put("atlas", "a.com", { a: 1 });
  s.put("vault", "b.com", { b: 2 });

  const n = rotateVaultKey(dir, oldKek, newKek, canonicalizeHost);
  assert.equal(n, 2, "both entries rotated");

  const next = store(dir, newKek);
  assert.deepEqual(next.get("atlas", "a.com"), { a: 1 }, "new key opens");
  assert.deepEqual(next.get("vault", "b.com"), { b: 2 });
  assert.throws(() => store(dir, oldKek).get("atlas", "a.com"), /authenticate|decrypt/i, "old key is dead");
  rmSync(dir, { recursive: true, force: true });
});
