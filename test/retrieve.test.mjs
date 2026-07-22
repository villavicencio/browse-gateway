/**
 * U5 retrieve() tests — markdown extraction, the scoped-proxy escalation predicate, CAPTCHA
 * detection, and the retrieve() orchestration (with a fake gateway/core, no real browser).
 * The real AE1 (retrieve a hard target -> readable markdown) runs in-container via
 * scripts/validate-retrieve.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractMarkdown,
  isCloudflareBlock,
  shouldEscalateToProxy,
  detectCaptcha,
  proxyFromSecrets,
  mintStickyProxy,
  stickySuffixBootError,
  retrieve,
  isRetrieveFailure,
  PROXY_CLEARANCE_TIMEOUT_MS,
} from "../dist/verbs/index.js";
import { SecretStore } from "../dist/security/index.js";

const articleHtml = `<!doctype html><html><head><title>Doc</title></head><body><nav>menu</nav>
<article><h1>Headline</h1><p>${"Real article sentence with plenty of words. ".repeat(20)}</p>
<p>${"A second substantial paragraph for the reader algorithm. ".repeat(20)}</p></article>
<footer>foot</footer></body></html>`;

const cfBlockSignal = {
  status: 403,
  url: "https://hard.example/",
  title: "Just a moment...",
  text: "Enable JavaScript and cookies to continue",
  html: "<div class='cf-chl-opt' id='challenge-platform'></div>",
  clearanceWaitedMs: 0,
};

const renderOf = (over) => ({ url: "u", status: 200, title: "", text: "", html: "", clearanceWaitedMs: 0, ...over });

/** Fake gateway whose Nth withConsumerSession call renders the Nth programmed result. */
function makeFakeGateway(results) {
  const calls = [];
  let idx = 0;
  const gateway = {
    async withConsumerSession(token, fn, coreOverrides) {
      const result = results[Math.min(idx, results.length - 1)];
      idx++;
      const call = { token, coreOverrides };
      calls.push(call);
      const session = {
        core: {
          kind: "fake",
          async render(_url, renderOpts) {
            call.renderOpts = renderOpts;
            return renderOf(result);
          },
          async setNavigationGuard() {},
          async close() {},
        },
      };
      return fn(session, { id: "agent-1" });
    },
  };
  return { gateway, calls };
}

test("extractMarkdown: real article -> clean markdown, not degraded", () => {
  const r = extractMarkdown(articleHtml, "https://hard.example/post");
  assert.equal(r.degraded, false);
  assert.match(r.markdown, /Headline/);
  assert.match(r.markdown, /Real article sentence/);
  assert.ok(!/menu|foot/.test(r.markdown), "boilerplate stripped");
});

test("extractMarkdown: empty/garbage -> degraded, never throws", () => {
  assert.equal(extractMarkdown("", "u").degraded, true);
  assert.equal(extractMarkdown("<html></html>", "u").degraded, true);
});

test("isCloudflareBlock: true for a CF interstitial, false for cleared/other", () => {
  assert.equal(isCloudflareBlock(cfBlockSignal), true);
  // Cleared CF page: real content, challenge-platform still in HTML, but not blocked.
  assert.equal(
    isCloudflareBlock({ title: "Real", text: "x".repeat(1000), html: "<script src='/cdn-cgi/challenge-platform/x'></script>" }),
    false,
  );
  // DataDome block is not a CF managed challenge.
  assert.equal(isCloudflareBlock({ title: "g2", text: "", html: "captcha-delivery datadome" }), false);
});

test("shouldEscalateToProxy: CF block OR hard block, gated on datacenter IP + proxy available", () => {
  assert.equal(shouldEscalateToProxy(cfBlockSignal, cfBlockSignal.status, { onDatacenterIp: true, proxyAvailable: true }), true);
  assert.equal(shouldEscalateToProxy(cfBlockSignal, cfBlockSignal.status, { onDatacenterIp: false, proxyAvailable: true }), false);
  assert.equal(shouldEscalateToProxy(cfBlockSignal, cfBlockSignal.status, { onDatacenterIp: true, proxyAvailable: false }), false);
  // Soft/real page (200, full content): never escalate, even on a datacenter IP with a proxy.
  assert.equal(
    shouldEscalateToProxy({ title: "ok", text: "x".repeat(1000), html: "<main/>" }, 200, { onDatacenterIp: true, proxyAvailable: true }),
    false,
  );
  // Hard block: bare 403 + thin body (no CF phrase) — escalates so a clean residential IP can clear it.
  const hard = { title: "", text: "Forbidden", html: "Forbidden" };
  assert.equal(shouldEscalateToProxy(hard, 403, { onDatacenterIp: true, proxyAvailable: true }), true);
  // A real page that returns 403 yet rendered full content is NOT a hard block.
  assert.equal(
    shouldEscalateToProxy({ title: "g2", text: "x".repeat(1000), html: "<main/>" }, 403, { onDatacenterIp: true, proxyAvailable: true }),
    false,
  );
});

