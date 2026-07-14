/**
 * Vault store (U4) — per-(consumer, host) encrypted entries: round-trip, host-key normalization,
 * AAD slot-binding, crypto-shred, key custody (file/env), the fail-closed boot guard, redaction
 * folding, and key rotation. Real temp dirs + real fs; placeholder consumer codenames.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, chmodSync, mkdirSync, rmSync, renameSync, symlinkSync, linkSync } from "node:fs";
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
  SecretStore,
  redactSecrets,
  sealJson,
  slotFileName,
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
  s.put("atlas", "example.com", {
    session: { cookies: [{ name: "sid", value: "x".repeat(40) }, { name: "csrf", value: "ab12" }], origins: [] },
    creds: CREDS,
  });
  assert.ok(folded.has(CREDS.password), "password folded for redaction");
  assert.ok(folded.has("x".repeat(40)), "long cookie value folded");
  assert.ok(folded.has("ab12"), "SHORT cookie value folded — a {name,value} pair's value is credential-grade");
  assert.ok(!folded.has("sid"), "short cookie NAME not folded (would over-redact ordinary logs)");
  assert.ok(!folded.has("csrf"), "short cookie NAME not folded");
  // get() folds too (e.g. after a process restart that never saw the put).
  const folded2 = new Set();
  store(dir, KEK, (vals) => { for (const v of vals) folded2.add(v); }).get("atlas", "example.com");
  assert.ok(folded2.has(CREDS.password));
  rmSync(dir, { recursive: true, force: true });
});

test("loadVaultKey: file path (0600 enforced), raw env, none, unreadable, bad size", () => {
  const dir = tmp();
  const keyB64 = randomBytes(32).toString("base64");
  const keyFile = join(dir, "vault.key");
  writeFileSync(keyFile, `${keyB64}\n`);
  chmodSync(keyFile, 0o600); // owner-only — the required posture
  assert.equal(loadVaultKey({ BGW_VAULT_KEY_FILE: keyFile }).toString("base64"), keyB64, "from a 0600 file");
  assert.equal(loadVaultKey({ BGW_VAULT_KEY: keyB64 }).toString("base64"), keyB64, "from raw env");
  assert.equal(loadVaultKey({}), null, "no source → null");
  assert.throws(() => loadVaultKey({ BGW_VAULT_KEY_FILE: join(dir, "absent") }), /not readable/);
  assert.throws(() => loadVaultKey({ BGW_VAULT_KEY: randomBytes(16).toString("base64") }), /must be 32 bytes/);
  rmSync(dir, { recursive: true, force: true });
});

test("loadVaultKey REJECTS a group/world-accessible or non-regular key file (P1: KEK perms enforced)", () => {
  const dir = tmp();
  const keyB64 = randomBytes(32).toString("base64");
  const keyFile = join(dir, "vault.key");
  writeFileSync(keyFile, `${keyB64}\n`);
  for (const mode of [0o644, 0o640, 0o604, 0o660]) {
    chmodSync(keyFile, mode);
    assert.throws(() => loadVaultKey({ BGW_VAULT_KEY_FILE: keyFile }), /group\/world-accessible/, `mode 0${mode.toString(8)} rejected`);
  }
  chmodSync(keyFile, 0o600);
  assert.ok(loadVaultKey({ BGW_VAULT_KEY_FILE: keyFile }), "0600 accepted");
  // A directory (non-regular) is rejected before any read.
  const asDir = join(dir, "akeydir");
  mkdirSync(asDir, { mode: 0o700 });
  assert.throws(() => loadVaultKey({ BGW_VAULT_KEY_FILE: asDir }), /not a regular file/);
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

test("LARGE credential-grade leaves fold up to the ceiling and are redactable end-to-end (audit #4)", () => {
  const dir = tmp();
  const folded = new Set();
  const s = store(dir, KEK, (vals) => { for (const v of vals) folded.add(v); });
  const atCap = "j" + "W".repeat(65535); // exactly REDACT_SENSITIVE_MAX = 65536 (> the generic 4KB cap)
  const bigCookie = "s".repeat(30000); // a big {name,value} cookie value (credential-grade)
  const bigNote = "n".repeat(30000); // a large value under a NON-sensitive key
  s.put("atlas", "example.com", {
    creds: { token: atCap },
    session: { cookies: [{ name: "SID", value: bigCookie }] },
    note: bigNote,
  });
  assert.ok(folded.has(atCap), "a value AT the 64KB ceiling folds — must be redactable");
  assert.ok(folded.has(bigCookie), "a big {name,value} cookie value folds (credential-grade)");
  assert.ok(!folded.has(bigNote), "a large NON-sensitive value stays capped (generic blob-noise guard)");
  // End-to-end: the folded credential is actually scrubbed by redactSecrets via a SecretStore.
  const secrets = new SecretStore(() => ({}));
  secrets.addRedactable(folded);
  const scrubbed = redactSecrets(`leaked token=${atCap} cookie=${bigCookie}`, secrets);
  assert.ok(!scrubbed.includes(atCap), "the folded token is scrubbed from a log line (VaultStore→SecretStore→redactSecrets)");
  assert.ok(!scrubbed.includes(bigCookie), "the folded cookie value is scrubbed");
  rmSync(dir, { recursive: true, force: true });
});

test("put REFUSES a credential-grade value beyond the fold ceiling — no silent unredactable secret (audit #4)", () => {
  const dir = tmp();
  const folded = new Set();
  const s = store(dir, KEK, (vals) => { for (const v of vals) folded.add(v); });
  const overCap = "j".repeat(65537); // one over REDACT_SENSITIVE_MAX — cannot be guaranteed redactable
  assert.throws(
    () => s.put("atlas", "example.com", { creds: { token: overCap } }),
    /larger than 65536|cannot be guaranteed redactable/,
  );
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".vault.json")).length, 0, "nothing persisted on a rejected put");
  assert.ok(!folded.has(overCap), "the oversized value was never folded");
  rmSync(dir, { recursive: true, force: true });
});

test("get is LENIENT on a pre-existing oversized entry — reading must not break warm-open (audit #4)", () => {
  const dir = tmp();
  const folded = new Set();
  const s = store(dir, KEK, (vals) => { for (const v of vals) folded.add(v); });
  // Seed a normal entry to learn the on-disk filename, then overwrite it with a re-sealed OVERSIZED
  // payload under the SAME slot — simulating an entry written before the put-time guard existed.
  s.put("atlas", "example.com", { creds: { password: "seed-value" } });
  const [file] = readdirSync(dir).filter((f) => f.endsWith(".vault.json"));
  const big = "z".repeat(70000);
  const record = sealJson({ creds: { token: big } }, { kek: KEK, consumerId: "atlas", host: "example.com" });
  writeFileSync(join(dir, file), JSON.stringify({ consumerId: "atlas", host: "example.com", record }) + "\n");
  const got = s.get("atlas", "example.com"); // must NOT throw — legacy entry stays readable
  assert.equal(got.creds.token, big, "legacy oversized entry remains readable (get is lenient)");
  assert.ok(!folded.has(big), "the oversized leaf is not folded on read (best-effort)");
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

test("rotateVaultKey FAILS on a malformed *.vault.json instead of silently skipping it (P2)", () => {
  const dir = tmp();
  const oldKek = randomBytes(32);
  const newKek = randomBytes(32);
  const s = store(dir, oldKek);
  s.put("atlas", "a.com", { a: 1 });
  s.put("vault", "b.com", { b: 2 });
  // Drop in a malformed entry — list() would SKIP it; rotation must NOT (it would leave it unrotated).
  writeFileSync(join(dir, "garbage.vault.json"), "{ not valid json");

  assert.throws(() => rotateVaultKey(dir, oldKek, newKek, canonicalizeHost), /not valid JSON|refusing to rotate/);

  // Nothing flipped: the two good entries still open under the OLD key (rotation aborted before writes).
  const old = store(dir, oldKek);
  assert.deepEqual(old.get("atlas", "a.com"), { a: 1 }, "old key still opens — not split-brained");
  assert.deepEqual(old.get("vault", "b.com"), { b: 2 });
  assert.throws(() => store(dir, newKek).get("atlas", "a.com"), /authenticate|decrypt/i, "new key opens nothing");
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

test("rotateVaultKey: a LEGACY oversized entry rotates atomically (put's audit-#4 reject must not split rotation)", () => {
  const dir = tmp();
  const oldKek = randomBytes(32);
  const newKek = randomBytes(32);
  const s = store(dir, oldKek);
  s.put("atlas", "a.com", { a: 1 }); // a normal entry that rotates first
  // Craft a LEGACY oversized entry directly (put() would now reject it), sealed under the OLD key —
  // simulating an entry written before the audit-#4 guard existed. It sits alongside the normal one.
  const big = "z".repeat(70000);
  const rec = sealJson({ creds: { token: big } }, { kek: oldKek, consumerId: "atlas", host: "b.com" });
  // Learn the on-disk name by putting a placeholder for the same slot, then overwrite it with the big rec.
  s.put("atlas", "b.com", { placeholder: "x" });
  const bFile = readdirSync(dir).filter((f) => f.endsWith(".vault.json")).find((f) => {
    try { return JSON.parse(readFileSync(join(dir, f), "utf8")).host === "b.com"; } catch { return false; }
  });
  writeFileSync(join(dir, bFile), JSON.stringify({ consumerId: "atlas", host: "b.com", record: rec }) + "\n");

  const n = rotateVaultKey(dir, oldKek, newKek, canonicalizeHost);
  assert.equal(n, 2, "both entries rotated (rotation did not throw on the oversized legacy entry)");

  // Atomic: EVERY entry now opens under the NEW key (no split-brain), none under the old.
  const next = store(dir, newKek);
  assert.deepEqual(next.get("atlas", "a.com"), { a: 1 }, "normal entry rotated to the new key");
  assert.equal(next.get("atlas", "b.com").creds.token, big, "legacy oversized entry rotated to the new key");
  assert.throws(() => store(dir, oldKek).get("atlas", "a.com"), /authenticate|decrypt/i, "old key opens nothing after rotation");
  assert.throws(() => store(dir, oldKek).get("atlas", "b.com"), /authenticate|decrypt/i);
  rmSync(dir, { recursive: true, force: true });
});

test("rotateVaultKey: RESUMES a crash-interrupted rotation (mixed old/new key files, audit #8)", () => {
  const dir = tmp();
  const oldKek = randomBytes(32);
  const newKek = randomBytes(32);
  store(dir, oldKek).put("atlas", "a.com", { a: 1 });
  store(dir, oldKek).put("vault", "b.com", { b: 2 });
  // Simulate a rotation that CRASHED after flipping a.com to the new key but before b.com (same slot →
  // same file, so this overwrites a.com's record with a newKek-sealed one). The vault is now split.
  store(dir, newKek).put("atlas", "a.com", { a: 1 });
  // Re-running with the SAME (old,new) pair must RESUME — NOT fail Phase 1 on the already-flipped file.
  const n = rotateVaultKey(dir, oldKek, newKek, canonicalizeHost);
  assert.equal(n, 2, "both entries rotated — the already-flipped one resumed, not errored");
  const next = store(dir, newKek);
  assert.deepEqual(next.get("atlas", "a.com"), { a: 1 }, "the already-flipped entry opens under the new key");
  assert.deepEqual(next.get("vault", "b.com"), { b: 2 }, "the remaining entry was rotated to the new key");
  assert.throws(() => store(dir, oldKek).get("vault", "b.com"), /authenticate|decrypt/i, "the old key opens nothing after resume");
  rmSync(dir, { recursive: true, force: true });
});

test("rotateVaultKey: REJECTS an identical old/new master key (a rotation must change the key)", () => {
  const dir = tmp();
  const kek = randomBytes(32);
  store(dir, kek).put("atlas", "a.com", { a: 1 });
  assert.throws(() => rotateVaultKey(dir, kek, Buffer.from(kek), canonicalizeHost), /identical|DIFFERENT/);
  // A corrupt file that opens under NEITHER key still fails closed (no partial write).
  rmSync(dir, { recursive: true, force: true });
});

test("rotateVaultKey: a file that opens under NEITHER key fails closed (no partial write)", () => {
  const dir = tmp();
  const oldKek = randomBytes(32);
  const newKek = randomBytes(32);
  const foreignKek = randomBytes(32);
  store(dir, oldKek).put("atlas", "a.com", { a: 1 });
  // A file sealed under a THIRD (foreign) key — opens under neither old nor new.
  const rec = sealJson({ x: 1 }, { kek: foreignKek, consumerId: "atlas", host: "foreign.com" });
  store(dir, oldKek).put("atlas", "foreign.com", { placeholder: 1 });
  const f = readdirSync(dir).filter((n) => n.endsWith(".vault.json")).find((n) => {
    try { return JSON.parse(readFileSync(join(dir, n), "utf8")).host === "foreign.com"; } catch { return false; }
  });
  writeFileSync(join(dir, f), JSON.stringify({ consumerId: "atlas", host: "foreign.com", record: rec }) + "\n");
  assert.throws(() => rotateVaultKey(dir, oldKek, newKek, canonicalizeHost), /authenticate|decrypt/i);
  // Phase 1 aborted before any write: the good entry still opens under the OLD key.
  assert.deepEqual(store(dir, oldKek).get("atlas", "a.com"), { a: 1 }, "no entry was rotated (fail closed)");
  rmSync(dir, { recursive: true, force: true });
});

test("rotateVaultKey: REJECTS a valid entry copied to a NON-canonical filename (no old-key ciphertext survives, audit #8)", () => {
  const dir = tmp();
  const oldKek = randomBytes(32);
  const newKek = randomBytes(32);
  store(dir, oldKek).put("atlas", "a.com", { a: 1 }); // the canonical file for the slot
  // Copy that entry's record to a NON-canonical filename (a manual copy / duplicate slot). Both decrypt,
  // but put() only rewrites the canonical path, so the copy would otherwise survive under the OLD key.
  const [canonical] = readdirSync(dir).filter((n) => n.endsWith(".vault.json"));
  writeFileSync(join(dir, "copy-not-a-canonical-hash.vault.json"), readFileSync(join(dir, canonical)));
  assert.throws(() => rotateVaultKey(dir, oldKek, newKek, canonicalizeHost), /canonical slot path/);
  // Fail closed BEFORE any write: the canonical entry still opens under the OLD key (nothing rotated).
  assert.deepEqual(store(dir, oldKek).get("atlas", "a.com"), { a: 1 }, "no partial rotation");
  rmSync(dir, { recursive: true, force: true });
});

test("rotateVaultKey: REJECTS a NON-CANONICAL stored host (raw host would leave an old-key file, audit #8)", () => {
  const dir = tmp();
  const oldKek = randomBytes(32);
  const newKek = randomBytes(32);
  store(dir, oldKek).put("atlas", "a.com", { a: 1 }); // a good canonical entry
  // A record sealed for a RAW (non-canonical) host, stored at that raw host's slot path. Phase 2's put()
  // would canonicalize "A.COM." → "a.com" and write a DIFFERENT slot, leaving this file under the old key.
  const rec = sealJson({ x: 1 }, { kek: oldKek, consumerId: "atlas", host: "A.COM." });
  writeFileSync(slotFileName(dir, "atlas", "A.COM."), JSON.stringify({ consumerId: "atlas", host: "A.COM.", record: rec }) + "\n");
  assert.throws(() => rotateVaultKey(dir, oldKek, newKek, canonicalizeHost), /non-canonical host/);
  assert.deepEqual(store(dir, oldKek).get("atlas", "a.com"), { a: 1 }, "fail closed — nothing rotated");
  rmSync(dir, { recursive: true, force: true });
});

test("rotateVaultKey: REJECTS a symlinked or hard-linked entry file (an alias would keep old ciphertext, audit #8)", () => {
  const oldKek = randomBytes(32);
  const newKek = randomBytes(32);
  // Symlink: a canonical-named symlink to the real entry — Phase 2's rename replaces the LINK, not the target.
  const d1 = tmp();
  store(d1, oldKek).put("atlas", "a.com", { a: 1 });
  const [f1] = readdirSync(d1).filter((n) => n.endsWith(".vault.json"));
  renameSync(join(d1, f1), join(d1, "real-target")); // move the real file off the *.vault.json set
  symlinkSync(join(d1, "real-target"), join(d1, f1)); // canonical-named symlink → the real target
  assert.throws(() => rotateVaultKey(d1, oldKek, newKek, canonicalizeHost), /plain single-linked|symlink|hard link|non-regular/);
  rmSync(d1, { recursive: true, force: true });

  // Hard link: a second name for the same inode — rename leaves the other name on the old ciphertext.
  const d2 = tmp();
  store(d2, oldKek).put("atlas", "a.com", { a: 1 });
  const [f2] = readdirSync(d2).filter((n) => n.endsWith(".vault.json"));
  linkSync(join(d2, f2), join(d2, "hardlink-copy")); // f2 now has nlink=2
  assert.throws(() => rotateVaultKey(d2, oldKek, newKek, canonicalizeHost), /plain single-linked|symlink|hard link|non-regular/);
  rmSync(d2, { recursive: true, force: true });
});

test("rotateVaultKey: REJECTS an orphaned atomic-write temp (crashed write left old-key ciphertext, audit #8)", () => {
  const dir = tmp();
  const oldKek = randomBytes(32);
  const newKek = randomBytes(32);
  store(dir, oldKek).put("atlas", "a.com", { a: 1 });
  const [f] = readdirSync(dir).filter((n) => n.endsWith(".vault.json"));
  // Simulate a crash between put's temp-write and rename: an orphaned <slot>.vault.json.<hex>.tmp with
  // OLD-key ciphertext. Rotation enumerates only *.vault.json, so it would ignore this and "succeed".
  writeFileSync(join(dir, `${f}.abcdef012345.tmp`), readFileSync(join(dir, f)));
  assert.throws(() => rotateVaultKey(dir, oldKek, newKek, canonicalizeHost), /orphaned atomic-write temp|\.tmp/);
  // Fail closed: nothing rotated (the published entry still opens under the OLD key).
  assert.deepEqual(store(dir, oldKek).get("atlas", "a.com"), { a: 1 }, "no partial rotation while an orphan temp exists");
  rmSync(dir, { recursive: true, force: true });
});
