/**
 * VIL-121 — classes a fresh exit cannot clear.
 *
 * Three behaviours, one shared classifier, both verbs:
 *  - a thin 429 is `rate-limited`, distinct from a reputation `hard-block`, and never requests a fresh exit;
 *  - the proxied re-roll loop STOPS on a class no exit can change (404/410/429, or an active CAPTCHA with no
 *    solver) instead of spending the remaining attempts to be told the same thing;
 *  - budget exhaustion no longer ERASES a decisive site verdict — it becomes orthogonal evidence
 *    (`budgetExhausted`) so #43's guarantee survives without hiding the actionable half of the report.
 *
 * Every escalation assertion is written as "how many PROXIED sessions were opened", because that is the
 * thing being spent. Asserting only on the surfaced class would pass while still burning exits.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { retrieve, shouldEscalateDrive, classifyBlock, resolveBlockReason } from "../dist/verbs/index.js";
import {
  isUnclearableStatus,
  isExitClearableHardBlock,
  isTerminalUnclearableRender,
  isHardBlock,
} from "../dist/browser/index.js";
import { GatewayDriveController } from "../dist/mcp/drive-controller.js";
import {
  finalFailureClass,
  DECISIVE_FAILURE_CLASSES,
  warmFailureAdvice,
} from "../dist/observability/index.js";
import { createGatewayMcpServer } from "../dist/mcp/index.js";
import { DEFAULT_CALL_TIMEOUTS } from "../dist/gateway/index.js";
import { SecretStore } from "../dist/security/index.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "pages");
const fixture = (name) => readFileSync(join(FIXTURES, name), "utf8");

/** The visible-text projection of a fixture, as the browser core would report `render.text`. Keeps the
 *  page's `html` and `text` derived from ONE source so a fixture edit can't leave the two disagreeing. */
function visibleText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const PROXY = () => ({ BGW_PROXY_URL: "http://proxy:8080", BGW_PROXY_PASSWORD: "pwd" });
const FAT = "Real article sentence with plenty of words. ".repeat(20); // > MIN_CONTENT_LENGTH

const renderOf = (over) => ({
  url: "https://target.invalid/",
  status: 200,
  title: "",
  text: "",
  html: "",
  clearanceWaitedMs: 0,
  diagnostics: { finalUrl: "https://target.invalid/", status: over?.status ?? 200 },
  ...over,
});

/** A page built from a fixture: html + the text the core would extract from it. */
function pageFrom(name, status) {
  const html = fixture(name);
  return renderOf({ status, html, text: visibleText(html), title: "" });
}

/**
 * Fake gateway: the Nth withConsumerSession call renders the Nth programmed result (clamped to the last),
 * recording every call's coreOverrides so a test can count PROXIED sessions specifically.
 * `delayMs` makes real wall-clock cross a small callBudgetMs deterministically.
 */
function makeFakeGateway(results, delayMs = 0) {
  const calls = [];
  let idx = 0;
  const gateway = {
    async withConsumerSession(token, fn, coreOverrides) {
      const result = results[Math.min(idx, results.length - 1)];
      idx++;
      const call = { coreOverrides };
      calls.push(call);
      const session = {
        core: {
          kind: "fake",
          async render(_url, renderOpts) {
            call.renderOpts = renderOpts;
            if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
            return renderOf({ ...result });
          },
          async setNavigationGuard() {},
          async close() {},
        },
      };
      return fn(session, { id: "agent-1" });
    },
  };
  const proxiedCalls = () => calls.filter((c) => c.coreOverrides?.proxy !== undefined);
  return { gateway, calls, proxiedCalls };
}

const run = (gateway, opts = {}) =>
  retrieve(gateway, new SecretStore(() => PROXY()), {
    token: "t",
    url: "https://target.invalid/thing",
    escalation: { onDatacenterIp: true },
    ...opts,
  });

// --- the pure predicates -------------------------------------------------------------------------

