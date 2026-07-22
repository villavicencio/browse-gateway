#!/usr/bin/env node
/**
 * Per-call wall-clock budget proof (issue #43). Run IN-CONTAINER (headful Chrome under Xvfb) — it
 * OBSERVES the budget actually bounding a real browser, which unit tests (clamp math) and the other
 * gate validators (they run retrieve() with the 90s default against fast-clearing targets, so the
 * bound never bites) cannot. Two legs:
 *
 *   A. Core render deadline (the codex-r5 "working fix"): drive the REAL clearance poll and prove the
 *      shared per-call `budgetDeadlineMs` cuts it short. `clearedTextLength` is set impossibly high so
 *      the page can NEVER satisfy "cleared" — therefore the poll exiting BELOW the (much larger)
 *      clearance timeout is only possible via the budget break. This is airtight and deterministic:
 *      no clearing, no proxy, no challenge-flakiness. A regression that drops the poll's budget break
 *      (reintroducing the 160-220s stacking #43 fixed) makes this leg run to the clearance timeout.
 *
 *   B. Retrieve typed-timeout contract: a FORCED-proxy call whose budget is below the minimum-attempt
 *      floor bails BEFORE opening any proxied session (retrieve's synthetic-render path), so it makes
 *      NO proxy request (nothing billed) yet exercises the real env->config.timeouts->RetrieveOptions
 *      plumbing end-to-end and asserts the decisive `failureClass='timeout'` / `reason=null` /
 *      honest `proxyUsed=false` contract the MCP surface advertises.
 *
 * Cannot run on the host: leg A needs Docker/Xvfb + a real browser. Leg B needs BGW_PROXY_* configured
 * (never contacted); it self-skips with a note when no proxy is set (e.g. a clean CI run).
 */
import { createBrowserCore } from "../dist/browser/index.js";
import { retrieve, proxyFromSecrets } from "../dist/verbs/index.js";
import { Gateway, loadConfig, DEFAULT_CALL_TIMEOUTS } from "../dist/gateway/index.js";
import { PolicyEngine, ConsumerRegistry } from "../dist/policy/index.js";
import { SecretStore } from "../dist/security/index.js";

// A hard (Cloudflare-fronted) target that reliably LOADS from the gate's IP (leg A does not care
// whether it clears — clearedTextLength is set so it never counts as cleared). Configurable.
const TARGET = process.env.BGW_BUDGET_URL ?? "https://www.udemy.com/";
const CHANNEL = process.env.BGW_CHANNEL ?? "chrome";
const NO_SANDBOX = process.env.BGW_NO_SANDBOX === "1";

// Leg A knobs: a GLOBAL budget that (a) comfortably clears the goto so the clearance poll actually
// RUNS, then (b) cuts that poll FAR below the per-stage clearance timeout. The gap between the budget
// and the clearance timeout is the whole point — the render must return at ~budget, not ~clearance, or
// the bound regressed. (The first cut used a 5s budget; udemy's goto under Rosetta ate it before the
// poll ever slept, so the poll must be given headroom past the goto.)
const BUDGET_MS = 12_000;
const CLEARANCE_MS = 30_000;
const NEVER_CLEARS = 10_000_000; // clearedTextLength no real page reaches -> isCleared is always false,
//                                  so the poll can ONLY exit via the clearance timeout or the budget break.

let failures = 0;
let notes = 0;
const check = (label, ok) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};
const note = (label) => {
  console.log(`  ~~~~  ${label}`);
  notes++;
};

console.log("=== browse-gateway :: per-call wall-clock budget proof (issue #43) ===");
console.log(`[budget] target=${TARGET} budget=${BUDGET_MS}ms clearanceTimeout=${CLEARANCE_MS}ms`);

