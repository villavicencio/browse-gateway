#!/usr/bin/env node
/**
 * R2 (#80) gate — self-inflicted policy blocks, real browser + full gateway, IN-CONTAINER.
 *
 * A main-document navigation the gateway's OWN nav guard aborts (net::ERR_BLOCKED_BY_CLIENT — the guard is
 * the sole client-blocker) must classify as `policy-blocked` carrying the guard's reason, and must NEVER
 * be mistaken for a dead exit (no burned-exit re-roll — a fresh exit can't fix an off-allowlist target).
 * The discriminator is TOP-FRAME-scoped: a benign off-allowlist SUBRESOURCE (ads/analytics/fonts) is
 * ubiquitous and must NOT fail the page. Asserts, against a real Chrome:
 *
 *   1. MAIN-FRAME self-block: render() of an OFF-allowlist host is blocked by the guard →
 *      render.policyBlocked = { host, reason: "host not in consumer allowlist" }, the failure envelope
 *      carries the same via `selfBlockedNav`, classifyFailure(signal) === "policy-blocked", and
 *      isDeadExit(..., policyBlocked) === false (excluded from burned-exit re-roll).
 *   2. BENIGN off-allowlist SUBRESOURCE (no regression): render() of an ALLOWLISTED page that embeds an
 *      off-allowlist <img> renders real content (status 200) and does NOT set policyBlocked — the
 *      subresource block is top-frame-scoped away, exactly as before #80.
 *
 * Loopback fixture on two DISTINCT hosts (127.0.0.1 allowlisted owner; 127.0.0.2 off-allowlist); the
 * policy egress filter (anti-SSRF) is disabled via `egress: () => false` to reach loopback — the ONLY
 * deviation from production policy. A Mac binds only 127.0.0.1 → the off-host legs SKIP loudly there
 * (run in-container for full coverage).
 *
 *   npm run build && node scripts/validate-policy-block.mjs   (in-container: BGW_NO_SANDBOX=1)
 */
import http from "node:http";
import { Gateway, loadConfig } from "../dist/gateway/index.js";
import { PolicyEngine, ConsumerRegistry, InMemoryAuditSink } from "../dist/policy/index.js";
import { classifyFailure, isDeadExit } from "../dist/verbs/index.js";
import { canonicalizeHost } from "../dist/security/index.js";

const TOKEN = "tok-policy-block";
const page = (b) => `<!doctype html><html><body>${b}</body></html>`;

function startServer(host, handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on("error", reject);
    server.listen(0, host, () => resolve({ origin: `http://${host}:${server.address().port}`, host, close: () => new Promise((r) => server.close(r)) }));
  });
}

let failures = 0;
const check = (label, ok) => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) failures++; };

console.log("=== browse-gateway :: R2 (#80) self-inflicted policy blocks (full gateway, real browser) ===");

const OFF_HOST = "127.0.0.2"; // OFF the allowlist
let off = null;
try {
  off = await startServer(OFF_HOST, (req, res) => {
    if (req.url.startsWith("/pixel")) { res.writeHead(200, { "Content-Type": "image/gif" }); return res.end(Buffer.from("R0lGODlhAQABAAAAACw=", "base64")); }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(page("<h1>OFF-ALLOWLIST PAGE — should never be reached</h1>"));
  });
} catch (err) {
  if (process.env.BGW_POLICY_BLOCK_ALLOW_PARTIAL === "1") {
    console.log(`  SKIP (allowed) off-host legs — ${OFF_HOST} unbindable (${err.code ?? err.message})`);
  } else {
    check(`off-host coverage available (${OFF_HOST} bound)`, false);
    console.error(`        ${OFF_HOST} could not bind (${err.code ?? err.message}); set BGW_POLICY_BLOCK_ALLOW_PARTIAL=1 for a macOS-only run.`);
  }
}

// The allowlisted owner page embeds an OFF-allowlist <img> (a benign cross-host subresource) so the guard
// blocks the subresource while the page itself renders — the top-frame-scoping regression check (leg 2).
const owner = await startServer("127.0.0.1", (req, res) => {
  const offImg = off ? `<img src="${off.origin}/pixel.gif" alt="x">` : "";
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(page(`<h1 id="ok">ALLOWLISTED OWNER PAGE</h1><p>${"real content ".repeat(20)}</p>${offImg}`));
});