test("isUnclearableStatus: 404/410/429 only — a reputation 4xx/5xx stays clearable", () => {
  for (const s of [404, 410, 429]) assert.equal(isUnclearableStatus(s), true, `${s} is unclearable`);
  for (const s of [401, 403, 407, 451, 500, 502, 503, 200]) {
    assert.equal(isUnclearableStatus(s), false, `${s} must stay exit-clearable`);
  }
  // A failed nav says nothing about the resource — its retry path is deliberately unchanged.
  assert.equal(isUnclearableStatus(null), false, "null status is not an unclearable verdict");
});

test("isExitClearableHardBlock: narrows isHardBlock without widening what counts as blocked", () => {
  const thin = { text: "Forbidden" };
  // A thin 403 is BOTH a hard block and worth an exit — the case the ladder exists for.
  assert.equal(isHardBlock(thin, 403), true);
  assert.equal(isExitClearableHardBlock(thin, 403), true);
  // A thin 404/410/429 is STILL a hard block (so it is still reported blocked) but is NOT worth an exit.
  for (const s of [404, 410, 429]) {
    assert.equal(isHardBlock(thin, s), true, `${s} thin is still a hard block`);
    assert.equal(isExitClearableHardBlock(thin, s), false, `${s} must not request a fresh exit`);
  }
  // A fat page that happens to return 4xx is neither (it rendered real content).
  assert.equal(isExitClearableHardBlock({ text: FAT }, 403), false);
});

// --- the shared block classifier -----------------------------------------------------------------

test("classifyBlock: a thin 429 is rate-limited; a thin 403 stays hard-block", () => {
  const thin429 = { title: "", text: "Slow down", status: 429 };
  assert.equal(classifyBlock(thin429), "rate-limited");
  assert.equal(classifyBlock({ title: "", text: "Forbidden", status: 403 }), "hard-block");
  assert.equal(classifyBlock({ title: "", text: "Gone", status: 410 }), "hard-block");
});

test("classifyBlock: a 429 carrying a vendor marker attributes to the VENDOR, not rate-limited", () => {
  // Load-bearing ordering: a managed challenge IS exit-clearable, so it must keep escalating even when it
  // arrives on a 429. Only a BARE 429 is a rate limit.
  assert.equal(classifyBlock({ title: "", text: "x", status: 429, cfHint: true }), "cf-challenge");
  assert.equal(classifyBlock({ title: "", text: "x", status: 429, pxHint: true }), "perimeterx-challenge");
  assert.equal(classifyBlock({ title: "", text: "x", status: 429, ddHint: true }), "datadome-challenge");
});

test("classifyBlock: a FAT 429 that rendered real content is not blocked at all", () => {
  assert.equal(classifyBlock({ title: "ok", text: FAT, status: 429 }), null);
});

// --- retrieve: no exit is spent on an unclearable class -------------------------------------------

test("retrieve: a thin 429 is rate-limited and opens ZERO proxied sessions", async () => {
  const { gateway, calls, proxiedCalls } = makeFakeGateway([pageFrom("thin-429.html", 429)]);
  const r = await run(gateway);
  assert.equal(r.blocked, true, "a thin 429 is still a failure");
  assert.equal(r.reason, "rate-limited");
  assert.equal(r.diagnostics?.failureClass, "rate-limited");
  assert.equal(r.proxyUsed, false, "no residential exit was spent");
  assert.equal(proxiedCalls().length, 0, "ZERO proxied sessions opened");
  assert.equal(calls.length, 1, "the direct attempt only");
});

test("retrieve: a thin 404 opens ZERO proxied sessions (the 2026-08-27 automatic-path burn)", async () => {
  const { gateway, calls, proxiedCalls } = makeFakeGateway([pageFrom("thin-404.html", 404)]);
  const r = await run(gateway);
  assert.equal(r.blocked, true);
  assert.equal(r.reason, "hard-block", "404 keeps the hard-block label; only exit-spending changes");
  assert.equal(proxiedCalls().length, 0, "ZERO proxied sessions opened");
  assert.equal(calls.length, 1);
});

