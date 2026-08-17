#!/usr/bin/env node
/**
 * Artifact contract gate (plan Task G). Run IN-CONTAINER (headful Chrome under Xvfb).
 *
 * This is the ONLY stage that runs the artifact stack's real code against a real browser. Everything
 * below it — 1489 host-side unit tests included — proves things about fakes. So every layer this gate
 * cares about is real, and none of it is reached by an internal shortcut:
 *
 *  - a real `ArtifactRuntime` on a real filesystem root, holding its real exclusive lock;
 *  - a real headful Chrome under Xvfb, performing REAL downloads through the real driver `download`
 *    event, the real `#routeDownload` attribution, and the real `registerDownload`/`seal` lifecycle;
 *  - the real `retrieve` verb and the real `GatewayDriveController`, each minting their own capture
 *    operations exactly as `http-main.ts` wires them;
 *  - the real `createHttpHandler` + Node `http` listener + real `StreamableHTTPClientTransport` MCP
 *    sessions. Every artifact assertion below is made against a tool result that crossed a real HTTP
 *    MCP session — never a direct call to `acquireResponseLease` (contract Task G, final clause).
 *
 * DETERMINISM AND ISOLATION. The fixture corpus is served by a loopback HTTP server inside this same
 * container: no live site, no credentials, no egress. It is reached through a HOSTNAME
 * (`bill-fixture.test`, an /etc/hosts entry pointing at 127.0.0.1) rather than through `127.0.0.1`,
 * for a reason worth stating: `ArtifactRuntime.createOperation` refuses an IP-literal `sourceHost`
 * outright (`isIP(...) !== 0` -> `artifact-config-invalid`), so an IP-addressed fixture can never
 * capture at all — measured, not assumed. Using a name also means this gate runs against the
 * UNMODIFIED shipped egress filter: no narrowing, no injected override, nothing weakened to make the
 * harness work. Leg 0 asserts the shipped filter is genuinely in force.
 *
 * RED CONTROLS. `BGW_ARTIFACT_GATE_RED=<control>` sabotages the PREMISE of exactly one leg (never the
 * assertion), so the assertion is what reports the bad news. Each is listed in RED_CONTROLS below and
 * must drive this gate to a non-zero exit. The contract's two named controls — muted listener and
 * forced capture failure — are deliberately NOT knobs here: they are produced by patching the built
 * `dist` in an overlay image, so what goes RED is the real shipping code path, not a harness branch.
 *
 * KNOWN OPEN DEFECT — this gate does NOT currently exit 0, and that is the gate working.
 * Three checks fail against a real, unfixed defect (see
 * docs/solutions/integration-issues/driver-disposal-calls-are-mutually-exclusive-not-concurrent.md):
 * `ArtifactOperation#startCleanup` requires both `cancel()` and `delete()` to confirm, but on a real
 * driver those two are mutually exclusive, so ONE refused download poisons the runtime permanently and
 * every later capture silently stops. The exact expected-failing set is:
 *
 *   - "a sub-magic-length download is refused as artifact-not-pdf"
 *   - "an oversize download is refused as artifact-size-limit"
 *   - "a capture still seals after four consecutive refusals"
 *
 * ANY other failure is a new regression. The assertions are deliberately NOT relaxed to make this
 * green — a gate that lowers its bar to match a defect is worth nothing.
 *
 * Exit 0 only when every leg passed.
 *
 * RUN (the fixture hostname is supplied by Docker, since a container's /etc/hosts is generated at run
 * time and an image-baked entry would be discarded):
 *
 *   docker build --platform linux/amd64 -f docker/Dockerfile -t browse-gateway:<tag> .
 *   docker run --rm --platform linux/amd64 --shm-size=1g --init \
 *     --add-host bill-fixture.test:127.0.0.1 <tag> node scripts/validate-artifact.mjs
 */
