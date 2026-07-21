/**
 * #42 per-stage timing tests. Four axes:
 *  (a) PURE — assembleTiming rounds, clamps negatives, omits absent stages, and a populated Timing is
 *      non-negative + monotone (totalMs >= each measured sub-stage);
 *  (b) REDACTION — the all-numeric #42 timing slot passes redactFailureDiagnostics untouched while a real
 *      secret elsewhere is still scrubbed (matches the #40/#41 slot tests);
 *  (c) RETRIEVE — a real retrieve() surfaces `timing` on success AND failure (the SAME object folded into
 *      the envelope on failure — single derivation), and the proxied retry loop reports one attemptMs per
 *      attempt (1:1 with `attempts`), all with a fake gateway/core (no real browser);
 *  (d) DRIVE — the controller stamps a whole-verb `timing.totalMs` on every returned snapshot, and the MCP
 *      surface renders a compact `total:` line.
 * The live timing on a real browser runs in-container via the stealth/retrieve/drive validators.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { assembleTiming, redactFailureDiagnostics } from "../dist/observability/index.js";
import { retrieve, PROXY_CLEARANCE_TIMEOUT_MS } from "../dist/verbs/index.js";
import { createGatewayMcpServer } from "../dist/mcp/index.js";
import { GatewayDriveController } from "../dist/mcp/drive-controller.js";
import { SecretStore } from "../dist/security/index.js";

// --- Fixtures (mirroring retrieve.test.mjs / drive-controller.test.mjs idioms) -----------------------
const articleHtml = `<!doctype html><html><head><title>Doc</title></head><body><nav>menu</nav>
<article><h1>Headline</h1><p>${"Real article sentence with plenty of words. ".repeat(20)}</p>
<p>${"A second substantial paragraph for the reader algorithm. ".repeat(20)}</p></article>
<footer>foot</footer></body></html>`;

const cfBlock = {
  status: 403,
  title: "Just a moment...",
  text: "Enable JavaScript and cookies to continue",
  html: "<div class='cf-chl-opt' id='challenge-platform'></div>",
};

const renderOf = (over) => ({ url: "u", status: 200, title: "", text: "", html: "", clearanceWaitedMs: 0, ...over });

/** Fake gateway whose Nth withConsumerSession call renders the Nth programmed result (last one repeats). */
function makeFakeGateway(results) {
  const calls = [];
  let idx = 0;
  const gateway = {
    async withConsumerSession(token, fn, coreOverrides) {
      const result = results[Math.min(idx, results.length - 1)];
      idx++;
      const call = { token, coreOverrides };
      calls.push(call);
      const session = {
        core: {
          kind: "fake",
          async render(_url, renderOpts) {
            call.renderOpts = renderOpts;
            return renderOf(result);
          },
          async setNavigationGuard() {},
          async close() {},
        },
      };
      return fn(session, { id: "agent-1" });
    },
  };
  return { gateway, calls };
}

/** Fake gateway for the drive controller: a fully-faked core whose navigate/snapshot carry NO timing, so a
 *  timing on the controller's result proves the #timedSnap whole-verb stamp fired. */
function makeDriveGateway() {
  let nextId = 1;
  const open = new Map();
  const core = {
    async navigate(url) { return { url, title: "t", tree: "- x [ref=e1]", status: 200 }; },
    async snapshot() { return { url: "u", title: "t", tree: "- x [ref=e1]", status: 200 }; },
    async click() {},
    async type() {},
    async selectOption() {},
    async pressKey() {},
    async waitFor() {},
    async screenshot() { return "QUJD"; },
  };
  const gateway = {
    sessions: { get: (h) => open.get(h) },
    async openConsumerSession() { const id = "h" + nextId++; open.set(id, { core }); return id; },
    async useConsumerSession(_t, handle, fn) {
      const s = open.get(handle);
      if (!s) throw new Error(`no open session for handle ${handle}`);
      return fn(s);
    },
    async closeConsumerSession(_t, handle) { open.delete(handle); },
  };
  return { gateway };
}

