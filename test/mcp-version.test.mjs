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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createGatewayMcpServer, resolveGatewayVersion, isOpaqueVersion, REPORTED_VERSION } from "../dist/mcp/index.js";

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

test("R1 — the project is past 0.x", () => {
  // The invariant is the STABILITY signal, not a particular release: pinning the exact string made
  // every additive contract change (VIL-122 was the first) edit this test for no behavioural reason.
  const [major] = manifestVersion.split(".").map(Number);
  assert.ok(major >= 1, `expected a 1.x-or-later contract version, got ${manifestVersion}`);
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
  for (const body of [
    '{"name":"x"}',
    '{"version":42}',
    '{"version":"1.0"}',
    '{"version":"1.0.0+abc"}',
    // Leading zeros are NOT valid semver (spec: numeric identifiers must not include them). Accepting
    // one would boot the gateway and report an invalid version over MCP. (CodeRabbit, PR #142.)
    '{"version":"01.2.3"}',
    '{"version":"1.02.3"}',
    '{"version":"1.2.03"}',
  ]) {
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

// --- U4: the opacity guard (R7) ---
//
// The subject is what a CONSUMER is advertised, not what the resolver returns. Those are different
// values: `createGatewayMcpServer({ version })` bypasses the resolver entirely (the injection test
// above proves it wins), so a guard that only reads `resolveGatewayVersion().reported` cannot see the
// one path that can publish a non-opaque version. Guard the advertised value.

/** What a real MCP client reads off `serverInfo.version` — the value a consumer actually receives. */
async function advertisedVersion(deps) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createGatewayMcpServer({ retrieve: async () => ({ markdown: "x" }), ...deps });
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  try {
    return client.getServerVersion().version;
  } finally {
    await client.close();
  }
}

test("R7 — the version a consumer is ADVERTISED is opaque", async () => {
  assert.ok(
    isOpaqueVersion(await advertisedVersion({})),
    "the version published over MCP must be a bare semver core, optionally + a 12-hex build stamp",
  );
});

test("R7 — the resolved version is opaque, and shares ONE pattern with the guard", () => {
  const reported = resolveGatewayVersion(repoRoot).reported;
  assert.ok(isOpaqueVersion(reported), `not opaque: ${reported}`);
  // The pattern is imported, never re-authored here. A local copy drifted looser than the resolver
  // once already (it accepted the leading zeros SEMVER_CORE rejects), which is a guard weaker than
  // the thing it guards.
  assert.match(reported, REPORTED_VERSION);
});

test("R7 RED — the guard actually REFUSES every identifier decision (a) ruled out", async () => {
  // Watched RED by construction. Each value reaches serverInfo through the SUPPORTED injection path
  // — a real server advertising a real value to a real client — not a string handed to a matcher.
  // A guard nobody has seen fail is not a guard; see
  // docs/solutions/best-practices/a-test-whose-stub-guarantees-the-assertion-proves-nothing.md.
  const mustRefuse = {
    "full commit sha": "1.0.0+8761780f4a2b9c3d5e6f708192a3b4c5d6e7f809",
    "short commit sha": "1.0.0+8761780",
    "git ref": "1.0.0+main",
    "describe output": "1.0.0-3-g8761780",
    "manifest digest": "1.0.0+sha256:b2e1966fe1cb",
    "container name": "1.0.0+svc-container-01",
    "host name": "1.0.0+deploy-host-01",
    "uppercase hex": "1.0.0+A1B2C3D4E5F6",
    "path-shaped": "1.0.0+app/dist",
    "leading zeros": "01.0.0+a1b2c3d4e5f6",
    "bare stamp, no semver": "a1b2c3d4e5f6",
  };
  for (const [label, value] of Object.entries(mustRefuse)) {
    assert.equal(isOpaqueVersion(value), false, `guard must refuse a ${label}: ${value}`);
    // And it refuses it where it counts — on the wire, as advertised to a client.
    assert.equal(
      isOpaqueVersion(await advertisedVersion({ version: value })),
      false,
      `a ${label} injected into serverInfo must fail the guard: ${value}`,
    );
  }

  // The mirror: a well-formed stamp must PASS, or the guard is refusing everything and proving
  // nothing. A test that only ever says "no" is satisfied by a broken predicate.
  assert.equal(isOpaqueVersion(await advertisedVersion({ version: "1.0.0+a1b2c3d4e5f6" })), true);
  assert.equal(isOpaqueVersion(await advertisedVersion({ version: "1.0.0" })), true);
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

test("a stamp that cannot be READ refuses to boot — only true absence is unstamped", () => {
  // The catch used to swallow every readFileSync failure, so an unreadable stamp degraded silently
  // to "unstamped" — contradicting this module's own rule that a corrupt identity is worse than a
  // missing one. Only ENOENT means absent. (CodeRabbit, PR #142.)
  const dir = scratchRoot({ "package.json": '{"version":"1.2.3"}' });
  try {
    // A DIRECTORY named .deploy-id: a real EISDIR, constructed at the source rather than by stubbing
    // readFileSync to throw a synthetic error.
    mkdirSync(join(dir, ".deploy-id"));
    assert.throws(() => resolveGatewayVersion(dir), (err) => err.code === "EISDIR" || /EISDIR/.test(err.message));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stamp with no read permission refuses to boot", () => {
  const dir = scratchRoot({ "package.json": '{"version":"1.2.3"}', ".deploy-id": "a1b2c3d4e5f6" });
  try {
    chmodSync(join(dir, ".deploy-id"), 0o000);
    // Skip when running as a user that bypasses permission bits (e.g. root in a container).
    let readable = true;
    try { readFileSync(join(dir, ".deploy-id"), "utf8"); } catch { readable = false; }
    if (readable) return;
    assert.throws(() => resolveGatewayVersion(dir), (err) => err.code === "EACCES" || /EACCES/.test(err.message));
  } finally {
    try { chmodSync(join(dir, ".deploy-id"), 0o600); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});
