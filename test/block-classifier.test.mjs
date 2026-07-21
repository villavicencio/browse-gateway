/**
 * U1 (issue #21) — the shared block-vendor classifier and PerimeterX detection primitives.
 * classifyBlock is the single source of truth for vendor/hard-block attribution across retrieve
 * (full render → hints from HTML) and drive (PageSnapshot → carried cfHint/pxHint booleans).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyBlock, wafVendorFromReason } from "../dist/verbs/index.js";
import {
  isPerimeterXVisible,
  hasPerimeterXHint,
  hasDataDomeHint,
  isPerimeterXChallenge,
  hasPerimeterXChallengeCopy,
} from "../dist/browser/index.js";

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

test("classifyBlock: a boundary-length 200 PX challenge (fat innerText, copy in source) → perimeterx-challenge", () => {
  // The case #24 missed: top-doc innerText is over the thin bar (the press-&-hold is in an iframe), so
  // isPerimeterXChallenge(thin) is false — but pxHint + the challenge copy in source (pxCopy) catches it.
  assert.equal(
    classifyBlock({ title: "", text: "x".repeat(220), status: 200, pxHint: true, pxCopy: true }),
    "perimeterx-challenge",
  );
});

test("classifyBlock: a cleared PX page with fat content + persistent marker but NO challenge copy → null", () => {
  // pxHint persists on a cleared page; pxCopy is what's absent. Fat content + pxCopy=false → not blocked.
  assert.equal(classifyBlock({ title: "Woodford", text: "x".repeat(1000), status: 200, pxHint: true, pxCopy: false }), null);
});

test("hasPerimeterXChallengeCopy: matches the press-&-hold / HUMAN copy in HTML; a cleared product page does not", () => {
  assert.equal(hasPerimeterXChallengeCopy("<div>Press &amp; Hold to confirm you are a human</div>"), true);
  assert.equal(hasPerimeterXChallengeCopy("<footer>Powered by HUMAN Security</footer>"), true);
  // Cleared Total Wine page: px-captcha modal id present (vendor marker), but no challenge copy.
  assert.equal(hasPerimeterXChallengeCopy("<div id='px-captcha-modal'></div><h1>Woodford Reserve 1.75L</h1><p>$59.99</p>"), false);
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

// --- DataDome (issue #40) ---

test("hasDataDomeHint: matches the DataDome CDN + cookie family; a normal page does not", () => {
  assert.equal(hasDataDomeHint("<script src='https://js.datadome.co/tags.js'></script>"), true);
  assert.equal(hasDataDomeHint("<iframe src='https://geo.captcha-delivery.com/captcha/?initialCid=...'></iframe>"), true);
  assert.equal(hasDataDomeHint("document.cookie = 'datadome=abc; dd_cookie=1'"), true);
  assert.equal(hasDataDomeHint("<main><h1>Woodford Reserve 1.75L</h1><p>$59.99</p></main>"), false);
});

test("classifyBlock: a blocked page carrying a DataDome marker → datadome-challenge (not generic blocked)", () => {
  // A DataDome interstitial: a visible generic block phrase makes it blocked; the ddHint re-labels it
  // from the generic 'blocked' fallthrough to a distinct datadome-challenge (the #40 fix).
  assert.equal(
    classifyBlock({ title: "", text: "Access denied", status: 403, ddHint: true }),
    "datadome-challenge",
  );
});

test("classifyBlock: a DataDome 403 + thin body → datadome-challenge (not hard-block)", () => {
  // Pre-#40 a bare DataDome 403 fell through to hard-block; the ddHint branch (before hard-block) now
  // attributes it. Escalation is unaffected — it keys off isHardBlock(signal), not this label.
  assert.equal(classifyBlock({ title: "", text: "Forbidden", status: 403, ddHint: true }), "datadome-challenge");
});

test("classifyBlock: Cloudflare and PerimeterX still WIN over a co-occurring DataDome marker (precedence)", () => {
  // A page tripping overlapping vendor markers attributes to whichever `reason` reports first — cf > px >
  // dd — so reason and the derived wafVendor can never name different vendors on the same envelope.
  assert.equal(classifyBlock({ title: "Just a moment...", text: "", status: 403, cfHint: true, ddHint: true }), "cf-challenge");
  assert.equal(classifyBlock({ title: "", text: "Forbidden", status: 403, pxHint: true, ddHint: true }), "perimeterx-challenge");
});

test("classifyBlock: a CLEARED page whose DataDome marker persists (200, fat content) is NOT blocked", () => {
  // datadome/dd_cookie markers stay embedded after a challenge clears, so ddHint is true on success; the
  // outer !blocked guard (fat 200) means the datadome-challenge branch is never reached — no false-positive.
  assert.equal(classifyBlock({ title: "Product", text: "x".repeat(1000), status: 200, ddHint: true }), null);
});

test("classifyBlock: a thin 200 with a DataDome marker but no block phrase is a legit short page, not blocked", () => {
  // ddHint is attribution-only (like cfHint/pxHint) — never a `blocked` input. A thin 200 with no visible
  // block phrase and no PX press-&-hold stays a legitimately short page.
  assert.equal(classifyBlock({ title: "", text: "short", status: 200, ddHint: true }), null);
});

// --- wafVendorFromReason: vendor is a projection of the reason (issue #40) ---

test("wafVendorFromReason: each WAF reason maps to its vendor; captcha uses the widget kind", () => {
  assert.equal(wafVendorFromReason("cf-challenge"), "cloudflare");
  assert.equal(wafVendorFromReason("perimeterx-challenge"), "perimeterx");
  assert.equal(wafVendorFromReason("datadome-challenge"), "datadome");
  assert.equal(wafVendorFromReason("captcha", "recaptcha"), "recaptcha");
  assert.equal(wafVendorFromReason("captcha", "hcaptcha"), "hcaptcha");
  assert.equal(wafVendorFromReason("captcha", "turnstile"), "turnstile");
});

test("wafVendorFromReason: unattributable reasons → undefined (the single empty state, keeps the #39 gate green)", () => {
  for (const r of ["nav-failed", "hard-block", "blocked", null]) {
    assert.equal(wafVendorFromReason(r), undefined);
  }
  // captcha with no/unknown kind is unattributed rather than mislabeled.
  assert.equal(wafVendorFromReason("captcha"), undefined);
  assert.equal(wafVendorFromReason("captcha", "unknown"), undefined);
});

test("wafVendorFromReason∘classifyBlock: the surfaced vendor NEVER contradicts the reason (structural agreement)", () => {
  // The whole point of deriving vendor FROM the reason: for any signal, the two agree by construction.
  const sigs = [
    { title: "Just a moment...", text: "", status: 403, cfHint: true },
    { title: "", text: "Forbidden", status: 403, pxHint: true },
    { title: "", text: "Access denied", status: 403, ddHint: true },
    { title: "Just a moment...", text: "", status: 403, cfHint: true, ddHint: true }, // co-occurring markers
    { title: "", text: "Forbidden", status: 403, pxHint: true, ddHint: true },
  ];
  const reasonToVendor = { "cf-challenge": "cloudflare", "perimeterx-challenge": "perimeterx", "datadome-challenge": "datadome" };
  for (const sig of sigs) {
    const reason = classifyBlock(sig);
    assert.equal(wafVendorFromReason(reason), reasonToVendor[reason], `reason=${reason} must map to its own vendor`);
  }
});