test("detectCaptcha: recognizes recaptcha/hcaptcha/turnstile + sitekey, else null", () => {
  const rc = detectCaptcha({ title: "", text: "", html: '<div class="g-recaptcha" data-sitekey="sk-abc"></div><script src="https://www.google.com/recaptcha/api.js"></script>' }, "u");
  assert.equal(rc?.kind, "recaptcha");
  assert.equal(rc?.siteKey, "sk-abc");
  assert.equal(detectCaptcha({ title: "", text: "", html: '<div class="cf-turnstile"></div>' }, "u")?.kind, "turnstile");
  assert.equal(detectCaptcha({ title: "", text: "", html: "<main>no captcha here</main>" }, "u"), null);
  // A CF MANAGED challenge ("Just a moment") loads the challenge-platform script, NOT a Turnstile widget —
  // detectCaptcha must return null so its reason stays cf-challenge (→ wafVendor cloudflare), not captcha
  // (→ turnstile). This locks the captcha-vs-cf boundary the #40 vendor projection relies on.
  assert.equal(
    detectCaptcha({ title: "Just a moment...", text: "", html: "<script src='/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1'></script>" }, "u"),
    null,
  );
});

test("proxyFromSecrets: builds config from secrets, undefined when absent", () => {
  assert.equal(proxyFromSecrets(new SecretStore(() => ({}))), undefined);
  const p = proxyFromSecrets(new SecretStore(() => ({ BGW_PROXY_URL: "http://p:8080", BGW_PROXY_USERNAME: "usr", BGW_PROXY_PASSWORD: "pwd" })));
  assert.deepEqual(p, { server: "http://p:8080", username: "usr", password: "pwd" });
});

test("retrieve: AE1 happy path returns readable markdown, no proxy, not blocked", async () => {
  const { gateway, calls } = makeFakeGateway([renderOf({ title: "Hard", text: "x".repeat(1000), html: articleHtml })]);
  const r = await retrieve(gateway, new SecretStore(() => ({})), { token: "t", url: "https://hard.example/" });
  assert.match(r.markdown, /Headline/);
  assert.equal(r.degraded, false);
  assert.equal(r.blocked, false);
  assert.equal(r.reason, null, "not blocked -> no reason");
  assert.equal(r.proxyUsed, false);
  assert.equal(calls.length, 1);
});

test("retrieve: AE2 soft target from datacenter IP does NOT engage the proxy", async () => {
  const { gateway, calls } = makeFakeGateway([renderOf({ text: "x".repeat(1000), html: articleHtml })]);
  const secrets = new SecretStore(() => ({ BGW_PROXY_URL: "http://proxy:8080" }));
  const r = await retrieve(gateway, secrets, { token: "t", url: "https://soft/", escalation: { onDatacenterIp: true } });
  assert.equal(r.proxyUsed, false, "no escalation for a non-CF target");
  assert.equal(calls.length, 1, "only the direct render happened");
  assert.equal(calls[0].coreOverrides, undefined);
});

test("mintStickyProxy: appends the suffix template with {id} substituted; base config untouched", () => {
  const base = { server: "http://proxy:8080", username: "u", password: "pwd" };
  const minted = mintStickyProxy(base, "_sticky-{id}-hold", "abc123");
  assert.equal(minted.password, "pwd_sticky-abc123-hold");
  assert.equal(minted.server, base.server);
  assert.equal(base.password, "pwd", "base config is not mutated");
});

test("mintStickyProxy: no template or no password → the base config unchanged (rotating behavior)", () => {
  const base = { server: "http://proxy:8080", password: "pwd" };
  assert.equal(mintStickyProxy(base, undefined), base, "no template → same object, password untouched");
  const noPw = { server: "s", username: "u" };
  assert.equal(mintStickyProxy(noPw, "_sticky-{id}"), noPw, "no password to suffix → same object");
});

test("mintStickyProxy: a fresh random id per call (distinct exits across attempts)", () => {
  const base = { server: "s", password: "pwd" };
  const a = mintStickyProxy(base, "_s-{id}");
  const b = mintStickyProxy(base, "_s-{id}");
  assert.notEqual(a.password, b.password, "two mints must land two different sticky sessions");
});

test("mintStickyProxy: auto-generated {id} is EXACTLY 8 hex chars (IPRoyal _session- spec)", () => {
  // IPRoyal requires the _session- value be precisely 8 alphanumeric chars. The auto-generated id
  // (no explicit id arg) must satisfy that — a 16-char id is out of spec and may be truncated/ignored.
  const base = { server: "s", password: "pwd" };
  const minted = mintStickyProxy(base, "_country-us_session-{id}_lifetime-30m");
  const session = minted.password.match(/_session-([0-9a-z]+)_/)?.[1];
  assert.ok(session, "a session token was appended");
  assert.match(session, /^[0-9a-f]{8}$/, "session id must be exactly 8 hex chars");
});

test("mintStickyProxy: a suffix with no {id} is a static no-op append → all attempts pin one exit", () => {
  // The silent rotation-collapse footgun: replaceAll('{id}') matches nothing, so two mints are
  // IDENTICAL. stickySuffixBootError() rejects this config at startup (asserted below).
  const base = { server: "s", password: "pwd" };
  const a = mintStickyProxy(base, "_static-hold");
  const b = mintStickyProxy(base, "_static-hold");
  assert.equal(a.password, "pwd_static-hold");
  assert.equal(a.password, b.password, "no {id} → same exit every attempt");
});

