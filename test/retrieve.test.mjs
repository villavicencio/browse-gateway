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
  retrieve,
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
      calls.push({ token, coreOverrides });
      const session = {
        core: {
          kind: "fake",
          async render() {
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

test("shouldEscalateToProxy: only CF block + datacenter IP + proxy available", () => {
  assert.equal(shouldEscalateToProxy(cfBlockSignal, { onDatacenterIp: true, proxyAvailable: true }), true);
  assert.equal(shouldEscalateToProxy(cfBlockSignal, { onDatacenterIp: false, proxyAvailable: true }), false);
  assert.equal(shouldEscalateToProxy(cfBlockSignal, { onDatacenterIp: true, proxyAvailable: false }), false);
  // Soft/real page: never escalate, even on a datacenter IP with a proxy.
  assert.equal(
    shouldEscalateToProxy({ title: "ok", text: "x".repeat(1000), html: "<main/>" }, { onDatacenterIp: true, proxyAvailable: true }),
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
