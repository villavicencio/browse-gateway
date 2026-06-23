/**
 * Shared gateway runtime tests (U8b) — `buildGatewayRuntime` constructs the authenticated,
 * policy-guarded Gateway from env and enforces every fail-closed boot guard. No Chrome is launched
 * (Gateway.create builds the SessionManager lazily; a browser only spawns on the first session), so
 * this is a fast unit test of the extracted boot wiring that http-main and vault-host both depend on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { buildGatewayRuntime } from "../dist/mcp/runtime.js";

const noLog = () => {};

function fixtureEnv(overrides = {}, { withVaultKey = true, manifest = [{ id: "atlas", allow: ["*"] }] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "bgw-runtime-"));
  const manifestPath = join(root, "consumers.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const keyFile = join(root, "vault.key");
  writeFileSync(keyFile, randomBytes(32).toString("base64"));
  chmodSync(keyFile, 0o600);
  const env = {
    BGW_CONSUMERS_MANIFEST: manifestPath,
    BGW_MAX_SESSIONS: "3",
    BGW_VAULT_DIR: join(root, "vault"),
    ...(withVaultKey ? { BGW_VAULT_KEY_FILE: keyFile } : {}),
    ...Object.fromEntries(manifest.map((m) => [`BGW_CONSUMER_TOKEN_${m.id.toUpperCase()}`, `tok-${m.id}-${"z".repeat(40)}`])),
    ...overrides,
  };
  return { env, root, keyFile, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("builds a runtime from a valid env: gateway, specs, vault, escalation posture", async () => {
  const fx = fixtureEnv({ BGW_ON_DATACENTER_IP: "1", BGW_DIAG_VERIFY_EGRESS: "1" });
  try {
    const rt = buildGatewayRuntime(fx.env, { log: noLog });
    assert.ok(rt.gateway, "gateway constructed");
    assert.ok(rt.policy, "policy constructed");
    assert.equal(rt.registry.size, 1);
    assert.deepEqual(rt.specs.map((s) => s.id), ["atlas"]);
    assert.ok(rt.vault, "vault opened (key present)");
    assert.equal(rt.onDatacenterIp, true);
    assert.equal(rt.verifyEgress, true);
    assert.equal(rt.stickySuffix, undefined);
    await rt.gateway.shutdown().catch(() => {});
  } finally {
    fx.cleanup();
  }
});

test("vault dormant: dir set, no key, no entries → vault is null, no throw", async () => {
  const fx = fixtureEnv({}, { withVaultKey: false });
  try {
    const rt = buildGatewayRuntime(fx.env, { log: noLog });
    assert.equal(rt.vault, null);
    await rt.gateway.shutdown().catch(() => {});
  } finally {
    fx.cleanup();
  }
});

test("fail-closed: pool too small for the consumer count", () => {
  const fx = fixtureEnv(
    { BGW_MAX_SESSIONS: "1" },
    { manifest: [{ id: "atlas", allow: ["*"] }, { id: "argus", allow: ["*"] }] },
  );
  try {
    assert.throws(() => buildGatewayRuntime(fx.env, { log: noLog }), /too low for 2 consumer/);
  } finally {
    fx.cleanup();
  }
});

test("fail-closed: a sticky suffix without {id} is rejected (silent rotation kill)", () => {
  const fx = fixtureEnv({ BGW_PROXY_STICKY_SUFFIX: "_session-static" });
  try {
    assert.throws(() => buildGatewayRuntime(fx.env, { log: noLog }), /\{id\}|sticky/i);
  } finally {
    fx.cleanup();
  }
});

test("fail-closed: BGW_CONSUMERS_MANIFEST is required", () => {
  const fx = fixtureEnv();
  try {
    const { BGW_CONSUMERS_MANIFEST, ...env } = fx.env;
    assert.throws(() => buildGatewayRuntime(env, { log: noLog }), /BGW_CONSUMERS_MANIFEST is required/);
  } finally {
    fx.cleanup();
  }
});

test("fail-closed: vault entries on disk but no master key refuses to boot", () => {
  const root = mkdtempSync(join(tmpdir(), "bgw-runtime-bootguard-"));
  try {
    const manifestPath = join(root, "consumers.json");
    writeFileSync(manifestPath, JSON.stringify([{ id: "atlas", allow: ["*"] }]));
    const vaultDir = join(root, "vault");
    mkdirSync(vaultDir, { recursive: true });
    writeFileSync(join(vaultDir, "deadbeef.vault.json"), "{}"); // an entry on disk, no key configured
    const env = {
      BGW_CONSUMERS_MANIFEST: manifestPath,
      BGW_MAX_SESSIONS: "3",
      BGW_VAULT_DIR: vaultDir,
      BGW_CONSUMER_TOKEN_ATLAS: `tok-${"z".repeat(40)}`,
    };
    assert.throws(() => buildGatewayRuntime(env, { log: noLog }), /no master key|refusing to boot/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