test("stickySuffixBootError: rejects a non-empty suffix lacking {id}; passes valid/absent", () => {
  assert.equal(stickySuffixBootError(undefined), null, "absent → ok");
  assert.equal(stickySuffixBootError(""), null, "empty → ok (treated as unset)");
  assert.equal(stickySuffixBootError("_session-{id}_lifetime-30m"), null, "has {id} → ok");
  assert.match(stickySuffixBootError("_session-static"), /\{id\}/, "no {id} → boot error mentioning {id}");
});

test("retrieve: sticky escalation mints a FRESH held exit per proxied attempt + raised clearance", async () => {
  // Direct blocked, then two proxied attempts still blocked, third clears: each proxied attempt
  // must carry a DIFFERENT sticky password (fresh exit per retry) and the escalated clearance
  // budget (an interstitial clears at ~22s on a held exit — over the 20s default).
  const { gateway, calls } = makeFakeGateway([
    renderOf(cfBlockSignal),
    renderOf(cfBlockSignal),
    renderOf(cfBlockSignal),
    renderOf({ text: "x".repeat(1000), html: articleHtml }),
  ]);
  const secrets = new SecretStore(() => ({ BGW_PROXY_URL: "http://proxy:8080", BGW_PROXY_PASSWORD: "pwd" }));
  const r = await retrieve(gateway, secrets, {
    token: "t",
    url: "https://hard.example/",
    escalation: { onDatacenterIp: true },
    stickySuffix: "_s-{id}",
  });
  assert.equal(r.proxyUsed, true);
  assert.equal(calls.length, 4); // 1 direct + 3 proxied
  const proxied = calls.slice(1).map((c) => c.coreOverrides?.proxy?.password);
  for (const pw of proxied) assert.match(pw, /^pwd_s-[0-9a-f]+$/, "sticky suffix applied over the base password");
  assert.equal(new Set(proxied).size, 3, "every proxied attempt minted its own sticky session");
  for (const c of calls.slice(1)) {
    assert.equal(c.renderOpts?.clearanceTimeoutMs, PROXY_CLEARANCE_TIMEOUT_MS, "escalated clearance on proxied attempts");
  }
  assert.equal(calls[0].renderOpts?.clearanceTimeoutMs, undefined, "direct render keeps the default budget");
  assert.equal(r.blocked, false);
});

test("retrieve: no stickySuffix → proxied attempts keep the base password (prior rotating behavior)", async () => {
  const { gateway, calls } = makeFakeGateway([
    renderOf(cfBlockSignal),
    renderOf({ text: "x".repeat(1000), html: articleHtml }),
  ]);
  const secrets = new SecretStore(() => ({ BGW_PROXY_URL: "http://proxy:8080", BGW_PROXY_PASSWORD: "pwd" }));
  const r = await retrieve(gateway, secrets, { token: "t", url: "https://hard.example/", escalation: { onDatacenterIp: true } });
  assert.equal(r.proxyUsed, true);
  assert.equal(calls[1].coreOverrides?.proxy?.password, "pwd");
});

test("retrieve: an explicit clearanceTimeoutMs wins over the escalated default on proxied attempts", async () => {
  const { gateway, calls } = makeFakeGateway([
    renderOf(cfBlockSignal),
    renderOf({ text: "x".repeat(1000), html: articleHtml }),
  ]);
  const secrets = new SecretStore(() => ({ BGW_PROXY_URL: "http://proxy:8080" }));
  await retrieve(gateway, secrets, {
    token: "t",
    url: "https://hard.example/",
    escalation: { onDatacenterIp: true },
    clearanceTimeoutMs: 7_000,
  });
  assert.equal(calls[1].renderOpts?.clearanceTimeoutMs, 7_000, "caller's explicit budget is respected");
});

test("retrieve: CF block from datacenter IP escalates to the proxy and then succeeds", async () => {
  const { gateway, calls } = makeFakeGateway([
    renderOf(cfBlockSignal), // direct render is blocked by CF
    renderOf({ text: "x".repeat(1000), html: articleHtml }), // proxied render clears
  ]);
  const secrets = new SecretStore(() => ({ BGW_PROXY_URL: "http://proxy:8080" }));
  const r = await retrieve(gateway, secrets, { token: "t", url: "https://hard.example/", escalation: { onDatacenterIp: true } });
  assert.equal(r.proxyUsed, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].coreOverrides?.proxy, { server: "http://proxy:8080" });
  assert.match(r.markdown, /Headline/);
  assert.equal(r.blocked, false);
});

test("retrieve: a bare 403 with thin body is reported as blocked, not returned as content (finding #2)", async () => {
  // The reputation block: 403 + "Forbidden" (len 9). No proxy configured, so it can't escalate;
  // it must come back blocked:true rather than markdown="Forbidden", blocked:false.
  const { gateway, calls } = makeFakeGateway([renderOf({ status: 403, text: "Forbidden", html: "Forbidden" })]);
  const r = await retrieve(gateway, new SecretStore(() => ({})), { token: "t", url: "https://hard.example/" });
  assert.equal(r.blocked, true, "a 4xx + thin body is a hard block");
  assert.equal(r.reason, "hard-block");
  assert.equal(r.proxyUsed, false, "no proxy configured");
  assert.equal(calls.length, 1);
});