const audit = new InMemoryAuditSink();
const policy = new PolicyEngine({
  registry: new ConsumerRegistry([{ id: "atlas", token: TOKEN, allow: ["127.0.0.1"] }]), // 127.0.0.2 is OFF
  audit,
  egress: () => false, // the ONLY policy deviation — reach the loopback fixture
});
const config = loadConfig();
config.core.channel = process.env.BGW_CHANNEL ?? "chrome";
config.core.noSandbox = process.env.BGW_NO_SANDBOX === "1";
const gateway = Gateway.create(config, undefined, policy);

const signalFrom = (render) => ({
  title: render.title,
  text: render.text,
  status: render.status,
  finalUrl: render.diagnostics?.finalUrl,
  policyBlocked: render.policyBlocked !== undefined,
});

try {
  await gateway.withConsumerSession(TOKEN, async (session) => {
    // --- Leg 1: a MAIN-FRAME navigation to an OFF-allowlist host → self-inflicted policy block.
    if (off) {
      const blocked = await session.core.render(`${off.origin}/page`, { clearanceTimeoutMs: 6_000 });
      const sb = blocked.policyBlocked;
      check("1. off-allowlist main-frame nav sets render.policyBlocked", sb !== undefined);
      check("1. policyBlocked.host is the blocked off-allowlist host", canonicalizeHost(sb?.host ?? "") === OFF_HOST);
      check("1. policyBlocked.reason is the guard's own block reason", sb?.reason === "host not in consumer allowlist");
      check("1. the failure envelope carries selfBlockedNav (host+reason)", blocked.diagnostics?.selfBlockedNav?.host === OFF_HOST && blocked.diagnostics?.selfBlockedNav?.reason === "host not in consumer allowlist");
      check("1. classifyFailure → policy-blocked (top precedence)", classifyFailure(signalFrom(blocked)) === "policy-blocked");
      check("1. isDeadExit is FALSE — a self-block never re-rolls a fresh exit (no burned-exit)", isDeadExit(blocked.responseReceived, blocked.status, blocked.diagnostics?.finalUrl, blocked.policyBlocked !== undefined) === false);
      // Sanity: without the policyBlocked flag the same null-status render WOULD read as a dead exit — proving
      // the exclusion is load-bearing, not vacuous.
      check("1. (control) the same signal WITHOUT the flag would be a dead exit", isDeadExit(blocked.responseReceived, blocked.status, blocked.diagnostics?.finalUrl, false) === true);
    }

    // --- Leg 2: an ALLOWLISTED page embedding an OFF-allowlist SUBRESOURCE renders — NO page failure.
    const okPage = await session.core.render(`${owner.origin}/embeds-offhost`, { clearanceTimeoutMs: 6_000 });
    check("2. allowlisted page renders real content (status 200)", okPage.status === 200 && okPage.text.includes("ALLOWLISTED OWNER PAGE"));
    check("2. a benign off-allowlist SUBRESOURCE block does NOT set policyBlocked (top-frame-scoped)", okPage.policyBlocked === undefined);
    check("2. the rendered page is NOT classified policy-blocked", classifyFailure(signalFrom(okPage)) !== "policy-blocked");
    if (off) {
      // Confirm the subresource really WAS blocked (so leg 2 is meaningful, not a no-op) — its ERR_BLOCKED_BY_CLIENT
      // rides networkFailures, and the guard audited a subresource block for the off host.
      const subBlocked = audit.records.some((r) => r.action === "navigate" && r.decision === "block" && canonicalizeHost(r.host ?? "") === OFF_HOST);
      check("2. the off-allowlist subresource WAS in fact blocked by the guard (leg is meaningful)", subBlocked);
    }
  });
} finally {
  await gateway.shutdown().catch(() => {});
  await owner.close();
  if (off) await off.close();
}

const verdict = failures === 0 ? "PASS ✅" : "FAIL ❌";
const coverage = off ? "full coverage" : "leg 2 only — off-host legs SKIPPED (run in-container)";
console.log(`\n=== POLICY-BLOCK (R2 #80) GATE: ${verdict} (${failures} failure(s); ${coverage}) ===`);
process.exit(failures === 0 ? 0 : 1);
