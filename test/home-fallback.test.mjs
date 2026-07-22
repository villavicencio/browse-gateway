/**
 * #48 — silent home-fallback detector.
 *
 * A deep link (non-root path / query) that silently lands on the site's bare root is FLAGGED, so a caller
 * can tell a real zero-result from lost location/query state instead of the homepage being handed back as
 * the requested page. Three axes, mirroring the burned-exit shape (#45):
 *  - `isHomeFallback` is a PURE derivation over signals both verbs already carry (the requested URL + the
 *    landed finalUrl) — the shared predicate that keeps retrieve and drive at DETECTION parity. Positive-
 *    signal-only + same-host + query-drop-aware, so ordinary redirects / preserved queries never trip it.
 *  - retrieve surfaces it as an OUTCOME flag: `result.homeFallback` on BOTH shapes (a fat-homepage success
 *    carries no envelope, so the top-level flag is its only carrier), and folded into the failure envelope.
 *  - drive ANNOTATES the returned snapshot (`snap.homeFallback`) — a homepage is a returnable snapshot,
 *    never a drive failure, so the disposition differs while the detector is shared.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { retrieve, isHomeFallback } from "../dist/verbs/index.js";
import { redactFailureDiagnostics } from "../dist/observability/index.js";
import { SecretStore } from "../dist/security/index.js";
import { GatewayDriveController } from "../dist/mcp/drive-controller.js";

const REAL = "real accessibility tree ".repeat(60); // > MIN_CONTENT_LENGTH
const ARTICLE = `<!doctype html><html><head><title>Store Home</title></head><body><nav>menu</nav>
<article><h1>Welcome</h1><p>${"Homepage marketing copy with plenty of words. ".repeat(20)}</p>
<p>${"A second substantial homepage paragraph for the reader. ".repeat(20)}</p></article>
<footer>foot</footer></body></html>`;

const DEEP = "https://store.example/search?q=milk"; // a deep search link
const ROOT = "https://store.example/"; // the bare homepage it silently fell back to

// --- the shared pure predicate (the parity primitive) --------------------------------------------

test("isHomeFallback: a deep path collapsed to the same-host root FIRES", () => {
  assert.equal(isHomeFallback(DEEP, ROOT), true, "deep path + query → bare root");
  assert.equal(isHomeFallback("https://s.example/a/b/c", "https://s.example/"), true, "deep multi-segment → root");
  assert.equal(isHomeFallback("https://s.example/deep", "https://s.example/?utm_source=ad"), true, "landed root path, TRACKING query is ignored when the PATH carried the depth");
});

test("isHomeFallback: a query-only deep link FIRES only when the query was DROPPED", () => {
  assert.equal(isHomeFallback("https://s.example/?store=123", "https://s.example/"), true, "query dropped entirely");
  assert.equal(isHomeFallback("https://s.example/?store=123", "https://s.example/?utm_source=ad"), true, "landing carries only a tracking param → the store intent was dropped");
  assert.equal(isHomeFallback("https://s.example/?store=123", "https://s.example/?store=123"), false, "same query preserved → NOT a fallback");
  assert.equal(isHomeFallback("https://s.example/?store=123&x=1", "https://s.example/?store=123"), false, "a requested key survived → NOT a fallback");
});

test("isHomeFallback: conservative — ordinary redirects and root requests never trip it", () => {
  assert.equal(isHomeFallback("https://s.example/deep", "https://s.example/deep"), false, "deep → same deep");
  assert.equal(isHomeFallback("https://s.example/deep", "https://s.example/deep/"), false, "trailing-slash canonicalization");
  assert.equal(isHomeFallback("https://s.example/a", "https://s.example/b"), false, "deep → other deep (a different page, not home)");
  assert.equal(isHomeFallback("https://s.example/", "https://s.example/"), false, "a legitimately root-only request");
  assert.equal(isHomeFallback("https://s.example/", "https://s.example/?utm=ad"), false, "root request → root (campaign param added) is not a lost deep link");
});

test("isHomeFallback: a tracking-only root request stripped to a clean root is NOT a fallback (codex review)", () => {
  // A homepage requested with disposable campaign metadata, canonicalized to `/` — nothing was lost.
  assert.equal(isHomeFallback("https://shop.example/?utm_source=email", "https://shop.example/"), false, "utm_* stripped → not a fallback");
  assert.equal(isHomeFallback("https://shop.example/?gclid=abc123", "https://shop.example/"), false, "gclid stripped");
  assert.equal(isHomeFallback("https://shop.example/?utm_source=email", "https://shop.example/?ref=home"), false, "tracking → tracking, no intent key present either side");
  assert.equal(isHomeFallback("https://shop.example/?utm_source=email&q=milk", "https://shop.example/"), true, "a REAL intent key (q) alongside tracking, dropped → still a fallback");
});

test("isHomeFallback: an index-filename canonicalization is NOT a fallback (codex review)", () => {
  assert.equal(isHomeFallback("https://s.example/index.html", "https://s.example/"), false, "/index.html → / is root-equivalent");
  assert.equal(isHomeFallback("https://s.example/default.aspx", "https://s.example/"), false, "/default.aspx → /");
  assert.equal(isHomeFallback("https://s.example/foo/index.html", "https://s.example/"), true, "/foo/index.html → / still lost the /foo depth");
});

test("isHomeFallback: a deep path whose intent-bearing query SURVIVED is depth-preserved, not a fallback (codex review)", () => {
  assert.equal(isHomeFallback("https://s.example/search?q=milk", "https://s.example/?q=milk"), false, "/search?q=x → /?q=x endpoint move preserved the query intent");
  assert.equal(isHomeFallback("https://s.example/search?q=milk", "https://s.example/"), true, "same deep search, query ALSO dropped → a fallback");
  assert.equal(isHomeFallback("https://s.example/search?q=milk&utm_source=x", "https://s.example/?utm_source=x"), true, "only the TRACKING key survived, the intent key q was lost → a fallback");
});

test("isHomeFallback: hash-router (/#/deep) is a conservative false-negative (documented deferral)", () => {
  assert.equal(isHomeFallback("https://s.example/#/deep", "https://s.example/"), false, "route lives in the fragment; pathname is '/' so depth is not seen (deferred)");
});

test("isHomeFallback: a deep path canonicalized into a LANDED fragment (hash route) is NOT a fallback (codex r2)", () => {
  // The landed pathname is '/' but the deep state is preserved in the fragment — not a bare root.
  assert.equal(isHomeFallback("https://s.example/products/123", "https://s.example/#/products/123"), false, "path → hash-route preserved the state");
  assert.equal(isHomeFallback("https://s.example/search?q=milk", "https://s.example/#/search?q=milk"), false, "query intent preserved in the fragment route");
});

test("isHomeFallback: a path→query canonicalization that PRESERVES state in the landed query is NOT a fallback (codex r3)", () => {
  assert.equal(isHomeFallback("https://s.example/search/milk", "https://s.example/?q=milk"), false, "/search/milk → /?q=milk kept the search state in the landed query");
  assert.equal(isHomeFallback("https://s.example/search/milk", "https://s.example/"), true, "same deep path, landed BARE (no query) → a fallback");
  assert.equal(isHomeFallback("https://s.example/search?q=milk&utm_source=x", "https://s.example/?utm_source=x"), true, "only a TRACKING key survived on the landing → the intent was lost");
});

test("isHomeFallback: hosts are compared via canonicalizeHost (trailing-dot FQDN equivalence) (codex r3)", () => {
  assert.equal(isHomeFallback("https://shop.example./search", "https://shop.example/"), true, "trailing-dot FQDN is the same host — the fallback is not spuriously suppressed");
  assert.equal(isHomeFallback("https://SHOP.example/search", "https://shop.example/"), true, "case-insensitive host match");
});

test("isHomeFallback: a cross-host landing is a DIFFERENT case (policy-governed), never a home-fallback", () => {
  assert.equal(isHomeFallback(DEEP, "https://login.example/"), false, "deep → other host root (auth/consent interstitial)");
  assert.equal(isHomeFallback("https://www.s.example/deep", "https://s.example/"), false, "www↔apex host mismatch is a conservative false-negative (deferred)");
});

test("isHomeFallback: fail-safe on undefined / unparseable / non-http URLs", () => {
  assert.equal(isHomeFallback(undefined, ROOT), false, "no requested URL");
  assert.equal(isHomeFallback(DEEP, undefined), false, "no landed URL");
  assert.equal(isHomeFallback("::::", ROOT), false, "unparseable requested URL → assert nothing");
  assert.equal(isHomeFallback("chrome-error://chromewebdata/", ROOT), false, "non-http requested scheme");
  assert.equal(isHomeFallback(DEEP, "data:text/html,x"), false, "non-http landed scheme");
});

// --- retrieve: the OUTCOME flag on both success and failure shapes -------------------------------

/** withConsumerSession renders the single programmed result (a direct, no-proxy retrieve). */
function makeGateway(result) {
  return {
    async withConsumerSession(_token, fn) {
      return fn({ core: { async render() { return result; }, async setNavigationGuard() {}, async close() {} } }, { id: "agent-1" });
    },
  };
}
const renderOf = (over) => ({ url: DEEP, status: 200, title: "", text: "", html: "", clearanceWaitedMs: 0, ...over });
const doRetrieve = (result, url = DEEP) => retrieve(makeGateway(result), new SecretStore(() => ({})), { token: "t", url });