test("retrieve: a hard 403 from a datacenter IP escalates to the proxy and then clears (finding #3)", async () => {
  const { gateway, calls } = makeFakeGateway([
    renderOf({ status: 403, text: "Forbidden", html: "Forbidden" }), // reputation block on the datacenter IP
    renderOf({ status: 200, text: "x".repeat(1000), html: articleHtml }), // clean residential IP clears it
  ]);
  const secrets = new SecretStore(() => ({ BGW_PROXY_URL: "http://proxy:8080" }));
  const r = await retrieve(gateway, secrets, { token: "t", url: "https://hard.example/", escalation: { onDatacenterIp: true } });
  assert.equal(r.proxyUsed, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].coreOverrides?.proxy, { server: "http://proxy:8080" });
  assert.match(r.markdown, /Headline/);
  assert.equal(r.blocked, false);
});

test("retrieve: a hard 403 the proxy still cannot clear stays blocked (exhausts retries)", async () => {
  const { gateway, calls } = makeFakeGateway([
    renderOf({ status: 403, text: "Forbidden", html: "Forbidden" }),
    renderOf({ status: 403, text: "Forbidden", html: "Forbidden" }), // every proxy exit also blocked
  ]);
  const secrets = new SecretStore(() => ({ BGW_PROXY_URL: "http://proxy:8080" }));
  const r = await retrieve(gateway, secrets, { token: "t", url: "https://hard.example/", escalation: { onDatacenterIp: true } });
  assert.equal(r.proxyUsed, true);
  assert.equal(calls.length, 4, "direct + 3 fresh-exit retries, all still blocked");
  assert.equal(r.blocked, true, "still blocked after escalation -> reported, not returned as content");
  assert.equal(r.reason, "hard-block", "exhausted proxy on a reputation 403 -> hard-block");
});

test("retrieve: a dead proxy exit (failed nav) is retried on a fresh session, then clears", async () => {
  const { gateway, calls } = makeFakeGateway([
    renderOf({ status: 403, text: "Forbidden", html: "Forbidden" }), // direct -> hard block, escalate
    renderOf({ status: null, text: "", html: "" }), // 1st exit dead: nav failed, no response
    renderOf({ status: 200, text: "x".repeat(1000), html: articleHtml }), // 2nd exit good -> clears
  ]);
  const secrets = new SecretStore(() => ({ BGW_PROXY_URL: "http://proxy:8080" }));
  const r = await retrieve(gateway, secrets, { token: "t", url: "https://hard.example/", escalation: { onDatacenterIp: true } });
  assert.equal(r.proxyUsed, true);
  assert.equal(calls.length, 3, "direct + dead-exit retry + good-exit");
  assert.deepEqual(calls[1].coreOverrides?.proxy, { server: "http://proxy:8080" });
  assert.equal(calls[1].coreOverrides?.navigationTimeoutMs, 25_000, "shorter per-attempt nav timeout on proxied tries");
  assert.equal(r.blocked, false);
  assert.match(r.markdown, /Headline/);
});

test("retrieve: when every proxy exit fails (null status), the result is reported blocked", async () => {
  const { gateway, calls } = makeFakeGateway([
    renderOf({ status: 403, text: "Forbidden", html: "Forbidden" }), // direct -> hard block, escalate
    renderOf({ status: null, text: "", html: "" }), // every proxied attempt: dead exit
  ]);
  const secrets = new SecretStore(() => ({ BGW_PROXY_URL: "http://proxy:8080" }));
  const r = await retrieve(gateway, secrets, { token: "t", url: "https://hard.example/", escalation: { onDatacenterIp: true } });
  assert.equal(r.proxyUsed, true);
  assert.equal(calls.length, 4, "direct + 3 dead-exit attempts");
  assert.equal(r.blocked, true, "a failed nav (null status) reports blocked, not empty success");
  assert.equal(r.reason, "nav-failed", "every exit dead (null status) -> nav-failed");
});

test("retrieve: a render that ended on chrome-error:// with a STALE 200 + error-text markdown is a nav failure, not content (codex #41 r4)", async () => {
  // A client-side crash to a dead host: the fresh-page status stays at the initial 200 while page.url() is
  // chrome-error, and the Chrome error DOM extracts to NON-empty markdown. Without folding the chrome-error
  // final URL into the failure decision, isRetrieveFailure would be false and the browser's error text would
  // be handed back as page content. The chrome-error URL is unambiguous, so it is SAFE to fail the call.
  const errHtml = "<html><body><div id='main-message'>This site can’t be reached. ERR_EMPTY_RESPONSE</div></body></html>";
  const { gateway } = makeFakeGateway([
    renderOf({ status: 200, title: "", text: "This site can’t be reached. ERR_EMPTY_RESPONSE", html: errHtml, diagnostics: { finalUrl: "chrome-error://chromewebdata/", status: 200 } }),
  ]);
  const r = await retrieve(gateway, new SecretStore(() => ({})), { token: "t", url: "https://dead.example/" });
  assert.equal(r.blocked, true, "a chrome-error render is reported blocked, not returned as content");
  assert.equal(r.reason, "nav-failed", "a dead nav to chrome-error is nav-failed even with a stale 200");
  assert.equal(r.diagnostics?.failureClass, "nav-failed", "the envelope classifies it nav-failed");
  assert.equal(isRetrieveFailure(r), true, "the MCP layer fails the call instead of surfacing the browser error text");
});

