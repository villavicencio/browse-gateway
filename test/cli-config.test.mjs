/**
 * Obscura local-config tests (U1/KTD8) — file + env layering, fail-loud validation, and the
 * no-fleet-defaults guarantee (committed source must never supply a fleet identifier).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadObscuraConfig, requireConfig } from "../dist/cli/index.js";

function withConfigFile(contents) {
  const dir = mkdtempSync(join(tmpdir(), "obscura-config-"));
  const path = join(dir, "config.json");
  if (contents !== undefined) writeFileSync(path, contents);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("loads values from the config file", () => {
  const { path, cleanup } = withConfigFile(
    JSON.stringify({ adminSsh: "prod-admin", consumer: "consumer-1", gatewayHost: "127.0.0.1:9090" }),
  );
  try {
    const cfg = loadObscuraConfig({}, path);
    assert.equal(cfg.adminSsh, "prod-admin");
    assert.equal(cfg.consumer, "consumer-1");
    assert.equal(cfg.gatewayHost, "127.0.0.1:9090");
  } finally {
    cleanup();
  }
});

test("OBSCURA_* env overrides the file", () => {
  const { path, cleanup } = withConfigFile(JSON.stringify({ gatewayHost: "127.0.0.1:9090", consumer: "from-file" }));
  try {
    const cfg = loadObscuraConfig({ OBSCURA_GATEWAY_HOST: "127.0.0.1:7070", OBSCURA_ADMIN_SSH: "env-admin" }, path);
    assert.equal(cfg.gatewayHost, "127.0.0.1:7070", "env wins over file");
    assert.equal(cfg.consumer, "from-file", "file value survives when env is silent");
    assert.equal(cfg.adminSsh, "env-admin", "env can supply keys the file lacks");
  } finally {
    cleanup();
  }
});

test("a set-but-blank env var falls through to the file value instead of masking it", () => {
  const { path, cleanup } = withConfigFile(JSON.stringify({ adminSsh: "from-file" }));
  try {
    const cfg = loadObscuraConfig({ OBSCURA_ADMIN_SSH: "" }, path);
    assert.equal(cfg.adminSsh, "from-file");
  } finally {
    cleanup();
  }
});

test("missing required key errors by name with how to set it", () => {
  const { path, cleanup } = withConfigFile(undefined); // no file at all
  try {
    const cfg = loadObscuraConfig({}, path);
    assert.throws(() => requireConfig(cfg, "adminSsh"), /missing config "adminSsh".*OBSCURA_ADMIN_SSH/);
    assert.throws(() => requireConfig(cfg, "consumer"), /OBSCURA_CONSUMER/);
  } finally {
    cleanup();
  }
});

test("no fleet value is ever returned as a default", () => {
  const { path, cleanup } = withConfigFile(undefined);
  try {
    const cfg = loadObscuraConfig({}, path);
    // Fleet identifiers must be absent, not defaulted.
    assert.equal(cfg.adminSsh, undefined);
    assert.equal(cfg.tunnelHostName, undefined);
    assert.equal(cfg.consumer, undefined);
    assert.equal(cfg.remoteManifest, undefined);
    assert.equal(cfg.remoteEnvFile, undefined);
    // Protocol constants (already public in this repo) are the only defaults.
    assert.equal(cfg.gatewayHost, "127.0.0.1:8080");
    assert.equal(cfg.tunnelAlias, "browse-gateway-tunnel");
    assert.equal(cfg.container, "browse-gateway-http");
  } finally {
    cleanup();
  }
});

test("malformed file, unknown keys, and non-string values fail loudly", () => {
  const bad = withConfigFile("not json");
  try {
    assert.throws(() => loadObscuraConfig({}, bad.path), /not valid JSON/);
  } finally {
    bad.cleanup();
  }

  const unknown = withConfigFile(JSON.stringify({ adminSSH: "typo-case" }));
  try {
    assert.throws(() => loadObscuraConfig({}, unknown.path), /unknown key "adminSSH"/);
  } finally {
    unknown.cleanup();
  }

  const nonString = withConfigFile(JSON.stringify({ adminSsh: 42 }));
  try {
    assert.throws(() => loadObscuraConfig({}, nonString.path), /must be a non-empty string/);
  } finally {
    nonString.cleanup();
  }

  const array = withConfigFile("[]");
  try {
    assert.throws(() => loadObscuraConfig({}, array.path), /must be a JSON object/);
  } finally {
    array.cleanup();
  }
});

test("#53: healthToken loads from the file and OBSCURA_HEALTH_TOKEN overrides it", () => {
  const { path, cleanup } = withConfigFile(JSON.stringify({ healthToken: "from-file" }));
  try {
    assert.equal(loadObscuraConfig({}, path).healthToken, "from-file");
    assert.equal(loadObscuraConfig({ OBSCURA_HEALTH_TOKEN: "from-env" }, path).healthToken, "from-env");
  } finally {
    cleanup();
  }
});