// --- (a) PURE: assembleTiming -----------------------------------------------------------------------
test("assembleTiming: rounds, clamps negatives to 0, omits undefined stages, keeps totalMs", () => {
  const t = assembleTiming({ totalMs: 1234.7, clearancePollMs: 800.2, snapshotMs: 40.9, domContentLoadedMs: -5 });
  assert.equal(t.totalMs, 1235, "totalMs rounded");
  assert.equal(t.clearancePollMs, 800, "clearancePoll rounded down");
  assert.equal(t.snapshotMs, 41, "snapshot rounded up");
  assert.equal(t.domContentLoadedMs, 0, "a negative clock read clamps to 0, never surfaced negative");
  assert.equal(t.captchaSolveMs, undefined, "an absent stage is OMITTED (undefined), not surfaced as 0");
  // totalMs-only assembly: no other keys leak in.
  assert.deepEqual(assembleTiming({ totalMs: 3 }), { totalMs: 3 });
});

test("assembleTiming: a populated Timing is non-negative and monotone (totalMs >= each measured stage)", () => {
  const t = assembleTiming({ totalMs: 1000, domContentLoadedMs: 200, clearancePollMs: 700, snapshotMs: 50 });
  const stages = ["domContentLoadedMs", "clearancePollMs", "snapshotMs"];
  for (const s of stages) {
    assert.ok(t[s] >= 0, `${s} non-negative`);
    assert.ok(t.totalMs >= t[s], `totalMs (${t.totalMs}) >= ${s} (${t[s]})`);
  }
  assert.ok(t.totalMs >= 0);
});

// --- (b) REDACTION: the #42 slot passes through untouched -------------------------------------------
test("redactFailureDiagnostics passes the #42 timing slot through untouched (all-numeric, not free text)", () => {
  // Timing is attached at the redaction seam like wafVendor/failureClass; assert the redactor preserves it
  // verbatim (all values numeric → nothing to scrub) while still scrubbing a real secret in the URL.
  const red = redactFailureDiagnostics(
    { finalUrl: "https://x.example/?token=SECRET", timing: { totalMs: 1234, clearancePollMs: 800, snapshotMs: 40 } },
    { redactableValues: () => ["SECRET"] },
  );
  assert.deepEqual(red.timing, { totalMs: 1234, clearancePollMs: 800, snapshotMs: 40 }, "timing survives redaction unchanged");
  assert.ok(!/SECRET/.test(JSON.stringify(red)), "an actual secret is still scrubbed alongside it");
});

// --- (c) RETRIEVE -----------------------------------------------------------------------------------
test("retrieve: SUCCESS carries a timing with the surfaced render's core stages + a totalMs", async () => {
  const { gateway } = makeFakeGateway([
    { text: "x".repeat(1000), html: articleHtml, timing: { totalMs: 5, domContentLoadedMs: 120, clearancePollMs: 0, snapshotMs: 40 } },
  ]);
  const r = await retrieve(gateway, new SecretStore(() => ({})), { token: "t", url: "https://hard.example/" });
  assert.equal(r.blocked, false, "a real article is not blocked");
  assert.ok(r.timing, "every retrieve result carries timing (AC#1, success)");
  assert.equal(typeof r.timing.totalMs, "number", "totalMs is the whole-call wall-clock");
  // Core stages of the surfaced render carry through. (Do NOT assert totalMs >= a stage here: the fake render
  // is instant, so the real whole-call totalMs is < the injected 120 — a fake-data trap.)
  assert.equal(r.timing.domContentLoadedMs, 120, "surfaced render's domContentLoaded carries through");
  assert.equal(r.timing.snapshotMs, 40, "surfaced render's snapshot carries through");
  assert.equal(r.timing.clearancePollMs, 0, "a 0-ms stage is kept (ran instantly), not dropped");
  assert.equal(r.diagnostics, undefined, "success carries no failure envelope (non-regression)");
});