test("CONTROL: a thin 403 STILL escalates and still re-rolls exits", async () => {
  // The negative half of the change. If this ever goes quiet, the fix has eaten the escalation ladder.
  const { gateway, proxiedCalls } = makeFakeGateway([renderOf({ status: 403, text: "Forbidden", html: "Forbidden" })]);
  const r = await run(gateway, { timeouts: { ...DEFAULT_CALL_TIMEOUTS, proxyMaxAttempts: 3 } });
  assert.equal(r.proxyUsed, true, "a reputation 403 must still buy a fresh exit");
  assert.equal(proxiedCalls().length, 3, "and must still re-roll all configured attempts");
  assert.equal(r.reason, "hard-block");
});

// --- retrieve: the re-roll loop stops on a terminal render ----------------------------------------

test("retrieve: forced proxy + an active CAPTCHA with no solver → exactly ONE proxied attempt", async () => {
  // The 2026-08-25 field case: forceProxy on a reCAPTCHA-200 re-rolled until the call budget died.
  const { gateway, proxiedCalls } = makeFakeGateway([pageFrom("challenge-interstitial-200.html", 200)]);
  const r = await run(gateway, {
    forceProxy: true,
    timeouts: { ...DEFAULT_CALL_TIMEOUTS, proxyMaxAttempts: 3 },
  });
  assert.equal(proxiedCalls().length, 1, "one attempt, not proxyMaxAttempts — the wall does not move");
  assert.equal(r.reason, "captcha");
  assert.equal(r.diagnostics?.failureClass, "captcha");
});

test("CONTROL: forced proxy + a CF managed challenge STILL re-rolls every attempt", async () => {
  // A residential exit genuinely clears a CF challenge (screenshot-proven), so this must NOT be caught by
  // the CAPTCHA terminal check. `resolveBlockReason` yields cf-challenge, not captcha, which is what
  // keeps them apart.
  const cf = renderOf({
    status: 403,
    title: "Just a moment...",
    text: "Enable JavaScript and cookies to continue",
    html: "<div id='challenge-platform' class='cf-chl-opt'></div>",
  });
  const { gateway, proxiedCalls } = makeFakeGateway([cf]);
  const r = await run(gateway, { forceProxy: true, timeouts: { ...DEFAULT_CALL_TIMEOUTS, proxyMaxAttempts: 3 } });
  assert.equal(proxiedCalls().length, 3, "CF keeps re-rolling — a clean exit clears it");
  assert.equal(r.reason, "cf-challenge");
});

test("retrieve: a proxied attempt landing a 404 stops the loop after that attempt", async () => {
  // The unclearable check is keyed on the STATUS, so it fires on a proxied attempt too, not just direct.
  const { gateway, proxiedCalls } = makeFakeGateway([
    renderOf({ status: 403, text: "Forbidden", html: "Forbidden" }), // direct → escalate
    pageFrom("thin-404.html", 404), // first exit: the resource is simply gone
  ]);
  await run(gateway, { timeouts: { ...DEFAULT_CALL_TIMEOUTS, proxyMaxAttempts: 3 } });
  assert.equal(proxiedCalls().length, 1, "stop after the exit that proved the resource is absent");
});

// --- budget exhaustion vs a decisive verdict ------------------------------------------------------

test("retrieve: a decisive CAPTCHA verdict SURVIVES budget exhaustion, which stays visible", async () => {
  // One proxied attempt runs (budget > the min-attempt floor at entry), and the render itself overruns the
  // budget — so the call is budget-exhausted AND landed a decisive verdict. Both must be reported.
  const { gateway, proxiedCalls } = makeFakeGateway([pageFrom("challenge-interstitial-200.html", 200)], 2200);
  const r = await run(gateway, {
    forceProxy: true,
    timeouts: { ...DEFAULT_CALL_TIMEOUTS, callBudgetMs: 2100, proxyMaxAttempts: 3 },
  });
  // Shape assertion only — it does NOT guard the terminal break. At this budget the loop stops after one
  // attempt either way (the next attempt's pre-check fails the min-budget floor), so deleting the break
  // leaves this green. The break's guard is the "exactly ONE proxied attempt" test above, which runs on a
  // generous budget precisely so the break is the only thing that can stop it.
  assert.equal(proxiedCalls().length, 1, "one attempt ran before the budget expired");
  assert.equal(r.diagnostics?.failureClass, "captcha", "the site's verdict is not erased by the clock");
  assert.equal(r.reason, "captcha", "and the MCP-preferred `reason` agrees with it");
  assert.equal(r.diagnostics?.budgetExhausted, true, "#43's guarantee: the budget overrun is still visible");
  assert.equal(r.proxyDiagnostic?.budgetExhausted, true, "and on the escalation diagnostic too");
});

