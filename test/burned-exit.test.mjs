/**
 * #45 — burned-exit vs site-block discrimination + the drive escalation budget bound.
 *
 * Two axes, kept orthogonal (the pre-code critique's load-bearing conclusion):
 *  - `isDeadExit` is a PURE derivation over signals BOTH verbs already carry (status + landed URL) — the
 *    shared predicate that keeps retrieve and drive at detection parity (no probe, no HTML).
 *  - A proxy escalation that EXHAUSTS every attempt with a dead exit (none reached the site) is a
 *    `burned-exit` — surfaced as orthogonal exit-health EVIDENCE (EscalationDiagnostics.burnedExit) + a
 *    seam-level `burned-exit` FailureClass (a refinement of nav-failed; NO WAF vendor). A block from a LIVE
 *    exit stays site-attributed. Behavior (re-rolling) is unchanged — this is legibility.
 *  - The drive cold escalation loop now consumes the #43 per-call budget: a pre-attempt bail bounds the
 *    previously-unbounded ~200-255s stacking loop, classified `timeout`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { retrieve, isDeadExit } from "../dist/verbs/index.js";
import { DEFAULT_CALL_TIMEOUTS } from "../dist/gateway/index.js";
import { SecretStore } from "../dist/security/index.js";
import { GatewayDriveController } from "../dist/mcp/drive-controller.js";

const REAL = "real accessibility tree ".repeat(60); // > MIN_CONTENT_LENGTH
const PROXY = () => ({ BGW_PROXY_URL: "http://proxy:8080", BGW_PROXY_PASSWORD: "pwd" });

// --- the shared pure predicate (the parity primitive) --------------------------------------------

test("isDeadExit: a dead exit is null-status OR a chrome-error landing; a live response is neither", () => {
  assert.equal(isDeadExit(null, undefined), true, "no response captured → dead");
  assert.equal(isDeadExit(null, "https://site/"), true, "null status is dead regardless of URL");
  assert.equal(isDeadExit(200, "chrome-error://chromewebdata/"), true, "chrome-error landing → dead (stale 200)");
  assert.equal(isDeadExit(403, "https://site/"), false, "a real 403 is a LIVE site response, not a dead exit");
  assert.equal(isDeadExit(200, "https://site/"), false, "a real 200 is live");
});

// --- retrieve: burned-exit on all-dead proxied exhaustion ----------------------------------------

const CF_BLOCK = {
  url: "u",
  status: 403,
  title: "Just a moment...",
  text: "Enable JavaScript and cookies to continue",
  html: "<div id='challenge-platform' class='cf-chl-opt'></div>",
  clearanceWaitedMs: 0,
  diagnostics: { finalUrl: "u", status: 403 },
};
const DEAD = { url: "u", status: null, title: "", text: "", html: "", clearanceWaitedMs: 0, diagnostics: { finalUrl: "u", status: null } };
const HARD_403 = { url: "u", status: 403, title: "", text: "Forbidden", html: "Forbidden", clearanceWaitedMs: 0, diagnostics: { finalUrl: "u", status: 403 } };

/** withConsumerSession returns results[call] — call 0 is the direct render, 1.. are proxied attempts. */
function makeRenderSeq(results) {
  let i = 0;
  return {
    async withConsumerSession(_token, fn) {
      const result = results[Math.min(i, results.length - 1)];
      i += 1;
      return fn({ core: { async render() { return result; }, async setNavigationGuard() {}, async close() {} } }, { id: "agent-1" });
    },
  };
}

test("retrieve: direct CF-block then all proxied exits DEAD → burned-exit evidence + FailureClass", async () => {
  // direct = CF block (escalate), then 3 proxied attempts all dead (no exit reaches the site).
  const gateway = makeRenderSeq([CF_BLOCK, DEAD, DEAD, DEAD]);
  const r = await retrieve(gateway, new SecretStore(PROXY), {
    token: "t",
    url: "https://hard.example/",
    escalation: { onDatacenterIp: true },
  });
  assert.equal(r.blocked, true);
  assert.equal(r.proxyUsed, true);
  assert.equal(r.proxyDiagnostic.attempts, DEFAULT_CALL_TIMEOUTS.proxyMaxAttempts, "exhausted every exit");
  assert.equal(r.proxyDiagnostic.burnedExit, true, "all exits died → burned-exit evidence");
  assert.equal(r.diagnostics.failureClass, "burned-exit", "seam-level burned-exit class");
  assert.equal(r.diagnostics.wafVendor, undefined, "a burned exit carries NO WAF vendor");
  assert.equal(r.reason, null, "the burned-exit verdict nulls the incidental nav-failed reason (codex r6) so the MCP surface shows burned-exit");
});

