#!/usr/bin/env node
/**
 * R4 (#82) gate — shape-invariant PerimeterX detection on the DRIVE path, real browser, IN-CONTAINER.
 *
 * A "Press & Hold" challenge renders as a widget (canvas/button) inside a `px-captcha-modal` CHILD FRAME
 * while the TOP frame is FAT (store/product modal chrome ≥200 chars). The drive path's existing detection
 * misses it: isHardBlock needs a THIN body (the top frame is fat), and isVisiblyBlocked reads the aria tree
 * — which surfaces only ACCESSIBLE text, not the challenge copy carried in the page/frame SOURCE (a canvas
 * widget + source markers). So the fat-top-frame 403 slipped through as a returnable snapshot, while retrieve
 * (which scans the frame HTML) flagged it — the drive↔retrieve detection-parity gap.
 *
 * R4 gives the drive snapshot a scrubbed `pxCopy` boolean from hasPerimeterXChallengeCopy over the top HTML
 * || the captured CHILD-FRAME HTML (page/frame SOURCE, not the aria tree), gated on pxHint, and adds the
 * `(pxHint && pxCopy)` arm to navFailed.
 *
 * Fixture (served over HTTP so the nav gets a REAL 200 — not a data:-URL null the null-status arm would catch
 * regardless): a top page with the `px-captcha-modal` marker (→ pxHint) + FAT chrome + a child iframe whose
 * challenge COPY lives in the SOURCE (an HTML comment + a bare canvas widget), NOT as accessible text — so
 * the aria tree / isVisiblyBlocked can't see it, but hasPerimeterXChallengeCopy over the frame HTML can.
 * Asserts, against a real Chrome drive navigate():
 *
 *   1. a real 200 with a FAT top frame whose ARIA tree does NOT surface the challenge copy (isVisiblyBlocked
 *      + isHardBlock both miss it — the exact slip-through shape);
 *   2. snap.pxHint (top marker) + snap.pxCopy (the CHILD-FRAME SOURCE copy captured) are both set;
 *   3. navFailed(snap) is TRUE via the shape-invariant arm — and the CONTROL (same snap WITHOUT pxCopy) is
 *      NOT navFailed, proving pxCopy is the load-bearing reason;
 *   4. the drive failure signal classifies `anti-bot-block` / `perimeterx` (parity with retrieve).
 *
 *   npm run build && node scripts/validate-drive-pxcopy.mjs   (in-container: BGW_NO_SANDBOX=1)
 */
import http from "node:http";
import { createBrowserCore } from "../dist/browser/index.js";
import { navFailed, classifyFailure, wafVendorFromFailure } from "../dist/verbs/index.js";

const CHALLENGE_COPY = "Press & Hold to confirm you are a human (and not a bot).";
const FAT_CHROME = "Total Wine &amp; More — Folsom, CA. " + "Store and product chrome around the modal. ".repeat(8);

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  if (req.url.startsWith("/challenge")) {
    // The child frame: the press-&-hold challenge as a WIDGET (canvas) + the copy in the SOURCE (a comment) —
    // NOT accessible text, so the aria tree / isVisiblyBlocked can't see it, but the frame HTML carries it.
    return res.end(`<!doctype html><html><body><!-- ${CHALLENGE_COPY} --><canvas id="px-captcha" width="300" height="80"></canvas></body></html>`);
  }
  // The top page: a PerimeterX marker element (→ pxHint) + FAT chrome + the child iframe.
  res.end(
    `<!doctype html><html><body><div id="px-captcha-modal"></div>` +
      `<main>${FAT_CHROME}</main>` +
      `<iframe src="/challenge"></iframe></body></html>`,
  );
});

let failures = 0;
const check = (label, ok) => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) failures++; };

console.log("=== browse-gateway :: R4 (#82) shape-invariant PerimeterX on the drive path (real browser) ===");

const origin = await new Promise((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
});

const core = await createBrowserCore({
  channel: process.env.BGW_CHANNEL ?? "chrome",
  noSandbox: process.env.BGW_NO_SANDBOX === "1",
});
try {
  const snap = await core.navigate(`${origin}/page`, { clearanceTimeoutMs: 3000 });
  const treeLen = (snap.tree ?? "").trim().length;
  console.log(`  (status=${snap.status}, tree.len=${treeLen}, pxHint=${snap.pxHint}, pxCopy=${snap.pxCopy})`);

  // 1. a real 200, FAT top frame, and the challenge copy NOT in the aria tree (the shape isHardBlock/isVisibly miss).
  check("1. the nav landed a real HTTP 200 (not a null-status abort)", snap.status === 200);
  check("1. the top frame is FAT (>= 200 chars of modal chrome) — isHardBlock's thin-body gate can't fire", treeLen >= 200);
  check("1. the aria tree does NOT surface the press-&-hold copy (isVisiblyBlocked can't see the source-only widget copy)", !/press\s*&?\s*hold/i.test(snap.tree ?? ""));

  // 2. the shape-invariant signals: pxHint (top marker) + pxCopy (child-frame SOURCE copy captured).
  check("2. snap.pxHint is set from the top-doc px-captcha-modal marker", snap.pxHint === true);
  check("2. snap.pxCopy is set from the CHILD-FRAME source copy (shape-invariant capture over frame HTML)", snap.pxCopy === true);

  // 3. navFailed catches it via the pxCopy arm — and the CONTROL proves that arm is load-bearing.
  check("3. navFailed(snap) is TRUE — the fat-top-frame PX is caught (not handed back as a returnable 200)", navFailed(snap) === true);
  check("3. (control) the SAME snapshot WITHOUT pxCopy is NOT navFailed — pxCopy is the load-bearing reason", navFailed({ ...snap, pxCopy: undefined }) === false);

  // 4. classification parity with retrieve: anti-bot-block / perimeterx (via the pxCopy arm).
  const signal = { title: snap.title, text: snap.tree, status: snap.status ?? null, pxHint: snap.pxHint, pxCopy: snap.pxCopy, finalUrl: snap.url };
  check("4. classifyFailure → anti-bot-block (the drive failure signal, parity with retrieve)", classifyFailure(signal) === "anti-bot-block");
  check("4. wafVendorFromFailure → perimeterx (attributed via the pxCopy arm)", wafVendorFromFailure("anti-bot-block", signal) === "perimeterx");
} finally {
  await core.close();
  await new Promise((r) => server.close(r));
}

const verdict = failures === 0 ? "PASS ✅" : "FAIL ❌";
console.log(`\n=== DRIVE-PXCOPY (R4 #82) GATE: ${verdict} (${failures} failure(s)) ===`);
process.exit(failures === 0 ? 0 : 1);
