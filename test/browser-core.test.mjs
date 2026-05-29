/**
 * Unit tests for the browser core's pure logic — challenge detection and launch-option
 * mapping. Network-independent and fast; the real anti-bot bypass is proven by the
 * in-container kill-gate (`scripts/validate-stealth.mjs`), not here.
 *
 * Fixtures are taken from real responses observed during U1 (2026-05-27): Cloudflare's
 * "Just a moment…" interstitial, DataDome's empty block, and — critically — real CF-protected
 * pages (udemy/glassdoor) that render full content while still embedding CF's
 * `challenge-platform` script. That last case is why detection ignores raw HTML.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assess,
  isCleared,
  isVisiblyBlocked,
  matchedBlockPhrases,
  vendorHints,
  MIN_CONTENT_LENGTH,
  STRONG_CONTENT_LENGTH,
  buildLaunchOptions,
  resolveCoreOptions,
  DEFAULT_CORE_OPTIONS,
} from "../dist/browser/index.js";

const realContent = "x".repeat(STRONG_CONTENT_LENGTH + 1);

// A real CF-protected page that CLEARED: real homepage content, but CF's challenge-platform
// script still embedded in the HTML. Must NOT be treated as blocked (the U1 false-positive).
const clearedCfPage = {
  title: "Udemy - Online Courses",
  text: `Explore Subscribe Search for anything ${realContent}`,
  html: '<script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1"></script>',
};

test("matchedBlockPhrases detects a Cloudflare interstitial (title + text)", () => {
  const signal = {
    title: "Just a moment...",
    text: "Enable JavaScript and cookies to continue",
    html: "<div class='cf-chl-opt' id='challenge-platform'></div>",
  };
  assert.ok(matchedBlockPhrases(signal).length >= 2);
});

test("matchedBlockPhrases ignores HTML-only vendor scripts on a cleared page", () => {
  // The regression: challenge-platform is in HTML, not a visible phrase → no block phrase.
  assert.deepEqual(matchedBlockPhrases(clearedCfPage), []);
});

test("vendorHints surfaces persistent CF script as a diagnostic (not a block)", () => {
  const hints = vendorHints(clearedCfPage);
  assert.ok(hints.some((h) => /challenge-platform/.test(h)));
});

test("assess: real CF page with persistent challenge-platform script => GO (regression)", () => {
  const a = assess(clearedCfPage);
  assert.equal(a.verdict, "GO");
  assert.equal(a.blocked, false);
  assert.ok(a.vendorHints.length >= 1, "vendor hint still reported for observability");
});

test("assess: visible CF interstitial => NO-GO", () => {
  const a = assess({
    title: "Just a moment...",
    text: "Enable JavaScript and cookies to continue",
    html: "<div id='challenge-platform'></div>",
  });
  assert.equal(a.verdict, "NO-GO");
  assert.equal(a.blocked, true);
});

test("assess: empty body (DataDome block) => NO-GO by content length", () => {
  // DataDome's block renders the captcha in an iframe — visible text is empty.
  const a = assess({ title: "g2.com", text: "", html: "geo.captcha-delivery.com datadome" });
  assert.equal(a.verdict, "NO-GO");
  assert.equal(a.blocked, true);
  assert.equal(a.textLength, 0);
});

test("assess: real content, no block phrases => GO", () => {
  const a = assess({ title: "Article", text: realContent, html: "<main/>" });
  assert.equal(a.verdict, "GO");
  assert.equal(a.blocked, false);
});

test("assess: content between MIN and STRONG, no phrases => INCONCLUSIVE", () => {
  const mid = "y".repeat(MIN_CONTENT_LENGTH + 1);
  assert.ok(mid.length > MIN_CONTENT_LENGTH && mid.length <= STRONG_CONTENT_LENGTH);
  const a = assess({ title: "x", text: mid, html: "<p/>" });
  assert.equal(a.verdict, "INCONCLUSIVE");
  assert.equal(a.blocked, false);
});

test("isCleared: true only when no block phrase AND content strong (default kill-gate bar)", () => {
  assert.equal(isCleared(clearedCfPage), true);
  assert.equal(isCleared({ title: "Just a moment...", text: realContent, html: "" }), false);
  assert.equal(isCleared({ title: "x", text: "short", html: "<p/>" }), false); // < STRONG bar
});

test("isCleared: low threshold (retrieve path) clears short real pages fast", () => {
  // A legitimately short page (no block phrase, real text) clears immediately instead of
  // polling to the full clearance timeout — the fix for the short-page latency/DoS bug.
  assert.equal(isCleared({ title: "x", text: "a short but genuine article body" }, 0), true);
  assert.equal(isCleared({ title: "Just a moment...", text: "loading" }, 0), false); // phrase still blocks
  assert.equal(isCleared({ title: "", text: "   " }, 0), false); // whitespace only -> keep polling
});

test("isVisiblyBlocked: true only for a visible block phrase, not thin content", () => {
  assert.equal(isVisiblyBlocked({ title: "Just a moment...", text: "" }), true);
  assert.equal(isVisiblyBlocked({ title: "Short", text: "tiny" }), false); // thin but NOT a block
  assert.equal(isVisiblyBlocked({ title: "Article", text: realContent }), false);
});

test("resolveCoreOptions: defaults are headful + real chrome", () => {
  const r = resolveCoreOptions();
  assert.equal(r.headless, false);
  assert.equal(r.channel, "chrome");
  assert.equal(r.noSandbox, false);
  assert.deepEqual(r, DEFAULT_CORE_OPTIONS);
});

test("resolveCoreOptions: explicit overrides win (incl. headless:true)", () => {
  const r = resolveCoreOptions({ headless: true, channel: "", noSandbox: true });
  assert.equal(r.headless, true);
  assert.equal(r.channel, "");
  assert.equal(r.noSandbox, true);
});

test("buildLaunchOptions: headful real-chrome, no sandbox arg by default", () => {
  const opts = buildLaunchOptions(resolveCoreOptions());
  assert.equal(opts.headless, false);
  assert.equal(opts.channel, "chrome");
  assert.equal(opts.args, undefined);
});

test("buildLaunchOptions: empty channel omitted (patched chromium), --no-sandbox added", () => {
  const opts = buildLaunchOptions(resolveCoreOptions({ channel: "", noSandbox: true }));
  assert.ok(!("channel" in opts), "channel should be omitted when empty");
  assert.deepEqual(opts.args, ["--no-sandbox"]);
});

test("buildLaunchOptions: headless negative-control config maps through", () => {
  const opts = buildLaunchOptions(resolveCoreOptions({ headless: true }));
  assert.equal(opts.headless, true);
});