test("retrieve: a LIVE block among the proxied attempts is site-attributed, NOT burned-exit", async () => {
  // One proxied attempt REACHES the site (a live 403) → the failure is the site's, not all-exits-dead.
  const gateway = makeRenderSeq([CF_BLOCK, DEAD, HARD_403, DEAD]);
  const r = await retrieve(gateway, new SecretStore(PROXY), {
    token: "t",
    url: "https://hard.example/",
    escalation: { onDatacenterIp: true },
  });
  assert.equal(r.blocked, true);
  assert.notEqual(r.diagnostics.failureClass, "burned-exit", "a live site response is not a burned exit");
  assert.equal(r.proxyDiagnostic.burnedExit, undefined, "burnedExit omitted when an exit reached the site");
});

test("retrieve: a FORCED-proxy all-dead escalation is NOT burned-exit (no direct-reachability control) — codex r7", async () => {
  // forceProxy SKIPS the direct attempt, so all-dead could be an off-allowlist/DNS-dead TARGET on HEALTHY
  // exits — not a burn. Without the direct-reachability evidence, stay nav-failed (positive-signal-only).
  const gateway = makeRenderSeq([DEAD, DEAD, DEAD]); // no direct render (forced); every proxied attempt dead
  const r = await retrieve(gateway, new SecretStore(PROXY), {
    token: "t",
    url: "https://hard.example/",
    forceProxy: true,
    escalation: { onDatacenterIp: true },
  });
  assert.equal(r.blocked, true);
  assert.equal(r.proxyUsed, true);
  assert.notEqual(r.diagnostics.failureClass, "burned-exit", "the forced path lacks reachability evidence → not a burn");
  assert.equal(r.proxyDiagnostic.burnedExit, undefined, "no burned-exit evidence on the forced path");
});

// --- drive: a per-session-programmed gateway that PRESERVES status:null (the dead-exit case) -------

