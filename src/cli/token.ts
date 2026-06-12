/**
 * Consumer token minting + env-key mapping for `obscura keys`. The env-key normalization is NOT
 * mirrored here — it is imported from the policy module, the frozen deployment contract the
 * gateway itself authenticates by, so the CLI can never drift from it.
 */
import { randomBytes } from "node:crypto";

export { tokenEnvKey } from "../policy/consumer-config.js";
import { tokenEnvKey } from "../policy/consumer-config.js";

/** 32 bytes of CSPRNG entropy, hex-encoded (64 chars) — the gateway treats it as opaque. */
export function mintToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Two distinct ids that normalize to the same `BGW_CONSUMER_TOKEN_<ID>` env key would silently
 * share a token slot — the gateway rejects that at boot, so reject it here at mint time instead.
 * Returns the existing id the candidate collides with, or `null`.
 */
export function envKeyCollision(candidateId: string, existingIds: string[]): string | null {
  const key = tokenEnvKey(candidateId);
  for (const existing of existingIds) {
    if (existing !== candidateId && tokenEnvKey(existing) === key) return existing;
  }
  return null;
}