test("retrieve: a fat-homepage fallback is a SUCCESS that carries the top-level flag (no envelope)", async () => {
  const r = await doRetrieve(renderOf({ title: "Store Home", text: REAL, html: ARTICLE, diagnostics: { finalUrl: ROOT, status: 200 } }));
  assert.equal(r.blocked, false, "a fat homepage is not blocked");
  assert.ok(r.markdown.trim().length > 0, "real homepage content extracted → success shape");
  assert.equal(r.homeFallback, true, "the silent fallback is flagged on the success result");
  assert.equal(r.diagnostics, undefined, "a SUCCESS carries no failure envelope — the top-level flag is its carrier");
});

test("retrieve: a THIN fallback flags BOTH the top-level result and the failure envelope", async () => {
  const r = await doRetrieve(renderOf({ text: "", html: "", diagnostics: { finalUrl: ROOT, status: 200 } }));
  assert.equal(r.homeFallback, true, "top-level flag set on the failure too");
  assert.ok(r.diagnostics, "an empty extraction is a retrieve failure → envelope built");
  assert.equal(r.diagnostics.homeFallback, true, "the envelope slot carries the same derivation");
  assert.equal(r.diagnostics.failureClass, "empty-shell", "home-fallback rides ALONGSIDE the per-signal class, it does not replace it");
});