test("retrieve: a FAILED retrieve folds the SAME timing into the envelope (single derivation)", async () => {
  const { gateway } = makeFakeGateway([
    { ...cfBlock, diagnostics: { finalUrl: "https://hard.example/", status: 403 }, timing: { totalMs: 9, domContentLoadedMs: 200, clearancePollMs: 45000, snapshotMs: 30 } },
  ]);
  const r = await retrieve(gateway, new SecretStore(() => ({})), { token: "t", url: "https://hard.example/" });
  assert.equal(r.blocked, true);
  assert.ok(r.timing, "failed retrieve carries timing (AC#1, failure)");
  assert.ok(r.diagnostics, "failed retrieve carries the #39 envelope");
  assert.ok(r.diagnostics.timing, "the envelope carries timing (AC#3)");
  assert.deepEqual(r.diagnostics.timing, r.timing, "envelope.timing IS result.timing — one derivation, never disagreeing");
  assert.equal(r.timing.clearancePollMs, 45000, "the surfaced render's clearance poll carries into the breakdown");
});

test("retrieve: the proxied retry loop reports one attemptMs per attempt (1:1 with attempts)", async () => {
  // 1 direct blocked + 3 proxied (2 blocked, 3rd clears): attemptMs counts the 3 PROXIED attempts only.
  const { gateway } = makeFakeGateway([
    cfBlock,
    cfBlock,
    cfBlock,
    { text: "x".repeat(1000), html: articleHtml },
  ]);
  const secrets = new SecretStore(() => ({ BGW_PROXY_URL: "http://proxy:8080", BGW_PROXY_PASSWORD: "pwd" }));
  const r = await retrieve(gateway, secrets, { token: "t", url: "https://hard.example/", escalation: { onDatacenterIp: true } });
  assert.equal(r.proxyUsed, true);
  assert.ok(r.proxyDiagnostic, "escalation surfaced the proxy diagnostic");
  assert.equal(r.proxyDiagnostic.attempts, 3, "three proxied attempts");
  assert.ok(Array.isArray(r.proxyDiagnostic.attemptMs), "attemptMs present when the proxy engaged");
  assert.equal(r.proxyDiagnostic.attemptMs.length, r.proxyDiagnostic.attempts, "one duration per proxied attempt (1:1)");
  for (const ms of r.proxyDiagnostic.attemptMs) assert.equal(typeof ms, "number", "each attempt duration is a number");
});

test("retrieve: a direct-cleared retrieve surfaces no attemptMs (proxy never engaged)", async () => {
  const { gateway } = makeFakeGateway([{ text: "x".repeat(1000), html: articleHtml }]);
  const r = await retrieve(gateway, new SecretStore(() => ({})), { token: "t", url: "https://soft/" });
  assert.equal(r.proxyUsed, false);
  assert.equal(r.proxyDiagnostic, undefined, "no proxy diagnostic (and so no attemptMs) on a direct success");
  assert.ok(r.timing, "but timing is still present (AC#1)");
});

// --- (d) DRIVE --------------------------------------------------------------------------------------
test("drive controller: every returned snapshot carries a whole-verb timing.totalMs", async () => {
  const { gateway } = makeDriveGateway();
  const c = new GatewayDriveController(gateway, new SecretStore(() => ({})), "tok");
  const nav = await c.navigate("https://example.com/");
  assert.ok(nav.timing, "navigate result carries timing");
  assert.equal(typeof nav.timing.totalMs, "number");
  assert.ok(nav.timing.totalMs >= 0, "non-negative");
  // An action verb's totalMs is the WHOLE-ACTION wall-clock (incl. settle), not just the post-action
  // snapshot — the #timedSnap stamp is what fixes the "action reports ~snapshot-only ms" trap.
  const clicked = await c.click({ target: "e1", element: "x" });
  assert.equal(typeof clicked.timing.totalMs, "number", "action verb carries a whole-verb totalMs");
  const snap = await c.snapshot();
  assert.equal(typeof snap.timing.totalMs, "number", "bare snapshot carries a totalMs too");
});

/** A drive gateway whose navigate returns a caller-supplied (usually nav-failed) snapshot. `delayMs`
 *  makes navigate slow, for the queue-latency test. */