test("retrieve: rejects non-http(s) URLs before any session opens (file:// local-read)", async () => {
  const { gateway, calls } = makeFakeGateway([renderOf({ text: "x".repeat(1000), html: articleHtml })]);
  for (const url of ["file:///etc/passwd", "data:text/html,<h1>x</h1>", "ftp://host/f"]) {
    await assert.rejects(
      retrieve(gateway, new SecretStore(() => ({})), { token: "t", url }),
      /unsupported URL scheme/,
      url,
    );
  }
  assert.equal(calls.length, 0, "no session opened for a rejected scheme");
});

test("retrieve: a short-but-valid page is not reported as blocked (false-block regression)", async () => {
  // Short real content, no block phrase: must return content, not blocked:true.
  const shortHtml = "<html><body><p>A short but legitimate page body.</p></body></html>";
  const { gateway } = makeFakeGateway([renderOf({ status: 200, text: "A short but legitimate page body.", html: shortHtml })]);
  const r = await retrieve(gateway, new SecretStore(() => ({})), { token: "t", url: "https://small.example/" });
  assert.equal(r.blocked, false, "thin content must not be reported as a block");
  assert.equal(r.reason, null, "a legit short page has no block reason");
  assert.ok(r.markdown.length > 0, "content returned");
});

test("retrieve: a detected CAPTCHA is handed to the solver (no dead-end)", async () => {
  const captchaHtml = '<div class="g-recaptcha" data-sitekey="sk-1"></div><script src="https://www.google.com/recaptcha/api.js"></script>';
  const { gateway } = makeFakeGateway([renderOf({ text: "x".repeat(300), html: captchaHtml })]);
  let solvedWith = null;
  const solver = { async solve(ch) { solvedWith = ch; return "captcha-token"; } };
  const r = await retrieve(gateway, new SecretStore(() => ({})), { token: "t", url: "https://x/", solver });
  assert.equal(r.captchaSolved, true);
  assert.equal(solvedWith?.kind, "recaptcha");
  assert.equal(solvedWith?.siteKey, "sk-1");
});

test("retrieve: a CF managed challenge with no proxy is reported blocked with reason=cf-challenge", async () => {
  const { gateway } = makeFakeGateway([renderOf(cfBlockSignal)]);
  const r = await retrieve(gateway, new SecretStore(() => ({})), { token: "t", url: "https://hard.example/" });
  assert.equal(r.blocked, true);
  assert.equal(r.reason, "cf-challenge");
  assert.equal(r.proxyUsed, false, "no proxy configured to escalate to");
});

test("retrieve: an interactive CAPTCHA block is reported with reason=captcha (most-actionable)", async () => {
  // 403 + thin + a Turnstile widget: hard-block AND captcha both apply; captcha wins (it's the
  // actionable signal — needs a solver, which no proxy substitutes for).
  const turnstile = renderOf({ status: 403, title: "Verify", text: "Please verify you are a human", html: '<div class="cf-turnstile" data-sitekey="0x4"></div>' });
  const { gateway } = makeFakeGateway([turnstile]);
  const r = await retrieve(gateway, new SecretStore(() => ({})), { token: "t", url: "https://captcha.example/" });
  assert.equal(r.blocked, true);
  assert.equal(r.reason, "captcha");
});

test("#44: retrieve surfaces solverEligible=true + not-configured on a solvable-kind (reCAPTCHA) CAPTCHA block", async () => {
  // retrieve wires NO solver in production; the actionable signal is that this kind IS solvable, so routing
  // to the drive path (which has a solver) could clear it — captchaSolveReason='not-configured' says WHY it
  // wasn't attempted here. (renderOf must carry `diagnostics` for the #39 envelope to be assembled.)
  const rc = renderOf({
    status: 403, title: "Verify", text: "Please verify you are a human",
    html: '<div class="g-recaptcha" data-sitekey="sk-1"></div>',
    diagnostics: { finalUrl: "https://cap.example/", status: 403 },
  });
  const { gateway } = makeFakeGateway([rc]);
  const r = await retrieve(gateway, new SecretStore(() => ({})), { token: "t", url: "https://cap.example/" });
  assert.equal(r.reason, "captcha");
  assert.equal(r.diagnostics?.failureClass, "captcha");
  assert.equal(r.diagnostics?.solverEligible, true, "reCAPTCHA v2 is a solvable kind");
  assert.equal(r.diagnostics?.captchaSolveReason, "not-configured", "retrieve wires no solver");
});

