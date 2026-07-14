/**
 * Vault crypto (U3) — the AES-256-GCM envelope: round-trip, authentication (tamper/wrong-key),
 * AAD slot-binding (no cross-consumer/host transplant, injective even with odd field bytes), nonce
 * freshness, version + shape guards. All pure, no I/O. KEKs are random 32-byte buffers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  seal,
  open,
  sealJson,
  openJson,
  decodeMasterKey,
  VAULT_SCHEMA_VERSION,
} from "../dist/security/index.js";

const KEK = randomBytes(32);
const CTX = { kek: KEK, consumerId: "atlas", host: "example.com" };

test("round-trips empty, small, and large payloads", () => {
  for (const pt of ["", "hello", "x".repeat(100_000)]) {
    assert.equal(open(seal(pt, CTX), CTX).toString("utf8"), pt);
  }
  const bytes = randomBytes(4096);
  assert.ok(open(seal(bytes, CTX), CTX).equals(bytes));
  const state = { cookies: [{ name: "sid", value: "abc" }], origins: [{ origin: "https://example.com" }] };
  assert.deepEqual(openJson(sealJson(state, CTX), CTX), state);
});

test("authentication: a single flipped ciphertext byte fails open()", () => {
  const rec = seal("secret-session", CTX);
  const ct = Buffer.from(rec.blob.ct, "base64");
  ct[0] ^= 0x01;
  const tampered = { ...rec, blob: { ...rec.blob, ct: ct.toString("base64") } };
  assert.throws(() => open(tampered, CTX), /unable to authenticate|bad decrypt|Unsupported state/i);
});

test("authentication: a tampered wrapped-DEK fails open()", () => {
  const rec = seal("secret", CTX);
  const dekCt = Buffer.from(rec.dek.ct, "base64");
  dekCt[0] ^= 0xff;
  const tampered = { ...rec, dek: { ...rec.dek, ct: dekCt.toString("base64") } };
  assert.throws(() => open(tampered, CTX));
});

test("AAD slot-binding: a record cannot be transplanted to another consumer or host", () => {
  const rec = seal("atlas-on-example", CTX);
  assert.throws(() => open(rec, { kek: KEK, consumerId: "vault", host: "example.com" }));
  assert.throws(() => open(rec, { kek: KEK, consumerId: "atlas", host: "other.com" }));
  assert.equal(open(rec, CTX).toString("utf8"), "atlas-on-example");
});

test("AAD is INJECTIVE across the consumer/host boundary — a space in a field can't collide slots", () => {
  // Two DISTINCT slots a naive space-join would map to the SAME AAD ("...atlas x.com y.com").
  const recA = seal("A", { kek: KEK, consumerId: "atlas", host: "x.com y.com" });
  assert.throws(() => open(recA, { kek: KEK, consumerId: "atlas x.com", host: "y.com" }), /authenticate|decrypt/i);
  assert.equal(open(recA, { kek: KEK, consumerId: "atlas", host: "x.com y.com" }).toString("utf8"), "A");
});

test("slot fields reject NUL / control characters and empties", () => {
  const NUL = String.fromCharCode(0);
  const SOH = String.fromCharCode(1);
  assert.throws(() => seal("x", { kek: KEK, consumerId: "atlas", host: "a" + NUL + "b.com" }), /control characters/);
  assert.throws(() => seal("x", { kek: KEK, consumerId: "at" + SOH + "las", host: "a.com" }), /control characters/);
  assert.throws(() => seal("x", { kek: KEK, consumerId: "", host: "a.com" }), /non-empty/);
});

test("AAD injectivity: ill-formed Unicode (lone surrogates) is REJECTED, not collapsed to one AAD", () => {
  // Buffer.from(x, "utf8") maps EVERY lone surrogate to the same replacement bytes (EF BF BD), so
  // without a guard consumerId "\uD800" and "\uD801" would share an AAD — a record sealed under one
  // could open under the other (a cross-slot transplant). Both must fail closed at seal AND open time.
  const HI = "\uD800"; // lone high surrogate
  const HI2 = "\uD801"; // a DIFFERENT lone high surrogate — same UTF-8 replacement bytes as HI
  const LO = "\uDC00"; // lone low surrogate
  assert.throws(() => seal("x", { kek: KEK, consumerId: HI, host: "a.com" }), /ill-formed Unicode/);
  assert.throws(() => seal("x", { kek: KEK, consumerId: HI2, host: "a.com" }), /ill-formed Unicode/);
  assert.throws(() => seal("x", { kek: KEK, consumerId: "atlas", host: "a" + LO + ".com" }), /ill-formed Unicode/);
  assert.throws(() => open(seal("x", CTX), { kek: KEK, consumerId: HI, host: "example.com" }), /ill-formed Unicode/);
  // A well-formed astral scalar (a PROPER surrogate pair, U+1F600 😀) round-trips losslessly → accepted.
  const pair = "😀.example";
  const rec = seal("emoji-ok", { kek: KEK, consumerId: "atlas", host: pair });
  assert.equal(open(rec, { kek: KEK, consumerId: "atlas", host: pair }).toString("utf8"), "emoji-ok");
});

test("wrong master key fails open()", () => {
  const rec = seal("secret", CTX);
  assert.throws(() => open(rec, { kek: randomBytes(32), consumerId: "atlas", host: "example.com" }));
});

test("rejects a wrong-sized master key on seal and open", () => {
  assert.throws(() => seal("x", { kek: randomBytes(16), consumerId: "atlas", host: "example.com" }), /must be 32 bytes/);
  const rec = seal("x", CTX);
  assert.throws(() => open(rec, { kek: randomBytes(31), consumerId: "atlas", host: "example.com" }), /must be 32 bytes/);
});

test("nonce + DEK freshness: every seal uses distinct nonces (no fixed-nonce reuse)", () => {
  const N = 1000;
  const blobNonces = new Set();
  const dekNonces = new Set();
  const dekCts = new Set();
  for (let i = 0; i < N; i++) {
    const rec = seal("same-plaintext-every-time", CTX);
    blobNonces.add(rec.blob.nonce);
    dekNonces.add(rec.dek.nonce);
    dekCts.add(rec.dek.ct);
  }
  assert.equal(blobNonces.size, N, "blob nonces all distinct");
  assert.equal(dekNonces.size, N, "DEK-wrap nonces all distinct");
  assert.equal(dekCts.size, N, "a fresh DEK per seal → distinct wrapped ciphertexts");
});

test("version guard: an unsupported record version is refused explicitly (not a silent wrong-key)", () => {
  const rec = seal("x", CTX);
  const future = { ...rec, v: VAULT_SCHEMA_VERSION + 1 };
  assert.throws(() => open(future, CTX), /unsupported record version/);
});

test("shape guard: an unauthenticated / malformed record is refused before decrypt", () => {
  assert.throws(() => open({ v: VAULT_SCHEMA_VERSION, blob: { nonce: "a", ct: "b", tag: "c" } }, CTX), /missing dek\/blob/);
  assert.throws(() => open({ v: VAULT_SCHEMA_VERSION, dek: {}, blob: {} }, CTX), /missing dek\/blob/);
  assert.throws(() => open({ dek: { nonce: "a", ct: "b", tag: "c" }, blob: { nonce: "a", ct: "b", tag: "c" } }, CTX), /missing numeric version/);
  const rec = seal("x", CTX);
  const noTag = { ...rec, blob: { ...rec.blob, tag: Buffer.alloc(4).toString("base64") } };
  assert.throws(() => open(noTag, CTX), /auth-tag length|unauthenticated/);
});

test("decodeMasterKey accepts a 32-byte base64 key and rejects the wrong size", () => {
  const key = randomBytes(32);
  assert.ok(decodeMasterKey(key.toString("base64")).equals(key));
  assert.ok(decodeMasterKey(`  ${key.toString("base64")}\n`).equals(key), "trims surrounding whitespace");
  assert.throws(() => decodeMasterKey(randomBytes(16).toString("base64")), /must be 32 bytes/);
});