function makeScriptedDriveGateway(navSnap, delayMs = 0) {
  let nextId = 1;
  const open = new Map();
  const core = {
    async navigate(url) { if (delayMs) await new Promise((r) => setTimeout(r, delayMs)); return { ...navSnap, url }; },
    async snapshot() { return { url: "u", title: "t", tree: "-", status: 200 }; },
  };
  const gateway = {
    sessions: { get: (h) => open.get(h) },
    async openConsumerSession() { const id = "h" + nextId++; open.set(id, { core }); return id; },
    async useConsumerSession(_t, handle, fn) { const s = open.get(handle); if (!s) throw new Error("no session"); return fn(s); },
    async closeConsumerSession(_t, handle) { open.delete(handle); },
  };
  return { gateway };
}

test("drive FAILURE: the envelope's timing.totalMs is overridden with the WHOLE-verb wall-clock", async () => {
  // A nav-failed direct navigate (no proxy) throws EscalationError carrying the failure envelope. The core
  // per-nav timing injects an ABSURD totalMs (999999); the controller's #timedSnap must replace it with the
  // real (tiny) whole-verb elapsed while PRESERVING the stage breakdown — so totalMs can't contradict attemptMs.
  const { gateway } = makeScriptedDriveGateway({
    title: "t", tree: "Forbidden", status: null,
    diagnostics: { finalUrl: "https://hostile.example/", status: null },
    timing: { totalMs: 999999, clearancePollMs: 8000, snapshotMs: 12 },
  });
  const c = new GatewayDriveController(gateway, new SecretStore(() => ({})), "tok");
  await assert.rejects(c.navigate("https://hostile.example/"), (err) => {
    const failure = err.failure; // EscalationError carries the (redacted) envelope
    assert.ok(failure?.timing, "failure envelope carries timing");
    assert.ok(failure.timing.totalMs < 1000, "the injected core totalMs (999999) was replaced by the real whole-verb elapsed");
    assert.equal(failure.timing.clearancePollMs, 8000, "the stage breakdown is preserved through the override");
    return true;
  });
});

test("drive: a queued verb's totalMs INCLUDES the time it waited behind another verb (t0 before #serialize)", async () => {
  // Two concurrent navigates on one controller serialize; the second waits behind the first. Its totalMs
  // must include that queue wait (t0 is captured before #serialize), not just its own execution slice.
  const { gateway } = makeScriptedDriveGateway({ title: "t", tree: "x".repeat(200), status: 200 }, 60);
  const c = new GatewayDriveController(gateway, new SecretStore(() => ({})), "tok");
  const [, second] = await Promise.all([
    c.navigate("https://example.com/a"),
    c.navigate("https://example.com/b"),
  ]);
  assert.ok(second.timing.totalMs >= 50, `second navigate waited ~60ms behind the first; totalMs=${second.timing.totalMs} must reflect the queue wait`);
});

test("MCP drive: formatSnapshot surfaces a compact total line on a success snapshot", async () => {
  // A fake drive whose navigate returns a snapshot carrying a timing → the server's formatSnapshot renders
  // a `total: Nms` line (drive SUCCESS surfacing of AC#1).
  const drive = {
    async open() {},
    async navigate(url) { return { url, title: "Example", tree: '- button "Go" [ref=e4]', status: 200, timing: { totalMs: 1234 } }; },
    async snapshot() { return { url: "u", title: "t", tree: "-", timing: { totalMs: 7 } }; },
    async click() { return { url: "u", title: "t", tree: "-" }; },
    async type() { return { url: "u", title: "t", tree: "-" }; },
    async selectOption() { return { url: "u", title: "t", tree: "-" }; },
    async pressKey() { return { url: "u", title: "t", tree: "-" }; },
    async waitFor() { return { url: "u", title: "t", tree: "-" }; },
    async screenshot() { return "QUJD"; },
    async close() {},
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createGatewayMcpServer({ retrieve: async () => ({ markdown: "", title: "", status: 200, blocked: false, reason: null, degraded: false, proxyUsed: false, captchaSolved: false }), drive });
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  const res = await client.callTool({ name: "browser_navigate", arguments: { url: "https://example.com/" } });
  assert.equal(res.isError ?? false, false);
  assert.match(res.content[0].text, /total: 1234ms/, "the compact total line is rendered on success");
});
