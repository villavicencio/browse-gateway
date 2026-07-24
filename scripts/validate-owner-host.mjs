#!/usr/bin/env node
/**
 * R1 (#79) keystone gate — the owner-host contract, real browser + full gateway, IN-CONTAINER.
 *
 * A WARM (credentialed) drive session pins ONE browser context clamped to ONE owner host. The post-#38
 * regression: asking that session to navigate a DIFFERENT host tripped the gateway's own owner-host
 * clamp (net::ERR_BLOCKED_BY_CLIENT → null status → navFailed), and the pinned handler mistook the
 * self-refusal for a dead exit and #discardSession'd a STILL-VALID session (with its live WAF
 * clearance), cold-reopening on a fresh un-warmed exit that re-triggered the WAF. R1 refuses the
 * cross-host nav BEFORE the wire with a typed `owner-host-mismatch` result that PRESERVES the session.
 *
 * Drives the exact regression sequence (open warm host A → cross-host nav → return to A) through a REAL
 * Chrome and the full GatewayDriveController (wired exactly as http-main's buildServer does), asserting:
 *
 *   1. warm-open pins on owner host A (127.0.0.1): navigate(A) lands AUTHENTICATED, exactly ONE
 *      credentialed session-open.
 *   2. a cross-host nav to an IN-SCOPE non-owner host B (127.0.0.2, in the allowlist) is REFUSED with a
 *      typed owner-host-mismatch (own failureClass) advising "open a separate drive session" — WITHOUT
 *      reaching the wire (B's fixture is never fetched) and WITHOUT discarding the session.
 *   3. a cross-host nav to an OFF-SCOPE host (not in the allowlist) is refused with "out of this
 *      consumer's scope" (the second caller-actionable sub-case).
 *   4. RETURN to owner host A still lands AUTHENTICATED on the SAME session — the context (and its live
 *      clearance) survived the cross-host detour, and there is STILL exactly ONE credentialed
 *      session-open (no discard → no cold re-open → no WAF re-trigger). This is finding #1 dissolved.
 *   5. the owner-host CLAMP is still intact (security boundary): guardForCredentialHost BLOCKS a
 *      cross-host navigation request and ALLOWS the owner host — R1 changed the RESPONSE, never the
 *      DECISION (policy/index.ts is untouched).
 *
 * The off-host leg needs a distinct loopback HOST (127.0.0.2, not just a port) so the clamp can tell it
 * apart from the owner. 127.0.0.0/8 is all loopback on Linux (the container); a Mac binds only 127.0.0.1,
 * so off-host legs SKIP loudly there (run in-container for full coverage). The policy egress filter
 * normally blocks loopback (anti-SSRF); the gate injects `egress: () => false` to reach the fixture — the
 * ONLY deviation from production policy. Vault is dormant in prod; the gate uses a temp dir + random KEK.
 *
 *   npm run build && node scripts/validate-owner-host.mjs   (in-container: BGW_NO_SANDBOX=1)
 */
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Gateway, loadConfig } from "../dist/gateway/index.js";
import { PolicyEngine, ConsumerRegistry, Allowlist, InMemoryAuditSink } from "../dist/policy/index.js";
import { SecretStore, VaultStore, canonicalizeHost } from "../dist/security/index.js";
import { createBrowserCore } from "../dist/browser/index.js";
import { GatewayDriveController } from "../dist/mcp/drive-controller.js";
import { importLoginToVault, getVaultEntry } from "../dist/mcp/vault-login.js";
import { failureOf } from "../dist/observability/index.js";

const TOKEN = "tok-owner-host";
const COOKIE = "sid=owner-host-7b2e4c19"; // durable session cookie (not IP-bound → survives capture)
const OFF_SCOPE_HOST = "198.51.100.7"; // RFC5737 TEST-NET-2 — never in the allowlist, never dialed (R1 refuses first)

const page = (b) => `<!doctype html><html><body>${b}</body></html>`;
const hasSid = (req) => (req.headers.cookie ?? "").includes(COOKIE);
const requestLog = []; // [tag, path] — proves host B is NEVER fetched (R1 refuses before the wire)

