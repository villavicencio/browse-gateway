/**
 * Unit tests for the TOTP wrapper (U6 — credential vault Phase 2, assisted-login).
 *
 * Two concerns: (1) de-risk the new `otplib` dependency by asserting it reproduces the RFC-6238
 * Appendix-B SHA-1 reference vectors exactly — a future bump that broke conformance fails here; and
 * (2) lock our wrapper's contract — deterministic codes at a pinned epoch, seed normalization, the
 * ≥128-bit RFC floor, and that a bad seed never leaks into the thrown message.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateSync } from "otplib";
import {
  generateTotp,
  verifyTotp,
  isValidTotpSeed,
  normalizeTotpSeed,
  MIN_TOTP_SEED_BYTES,
} from "../dist/verbs/index.js";

// A 160-bit (32 Base32 char) seed — above the RFC-4226 / otplib 128-bit floor.
const SEED = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

test("otplib reproduces the RFC-6238 Appendix-B SHA-1 vectors (dependency conformance gate)", () => {
  // RFC secret is the ASCII bytes "12345678901234567890" (a raw key, not Base32) → pass as bytes.
  const secret = new TextEncoder().encode("12345678901234567890");
  const vectors = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
  ];
  for (const [epoch, expected] of vectors) {
    assert.equal(
      generateSync({ secret, algorithm: "sha1", digits: 8, period: 30, epoch }),
      expected,
      `RFC-6238 vector at t=${epoch}`,
    );
  }
});

test("generateTotp: deterministic 6-digit codes at a pinned epoch, distinct across the 30s step", () => {
  assert.equal(generateTotp(SEED, 1700000000), "406058");
  assert.equal(generateTotp(SEED, 1700000030), "661763");
  assert.equal(generateTotp(SEED, 1700000060), "996875");
  // same epoch → same code (pure); adjacent steps differ.
  assert.equal(generateTotp(SEED, 1700000000), generateTotp(SEED, 1700000000));
  assert.notEqual(generateTotp(SEED, 1700000000), generateTotp(SEED, 1700000030));
  assert.match(generateTotp(SEED, 1700000000), /^\d{6}$/);
});

test("normalizeTotpSeed: a spaced, lowercased seed yields the canonical code (apps display it that way)", () => {
  const asDisplayed = "jbsw y3dp ehpk 3pxp jbsw y3dp ehpk 3pxp";
  assert.equal(normalizeTotpSeed(asDisplayed), SEED);
  assert.equal(generateTotp(asDisplayed, 1700000000), "406058");
});

test("verifyTotp: a freshly generated code validates at the same epoch; a wrong code does not", () => {
  const code = generateTotp(SEED, 1700000000);
  assert.equal(verifyTotp(SEED, code, 1700000000), true);
  assert.equal(verifyTotp(SEED, "000000", 1700000000), false);
  assert.equal(verifyTotp(SEED, "not-a-code", 1700000000), false); // malformed → false, never throws
});

test("isValidTotpSeed: enforces Base32 charset + the ≥128-bit floor", () => {
  assert.equal(MIN_TOTP_SEED_BYTES, 16);
  assert.equal(isValidTotpSeed(SEED), true); // 160-bit
  assert.equal(isValidTotpSeed("jbsw y3dp ehpk 3pxp jbsw y3dp ehpk 3pxp"), true); // normalized first
  assert.equal(isValidTotpSeed("JBSWY3DPEHPK3PXP"), false); // 80-bit — below the RFC floor
  assert.equal(isValidTotpSeed("not base32 0189!"), false); // 0/1/8/9 and symbols aren't Base32
  assert.equal(isValidTotpSeed(""), false);
});

test("isValidTotpSeed: rejects an invalid Base32 quantum the decoder would reject (PR #29 P2 regression)", () => {
  // 27 chars passes a naive ⌊chars·5/8⌋≥16 byte-count check (16 bytes) AND the charset regex, but is
  // NOT a valid Base32 length — the real decoder throws "excess padding". A heuristic check would
  // accept it and the seed would only fail at first login. Authoritative validation rejects it.
  assert.equal(isValidTotpSeed("A".repeat(27)), false);
  assert.equal(isValidTotpSeed("A".repeat(32)), true); // a valid 32-char quantum (20 bytes) still passes
});

test("isValidTotpSeed never diverges from generateTotp (accepts exactly what generates)", () => {
  // The invariant the P2 was about: a seed is "valid" iff generateTotp can actually use it.
  const cases = [
    SEED,
    "JBSWY3DPEHPK3PXP", // 80-bit
    "A".repeat(27), // bad quantum
    "A".repeat(32), // good quantum
    "not base32 0189!",
    "",
    "MFRGGZDFMZTWQ2LKNNWG23TPOA======", // padded, valid
  ];
  for (const seed of cases) {
    let generates = true;
    try {
      generateTotp(seed, 0);
    } catch {
      generates = false;
    }
    assert.equal(isValidTotpSeed(seed), generates, `divergence for ${JSON.stringify(seed)}`);
  }
});

test("generateTotp: a too-short seed throws a clean, SECRET-FREE message (no seed in the error)", () => {
  const weak = "JBSWY3DPEHPK3PXP"; // 80-bit, otplib rejects
  assert.throws(
    () => generateTotp(weak, 1700000000),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /too short|invalid/i);
      assert.ok(!err.message.includes(weak), "the seed must never appear in the error message");
      assert.equal(err.cause, undefined, "no cause chain that could carry a decoder echo of the seed");
      return true;
    },
  );
});