test("#44: retrieve marks a Turnstile CAPTCHA solverEligible=true (the solver maps Turnstile too)", async () => {
  const ts = renderOf({
    status: 403, title: "Verify", text: "Please verify you are a human",
    html: '<div class="cf-turnstile" data-sitekey="0x4"></div>',
    diagnostics: { finalUrl: "https://cap.example/", status: 403 },
  });
  const { gateway } = makeFakeGateway([ts]);
  const r = await retrieve(gateway, new SecretStore(() => ({})), { token: "t", url: "https://cap.example/" });
  assert.equal(r.diagnostics?.failureClass, "captcha");
  assert.equal(r.diagnostics?.solverEligible, true, "Turnstile IS solvable by the configured solver");
  assert.equal(r.diagnostics?.captchaSolveReason, "not-configured", "retrieve wires no solver in production");
});

test("#44: retrieve with a SUPPLIED solver that FAILS reports the typed code, not `not-configured` (codex r1)", async () => {
  // The public opts.solver seam: a supplied solver was invoked and threw — the envelope must reflect the
  // typed failure, never the contradictory not-configured (which implies no solver was available).
  const ren = renderOf({
    status: 403, title: "Verify", text: "Please verify you are a human",
    html: '<div class="g-recaptcha" data-sitekey="sk-1"></div>',
    diagnostics: { finalUrl: "https://cap.example/", status: 403 },
  });
  const { gateway } = makeFakeGateway([ren]);
  const solver = { async solve() { const e = new Error("service returned an error"); e.code = "vendor-error"; throw e; } };
  const r = await retrieve(gateway, new SecretStore(() => ({})), { token: "t", url: "https://cap.example/", solver });
  assert.equal(r.captchaSolved, false, "a failed solve leaves the page blocked, not solved");
  assert.equal(r.diagnostics?.failureClass, "captcha");
  assert.equal(r.diagnostics?.captchaSolveReason, "vendor-error", "the supplied solver's typed code is surfaced");
});

test("#44: a solve failure on a DIFFERENT kind than the classified widget is NOT attached (codex r5)", async () => {
  // detectCaptcha matches the preloaded hCaptcha LIBRARY (so the solve attempts hcaptcha), but
  // activeCaptchaKind classifies the ACTIVE g-recaptcha container. The hcaptcha failure must NOT ride a
  // reCAPTCHA envelope — the reason attaches only when the attempted kind matches the classified widget.
  const mixed = renderOf({
    status: 403, title: "Verify", text: "Please verify you are a human",
    html: '<script src="https://hcaptcha.com/1/api.js"></script><div class="g-recaptcha" data-sitekey="sk-1"></div>',
    diagnostics: { finalUrl: "https://cap.example/", status: 403 },
  });
  const { gateway } = makeFakeGateway([mixed]);
  const solver = { async solve() { const e = new Error("boom"); e.code = "vendor-error"; throw e; } };
  const r = await retrieve(gateway, new SecretStore(() => ({})), { token: "t", url: "https://cap.example/", solver });
  assert.equal(r.diagnostics?.failureClass, "captcha");
  assert.equal(r.diagnostics?.solverEligible, true, "the classified reCAPTCHA is solvable");
  assert.notEqual(r.diagnostics?.captchaSolveReason, "vendor-error", "the hCaptcha-attempt failure must not attach to the reCAPTCHA envelope");
  assert.equal(r.diagnostics?.captchaSolveReason, undefined, "kind mismatch → reason dropped");
});

test("#44: a stale direct-render solve reason is NOT attached after escalation replaces the render (codex r4)", async () => {
  // opts.solver FAILS on the DIRECT captcha render, then escalation replaces `render` with proxied ones. The
  // direct render's code must NOT ride the final envelope — it never described the surfaced (proxied) page.
  const capBlock = () => renderOf({
    status: 403, title: "", text: "Forbidden",
    html: '<div class="g-recaptcha" data-sitekey="sk-1"></div>',
    diagnostics: { finalUrl: "https://hard.example/", status: 403 },
  });
  const { gateway } = makeFakeGateway([capBlock(), capBlock(), capBlock(), capBlock()]);
  const secrets = new SecretStore(() => ({ BGW_PROXY_URL: "http://proxy:8080", BGW_PROXY_PASSWORD: "pwd" }));
  let solveCalls = 0;
  const solver = { async solve() { solveCalls++; const e = new Error("vendor boom"); e.code = "vendor-error"; throw e; } };
  const r = await retrieve(gateway, secrets, { token: "t", url: "https://hard.example/", escalation: { onDatacenterIp: true }, solver });
  assert.equal(r.proxyUsed, true, "escalation ran (the direct hard-block escalated)");
  assert.equal(solveCalls, 1, "the solve was attempted once, on the direct render only");
  assert.equal(r.diagnostics?.solverEligible, true, "the final render still carries a solvable widget");
  assert.notEqual(r.diagnostics?.captchaSolveReason, "vendor-error", "the STALE direct-render code must not ride the final envelope");
  assert.equal(r.diagnostics?.captchaSolveReason, undefined, "no solve was attempted on the surfaced render → omitted");
});

