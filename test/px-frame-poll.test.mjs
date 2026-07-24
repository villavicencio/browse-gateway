/**
 * F2 (post-#78) — the bounded child-frame COPY poll in captureChildFrameHtml. The PerimeterX press-&-hold
 * challenge renders inside a child iframe on a later async tick, so a one-shot read of the child frames can
 * miss the copy (frame not committed yet, an empty skeleton committed first, or an unrelated ad frame making
 * the markup non-blank while the challenge frame is still copy-less). captureChildFrameHtml re-reads until the
 * CHALLENGE COPY appears (not merely non-blank markup), bounded, exiting the instant it appears.
 *
 * This is the LOAD-BEARING regression guard for the poll: a real-browser gate cannot isolate it (render()'s
 * own settle wait outlasts a late injection, so a one-shot read passes the gate too — Codex r2). A fake page
 * whose child frame returns blank→blank→copy is deterministic: it PASSES with the poll and FAILS if
 * captureChildFrameHtml is reverted to a single read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { captureChildFrameHtml } from "../dist/browser/patchright-core.js";
import { hasPerimeterXChallengeCopy } from "../dist/browser/index.js";

const COPY = "<div>Press &amp; Hold to confirm you are a human (and not a bot).</div>"; // serialized as &amp; (real shape)

/** A minimal PatchrightPage stand-in: one child frame whose content() returns the given sequence (last value
 *  repeats), an instant waitForTimeout, plus read/sleep counters so a test can assert the poll actually
 *  re-read and slept. `childCount: 0` models a page with no child frames at all. */
function fakePage(seq, childCount = 1) {
  let reads = 0;
  let sleeps = 0;
  const main = { tag: "main" };
  const child = {
    content: async () => {
      const v = seq[Math.min(reads, seq.length - 1)];
      reads++;
      return v;
    },
  };
  const frames = childCount === 0 ? [main] : [main, child];
  return {
    mainFrame: () => main,
    frames: () => frames,
    waitForTimeout: async () => { sleeps++; },
    get reads() { return reads; },
    get sleeps() { return sleeps; },
  };
}

test("captureChildFrameHtml: recovers a LATE copy — blank, blank, then the copy (fails on a one-shot read)", async () => {
  const page = fakePage(["", "", COPY]);
  const html = await captureChildFrameHtml(page);
  assert.ok(hasPerimeterXChallengeCopy(html), "the late-injected challenge copy is recovered by the poll");
  assert.equal(page.reads, 3, "re-read until the copy appeared (a one-shot would read once and return blank)");
  assert.equal(page.sleeps, 2, "slept between the three reads");
});

test("captureChildFrameHtml: exits on attempt 0 when the copy is already present (~0 cost)", async () => {
  const page = fakePage([COPY]);
  const html = await captureChildFrameHtml(page);
  assert.ok(hasPerimeterXChallengeCopy(html));
  assert.equal(page.reads, 1, "one read, no poll");
  assert.equal(page.sleeps, 0, "no sleeps — a present-copy (or already-loaded) frame pays nothing");
});

test("captureChildFrameHtml: does NOT exit early on non-blank markup that lacks the copy", async () => {
  // An unrelated non-empty ad frame / an empty challenge skeleton is non-blank but copy-less — the OLD
  // 'exit on non-blank' heuristic would stop here and miss the copy. Poll-for-copy keeps going.
  const page = fakePage(['<div>Sponsored ad markup, no challenge.</div>', COPY]);
  const html = await captureChildFrameHtml(page);
  assert.ok(hasPerimeterXChallengeCopy(html), "kept polling past non-blank-but-copy-less markup");
  assert.equal(page.reads, 2, "one extra read past the non-blank-but-copy-less frame");
});

test("captureChildFrameHtml: is BOUNDED — a copy that never appears stops after the attempt cap", async () => {
  const page = fakePage(["", "", "", "", "", ""]); // never yields the copy (models a cleared page)
  const html = await captureChildFrameHtml(page);
  assert.ok(!hasPerimeterXChallengeCopy(html), "no copy → returns copy-less markup");
  assert.equal(page.reads, 4, "initial read + 3 bounded poll attempts, then stop (never unbounded)");
  assert.equal(page.sleeps, 3, "exactly the cap of sleeps");
});

test("captureChildFrameHtml: a page with NO child frames returns blank without hanging", async () => {
  const page = fakePage([], 0);
  const html = await captureChildFrameHtml(page);
  assert.equal(html, "", "no children → blank, bounded (the poll can't find copy that will never come)");
});
