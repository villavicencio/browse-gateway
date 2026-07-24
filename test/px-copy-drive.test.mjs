/**
 * R4 (#82) — shape-invariant PerimeterX detection on the DRIVE path (parity with retrieve). A press-&-hold
 * challenge's copy lives in the page source / a `px-captcha-modal` CHILD FRAME while the top frame is FAT
 * (modal chrome ≥200 chars), so isHardBlock (needs a THIN body) and isVisiblyBlocked (top-doc innerText)
 * miss it. The scrubbed `pxCopy` boolean + the `(pxHint && pxCopy)` arm of navFailed close the gap so the
 * SAME 403 classifies identically whether the top frame is thin or fat. The pure classification is unit
 * tested here; the REAL child-frame capture is proven in-container by scripts/validate-drive-pxcopy.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { navFailed, classifyFailure, wafVendorFromFailure } from "../dist/verbs/index.js";

const FAT = "modal chrome content ".repeat(20); // >200 chars — NOT a thin body, so isHardBlock can't catch it

test("navFailed: a FAT-top-frame PerimeterX press-&-hold (pxHint + pxCopy) IS a failure (shape-invariant)", () => {
  // a fat 200 whose challenge is in a child frame — the exact case isHardBlock/isVisiblyBlocked miss
  assert.equal(navFailed({ url: "https://x/", title: "", tree: FAT, status: 200, pxHint: true, pxCopy: true }), true);
  // a genuine 403 with the challenge in a fat top frame also caught
  assert.equal(navFailed({ url: "https://x/", title: "", tree: FAT, status: 403, pxHint: true, pxCopy: true }), true);
});

test("navFailed: pxHint ALONE on a fat 200 is NOT a failure (a persistent marker survives a clear — needs pxCopy)", () => {
  // pxHint persists after a challenge clears; without the live challenge COPY the fat page is a real success
  assert.equal(navFailed({ url: "https://x/", title: "", tree: FAT, status: 200, pxHint: true }), false);
  // pxCopy without pxHint never fires the arm (it requires BOTH; pxCopy is only computed when pxHint holds)
  assert.equal(navFailed({ url: "https://x/", title: "", tree: FAT, status: 200, pxCopy: true }), false);
  // a clean fat 200 with neither flag is unchanged (non-regression)
  assert.equal(navFailed({ url: "https://x/", title: "", tree: FAT, status: 200 }), false);
});

test("classifyFailure + wafVendorFromFailure: a fat-frame PX (pxHint + pxCopy) → anti-bot-block / perimeterx (parity with retrieve)", () => {
  const sig = { title: "", text: FAT, status: 200, pxHint: true, pxCopy: true };
  assert.equal(classifyFailure(sig), "anti-bot-block", "the fat-top-frame PX is classified as a WAF block, not a returnable 200");
  assert.equal(wafVendorFromFailure("anti-bot-block", sig), "perimeterx", "attributed to perimeterx via the pxCopy arm");
  // a fat 200 with pxHint but NO pxCopy is a cleared page's persistent marker → NOT a block (empty-shell, no vendor)
  assert.equal(classifyFailure({ title: "", text: FAT, status: 200, pxHint: true }), "empty-shell", "no false-positive on a cleared PX page (persistent marker, no live copy)");
});
