#!/usr/bin/env node
/**
 * Real-browser proof of the on-host `vault login` capture path (U8b). Unlike validate-vault-login.mjs
 * (which hand-wires a Gateway), this drives the capture through `buildGatewayRuntime` — the SHARED
 * boot the production `cli/vault-host.js login` entrypoint uses — so it proves the runtime extraction,
 * the consumer-token lookup, and the makeGatewayLoginRunner + captureLoginToVault composition end to
 * end against a real Chrome, exactly as the entrypoint will on-host.
 *
 * It runs IN-PROCESS (not as a subprocess) for one reason: the egress filter blocks loopback as
 * anti-SSRF, so the fixture at 127.0.0.1 is only reachable with `policyEgress: () => false` — a
 * TEST-ONLY in-process hook on buildGatewayRuntime that the deployed entrypoint never passes. The
 * subprocess arg/stdin/token-lookup glue is covered separately by test/vault-host.test.mjs.
 *
 *   npm run build && node scripts/validate-vault-host-login.mjs
 */
import http from "node:http";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { generateSync, verifySync } from "otplib";
import { tokenEnvKey } from "../dist/policy/index.js";
import { buildGatewayRuntime } from "../dist/mcp/runtime.js";
import { makeGatewayLoginRunner } from "../dist/mcp/gateway-login-runner.js";
import { captureLoginToVault, getVaultEntry, buildWarmOverride } from "../dist/mcp/vault-login.js";

const CONSUMER = "atlas";
const USER = "operator@example.test";
const PASS = "correct-horse-battery-staple";
const SEED = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const SID = "sid=vault-host-login-1a2b3c4d";

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
      // Durable session cookie PLUS IP-bound challenge cookies the vault MUST strip on capture.
      return html(res, dashboard, { "Set-Cookie": [`${SID}; Path=/`, "cf_clearance=ip-bound-xyz; Path=/", "__cf_bm=botmgmt-xyz; Path=/"] });
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
const log = (m) => process.stderr.write(`[validate-vault-host-login] ${m}\n`);

console.log("=== browse-gateway :: on-host vault login capstone (U8b, via buildGatewayRuntime) ===");
check("fixture self-check: TOTP verifies server-side", verifySync({ secret: SEED, token: generateSync({ secret: SEED }), epochTolerance: 1 }).valid);

const srv = await startServer();
const root = mkdtempSync(join(tmpdir(), "bgw-vault-host-login-e2e-"));
const vaultDir = join(root, "vault");
const manifestPath = join(root, "consumers.json");
const keyFile = join(root, "vault.key");
const TOKEN = `tok-${randomBytes(24).toString("hex")}`;
writeFileSync(manifestPath, JSON.stringify([{ id: CONSUMER, allow: ["127.0.0.1"] }]));
writeFileSync(keyFile, randomBytes(32).toString("base64"));
chmodSync(keyFile, 0o600);

// The controlled env the on-host entrypoint would inherit from the container — minus the egress
// filter, which we disable via the test-only policyEgress hook so the loopback fixture is reachable.
const env = {
  PATH: process.env.PATH,
  BGW_CHANNEL: process.env.BGW_CHANNEL ?? "chrome",
  ...(process.env.BGW_NO_SANDBOX ? { BGW_NO_SANDBOX: process.env.BGW_NO_SANDBOX } : {}),
  BGW_CONSUMERS_MANIFEST: manifestPath,
  [tokenEnvKey(CONSUMER)]: TOKEN,
  BGW_MAX_SESSIONS: "3",
  BGW_VAULT_DIR: vaultDir,
  BGW_VAULT_KEY_FILE: keyFile,
};

const runtime = buildGatewayRuntime(env, { log, policyEgress: () => false });
try {
  check("runtime opened the vault + loaded the consumer", runtime.vault !== null && runtime.specs.some((s) => s.id === CONSUMER));
  const spec = runtime.specs.find((s) => s.id === CONSUMER);

  const recipe = {
    loginUrl: `http://127.0.0.1:${srv.port}/login`,
    usernameField: "#username",
    passwordField: "#password",
    submit: "#submit",
    totpField: "#code",
    successText: "AUTHENTICATED DASHBOARD",
  };

  // The EXACT composition the entrypoint runs: production login-runner over the runtime's gateway.
  const runLogin = makeGatewayLoginRunner(runtime.gateway, runtime.secrets, spec.token, { onDatacenterIp: runtime.onDatacenterIp });
  await captureLoginToVault(
    { vault: runtime.vault, runLogin },
    { consumerId: CONSUMER, host: "127.0.0.1", recipe, creds: { username: USER, password: PASS, totpSeed: SEED } },
  );

  const entry = getVaultEntry(runtime.vault, CONSUMER, "127.0.0.1");
  const names = (entry?.session.cookies ?? []).map((c) => c.name);
  console.log(`  (captured cookie names: ${JSON.stringify(names)})`);
  check("capture persisted the durable session cookie through the runtime vault", names.includes("sid"));
  check("IP-bound challenge cookies were stripped live (no cf_clearance / __cf_bm)", !names.includes("cf_clearance") && !names.includes("__cf_bm"));
  check("direct capture bound no sticky exit (R7 — proxy is trigger-only)", entry?.stickyExitId === undefined);

  // Warm replay through a fresh session built from the stored entry → lands authenticated.
  const override = buildWarmOverride(runtime.vault, runtime.secrets, { consumerId: CONSUMER, host: "127.0.0.1", onDatacenterIp: false });
  const handle = await runtime.gateway.openConsumerSession(TOKEN, override); // clamp derives from override.restoreState.ownerHost
  try {
    const snap = await runtime.gateway.useConsumerSession(TOKEN, handle, (s) =>
      s.core.navigate(`http://127.0.0.1:${srv.port}/dashboard`, { clearanceTimeoutMs: 3000 }),
    );
    check("warm replay through the runtime gateway lands authenticated", /AUTHENTICATED DASHBOARD/.test(`${snap.title}\n${snap.tree}`));
  } finally {
    await runtime.gateway.closeConsumerSession(TOKEN, handle).catch(() => {});
  }
} finally {
  await runtime.gateway.shutdown().catch(() => {});
  await srv.close();
  rmSync(root, { recursive: true, force: true });
}

const verdict = failures === 0 ? "PASS ✅" : "FAIL ❌";
console.log(`\n=== VAULT-HOST-LOGIN GATE: ${verdict} (${failures} failure(s)) ===`);
process.exit(failures === 0 ? 0 : 1);
