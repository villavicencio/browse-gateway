/**
 * U7a provisioning tests — the pure manifest+token loader (no filesystem) and the SecretStore
 * redaction extension that keeps consumer bearer tokens out of logs/audit/errors (R9). The live
 * HTTP path is exercised by http-server.test.mjs (unit) and scripts/validate-http.mjs (in-container).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenEnvKey, parseConsumerManifest, buildConsumerSpecs } from "../dist/policy/index.js";
import { SecretStore, redactSecrets } from "../dist/security/index.js";
import { poolSizingError } from "../dist/gateway/index.js";

test("tokenEnvKey normalizes ids to a BGW_CONSUMER_TOKEN_<ID> env key", () => {
  assert.equal(tokenEnvKey("atlas"), "BGW_CONSUMER_TOKEN_ATLAS");
  assert.equal(tokenEnvKey("agent-1"), "BGW_CONSUMER_TOKEN_AGENT_1");
  assert.equal(tokenEnvKey("a.b c"), "BGW_CONSUMER_TOKEN_A_B_C");
});

test("parseConsumerManifest accepts a valid array and rejects malformed shapes", () => {
  const m = parseConsumerManifest('[{"id":"a","allow":["x.com"],"tags":["t"]}]');
  assert.equal(m.length, 1);
  assert.equal(m[0].id, "a");
  assert.deepEqual(m[0].allow, ["x.com"]);
  assert.throws(() => parseConsumerManifest("not json"), /not valid JSON/);
  assert.throws(() => parseConsumerManifest('{"id":"a"}'), /must be a JSON array/);
  assert.throws(() => parseConsumerManifest('[{"allow":["x"]}]'), /has no id/);
  assert.throws(() => parseConsumerManifest('[{"id":"a","allow":"x"}]'), /invalid allow/);
  assert.throws(() => parseConsumerManifest('[{"id":"a","allow":["x"],"tags":"t"}]'), /invalid tags/);
});

test("buildConsumerSpecs joins tokens from env and fails closed on every gap", () => {
  const manifest = [
    { id: "atlas", allow: ["x.com"] },
    { id: "agent-1", allow: ["y.com"] },
  ];
  const env = { BGW_CONSUMER_TOKEN_ATLAS: "tok-A", BGW_CONSUMER_TOKEN_AGENT_1: "tok-B" };
  const { specs, tokens } = buildConsumerSpecs(manifest, env);
  assert.equal(specs.length, 2);
  assert.deepEqual([...tokens].sort(), ["tok-A", "tok-B"]);
  assert.equal(specs[0].token, "tok-A");

  assert.throws(
    () => buildConsumerSpecs(manifest, { BGW_CONSUMER_TOKEN_ATLAS: "tok-A" }),
    /missing bearer token for consumer agent-1/,
  );
  assert.throws(() => buildConsumerSpecs([], env), /empty/);
  assert.throws(
    () => buildConsumerSpecs([{ id: "z", allow: [] }], { BGW_CONSUMER_TOKEN_Z: "t" }),
    /empty allowlist/,
  );
  assert.throws(
    () => buildConsumerSpecs([{ id: "a", allow: ["x"] }, { id: "a", allow: ["y"] }], { BGW_CONSUMER_TOKEN_A: "t" }),
    /duplicate consumer id/,
  );
  // Two distinct ids that normalize to the same env key must be rejected (no silent token sharing).
  assert.throws(
    () => buildConsumerSpecs([{ id: "a-b", allow: ["x"] }, { id: "a.b", allow: ["y"] }], { BGW_CONSUMER_TOKEN_A_B: "t" }),
    /collide on token env key/,
  );
});

test("poolSizingError refuses an under-sized pool (boot guard), passes a sized one", () => {
  // 2 consumers × perConsumerMax 1 + 1 retrieve headroom = 3 required.
  assert.match(poolSizingError(2, 1, 2), /too low for 2 consumer/);
  assert.match(poolSizingError(2, 1, 2), /need >= 3/);
  assert.equal(poolSizingError(2, 1, 3), null, "exactly sized pool boots");
  assert.equal(poolSizingError(2, 1, 5), null, "over-sized pool boots");
  // perConsumerMax scales the floor.
  assert.match(poolSizingError(3, 2, 5), /need >= 7/);
  assert.equal(poolSizingError(3, 2, 7), null);
});

test("SecretStore.addRedactable folds consumer tokens into redaction (R9) and survives rotation", () => {
  const store = new SecretStore(() => ({}));
  const token = "consumer-token-abcdef";
  // Not yet registered -> passes through unredacted.
  assert.equal(redactSecrets(`Authorization: Bearer ${token}`, store), `Authorization: Bearer ${token}`);
  store.addRedactable([token]);
  assert.equal(redactSecrets(`Authorization: Bearer ${token}`, store), "Authorization: Bearer [REDACTED]");
  // A later proxy-secret rotation (reload) must not un-redact a previously registered token.
  store.reload();
  assert.equal(redactSecrets(`leaked ${token}`, store), "leaked [REDACTED]");
});
