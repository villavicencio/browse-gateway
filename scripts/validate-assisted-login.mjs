#!/usr/bin/env node
/**
 * Real-browser proof (U6 — assisted login). Drives a fixture login form through the actual
 * assisted-login primitive against real Chrome: navigate → fill credentials → submit → a 2FA stage
 * (a generated TOTP code, server-verified) → the authenticated dashboard → capture the session
 * state. Then a cold-restore leg replays the captured state into a fresh context and confirms it
 * lands authenticated — tying U6's capture to U5's restore. The orchestration logic itself is unit-
 * tested against a fake driver in test/assisted-login.test.mjs; this proves the live BrowserCore path.
 *
 *   npm run build && node scripts/validate-assisted-login.mjs
 */
import http from "node:http";
import { createBrowserCore } from "../dist/browser/index.js";
import { assistedLogin, coreLoginDriver } from "../dist/verbs/index.js";
import { generateSync, verifySync } from "otplib";

// Fixture credentials (fake) + a 160-bit TOTP seed.
const USER = "operator@example.test";
const PASS = "correct-horse-battery-staple";
const SEED = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const COOKIE = "sid=assisted-login-7c4f1a2b";

const page = (body) => `<!doctype html><html><body>${body}</body></html>`;
const loginForm = page(
  `<h1>Sign in</h1><form method="POST" action="/auth">` +
    `<input id="username" name="username"><input id="password" name="password" type="password">` +
    `<button id="submit" type="submit">Sign in</button></form>`,
);
const twofaForm = page(
  `<h1>Enter your 2FA code</h1><form method="POST" action="/verify">` +
    `<input id="code" name="code"><button id="submit" type="submit">Verify</button></form>`,
);
const dashboard = page(`<h1 id="dash">AUTHENTICATED DASHBOARD</h1><a href="/logout">Sign out</a>`);

// SPA login: the submit is a plain button whose handler POSTs via fetch, then renders the dashboard
// CLIENT-SIDE after a delay — so the authenticated DOM is NOT present when click() returns. This is
// the async path the bounded success poll must wait out (the form flow above is settled at click).
const spaLogin = page(
  `<h1>Sign in</h1>` +
    `<input id="username"><input id="password" type="password"><button id="submit" type="button">Sign in</button>` +
    `<script>document.getElementById('submit').addEventListener('click', async () => {` +
    `const u = document.getElementById('username').value, p = document.getElementById('password').value;` +
    `const r = await fetch('/spa-auth', {method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:'username='+encodeURIComponent(u)+'&password='+encodeURIComponent(p)});` +
    `if (r.ok) setTimeout(() => { document.body.innerHTML = '<h1 id=\\'dash\\'>AUTHENTICATED DASHBOARD</h1>'; }, 150);` +
    `});</script>`,
);

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(new URLSearchParams(data)));
  });
}
const hasCookie = (req) => (req.headers.cookie ?? "").includes(COOKIE);
const html = (res, body, headers = {}) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...headers });
  res.end(body);
};

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "GET" && url.pathname === "/login") return html(res, loginForm);
  if (req.method === "POST" && url.pathname === "/auth") {
    const body = await readBody(req);
    // Correct credentials advance to the 2FA stage; anything else is rejected on the same-status page.
    return html(res, body.get("username") === USER && body.get("password") === PASS ? twofaForm : page("<h1>Invalid credentials</h1>"));
  }
  if (req.method === "POST" && url.pathname === "/verify") {
    const body = await readBody(req);
    // Server-side TOTP verification (±1 step tolerance for a window roll between generate and submit).
    const ok = verifySync({ secret: SEED, token: body.get("code") ?? "", epochTolerance: 1 }).valid;
    return ok ? html(res, dashboard, { "Set-Cookie": `${COOKIE}; Path=/` }) : html(res, page("<h1>Invalid code</h1>"));
  }
  if (req.method === "GET" && url.pathname === "/dashboard") {
    return html(res, hasCookie(req) ? dashboard : page("<h1>Please sign in</h1>"));
  }
  if (req.method === "GET" && url.pathname === "/spa") return html(res, spaLogin);
  if (req.method === "POST" && url.pathname === "/spa-auth") {
    const body = await readBody(req);
    if (body.get("username") === USER && body.get("password") === PASS) {
      return html(res, "{}", { "Set-Cookie": `${COOKIE}; Path=/`, "Content-Type": "application/json" });
    }
    res.writeHead(401);
    return res.end("{}");
  }
  res.writeHead(404);
  res.end("not found");
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => void handler(req, res));
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ origin: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

