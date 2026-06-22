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
});

test("proxyFromSecrets: builds config from secrets, undefined when absent", () => {
  assert.equal(proxyFromSecrets(new SecretStore(() => ({}))), undefined);
  const p = proxyFromSecrets(new SecretStore(() => ({ BGW_PROXY_URL: "http://p:8080", BGW_PROXY_USERNAME: "u", BGW_PROXY_PASSWORD: "pw" })));
  assert.deepEqual(p, { server: "http://p:8080", username: "u", password: "pw" });
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
  const base = { server: "http://proxy:8080", username: "u", password: "pw" };
  const minted = mintStickyProxy(base, "_sticky-{id}-hold", "abc123");
  assert.equal(minted.password, "pw_sticky-abc123-hold");
  assert.equal(minted.server, base.server);
  assert.equal(base.password, "pw", "base config is not mutated");
});

test("mintStickyProxy: no template or no password → the base config unchanged (rotating behavior)", () => {
  const base = { server: "http://proxy:8080", password: "pw" };
  assert.equal(mintStickyProxy(base, undefined), base, "no template → same object, password untouched");
  const noPw = { server: "s", username: "u" };
  assert.equal(mintStickyProxy(noPw, "_sticky-{id}"), noPw, "no password to suffix → same object");
});

test("mintStickyProxy: a fresh random id per call (distinct exits across attempts)", () => {
  const base = { server: "s", password: "pw" };
  const a = mintStickyProxy(base, "_s-{id}");
  const b = mintStickyProxy(base, "_s-{id}");
  assert.notEqual(a.password, b.password, "two mints must land two different sticky sessions");
});

test("mintStickyProxy: auto-generated {id} is EXACTLY 8 hex chars (IPRoyal _session- spec)", () => {
  // IPRoyal requires the _session- value be precisely 8 alphanumeric chars. The auto-generated id
  // (no explicit id arg) must satisfy that — a 16-char id is out of spec and may be truncated/ignored.
  const base = { server: "s", password: "pw" };
  const minted = mintStickyProxy(base, "_country-us_session-{id}_lifetime-30m");
  const session = minted.password.match(/_session-([0-9a-z]+)_/)?.[1];
  assert.ok(session, "a session token was appended");
  assert.match(session, /^[0-9a-f]{8}$/, "session id must be exactly 8 hex chars");
});

test("mintStickyProxy: a suffix with no {id} is a static no-op append → all attempts pin one exit", () => {
  // The silent rotation-collapse footgun: replaceAll('{id}') matches nothing, so two mints are
  // IDENTICAL. stickySuffixBootError() rejects this config at startup (asserted below).
  const base = { server: "s", password: "pw" };
  const a = mintStickyProxy(base, "_static-hold");
  const b = mintStickyProxy(base, "_static-hold");
  assert.equal(a.password, "pw_static-hold");
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
  const secrets = new SecretStore(() => ({ BGW_PROXY_URL: "http://proxy:8080", BGW_PROXY_PASSWORD: "pw" }));
  const r = await retrieve(gateway, secrets, {
    token: "t",
    url: "https://hard.example/",
    escalation: { onDatacenterIp: true },
    stickySuffix: "_s-{id}",
  });
  assert.equal(r.proxyUsed, true);
  assert.equal(calls.length, 4); // 1 direct + 3 proxied
  const proxied = calls.slice(1).map((c) => c.coreOverrides?.proxy?.password);
  for (const pw of proxied) assert.match(pw, /^pw_s-[0-9a-f]+$/, "sticky suffix applied over the base password");
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
  const secrets = new SecretStore(() => ({ BGW_PROXY_URL: "http://proxy:8080", BGW_PROXY_PASSWORD: "pw" }));
  const r = await retrieve(gateway, secrets, { token: "t", url: "https://hard.example/", escalation: { onDatacenterIp: true } });
  assert.equal(r.proxyUsed, true);
  assert.equal(calls[1].coreOverrides?.proxy?.password, "pw");
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
