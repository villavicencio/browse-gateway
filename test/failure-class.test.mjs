/**
 * #41 — the typed failure-class taxonomy. classifyFailure layers on the block classifier: the block/nav
 * classes come off resolveBlockReason, and its reason===null arm sub-classifies the 200-states
 * (empty-shell / hydration-failed / real-zero-results / unsupported-browser). wafVendorFromFailure keeps
 * the vendor a PROJECTION of the class (the #40 doctrine). These are pure functions — no browser.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFailure, wafVendorFromFailure, genuineNetworkFailure } from "../dist/verbs/index.js";
import { hasEmptyStateMarker, hasUnsupportedBrowserPhrase, hasFrameworkRoot } from "../dist/browser/index.js";

const PX_TEXT = "Before we continue... Press & Hold to confirm you are a human (and not a bot).";

// --- classifyFailure: the block/nav layer (straight off resolveBlockReason) ---

test("classifyFailure: null status → nav-failed", () => {
  assert.equal(classifyFailure({ title: "", text: "This site can't be reached", status: null }), "nav-failed");
});

test("classifyFailure: a specific WAF vendor (cf/px/datadome) → anti-bot-block", () => {
  assert.equal(classifyFailure({ title: "Just a moment...", text: "", status: 403 }), "anti-bot-block"); // cf visible
  assert.equal(classifyFailure({ title: "", text: "Forbidden", status: 403, cfHint: true }), "anti-bot-block"); // cf hint
  assert.equal(classifyFailure({ title: "", text: PX_TEXT, status: 403 }), "anti-bot-block"); // px visible
  assert.equal(classifyFailure({ title: "", text: "Forbidden", status: 403, pxHint: true }), "anti-bot-block"); // px hint (hard→px)
  assert.equal(classifyFailure({ title: "", text: "Access denied", status: 403, ddHint: true }), "anti-bot-block"); // datadome
});

test("classifyFailure: a generic visible block phrase (no vendor) → anti-bot-block", () => {
  assert.equal(classifyFailure({ title: "", text: "You have been blocked", status: 200 }), "anti-bot-block");
  assert.equal(classifyFailure({ title: "", text: "Access denied", status: 200 }), "anti-bot-block");
});

test("classifyFailure: an ACTIVE interactive CAPTCHA on an otherwise-generic block → captcha", () => {
  // A bare verify page + a detected widget kind: resolveBlockReason promotes hard-block → captcha.
  assert.equal(
    classifyFailure({ title: "Verify", text: "Please verify you are a human", status: 403, captchaKind: "recaptcha" }),
    "captcha",
  );
});

test("classifyFailure: 4xx/5xx + thin body, no vendor marker → hard-block", () => {
  assert.equal(classifyFailure({ title: "", text: "Forbidden", status: 403 }), "hard-block");
  assert.equal(classifyFailure({ title: "", text: "", status: 503 }), "hard-block");
});

test("classifyFailure: a 4xx thin soft-404 with 'no results' copy deliberately stays hard-block, NOT real-zero-results", () => {
  // The empty-state marker is consulted ONLY in the reason===null arm. A 4xx is server-attested failure
  // evidence a genuine (200) zero-results page never carries, so hard-block wins (finding #14).
  assert.equal(classifyFailure({ title: "", text: "No results found", status: 404 }), "hard-block");
});

// --- classifyFailure: the reason===null 200-state arm (retrieve empty-markdown failures) ---

test("classifyFailure: an unsupported-browser interstitial → unsupported-browser (thin OR fat)", () => {
  assert.equal(classifyFailure({ title: "Unsupported browser", text: "Please update your browser to continue.", status: 200 }), "unsupported-browser");
  // FAT wrapper: the definitive phrase is meaningful even above the thin bar — it is checked BEFORE the
  // thin gate, so a full-page interstitial with marketing chrome is not mislabeled empty-shell (finding #11).
  assert.equal(
    classifyFailure({ title: "", text: "Your browser is out of date. " + "x".repeat(400), status: 200 }),
    "unsupported-browser",
  );
});

test("classifyFailure: a fat page that failed extraction (no article) → empty-shell", () => {
  // fat innerText but empty markdown (the boilerplate-only edge): no more specific label fits.
  assert.equal(classifyFailure({ title: "", text: "x".repeat(400), status: 200 }), "empty-shell");
});

test("classifyFailure: a THIN explicit empty-state → real-zero-results", () => {
  assert.equal(classifyFailure({ title: "No results", text: "", status: 200 }), "real-zero-results"); // title-borne
  assert.equal(classifyFailure({ title: "Search", text: "0 results found", status: 200 }), "real-zero-results");
  assert.equal(classifyFailure({ title: "", text: "Your search returned no matches", status: 200 }), "real-zero-results");
});

test("classifyFailure: a THIN shell serving an active captcha widget → empty-shell, NOT captcha (codex #41 r3)", () => {
  // A thin 200 with an active widget kind but NO block phrase: classifyBlock returns null (not blocked), so
  // reason stays null. Promoting it to `captcha`/a widget vendor would make the envelope disagree with the
  // proxy-diagnostic reason (null) — the #40 r3 "one reason" invariant. It is surfaced as empty-shell (the
  // CLASS is delivered); attributing the captcha-shell vendor needs a block-decision detector (deferred).
  const sig = { title: "", text: "", status: 200, captchaKind: "recaptcha" };
  assert.equal(classifyFailure(sig), "empty-shell");
  assert.equal(wafVendorFromFailure(classifyFailure(sig), sig), undefined, "no widget vendor on a not-blocked thin shell");
});

test("classifyFailure: a THIN shell + framework root + a GENUINE failed load → hydration-failed", () => {
  assert.equal(
    classifyFailure({ title: "", text: "", status: 200, frameworkRoot: true, networkFailed: true }),
    "hydration-failed",
  );
});

test("classifyFailure: a dead nav that reached chrome-error:// (stale non-null status) → nav-failed (codex r1/r2)", () => {
  // A client-side nav to a dead host leaves the fresh-page status at the prior 200 while finalUrl records
  // the chrome-error page. The status===null nav-failed test misses it — the finalUrl signal catches it,
  // and it WINS over the content-arm signals (framework root + a genuine failure would otherwise be
  // hydration-failed). Both paths derive finalUrl (retrieve: diagnostics.finalUrl; drive: snapshot url).
  assert.equal(classifyFailure({ title: "", text: "ERR_EMPTY_RESPONSE", status: 200, finalUrl: "chrome-error://chromewebdata/" }), "nav-failed");
  assert.equal(
    classifyFailure({ title: "", text: "", status: 200, frameworkRoot: true, networkFailed: true, finalUrl: "chrome-error://chromewebdata/" }),
    "nav-failed",
    "chrome-error wins over the hydration-failed content signals",
  );
});

test("classifyFailure: a THIN quiet shell (framework root, no genuine failure) → empty-shell (formalized empty-content)", () => {
  assert.equal(classifyFailure({ title: "", text: "", status: 200, frameworkRoot: true, networkFailed: false }), "empty-shell");
  assert.equal(classifyFailure({ title: "", text: "", status: 200 }), "empty-shell"); // no framework root either
});

test("classifyFailure: a THIN 200 carrying a PERSISTENT DataDome marker but no live challenge → empty-shell, NOT anti-bot-block (#40-trap regression)", () => {
  // ddHint persists on a cleared/working DataDome page (block-classifier.test.mjs:147 asserts classifyBlock
  // returns null here). Keying failure attribution on it would re-open the exact #40 false-positive — so a
  // thin DataDome-protected page that merely failed extraction is an honest empty-shell, and NO vendor is
  // fabricated. A live DataDome-challenge (rendered-evidence) detector is a follow-up.
  const sig = { title: "", text: "", status: 200, ddHint: true };
  assert.equal(classifyFailure(sig), "empty-shell");
  assert.equal(wafVendorFromFailure(classifyFailure(sig), sig), undefined, "no datadome fabrication on a persistent marker");
});

// --- wafVendorFromFailure: vendor is a projection of the class (issue #40 doctrine) ---

test("wafVendorFromFailure: anti-bot-block projects the specific WAF vendor off the block reason", () => {
  assert.equal(wafVendorFromFailure("anti-bot-block", { title: "Just a moment...", text: "", status: 403 }), "cloudflare");
  assert.equal(wafVendorFromFailure("anti-bot-block", { title: "", text: "Forbidden", status: 403, pxHint: true }), "perimeterx");
  assert.equal(wafVendorFromFailure("anti-bot-block", { title: "", text: "Access denied", status: 403, ddHint: true }), "datadome");
  // a generic 'blocked' (visible phrase, no vendor marker) is anti-bot-block with NO attributable vendor.
  assert.equal(wafVendorFromFailure("anti-bot-block", { title: "", text: "You have been blocked", status: 200 }), undefined);
});

test("wafVendorFromFailure: captcha projects the widget kind; unknown/absent → undefined", () => {
  assert.equal(wafVendorFromFailure("captcha", { title: "", text: "", status: 200, captchaKind: "recaptcha" }), "recaptcha");
  assert.equal(wafVendorFromFailure("captcha", { title: "", text: "", status: 200, captchaKind: "turnstile" }), "turnstile");
  assert.equal(wafVendorFromFailure("captcha", { title: "", text: "", status: 200, captchaKind: "unknown" }), undefined);
  assert.equal(wafVendorFromFailure("captcha", { title: "", text: "", status: 200 }), undefined);
});

test("wafVendorFromFailure: every non-block content/nav class → undefined (the single empty state, keeps the #39 gate green)", () => {
  const sig = { title: "", text: "", status: 200, ddHint: true, pxHint: true, cfHint: true };
  for (const fc of ["hard-block", "empty-shell", "hydration-failed", "real-zero-results", "unsupported-browser", "nav-failed"]) {
    assert.equal(wafVendorFromFailure(fc, sig), undefined, `${fc} attributes no vendor even with persistent markers present`);
  }
});

// --- genuineNetworkFailure: exclude the allowlist guard's own aborts (finding #3) ---

test("genuineNetworkFailure: guard aborts (BLOCKED_BY_CLIENT) and benign cancellations (ABORTED) do NOT count; real failures do", () => {
  assert.equal(genuineNetworkFailure(["GET https://ads.example/ net::ERR_BLOCKED_BY_CLIENT"]), false);
  // ERR_ABORTED is a normal SPA cancellation (navigate-away / AbortController), not a broken load (codex r6).
  assert.equal(genuineNetworkFailure(["GET https://api.example/data net::ERR_ABORTED"]), false);
  assert.equal(genuineNetworkFailure(["GET https://cdn.example/app.js net::ERR_FAILED"]), true);
  assert.equal(genuineNetworkFailure(["GET https://x net::ERR_CONNECTION_REFUSED"]), true);
  // mixed: at least one genuine failure among benign entries → true.
  assert.equal(genuineNetworkFailure(["GET https://a net::ERR_BLOCKED_BY_CLIENT", "GET https://b net::ERR_ABORTED", "GET https://c net::ERR_TIMED_OUT"]), true);
  // the benign match is anchored to the TRAILING error field — a URL that merely CONTAINS a benign code
  // must not mask a real trailing failure (codex r7).
  assert.equal(genuineNetworkFailure(["GET https://api.example/ERR_ABORTED net::ERR_FAILED"]), true);
  assert.equal(genuineNetworkFailure([]), false);
  assert.equal(genuineNetworkFailure(undefined), false);
});

// --- the new pure detectors ---

test("hasEmptyStateMarker: matches genuine empty-state copy; ordinary content does not", () => {
  assert.equal(hasEmptyStateMarker({ title: "", text: "No results found for 'widgets'" }), true);
  assert.equal(hasEmptyStateMarker({ title: "0 results", text: "" }), true);
  assert.equal(hasEmptyStateMarker({ title: "", text: "Nothing to display" }), true);
  assert.equal(hasEmptyStateMarker({ title: "", text: "We couldn't find any matching products" }), true);
  assert.equal(hasEmptyStateMarker({ title: "Home", text: "The results are in — read our report" }), false); // 'results' alone
  assert.equal(hasEmptyStateMarker({ title: "Cart", text: "Add this item to your shopping cart" }), false);
});

test("hasUnsupportedBrowserPhrase: matches interstitial phrasings; benign copy does not", () => {
  assert.equal(hasUnsupportedBrowserPhrase({ title: "", text: "Your browser is out of date" }), true);
  assert.equal(hasUnsupportedBrowserPhrase({ title: "", text: "Please update your browser" }), true);
  assert.equal(hasUnsupportedBrowserPhrase({ title: "Unsupported browser", text: "" }), true);
  assert.equal(hasUnsupportedBrowserPhrase({ title: "", text: "This browser is no longer supported" }), true);
  assert.equal(hasUnsupportedBrowserPhrase({ title: "", text: "Update your app for the best experience" }), false); // app, not browser
  assert.equal(hasUnsupportedBrowserPhrase({ title: "Docs", text: "Browser support table" }), false);
});

test("hasFrameworkRoot: matches an SPA mount root as a whole token; content / near-misses do not", () => {
  assert.equal(hasFrameworkRoot('<body><div id="root"></div></body>'), true);
  assert.equal(hasFrameworkRoot('<div id="__next"></div>'), true);
  assert.equal(hasFrameworkRoot("<div data-reactroot></div>"), true);
  assert.equal(hasFrameworkRoot('<div id="app" class="x"></div>'), true);
  assert.equal(hasFrameworkRoot('<div id="rootLayout"></div>'), false); // not the whole id token
  assert.equal(hasFrameworkRoot('<div id="approot"></div>'), false);
  assert.equal(hasFrameworkRoot("<main><h1>Real content</h1></main>"), false);
});

test("hasFrameworkRoot: a hyphen/word-prefixed attribute is NOT a real mount root (codex #41 r7)", () => {
  // `\b` matches after a hyphen, so a bare `\bid=` wrongly accepted data-id/aria-id; the (?<![-\w]) guard
  // requires a real attribute-name delimiter. These must NOT read as SPA roots.
  assert.equal(hasFrameworkRoot('<div data-id="root"></div>'), false);
  assert.equal(hasFrameworkRoot('<div aria-id="app"></div>'), false);
  assert.equal(hasFrameworkRoot('<div data-ng-version="17"></div>'), false);
  assert.equal(hasFrameworkRoot('<custom-id="app"></custom-id>'), false);
  // the REAL attributes still resolve.
  assert.equal(hasFrameworkRoot('<div ng-version="17.1.0">app</div>'), true);
  assert.equal(hasFrameworkRoot('<body><div id="root"></div></body>'), true);
});

test("hasFrameworkRoot: dormant markup in a comment / script / template is NOT a live mount root (codex #41 r2)", () => {
  // The #40-trap re-entry: an id="root" example inside inert context must not read as a live SPA shell,
  // else any thin failure with a genuine network error misclassifies as hydration-failed.
  assert.equal(hasFrameworkRoot('<!-- <div id="root"></div> -->'), false); // commented out
  assert.equal(hasFrameworkRoot('<script>var tmpl = \'<div id="app"></div>\';</script>'), false); // script string
  assert.equal(hasFrameworkRoot('<template><div id="__next"></div></template>'), false); // inert template
  assert.equal(hasFrameworkRoot('<style>#root{display:none}</style>'), false); // stylesheet (no id= attr anyway)
  // A REAL mount root alongside a commented-out one still resolves (the live one wins).
  assert.equal(hasFrameworkRoot('<!-- <div id="app"></div> --><body><div id="root"></div></body>'), true);
});