test("#43 PRESERVED: budget exhaustion on a NON-decisive root is still a timeout", async () => {
  const { gateway } = makeFakeGateway([renderOf({ status: null, text: "", html: "" })], 2200);
  const r = await run(gateway, {
    forceProxy: true,
    timeouts: { ...DEFAULT_CALL_TIMEOUTS, callBudgetMs: 2100, proxyMaxAttempts: 3 },
  });
  assert.equal(r.diagnostics?.failureClass, "timeout", "dead exits + no budget is a timeout, as before");
  assert.equal(r.reason, null, "and the reason is nulled so the surface advertises timeout");
  assert.equal(r.diagnostics?.budgetExhausted, true);
});

test("finalFailureClass: exhaustive table over every FailureClass x budgetExceeded", () => {
  const ALL = [
    "anti-bot-block", "captcha", "hard-block", "rate-limited", "empty-shell", "hydration-failed",
    "real-zero-results", "unsupported-browser", "nav-failed", "owner-host-mismatch", "policy-blocked",
    "burned-exit", "timeout", "ok",
  ];
  for (const c of ALL) {
    assert.equal(finalFailureClass(c, false), c, `${c}: an unexhausted budget never rewrites the root`);
    const expected = DECISIVE_FAILURE_CLASSES.has(c) ? c : "timeout";
    assert.equal(finalFailureClass(c, true), expected, `${c} under exhaustion`);
  }
  assert.equal(finalFailureClass(undefined, false), undefined);
  assert.equal(finalFailureClass(undefined, true), "timeout", "an unclassified failure that spent the budget");
  // The membership itself is the load-bearing judgement — pin it so a future edit is a deliberate one.
  assert.deepEqual([...DECISIVE_FAILURE_CLASSES].sort(), ["captcha", "policy-blocked", "rate-limited"]);
  // The two exit-clearable classes are deliberately NOT decisive: for them "we ran out of time, retry" is
  // the correct advice, and #43 chose it on purpose.
  for (const c of ["hard-block", "anti-bot-block"]) {
    assert.equal(finalFailureClass(c, true), "timeout", `${c} is exit-clearable, so the timeout wins`);
  }
});

// --- drive parity ---------------------------------------------------------------------------------

test("shouldEscalateDrive: a 429 snapshot does not escalate; a 403 snapshot does", () => {
  const snap = (status, over = {}) => ({ status, title: "", tree: "Blocked", url: "https://target.invalid/", ...over });
  assert.equal(shouldEscalateDrive(snap(403)), true, "a reputation 403 still buys an exit on the drive path");
  assert.equal(shouldEscalateDrive(snap(429)), false, "a 429 must not");
  assert.equal(shouldEscalateDrive(snap(404)), false, "nor a 404");
  assert.equal(shouldEscalateDrive(snap(410)), false, "nor a 410");
  // Parity with retrieve: a CF marker escalates regardless of the status it arrives on.
  assert.equal(shouldEscalateDrive(snap(429, { cfHint: true })), true, "a CF challenge on a 429 still escalates");
});

// --- every surface over the vocabulary -------------------------------------------------------------

test("warm-advice: rate-limited gets its own advice, ahead of the fresh-exit branch", () => {
  const advice = warmFailureAdvice({ failureClass: "rate-limited", freshExitHost: true });
  assert.match(advice, /rate-limiting/i);
  assert.match(advice, /wait/i);
  assert.doesNotMatch(advice, /draw a clean exit/, "must NOT advise retrying for a fresh exit");
  assert.doesNotMatch(advice, /re-capture/, "and must not blame the stored credential");
});