import { createServer } from "node:http";
import { mkdtempSync, rmSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { tokenEnvKey } from "../dist/policy/index.js";
import { isBlockedEgressHost } from "../dist/security/index.js";
import { loadArtifactConfig, buildArtifactRuntime } from "../dist/artifacts/runtime-builder.js";
import { buildGatewayRuntime } from "../dist/mcp/runtime.js";
import { createGatewayMcpServer, createHttpHandler } from "../dist/mcp/index.js";
import { GatewayDriveController } from "../dist/mcp/drive-controller.js";
import { retrieve } from "../dist/verbs/index.js";

const RED = process.env.BGW_ARTIFACT_GATE_RED ?? "";
const RED_CONTROLS = new Set([
  "foreign-owner",          // leg 3: the foreign graph is built with the OWNER's consumerId
  "shared-controller",      // leg 3: the second owner graph reuses the first graph's controllerId
  "second-fetch-fresh-id",  // leg 3: the one-shot re-fetch uses an UNCONSUMED id instead of the consumed one
  "inline-as-attachment",   // leg 4: the inline route sends an attachment disposition
  "serve-pdf-as-notpdf",    // leg 5: the non-PDF route serves a real PDF
  "serve-small-oversize",   // leg 5: the oversize route serves a small PDF
  "skip-cleanup",           // leg 7: the runtime is never closed, so its artifacts stay on disk
]);
if (RED && !RED_CONTROLS.has(RED)) {
  console.error(`unknown BGW_ARTIFACT_GATE_RED=${RED}; known: ${[...RED_CONTROLS].join(", ")}`);
  process.exit(2);
}

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail !== undefined && !ok ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const dirs = [];
const tempDir = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

// ---------------------------------------------------------------------------------------------
// The fixture corpus. Every body is generated here, so the gate never depends on a file in the
// image and every size/hash below is exact.
// ---------------------------------------------------------------------------------------------
const PDF_BODY = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
    "2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
  "utf8",
);
const PDF_SHA256 = createHash("sha256").update(PDF_BODY).digest("hex");
// A SECOND, byte-distinct PDF, so a leg that must identify one artifact among several cannot pass by
// accident on a corpus where every body hashes the same.
const PDF_BODY_2 = Buffer.concat([PDF_BODY, Buffer.from("% second fixture\n", "utf8")]);
const PDF_SHA256_2 = createHash("sha256").update(PDF_BODY_2).digest("hex");
// > 8 MiB (MAX_ARTIFACT_BYTES), still PDF-magic, so the refusal is decided by SIZE and not by magic.
const OVERSIZE_BODY = Buffer.concat([PDF_BODY, Buffer.alloc(9 * 1024 * 1024, 0x20)]);
// >= 5 bytes and NOT PDF-magic: the store hashes it, then refuses at the magic check.
const NOT_PDF_BODY = Buffer.alloc(1024, 0x41);
// < 5 bytes: too short for the magic to even be read — the other of the two closed non-PDF refusals.
const TINY_BODY = Buffer.from("ab", "utf8");

const ROUTES = {
  "/bill.pdf": { body: PDF_BODY, type: "application/pdf", attach: "bill.pdf" },
  "/bill2.pdf": { body: PDF_BODY_2, type: "application/pdf", attach: "bill2.pdf" },
  "/spare.pdf": { body: PDF_BODY_2, type: "application/pdf", attach: "spare.pdf" },
  // Inline: served as a PDF with NO attachment disposition, so Chrome renders it in the plugin shell
  // and emits no download event at all — the exact shape `inline-pdf-unsupported` exists to name.
  "/inline.pdf": {
    body: PDF_BODY,
    type: "application/pdf",
    attach: RED === "inline-as-attachment" ? "inline.pdf" : null,
  },
  "/notpdf.bin": {
    body: RED === "serve-pdf-as-notpdf" ? PDF_BODY : NOT_PDF_BODY,
    type: "application/octet-stream",
    attach: "notpdf.bin",
  },
  "/tiny.bin": { body: TINY_BODY, type: "application/octet-stream", attach: "tiny.bin" },
  "/oversize.pdf": {
    body: RED === "serve-small-oversize" ? PDF_BODY : OVERSIZE_BODY,
    type: "application/pdf",
    attach: "oversize.pdf",
  },
  // A plain page: the no-artifact control. A capture-enabled navigation that downloads nothing must
  // seal `none` and surface NO structuredContent — which is what proves the "available" legs below
  // are reporting a real capture rather than a field this stack always emits.
  "/page.html": { body: Buffer.from("<html><title>fixture</title><body><h1>fixture page</h1></body></html>", "utf8"), type: "text/html", attach: null },
};

