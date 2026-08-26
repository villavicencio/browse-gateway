/**
 * U1 — the gateway's contract version and deploy stamp are RESOLVED, never a literal, and a gateway
 * that cannot state its version refuses to boot.
 *
 * Every RED here is constructed AT THE SOURCE — an actual directory with no or malformed manifest handed to
 * the resolver — rather than by feeding a bad string to a matcher. A guard whose stub guarantees the
 * assertion proves nothing; see
 * docs/solutions/best-practices/a-test-whose-stub-guarantees-the-assertion-proves-nothing.md.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createGatewayMcpServer, resolveGatewayVersion } from "../dist/mcp/index.js";

const repoRoot = new URL("..", import.meta.url).pathname;
const manifestVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;

/** A throwaway app-root, so a RED is a real unreadable/malformed manifest rather than a stubbed one. */
function scratchRoot(files) {
  const dir = mkdtempSync(join(tmpdir(), "bgw-version-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

test("resolves the exact version the shipped manifest carries", () => {
  const v = resolveGatewayVersion(repoRoot);
  assert.equal(v.contractVersion, manifestVersion);
  assert.match(v.contractVersion, /^\d+\.\d+\.\d+$/);
});

test("R1 — the project is at 1.0.0, not 0.x", () => {
  assert.equal(manifestVersion, "1.0.0");
});

test("a client reads the resolved version over a real in-memory transport", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createGatewayMcpServer({ retrieve: async () => ({ markdown: "x" }) });
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  assert.equal(client.getServerVersion().version, resolveGatewayVersion(repoRoot).reported);
  await client.close();
});

test("an explicitly injected version still wins over the resolver", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createGatewayMcpServer({ version: "9.9.9", retrieve: async () => ({ markdown: "x" }) });
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  assert.equal(client.getServerVersion().version, "9.9.9");
  await client.close();
});

// --- fail-closed: RED constructed at the source ---

test("an UNREADABLE manifest refuses to resolve rather than serving an unversioned gateway", () => {
  const dir = scratchRoot({}); // no package.json at all
  try {
    assert.throws(() => resolveGatewayVersion(dir), /cannot read .*package\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a MALFORMED manifest refuses the same way", () => {
  const dir = scratchRoot({ "package.json": "{ not json" });
  try {
    assert.throws(() => resolveGatewayVersion(dir), /not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a manifest with no usable version refuses — including a non-bare-semver one", () => {
  for (const body of ['{"name":"x"}', '{"version":42}', '{"version":"1.0"}', '{"version":"1.0.0+abc"}']) {
    const dir = scratchRoot({ "package.json": body });
    try {
      assert.throws(() => resolveGatewayVersion(dir), /no usable "version"/, `should refuse: ${body}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// --- the deploy stamp (KTD9) ---

test("an UNSTAMPED build reports a bare semver and no deploy id", () => {
  const dir = scratchRoot({ "package.json": '{"version":"1.2.3"}' });
  try {
    const v = resolveGatewayVersion(dir);
    assert.equal(v.deployId, undefined);
    assert.equal(v.reported, "1.2.3");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a STAMPED build reports semver + build metadata", () => {
  const dir = scratchRoot({ "package.json": '{"version":"1.2.3"}', ".deploy-id": "a1b2c3d4e5f6" });
  try {
    const v = resolveGatewayVersion(dir);
    assert.equal(v.deployId, "a1b2c3d4e5f6");
    assert.equal(v.reported, "1.2.3+a1b2c3d4e5f6");
    // The opacity shape U4 guards. Build metadata is valid semver (spec §10).
    assert.match(v.reported, /^\d+\.\d+\.\d+\+[0-9a-f]{12}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a MALFORMED stamp refuses to boot rather than reporting a non-identity", () => {
  // A corrupt stamp is worse than an absent one: a consumer would treat it as an identity.
  for (const bad of ["nothexatall", "A1B2C3D4E5F6", "a1b2c3", "a1b2c3d4e5f6f7", "", "sha256:abc"]) {
    const dir = scratchRoot({ "package.json": '{"version":"1.2.3"}', ".deploy-id": bad });
    try {
      assert.throws(() => resolveGatewayVersion(dir), /deploy stamp must be 12 lowercase hex/, `should refuse: ${JSON.stringify(bad)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("the stamp is stable for one image and differs across images", () => {
  const a1 = scratchRoot({ "package.json": '{"version":"1.2.3"}', ".deploy-id": "aaaaaaaaaaaa" });
  const a2 = scratchRoot({ "package.json": '{"version":"1.2.3"}', ".deploy-id": "bbbbbbbbbbbb" });
  try {
    // Same root read twice == same deployment: a consumer comparing two calls sees equality.
    assert.equal(resolveGatewayVersion(a1).reported, resolveGatewayVersion(a1).reported);
    // A different build == a different id, which is the whole point of VIL-112.
    assert.notEqual(resolveGatewayVersion(a1).reported, resolveGatewayVersion(a2).reported);
  } finally {
    rmSync(a1, { recursive: true, force: true });
    rmSync(a2, { recursive: true, force: true });
  }
});

test("the resolved version never carries an infrastructure identifier (R7)", () => {
  const reported = resolveGatewayVersion(repoRoot).reported;
  assert.doesNotMatch(reported, /sha256:/);
  assert.doesNotMatch(reported, /[A-Z]/);       // no host/container names
  assert.doesNotMatch(reported, /[_/]/);
  assert.match(reported, /^\d+\.\d+\.\d+(\+[0-9a-f]{12})?$/);
});

// --- the round-2 regression guard ---

test("REGRESSION: the HTTP launcher resolves the version at BOOT, not per connection", () => {
  // The defect this locks out, verified in the tree before it was fixed: `createGatewayMcpServer({
  // version: "0.1.0" })` sat inside `buildServer:`, the PER-CONNECTION callback that runs after
  // bearer auth. A version resolver there throws a per-session 500, not a refused boot — and BOTH
  // deploy checks probe only UNAUTHENTICATED /mcp expecting 401, so neither would ever reach it. It
  // would look fail-closed and gate nothing.
  //
  // This is a STRUCTURAL guard on the compiled launcher, and deliberately labelled as one: the
  // behavioural version (spawn the launcher against a broken manifest, assert it never prints
  // `listening on`) needs a full consumer manifest + env fixture, because `buildGatewayRuntime` runs
  // first and would fail for unrelated reasons. A test that appeared behavioural but tripped on the
  // wrong guard would prove less than this does. Placement is the thing that regresses; placement is
  // what this asserts.
  const compiled = readFileSync(join(repoRoot, "dist/mcp/http-main.js"), "utf8");

  const resolveAt = compiled.indexOf("resolveGatewayVersion(");
  const buildServerAt = compiled.indexOf("buildServer:");
  assert.notEqual(resolveAt, -1, "the launcher must resolve the gateway version");
  assert.notEqual(buildServerAt, -1, "expected a buildServer: per-connection callback");
  assert.ok(
    resolveAt < buildServerAt,
    "resolveGatewayVersion() must run at BOOT, before the per-connection buildServer callback — " +
      "moving it inside makes an unreadable manifest a per-session 500 that no deploy check can see",
  );

  // Exactly once: a second call site inside the callback would satisfy the ordering check above
  // while reintroducing the per-connection read.
  const calls = compiled.split("resolveGatewayVersion(").length - 1;
  assert.equal(calls, 1, `expected exactly one resolveGatewayVersion() call in the launcher, found ${calls}`);

  // And the boot line must actually carry it, or KTD13's pre-swap-smoke gate has nothing to grep.
  assert.match(compiled, /version=\$\{.*?\}/, "the boot line must emit version=");
  assert.ok(compiled.includes("deploy="), "the boot line must emit deploy=");
});
