/**
 * TOTP (RFC 6238) wrapper for the assisted-login flow (U6 / KTD-6). `otplib` v13 is the maintained,
 * RFC-conformant library (speakeasy has been abandoned since 2016). A 2FA "setup key" is a
 * Base32-encoded shared secret; when a target prompts for a second factor during assisted login we
 * generate the current 6-digit code from the operator-provided seed.
 *
 * SECURITY (KTD-6): co-locating the seed with the password collapses 2FA to a single factor for
 * unattended automation — an accepted, documented trade-off (the seed buys anti-credential-stuffing,
 * not a true second factor). The seed is credential-grade: stored encrypted at password sensitivity
 * (U4), folded into the redaction set, and a generated code is NEVER logged. This module persists
 * nothing and logs nothing; on a bad seed it throws a re-wrapped, secret-free message so neither the
 * seed nor an underlying decoder error carrying it can reach a log.
 */
import { generateSync, verifySync } from "otplib";

/**
 * RFC 4226 floor, enforced by otplib v13: the shared secret MUST be ≥128 bits (16 bytes ≈ 26 Base32
 * chars). The common 80-bit / 16-char "Google Authenticator" seed is below it and is rejected — we
 * surface that as up-front validation ({@link isValidTotpSeed}) instead of a first-login throw.
 */
export const MIN_TOTP_SEED_BYTES = 16;

/**
 * Canonicalize a seed as the operator pastes it: authenticator apps display Base32 in lowercase,
 * space-separated groups. Strip all whitespace and uppercase so the Base32 decoder sees canonical
 * input (and a spaced/lowercase copy generates the same code as the canonical form).
 */
export function normalizeTotpSeed(seed: string): string {
  return seed.replace(/\s+/g, "").toUpperCase();
}

/**
 * Up-front check that the vault import path can use to reject a malformed/weak `seed` with a clear
 * message rather than failing at first login.
 *
 * AUTHORITATIVE by construction: it runs the SAME path {@link generateTotp} uses — the real Base32
 * decode (scure) plus otplib's ≥128-bit guardrail — and reports whether that path succeeds. A char
 * count + bit-count heuristic is necessary-but-NOT-sufficient: it would accept strings the decoder
 * rejects (e.g. an invalid Base32 quantum / excess padding like `"A".repeat(27)`), so a caller could
 * store a seed that then throws at login. Delegating removes any chance of that divergence.
 */
export function isValidTotpSeed(seed: string): boolean {
  try {
    generateTotp(seed, 0); // epoch pinned for determinism; the generated code is discarded
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate the current 6-digit TOTP code for a Base32 `seed`. `atSeconds` pins the Unix time (in
 * SECONDS) for deterministic tests; omitted = now. Throws a clean, SECRET-FREE error on a malformed
 * or too-short seed — otplib's own errors are byte-count/format only (verified not to echo the
 * secret), but we re-wrap WITHOUT a `cause` chain so a future decoder message that did echo input
 * could never ride out in an error log.
 */
export function generateTotp(seed: string, atSeconds?: number): string {
  const secret = normalizeTotpSeed(seed);
  try {
    return generateSync(atSeconds === undefined ? { secret } : { secret, epoch: atSeconds });
  } catch {
    throw new Error(
      `TOTP seed is invalid or too short (expected a Base32 secret of ≥${MIN_TOTP_SEED_BYTES} bytes / 128 bits)`,
    );
  }
}

/**
 * Verify `token` against `seed` at `atSeconds` (or now). Thin wrapper for the round-trip test and a
 * future refresh-on-expiry check; returns `false` on any malformed input rather than throwing.
 */
export function verifyTotp(seed: string, token: string, atSeconds?: number): boolean {
  try {
    const secret = normalizeTotpSeed(seed);
    const res = verifySync(
      atSeconds === undefined ? { secret, token } : { secret, token, epoch: atSeconds },
    );
    return res.valid === true;
  } catch {
    return false;
  }
}