function startFixtureServer() {
  const server = createServer((req, res) => {
    const route = ROUTES[(req.url ?? "").split("?")[0]];
    if (!route) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    const headers = { "Content-Type": route.type, "Content-Length": String(route.body.length) };
    if (route.attach) headers["Content-Disposition"] = `attachment; filename="${route.attach}"`;
    res.writeHead(200, headers);
    res.end(route.body);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function startMcpServer(handler) {
  const server = createServer((req, res) =>
    handler.handle(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    }),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: new URL(`http://127.0.0.1:${server.address().port}/mcp`) };
}

async function connect(url, token) {
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "artifact-gate", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

/** The fixed §3.5 denial, as a caller sees it. Nothing else may distinguish one refusal from another. */
const isFixedDenial = (res) =>
  res?.isError === true &&
  res.structuredContent === undefined &&
  Array.isArray(res.content) &&
  res.content.length === 1 &&
  res.content[0]?.type === "text" &&
  res.content[0]?.text === "Artifact is unavailable.";

console.log("=== browse-gateway :: artifact contract gate (Task G) ===");
if (RED) console.log(`  !! RED CONTROL ACTIVE: ${RED} — this run MUST fail\n`);

const artifactRoot = join(tempDir("bgw-artifact-gate-"), "store");
let fixture, mcp, runtime, gateway;
const clients = [];

try {
  fixture = await startFixtureServer();
  const HOST = process.env.BGW_ARTIFACT_GATE_HOST ?? "bill-fixture.test";
  const EGRESS_HOST = "metadata.google.internal"; // allowlisted on purpose; see the manifest below
  const base = `http://${HOST}:${fixture.port}`;
  console.log(`  fixture corpus on ${base}, artifact root ${artifactRoot}\n`);

  // -------------------------------------------------------------------------------------------
  // Leg 0 — the SHIPPED egress filter is in force, unmodified.
  // -------------------------------------------------------------------------------------------
  console.log("--- leg 0: the shipped egress filter is in force ---");
  check("the fixture host resolves for the browser", await fetch(`${base}/page.html`).then((r) => r.ok).catch(() => false));
  check("the fixture host is not itself an egress-blocked name", isBlockedEgressHost(HOST) === false);
  // Calling the pure predicate proves only that the predicate exists. What matters is that the
  // NAVIGATION LAYER consults it — so the real assertion below is made against the guard the real
  // PolicyEngine built during the real boot, for a host that IS on the consumer's allowlist. That is
  // the documented property ("egress deny wins over any allowlist"), and unwiring `egress` from the
  // PolicyEngine turns it RED while leaving the predicate itself untouched.
  //   (Deferred until after boot — see leg 0b, below the runtime construction.)

  // -------------------------------------------------------------------------------------------
  // The real stack, wired exactly as http-main.ts wires it.
  // -------------------------------------------------------------------------------------------
  const OWNER = "owner-consumer";
  const FOREIGN = "foreign-consumer";

  // Booted through the PRODUCTION path — `loadArtifactConfig` -> `buildGatewayRuntime` ->
  // `buildArtifactRuntime`, in http-main.ts's exact order — rather than by hand-constructing a
  // Gateway/PolicyEngine. That is the whole point of this gate: a hand-rolled stack would prove the
  // harness can capture while the shipped entrypoint still cannot, which is precisely the defect this
  // gate was written to catch. Nothing is overridden — no `policyEgress`, no injected core factory,
  // and the consumer allowlist, policy engine and egress filter are all the shipped ones.
  //
  // DOCUMENTED DIVERGENCE, so this is not read as more than it is: the handler below is built without
  // `allowedHosts`/`allowedOrigins`, so Host-based DNS-rebind protection is OFF for this gate — a
  // configuration `http-main.ts` refuses to boot with. This gate therefore proves nothing about the
  // rebind guard; `scripts/validate-http.mjs` owns that surface. Everything this gate DOES assert is
  // about artifact capture, authorization and retrieval, none of which the rebind guard participates in.
  const manifestPath = join(tempDir("bgw-artifact-gate-cfg-"), "consumers.json");
  // EGRESS_HOST is deliberately ALLOWLISTED. It is a metadata address, so the only thing that can
  // refuse it is the egress deny — which is exactly what leg 0b needs in order to test the wiring
  // rather than the allowlist. Nothing ever navigates to it.
  writeFileSync(manifestPath, JSON.stringify([
    { id: OWNER, allow: [HOST, EGRESS_HOST] },
    { id: FOREIGN, allow: [HOST] },
  ]));
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}),
    BGW_CHANNEL: process.env.BGW_CHANNEL ?? "chrome",
    ...(process.env.BGW_NO_SANDBOX ? { BGW_NO_SANDBOX: process.env.BGW_NO_SANDBOX } : {}),
    BGW_CONSUMERS_MANIFEST: manifestPath,
    [tokenEnvKey(OWNER)]: "tok-owner",
    [tokenEnvKey(FOREIGN)]: "tok-foreign",
    BGW_MAX_SESSIONS: "8",
    BGW_PER_CONSUMER_MAX: "2",
    BGW_ARTIFACT_CAPTURE_ENABLED: "1",
    BGW_ARTIFACT_ROOT: artifactRoot,
  };
  const artifactConfig = loadArtifactConfig(env);
  check("the shared loader reports artifact capture enabled", artifactConfig.enabled === true);
  const booted = buildGatewayRuntime(env, {
    log: (m) => process.stderr.write(`[artifact-gate] ${m}\n`),
    captureEnabled: artifactConfig.enabled,
  });
  const { gateway: bootedGateway, secrets, policy, config } = booted;
  gateway = bootedGateway;
  check("the booted gateway's browser cores are capture-enabled", config.core.captureEnabled === true,
    JSON.stringify(config.core?.captureEnabled));
  runtime = buildArtifactRuntime(artifactConfig);
  // The LOCK, not merely the root: asserting `existsSync(artifactRoot)` would pass with the whole
  // locking mechanism removed, since the store mkdir's its root either way.
  const lockPath = join(artifactRoot, ".gateway-lock");
  check("the artifact runtime took its exclusive root lock", existsSync(lockPath), lockPath);

  // --- leg 0b: the navigation layer actually consults the egress filter. -----------------------
  // `EGRESS_HOST` is on this consumer's allowlist (see the manifest above), so the ONLY thing that
  // can refuse it is the egress deny — which is what makes this a test of the wiring rather than of
  // the allowlist. Asserted against the guard the real boot built, so it needs no DNS and cannot pass
  // because a name failed to resolve.
  {
    const consumer = policy.authenticate("tok-owner");
    const guard = policy.guardFor(consumer);
    const req = (url) => ({ url, host: new URL(url).hostname, isNavigationRequest: true });
    check("an ALLOWLISTED but egress-denied host is blocked by the real navigation guard",
      guard(req(`http://${EGRESS_HOST}/`), {}) === "block");
    check("the same guard admits the allowlisted fixture host",
      guard(req(`${base}/page.html`), {}) === "allow");
  }

  // One graph per MCP session, exactly like http-main.ts's `buildServer`. `graphs` records what each
  // graph was actually built with, so the assertions below can name the lineage they mean.
  const graphs = [];
  let firstControllerId;
  const buildServer = (consumer) => {
    const effectiveConsumerId =
      RED === "foreign-owner" && consumer.id === FOREIGN ? OWNER : consumer.id;
    const artifactCapture = { runtime, consumerId: effectiveConsumerId };
    const drive = new GatewayDriveController(gateway, secrets, consumer.token, {
      consumerId: effectiveConsumerId,
      allowlist: consumer.allowlist,
      artifacts: artifactCapture,
      timeouts: config.timeouts,
    });
    // The wrong-controller leg needs a SECOND lineage for the SAME consumer; the RED control collapses
    // the two onto one controllerId, which is exactly what the leg must refuse to tolerate.
    const controllerId =
      RED === "shared-controller" && firstControllerId ? firstControllerId : drive.controllerId;
    if (!firstControllerId) firstControllerId = drive.controllerId;
    const server = createGatewayMcpServer({
      drive,
      retrieve: async ({ url, forceProxy }) =>
        retrieve(gateway, secrets, {
          token: consumer.token,
          url,
          forceProxy: forceProxy ?? false,
          timeouts: config.timeouts,
          artifactCapture,
        }),
      artifacts: {
        consumerId: effectiveConsumerId,
        controllerId,
        consumeForServer: (input) => runtime.acquireResponseLease(input),
      },
    });
    graphs.push({ consumerId: effectiveConsumerId, controllerId });
    return { server, dispose: async () => drive.close().catch(() => {}) };
  };

  const handler = createHttpHandler({
    authenticate: (token) => policy.authenticate(token),
    buildServer,
    artifactsEnabled: true,
  });
  mcp = await startMcpServer(handler);

  // Three REAL MCP HTTP sessions: the owner's first graph, a second graph for the SAME owner (a
  // distinct drive lineage), and a foreign consumer.
  const ownerA = await connect(mcp.url, "tok-owner");
  clients.push(ownerA);
  const ownerB = await connect(mcp.url, "tok-owner");
  clients.push(ownerB);
  const foreign = await connect(mcp.url, "tok-foreign");
  clients.push(foreign);
  check("three distinct MCP HTTP sessions opened against the real handler", graphs.length === 3);
  check(
    "the owner's two sessions are distinct drive lineages",
    RED === "shared-controller" ? true : graphs[0].controllerId !== graphs[1].controllerId,
  );

  const callTool = (client, name, args) => client.callTool({ name, arguments: args });

  // -------------------------------------------------------------------------------------------
  // Leg 1 — retrieve attachment -> metadata -> one-time blob -> %PDF-/size/hash match.
  // -------------------------------------------------------------------------------------------
  console.log("\n--- leg 1: retrieve -> metadata -> one-shot blob ---");
  const retrieved = await callTool(ownerA, "retrieve", { url: `${base}/bill.pdf` });
  const rMeta = retrieved?.structuredContent?.artifact;
  check(
    "a real Chrome download through retrieve() sealed an available artifact",
    retrieved?.structuredContent?.artifactOutcome === "available" && rMeta !== undefined,
    JSON.stringify({ isError: retrieved?.isError, structured: retrieved?.structuredContent, text: retrieved?.content?.[0]?.text?.slice(0, 400) }),
  );
  if (rMeta) {
    check("retrieve metadata reports the exact fixture size", rMeta.sizeBytes === PDF_BODY.length, `${rMeta.sizeBytes} != ${PDF_BODY.length}`);
    check("retrieve metadata reports the exact fixture sha256", rMeta.sha256 === PDF_SHA256);
    check("retrieve metadata names the canonical source host only", rMeta.sourceHost === HOST, rMeta.sourceHost);
    check("retrieve metadata is the ONE public projection, no record internals", (() => {
      const keys = Object.keys(rMeta).sort().join(",");
      return keys === "artifactId,createdAt,disposition,expiresAt,kind,sha256,sizeBytes,sourceHost";
    })(), Object.keys(rMeta).sort().join(","));
    check("retrieve metadata declares kind=pdf disposition=attachment", rMeta.kind === "pdf" && rMeta.disposition === "attachment");

    const got = await callTool(ownerA, "browser_get_artifact", { artifactId: rMeta.artifactId });
    const block = got?.content?.[0];
    check("browser_get_artifact returned one embedded resource block", block?.type === "resource" && got?.isError !== true,
      JSON.stringify(got?.content?.[0] ?? got).slice(0, 300));
    if (block?.type === "resource") {
      check("the resource is addressed artifact:<id> as application/pdf",
        block.resource.uri === `artifact:${rMeta.artifactId}` && block.resource.mimeType === "application/pdf");
      const decoded = Buffer.from(block.resource.blob, "base64");
      check("the returned blob starts with %PDF-", decoded.subarray(0, 5).toString("latin1") === "%PDF-");
      check("the returned blob is byte-identical to the fixture", decoded.equals(PDF_BODY));
      check("the returned blob's size matches the reported metadata", decoded.length === rMeta.sizeBytes);
      check("the returned blob's sha256 matches the reported metadata",
        createHash("sha256").update(decoded).digest("hex") === rMeta.sha256);
      const serialized = JSON.stringify(got);
      for (const forbidden of [OWNER, FOREIGN, artifactRoot, "consumerId", "controllerId", "owner"]) {
        check(`the artifact response leaks no "${forbidden}"`, serialized.includes(forbidden) === false);
      }
    }

    // One-shot: the SAME owner, the SAME session, immediately after a completed transfer.
    let secondId = rMeta.artifactId;
    if (RED === "second-fetch-fresh-id") {
      const spare = await callTool(ownerA, "retrieve", { url: `${base}/spare.pdf` });
      secondId = spare?.structuredContent?.artifact?.artifactId ?? secondId;
    }
    const again = await callTool(ownerA, "browser_get_artifact", { artifactId: secondId });
    check("a second fetch of a consumed artifact collapses to the fixed denial", isFixedDenial(again),
      JSON.stringify(again).slice(0, 300));
  }

  // -------------------------------------------------------------------------------------------
  // Leg 2 — drive attachment -> metadata -> same-controller consume.
  // -------------------------------------------------------------------------------------------
  console.log("\n--- leg 2: drive -> metadata -> same-controller consume ---");
  const navigated = await callTool(ownerA, "browser_navigate", { url: `${base}/bill2.pdf` });
  const dMeta = navigated?.structuredContent?.artifact;
  check(
    "a real Chrome download through browser_navigate sealed an available artifact",
    navigated?.structuredContent?.artifactOutcome === "available" && dMeta !== undefined,
    JSON.stringify({ structured: navigated?.structuredContent, text: navigated?.content?.[0]?.text?.slice(0, 300) }),
  );
  if (dMeta) {
    check("drive metadata rides structuredContent, never the snapshot text",
      typeof navigated.content?.[0]?.text === "string" && navigated.content[0].text.includes(dMeta.artifactId) === false);
    check("drive metadata reports the second fixture's exact sha256", dMeta.sha256 === PDF_SHA256_2);
    const gotDrive = await callTool(ownerA, "browser_get_artifact", { artifactId: dMeta.artifactId });
    const dBlock = gotDrive?.content?.[0];
    check("the SAME drive controller consumes its own artifact", dBlock?.type === "resource" && gotDrive?.isError !== true,
      JSON.stringify(gotDrive).slice(0, 300));
    if (dBlock?.type === "resource") {
      check("the drive artifact's bytes are byte-identical to the second fixture",
        Buffer.from(dBlock.resource.blob, "base64").equals(PDF_BODY_2));
    }
  }

  // -------------------------------------------------------------------------------------------
  // Leg 3 — foreign consumer and wrong controller are refused, indistinguishably.
  // -------------------------------------------------------------------------------------------
  console.log("\n--- leg 3: foreign / wrong-controller denial ---");
  // Each denial axis is tested against the ONE artifact scope where that axis is the only thing that
  // can refuse. This is not fussiness — the first version of this leg tried the foreign consumer
  // against a DRIVE-scoped artifact, and the `foreign-owner` RED control came back GREEN: the lineage
  // check was refusing it, so the leg passed without ever testing consumer identity. A denial leg that
  // two independent checks can satisfy proves neither of them.
  //
  // 3a. CONSUMER-scoped (from retrieve): controller/lineage is not consulted at all, so a refusal here
  //     can only mean "not your consumer".
  const consumerScoped = await callTool(ownerA, "retrieve", { url: `${base}/bill.pdf` });
  const csMeta = consumerScoped?.structuredContent?.artifact;
  check("a consumer-scoped artifact was captured for the foreign-denial leg", csMeta !== undefined,
    JSON.stringify(consumerScoped?.structuredContent));
  if (csMeta) {
    const byForeign = await callTool(foreign, "browser_get_artifact", { artifactId: csMeta.artifactId });
    check("a FOREIGN consumer is refused with the fixed denial", isFixedDenial(byForeign), JSON.stringify(byForeign).slice(0, 300));
    check("the foreign refusal leaks no server path", JSON.stringify(byForeign).includes(artifactRoot) === false);
    // The positive half of the same axis: the rightful consumer, on a DIFFERENT MCP session and a
    // different drive lineage, MAY fetch a consumer-scoped artifact. Without this, "refused" above
    // could equally mean "consumer-scoped artifacts are unreachable from any second session".
    const byOwnerOtherSession = await callTool(ownerB, "browser_get_artifact", { artifactId: csMeta.artifactId });
    check("the rightful consumer on another session CAN fetch a consumer-scoped artifact",
      byOwnerOtherSession?.content?.[0]?.type === "resource", JSON.stringify(byOwnerOtherSession).slice(0, 300));
  }

  // 3b. DRIVE-scoped (from browser_navigate on lineage A): both sessions carry the SAME consumer, so
  //     lineage is the only axis left that can refuse ownerB.
  const driveScoped = await callTool(ownerA, "browser_navigate", { url: `${base}/bill2.pdf` });
  const dsMeta = driveScoped?.structuredContent?.artifact;
  check("a drive-scoped artifact was captured for the lineage-denial leg", dsMeta !== undefined,
    JSON.stringify(driveScoped?.structuredContent));
  if (dsMeta) {
    const byOtherLineage = await callTool(ownerB, "browser_get_artifact", { artifactId: dsMeta.artifactId });
    check("the SAME consumer on a DIFFERENT drive lineage is refused", isFixedDenial(byOtherLineage),
      JSON.stringify(byOtherLineage).slice(0, 300));

    const byOwner = await callTool(ownerA, "browser_get_artifact", { artifactId: dsMeta.artifactId });
    check("after the refusal the rightful lineage still succeeds (the refusal consumed nothing)",
      byOwner?.content?.[0]?.type === "resource", JSON.stringify(byOwner).slice(0, 200));
  }

  const unknown = await callTool(ownerA, "browser_get_artifact", { artifactId: "AAAAAAAAAAAAAAAAAAAAAA" });
  check("an unknown artifact id is refused with the SAME fixed denial", isFixedDenial(unknown));
  const malformed = await callTool(ownerA, "browser_get_artifact", { artifactId: "../../etc/passwd" });
  check("a traversal-shaped artifact id is refused with the SAME fixed denial", isFixedDenial(malformed));

  // Captured HERE, before the refusal legs, and deliberately never consumed: leg 7 needs something
  // real on disk to prove cleanup removed it, and every other artifact this gate takes is consumed
  // one-shot (which discards it immediately). Taken early on purpose — leg 7 is a test of CLEANUP, so
  // its premise must not depend on capture still working after four refusals.
  // Consumer-scoped, because `handler.closeAll()` discards drive-scoped artifacts as it disposes each
  // graph, and only `runtime.close()` can remove this one.
  const unconsumed = await callTool(ownerA, "retrieve", { url: `${base}/spare.pdf` });
  check("an unconsumed artifact was captured for the cleanup leg",
    unconsumed?.structuredContent?.artifact?.artifactId !== undefined,
    JSON.stringify(unconsumed?.structuredContent));

  // -------------------------------------------------------------------------------------------
  // Leg 4 — an inline PDF is explicitly unsupported and produces NO artifact.
  // -------------------------------------------------------------------------------------------
  console.log("\n--- leg 4: inline PDF is unsupported, no artifact ---");
  const inline = await callTool(ownerA, "retrieve", { url: `${base}/inline.pdf` });
  check("an inline PDF is refused as inline-pdf-unsupported",
    inline?.structuredContent?.artifactOutcome === "inline-pdf-unsupported" &&
      inline?.structuredContent?.artifactFailure === "inline-pdf-unsupported",
    JSON.stringify(inline?.structuredContent));
  check("an inline PDF surfaces NO artifact metadata", inline?.structuredContent?.artifact === undefined);

  // The no-artifact control: a capture-enabled navigation that downloads nothing seals `none`.
  // The retrieve must SUCCEED first. Without that, this passes when the call failed outright (a 404,
  // a policy denial, a browser launch failure) — an absent `structuredContent` is not evidence that
  // capture correctly declined, and this is the control the "available" legs lean on.
  const plain = await callTool(ownerA, "retrieve", { url: `${base}/page.html` });
  const plainText = plain?.content?.[0]?.text ?? "";
  check("the plain-page control actually retrieved the page",
    plain?.isError !== true && plainText.includes("fixture page"), JSON.stringify(plain).slice(0, 300));
  check("a successful plain-page retrieve seals no artifact at all",
    plain?.structuredContent?.artifact === undefined && plain?.structuredContent?.artifactOutcome === undefined,
    JSON.stringify(plain?.structuredContent));

  // -------------------------------------------------------------------------------------------
  // Leg 5 — non-PDF and oversize controls fail closed.
  // -------------------------------------------------------------------------------------------
  console.log("\n--- leg 5: non-PDF and oversize refusals ---");
  const notPdf = await callTool(ownerA, "retrieve", { url: `${base}/notpdf.bin` });
  check("a non-PDF download is refused as capture-failed",
    notPdf?.structuredContent?.artifactOutcome === "capture-failed",
    JSON.stringify(notPdf?.structuredContent));
  check("the non-PDF refusal names a closed magic/integrity failure",
    ["artifact-integrity-failed", "artifact-not-pdf"].includes(notPdf?.structuredContent?.artifactFailure),
    notPdf?.structuredContent?.artifactFailure);
  check("a non-PDF download surfaces no artifact metadata", notPdf?.structuredContent?.artifact === undefined);

  const tiny = await callTool(ownerA, "retrieve", { url: `${base}/tiny.bin` });
  check("a sub-magic-length download is refused as artifact-not-pdf",
    tiny?.structuredContent?.artifactOutcome === "capture-failed" &&
      tiny?.structuredContent?.artifactFailure === "artifact-not-pdf",
    JSON.stringify(tiny).slice(0, 500));

  const oversize = await callTool(ownerA, "retrieve", { url: `${base}/oversize.pdf` });
  check("an oversize download is refused as artifact-size-limit",
    oversize?.structuredContent?.artifactOutcome === "capture-failed" &&
      oversize?.structuredContent?.artifactFailure === "artifact-size-limit",
    JSON.stringify(oversize).slice(0, 500));
  check("an oversize download surfaces no artifact metadata", oversize?.structuredContent?.artifact === undefined);

  // -------------------------------------------------------------------------------------------
  // Leg 6 — the refusals released everything they reserved.
  //
  // The store's own `accounting()` seam is store-private (`ArtifactRuntime` does not re-export it), and
  // reaching around the runtime for it would break this gate's "through the real consumer surface" rule
  // anyway. So the property is asserted the way a consumer can actually observe it: after four
  // consecutive refusals (inline, non-PDF, tiny, oversize), a fresh capture must still seal AND still be
  // retrievable. A leaked stage permit, response permit or byte reservation shows up here as a capture
  // that no longer seals or a fetch that no longer completes — which is what the accounting numbers
  // were only ever a proxy for.
  // -------------------------------------------------------------------------------------------
  console.log("\n--- leg 6: the refusals leaked no permits or reservations ---");
  const afterRefusals = await callTool(ownerA, "retrieve", { url: `${base}/bill.pdf` });
  const aMeta = afterRefusals?.structuredContent?.artifact;
  check("a capture still seals after four consecutive refusals", aMeta !== undefined,
    JSON.stringify(afterRefusals).slice(0, 500));
  if (aMeta) {
    const afterGot = await callTool(ownerA, "browser_get_artifact", { artifactId: aMeta.artifactId });
    check("that artifact is still retrievable (no permit was leaked by the refusals)",
      afterGot?.content?.[0]?.type === "resource", JSON.stringify(afterGot).slice(0, 300));
    if (afterGot?.content?.[0]?.type === "resource") {
      check("its bytes are still byte-identical to the fixture",
        Buffer.from(afterGot.content[0].resource.blob, "base64").equals(PDF_BODY));
    }
  }

  // -------------------------------------------------------------------------------------------
  // Leg 7 — no orphan partial/final artifacts after cleanup.
  // -------------------------------------------------------------------------------------------
  console.log("\n--- leg 7: no orphan artifacts after cleanup ---");
  // The unconsumed artifact taken before the refusal legs is what makes this leg mean anything: every
  // other artifact here is consumed one-shot, and `complete()` discards a consumed artifact
  // immediately — so without it the survivor scan below reads an EMPTY directory whether or not
  // cleanup ran, and the `skip-cleanup` control passes vacuously. It did exactly that until this leg
  // was given a premise; the control is what found it.
  const dataDir = join(artifactRoot, "data");
  const artifactFiles = () =>
    existsSync(dataDir) ? readdirSync(dataDir).filter((n) => n.endsWith(".pdf") || n.endsWith(".part")) : [];
  const beforeCleanup = artifactFiles();
  check("that artifact is on disk BEFORE cleanup (this leg has a real premise)",
    beforeCleanup.length >= 1, `data dir held ${beforeCleanup.length} file(s)`);

  for (const client of clients.splice(0)) await client.close().catch(() => {});
  await handler.closeAll().catch(() => {});
  await new Promise((resolve) => mcp.server.close(resolve));
  mcp.server.closeAllConnections?.();
  mcp = undefined;
  if (RED !== "skip-cleanup") {
    const closeResult = await runtime.close();
    check("the artifact runtime closed cleanly", closeResult === undefined, String(closeResult));
    runtime = undefined;
  }
  const survivors = artifactFiles();
  console.log(`  data dir: ${beforeCleanup.length} file(s) before cleanup, ${survivors.length} after`);
  check("no .part staging file survived cleanup", survivors.some((n) => n.endsWith(".part")) === false, survivors.join(","));
  check("no committed .pdf artifact survived cleanup", survivors.some((n) => n.endsWith(".pdf")) === false, survivors.join(","));
} catch (err) {
  console.log(`  FAIL  threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  failures++;
} finally {
  for (const client of clients) await client.close().catch(() => {});
  if (mcp) {
    await new Promise((resolve) => mcp.server.close(resolve));
    mcp.server.closeAllConnections?.();
  }
  if (gateway) await gateway.shutdown().catch(() => {});
  if (runtime) await runtime.close().catch(() => {});
  if (fixture) await new Promise((resolve) => fixture.server.close(resolve));
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
}

const verdict = failures === 0 ? "PASS ✅" : "FAIL ❌";
console.log(`\n=== ARTIFACT GATE: ${verdict} (${failures} failure(s)) ===`);
if (RED) {
  // The exit code is NOT inverted here, deliberately. An inverted code would turn "this run failed for
  // some unrelated reason" into "the control worked", which is precisely the vacuous control this
  // repo's rule exists to prevent. A RED run is expected to exit non-zero; WHICH leg failed is read
  // from the log above, and a RED control that exits 0 has proven its leg is vacuous.
  console.log(
    failures > 0
      ? `=== RED CONTROL "${RED}": gate went RED as required (check the failing leg above is the sabotaged one) ===`
      : `=== RED CONTROL "${RED}": GATE STAYED GREEN — the sabotaged leg proves nothing ===`,
  );
}
process.exit(failures === 0 ? 0 : 1);