test("MCP surface: a rate-limited retrieve tells the caller to wait, not to force the proxy", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createGatewayMcpServer({
    retrieve: async () => ({
      markdown: "",
      title: "",
      status: 429,
      blocked: true,
      reason: "rate-limited",
      degraded: false,
      proxyUsed: false,
      captchaSolved: false,
      diagnostics: { failureClass: "rate-limited", status: 429 },
    }),
  });
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  const res = await client.callTool({ name: "retrieve", arguments: { url: "https://target.invalid/" } });
  assert.equal(res.isError, true);
  const text = res.content[0].text;
  assert.match(text, /reason=rate-limited/);
  assert.match(text, /rate-limiting this client/);
  assert.match(text, /do not force the proxy/);
});

// --- the low-result-count guardrail from the ticket -------------------------------------------------

test("a fat 200 with few result-like entries is a SUCCESS — low result count triggers nothing", async () => {
  const html = `<!doctype html><html><head><title>Results</title></head><body><article><h1>Results</h1>
    <p><a href="https://example.invalid/a">First result</a> ${FAT}</p>
    <p><a href="https://example.invalid/b">Second result</a> ${FAT}</p></article></body></html>`;
  const { gateway, proxiedCalls } = makeFakeGateway([renderOf({ status: 200, html, text: visibleText(html) })]);
  const r = await run(gateway);
  assert.equal(r.blocked, false, "a thin RESULT SET is not a blocked PAGE");
  assert.equal(r.reason, null);
  assert.equal(proxiedCalls().length, 0);
  assert.ok(r.markdown.length > 0, "content is returned");
});

test("resolveBlockReason promotes a generic block with an active widget to captcha, on ONE surface", () => {
  const html = fixture("challenge-interstitial-200.html");
  const sig = { title: "", text: visibleText(html), status: 200, captchaKind: "recaptcha" };
  assert.equal(classifyBlock(sig), "blocked", "generic: the fixture carries no vendor marker");
  assert.equal(resolveBlockReason(sig), "captcha", "and the active widget promotes it");
});


// --- the live-vs-persistent refinement (gauntlet round 1) -------------------------------------------
//
// The escalation gate ADMITS a managed challenge on an unclearable status (a clean exit really does clear
// one), so the loop must not immediately truncate it to a single attempt. But liveness cannot be read off
// the block REASON: the vendor markers persist after a clear, so an ordinary thin 404 from any
// Cloudflare-fronted origin classifies `cf-challenge`. These two tests pin both halves against each other.

test("isTerminalUnclearableRender: an unclearable status ends the re-roll UNLESS a live challenge is visible", () => {
  const plain = { title: "Not Found", text: "The requested page does not exist." };
  const liveCf = { title: "Just a moment...", text: "Enable JavaScript and cookies to continue" };
  for (const s of [404, 410, 429]) {
    assert.equal(isTerminalUnclearableRender(plain, s), true, `${s} with no live challenge is terminal`);
    assert.equal(isTerminalUnclearableRender(liveCf, s), false, `${s} carrying a LIVE challenge is not terminal`);
  }
  assert.equal(isTerminalUnclearableRender(plain, 403), false, "a reputation 403 was never terminal");
  assert.equal(isTerminalUnclearableRender(plain, null), false, "a dead nav is not terminal here");
});

test("a LIVE Cloudflare challenge served on a 429 still re-rolls every exit", () => {
  // The escalation gate admits it, so the loop must too — otherwise the two disagree and a clearable
  // challenge is abandoned after one exit.
  const liveCfOn429 = {
    title: "Just a moment...",
    text: "Enable JavaScript and cookies to continue",
    status: 429,
  };
  assert.equal(classifyBlock(liveCfOn429), "cf-challenge", "the vendor arm wins over rate-limited");
  assert.equal(isTerminalUnclearableRender(liveCfOn429, 429), false, "so the loop does NOT terminate");
});