function makeHandler(tag) {
  return (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    requestLog.push([tag, url.pathname]);
    if (url.pathname === "/login") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Set-Cookie": `${COOKIE}; Path=/; SameSite=Lax` });
      return res.end(page("<h1>LOGIN OK</h1>"));
    }
    if (url.pathname === "/dashboard") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(page(hasSid(req) ? `<h1 id="dash">AUTHENTICATED DASHBOARD</h1>` : `<h1>ANONYMOUS — please sign in</h1>`));
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(page("<h1>HOME</h1>"));
  };
}

function startServer(host, tag) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(makeHandler(tag));
    server.on("error", reject);
    server.listen(0, host, () => {
      resolve({ origin: `http://${host}:${server.address().port}`, host, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

let failures = 0;
const check = (label, ok) => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) failures++; };
const text = (snap) => `${snap.title}\n${snap.tree}`;
const FAST = { clearedTextLength: 0, clearanceTimeoutMs: 3000 };

console.log("=== browse-gateway :: R1 (#79) owner-host contract (full gateway, real browser) ===");

const a = await startServer("127.0.0.1", "A"); // owner host (has a vault entry)
let b = null;
try {
  b = await startServer("127.0.0.2", "B"); // in-scope non-owner host (must never be fetched)
} catch (err) {
  if (process.env.BGW_OWNER_HOST_ALLOW_PARTIAL === "1") {
    console.log(`  SKIP (allowed) in-scope cross-host leg — 127.0.0.2 unbindable (${err.code ?? err.message})`);
  } else {
    check("off-host coverage available (127.0.0.2 bound)", false);
    console.error(
      `        127.0.0.2 could not bind (${err.code ?? err.message}); set BGW_OWNER_HOST_ALLOW_PARTIAL=1 for a ` +
        `macOS owner-host-only dev run (the in-scope cross-host leg then SKIPs — run in-container for full coverage).`,
    );
  }
}

const aHost = "127.0.0.1";
const allow = b ? ["127.0.0.1", "127.0.0.2"] : ["127.0.0.1"]; // B is IN scope; OFF_SCOPE_HOST is not
const vaultDir = mkdtempSync(join(tmpdir(), "bgw-owner-host-e2e-"));
const audit = new InMemoryAuditSink();
const policy = new PolicyEngine({
  registry: new ConsumerRegistry([{ id: "atlas", token: TOKEN, allow }]),
  audit,
  egress: () => false, // the ONLY policy deviation — reach the loopback fixture
});
const credOpens = (host) =>
  audit.records.filter((r) => r.action === "session-open" && r.decision === "open" && r.consumerId === "atlas" && r.host === host);
const config = loadConfig();
config.core.channel = process.env.BGW_CHANNEL ?? "chrome";
config.core.noSandbox = process.env.BGW_NO_SANDBOX === "1";
const gateway = Gateway.create(config, undefined, policy);
const secrets = new SecretStore(() => ({})); // direct (no proxy) for the local/in-container proof
const vault = new VaultStore({ kek: randomBytes(32), dir: vaultDir, canonicalizeHost });

const fetchedTags = () => new Set(requestLog.map(([t]) => t));

try {
  // --- Seed: capture a real logged-in cookie with a throwaway browser, store it ENCRYPTED in the live vault.
  {
    const cap = await createBrowserCore({ channel: config.core.channel, noSandbox: config.core.noSandbox });
    let state;
    try {
      await cap.render(`${a.origin}/login`, FAST);
      state = await cap.captureStorageState();
    } finally {
      await cap.close();
    }
    importLoginToVault(vault, { consumerId: "atlas", host: aHost, session: state, creds: { username: "u", password: "p" } });
    const entry = getVaultEntry(vault, "atlas", aHost);
    check("seed: an encrypted vault entry holds the durable session cookie", (entry?.session.cookies ?? []).some((c) => c.name === "sid"));
  }

  const c1 = new GatewayDriveController(gateway, secrets, TOKEN, {
    onDatacenterIp: false,
    vault,
    consumerId: "atlas",
    allowlist: new Allowlist(allow),
  });
  try {
    // --- Leg 1: warm-open pins on owner host A.
    const warmed = await c1.navigate(`${a.origin}/dashboard`);
    check("1. warm-open via navigate(A) lands AUTHENTICATED (durable cookie restored)", /AUTHENTICATED DASHBOARD/.test(text(warmed)));
    check("1. exactly one credentialed session-open on the owner host", credOpens(aHost).length === 1);

    // --- Leg 2: cross-host nav to an IN-SCOPE non-owner host B → typed refusal, session preserved, no wire.
    if (b) {
      const bFetchesBefore = requestLog.filter(([t]) => t === "B").length;
      const err = await c1.navigate(`${b.origin}/dashboard`).then(() => null, (e) => e);
      check("2. cross-host nav to an in-scope host B is REFUSED", err instanceof Error);
      check("2. the refusal is a typed owner-host-mismatch (own failureClass, NOT nav-failed)", failureOf(err ?? {})?.failureClass === "owner-host-mismatch");
      check("2. the message advises opening a SEPARATE drive session (in-scope sub-case)", /open a separate drive session/i.test(err?.message ?? ""));
      check("2. host B was NEVER fetched — the nav was refused BEFORE the wire", requestLog.filter(([t]) => t === "B").length === bFetchesBefore);
      check("2. no discard — still exactly one credentialed session-open (session preserved)", credOpens(aHost).length === 1);
    }

    // --- Leg 3: cross-host nav to an OFF-SCOPE host → the out-of-scope sub-case.
    {
      const err = await c1.navigate(`http://${OFF_SCOPE_HOST}/x`).then(() => null, (e) => e);
      check("3. cross-host nav to an off-scope host is REFUSED with owner-host-mismatch", failureOf(err ?? {})?.failureClass === "owner-host-mismatch");
      check("3. the message says the host is OUT OF SCOPE (off-scope sub-case)", /out of this consumer's scope/i.test(err?.message ?? ""));
      check("3. still exactly one credentialed session-open (session preserved)", credOpens(aHost).length === 1);
    }

    // --- Leg 4: RETURN to owner host A — the context (and its live clearance) survived the detour.
    const back = await c1.navigate(`${a.origin}/dashboard`);
    check("4. return to owner host A still lands AUTHENTICATED on the SAME session", /AUTHENTICATED DASHBOARD/.test(text(back)));
    check("4. STILL exactly one credentialed session-open — NO cold re-open (finding #1 dissolved)", credOpens(aHost).length === 1);
  } finally {
    await c1.close();
  }

  // --- Leg 5: the owner-host CLAMP is still intact — R1 changed the response, never the decision. A pure
  // guard assertion (policy/index.ts untouched): the clamp BLOCKS a cross-host navigation and ALLOWS the
  // owner. This is the security boundary the pre-flight refusal sits in front of, proven independently.
  {
    const clampPolicy = new PolicyEngine({
      registry: new ConsumerRegistry([{ id: "atlas", token: TOKEN, allow }]),
      egress: () => false,
    });
    const guard = clampPolicy.guardForCredentialHost({ id: "atlas", allowlist: new Allowlist(allow) }, aHost);
    const crossHost = b ? b.host : OFF_SCOPE_HOST;
    check("5. clamp BLOCKS a cross-host navigation (no-exfil boundary intact)", guard({ host: crossHost, url: `http://${crossHost}/x`, isNavigationRequest: true }) === "block");
    check("5. clamp ALLOWS the owner-host navigation (not over-tightened)", guard({ host: aHost, url: `http://${aHost}/x`, isNavigationRequest: true }) === "allow");
  }
} finally {
  await gateway.shutdown().catch(() => {});
  await a.close();
  if (b) await b.close();
  rmSync(vaultDir, { recursive: true, force: true });
}

// Belt-and-braces: across the whole sequence the ONLY host ever fetched was the owner A (never B, never off-scope).
check("across the sequence, ONLY the owner host A was ever fetched (cross-host navs never hit the wire)", [...fetchedTags()].every((t) => t === "A"));

const verdict = failures === 0 ? "PASS ✅" : "FAIL ❌";
const coverage = b ? "full coverage" : "owner-host + off-scope + clamp only — in-scope cross-host leg SKIPPED (run in-container)";
console.log(`\n=== OWNER-HOST (R1 #79) GATE: ${verdict} (${failures} failure(s); ${coverage}) ===`);
process.exit(failures === 0 ? 0 : 1);
