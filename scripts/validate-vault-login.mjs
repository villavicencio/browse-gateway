#!/usr/bin/env node
/**
 * Real-browser, full-gateway proof of the vault capture path (U6d). Drives a fixture login (with a
 * server-verified 2FA stage) THROUGH the real Gateway — authenticate → allowlist-guarded,
 * consumer-bound session → assisted-login → captureStorageState → strip IP-bound tokens → encrypted
 * VaultStore → warm-replay through a fresh gateway session. This is the capstone the unit tests
 * inject fakes for; it also proves the R3 strip live (the fixture sets a real `cf_clearance`).
 *
 * The policy's egress filter normally blocks loopback (anti-SSRF); the test injects `egress: () =>
 * false` so the gateway can reach the 127.0.0.1 fixture — the ONLY deviation from production policy.
 *
 *   npm run build && node scripts/validate-vault-login.mjs
 */
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { generateSync, verifySync } from "otplib";
import { Gateway, loadConfig } from "../dist/gateway/index.js";
import { PolicyEngine, ConsumerRegistry } from "../dist/policy/index.js";
import { SecretStore, VaultStore, canonicalizeHost } from "../dist/security/index.js";
import { makeGatewayLoginRunner } from "../dist/mcp/gateway-login-runner.js";
import { captureLoginToVault, getVaultEntry, buildWarmOverride } from "../dist/mcp/vault-login.js";

const TOKEN = "tok-vault-login";
const USER = "operator@example.test";
const PASS = "correct-horse-battery-staple";
const SEED = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const SID = "sid=vault-login-9a8b7c6d";

const page = (b) => `<!doctype html><html><body>${b}</body></html>`;
const loginForm = page(`<h1>Sign in</h1><form method="POST" action="/auth"><input id="username" name="username"><input id="password" name="password" type="password"><button id="submit" type="submit">Sign in</button></form>`);
const twofaForm = page(`<h1>Enter your 2FA code</h1><form method="POST" action="/verify"><input id="code" name="code"><button id="submit" type="submit">Verify</button></form>`);
const dashboard = page(`<h1 id="dash">AUTHENTICATED DASHBOARD</h1>`);

function readBody(req) {
  return new Promise((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(new URLSearchParams(d))); });
}
const hasSid = (req) => (req.headers.cookie ?? "").includes(SID);
const html = (res, body, headers = {}) => { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...headers }); res.end(body); };

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "GET" && url.pathname === "/login") return html(res, loginForm);
  if (req.method === "POST" && url.pathname === "/auth") {
    const b = await readBody(req);
    return html(res, b.get("username") === USER && b.get("password") === PASS ? twofaForm : page("<h1>Invalid credentials</h1>"));
  }
  if (req.method === "POST" && url.pathname === "/verify") {
    const b = await readBody(req);
    if (verifySync({ secret: SEED, token: b.get("code") ?? "", epochTolerance: 1 }).valid) {
      // The durable session cookie PLUS IP-bound challenge cookies the vault MUST strip on capture.
      return html(res, dashboard, { "Set-Cookie": [`${SID}; Path=/`, "cf_clearance=ip-bound-abc; Path=/", "__cf_bm=botmgmt-abc; Path=/"] });
    }
    return html(res, page("<h1>Invalid code</h1>"));
  }
  if (req.method === "GET" && url.pathname === "/dashboard") return html(res, hasSid(req) ? dashboard : page("<h1>Please sign in</h1>"));
  res.writeHead(404); res.end("not found");
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => void handler(req, res));
    server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, close: () => new Promise((r) => server.close(r)) }));
  });
}

let failures = 0;
const check = (label, ok) => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) failures++; };

console.log("=== browse-gateway :: vault login capstone (U6d, full gateway path) ===");
check("fixture self-check: TOTP verifies server-side", verifySync({ secret: SEED, token: generateSync({ secret: SEED }), epochTolerance: 1 }).valid);

const srv = await startServer();
const vaultDir = mkdtempSync(join(tmpdir(), "bgw-vault-login-e2e-"));
// egress:()=>false is the ONLY policy deviation — it lets the gateway reach the loopback fixture.
const policy = new PolicyEngine({
  registry: new ConsumerRegistry([{ id: "atlas", token: TOKEN, allow: ["127.0.0.1"] }]),
  egress: () => false,
});
const config = loadConfig();
config.core.channel = process.env.BGW_CHANNEL ?? "chrome";
config.core.noSandbox = process.env.BGW_NO_SANDBOX === "1";
const gateway = Gateway.create(config, undefined, policy);
const secrets = new SecretStore(() => ({})); // direct sessions (no proxy) for the local proof
const vault = new VaultStore({ kek: randomBytes(32), dir: vaultDir, canonicalizeHost });

try {
  const recipe = {
    loginUrl: `http://127.0.0.1:${srv.port}/login`,
    usernameField: "#username",
    passwordField: "#password",
    submit: "#submit",
    totpField: "#code",
    successText: "AUTHENTICATED DASHBOARD",
  };
  // --- Capture THROUGH the gateway: authenticate → guarded session → assisted-login → capture → store.
  const runLogin = makeGatewayLoginRunner(gateway, secrets, TOKEN, { onDatacenterIp: false });
  await captureLoginToVault({ vault, runLogin }, { consumerId: "atlas", host: "127.0.0.1", recipe, creds: { username: USER, password: PASS, totpSeed: SEED } });

  const entry = getVaultEntry(vault, "atlas", "127.0.0.1");
  const names = (entry?.session.cookies ?? []).map((c) => c.name);
  console.log(`  (captured cookie names: ${JSON.stringify(names)})`);
  check("capture persisted an entry with the durable session cookie", names.includes("sid"));
  check("IP-bound challenge cookies were stripped live (no cf_clearance / __cf_bm)", !names.includes("cf_clearance") && !names.includes("__cf_bm"));
  // The loopback fixture clears DIRECT, so the runner never escalates → no exit is bound (R7). A
  // bound stickyExitId only appears when escalation actually happens (covered by the runner unit test).
  check("direct capture bound no sticky exit (R7 — proxy is trigger-only)", entry?.stickyExitId === undefined);

  // --- Warm replay through a FRESH gateway session built from the stored entry.
  const override = buildWarmOverride(entry, secrets, { onDatacenterIp: false, ownerHost: "127.0.0.1" });
  const handle = await gateway.openConsumerSession(TOKEN, override, { credentialHost: "127.0.0.1" });
  try {
    const snap = await gateway.useConsumerSession(TOKEN, handle, (s) => s.core.navigate(`http://127.0.0.1:${srv.port}/dashboard`, { clearanceTimeoutMs: 3000 }));
    check("warm replay through the gateway lands authenticated (durable cookie restored)", /AUTHENTICATED DASHBOARD/.test(`${snap.title}\n${snap.tree}`));
  } finally {
    await gateway.closeConsumerSession(TOKEN, handle).catch(() => {});
  }
} finally {
  await gateway.shutdown().catch(() => {});
  await srv.close();
  rmSync(vaultDir, { recursive: true, force: true });
}

const verdict = failures === 0 ? "PASS ✅" : "FAIL ❌";
console.log(`\n=== VAULT-LOGIN GATE: ${verdict} (${failures} failure(s)) ===`);
process.exit(failures === 0 ? 0 : 1);
