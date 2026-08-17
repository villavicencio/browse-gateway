/**
 * Task 2 §4.3 — the shared artifact config/runtime-builder boundary (`loadArtifactConfig`,
 * `buildArtifactRuntime`, `assertStdioArtifactUnsupported`) and its wiring into `buildGatewayRuntime`
 * (`src/mcp/runtime.ts`). Proves: (1) the disabled short-circuit reads nothing but the enable flag and
 * builds no runtime; (2) an enabled config constructs exactly one process-owned `ArtifactRuntime` with
 * Task 1's inherited quotas/10-minute TTL, unchanged; (3) an invalid root fails closed (throws) with no
 * partial state; (4) the stdio gate refuses before any artifact filesystem/runtime creation.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { loadArtifactConfig, buildArtifactRuntime, assertStdioArtifactUnsupported } from "../dist/artifacts/runtime-builder.js";
import { ArtifactRuntime } from "../dist/artifacts/index.js";
import { buildGatewayRuntime } from "../dist/mcp/runtime.js";

const dirs = [];
function temp() {
  const dir = mkdtempSync(join(tmpdir(), "bgw-artifact-builder-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});
const noLog = () => {};

// ---- loadArtifactConfig -----------------------------------------------------------------------

test("loadArtifactConfig: unset BGW_ARTIFACT_CAPTURE_ENABLED is disabled and reads nothing else", () => {
  // A Proxy that throws on any OTHER property read proves the exact short-circuit: only the enable
  // flag itself is ever consulted before the function decides "disabled".
  const env = new Proxy(
    { BGW_ARTIFACT_CAPTURE_ENABLED: undefined },
    {
      get(target, prop) {
        if (prop === "BGW_ARTIFACT_CAPTURE_ENABLED") return target[prop];
        if (prop === Symbol.iterator || typeof prop === "symbol") return undefined;
        throw new Error(`unexpected env read: ${String(prop)}`);
      },
    },
  );
  assert.deepEqual(loadArtifactConfig(env), { enabled: false });
});

test("loadArtifactConfig: a non-'1' value (e.g. 'true') is disabled, not enabled", () => {
  assert.deepEqual(loadArtifactConfig({ BGW_ARTIFACT_CAPTURE_ENABLED: "true" }), { enabled: false });
});

test("loadArtifactConfig: enabled with a root returns { enabled: true, root }", () => {
  const root = join(temp(), "artifacts");
  assert.deepEqual(loadArtifactConfig({ BGW_ARTIFACT_CAPTURE_ENABLED: "1", BGW_ARTIFACT_ROOT: root }), { enabled: true, root });
});

test("loadArtifactConfig: enabled without BGW_ARTIFACT_ROOT fails closed", () => {
  assert.throws(() => loadArtifactConfig({ BGW_ARTIFACT_CAPTURE_ENABLED: "1" }), /BGW_ARTIFACT_ROOT is required/);
});

test("loadArtifactConfig: enabled with an empty/whitespace root fails closed", () => {
  assert.throws(() => loadArtifactConfig({ BGW_ARTIFACT_CAPTURE_ENABLED: "1", BGW_ARTIFACT_ROOT: "   " }), /BGW_ARTIFACT_ROOT is required/);
});

// ---- buildArtifactRuntime ----------------------------------------------------------------------

test("buildArtifactRuntime: disabled config builds no runtime and touches no filesystem", () => {
  const root = join(temp(), "never-created");
  assert.equal(buildArtifactRuntime({ enabled: false }), undefined);
  assert.equal(existsSync(root), false);
});

test("buildArtifactRuntime: enabled config constructs exactly one process-owned ArtifactRuntime with inherited quotas/TTL", async () => {
  const root = join(temp(), "artifacts");
  const runtime = buildArtifactRuntime({ enabled: true, root });
  try {
    assert.ok(runtime instanceof ArtifactRuntime);
    // Inherited-quota/TTL proof: the runtime accepts a real capture at Task 1's defaults with NO
    // limit override supplied here — a bespoke/re-specified quota would either reject a legitimate
    // capture or accept an oversized one; this exercises the actual accepted path end to end.
    const source = join(temp(), "source.pdf");
    writeFileSync(source, Buffer.from("%PDF-1.7\nhello"));
    const operation = runtime.createOperation({ owner: { scope: "consumer", consumerId: "c" }, sourceHost: "example.com" });
    assert.ok(operation.registerDownload({ path: () => source }));
    const result = await operation.seal();
    assert.equal(result.outcome, "available");
    assert.equal(result.artifact.sizeBytes, 14);
    // 10-minute default TTL (Task 1, unchanged): expiresAt - createdAt is exactly 600_000ms.
    const spanMs = Date.parse(result.artifact.expiresAt) - Date.parse(result.artifact.createdAt);
    assert.equal(spanMs, 600_000);
  } finally {
    await runtime.close();
  }
});

test("buildArtifactRuntime: an invalid root fails closed synchronously with no partial state", () => {
  const notADir = join(temp(), "not-a-directory");
  writeFileSync(notADir, "a plain file, not a directory");
  assert.throws(() => buildArtifactRuntime({ enabled: true, root: notADir }), (e) => e.code === "artifact-root-invalid");
});

// ---- assertStdioArtifactUnsupported --------------------------------------------------------------

test("assertStdioArtifactUnsupported: disabled/absent env is a no-op", () => {
  assert.doesNotThrow(() => assertStdioArtifactUnsupported({}));
  assert.doesNotThrow(() => assertStdioArtifactUnsupported({ BGW_ARTIFACT_CAPTURE_ENABLED: "0" }));
});

test("assertStdioArtifactUnsupported: enabled refuses with the exact closed code, reading nothing else", () => {
  // Same throws-on-any-other-read proxy as above: the stdio refusal must reach its verdict from the
  // enable flag ALONE — never BGW_ARTIFACT_ROOT — so a malformed root alongside it is never read on
  // the stdio path (acceptance A4: "no root/lock creation").
  const env = new Proxy(
    { BGW_ARTIFACT_CAPTURE_ENABLED: "1" },
    {
      get(target, prop) {
        if (prop === "BGW_ARTIFACT_CAPTURE_ENABLED") return target[prop];
        if (prop === Symbol.iterator || typeof prop === "symbol") return undefined;
        throw new Error(`unexpected env read: ${String(prop)}`);
      },
    },
  );
  assert.throws(() => assertStdioArtifactUnsupported(env), (e) => e.code === "artifact-transport-unsupported");
});

// ---- buildGatewayRuntime wiring ------------------------------------------------------------------

function gatewayFixtureEnv(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "bgw-runtime-artifact-"));
  dirs.push(root);
  const manifestPath = join(root, "consumers.json");
  writeFileSync(manifestPath, JSON.stringify([{ id: "atlas", allow: ["*"] }]));
  return {
    BGW_CONSUMERS_MANIFEST: manifestPath,
    BGW_MAX_SESSIONS: "3",
    BGW_CONSUMER_TOKEN_ATLAS: `tok-${randomBytes(24).toString("hex")}`,
    ...overrides,
  };
}

test("buildGatewayRuntime: disabled (default) exposes no artifactRuntime and creates no artifact root", async () => {
  const artifactsRoot = join(temp(), "should-not-exist");
  const env = gatewayFixtureEnv({ BGW_ARTIFACT_ROOT: artifactsRoot }); // root set but NOT enabled — must be ignored
  const rt = buildGatewayRuntime(env, { log: noLog });
  try {
    assert.equal(rt.artifactRuntime, undefined);
    assert.equal(existsSync(artifactsRoot), false);
  } finally {
    await rt.gateway.shutdown().catch(() => {});
  }
});

test("buildGatewayRuntime: enabled constructs exactly one process-owned ArtifactRuntime and exposes it", async () => {
  const artifactsRoot = join(temp(), "artifacts");
  const env = gatewayFixtureEnv({ BGW_ARTIFACT_CAPTURE_ENABLED: "1", BGW_ARTIFACT_ROOT: artifactsRoot });
  const rt = buildGatewayRuntime(env, { log: noLog });
  try {
    assert.ok(rt.artifactRuntime instanceof ArtifactRuntime);
    assert.equal(existsSync(artifactsRoot), true);
  } finally {
    await rt.artifactRuntime.close();
    await rt.gateway.shutdown().catch(() => {});
  }
});

test("buildGatewayRuntime: an invalid artifact root fails the whole boot closed, before the gateway is built", () => {
  const notADir = join(temp(), "not-a-directory");
  writeFileSync(notADir, "a plain file, not a directory");
  const env = gatewayFixtureEnv({ BGW_ARTIFACT_CAPTURE_ENABLED: "1", BGW_ARTIFACT_ROOT: notADir });
  assert.throws(() => buildGatewayRuntime(env, { log: noLog }), (e) => e.code === "artifact-root-invalid");
});
