#!/usr/bin/env node
/**
 * Real-browser proof (U5 — credential vault Phase 2): a session captured once via
 * `captureStorageState()` replays into a COLD, ephemeral context as logged-in. This is the
 * capture → store → restore lifecycle KTD-3/KTD-4 describe, minus the encryption layer (U4) and
 * the vault wiring (U6) — it proves the browser-core surface in isolation, the way the anti-bot
 * bypass is proven by the kill-gate and the child-frame capture by validate-frame-capture.mjs.
 *
 * Fixture: a tiny loopback server with two routes:
 *   /login — Set-Cookie a session cookie + an inline script that writes a localStorage token.
 *   /app   — reflects, server-side, whether the session COOKIE arrived (AUTHENTICATED/ANONYMOUS)
 *            and, client-side, the restored localStorage value (ls=… / ls=MISSING).
 * Two server instances on the SAME host, DIFFERENT ports → two distinct origins:
 *   Origin A (capture + restore-match): cold restore must show AUTHENTICATED + the ls token.
 *   Origin B (origin-guard negative):   localStorage is origin-scoped (port included) → ls=MISSING,
 *            proving the init script never seeds another origin's store. (The cookie IS sent to B —
 *            cookies are host-scoped, port-agnostic — so we assert only the localStorage guard here.)
 *
 * Run in-container (headful Chrome under Xvfb) or locally with a real Chrome:
 *   npm run build && node scripts/validate-vault-roundtrip.mjs
 */
import http from "node:http";
import { createBrowserCore } from "../dist/browser/index.js";

// Fake fixture secrets (not real credentials) — distinctive so we can grep them out of the page.
const COOKIE_NAME = "vault_session";
const COOKIE_VAL = "cookie-roundtrip-7f3a9c21";
const LS_KEY = "vault_ls_token";
const LS_VAL = "ls-roundtrip-b8e6d4f0";

function parseCookies(header) {
  const out = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/login") {
    res.setHeader("Set-Cookie", `${COOKIE_NAME}=${COOKIE_VAL}; Path=/; SameSite=Lax`);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      `<!doctype html><html><body><h1>LOGIN OK</h1>` +
        `<script>localStorage.setItem(${JSON.stringify(LS_KEY)}, ${JSON.stringify(LS_VAL)});</script>` +
        `</body></html>`,
    );
    return;
  }
  if (url.pathname === "/app") {
    const authed = parseCookies(req.headers.cookie)[COOKIE_NAME] === COOKIE_VAL;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      `<!doctype html><html><body>` +
        `<h1 id="auth">${authed ? "AUTHENTICATED" : "ANONYMOUS"}</h1>` +
        `<p id="ls">ls=PENDING</p>` +
        `<script>document.getElementById('ls').textContent = ` +
        `'ls=' + (localStorage.getItem(${JSON.stringify(LS_KEY)}) || 'MISSING');</script>` +
        `</body></html>`,
    );
    return;
  }
  res.statusCode = 404;
  res.end("not found");
}

/** Start an HTTP server on an ephemeral loopback port; resolve with {origin, close}. */
function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

let failures = 0;
const check = (label, ok) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};
// Short real pages: clear immediately (clearedTextLength:0) instead of polling to the full timeout.
const FAST = { clearedTextLength: 0, clearanceTimeoutMs: 3000 };
const coreOpts = {
  channel: process.env.BGW_CHANNEL ?? "chrome",
  noSandbox: process.env.BGW_NO_SANDBOX === "1",
};

console.log("=== browse-gateway :: vault storageState round-trip proof (U5) ===");

const a = await startServer();
const b = await startServer();
try {
  // --- Capture phase: log in on origin A, snapshot the session state, tear the browser down. ---
  let state;
  {
    const core = await createBrowserCore(coreOpts);
    try {
      await core.render(`${a.origin}/login`, FAST);
      state = await core.captureStorageState();
    } finally {
      await core.close();
    }
  }
  const cookie = (state.cookies ?? []).find((c) => c.name === COOKIE_NAME);
  const originEntry = (state.origins ?? []).find((o) => o.origin === a.origin);
  const lsEntry = originEntry?.localStorage?.find((e) => e.name === LS_KEY);
  console.log(
    `  (captured cookies=${state.cookies?.length ?? 0}, origins=${state.origins?.length ?? 0}, ` +
      `cookieFound=${!!cookie}, lsFound=${!!lsEntry})`,
  );
  check("captured the session cookie", cookie?.value === COOKIE_VAL);
  check("captured the per-origin localStorage token", lsEntry?.value === LS_VAL);

  // --- Restore phase: a COLD core (clean ephemeral profile) seeded only with the captured state. ---
  const restored = await createBrowserCore({ ...coreOpts, userDataDir: "", restoreState: { state, ownerHost: "127.0.0.1" } });
  try {
    const appA = await restored.render(`${a.origin}/app`, FAST);
    const textA = `${appA.title}\n${appA.text}`;
    check("origin A: cookie restored → server sees the session (AUTHENTICATED)", /AUTHENTICATED/.test(textA));
    check("origin A: localStorage restored → page reads the seeded token", textA.includes(`ls=${LS_VAL}`));
    check("origin A: not a stale ANONYMOUS/MISSING render", !/ANONYMOUS/.test(textA) && !/ls=MISSING/.test(textA));

    // Origin-guard: the SAME stored state must NOT seed localStorage on a different origin (port B).
    const appB = await restored.render(`${b.origin}/app`, FAST);
    const textB = `${appB.title}\n${appB.text}`;
    check("origin B: localStorage NOT seeded (origin-guard holds — ls=MISSING)", textB.includes("ls=MISSING"));
    check("origin B: captured token value does not leak onto origin B", !textB.includes(LS_VAL));
  } finally {
    await restored.close();
  }

  // --- Failure path: a malformed/legacy persisted cookie (no domain/path) makes addCookies reject
  // AFTER Chrome has launched. launch() must surface that rejection (restoreOrClose closes the
  // orphaned context first). Here we prove the rejection end-to-end against real Chrome; the
  // close-is-called invariant is asserted in the unit test with a fake context. ---
  let rejected = false;
  try {
    const bad = { cookies: [{ name: "sid", value: "x" }], origins: [] }; // no domain/url → addCookies throws
    const leaky = await createBrowserCore({ ...coreOpts, userDataDir: "", restoreState: { state: bad, ownerHost: "127.0.0.1" } });
    await leaky.close(); // should not be reached; clean up if it somehow was
  } catch {
    rejected = true;
  }
  check("malformed restoreState → launch rejects (context closed, not orphaned)", rejected);
} finally {
  await a.close();
  await b.close();
}

const verdict = failures === 0 ? "PASS ✅" : "FAIL ❌";
console.log(`\n=== VAULT-ROUNDTRIP GATE: ${verdict} (${failures} failure(s)) ===`);
process.exit(failures === 0 ? 0 : 1);