test("retrieve: a deep link that landed deep is NOT a fallback", async () => {
  const r = await doRetrieve(renderOf({ text: REAL, html: ARTICLE, diagnostics: { finalUrl: DEEP, status: 200 } }));
  assert.equal(r.homeFallback, undefined, "deep→deep → flag omitted (never false)");
});

// --- drive: a non-fatal annotation on the returned snapshot --------------------------------------

/** A single healthy consumer session whose navigate() lands on `landUrl` regardless of the requested url. */
function makeDriveGateway(landUrl) {
  const open = new Map();
  let n = 0;
  return {
    sessions: { get: (h) => open.get(h) },
    async openConsumerSession() {
      const id = "h" + n++;
      open.set(id, {
        core: {
          async navigate() {
            return { url: landUrl, title: "Store Home", tree: REAL, status: 200, diagnostics: { finalUrl: landUrl, status: 200 } };
          },
          async snapshot() { return { url: landUrl, title: "Store Home", tree: REAL, status: 200 }; },
        },
      });
      return id;
    },
    async useConsumerSession(_token, handle, fn) {
      const s = open.get(handle);
      if (!s) throw new Error("session not found");
      return fn(s);
    },
    async closeConsumerSession(_token, handle) { open.delete(handle); },
  };
}

test("drive: navigate(deep) that lands on the root ANNOTATES the returned snapshot (non-fatal)", async () => {
  const drive = new GatewayDriveController(makeDriveGateway(ROOT), new SecretStore(() => ({})), "tok", {});
  const snap = await drive.navigate(DEEP);
  assert.equal(snap.status, 200, "a homepage is a healthy, returnable snapshot — NOT a drive failure");
  assert.equal(snap.homeFallback, true, "the deep link → root fallback is annotated");
  await drive.close();
});

test("drive: navigate that lands where requested is NOT annotated", async () => {
  const drive = new GatewayDriveController(makeDriveGateway(DEEP), new SecretStore(() => ({})), "tok", {});
  const snap = await drive.navigate(DEEP);
  assert.equal(snap.homeFallback, undefined, "deep→deep → annotation omitted");
  await drive.close();
});

// --- redaction: the boolean survives while the URL path is collapsed -----------------------------

test("redactFailureDiagnostics: homeFallback boolean passes UNTOUCHED while finalUrl path collapses", () => {
  const out = redactFailureDiagnostics({ finalUrl: ROOT, homeFallback: true }, new SecretStore(() => ({})));
  assert.equal(out.homeFallback, true, "a closed boolean can never be page-derived free text → passes through");
  assert.equal(out.finalUrl, "https://store.example/", "the surfaced finalUrl is collapsed; the detector already ran on the RAW url pre-redaction");
});