// ── Leg A: the shared per-call deadline cuts a REAL clearance poll short ───────────────────────────
console.log("\n── leg A: budgetDeadlineMs bounds the real clearance poll (core) ──");
{
  const core = await createBrowserCore({ channel: CHANNEL, noSandbox: NO_SANDBOX });
  try {
    // Turn on the same CDP-Fetch guard machinery prod installs, so this is a representative render.
    await core.setNavigationGuard(() => "allow");
    const t0 = performance.now();
    const r = await core.render(TARGET, {
      clearanceTimeoutMs: CLEARANCE_MS,
      budgetDeadlineMs: performance.now() + BUDGET_MS,
      clearedTextLength: NEVER_CLEARS,
    });
    const wall = Math.round(performance.now() - t0);
    const waited = Math.round(r.clearanceWaitedMs);
    console.log(`  render: status=${r.status} clearanceWaitedMs=${waited} wall=${wall}ms pollMs=${Math.round(r.timing?.clearancePollMs ?? -1)}`);
    // If the page never loaded, the budget can't be shown to bound the POLL (a nav failure is a different
    // path). Treat that as a note, not a false pass/fail — bump BGW_BUDGET_URL or BUDGET_MS if it recurs.
    if (r.status === null) {
      note(`target did not load (status=null) — cannot observe the clearance-poll bound this run (try a larger BUDGET_MS / a different BGW_BUDGET_URL)`);
    } else {
      // clearedTextLength is unreachable, so isCleared is ALWAYS false: the poll can end ONLY at the
      // ${CLEARANCE_MS}ms clearance timeout or the ${BUDGET_MS}ms budget break. Therefore a render that
      // returns at ~budget (and a poll that slept well under the clearance timeout) PROVES #43's shared
      // per-call deadline cut a real, running clearance poll — the exact 160-220s-stacking fix, observed live.
      check(`the clearance poll actually ran/slept (waited=${waited}ms > 500) — so the budget bound is genuinely under test`, waited > 500);
      check(`the poll was cut FAR below the ${CLEARANCE_MS}ms clearance timeout (waited=${waited}ms < ${CLEARANCE_MS - 10_000})`, waited < CLEARANCE_MS - 10_000);
      check(`the WHOLE render returned at ~budget, not ~clearance (wall=${wall}ms <= ${BUDGET_MS + 8_000}; unbounded it would be ~${CLEARANCE_MS + 5_000}ms)`, wall <= BUDGET_MS + 8_000);
    }
  } finally {
    await core.close();
  }
}

// ── Leg B: retrieve surfaces a decisive typed timeout (no proxy request billed) ────────────────────
console.log("\n── leg B: retrieve escalation budget -> decisive typed 'timeout' (no proxy spend) ──");
{
  const TOKEN = "tok-budget";
  const host = new URL(TARGET).hostname.replace(/^www\./, "");
  const policy = new PolicyEngine({
    registry: new ConsumerRegistry([{ id: "agent-1", token: TOKEN, allow: [host, `*.${host}`] }]),
  });
  const gateway = Gateway.create(loadConfig(), undefined, policy);
  const secrets = new SecretStore(); // reads BGW_PROXY_* from env -> proxy CONFIGURED but never contacted
  try {
    if (proxyFromSecrets(secrets) === undefined) {
      note("BGW_PROXY_* not set — skipping the retrieve typed-timeout leg (it needs a CONFIGURED proxy to force-escalate; it makes NO request)");
    } else {
      const t0 = performance.now();
      const r = await retrieve(gateway, secrets, {
        token: TOKEN,
        url: TARGET,
        forceProxy: true,
        escalation: { onDatacenterIp: true },
        // Below MIN_ATTEMPT_BUDGET_MS (2000) -> the loop bails before opening any proxied session.
        timeouts: { ...DEFAULT_CALL_TIMEOUTS, callBudgetMs: 500 },
      });
      const wall = Math.round(performance.now() - t0);
      console.log(`  retrieve: blocked=${r.blocked} reason=${r.reason} failureClass=${r.diagnostics?.failureClass} proxyUsed=${r.proxyUsed} wall=${wall}ms`);
      check("a budget-exhausted forced retrieve is reported blocked", r.blocked === true);
      check("classified as the decisive typed 'timeout' (overriding the incidental block class)", r.diagnostics?.failureClass === "timeout");
      check("the block reason is nulled on a timeout (MCP surface advertises 'timeout')", r.reason === null);
      check("NO proxy request was billed — it bailed before opening a session (proxyUsed=false)", r.proxyUsed === false);
      check(`it returned fast, bounded by the 500ms budget + overhead (wall=${wall}ms < 5000)`, wall < 5_000);
    }
  } finally {
    await gateway.shutdown();
  }
}

console.log(`\n=== CALL-BUDGET GATE: ${failures === 0 ? "PASS ✅" : "FAIL ❌"} (${failures} failure(s), ${notes} note(s)) ===`);
process.exit(failures === 0 ? 0 : 1);
