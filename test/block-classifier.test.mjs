/**
 * U1 (issue #21) — the shared block-vendor classifier and PerimeterX detection primitives.
 * classifyBlock is the single source of truth for vendor/hard-block attribution across retrieve
 * (full render → hints from HTML) and drive (PageSnapshot → carried cfHint/pxHint booleans).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyBlock } from "../dist/verbs/index.js";
import { isPerimeterXVisible, hasPerimeterXHint, isPerimeterXChallenge } from "../dist/browser/index.js";

// The real PerimeterX "Press & Hold" interstitial text (from the issue #21 repro).
const PX_TEXT = "Before we continue... Press & Hold to confirm you are a human (and not a bot).";

test("classifyBlock: PerimeterX 'Press & Hold' visible text → perimeterx-challenge", () => {
  assert.equal(classifyBlock({ title: "", text: PX_TEXT, status: 403 }), "perimeterx-challenge");
});

test("classifyBlock: pxHint=true with no visible phrase → perimeterx-challenge (HTML-hint layer)", () => {
  // Thin 403 with the carried PX hint: attributed to PX even though the tree shows no PX phrase,
  // and BEFORE hard-block (the hint is the more specific signal).
  assert.equal(classifyBlock({ title: "", text: "Forbidden", status: 403, pxHint: true }), "perimeterx-challenge");
});

test("classifyBlock: Cloudflare still wins (visible phrase or cfHint) — unchanged", () => {
  assert.equal(classifyBlock({ title: "Just a moment...", text: "", status: 403 }), "cf-challenge");
  assert.equal(classifyBlock({ title: "", text: "Forbidden", status: 403, cfHint: true }), "cf-challenge");
});

test("classifyBlock: 403 + thin body, no vendor markers → hard-block", () => {
  assert.equal(classifyBlock({ title: "", text: "Forbidden", status: 403 }), "hard-block");
});

test("classifyBlock: null status → nav-failed; a real cleared 200 page → null", () => {
  assert.equal(classifyBlock({ title: "x", text: "x".repeat(1000), status: null }), "nav-failed");
  assert.equal(classifyBlock({ title: "Real", text: "x".repeat(1000), status: 200 }), null);
});

test("classifyBlock: PerimeterX press-&-hold served as a 200 (iframe widget) → perimeterx-challenge", () => {
  // The gateway repro (2026-06-22): PX serves the challenge with a 200 and renders its widget in a
  // cross-origin iframe, so the visible phrase never reaches render.text. Only the HTML marker
  // (pxHint) + thin content betray it. Pre-fix this fell through to `null` and the challenge shell
  // was returned as content.
  assert.equal(classifyBlock({ title: "", text: "Before we continue...", status: 200, pxHint: true }), "perimeterx-challenge");
});

test("classifyBlock: a CLEARED PX page (pxHint persists, but real content) is NOT blocked", () => {
  // px-captcha / _px3 markers stay embedded in the HTML after the challenge clears, so pxHint is true
  // on a successful fetch too. Fat content is the discriminator — must not false-positive.
  assert.equal(classifyBlock({ title: "Woodford Reserve", text: "x".repeat(1000), status: 200, pxHint: true }), null);
});

test("classifyBlock: a thin 200 with NO PX marker is still a legit short page, not blocked", () => {
  assert.equal(classifyBlock({ title: "", text: "short", status: 200 }), null);
});

test("isPerimeterXChallenge: pxHint + thin → true; pxHint + fat → false; thin without pxHint → false", () => {
  assert.equal(isPerimeterXChallenge({ text: "Before we continue..." }, true), true);
  assert.equal(isPerimeterXChallenge({ text: "x".repeat(1000) }, true), false);
  assert.equal(isPerimeterXChallenge({ text: "short" }, false), false);
});

test("hasPerimeterXHint: matches distinctive PX markers; a normal page does not", () => {
  assert.equal(hasPerimeterXHint("<script src='//client.perimeterx.net/abc/main.min.js'></script>"), true);
  assert.equal(hasPerimeterXHint("document.cookie = '_pxhd=...; _px3=...'"), true);
  assert.equal(hasPerimeterXHint("<div id='px-captcha'></div>"), true);
  assert.equal(hasPerimeterXHint("<main><h1>Woodford Reserve 1.75L</h1><p>$59.99</p></main>"), false);
});

test("isPerimeterXVisible: matches the press-and-hold / HUMAN phrases; ordinary copy does not", () => {
  assert.equal(isPerimeterXVisible({ title: "", text: PX_TEXT }), true);
  assert.equal(isPerimeterXVisible({ title: "", text: "Powered by HUMAN Security" }), true);
  assert.equal(isPerimeterXVisible({ title: "Cart", text: "Add this item to your shopping cart" }), false);
});