test("#44: retrieve preserves the CAPTCHA reason when a WAF marker takes class precedence (codex r3)", async () => {
  // A DataDome page ALSO serving a reCAPTCHA: classifyFailure keeps anti-bot-block (WAF-first), but a real
  // solvable widget is present — so solverEligible + captchaSolveReason must ride the DETECTED captcha, not
  // the projected primary class (parity with the drive path; the eligibility fields gate on captchaKind).
  const both = renderOf({
    status: 403, title: "", text: "Access denied",
    html: 'datadome captcha-delivery <div class="g-recaptcha" data-sitekey="sk-1"></div>',
    diagnostics: { finalUrl: "https://dd.example/", status: 403 },
  });
  const { gateway } = makeFakeGateway([both]);
  const r = await retrieve(gateway, new SecretStore(() => ({})), { token: "t", url: "https://dd.example/" });
  assert.equal(r.diagnostics?.failureClass, "anti-bot-block", "the WAF marker wins the primary class");
  assert.equal(r.diagnostics?.solverEligible, true, "the detected reCAPTCHA is solvable");
  assert.equal(r.diagnostics?.captchaSolveReason, "not-configured", "the reason is preserved despite the WAF class");
});

test("retrieve: a 200 PerimeterX press-&-hold served as a TOP-document interstitial (copy in html, not innerText) is blocked", async () => {
  // The live gateway repro (#24 follow-up), top-document form: PX serves the press-&-hold full-page
  // with a 200. The challenge copy reaches render.html (so extractMarkdown scrapes it) but NOT
  // render.text (top-doc innerText, here ordinary chrome over the 200-char bar). isHardBlock (needs
  // 4xx) and isPerimeterXChallenge (needs thin text) both miss it — pxHint + copy-in-source catches it.
  const challengeHtml =
    "<html><body><div id='px-captcha-modal'></div>" +
    "<div>Before we continue... Press &amp; Hold to confirm you are a human (and not a bot). Reference ID 5df6f538</div>" +
    "</body></html>";
  const { gateway } = makeFakeGateway([renderOf({ status: 200, text: "x".repeat(220), html: challengeHtml })]);
  const r = await retrieve(gateway, new SecretStore(() => ({})), { token: "t", url: "https://www.totalwine.com/p/1" });
  assert.equal(r.blocked, true, "a 200 PX press-&-hold must not be returned as content");
  assert.equal(r.reason, "perimeterx-challenge");
});

test("retrieve: a 200 PerimeterX press-&-hold rendered INSIDE the px-captcha-modal iframe (copy only in frameHtml) is blocked", async () => {
  // The iframe form (P1 review, PR #25): the top document is a fat page whose only PX evidence is the
  // px-captcha-modal element (pxHint) — the challenge copy lives in the CHILD FRAME's document, which
  // page.content() (top frame only) never serializes. The core captures it as render.frameHtml; the
  // top-doc html carries NO copy. Detection must read frameHtml, not just html.
  const topHtml = "<html><body><div id='px-captcha-modal'></div><main>Total Wine — Folsom, CA</main></body></html>";
  const frameHtml = "<html><body><div>Press &amp; Hold to confirm you are a human (and not a bot).</div></body></html>";
  const { gateway } = makeFakeGateway([renderOf({ status: 200, text: "x".repeat(400), html: topHtml, frameHtml })]);
  const r = await retrieve(gateway, new SecretStore(() => ({})), { token: "t", url: "https://www.totalwine.com/p/1" });
  assert.equal(r.blocked, true, "an iframe-served PX challenge (copy only in frameHtml) must be blocked");
  assert.equal(r.reason, "perimeterx-challenge");
});

test("retrieve: a CLEARED PerimeterX page (px-captcha marker persists, real content, no challenge copy) is NOT blocked", async () => {
  // px-captcha / _px markers stay embedded after the challenge clears, so pxHint is true on success.
  // The discriminator is the challenge COPY, which is absent on the real product page — must return content.
  const clearedHtml =
    "<html><body><div id='px-captcha-modal'></div>" +
    `<article><h1>Woodford Reserve</h1><p>${"Real product detail sentence with plenty of words. ".repeat(20)}</p></article>` +
    "</body></html>";
  const { gateway } = makeFakeGateway([renderOf({ status: 200, text: "x".repeat(1000), html: clearedHtml })]);
  const r = await retrieve(gateway, new SecretStore(() => ({})), { token: "t", url: "https://www.totalwine.com/p/1" });
  assert.equal(r.blocked, false, "a cleared PX page (pxHint persists, no challenge copy) must return content");
  assert.equal(r.reason, null);
  assert.match(r.markdown, /Woodford Reserve/);
});

test("retrieve: a generic visible block (200, non-CF, non-captcha) reports reason=blocked (fallback arm)", async () => {
  // status 200 (so not hard-block), a non-CF block phrase, no captcha widget, no CF HTML hint:
  // exercises the final 'blocked' arm of the reason cascade — every other arm has its own test.
  const denied = renderOf({ status: 200, title: "Denied", text: "Access denied. You have been blocked.", html: "<html><body>Access denied</body></html>" });
  const { gateway } = makeFakeGateway([denied]);
  const r = await retrieve(gateway, new SecretStore(() => ({})), { token: "t", url: "https://waf.example/" });
  assert.equal(r.blocked, true, "a visible block phrase is blocked even at status 200");
  assert.equal(r.reason, "blocked", "not CF/captcha/hard-block -> generic blocked");
});

