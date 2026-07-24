#!/usr/bin/env node
/**
 * Real-browser proof (PR #25 P1): the core captures CHILD-FRAME html so a PerimeterX press-&-hold
 * rendered inside the `px-captcha-modal` iframe is detectable — `page.content()` serializes the top
 * frame only. Mirrors the project convention (pure logic unit-tested; real browser via validate-*).
 *
 * Fixture: a top document carrying the PX modal element (→ pxHint) + a fat <main> (over the thin bar)
 * + a CROSS-ORIGIN child iframe (a separate-origin data: URL) whose body holds the challenge copy.
 * Asserts: (1) render.html (top frame) does NOT contain the copy, (2) render.frameHtml DOES,
 * (3) the detection signal blocks it as perimeterx-challenge.
 *
 * Run in-container (headful Chrome under Xvfb) or locally with a real Chrome:
 *   npm run build && node scripts/validate-frame-capture.mjs
 */
import { createBrowserCore, hasPerimeterXHint, hasPerimeterXChallengeCopy } from "../dist/browser/index.js";
import { classifyBlock } from "../dist/verbs/index.js";

// Cross-origin child: a data: URL is an opaque origin, distinct from the top page's data: origin.
const childUrl = "data:text/html," + encodeURIComponent("<body><div>Press & Hold to confirm you are a human (and not a bot).</div></body>");
const topUrl =
  "data:text/html," +
  encodeURIComponent(
    `<body><div id="px-captcha-modal"></div>` +
      `<main>Total Wine &amp; More — Folsom, CA. ${"Store and product chrome around the modal. ".repeat(8)}</main>` +
      `<iframe src="${childUrl}"></iframe></body>`,
  );

let failures = 0;
const check = (label, ok) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

console.log("=== browse-gateway :: child-frame capture proof (PR #25 P1) ===");
const core = await createBrowserCore({
  channel: process.env.BGW_CHANNEL ?? "chrome",
  noSandbox: process.env.BGW_NO_SANDBOX === "1",
});
try {
  const render = await core.render(topUrl, { clearanceTimeoutMs: 3000 });
  const copyInTop = hasPerimeterXChallengeCopy(render.html);
  const copyInFrames = hasPerimeterXChallengeCopy(render.frameHtml ?? "");
  const pxHint = hasPerimeterXHint(render.html);
  // status: a data: URL navigation yields null (no HTTP response) — a fixture artifact that classifyBlock
  // would attribute to nav-failed. A real PX challenge is a 200/403; pin 200 so this asserts the
  // captured frame copy drives the perimeterx-challenge verdict, not the data:-URL null status.
  const reason = classifyBlock({
    title: render.title,
    text: render.text,
    status: 200,
    pxHint,
    pxCopy: copyInTop || copyInFrames,
  });

  console.log(
    `  (text.len=${render.text.trim().length}, frameHtml.len=${(render.frameHtml ?? "").length}, pxHint=${pxHint}, status=${render.status})`,
  );
  check("pxHint is set from the top-doc px-captcha-modal element", pxHint === true);
  check("render.html (top frame) does NOT carry the challenge copy — the gap page.content() leaves", copyInTop === false);
  check("render.frameHtml DOES carry the iframe-served challenge copy (cross-origin capture works)", copyInFrames === true);
  check("top-frame innerText is fat (over the thin bar) — proves we are NOT relying on thin content", render.text.trim().length >= 200);
  check("classifyBlock → perimeterx-challenge (iframe copy + pxHint)", reason === "perimeterx-challenge");
} finally {
  await core.close();
}

// ---------------------------------------------------------------------------------------------------
// LATE-copy child frame + an unrelated non-empty iframe (F2, post-#78): the challenge frame commits an EMPTY
// body at DCL and injects the press-&-hold copy on a later async tick, WHILE an unrelated (ad-like) child
// iframe is non-empty from the start. A one-shot read — or a poll that exits on "any non-blank markup" —
// finishes on attempt 0 (the ad frame is non-blank; the challenge frame's skeleton is non-blank) and MISSES
// the copy, returning a live fat-frame challenge as a healthy snapshot. The copy-polling captureChildFrameHtml
// keeps re-reading until the actual press-&-hold copy appears. This is the real PX shape: the modal iframe is
// present early but its challenge copy renders after a network/JS tick.
console.log("\n=== browse-gateway :: LATE-copy child-frame capture proof (F2, poll-for-copy) ===");
// Unrelated ad frame: non-empty immediately, NO PX copy — proves the exit isn't "any non-blank frame".
const adUrl = "data:text/html," + encodeURIComponent("<body><div>Sponsored — totally unrelated ad content here.</div></body>");
// Challenge frame: commits an empty body, then its OWN script injects the press-&-hold copy at ~400ms
// (cross-origin, so only the child itself can populate it; the parent reads it via frame.content()).
const lateCopyChildUrl =
  "data:text/html," +
  encodeURIComponent(
    "<body></body><script>setTimeout(function(){var d=document.createElement('div');" +
      "d.textContent='Press & Hold to confirm you are a human (and not a bot).';" +
      "document.body.appendChild(d);},400);</script>",
  );
const lateTopUrl =
  "data:text/html," +
  encodeURIComponent(
    `<body><div id="px-captcha-modal"></div>` +
      `<main>Total Wine &amp; More — Folsom, CA. ${"Store and product chrome around the modal. ".repeat(8)}</main>` +
      `<iframe src="${adUrl}"></iframe><iframe src="${lateCopyChildUrl}"></iframe></body>`,
  );
const lateCore = await createBrowserCore({
  channel: process.env.BGW_CHANNEL ?? "chrome",
  noSandbox: process.env.BGW_NO_SANDBOX === "1",
});
try {
  const render = await lateCore.render(lateTopUrl, { clearanceTimeoutMs: 3000 });
  const copyInTop = hasPerimeterXChallengeCopy(render.html);
  const copyInFrames = hasPerimeterXChallengeCopy(render.frameHtml ?? "");
  const pxHint = hasPerimeterXHint(render.html);
  const reason = classifyBlock({ title: render.title, text: render.text, status: 200, pxHint, pxCopy: copyInTop || copyInFrames });
  console.log(
    `  (text.len=${render.text.trim().length}, frameHtml.len=${(render.frameHtml ?? "").length}, pxHint=${pxHint}, status=${render.status})`,
  );
  check("pxHint is set from the top-doc px-captcha-modal element (present at DCL)", pxHint === true);
  check("render.html (top frame) does NOT carry the challenge copy", copyInTop === false);
  check("render.frameHtml carries the LATE-injected copy despite a non-empty ad frame + empty skeleton — poll-for-copy recovered it", copyInFrames === true);
  check("classifyBlock → perimeterx-challenge on the late-copy challenge (parity with the inline case)", reason === "perimeterx-challenge");
} finally {
  await lateCore.close();
}

const verdict = failures === 0 ? "PASS ✅" : "FAIL ❌";
console.log(`\n=== FRAME-CAPTURE GATE: ${verdict} (${failures} failure(s)) ===`);
process.exit(failures === 0 ? 0 : 1);
