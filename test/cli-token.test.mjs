/**
 * Obscura token tests (U3) — CSPRNG mint shape, the env-key contract (imported from policy, not
 * mirrored), and mint-time collision detection.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mintToken, tokenEnvKey, envKeyCollision } from "../dist/cli/index.js";
import { tokenEnvKey as policyTokenEnvKey } from "../dist/policy/index.js";

test("mintToken is 32 bytes of hex and never repeats", () => {
  const a = mintToken();
  const b = mintToken();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});

test("tokenEnvKey IS the policy module's normalization (same function, no drift possible)", () => {
  assert.equal(tokenEnvKey, policyTokenEnvKey);
  assert.equal(tokenEnvKey("consumer-1"), "BGW_CONSUMER_TOKEN_CONSUMER_1");
  assert.equal(tokenEnvKey("a.b-c"), "BGW_CONSUMER_TOKEN_A_B_C");
  assert.equal(tokenEnvKey("a..b"), "BGW_CONSUMER_TOKEN_A_B", "runs collapse to one underscore");
});

test("envKeyCollision flags two ids normalizing to one key", () => {
  assert.equal(envKeyCollision("a.b", ["a-b", "other"]), "a-b");
  assert.equal(envKeyCollision("consumer-2", ["consumer-1"]), null);
  assert.equal(envKeyCollision("same", ["same"]), null, "the id itself is not a collision");
});