// --- issue #40: mitigation/CAPTCHA vendor on the retrieve failure envelope ---

test("retrieve: a DataDome block reports reason=datadome-challenge and diagnostics.wafVendor=datadome (no longer generic 'blocked')", async () => {
  const dd = renderOf({
    status: 403,
    title: "",
    text: "Access denied",
    html: "<script src='https://js.datadome.co/tags.js'></script>",
    diagnostics: { finalUrl: "https://dd.example/", status: 403 },
  });
  const { gateway } = makeFakeGateway([dd]);
  const r = await retrieve(gateway, new SecretStore(() => ({})), { token: "t", url: "https://dd.example/" });
  assert.equal(r.blocked, true);
  assert.equal(r.reason, "datadome-challenge", "DataDome is re-labeled, not left as generic blocked");
  assert.equal(r.diagnostics?.wafVendor, "datadome", "vendor surfaced on the #39 envelope");
});

test("retrieve: a DataDome page that ALSO preloads a reCAPTCHA library stays datadome, not recaptcha (codex #40 r2)", async () => {
  // detectCaptcha matches a merely-loaded captcha library; the DataDome marker must win so the vendor
  // isn't mislabeled recaptcha. This is the exact over-attribution Codex flagged.
  const dd = renderOf({
    status: 403,
    title: "",
    text: "Access denied",
    html: "<script src='https://js.datadome.co/tags.js'></script><script src='https://www.google.com/recaptcha/api.js'></script>",
    diagnostics: { finalUrl: "https://dd.example/", status: 403 },
  });
  const { gateway } = makeFakeGateway([dd]);
  const r = await retrieve(gateway, new SecretStore(() => ({})), { token: "t", url: "https://dd.example/" });
  assert.equal(r.reason, "datadome-challenge", "the real WAF vendor wins over an incidental captcha library");
  assert.equal(r.diagnostics?.wafVendor, "datadome");
});

test("retrieve: a generic block that merely LOADS a reCAPTCHA library (no widget/sitekey) is NOT labeled captcha (codex #40 r3)", async () => {
  // No CF/PX/DD marker and no active widget — just the library script. captchaKind requires a sitekey'd
  // container, so this stays a hard-block with no fabricated captcha vendor.
  const libOnly = renderOf({
    status: 403,
    title: "",
    text: "Forbidden",
    html: "<script src='https://www.google.com/recaptcha/api.js'></script>",
    diagnostics: { finalUrl: "https://x.example/", status: 403 },
  });
  const { gateway } = makeFakeGateway([libOnly]);
  const r = await retrieve(gateway, new SecretStore(() => ({})), { token: "t", url: "https://x.example/" });
  assert.equal(r.reason, "hard-block", "a loaded library must not promote a generic block to captcha");
  assert.equal(r.diagnostics?.wafVendor, undefined, "no captcha vendor fabricated from a library load");
});

test("retrieve: a reCAPTCHA block surfaces the CAPTCHA kind as wafVendor (reason=captcha)", async () => {
  const rc = renderOf({
    status: 403,
    title: "Verify",
    text: "Please verify you are a human",
    html: '<div class="g-recaptcha" data-sitekey="sk-1"></div><script src="https://www.google.com/recaptcha/api.js"></script>',
    diagnostics: { finalUrl: "https://c.example/", status: 403 },
  });
  const { gateway } = makeFakeGateway([rc]);
  const r = await retrieve(gateway, new SecretStore(() => ({})), { token: "t", url: "https://c.example/" });
  assert.equal(r.reason, "captcha");
  assert.equal(r.diagnostics?.wafVendor, "recaptcha");
});

test("retrieve: a CF managed challenge surfaces wafVendor=cloudflare (not turnstile — detectCaptcha misses the challenge-platform)", async () => {
  const cf = renderOf({
    status: 403,
    title: "Just a moment...",
    text: "Enable JavaScript and cookies to continue",
    html: "<div class='cf-chl-opt' id='challenge-platform'></div>",
    diagnostics: { finalUrl: "https://cf.example/", status: 403 },
  });
  const { gateway } = makeFakeGateway([cf]);
  const r = await retrieve(gateway, new SecretStore(() => ({})), { token: "t", url: "https://cf.example/" });
  assert.equal(r.reason, "cf-challenge");
  assert.equal(r.diagnostics?.wafVendor, "cloudflare");
});

test("retrieve: a failed nav (null status) carries the envelope but NO wafVendor (unattributed — keeps the #39 gate)", async () => {
  const navFail = renderOf({ status: null, title: "", text: "", html: "", diagnostics: { finalUrl: "https://x.example/", status: null } });
  const { gateway } = makeFakeGateway([navFail]);
  const r = await retrieve(gateway, new SecretStore(() => ({})), { token: "t", url: "https://x.example/" });
  assert.equal(r.reason, "nav-failed");
  assert.ok(r.diagnostics, "the failure envelope is still attached");
  assert.equal(r.diagnostics.wafVendor, undefined, "no vendor is fabricated for a failed nav");
});