test("REGRESSION GUARD: an ordinary thin 404 from a CF-fronted origin is STILL terminal", async () => {
  // This pins a review suggestion that was investigated and REJECTED: keying the terminal break on the
  // block REASON instead of the status. `cfHint` is a persistent HTML marker with no liveness requirement,
  // so classifyBlock labels this page `cf-challenge` even though nothing is challenging us. Reason-gating
  // would therefore re-roll every exit on the single most common shape this ticket exists to stop.
  const html = fixture("thin-404.html") + "<script src='/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1'></script>";
  const cfFronted404 = renderOf({ status: 404, html, text: visibleText(fixture("thin-404.html")) });
  assert.equal(classifyBlock({ title: "", text: cfFronted404.text, status: 404, cfHint: true }), "cf-challenge",
    "the persistent marker alone labels it a CF challenge — which is exactly why reason-gating is unsafe");
  assert.equal(isTerminalUnclearableRender({ title: "", text: cfFronted404.text }, 404), true,
    "but with no VISIBLE challenge phrase it is still terminal");

  const { gateway, proxiedCalls } = makeFakeGateway([cfFronted404]);
  await run(gateway, { forceProxy: true, timeouts: { ...DEFAULT_CALL_TIMEOUTS, proxyMaxAttempts: 3 } });
  assert.equal(proxiedCalls().length, 1, "ONE exit, not three — the burn stays closed for CF-fronted 404s");
});

// --- drive loop parity (gauntlet round 1) -----------------------------------------------------------

/** A per-session-programmed gateway for the drive controller: sessions[n] is the nth opened session. */
function makeDriveSeq(sessions) {
  let si = -1;
  let nextId = 1;
  const open = new Map();
  const opened = [];
  const gateway = {
    sessions: { get: (h) => open.get(h) },
    async openConsumerSession(_token, overrides) {
      si += 1;
      const navs = sessions[Math.min(si, sessions.length - 1)] ?? [{}];
      let ni = 0;
      const id = "h" + nextId++;
      open.set(id, {
        core: {
          async navigate(url) {
            const o = navs[Math.min(ni, navs.length - 1)] ?? {};
            ni += 1;
            return {
              url: o.url ?? url,
              title: o.title ?? "t",
              tree: o.tree ?? FAT,
              status: "status" in o ? o.status : 200,
              diagnostics: o.diagnostics ?? { finalUrl: o.url ?? url, status: "status" in o ? o.status : 200 },
            };
          },
          async snapshot() {
            return { url: "u", title: "t", tree: FAT, status: 200 };
          },
        },
      });
      opened.push({ id, overrides });
      return id;
    },
    async useConsumerSession(_token, handle, fn) {
      const s = open.get(handle);
      if (!s) throw new Error("session not found");
      return fn(s);
    },
    async closeConsumerSession(_token, handle) {
      open.delete(handle);
    },
  };
  return { gateway, opened };
}

test("drive: a proxied 404 stops the re-roll loop instead of spending every exit", async () => {
  // Narrowing shouldEscalateDrive only stopped a DIRECT unclearable status from STARTING escalation.
  // Inside the loop each proxied 404 still satisfied navFailed and drew a fresh exit, up to
  // proxyMaxAttempts — the drive-side half of the same burn.
  const { gateway, opened } = makeDriveSeq([
    [{ status: 403, tree: "Forbidden" }], // direct: a reputation block, so escalation legitimately starts
    [{ status: 404, tree: "Not Found" }], // first proxied exit: the resource is simply absent
  ]);
  const drive = new GatewayDriveController(gateway, new SecretStore(PROXY), "tok", { onDatacenterIp: true });
  await assert.rejects(drive.navigate("https://target.invalid/gone"), () => true);
  assert.equal(opened.length, 2, "1 direct + exactly 1 proxied session — not 1 + proxyMaxAttempts");
});

test("CONTROL: drive still re-rolls every exit on a reputation 403", async () => {
  const { gateway, opened } = makeDriveSeq([[{ status: 403, tree: "Forbidden" }]]);
  const drive = new GatewayDriveController(gateway, new SecretStore(PROXY), "tok", { onDatacenterIp: true });
  await assert.rejects(drive.navigate("https://target.invalid/p"), () => true);
  assert.equal(opened.length, 1 + DEFAULT_CALL_TIMEOUTS.proxyMaxAttempts, "the ladder is intact for 403");
});