function makeDriveSeq(sessions) {
  let si = -1;
  let nextId = 1;
  const open = new Map();
  const opened = [];
  const nav = (o, url) => ({
    url: o.url ?? url,
    title: o.title ?? "t",
    tree: o.tree ?? REAL,
    status: "status" in o ? o.status : 200, // preserve an explicit null (dead exit)
    diagnostics: o.diagnostics ?? { finalUrl: o.url ?? url, status: "status" in o ? o.status : 200 },
  });
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
            return nav(o, url);
          },
          async snapshot() {
            return { url: "u", title: "t", tree: REAL, status: 200 };
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

test("drive: direct hard-block then all proxied exits DEAD → EscalationError with burned-exit", async () => {
  const { gateway, opened } = makeDriveSeq([[{ status: 403, tree: "Forbidden" }], [{ status: null }], [{ status: null }], [{ status: null }]]);
  const drive = new GatewayDriveController(gateway, new SecretStore(PROXY), "tok", { onDatacenterIp: true });

  await assert.rejects(drive.navigate("https://hostile.example/p/1"), (err) => {
    assert.equal(err.name, "EscalationError");
    assert.equal(err.diagnostics.attempts, DEFAULT_CALL_TIMEOUTS.proxyMaxAttempts);
    assert.equal(err.diagnostics.burnedExit, true, "all exits died → burned-exit evidence");
    assert.equal(err.failure.failureClass, "burned-exit", "seam-level burned-exit class on the drive envelope");
    assert.equal(err.failure.wafVendor, undefined, "burned exit carries no WAF vendor");
    return true;
  });
  assert.equal(opened.length, 1 + DEFAULT_CALL_TIMEOUTS.proxyMaxAttempts, "1 direct + N proxied sessions opened");
});

test("drive: a LIVE hard-block on every proxied exit is site-attributed, NOT burned-exit", async () => {
  const { gateway } = makeDriveSeq([[{ status: 403, tree: "Forbidden" }], [{ status: 403, tree: "Forbidden" }], [{ status: 403, tree: "Forbidden" }], [{ status: 403, tree: "Forbidden" }]]);
  const drive = new GatewayDriveController(gateway, new SecretStore(PROXY), "tok", { onDatacenterIp: true });

  await assert.rejects(drive.navigate("https://hostile.example/p/1"), (err) => {
    assert.equal(err.diagnostics.burnedExit, undefined, "live exits reached the site → not burned");
    assert.equal(err.failure.failureClass, "hard-block", "stays the site class");
    return true;
  });
});

test("drive: an already-spent budget refuses at the queue boundary — NO session opened, typed timeout (codex r6)", async () => {
  // budgetDeadlineMs is t0-relative (pre-serialize). A zero budget (or a call that waited out its budget in
  // the serialized queue) is already expired at #navigate entry → refuse BEFORE opening/reusing a session or
  // touching the persistent page. Surfaces failureClass=timeout so the MCP error-kind reads it in-band.
  const { gateway, opened } = makeDriveSeq([[{ status: 403, tree: "Forbidden" }]]);
  const drive = new GatewayDriveController(gateway, new SecretStore(PROXY), "tok", {
    onDatacenterIp: true,
    timeouts: { ...DEFAULT_CALL_TIMEOUTS, callBudgetMs: 0 },
  });
  await assert.rejects(drive.navigate("https://hostile.example/p/1"), (err) => {
    assert.match(err.message, /budget|timed out/i, "surfaces the budget as the cause");
    assert.equal(err.failure?.failureClass, "timeout", "a budget timeout is in-band (failureClass=timeout)");
    return true;
  });
  assert.equal(opened.length, 0, "an expired budget refuses BEFORE opening any session or touching the page");
});

test("drive: the escalation loop bails on the #43 budget after the direct attempt (timeout, no proxied re-roll)", async () => {
  // A small-but-nonzero budget passes the entry check, then the pre-attempt loop bail fires (< MIN_ATTEMPT_
  // BUDGET_MS remains for a meaningful proxied attempt) → direct opened, zero proxied attempts, typed timeout.
  const { gateway, opened } = makeDriveSeq([[{ status: 403, tree: "Forbidden" }], [{ status: null }]]);
  const drive = new GatewayDriveController(gateway, new SecretStore(PROXY), "tok", {
    onDatacenterIp: true,
    timeouts: { ...DEFAULT_CALL_TIMEOUTS, callBudgetMs: 1000 }, // < MIN_ATTEMPT_BUDGET_MS (2000) → loop bails at attempt 1
  });
  await assert.rejects(drive.navigate("https://hostile.example/p/1"), (err) => {
    assert.equal(err.name, "EscalationError");
    assert.equal(err.diagnostics.attempts, 0, "no proxied attempt spent — the budget bounded the loop");
    assert.equal(err.diagnostics.proxyApplied, false);
    assert.equal(err.diagnostics.burnedExit, undefined, "a budget bail is a timeout, not a burn");
    assert.match(err.message, /budget/i, "surfaces the budget as the cause");
    assert.equal(err.failure?.failureClass, "timeout", "timeout envelope even when no attempt produced a snapshot");
    return true;
  });
  assert.equal(opened.length, 1, "only the direct session opened; the budget stopped the re-roll loop");
});

test("drive: a budget-expired single-shot navigate classifies timeout, not nav-failed (codex r2)", async () => {
  // Direct fails null-status and does NOT escalate (no proxy); with a spent budget the failure path must
  // classify timeout (the deadline was the cause), not the incidental nav-failed class.
  const { gateway } = makeDriveSeq([[{ status: null }]]);
  const drive = new GatewayDriveController(gateway, new SecretStore(() => ({})), "tok", {
    onDatacenterIp: true,
    timeouts: { ...DEFAULT_CALL_TIMEOUTS, callBudgetMs: 0 },
  });
  await assert.rejects(drive.navigate("https://example.com/"), (err) => {
    assert.match(err.message, /timed out/i, "a budget-expired navigate reads as a timeout");
    assert.equal(err.failure?.failureClass, "timeout", "classified timeout, not nav-failed");
    return true;
  });
});

test("drive: the escalation loop applies the configured BGW_PROXY_NAV_TIMEOUT_MS to each proxied open", async () => {
  const { gateway, opened } = makeDriveSeq([[{ status: 403, tree: "Forbidden" }], [{ status: null }], [{ status: null }], [{ status: null }]]);
  const drive = new GatewayDriveController(gateway, new SecretStore(PROXY), "tok", {
    onDatacenterIp: true,
    timeouts: { ...DEFAULT_CALL_TIMEOUTS, proxyNavTimeoutMs: 1234 },
  });
  await assert.rejects(drive.navigate("https://hostile.example/p/1"), () => true);
  // opened[0] is the direct session (no override); opened[1..] are the proxied attempts.
  assert.equal(opened[1].overrides.navigationTimeoutMs, 1234, "proxied opens use the configured nav timeout, not the hardcoded default");
});
