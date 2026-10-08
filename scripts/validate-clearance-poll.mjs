#!/usr/bin/env node
/**
 * Clearance-poll ceiling proof (VIL-136), through the REAL PatchrightBrowserCore — no mocks.
 *
 * On prod, a thin 404 loaded in 608 ms and then spent 20.2 s polling for clearance it could never
 * reach. The fix caps the poll at UNCLEARABLE_CLEARANCE_POLL_MS for a 404/410/429 that shows NO live
 * Cloudflare challenge. This gate proves both halves against real Chrome:
 *   - the waste is gone: a thin 404 / 410 / 429 (and a 404 carrying a PERSISTENT CF marker, which is
 *     how ordinary CF-fronted 404s look) stops at the cap;
 *   - nothing that can clear lost its wait: a LIVE CF challenge on a 404 keeps the full budget, a
 *     challenge that APPEARS mid-poll extends to the full budget, a thin 200 is unchanged, and a
 *     client-rendered app that serves a 404 shell and hydrates content still clears (the verdict
 *     must not change — only how long we wait).
 *
 * `clearanceWaitedMs` is the poll's sleep counter, so the assertions are on budget arithmetic rather
 * than on wall-clock noise. Pure page behaviour (no anti-bot), so it runs headless on the Mac with
 * patched Chromium AND headful under Xvfb in-container.
 *
 *   BGW_VALIDATE_HEADLESS=0   run headful (default headless; set 0 in-container under Xvfb)
 *   BGW_CHANNEL=chrome        browser channel ("" = patched chromium, the default here)
 *   BGW_NO_SANDBOX=1          pass --no-sandbox (root in container)
 */
import http from "node:http";
import { createBrowserCore, UNCLEARABLE_CLEARANCE_POLL_MS } from "../dist/browser/index.js";

const BUDGET_MS = 6_000; // the clearance budget each render gets — small, so the gate is quick
const LONG = "Real article content. ".repeat(200); // well past the "cleared" content threshold

const page = (status, { title = "Page", body = "", head = "" } = {}) => (res) => {
  res.writeHead(status, { "Content-Type": "text/html" });
  res.end(`<html><head><title>${title}</title>${head}</head><body>${body}</body></html>`);
};

const routes = {
  "/thin404": page(404, { title: "Not Found", body: "nope" }),
  "/thin410": page(410, { title: "Gone", body: "gone" }),
  "/thin429": page(429, { title: "Too Many Requests", body: "slow down" }),
  // An ordinary 404 from a CF-fronted origin: the challenge-platform marker persists, no visible phrase.
  "/cf-marker-404": page(404, { title: "Not Found", body: "nope", head: '<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>' }),
  // A LIVE managed challenge served on a 404: the visible phrase is there, so it must keep its budget.
  "/cf-live-404": page(404, { title: "Just a moment...", body: "Checking your browser before accessing the site." }),
  // A challenge that appears only after the first poll: the limit must be re-derived per poll.
  "/cf-late-404": page(404, {
    title: "Not Found",
    body: `nope<script>setTimeout(() => { document.title = "Just a moment..."; }, 1500);</script>`,
  }),
  // A client-rendered app: 404 shell, real content hydrated 700 ms later — must still clear.
  "/spa-404": page(404, {
    title: "App",
    body: `<div id="root">loading</div><script>setTimeout(() => { document.getElementById("root").textContent = ${JSON.stringify(LONG)}; }, 700);</script>`,
  }),
  // A thin 200 is not an unclearable status: behaviour unchanged (full budget).
  "/thin200": page(200, { title: "Hi", body: "tiny" }),
};

const server = http.createServer((req, res) => (routes[req.url] ?? page(500, { body: "no route" }))(res));
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures++;
};

console.log("=== browse-gateway :: clearance-poll ceiling (VIL-136) ===");
console.log(`budget=${BUDGET_MS}ms  cap=${UNCLEARABLE_CLEARANCE_POLL_MS}ms`);

const core = await createBrowserCore({
  headless: process.env.BGW_VALIDATE_HEADLESS !== "0",
  channel: process.env.BGW_CHANNEL ?? "",
  noSandbox: process.env.BGW_NO_SANDBOX === "1",
});

const render = (path) => core.render(`${base}${path}`, { clearanceTimeoutMs: BUDGET_MS });

try {
  for (const [path, status] of [["/thin404", 404], ["/thin410", 410], ["/thin429", 429], ["/cf-marker-404", 404]]) {
    const r = await render(path);
    check(`${path}: the poll stops at the cap`, r.status === status && r.clearanceWaitedMs <= UNCLEARABLE_CLEARANCE_POLL_MS, `status=${r.status} waited=${r.clearanceWaitedMs}ms`);
  }

  const live = await render("/cf-live-404");
  check("/cf-live-404: a LIVE challenge keeps its full budget", live.clearanceWaitedMs >= BUDGET_MS, `waited=${live.clearanceWaitedMs}ms`);

  const late = await render("/cf-late-404");
  check("/cf-late-404: a challenge appearing mid-poll extends to the full budget", late.clearanceWaitedMs >= BUDGET_MS, `waited=${late.clearanceWaitedMs}ms`);

  const spa = await render("/spa-404");
  check(
    "/spa-404: a hydrating app on a 404 still clears with its content (verdict unchanged)",
    spa.text.includes("Real article content") && spa.clearanceWaitedMs <= UNCLEARABLE_CLEARANCE_POLL_MS,
    `waited=${spa.clearanceWaitedMs}ms textLen=${spa.text.length}`,
  );

  const thin200 = await render("/thin200");
  check("/thin200: a non-unclearable status is unchanged (full budget)", thin200.clearanceWaitedMs >= BUDGET_MS, `waited=${thin200.clearanceWaitedMs}ms`);
} finally {
  await core.close();
  server.close();
}

console.log(failures ? `\n=== CLEARANCE-POLL GATE: FAIL (${failures}) ===` : "\n=== CLEARANCE-POLL GATE: PASS ===");
process.exitCode = failures ? 1 : 0;