let failures = 0;
const check = (label, ok) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};
const coreOpts = { channel: process.env.BGW_CHANNEL ?? "chrome", noSandbox: process.env.BGW_NO_SANDBOX === "1" };

console.log("=== browse-gateway :: assisted-login proof (U6) ===");
// Sanity: the seed generates a code the fixture server accepts (cross-checks the fixture itself).
check("fixture self-check: generated TOTP verifies server-side", verifySync({ secret: SEED, token: generateSync({ secret: SEED }), epochTolerance: 1 }).valid);

const srv = await startServer();
try {
  // --- Assisted login: drive the form (credentials → 2FA) and capture the authenticated session. ---
  let state;
  {
    const core = await createBrowserCore(coreOpts);
    try {
      const recipe = {
        loginUrl: `${srv.origin}/login`,
        usernameField: "#username",
        passwordField: "#password",
        submit: "#submit",
        totpField: "#code",
        successText: "AUTHENTICATED DASHBOARD",
      };
      const result = await assistedLogin(
        coreLoginDriver(core),
        recipe,
        { username: USER, password: PASS, totpSeed: SEED },
        { fieldTimeoutMs: 8000, pollIntervalMs: 200 },
      );
      state = result.state;
    } finally {
      await core.close();
    }
  }
  const cookie = (state.cookies ?? []).find((c) => COOKIE.startsWith(`${c.name}=`));
  check("assisted login reached the dashboard and captured a session cookie", !!cookie);

  // --- Cold-restore proof (ties capture → U5 restore): the captured state lands authenticated. ---
  const restored = await createBrowserCore({ ...coreOpts, userDataDir: "", restoreState: state });
  try {
    const dash = await restored.render(`${srv.origin}/dashboard`, { clearedTextLength: 0, clearanceTimeoutMs: 3000 });
    check("captured state replays into a cold session as authenticated", /AUTHENTICATED DASHBOARD/.test(`${dash.title}\n${dash.text}`));
  } finally {
    await restored.close();
  }

  // --- SPA leg (PR #30 P1): the dashboard renders client-side ~150ms AFTER the fetch submit, so the
  // success DOM is absent when click() returns. The bounded success poll must wait it out. ---
  {
    const core = await createBrowserCore(coreOpts);
    try {
      const recipe = {
        loginUrl: `${srv.origin}/spa`,
        usernameField: "#username",
        passwordField: "#password",
        submit: "#submit",
        successText: "AUTHENTICATED DASHBOARD",
      };
      const result = await assistedLogin(
        coreLoginDriver(core),
        recipe,
        { username: USER, password: PASS },
        { fieldTimeoutMs: 8000, pollIntervalMs: 200 },
      );
      const spaCookie = (result.state.cookies ?? []).find((c) => COOKIE.startsWith(`${c.name}=`));
      check("SPA login (async client-rendered dashboard) is polled to success, not failed", !!spaCookie);
    } finally {
      await core.close();
    }
  }
} finally {
  await srv.close();
}

const verdict = failures === 0 ? "PASS ✅" : "FAIL ❌";
console.log(`\n=== ASSISTED-LOGIN GATE: ${verdict} (${failures} failure(s)) ===`);
process.exit(failures === 0 ? 0 : 1);
