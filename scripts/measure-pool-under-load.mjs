#!/usr/bin/env node
/**
 * POOL-UNDER-LOAD MEASUREMENT (#122 — the keystone of the concurrency epic).
 *
 * THE QUESTION. When a consumer fleet issues far more concurrent work than the pool is sized for,
 * what does the gateway actually DO? A field report attributed clustered "browser core failed to
 * launch" errors to pool exhaustion. The code contradicts that: a capacity refusal raises
 * `SESSION_LIMIT` with the message `session limit reached (N)` / `per-consumer session limit reached
 * (M)` (src/gateway/session-manager.ts, the two throws in `acquire`), while `CORE_LAUNCH` is raised
 * at THREE sites carrying TWO distinct strings:
 *   - `browser core failed to launch`               — synchronous factory throw, AND launch rejection
 *                                                     (two sites, one byte-identical string, both
 *                                                     carrying a `.cause`);
 *   - `browser core launch exceeded <N>ms deadline` — the launch that blew LAUNCH_DEADLINE_MS.
 * That distinction is load-bearing here and an earlier draft of this harness got it WRONG: it
 * matched only the first string, so a deadline-blown launch under contention — the single outcome
 * this whole measurement is built to catch, and the reason the per-call ceiling is derived from
 * LAUNCH_DEADLINE_MS at all — fell through to `unclassified`, and the report printed a clean
 * "NO, that string was produced ZERO times" beside an instrument-failed exit. Both strings are
 * matched now, and BOTH are named wherever the harness answers the ticket's question.
 * Neither the report nor its refutation has ever been checked against a running gateway. Nobody has
 * looked. This script looks.
 *
 * THIS IS A MEASUREMENT, NOT A GATE. The exit code reflects the INSTRUMENT, never the finding:
 *   exit 0  — the instrument worked. That includes the unflattering answers: "launch failures DO
 *             reproduce under pure over-subscription" exits 0, because it is data, not a regression.
 *   exit 1  — the instrument failed: a negative control did not behave, the fixture was unreachable,
 *             zero calls completed, an outcome could not be named, or the pool would not drain
 *             between configurations (which would silently pollute the next one).
 * Nothing here changes production behavior. #122 explicitly forbids fixing what it finds — no
 * capacity tuning, no pool resizing, no change to admission logic. Anomalies are reported, not
 * repaired.
 *
 * ------------------------------------------------------------------------------------------------
 * THREE SEPARATELY LABELLED CONFIGURATIONS, each issued as a SIMULTANEOUS BURST
 * ------------------------------------------------------------------------------------------------
 * A loop that awaits each call in turn measures nothing — it measures a serial queue, and a serial
 * queue never reaches the ceiling. Every burst here builds all N call promises first, parks them on
 * one shared release gate, and opens the gate once (see `runBurst`), so the calls enter the admission
 * gate together.
 *
 *   R  RETRIEVE fan-out through the REAL MCP path (HTTP transport, real policy engine, real
 *      handler). `retrieve` runs through `Gateway.withSession`, which calls `acquire(coreOverrides)`
 *      with NO meta (src/gateway/index.ts) — so the per-consumer guard never fires and ONLY the
 *      global ceiling applies. Every slot in the R burst therefore authenticates as the SAME
 *      consumer ON PURPOSE: if retrieve were per-consumer capped, a single consumer could not hold
 *      more than `perConsumerMax` sessions at once, so "more than perConsumerMax concurrent
 *      retrieve sessions, zero per-consumer refusals" is the direct evidence for the uncapped claim
 *      rather than a re-reading of the source.
 *
 *   D  DRIVE-OPEN fan-out through the REAL MCP path (`browser_open`). `openConsumerSession` passes
 *      `{ consumerId }` (src/gateway/index.ts), so this path IS per-consumer capped. Slots are
 *      assigned to consumers in CONTIGUOUS BLOCKS, not round-robin — see `assignConsumers()`: with
 *      round-robin the global ceiling always fills first and the per-consumer rule is unreachable,
 *      so a round-robin drive burst would silently measure the global rule twice and report the
 *      per-consumer cap as "never observed".
 *
 *   S  DIRECT `SessionManager.acquire()` IN-PROCESS — no MCP boundary. This is the ONLY path where
 *      `err.code` and `err.cause` survive: `GatewayDriveController` re-wraps every open error into a
 *      plain `Error` (src/mcp/drive-controller.ts), discarding both, and the retrieve closure does
 *      the same. Attribution therefore splits in two: the DEADLINE site is self-identifying by its
 *      message and so is attributable on every configuration, while the factory-throw and
 *      launch-rejection sites share one string and are separable only by `.cause` — which is to say
 *      only on S. It acquires with NO meta, mirroring retrieve's admission path.
 *
 * PER CALL we record: outcome, the VERBATIM message (never normalized, never truncated in the JSON
 * record), `err.code` / `err.cause` where the path exposes them, wall-clock to outcome, the position
 * in the burst, and the settle rank. ACROSS THE RUN we sample the operator `/health` counters — the
 * existing instrument (`buildOperatorHealth`, served behind `BGW_HEALTH_TOKEN`), not a new one — and
 * additionally snapshot the same counters in-process at each call's outcome, so occupancy sits beside
 * every refusal. A refusal with the counters beside it is evidence; a refusal alone is an anecdote.
 *
 * ------------------------------------------------------------------------------------------------
 * THREE CONTROLS. This project has been repeatedly bitten by checks that pass unconditionally.
 * ------------------------------------------------------------------------------------------------
 * A harness that reports "no refusals observed" is worthless until it has been SHOWN to report
 * refusals when they exist (docs/solutions/best-practices/a-test-whose-stub-guarantees-the-assertion-
 * proves-nothing.md). All three controls are RUNNABLE and REPORTED, not merely coded:
 *
 *   control-1  concurrency 1 must produce ZERO refusals AND ZERO launch failures. The refusal leg
 *              guards the false-positive direction (a harness that refuses everything would also
 *              "find" a capacity story). The launch leg guards the ENVIRONMENT: control-1 at
 *              concurrency 1 against an empty pool is the one phase that structurally cannot be
 *              capacity-limited, so a launch failure there means the container is broken — and
 *              without this leg a container where every launch fails passes every control and
 *              publishes "launch failures REPRODUCED", the field report's exact claim, manufactured.
 *              NOTE its structural weakness, stated in the report: control-1 asserts an ABSENCE, so
 *              a completely blind harness passes it. That is exactly why control-2 exists.
 *   control-2  maxSessions=1 at concurrency 4 must produce the LITERAL string
 *              `session limit reached (1)` on EVERY selected configuration — not merely once
 *              somewhere. Each configuration is structurally guaranteed 3 refusals at that shape, so
 *              a per-configuration requirement costs nothing and closes the case where ONE path goes
 *              blind (e.g. retrieve stops surfacing refusals as `isError` text) while the others
 *              carry the control and the main run then reads that path's silence as a result.
 *              Guards the false-negative direction — the one that matters here, because the headline
 *              finding of this ticket may well be a null result.
 *   SELF-TEST  POOL_LOAD_SELFTEST_SWALLOW=1 makes the single outcome-capture choke point
 *              (`classifyOutcome`) DISCARD every captured error, so an operator can watch the report
 *              go EMPTY rather than stay green. A GREEN REPORT UNDER THAT FLAG MEANS THE HARNESS IS
 *              BLIND. Under the flag the run always exits non-zero and prints which way it failed:
 *              control-2 losing its literal (expected — the instrument correctly detects its own
 *              blindness) or everything staying green (the self-test itself is broken).
 *
 * If a control does not run, the report REFUSES TO DRAW A CONCLUSION and says so. An unvalidated
 * instrument's null result is not a null result. The same refusal applies to a PARTIAL run —
 * narrowing POOL_LOAD_CONFIGS does not drop a control, so without this a `POOL_LOAD_CONFIGS=D`
 * invocation would print the full conclusion (including "launch failures: NONE observed" and the
 * launch-latency handoff) from a run in which S, the only configuration with raise-site attribution,
 * never executed. The controls and the instrument checks therefore run BEFORE any verdict is
 * printed, and every verdict section is gated on the result.
 *
 * ------------------------------------------------------------------------------------------------
 * VALIDITY LIMIT — restated in the output, not just here
 * ------------------------------------------------------------------------------------------------
 * The fixture path excludes proxy-connect and remote-target render cost, both of which sit inside the
 * production launch/first-nav window. A null result therefore bounds the claim to "not reproducible
 * without proxy and remote cost", NOT "does not occur". That sentence is printed verbatim whenever
 * the run finds no launch failures.
 *
 * ------------------------------------------------------------------------------------------------
 * RUN IT (in-container — headful Chrome under Xvfb is the shipping vehicle; never run this locally
 * and quote the numbers, a Mac-local run measures a different launch)
 * ------------------------------------------------------------------------------------------------
 *   docker build --platform linux/amd64 -f docker/Dockerfile -t browse-gateway:pool-load .
 *
 *   # the measurement (main run + both controls):
 *   docker run --rm --platform linux/amd64 --shm-size=1g --init browse-gateway:pool-load \
 *     node scripts/measure-pool-under-load.mjs
 *
 *   # control-2 ALONE, for pasting into the PR (exits 0 when the literal appears):
 *   docker run --rm --platform linux/amd64 --shm-size=1g --init \
 *     -e POOL_LOAD_PHASES=control-2 browse-gateway:pool-load \
 *     node scripts/measure-pool-under-load.mjs
 *
 *   # control-1 ALONE:
 *   docker run --rm --platform linux/amd64 --shm-size=1g --init \
 *     -e POOL_LOAD_PHASES=control-1 browse-gateway:pool-load \
 *     node scripts/measure-pool-under-load.mjs
 *
 *   # the blindness self-test (ALWAYS exits non-zero; read the SELF-TEST section of the output):
 *   docker run --rm --platform linux/amd64 --shm-size=1g --init \
 *     -e POOL_LOAD_SELFTEST_SWALLOW=1 browse-gateway:pool-load \
 *     node scripts/measure-pool-under-load.mjs
 *
 *   # a fuller launch-latency distribution (bigger pool, more rounds — costs real minutes):
 *   docker run --rm --platform linux/amd64 --shm-size=1g --init \
 *     -e BGW_MAX_SESSIONS=4 -e POOL_LOAD_ROUNDS=6 browse-gateway:pool-load \
 *     node scripts/measure-pool-under-load.mjs
 *
 * ENV
 *   BGW_MAX_SESSIONS=<n>            the pool cap under test (default: the shipped 2). The main run's
 *                                   concurrency defaults to 4x this.
 *   BGW_PER_CONSUMER_MAX=<n>        the per-consumer drive cap (default: the shipped 1).
 *   POOL_LOAD_CONCURRENCY=<n>       burst size for the main run (default 4 x maxSessions, min 2).
 *   POOL_LOAD_ROUNDS=<n>            main-run bursts per configuration (default 3). The launch-latency
 *                                   distribution has n = rounds x successes-per-round, so this is the
 *                                   knob that makes the distribution worth the name.
 *   POOL_LOAD_CONSUMERS=<n>         distinct consumers the D burst spreads over, in blocks (default 2).
 *   POOL_LOAD_CONFIGS=R,D,S         which configurations to run (default all three).
 *   POOL_LOAD_PHASES=main,control-1,control-2   which phases to run (default all three). Narrowing
 *                                   this yields a PARTIAL RUN: no conclusion is licensed from it.
 *   POOL_LOAD_HEALTH_INTERVAL_MS=<n>  operator /health poll interval during a burst (default 20).
 *   POOL_LOAD_SELFTEST_SWALLOW=1    the blindness self-test described above. NOT a measurement.
 *   POOL_LOAD_OUT=<path>            write the full structured record as JSON.
 *   POOL_LOAD_HOST=<host>           override the synthetic fixture hostname (default pool-fixture.example).
 */
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import dns from "node:dns/promises";

import { Gateway, loadConfig, LAUNCH_DEADLINE_MS } from "../dist/gateway/index.js";
import { PolicyEngine, ConsumerRegistry } from "../dist/policy/index.js";
import { SecretStore, redactSecrets } from "../dist/security/index.js";
import { createHttpHandler, createGatewayMcpServer } from "../dist/mcp/index.js";
// Not on the mcp barrel, so imported from its module — deliberately REUSED rather than reimplemented:
// #122 says the occupancy instrument already exists and must not be rebuilt, and a hand-rolled second
// projection of the pool getters would be free to disagree with what an operator sees on /health.
import { buildOperatorHealth } from "../dist/mcp/http-server.js";
import { GatewayDriveController } from "../dist/mcp/drive-controller.js";
import { retrieve } from "../dist/verbs/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// --- configuration ------------------------------------------------------------------------------

/** Reserved-TLD synthetic host for the local fixture. `.example` never resolves publicly, and the
 *  egress filter is PURE (it never resolves DNS), so a name that is not an IP literal and does not
 *  end in `.localhost`/`.internal`/`.local` passes the REAL filter — which is strictly better
 *  evidence than weakening it. Mapped to 127.0.0.1 in /etc/hosts for the run and restored after. */
const FIXTURE_HOST = process.env.POOL_LOAD_HOST || "pool-fixture.example";
const HOSTS_PATH = "/etc/hosts";
const FIXTURE_PATH = "/page";

const baseConfig = loadConfig();
const MAX_SESSIONS = baseConfig.maxSessions;
const PER_CONSUMER_MAX = baseConfig.perConsumerMax;
/** Over-subscription factor for the main run. 4x is the ticket's upper default: enough that the
 *  ceiling is crossed several times over even if a couple of slots settle early. */
const DEFAULT_OVERSUBSCRIBE = 4;
const CONCURRENCY = intOr(process.env.POOL_LOAD_CONCURRENCY, Math.max(2, DEFAULT_OVERSUBSCRIBE * MAX_SESSIONS));
const ROUNDS = intOr(process.env.POOL_LOAD_ROUNDS, 3);
const CONSUMER_COUNT = intOr(process.env.POOL_LOAD_CONSUMERS, 2);
const HEALTH_INTERVAL_MS = intOr(process.env.POOL_LOAD_HEALTH_INTERVAL_MS, 20);
const ALL_CONFIGS = ["R", "D", "S"];
const CONFIGS = listOr(process.env.POOL_LOAD_CONFIGS, ALL_CONFIGS);
const ALL_PHASES = ["main", "control-1", "control-2"];
const PHASES = listOr(process.env.POOL_LOAD_PHASES, ALL_PHASES);
const SWALLOW = process.env.POOL_LOAD_SELFTEST_SWALLOW === "1";

/** control-2's shape, fixed in source rather than env-exposed: the control's whole value is that it
 *  is a KNOWN refusal on demand, and an operator who can retune it can tune it into vacuity (e.g.
 *  concurrency 1, which cannot refuse anything). Its literal expectation is derived from this. */
const CONTROL2_MAX_SESSIONS = 1;
const CONTROL2_CONCURRENCY = 4;
const CONTROL2_LITERAL = `session limit reached (${CONTROL2_MAX_SESSIONS})`;

/**
 * Per-call ceiling for an MCP tool call, and the single most consequential number in the harness.
 * It is derived from LAUNCH_DEADLINE_MS rather than written as a bare constant: a client timeout
 * BELOW the launch deadline would abort a wedged launch from the client side and record it as a
 * transport error, so the very outcome this ticket exists to look for — a launch that fails because
 * it blew the deadline, i.e. the `browser core launch exceeded <N>ms deadline` raise site — would be
 * destroyed by the instrument before it could be observed.
 *
 * The margin on top is NOT "retrieve's call budget stacked after the launch", which an earlier
 * comment here claimed and which is wrong twice over: `callBudgetMs` defaults to 90s (larger than a
 * bare 60s), and it is t0-RELATIVE (`renderOpts.budgetDeadlineMs = t0 + callBudgetMs`,
 * src/verbs/retrieve.ts), so it SUBSUMES the launch rather than stacking after it. The real bound a
 * retrieve call can reach is therefore max(LAUNCH_DEADLINE_MS, callBudgetMs) plus post-render
 * extraction, and the margin exists to sit clear of that maximum — so it is computed from both
 * numbers instead of guessed. A margin is still added on top so a call that legitimately runs to its
 * own internal deadline returns the gateway's typed error rather than a client-side abort the
 * classifier could only file as `unclassified`.
 */
const CALL_TIMEOUT_MARGIN_MS = 60_000;
const CALL_TIMEOUT_MS = Math.max(LAUNCH_DEADLINE_MS, baseConfig.timeouts.callBudgetMs) + CALL_TIMEOUT_MARGIN_MS;
/** How long a configuration may take to return the pool to zero before the run is declared broken.
 *  Generous: a graceful Chrome close plus the force-kill confirm is seconds, never a minute. */
const DRAIN_TIMEOUT_MS = 60_000;
/** Poll interval while waiting for the pool to drain between configurations. */
const DRAIN_POLL_MS = 50;
/** Per-poll bound on the /health sampler, so a stalled sampler request cannot pile up behind the burst. */
const HEALTH_POLL_TIMEOUT_MS = 1_000;
/** Rows printed per table before elision. The JSON record always carries every call. */
const MAX_TABLE_ROWS = 24;
/** Verbatim messages are printed truncated to this width; the JSON record keeps them whole. */
const MSG_PRINT_CHARS = 150;
/**
 * Budget for HARNESS-SIDE burst issue skew: the spread between the first and last call reaching
 * `invoke` after the release gate opens. Every task is already parked on one promise, so the
 * continuations run in a single microtask drain and this is normally sub-millisecond; the budget is
 * deliberately loose because its job is to catch a STRUCTURAL regression (an `await` accidentally
 * introduced inside the task-building loop, turning the burst back into the serial queue the whole
 * design exists to avoid), not to police scheduler jitter.
 *
 * Stated plainly because it is easy to over-read: this number proves the harness ISSUED the calls
 * together. It cannot prove they OVERLAPPED inside the gateway — `t0` is taken before `invoke`, so
 * any serialization downstream of it (transport, dispatcher, event-loop starvation) is invisible
 * here. The evidence for gateway-side overlap is the occupancy peak and the refusals themselves.
 */
const BURST_ISSUE_SKEW_BUDGET_MS = 250;

function intOr(raw, fallback) {
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(String(raw).trim())) return NaN; // signalled to the validator below, never silently defaulted
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : NaN;
}

function listOr(raw, fallback) {
  if (raw === undefined || raw === "") return fallback;
  return String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Malformed instrument configuration is refused BEFORE anything is measured, because each of these
 * mistakes degrades into a plausible-looking measurement instead of an error:
 *   - a non-integer POOL_LOAD_CONCURRENCY silently becoming 1 turns the whole run into control-1:
 *     zero refusals, a clean-looking histogram, and a "the pool never refused anything" writeup
 *     drawn from a burst that never over-subscribed at all;
 *   - a concurrency at or below maxSessions cannot reach the ceiling, so a null result would be
 *     structurally guaranteed rather than measured — the exact shape of a false clean report;
 *   - a typo'd configuration or phase name would silently drop the run that carries the evidence
 *     (drop S and there is no attribution; drop control-2 and no conclusion is licensed) while the
 *     report still prints as if it had run everything;
 *   - a POOL_LOAD_CONSUMERS of 1 makes the D burst unable to ever reach the GLOBAL rule, and a
 *     value above the concurrency leaves consumers with no slots at all;
 *   - a consumer count that divides the concurrency into blocks no larger than `perConsumerMax`
 *     makes the PER-CONSUMER rule structurally unreachable on D (see `assignConsumers`), and its
 *     absence would then print in the conclusion as "0 refused by the per-consumer cap" — a
 *     measured-looking zero from a burst that could not have produced anything else.
 */
const configErrors = [];
if (!Number.isInteger(CONCURRENCY)) configErrors.push(`POOL_LOAD_CONCURRENCY must be a positive integer, got ${JSON.stringify(process.env.POOL_LOAD_CONCURRENCY)}`);
else if (CONCURRENCY <= MAX_SESSIONS) configErrors.push(`POOL_LOAD_CONCURRENCY (${CONCURRENCY}) must EXCEED maxSessions (${MAX_SESSIONS}) — at or below the cap the burst cannot over-subscribe the pool, so "no refusals" would be an artifact of the configuration rather than a measurement`);
if (!Number.isInteger(ROUNDS)) configErrors.push(`POOL_LOAD_ROUNDS must be a positive integer, got ${JSON.stringify(process.env.POOL_LOAD_ROUNDS)}`);
if (!Number.isInteger(CONSUMER_COUNT)) configErrors.push(`POOL_LOAD_CONSUMERS must be a positive integer, got ${JSON.stringify(process.env.POOL_LOAD_CONSUMERS)}`);
else if (CONSUMER_COUNT < 2) configErrors.push(`POOL_LOAD_CONSUMERS must be at least 2: with a single consumer every drive slot is refused by the PER-CONSUMER rule and the global rule is unreachable on the D path, so the D burst would measure only half of what it is for`);
else if (Number.isInteger(CONCURRENCY) && CONSUMER_COUNT > CONCURRENCY) configErrors.push(`POOL_LOAD_CONSUMERS (${CONSUMER_COUNT}) must not exceed POOL_LOAD_CONCURRENCY (${CONCURRENCY}) — consumers with no slots contribute nothing and shrink every block`);
// The equality case (consumers === concurrency) is the one the block design was written to prevent and
// the one the two bounds above happily admit: it hands every consumer exactly one slot, so
// `#countForConsumer` never reaches perConsumerMax before the check and the D burst degenerates into the
// round-robin shape the header calls unusable. Refused rather than warned, at parity with the
// `CONCURRENCY <= MAX_SESSIONS` rule directly above it: in both cases a rule cannot fire, so its zero is
// an artifact of the configuration rather than a measurement — and this script's own conclusion quotes
// that zero as a fact. Only enforced when D is actually selected, since no other configuration claims to
// exercise the per-consumer rule.
else if (CONFIGS.includes("D") && Number.isInteger(CONCURRENCY) && Math.ceil(CONCURRENCY / CONSUMER_COUNT) <= PER_CONSUMER_MAX)
  configErrors.push(
    `POOL_LOAD_CONSUMERS (${CONSUMER_COUNT}) at concurrency ${CONCURRENCY} gives every consumer a block of ${Math.ceil(CONCURRENCY / CONSUMER_COUNT)} slot(s), which cannot exceed perConsumerMax (${PER_CONSUMER_MAX}) — the per-consumer rule would be UNREACHABLE on the D burst and its absence would read as a measurement. Lower POOL_LOAD_CONSUMERS, raise POOL_LOAD_CONCURRENCY, or drop D from POOL_LOAD_CONFIGS.`,
  );
if (!Number.isInteger(HEALTH_INTERVAL_MS)) configErrors.push(`POOL_LOAD_HEALTH_INTERVAL_MS must be a positive integer, got ${JSON.stringify(process.env.POOL_LOAD_HEALTH_INTERVAL_MS)}`);
for (const c of CONFIGS) if (!ALL_CONFIGS.includes(c)) configErrors.push(`POOL_LOAD_CONFIGS: unknown configuration ${JSON.stringify(c)} (valid: ${ALL_CONFIGS.join(",")})`);
for (const p of PHASES) if (!ALL_PHASES.includes(p)) configErrors.push(`POOL_LOAD_PHASES: unknown phase ${JSON.stringify(p)} (valid: ${ALL_PHASES.join(",")})`);
if (!CONFIGS.length) configErrors.push("POOL_LOAD_CONFIGS selected no configurations");
if (!PHASES.length) configErrors.push("POOL_LOAD_PHASES selected no phases");
if (configErrors.length) {
  console.error("=== INSTRUMENT FAILED (configuration) ===");
  for (const e of configErrors) console.error(`  ${e}`);
  process.exit(1);
}

// --- instrument bookkeeping ---------------------------------------------------------------------

/** Raised when a self-check makes everything downstream meaningless, so the catch can print one
 *  line instead of a stack that reads like a harness bug. */
class InstrumentAbort extends Error {}

const instrumentFailures = [];
const notes = [];
const fail = (msg) => {
  instrumentFailures.push(msg);
  console.log(`  FAIL  ${msg}`);
};
const note = (msg) => {
  notes.push(msg);
  console.log(`  note  ${msg}`);
};
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) instrumentFailures.push(label + (detail ? ` — ${detail}` : ""));
  return ok;
};

const now = () => performance.now();
const r2 = (x) => (typeof x === "number" && Number.isFinite(x) ? Math.round(x * 100) / 100 : null);

/** Nearest-rank percentile over an ascending array. Nearest-rank, not interpolated: at the sample
 *  sizes a 2-slot pool produces, an interpolated p95 invents a value that no launch ever took. */
function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

function summarize(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  const mean = s.reduce((a, b) => a + b, 0) / n;
  const median = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  return { n, min: r2(s[0]), median: r2(median), p95: r2(percentile(s, 0.95)), max: r2(s[n - 1]), mean: r2(mean) };
}

/** Render a distribution with its n attached, and — below a threshold — an explicit warning that the
 *  p95 is an order statistic of a handful of samples rather than a percentile. #122 hands this number
 *  to the deadline ticket; handing it over unlabelled would let a p95 computed from four launches be
 *  quoted as if it bounded the tail. */
function renderDist(label, dist) {
  if (!dist) return `  ${label}: NO SAMPLES`;
  const thin = dist.n < 20 ? `  [n=${dist.n} — p95 here is an ORDER STATISTIC near the max, not a tail estimate; raise POOL_LOAD_ROUNDS/BGW_MAX_SESSIONS for a real percentile]` : "";
  return `  ${label}: n=${dist.n} min=${dist.min}ms median=${dist.median}ms p95=${dist.p95}ms max=${dist.max}ms mean=${dist.mean}ms${thin}`;
}

const clip = (s, nChars = MSG_PRINT_CHARS) => {
  if (s === null || s === undefined) return "";
  const one = String(s).replace(/\s+/g, " ").trim();
  return one.length > nChars ? `${one.slice(0, nChars)}…[+${one.length - nChars}]` : one;
};

// --- the local fixture --------------------------------------------------------------------------

/**
 * Deliberately boring, deterministic, and self-contained: the measurement is about ADMISSION, so the
 * page must contribute as little variance to the launch/first-nav window as possible. It carries well
 * over MIN_CONTENT_LENGTH (200) characters of extractable prose because `retrieve` classifies a
 * thin/empty extraction as a FAILURE — a short fixture would turn every successful R call into an
 * `isError` result and the harness would report a pool problem that is really a fixture problem.
 * No external references, no scripts, no images: nothing that could make one slot's render differ
 * from another's, and nothing that reaches the network.
 */
const FIXTURE_HTML = [
  "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">",
  "<title>Pool capacity fixture</title></head><body><article>",
  "<h1>Pool capacity fixture</h1>",
  "<p>This page exists only so that a retrieve call has something deterministic to render while the",
  "session pool is deliberately over-subscribed. It is served from the loopback interface inside the",
  "same container as the browser, so no proxy is involved and no external host is contacted.</p>",
  "<p>The text here is filler with no purpose beyond clearing the minimum-content threshold the",
  "retrieve verb uses to distinguish a real page from an empty shell or a challenge interstitial. A",
  "page that extracted to fewer characters than that threshold would be reported as a retrieval",
  "failure, and the harness would then mistake a fixture problem for a capacity problem.</p>",
  "<p>Nothing on this page is dynamic. There are no scripts, no stylesheets, no images, and no",
  "network requests of any kind, so two renders of it differ only by the cost of launching and",
  "driving the browser itself, which is exactly the quantity being measured.</p>",
  "</article></body></html>",
].join("\n");

// --- /etc/hosts mapping (so the REAL egress filter stays in force) --------------------------------

/**
 * Append `127.0.0.1 <FIXTURE_HOST>` unless already present. The container runs as root so this
 * normally succeeds; a non-root local run fails and the caller takes the documented in-process
 * fallback (a PolicyEngine built with a test-only egress override), which is weaker evidence and is
 * reported as such. Keeps the original bytes so the exit path can restore the file byte-for-byte,
 * and only when the file still looks exactly like what we wrote — a concurrent edit is never
 * clobbered. Pattern borrowed from scripts/measure-input-realism.mjs, including the `[^\S\n]`
 * (whitespace-except-newline) class: a plain `\s` under /m can walk across newlines from another
 * 127.0.0.1 line and read as "already present" when it is not.
 */
function ensureHostsEntry() {
  const line = `127.0.0.1 ${FIXTURE_HOST}\n`;
  const hostPattern = FIXTURE_HOST.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const alreadyRe = new RegExp(`^[^\\S\\n]*127\\.0\\.0\\.1(?:[^\\S\\n]+\\S+)*[^\\S\\n]+${hostPattern}[^\\S\\n]*$`, "m");
  try {
    const original = readFileSync(HOSTS_PATH, "utf8");
    if (alreadyRe.test(original)) return { ok: true, added: false, original, written: original };
    const written = original.endsWith("\n") ? original + line : `${original}\n${line}`;
    writeFileSync(HOSTS_PATH, written);
    return { ok: true, added: true, original, written };
  } catch (err) {
    return { ok: false, added: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function restoreHostsEntry(state) {
  if (!state?.added) return;
  try {
    if (readFileSync(HOSTS_PATH, "utf8") === state.written) writeFileSync(HOSTS_PATH, state.original);
  } catch {
    /* best-effort; the container is disposable and a left-behind line is inert */
  }
}

// --- the outcome capture choke point --------------------------------------------------------------

let swallowedCount = 0;

/** The refusal/failure vocabulary this harness is willing to publish. Anything outside it is an
 *  INSTRUMENT failure by design (see `classifyOutcome`): a distribution containing outcomes the
 *  harness cannot name is not a distribution, it is a guess with a histogram around it. */
const CLASS = {
  OK: "ok",
  GLOBAL_LIMIT: "global-limit",
  PER_CONSUMER_LIMIT: "per-consumer-limit",
  SHUTTING_DOWN: "shutting-down",
  /** `CORE_LAUNCH` from the factory-throw or launch-rejection site — one string, two sites. */
  LAUNCH_FAILURE: "launch-failure",
  /** `CORE_LAUNCH` from the DEADLINE site. Split out rather than folded into `launch-failure`
   *  because it is the only one of the three raise sites that names itself in its message, so
   *  keeping it distinct is free attribution on R and D, where `.code`/`.cause` are discarded. */
  LAUNCH_DEADLINE: "launch-deadline",
  /** retrieve's IN-BAND failure envelope (src/mcp/server.ts): a completed round trip that returned a
   *  blocked / empty / unreachable result. NOT a capacity refusal and NOT a launch failure — but very
   *  much gateway behaviour under load, so it gets a name of its own instead of falling through to
   *  `unclassified` and converting a real behavioural finding into an instrument failure + exit 1. */
  RETRIEVE_IN_BAND: "retrieve-in-band",
  UNCLASSIFIED: "unclassified",
};

/** The two classes that together answer the ticket's headline question. Both are `CORE_LAUNCH`; they
 *  are counted together everywhere the report says "launch failure" and reported separately wherever
 *  the raise site matters. */
const LAUNCH_CLASSES = [CLASS.LAUNCH_FAILURE, CLASS.LAUNCH_DEADLINE];
const isLaunchClass = (r) => LAUNCH_CLASSES.includes(r.class);

function classifyMessage(message) {
  if (/per-consumer session limit reached \(\d+\)/.test(message)) return CLASS.PER_CONSUMER_LIMIT;
  if (/session limit reached \(\d+\)/.test(message)) return CLASS.GLOBAL_LIMIT;
  if (/session manager is shutting down/.test(message)) return CLASS.SHUTTING_DOWN;
  if (/browser core failed to launch/.test(message)) return CLASS.LAUNCH_FAILURE;
  // The DEADLINE site's own string. Matching only the line above it — which an earlier draft did —
  // silently drops the single most consequential outcome this harness exists to catch: a launch that
  // wedges past LAUNCH_DEADLINE_MS under contention lands in `unclassified`, the run exits 1 as
  // "instrument failed", and the headline section prints "that string was produced ZERO times" in the
  // same output. Literally true, materially false: over-subscription DID produce a CORE_LAUNCH.
  if (/browser core launch exceeded \d+ms deadline/.test(message)) return CLASS.LAUNCH_DEADLINE;
  // retrieve's in-band envelope, matched on the prefix it is built from rather than on `_meta` so the
  // MCP paths (which carry `_meta`) and any future in-process path classify identically. Anchored, so
  // it cannot swallow an arbitrary unknown message and manufacture a name for it.
  if (/^Could not retrieve readable content for /.test(message)) return CLASS.RETRIEVE_IN_BAND;
  return CLASS.UNCLASSIFIED;
}

const textOf = (res) => res?.content?.map((c) => (c.type === "text" ? c.text : "")).join("") ?? "";

/**
 * THE SINGLE CHOKE POINT through which every outcome — thrown error (S) and `isError` tool result
 * (R, D) — becomes a record. It is single ON PURPOSE: the self-test below has to be able to blind
 * the WHOLE instrument, and a swallow that only reached the thrown-error path would "prove" the
 * harness sees refusals while leaving the two MCP configurations — where refusals arrive as an
 * ordinary successful HTTP response carrying `isError: true`, not as an exception — untested.
 *
 * POOL_LOAD_SELFTEST_SWALLOW=1 makes it discard the captured error and report the call as clean.
 * That is the instrument's self-test: the report must then go EMPTY. If it stays green, the harness
 * is blind and every clean result it has ever printed is worthless.
 */
function classifyOutcome({ thrown, toolResult }) {
  let message = null;
  let code = null;
  let cause = null;
  if (thrown) {
    message = thrown instanceof Error ? thrown.message : String(thrown);
    // `.code` and `.cause` survive ONLY here (the in-process S path). The MCP boundary re-wraps into
    // a plain Error and drops both, which is precisely why S exists as a separate configuration.
    code = typeof thrown?.code === "string" ? thrown.code : null;
    const c = thrown?.cause;
    if (c) cause = { name: c?.name ?? typeof c, message: c instanceof Error ? c.message : String(c) };
  } else if (toolResult?.isError) {
    message = textOf(toolResult);
  }

  if (message !== null && SWALLOW) {
    swallowedCount++;
    return { outcome: "ok", class: CLASS.OK, message: null, code: null, cause: null, swallowed: true };
  }
  if (message === null) return { outcome: "ok", class: CLASS.OK, message: null, code: null, cause: null, swallowed: false };
  return { outcome: "error", class: classifyMessage(message), message, code, cause, swallowed: false };
}

// --- the stack (real gateway + real policy + real HTTP MCP surface) --------------------------------

/** Consumer ids/tokens are PLACEHOLDERS — this repo is public and carries no fleet identifiers. */
const consumerSpecs = (count, allowHost) =>
  Array.from({ length: count }, (_, i) => ({ id: `consumer-${i + 1}`, token: `pool-load-token-${i + 1}`, allow: [allowHost] }));

/**
 * Stand up one complete stack for a phase: the real Gateway, the real PolicyEngine, the real
 * Streamable-HTTP MCP handler wired exactly as `src/mcp/http-main.ts` wires it (same drive
 * controller, same retrieve closure, same operator-health producer). Per PHASE, not per run,
 * because `maxSessions` is fixed at `Gateway.create` time — control-2's smaller pool is a different
 * gateway, not a mutated one.
 *
 * The idle reaper is deliberately NOT started. It is a second actor that mutates occupancy on its
 * own schedule (idle-TTL and wedged-in-flight branches), and this measurement is about what the
 * ADMISSION GATE does to a burst; a reaper firing mid-burst would put session churn into the record
 * with no way to attribute it. Teardown is explicit (`gateway.shutdown()`), so nothing leaks by
 * skipping it.
 */
function buildStack({ maxSessions, egressOverride, fixtureHostForAllowlist }) {
  const specs = consumerSpecs(CONSUMER_COUNT, fixtureHostForAllowlist);
  const secrets = new SecretStore(() => ({}));
  secrets.addRedactable(specs.map((s) => s.token));
  const registry = new ConsumerRegistry(specs);
  const policy = new PolicyEngine({ registry, ...(egressOverride ? { egress: egressOverride } : {}) });
  const config = { ...loadConfig(), maxSessions };
  const gateway = Gateway.create(config, undefined, policy);

  // A dedicated operator token, distinct from every consumer token — the same separation
  // `src/mcp/http-main.ts` enforces with its collision boot guard. Random per run so it cannot be
  // mistaken for a fixture value someone might copy into a deployment.
  const healthToken = randomBytes(16).toString("hex");
  secrets.addRedactable([healthToken]);

  let handler;
  const httpServer = createServer((req, res) => {
    if (!handler) {
      res.writeHead(503);
      res.end();
      return;
    }
    handler.handle(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    });
  });

  const makeHandler = (allowedHosts) =>
    createHttpHandler({
      authenticate: (token) => policy.authenticate(token),
      buildServer: (consumer) => {
        const drive = new GatewayDriveController(gateway, secrets, consumer.token, {
          onDatacenterIp: false, // no escalation: a proxied attempt cannot reach a loopback fixture
          verifyEgress: false,
          log: () => {},
        });
        const server = createGatewayMcpServer({
          drive,
          retrieve: async ({ url }) => {
            try {
              // `timeouts: config.timeouts` is passed because http-main.ts passes it (#43/#45): omitting
              // it silently runs R on DEFAULT_CALL_TIMEOUTS and ignores any BGW_* timeout set in the
              // container, while the run header prints the run's bounds as though the stack were
              // faithful — a fidelity gap invisible in the output.
              return await retrieve(gateway, secrets, { token: consumer.token, url, escalation: { onDatacenterIp: false }, timeouts: config.timeouts });
            } catch (err) {
              // Byte-identical to http-main's closure, including the redaction re-wrap that DISCARDS
              // `.code`/`.cause`. Kept faithful rather than "improved" to preserve the attribution
              // gap this ticket is measuring: if the harness quietly forwarded the typed error here,
              // the R configuration would report attribution the production path does not have.
              throw new Error(redactSecrets(err instanceof Error ? err.message : String(err), secrets));
            }
          },
        });
        return { server, dispose: () => drive.close() };
      },
      allowedHosts,
      health: () => ({ status: "ok" }),
      healthToken,
      operatorHealth: () => buildOperatorHealth(gateway.sessions),
      log: () => {},
    });

  return {
    gateway,
    policy,
    secrets,
    specs,
    healthToken,
    httpServer,
    maxSessions,
    get handler() {
      return handler;
    },
    async listen() {
      const port = await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve(httpServer.address().port)));
      // DNS-rebind protection stays ON, pinned to the loopback host:port actually bound — the same
      // posture production runs with, so the /health sampler is exercising the real route guard too.
      handler = makeHandler([`127.0.0.1:${port}`, `localhost:${port}`]);
      this.port = port;
      return port;
    },
    async close() {
      if (handler) await handler.closeAll().catch(() => {});
      httpServer.closeAllConnections?.();
      await new Promise((r) => httpServer.close(r));
      await gateway.shutdown().catch(() => {});
    },
  };
}

const connect = async (port, token) => {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "measure-pool-under-load", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport, close: () => client.close().catch(() => {}) };
};

// --- operator /health sampling ---------------------------------------------------------------------

/**
 * Poll the operator tier of `GET /health`. This is the OPERATOR's own view of occupancy — the
 * counters someone diagnosing a live incident would read — so a refusal correlated against it is
 * correlated against the instrument that will actually be used, not against a private copy of the
 * same numbers.
 *
 * Each sample carries TWO timestamps on the same monotonic clock as the call records: `t`, when the
 * poll was ISSUED, and `tRecv`, when its body was parsed. Only `tRecv` bounds when the counters were
 * actually produced — the handler runs `operatorHealth()` somewhere inside that interval, one
 * loopback round trip and at least one event-loop turn after `t`, on a loop saturated by exactly the
 * burst being measured. Pairing on `t` alone (which an earlier draft did) lets a sample issued at 4ms
 * but READ at 25ms "explain" a refusal that settled at 5ms — the state read backwards, which is
 * precisely what this comment used to claim the code prevented. Pairing therefore requires
 * `tRecv <= outcome`, and the reported `ageMs` is measured from `t` so it stays a LOWER bound on the
 * sample's staleness rather than an optimistic one.
 *
 * Started and stopped AROUND EACH BURST rather than left running for the whole phase: the sampler
 * shares the HTTP server with the calls under measurement, and polling every 20ms through the
 * multi-second drains and teardowns between bursts would add thousands of requests that can only
 * perturb the thing being measured while producing samples no record will ever be paired with.
 * `start()` is idempotent, and every burst's samples accumulate into the one phase-level array.
 */
function createHealthSampler(stack) {
  const samples = [];
  let errors = 0;
  let handle = null;
  const poll = async () => {
    const t = now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), HEALTH_POLL_TIMEOUT_MS);
    try {
      const res = await fetch(`http://127.0.0.1:${stack.port}/health`, {
        headers: { Authorization: `Bearer ${stack.healthToken}` },
        signal: ac.signal,
      });
      if (!res.ok) {
        errors++;
        return;
      }
      const body = await res.json();
      samples.push({ t, tRecv: now(), ...body });
    } catch {
      errors++;
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    samples,
    get errors() {
      return errors;
    },
    start() {
      if (handle) return;
      void poll(); // a baseline sample before the gate opens, so an instantly-refused slot has a predecessor
      handle = setInterval(() => void poll(), HEALTH_INTERVAL_MS);
    },
    stop() {
      if (!handle) return;
      clearInterval(handle);
      handle = null;
    },
  };
}

/**
 * The newest sample whose counters were READ at or before `t`, with its age. Null when the burst
 * refused faster than the first sample could land — reported honestly rather than back-filled from a
 * later sample.
 *
 * `samples` must already be narrowed to THIS burst's window (see `runBurst`). Searching the whole
 * phase array — which an earlier draft did — pairs a fast refusal in round 3 with the last sample of
 * round 2, taken post-drain with `activeCount: 0`, and attaches it to a refusal earned against a full
 * pool. That is not a missing sample reported as missing; it is a wrong sample reported as evidence,
 * and it crosses configurations as readily as rounds.
 */
function sampleAt(samples, t) {
  let best = null;
  for (const s of samples) {
    if (s.tRecv <= t && (!best || s.tRecv > best.tRecv)) best = s;
  }
  if (!best) return null;
  // Age from `t` (poll issue), not `tRecv`: the counters were produced somewhere in [t, tRecv], so the
  // issue time is the only bound that cannot understate how stale the reading is.
  return { ageMs: r2(t - best.t), activeCount: best.activeCount, reservedCount: best.reservedCount, orphanCount: best.orphanCount, unconfirmedCount: best.unconfirmedCount, watchedCount: best.watchedCount, maxSessions: best.maxSessions, status: best.status };
}

// --- burst mechanics ------------------------------------------------------------------------------

/** Contiguous BLOCK assignment of burst slots to consumers, not round-robin — see the D description
 *  in the header. Round-robin hands the first `maxSessions` slots to distinct consumers, the global
 *  ceiling fills, and every later slot is refused by the GLOBAL rule before the per-consumer rule is
 *  ever consulted (the two checks are ordered, global first). Blocks guarantee at least one consumer
 *  holds more slots than its cap, so both rules are reachable in a single burst. */
function assignConsumers(concurrency, consumerCount) {
  const block = Math.ceil(concurrency / consumerCount);
  return Array.from({ length: concurrency }, (_, i) => Math.min(consumerCount - 1, Math.floor(i / block)));
}

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const allRecords = [];
/**
 * One row per burst, carrying the peak occupancy the OPERATOR /health sampler saw WHILE that burst
 * was in flight.
 *
 * This exists because the per-call `poolAtOutcome` snapshot cannot answer "how many sessions were
 * live at once", and a first draft of this script silently got that wrong: `withSession` releases a
 * retrieve's session inside its own `finally`, BEFORE the tool result reaches the harness, so every
 * successful retrieve reads `activeCount: 0` at outcome. Deriving concurrency from those snapshots
 * made a run in which /health had plainly recorded two simultaneous retrieve sessions report
 * "no burst ever held more than perConsumerMax concurrent sessions — INDETERMINATE". The sampler is
 * the only instrument that observes the pool DURING the window rather than after it, which is
 * precisely why #122 asks for it.
 */
const burstSummaries = [];

/**
 * Issue `slots.length` calls SIMULTANEOUSLY and record each one.
 *
 * The release gate is the whole point: every task is constructed first and parked on one promise, so
 * the cost of building N promises (and, for the MCP paths, of N transports serializing their first
 * write) is spent BEFORE any call enters the admission gate. Without it the first slot would be
 * admitted, launch, and often complete before the last slot was even issued — which is a serial
 * queue wearing a burst's clothes, and it would report a pool that never refuses.
 */
async function runBurst({ config, phase, round, stack, slots, invoke, health }) {
  // Burst window start, on the same monotonic clock as every sample. A sample belongs to THIS burst
  // iff its poll was ISSUED at or after this instant.
  //
  // Windowing by TIMESTAMP rather than by array position (`samples.slice(sampleFrom)`, which an
  // earlier draft used) matters because the sampler is asynchronous: `health.stop()` clears the
  // interval but cannot cancel a `poll()` already awaiting `res.json()`, and that poll still pushes.
  // The push lands after this burst's slice was taken and before the next burst reads its own start
  // index, so a sample carrying the PREVIOUS burst's occupancy silently inflates the NEXT burst's
  // peak — and `maxOccupancyDuringBurst` is the sole input to the retrieve-uncapped verdict, so an
  // inflated value flips a correct INDETERMINATE into a fabricated CONFIRMED. A `t >= windowStart`
  // predicate drops that straggler from both windows instead.
  //
  // Captured BEFORE `health.start()` so the deliberate pre-gate baseline poll (the predecessor an
  // instantly-refused slot needs) is inside the window; the gate-release instant is captured
  // separately below, because call offsets must be measured from the release, not from here.
  const windowStart = now();
  health.start();
  const gate = deferred();
  let settled = 0;
  const tasks = slots.map((slot, position) =>
    (async () => {
      await gate.promise;
      const t0 = now();
      let thrown = null;
      let toolResult = null;
      try {
        toolResult = await invoke(slot);
      } catch (err) {
        thrown = err;
      }
      const t1 = now();
      const settleRank = ++settled;
      // Read in-process the instant the call settles. Labelled `poolAtOutcome` and NOT presented as
      // the gate's own reading: the gate evaluated its counters microseconds earlier, inside
      // `acquire`. It is the tightest correlation available without instrumenting production code,
      // which this ticket forbids.
      const pool = buildOperatorHealth(stack.gateway.sessions);
      const outcome = classifyOutcome({ thrown, toolResult });
      return { slot, position, t0, t1, settleRank, outcome, pool, toolResult };
    })(),
  );
  const burstStart = now();
  gate.resolve();
  const settledAll = await Promise.all(tasks); // every task catches internally, so this cannot reject
  health.stop();

  // Narrowed ONCE, here, and used for both the per-record pairing and the burst peak, so the two can
  // never disagree about which samples belong to this burst.
  const burstSamples = health.samples.filter((s) => s.t >= windowStart);

  const records = settledAll.map((s) => ({
    phase,
    config,
    round,
    position: s.position,
    settleRank: s.settleRank,
    consumerId: s.slot.consumerId ?? null,
    outcome: s.outcome.outcome,
    class: s.outcome.class,
    message: s.outcome.message,
    code: s.outcome.code,
    cause: s.outcome.cause,
    // What the PATH is expected to carry vs what actually arrived, kept as two fields. The old single
    // `codeAvailable: config === "S"` asserted the model instead of recording the observation, so a
    // typed code that unexpectedly survived the MCP boundary would still have printed as
    // "[code/cause DISCARDED]" — the harness contradicting its own evidence.
    codeExpected: config === "S",
    codeSurvived: s.outcome.code !== null || s.outcome.cause !== null,
    durationMs: r2(s.t1 - s.t0),
    startOffsetMs: r2(s.t0 - burstStart),
    endOffsetMs: r2(s.t1 - burstStart),
    poolAtOutcome: s.pool,
    healthSample: sampleAt(burstSamples, s.t1),
  }));
  for (const rec of records) allRecords.push(rec);

  // Occupancy readings with NO live orphan present. A wedged/failed launch's orphan counts toward
  // `activeCount` (session-manager: `#sessions.size + #orphans.size`), so a burst that produced one
  // could satisfy the "more concurrent sessions than perConsumerMax" discriminator without ever having
  // held two concurrent retrieve sessions. The verdict reads this field; the unfiltered peaks stay in
  // the record so the difference is visible rather than quietly applied.
  const cleanSamples = burstSamples.filter((s) => s.orphanCount === 0);
  const peak = (arr, f) => (arr.length ? Math.max(...arr.map(f)) : null);
  burstSummaries.push({
    phase,
    config,
    round,
    calls: records.length,
    samples: burstSamples.length,
    cleanSamples: cleanSamples.length,
    // From /health, DURING the burst — the only reading that can see a session that was opened and
    // released inside a single verb call.
    maxActiveDuringBurst: peak(burstSamples, (s) => s.activeCount),
    maxOccupancyDuringBurst: peak(burstSamples, (s) => s.activeCount + s.reservedCount),
    maxCleanOccupancyDuringBurst: peak(cleanSamples, (s) => s.activeCount + s.reservedCount),
    // From the in-process snapshot at each call's outcome — exact in time, but blind to anything the
    // call already released.
    maxActiveAtOutcome: peak(records, (r) => r.poolAtOutcome.activeCount),
    maxOccupancyAtOutcome: peak(records, (r) => r.poolAtOutcome.activeCount + r.poolAtOutcome.reservedCount),
    // Harness-side issue skew: how far apart the calls entered `invoke` after the gate opened. See the
    // instrument check that reads it for exactly what it does and does not prove.
    maxStartOffsetMs: peak(records, (r) => r.startOffsetMs ?? 0),
  });
  return { records, settledAll };
}

/**
 * Wait until the pool is genuinely empty. A configuration that starts while the previous one still
 * holds sessions measures a pool that was never at rest, and its refusals cannot be attributed to its
 * own burst — so a drain that does not complete is an INSTRUMENT failure, not a finding.
 *
 * ONE MANUAL RE-SWEEP before giving up, because the idle reaper is deliberately not running here (see
 * `buildStack`) and its absence has a sharp edge: a failed or wedged launch enqueues an orphan and
 * kicks exactly ONE sweep, and when that sweep cannot confirm the reclaim the record stays counted in
 * `activeCount` with the code's own comment saying "let the next reaper tick retry". With no reaper
 * there is no next tick, so the very outcome this ticket is hunting — a launch that fails under
 * contention — would convert itself into a 60s spin, a drain failure, a skipped remainder, and
 * `NO CONCLUSION IS LICENSED`. `reapIdle` is called with effectively infinite ttl and in-flight
 * bounds so it reaps NOTHING live (no session is touched, nothing being measured is mutated) and does
 * only the two things needed here: drain the unconfirmed set and retry the orphan dir sweep.
 *
 * A pool that drains only after that sweep is reported as a FINDING about orphan reclaim, not as a
 * polluted pool: the next round genuinely starts from zero, so the measurement downstream is sound.
 */
async function waitForDrain(stack, label) {
  let deadline = now() + DRAIN_TIMEOUT_MS;
  let swept = false;
  for (;;) {
    const h = buildOperatorHealth(stack.gateway.sessions);
    if (h.activeCount === 0 && h.reservedCount === 0) {
      if (swept) note(`pool after ${label} drained only after an explicit orphan re-sweep (reapIdle) — an unconfirmable orphan held a capacity slot with no reaper tick to retry it. FINDING about orphan reclaim, not a polluted pool: the next round did start from zero.`);
      return true;
    }
    if (now() > deadline) {
      if (!swept) {
        swept = true;
        // Retry the sweep once. `reapIdle` awaits `#drainUnconfirmed()` and every per-record
        // `#sweepOrphan`, so a confirmable reclaim has already happened by the time it resolves; the
        // deadline is extended anyway because a kill-confirm can legitimately take another poll or two,
        // and re-entering the loop with an ALREADY-EXPIRED deadline would fail on the very next pass
        // and make the sweep decorative.
        await stack.gateway.sessions.reapIdle(Number.MAX_SAFE_INTEGER, Date.now(), Number.MAX_SAFE_INTEGER).catch(() => {});
        deadline = now() + DRAIN_TIMEOUT_MS;
        continue;
      }
      fail(`pool did not drain after ${label} within ${DRAIN_TIMEOUT_MS}ms, even after an explicit orphan re-sweep (activeCount=${h.activeCount} reservedCount=${h.reservedCount} orphanCount=${h.orphanCount} unconfirmedCount=${h.unconfirmedCount}) — every later configuration in this phase would have measured a polluted pool`);
      return false;
    }
    await new Promise((r) => setTimeout(r, DRAIN_POLL_MS));
  }
}

// --- the three configurations ----------------------------------------------------------------------

/** R — retrieve fan-out. Every slot is a SEPARATE MCP connection authenticating as the SAME
 *  consumer: separate connections because that is the shape a consumer fleet presents (and it rules
 *  out any per-connection serialization inside one transport silently flattening the burst), the
 *  same consumer because that is what makes "retrieve is per-consumer uncapped" measurable rather
 *  than merely asserted. */
async function runConfigR({ stack, phase, rounds, concurrency, fixtureUrl, health }) {
  const consumer = stack.specs[0];
  const clients = [];
  try {
    for (let i = 0; i < concurrency; i++) clients.push(await connect(stack.port, consumer.token));
    for (let round = 1; round <= rounds; round++) {
      const slots = clients.map((c) => ({ conn: c, consumerId: consumer.id }));
      await runBurst({
        config: "R",
        phase,
        round,
        stack,
        slots,
        health,
        invoke: (slot) => slot.conn.client.callTool({ name: "retrieve", arguments: { url: fixtureUrl } }, undefined, { timeout: CALL_TIMEOUT_MS }),
      });
      // retrieve releases its session inside `withSession`'s finally before the tool returns, so this
      // should already be true; it is asserted anyway because a retrieve that leaked a session would
      // otherwise show up as an unexplained refusal in the NEXT round rather than as the leak it is.
      if (!(await waitForDrain(stack, `${phase}/R round ${round}`))) return;
    }
  } finally {
    for (const c of clients) await c.close();
  }
}

/** D — drive-open fan-out. One MCP connection per slot (each carries its own drive controller, which
 *  is what makes N concurrent opens possible at all), slots assigned to consumers in contiguous
 *  blocks so both admission rules are reachable. */
async function runConfigD({ stack, phase, rounds, concurrency, health }) {
  const assignment = assignConsumers(concurrency, stack.specs.length);
  const clients = [];
  try {
    for (let i = 0; i < concurrency; i++) clients.push(await connect(stack.port, stack.specs[assignment[i]].token));
    for (let round = 1; round <= rounds; round++) {
      const slots = clients.map((c, i) => ({ conn: c, consumerId: stack.specs[assignment[i]].id }));
      const { records } = await runBurst({
        config: "D",
        phase,
        round,
        stack,
        slots,
        health,
        invoke: (slot) => slot.conn.client.callTool({ name: "browser_open", arguments: {} }, undefined, { timeout: CALL_TIMEOUT_MS }),
      });
      // A drive session is HELD until closed — unlike retrieve — so every slot that opened one must
      // give it back before the next round, or round 2 would burst against an already-full pool and
      // report refusals earned by round 1.
      const opened = records.filter((r) => r.outcome === "ok");
      for (const rec of opened) {
        await clients[rec.position].client
          .callTool({ name: "browser_close", arguments: {} }, undefined, { timeout: CALL_TIMEOUT_MS })
          .catch(() => {});
      }
      if (!(await waitForDrain(stack, `${phase}/D round ${round}`))) return;
    }
  } finally {
    for (const c of clients) await c.close();
  }
}

/** S — direct `SessionManager.acquire()`, in-process, NO meta (mirroring retrieve's admission path).
 *  The only configuration where `err.code` and `err.cause` survive, and therefore the only source of
 *  raise-site attribution. Its wall-clock is the LAUNCH itself — not launch + navigate + render —
 *  which is why the launch-latency answer is quoted from here. */
async function runConfigS({ stack, phase, rounds, concurrency, health }) {
  for (let round = 1; round <= rounds; round++) {
    const slots = Array.from({ length: concurrency }, () => ({ consumerId: null }));
    const { settledAll } = await runBurst({
      config: "S",
      phase,
      round,
      stack,
      slots,
      health,
      invoke: async () => {
        const session = await stack.gateway.sessions.acquire();
        return { session };
      },
    });
    // Release only AFTER the whole burst has settled: holding every winner for the duration of the
    // burst is what makes the losers hit a genuinely occupied pool, exactly as a held drive session
    // or an in-flight retrieve would. Releasing eagerly would hand freed slots back mid-burst and
    // under-report refusals.
    for (const s of settledAll) {
      const session = s.toolResult?.session;
      if (session) await stack.gateway.sessions.release(session.id).catch(() => {});
    }
    if (!(await waitForDrain(stack, `${phase}/S round ${round}`))) return;
  }
}

// --- phase driver -----------------------------------------------------------------------------------

const stacks = new Set();

async function runPhase({ name, maxSessions, concurrency, rounds, hostsOk }) {
  console.log("");
  console.log(`--- phase ${name} : maxSessions=${maxSessions} perConsumerMax=${PER_CONSUMER_MAX} concurrency=${concurrency} rounds=${rounds} configs=${CONFIGS.join(",")} ---`);
  const stack = buildStack({
    maxSessions,
    // The fallback path (no writable /etc/hosts) is the only case that weakens the policy engine, and
    // it is reported loudly at the top of the run — the loopback fixture is otherwise unreachable
    // because the egress filter blocks 127.0.0.0/8 as anti-SSRF.
    egressOverride: hostsOk ? undefined : () => false,
    fixtureHostForAllowlist: hostsOk ? FIXTURE_HOST : "127.0.0.1",
  });
  stacks.add(stack);
  await stack.listen();
  const fixtureUrl = hostsOk ? `http://${FIXTURE_HOST}:${fixturePort}${FIXTURE_PATH}` : `http://127.0.0.1:${fixturePort}${FIXTURE_PATH}`;
  const health = createHealthSampler(stack);
  try {
    for (const config of CONFIGS) {
      if (config === "R") await runConfigR({ stack, phase: name, rounds, concurrency, fixtureUrl, health });
      if (config === "D") await runConfigD({ stack, phase: name, rounds, concurrency, health });
      if (config === "S") await runConfigS({ stack, phase: name, rounds, concurrency, health });
    }
  } finally {
    health.stop();
    stacks.delete(stack);
    await stack.close().catch((err) => fail(`teardown error in phase ${name}: ${err instanceof Error ? err.message : String(err)}`));
  }
  return { samples: health.samples, sampleErrors: health.errors, maxSessions, concurrency, rounds };
}

// --- lifecycle: fixture, hosts mapping, cleanup, signals ----------------------------------------------

const fixtureServer = createServer((req, res) => {
  if ((req.url ?? "").split("?")[0] === FIXTURE_PATH) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(FIXTURE_HTML);
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

let fixturePort = 0;
const hostsState = ensureHostsEntry();

/**
 * Everything the normal path tears down, extracted so the SIGNAL path runs the identical routine.
 *
 * SCOPE, stated because "kill every spawned process, remove every temp dir" is a standing rule here
 * and its absence should read as deliberate rather than forgotten: this harness spawns no child
 * process of its own and creates no temp dir of its own. Every browser is spawned by the
 * SessionManager and reclaimed by `gateway.shutdown()` (graceful close → group SIGKILL → generation
 * confirm), and every profile dir is minted and swept by the same manager. So the complete list of
 * things to reclaim is: the stacks (each of which owns a gateway) and the two loopback servers.
 * A leaked headful Chrome wedges the next run, which is why `shutdown()` runs for EVERY stack still
 * standing, not only the current one.
 * MEMOIZED rather than flagged: a Ctrl-C during an awaited burst runs this from the handler while
 * the main body is still suspended, and the main body then reaches its own `finally` — a
 * `cleanedUp = true` set at entry would let the second caller return INSTANTLY while the first is
 * still inside a browser close, and the main body would then race ahead to `process.exit` mid-
 * teardown. Handing every caller the same promise makes the second caller AWAIT the in-flight
 * teardown instead of racing it, and the work still runs exactly once.
 */
let cleanupPromise = null;
const cleanup = () => (cleanupPromise ??= runCleanup());
async function runCleanup() {
  for (const stack of [...stacks]) {
    stacks.delete(stack);
    await stack.close().catch(() => {});
  }
  fixtureServer.closeAllConnections?.();
  await new Promise((r) => fixtureServer.close(r));
}

/** How long the signal path waits for `cleanup()` before re-raising anyway. Bounded because a wedged
 *  browser close must not turn Ctrl-C into a hang; /etc/hosts is already restored by then, so the
 *  worst case of giving up is a leaked Chrome inside a disposable container, not a modified host. */
const SIGNAL_CLEANUP_TIMEOUT_MS = 15_000;
for (const sig of ["SIGINT", "SIGTERM"]) {
  // `once`, not `on`: after the first delivery our listener is gone, so a SECOND Ctrl-C reaches the
  // default disposition immediately — a free escape hatch if cleanup wedges, with the hosts file
  // already restored.
  process.once(sig, () => {
    // Synchronous and FIRST: this is the one piece of teardown that touches state outside the
    // container's lifetime, and it must survive a browser close that never returns.
    restoreHostsEntry(hostsState);
    let raised = false;
    const raise = () => {
      if (raised) return;
      raised = true;
      clearTimeout(watchdog);
      // Re-raise to the DEFAULT disposition so the exit status stays signal-shaped; any surviving
      // listener (the browser driver installs its own) would otherwise swallow the signal and leave
      // the process alive until the loop happens to empty.
      process.removeAllListeners(sig);
      process.kill(process.pid, sig);
    };
    // NOT unref'd: this timer is the only thing that still has to fire if `cleanup()` never settles,
    // and an unref'd watchdog would let the loop empty out from under the await.
    const watchdog = setTimeout(raise, SIGNAL_CLEANUP_TIMEOUT_MS);
    void cleanup().then(raise, raise);
  });
}

// --- run --------------------------------------------------------------------------------------------

const record = {
  startedAt: new Date().toISOString(),
  ticket: 122,
  config: {
    maxSessions: MAX_SESSIONS,
    perConsumerMax: PER_CONSUMER_MAX,
    concurrency: CONCURRENCY,
    rounds: ROUNDS,
    consumers: CONSUMER_COUNT,
    configs: CONFIGS,
    phases: PHASES,
    healthIntervalMs: HEALTH_INTERVAL_MS,
    callTimeoutMs: CALL_TIMEOUT_MS,
    launchDeadlineMs: LAUNCH_DEADLINE_MS,
    selftestSwallow: SWALLOW,
  },
  phases: {},
};

console.log("=== browse-gateway :: pool under load (#122) — MEASUREMENT, not a gate ===");
console.log("  exit 0 = the instrument worked (INCLUDING an unflattering finding); exit 1 = the instrument failed");
if (SWALLOW) {
  console.log("");
  console.log("  ############################################################################");
  console.log("  ##  POOL_LOAD_SELFTEST_SWALLOW=1 — THIS RUN IS NOT A MEASUREMENT.         ##");
  console.log("  ##  Captured errors are DISCARDED at the outcome choke point on purpose.  ##");
  console.log("  ##  The report below MUST go empty. A GREEN REPORT HERE MEANS THE HARNESS ##");
  console.log("  ##  IS BLIND — and every clean result it has printed is worthless.        ##");
  console.log("  ############################################################################");
}

let phaseResults = {};
try {
  fixturePort = await new Promise((resolve) => fixtureServer.listen(0, "127.0.0.1", () => resolve(fixtureServer.address().port)));

  const resolvedTo = hostsState.ok ? await dns.lookup(FIXTURE_HOST).then((a) => a.address, () => null) : null;
  const hostsOk = hostsState.ok && resolvedTo === "127.0.0.1";

  console.log("");
  console.log("--- fixture + policy path ------------------------------------------------------");
  if (hostsOk) {
    console.log(`  fixture: http://${FIXTURE_HOST}:${fixturePort}${FIXTURE_PATH}  (/etc/hosts ${hostsState.added ? "line added" : "line already present"}, resolves to ${resolvedTo})`);
    console.log("  policy : REAL PolicyEngine with the REAL egress filter (the synthetic .example host is not an IP literal, so the pure filter passes it)");
  } else {
    console.log(`  fixture: http://127.0.0.1:${fixturePort}${FIXTURE_PATH}`);
    console.log(`  policy : EGRESS FILTER OVERRIDDEN (test-only hook) — reason: ${hostsState.ok ? `${FIXTURE_HOST} resolved to ${resolvedTo}, not 127.0.0.1` : `/etc/hosts not writable: ${hostsState.error}`}`);
    note("running with the egress filter overridden — the ADMISSION path measured is identical, but the real egress filter was bypassed to reach the loopback fixture. Prefer the in-container run, which can write /etc/hosts.");
  }
  console.log(`  pool   : maxSessions=${MAX_SESSIONS} perConsumerMax=${PER_CONSUMER_MAX} (from BGW_MAX_SESSIONS / BGW_PER_CONSUMER_MAX or the shipped defaults)`);
  console.log(`  burst  : concurrency=${CONCURRENCY} (${r2(CONCURRENCY / MAX_SESSIONS)}x the pool), rounds=${ROUNDS}, consumers=${CONSUMER_COUNT}`);
  console.log(`  bounds : per-call ${CALL_TIMEOUT_MS}ms (= max(LAUNCH_DEADLINE_MS ${LAUNCH_DEADLINE_MS}ms, callBudgetMs ${baseConfig.timeouts.callBudgetMs}ms) + ${CALL_TIMEOUT_MARGIN_MS}ms, so a deadline-blown launch is recorded as CORE_LAUNCH rather than aborted client-side), drain ${DRAIN_TIMEOUT_MS}ms`);

  // FIXTURE PRE-FLIGHT, before a single browser is launched. "The fixture was unreachable" is one of
  // the named instrument failures in this script's exit contract, and it is also the failure most
  // likely to be misread as a finding: an unreachable fixture turns every R call into an error whose
  // message is about retrieval, and a reader skimming the histogram would see a wall of failures
  // under load. Fetching it over the SAME hostname the browser will use also proves the /etc/hosts
  // mapping end-to-end rather than trusting the write. The length check exists because a fixture that
  // 200s with too little text is worse than one that 404s: retrieve classifies a thin extraction as a
  // failure, so the run would look like a pool problem and be perfectly self-consistent.
  {
    const preflightUrl = hostsOk ? `http://${FIXTURE_HOST}:${fixturePort}${FIXTURE_PATH}` : `http://127.0.0.1:${fixturePort}${FIXTURE_PATH}`;
    let body = null;
    let status = null;
    try {
      const res = await fetch(preflightUrl);
      status = res.status;
      body = await res.text();
    } catch (err) {
      throw new InstrumentAbort(`fixture unreachable at ${preflightUrl}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (status !== 200) throw new InstrumentAbort(`fixture returned ${status} at ${preflightUrl} (expected 200)`);
    if (body.length < 400) throw new InstrumentAbort(`fixture body is only ${body.length} bytes — below the extractable-content floor retrieve uses, so every R call would fail for a reason that has nothing to do with the pool`);
    console.log(`  preflt : fixture reachable over the run's own hostname (${status}, ${body.length} bytes)`);
  }

  for (const phase of ALL_PHASES) {
    if (!PHASES.includes(phase)) continue;
    if (phase === "main") phaseResults.main = await runPhase({ name: "main", maxSessions: MAX_SESSIONS, concurrency: CONCURRENCY, rounds: ROUNDS, hostsOk });
    if (phase === "control-1") phaseResults["control-1"] = await runPhase({ name: "control-1", maxSessions: MAX_SESSIONS, concurrency: 1, rounds: 1, hostsOk });
    if (phase === "control-2") phaseResults["control-2"] = await runPhase({ name: "control-2", maxSessions: CONTROL2_MAX_SESSIONS, concurrency: CONTROL2_CONCURRENCY, rounds: 1, hostsOk });
  }
} catch (err) {
  console.error("");
  if (err instanceof InstrumentAbort) {
    // A deliberate stop, not a crash: a stack trace here would read like a harness bug rather than
    // the pre-flight refusing to measure through a broken instrument.
    console.error(`  measurement aborted: ${err.message}`);
    instrumentFailures.push(`aborted: ${err.message}`);
  } else {
    console.error(`  harness error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    instrumentFailures.push(`harness error: ${err instanceof Error ? err.message : String(err)}`);
  }
} finally {
  // The same routine the signal path runs, so the two teardowns cannot drift apart. An exception
  // thrown from a `finally` escapes the try it belongs to and would kill the process BEFORE the
  // report is printed — a teardown fault destroying the measurement it was tearing down — so it is
  // recorded as an instrument failure instead.
  await cleanup().catch((err) => instrumentFailures.push(`teardown error: ${err instanceof Error ? err.message : String(err)}`));
  restoreHostsEntry(hostsState);
}

// --- analysis -----------------------------------------------------------------------------------------

const inPhase = (phase) => allRecords.filter((r) => r.phase === phase);
const byClass = (recs, cls) => recs.filter((r) => r.class === cls);
const refusalsOf = (recs) => recs.filter((r) => r.class === CLASS.GLOBAL_LIMIT || r.class === CLASS.PER_CONSUMER_LIMIT);
/** Every CORE_LAUNCH outcome, from BOTH message shapes — see `CLASS`. Anything that answers the
 *  ticket's headline question counts through here, never through one class alone. */
const launchFailuresOf = (recs) => recs.filter(isLaunchClass);

/**
 * The attribution suffix for one record, printed from what ACTUALLY arrived rather than from which
 * configuration produced it. The distinction is not pedantry: the deadline raise site names itself in
 * its message, so it is attributable on R and D even though `.code`/`.cause` were discarded there, and
 * a suffix keyed only on `config === "S"` would print "[code/cause DISCARDED]" beside a message that
 * is self-identifying — the report contradicting its own evidence.
 */
function attributionOf(r) {
  if (r.codeSurvived) return `  code=${r.code ?? "none"}  cause=${r.cause ? JSON.stringify(`${r.cause.name}: ${clip(r.cause.message, 80)}`) : "none"}`;
  if (r.class === CLASS.LAUNCH_DEADLINE) return "  [no code/cause — but the DEADLINE raise site is named by the message itself]";
  if (r.codeExpected) return "  [no code/cause on an in-process error — unexpected; S is the path where they survive]";
  return "  [code/cause DISCARDED by the MCP boundary]";
}

/** Histogram keyed by (config, class, VERBATIM message, code) — verbatim because the entire dispute
 *  this ticket settles is about which exact string a capacity refusal produces, and a histogram that
 *  normalized messages would erase the evidence. */
function histogram(recs) {
  const map = new Map();
  for (const r of recs) {
    const key = JSON.stringify([r.config, r.class, r.message ?? "", r.code ?? ""]);
    const cur = map.get(key) ?? { config: r.config, class: r.class, message: r.message, code: r.code, count: 0, durations: [] };
    cur.count++;
    if (typeof r.durationMs === "number") cur.durations.push(r.durationMs);
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

console.log("");
console.log("=== OUTCOME HISTOGRAM (by configuration, class, and VERBATIM message) ===========");
for (const phase of ALL_PHASES) {
  const recs = inPhase(phase);
  if (!recs.length) continue;
  console.log(`\n  phase ${phase} (${recs.length} calls)`);
  for (const h of histogram(recs)) {
    const d = summarize(h.durations);
    console.log(`    ${String(h.count).padStart(4)}x  [${h.config}] ${h.class}${h.code ? ` code=${h.code}` : ""}  median=${d ? `${d.median}ms` : "n/a"}`);
    console.log(`           message: ${h.message === null ? "(none — successful call)" : JSON.stringify(clip(h.message))}`);
  }
}

console.log("");
console.log("=== PER-CALL RECORDS (main phase; the JSON record carries every call untruncated) ===");
console.log("  legend: pool(...) = in-process counters read the instant the call settled (exact in time,");
console.log(`          blind to what the call already released); health(...) = newest operator /health sample`);
console.log(`          at or before that instant, with its age (the sampler polls every ${HEALTH_INTERVAL_MS}ms, so a`);
console.log("          sub-10ms refusal often pairs with a pre-burst sample — under-reads, never back-fills)");
{
  const recs = inPhase("main");
  if (!recs.length) console.log("  (main phase not run)");
  const shown = recs.slice(0, MAX_TABLE_ROWS);
  for (const r of shown) {
    const pool = r.poolAtOutcome;
    const hs = r.healthSample;
    console.log(
      `  [${r.config}] round=${r.round} pos=${String(r.position).padStart(2)} rank=${String(r.settleRank).padStart(2)} ${String(r.durationMs).padStart(9)}ms  ${r.class}` +
        `  pool(active=${pool.activeCount} reserved=${pool.reservedCount} orphan=${pool.orphanCount} max=${pool.maxSessions})` +
        `  health(${hs ? `active=${hs.activeCount} reserved=${hs.reservedCount} age=${hs.ageMs}ms` : "no sample precedes this outcome"})`,
    );
    if (r.message !== null) console.log(`         verbatim: ${JSON.stringify(clip(r.message))}${attributionOf(r)}`);
  }
  if (recs.length > shown.length) console.log(`  … ${recs.length - shown.length} more (see POOL_LOAD_OUT for the full set)`);
}

const mainRecs = inPhase("main");
const mainBursts = burstSummaries.filter((b) => b.phase === "main");

// --- controls, self-test, and instrument checks — BEFORE any verdict is printed ------------------------
//
// Ordered this way deliberately. Every verdict section below is gated on `licensed`, and `licensed`
// cannot be computed until the controls have been judged and the instrument checks have run. In the
// previous ordering the verdicts printed first and the judgement printed last, which produced the one
// output a reader must never see: a flattering `NO, that string was produced ZERO times` sitting above
// an `INSTRUMENT FAILED` list — including under the blindness self-test, whose entire purpose is to
// prove the report is worthless. A reader pastes the section, not the file.

console.log("");
console.log("=== NEGATIVE CONTROLS ==========================================================");
const controls = {};
{
  // control-1 — concurrency 1 must produce ZERO refusals AND must reach the browser cleanly.
  if (PHASES.includes("control-1")) {
    const recs = inPhase("control-1");
    const refusals = refusalsOf(recs);
    const launchFails = launchFailuresOf(recs);
    const inBand = byClass(recs, CLASS.RETRIEVE_IN_BAND);
    // The launch-failure leg is not decoration. Without it, a container where EVERY launch fails
    // (no --shm-size, Chrome missing, OOM, Xvfb never started, pids_limit exhausted) sails through the
    // whole harness: control-1 sees one launch failure and zero refusals → pass; control-2's other
    // three slots still get refused by the maxSessions=1 gate → pass; the "reached the browser" check
    // accepts a launch failure as proof the path was exercised → pass; the conclusion is licensed; and
    // the headline prints "YES — launch failures REPRODUCED", i.e. the field report's exact claim,
    // manufactured by a broken environment and published as a measurement. control-1 at concurrency 1
    // against an EMPTY pool is the one phase that structurally cannot be capacity-limited, which makes
    // it the only place this is free to detect.
    const ok = recs.length > 0 && refusals.length === 0 && launchFails.length === 0;
    controls["control-1"] = { ran: true, pass: ok, calls: recs.length, refusals: refusals.length, launchFailures: launchFails.length, inBandFailures: inBand.length };
    const why = refusals.length
      ? `first refusal: ${JSON.stringify(clip(refusals[0].message))}`
      : launchFails.length
        ? `the browser could not launch with the pool EMPTY — no launch failure anywhere in this run can be attributed to over-subscription. First: ${JSON.stringify(clip(launchFails[0].message))}`
        : recs.length
          ? ""
          : "no calls completed";
    check(`control-1: concurrency 1 produced zero refusals and zero launch failures (${recs.length} calls, ${refusals.length} refusals, ${launchFails.length} launch failures)`, ok, why);
    console.log("         NOTE: the zero-refusals leg asserts an ABSENCE, so a totally blind harness also passes");
    console.log("         it. It guards the false-POSITIVE direction only. control-2 is the one that proves sight.");
    if (inBand.length) {
      // Not a fail: a retrieve can legitimately fail in-band for page-shaped reasons. But it happened at
      // concurrency 1 against an empty pool, so it is not contention — and any in-band failure in the
      // main run therefore cannot be attributed to contention either. Say so where it will be read.
      note(`control-1 produced ${inBand.length} in-band retrieve failure(s) at concurrency 1 — the fixture path itself is failing sometimes, so in-band failures in the main run cannot be attributed to contention`);
    }
  } else {
    controls["control-1"] = { ran: false, pass: false };
    console.log("  ~~~~  control-1 NOT RUN (POOL_LOAD_PHASES) — the false-positive direction is unguarded in this invocation");
  }

  // control-2 — a KNOWN refusal on demand. This is the load-bearing control.
  if (PHASES.includes("control-2")) {
    const recs = inPhase("control-2");
    const hits = recs.filter((r) => typeof r.message === "string" && r.message.includes(CONTROL2_LITERAL));
    // PER SELECTED CONFIGURATION, not one hit anywhere. At maxSessions=1 and concurrency 4 EVERY
    // configuration is structurally guaranteed at least 3 refusals (one slot admitted, the rest refused
    // by the global gate, which is consulted before the per-consumer one), so accepting a single total
    // hit is far weaker than the control can be — and the gap is exactly the dangerous one: if the
    // retrieve path stopped surfacing refusals as `isError` text, control-2 would still pass on S and D,
    // R's zero would print as an unactioned line, and the main run's R section would then report
    // "CONFIRMED uncapped" from the ABSENCE of per-consumer refusals on the very path just shown blind.
    const perConfig = CONFIGS.map((c) => [c, hits.filter((h) => h.config === c).length]);
    const blind = perConfig.filter(([, n]) => n === 0).map(([c]) => c);
    const ok = recs.length > 0 && blind.length === 0;
    controls["control-2"] = { ran: true, pass: ok, calls: recs.length, hits: hits.length, perConfig: Object.fromEntries(perConfig), literal: CONTROL2_LITERAL };
    check(
      `control-2: maxSessions=${CONTROL2_MAX_SESSIONS} at concurrency ${CONTROL2_CONCURRENCY} produced the literal ${JSON.stringify(CONTROL2_LITERAL)} on EVERY selected configuration (${hits.length} of ${recs.length} calls)`,
      ok,
      ok ? "" : blind.length ? `configuration(s) [${blind.join(",")}] never carried the literal — that path is NOT shown able to see a refusal, so its absences in the main run mean nothing` : "the harness cannot produce a known refusal on demand, so it is NOT trusted to report their absence",
    );
    for (const [cfg, n] of perConfig) console.log(`         [${cfg}] ${n} call(s) carried the literal${n === 0 ? "   <- BLIND" : ""}`);
    if (hits.length) console.log(`         verbatim evidence: ${JSON.stringify(clip(hits[0].message))}`);
    // Said out loud so nobody reads control-2's numbers as production-shaped: its pool is deliberately
    // below the shipping launcher's own floor (`poolSizingError`: consumers x perConsumerMax + 1), which
    // is fine for manufacturing a refusal on demand and meaningless as a capacity observation.
    console.log(`         SHAPE: maxSessions=${CONTROL2_MAX_SESSIONS} with ${CONSUMER_COUNT} consumers is BELOW the launcher's own pool floor`);
    console.log(`         (${CONSUMER_COUNT} x perConsumerMax ${PER_CONSUMER_MAX} + 1 = ${CONSUMER_COUNT * PER_CONSUMER_MAX + 1}) — a manufactured refusal, never a capacity measurement.`);
  } else {
    controls["control-2"] = { ran: false, pass: false };
    console.log("  ~~~~  control-2 NOT RUN (POOL_LOAD_PHASES) — this invocation has NOT been shown able to see a refusal");
  }
}

// --- the instrument self-test (POOL_LOAD_SELFTEST_SWALLOW) ---------------------------------------------

console.log("");
if (SWALLOW) {
  console.log("=== SELF-TEST OF THE INSTRUMENT (POOL_LOAD_SELFTEST_SWALLOW=1) ==================");
  console.log(`  outcomes swallowed at the capture choke point: ${swallowedCount}`);
  const anyErrors = allRecords.some((r) => r.outcome === "error");
  if (swallowedCount === 0) {
    fail("SELF-TEST BROKEN: the swallow flag was set but the choke point discarded nothing — either no call errored (raise the concurrency) or the swallow is not on the path the records come from. Nothing is proven about the harness's sight.");
  } else if (anyErrors) {
    fail("SELF-TEST BROKEN: errors were swallowed yet the report still contains error records — some outcome bypasses the single choke point, which means the swallow does not blind the whole instrument.");
  } else if (!controls["control-2"].ran) {
    // Without this branch the success message below is reached whenever control-2 merely DID NOT RUN,
    // so `POOL_LOAD_SELFTEST_SWALLOW=1 POOL_LOAD_PHASES=main` printed "control-2 lost its literal — the
    // instrument detects its own blindness" having tested exactly nothing about control-2. The direct
    // question this self-test answers is "can it tell passed from never-ran"; that answer was no.
    fail("SELF-TEST INCONCLUSIVE: control-2 did not run, so the only control that can LOSE its literal under blinding was never exercised. Re-run the self-test with control-2 in POOL_LOAD_PHASES.");
  } else if (controls["control-2"].pass) {
    fail("SELF-TEST BROKEN: control-2 still PASSED while every captured error was discarded. A control that survives blinding is not a control.");
  } else {
    console.log("  EXPECTED RESULT: the report went EMPTY and control-2 lost its literal — the instrument");
    console.log("  detects its own blindness. This confirms that a clean report from a NORMAL run is a");
    console.log("  measured absence rather than an unconditional pass.");
  }
  console.log("  This invocation is a self-test, NOT a measurement: it always exits non-zero.");
  instrumentFailures.push("POOL_LOAD_SELFTEST_SWALLOW=1 — self-test invocation, never a measurement");
}

// --- instrument health checks --------------------------------------------------------------------------

console.log("");
console.log("=== INSTRUMENT CHECKS ==========================================================");
{
  check(`calls completed (${allRecords.length})`, allRecords.length > 0, allRecords.length ? "" : "zero calls completed — nothing was measured");

  const unclassified = allRecords.filter((r) => r.class === CLASS.UNCLASSIFIED);
  check(
    `every outcome has a name (${unclassified.length} unclassified)`,
    unclassified.length === 0,
    unclassified.length ? `e.g. [${unclassified[0].config}] ${JSON.stringify(clip(unclassified[0].message))} — an unnamed outcome is treated as an instrument failure ON PURPOSE: a distribution containing outcomes the harness cannot name is a guess with a histogram around it` : "",
  );

  const samples = Object.values(phaseResults).flatMap((p) => p?.samples ?? []);
  check(`operator /health was sampled (${samples.length} samples)`, samples.length > 0, samples.length ? "" : "the occupancy instrument was never reachable, so no refusal in this report has occupancy beside it");
  if (samples.length) {
    // The sampler must be reading the SAME pool the bursts are driving. If /health reported a
    // different maxSessions than the gateway under test, the counters printed next to every refusal
    // would describe some other pool — a correlation that looks rigorous and means nothing.
    const phaseCaps = Object.entries(phaseResults).map(([name, p]) => [name, p?.maxSessions]);
    const mismatched = Object.entries(phaseResults).filter(([, p]) => (p?.samples ?? []).some((s) => s.maxSessions !== p.maxSessions));
    check(`operator /health reports the pool actually under test (${phaseCaps.map(([n, c]) => `${n}:${c}`).join(" ")})`, mismatched.length === 0, mismatched.length ? `phase ${mismatched[0][0]} sampled a different maxSessions` : "");
  }

  // Burst issue skew — see BURST_ISSUE_SKEW_BUDGET_MS for what this does and does not prove. It is a
  // structural tripwire: an `await` introduced inside the task-building loop by a later edit would turn
  // every burst back into the serial queue the release gate exists to prevent, and every printed "at Nx
  // concurrency" line would then be a lie that nothing else in the harness contradicts.
  const skews = burstSummaries.map((b) => b.maxStartOffsetMs).filter((v) => typeof v === "number");
  if (skews.length) {
    const worst = Math.max(...skews);
    check(
      `bursts were ISSUED simultaneously (worst gate-to-invoke skew ${r2(worst)}ms across ${skews.length} burst(s), budget ${BURST_ISSUE_SKEW_BUDGET_MS}ms)`,
      worst <= BURST_ISSUE_SKEW_BUDGET_MS,
      worst > BURST_ISSUE_SKEW_BUDGET_MS ? "the calls did not enter the admission gate together, so nothing in this report measured an over-subscribed pool" : "",
    );
    console.log("         SCOPE: this proves the HARNESS issued them together (t0 is taken before `invoke`).");
    console.log("         It cannot prove they overlapped INSIDE the gateway — that evidence is the occupancy");
    console.log("         peak and the refusals themselves, both reported below.");
  }

  if (!SWALLOW) {
    for (const phase of ALL_PHASES) {
      const recs = inPhase(phase);
      if (!recs.length) continue;
      for (const cfg of CONFIGS) {
        const cfgRecs = recs.filter((r) => r.config === cfg);
        if (!cfgRecs.length) continue;
        const successes = cfgRecs.filter((r) => r.outcome === "ok").length;
        const launchFails = launchFailuresOf(cfgRecs).length;
        // Every phase has at least one free slot, so at least one call must get PAST the gate and
        // reach the browser — either completing (ok) or failing in the launch itself, which is a
        // finding and still proves the path was exercised. Zero of both means the browser path never
        // worked at all, and every refusal recorded would be an artifact of a broken run rather than
        // of the cap: a full histogram of capacity refusals earned by an instrument that could not
        // have admitted anything anyway. (Accepting a launch failure as proof-of-path is only safe
        // because control-1 now independently refuses a run whose launches fail with an empty pool.)
        check(`[${phase}/${cfg}] at least one call reached the browser (${successes} ok, ${launchFails} launch failure(s), of ${cfgRecs.length})`, successes > 0 || launchFails > 0, successes === 0 && launchFails === 0 ? "no call ever got past the gate — treat every refusal in this phase as unexplained" : "");
      }
    }
  }
}

// --- is anything below this line quotable? --------------------------------------------------------------

const controlsRan = controls["control-1"]?.ran && controls["control-2"]?.ran;
const controlsPassed = controls["control-1"]?.pass && controls["control-2"]?.pass;
/** A narrowed run measures less than the harness claims to measure. Narrowing CONFIGS is the sharp
 *  case: it does not drop a control, so an earlier version happily licensed a full conclusion from
 *  `POOL_LOAD_CONFIGS=D` — printing "launch failures under pure over-subscription: NONE observed" and
 *  "0 refused by the per-consumer cap" from a run where S, the only configuration with raise-site
 *  attribution and the only one whose wall-clock the report calls THE number for the deadline ticket,
 *  never executed. `partial` therefore gates the licence, not just a footnote inside it. */
const partial = PHASES.length !== ALL_PHASES.length || CONFIGS.length !== ALL_CONFIGS.length;
const licensed = !SWALLOW && !partial && controlsRan && controlsPassed && instrumentFailures.length === 0 && inPhase("main").length > 0;
const unlicensedReasons = [];
if (SWALLOW) unlicensedReasons.push("it is the blindness SELF-TEST, not a measurement");
if (!controlsRan) unlicensedReasons.push(`a negative control did not run (phases=${PHASES.join(",")}). An unvalidated instrument's null result is not a null result.`);
else if (!controlsPassed) unlicensedReasons.push("a negative control did not behave. If the harness cannot produce a known refusal on demand it is not trusted to report their absence.");
if (partial) unlicensedReasons.push(`PARTIAL RUN (phases=${PHASES.join(",")} configs=${CONFIGS.join(",")}) — the licensed measurement is the default full run`);
if (instrumentFailures.length) unlicensedReasons.push(`${instrumentFailures.length} instrument failure(s), listed at the end`);
if (!inPhase("main").length) unlicensedReasons.push("the main phase did not run, so nothing was measured under over-subscription");

console.log("");
if (licensed) {
  console.log("=== THE INSTRUMENT VALIDATED ITSELF — the sections below are quotable ============");
} else {
  console.log("=== UNLICENSED — NOTHING BELOW THIS LINE IS AN ANSWER ===========================");
  for (const r of unlicensedReasons) console.log(`    - ${r}`);
  console.log("  The numbers still print, because seeing them is how you debug the instrument. They are");
  console.log("  NOT the measurement, and no line below may be quoted as one.");
}

console.log("");
console.log("=== LAUNCH LATENCY UNDER CONTENTION ============================================");
console.log("  Three DIFFERENT quantities, labelled so they are not averaged together by a reader:");
const okDurations = (config) => mainRecs.filter((r) => r.config === config && r.outcome === "ok").map((r) => r.durationMs);
const distS = summarize(okDurations("S"));
const distD = summarize(okDurations("D"));
const distR = summarize(okDurations("R"));
console.log(renderDist("S  LAUNCH ONLY (SessionManager.acquire wall-clock — THE number for the deadline ticket)", distS));
console.log(renderDist("D  open verb over MCP (launch + guard install + transport)", distD));
console.log(renderDist("R  whole retrieve verb (launch + navigate + render + extract) — NOT launch latency", distR));
// Refusal latency is reported PER CONFIGURATION for the same reason the success distributions are:
// an S refusal is a synchronous throw out of `acquire` (microseconds), while an R/D refusal is a full
// JSON-RPC-over-HTTP round trip on an event loop saturated by the burst (milliseconds). Pooled, the
// median is an artifact of the R:D:S record ratio rather than a property of the gate — and pooling them
// one line under a banner insisting these quantities must not be averaged is worse than not measuring.
const refusalDists = Object.fromEntries(CONFIGS.map((c) => [c, summarize(refusalsOf(mainRecs).filter((r) => r.config === c).map((r) => r.durationMs))]));
for (const c of CONFIGS) {
  const what = c === "S" ? "in-process gate only" : "gate + full MCP-over-HTTP round trip";
  console.log(renderDist(`refusal latency [${c}] (${what})`, refusalDists[c]));
}

console.log("");
console.log("=== DOES THE CEILING HOLD? =====================================================");
{
  const maxOf = (key) => {
    const vals = mainBursts.map((b) => b[key]).filter((v) => typeof v === "number");
    return vals.length ? Math.max(...vals) : null;
  };
  const maxActiveDuring = maxOf("maxActiveDuringBurst");
  const maxActiveAtOutcome = maxOf("maxActiveAtOutcome");
  const maxOccupancyAtOutcome = maxOf("maxOccupancyAtOutcome");
  const maxOccupancyDuring = maxOf("maxOccupancyDuringBurst");
  const maxCleanOccupancyDuring = maxOf("maxCleanOccupancyDuringBurst");
  const totalSamples = Object.values(phaseResults).reduce((a, p) => a + (p?.samples?.length ?? 0), 0);
  const failedPolls = Object.values(phaseResults).reduce((a, p) => a + (p?.sampleErrors ?? 0), 0);
  console.log(`  maxSessions under test (main phase)               : ${MAX_SESSIONS}`);
  console.log(`  max activeCount on operator /health DURING a burst: ${maxActiveDuring ?? "n/a"}  (${totalSamples} samples across the run, ${failedPolls} failed polls)`);
  console.log(`  max (active + reserved) on /health during a burst : ${maxOccupancyDuring ?? "n/a"}  — this is the quantity the gate actually tests`);
  console.log(`  ... of which ORPHAN-FREE observations only        : ${maxCleanOccupancyDuring ?? "n/a"}  — activeCount counts live orphans too`);
  console.log(`  max activeCount in-process at a call's outcome    : ${maxActiveAtOutcome ?? "n/a"}  (blind to a session the call already released — see below)`);
  console.log(`  max (active + reserved) in-process at an outcome  : ${maxOccupancyAtOutcome ?? "n/a"}`);
  console.log("");
  console.log("  RESOLUTION LIMIT of these two instruments, stated so neither is over-read:");
  console.log(`    - the /health sampler polls every ${HEALTH_INTERVAL_MS}ms, so a refusal that lands in single-digit`);
  console.log("      milliseconds is routinely paired with a sample taken BEFORE the burst reserved anything.");
  console.log("      Such a pairing under-reads occupancy; it is never back-filled from a later sample,");
  console.log("      because a sample taken after a winner released would 'explain' a refusal backwards.");
  console.log("      Pairing requires the sample's RESPONSE to have been parsed before the outcome, not");
  console.log("      merely its request to have been issued — the counters are produced somewhere in that");
  console.log("      interval, on a loop the burst itself is saturating.");
  console.log("    - the in-process at-outcome snapshot is exact in time but blind to what the call already");
  console.log("      gave back: `withSession` releases a retrieve's session before the tool result returns,");
  console.log("      so a successful retrieve reads activeCount 0 at its own outcome.");
  console.log("    - activeCount is `#sessions.size + #orphans.size`, so a wedged launch's live orphan raises");
  console.log("      it without a second browser ever having been driveable. The orphan-free line above is");
  console.log("      the one any concurrency verdict is read from.");
  console.log("    Neither is wrong; they answer different questions, and the report uses each for the one");
  console.log("    it can answer.");
  if (maxActiveDuring !== null && maxActiveDuring > MAX_SESSIONS) {
    console.log(`  FINDING: live sessions EXCEEDED maxSessions (${maxActiveDuring} > ${MAX_SESSIONS}). SessionManager documents this as possible transiently (a replacement taking a freed slot before a late orphan surfaces); it is REPORTED, not repaired (#122 forbids a fix).`);
  } else if (maxActiveDuring !== null) {
    console.log("  The ceiling HELD: live sessions never exceeded maxSessions in any observation.");
  }
  // A refusal that fires while the pool has room would be the interesting anomaly — it would mean the
  // gate refused on something other than occupancy. Counted rather than assumed away.
  const unexplained = refusalsOf(mainRecs).filter((r) => r.class === CLASS.GLOBAL_LIMIT && r.poolAtOutcome.activeCount + r.poolAtOutcome.reservedCount < MAX_SESSIONS);
  console.log(`  global refusals whose observed occupancy was BELOW the cap: ${unexplained.length} of ${byClass(mainRecs, CLASS.GLOBAL_LIMIT).length}` + (unexplained.length ? "  <- occupancy is read after the call settles, so a winner releasing first can explain this; inspect the JSON record" : ""));
}

console.log("");
console.log("=== IS A CORE_LAUNCH FAILURE EVER PRODUCED BY PURE OVER-SUBSCRIPTION? ===========");
{
  // BOTH strings, because CORE_LAUNCH has two of them and the field report only ever quoted one. A
  // section that answers "was `browser core failed to launch` produced?" with NO while a deadline-blown
  // launch sits unnamed in the same run is not a null result, it is a mis-filed positive.
  const launchFailures = launchFailuresOf(mainRecs);
  const byFailureSite = byClass(mainRecs, CLASS.LAUNCH_FAILURE);
  const byDeadline = byClass(mainRecs, CLASS.LAUNCH_DEADLINE);
  const control1Clean = controls["control-1"]?.ran && controls["control-1"]?.launchFailures === 0;
  console.log("  The two strings CORE_LAUNCH is raised with, counted separately:");
  console.log(`    "browser core failed to launch"               : ${byFailureSite.length}  (factory throw OR launch rejection)`);
  console.log(`    "browser core launch exceeded <N>ms deadline" : ${byDeadline.length}  (the launch blew LAUNCH_DEADLINE_MS)`);
  console.log("");
  if (!mainRecs.length) {
    console.log("  main phase not run — no answer from this invocation.");
  } else if (!licensed) {
    console.log("  NO ANSWER FROM THIS INVOCATION — the instrument did not license a conclusion (see above).");
    console.log("  The counts printed above are debugging output, not a result. In particular a ZERO here");
    console.log("  under the blindness self-test is exactly what a blind harness produces.");
  } else if (launchFailures.length === 0) {
    console.log(`  NO. Across ${mainRecs.length} calls at ${CONCURRENCY}x concurrency against a ${MAX_SESSIONS}-slot pool, NEITHER`);
    console.log("  CORE_LAUNCH string was produced. Over-subscription produced capacity refusals with a");
    console.log("  DIFFERENT, actionable message (see the histogram).");
    console.log("");
    console.log("  VALIDITY LIMIT — read this before quoting the line above:");
    console.log("  The fixture path excludes proxy-connect and remote-target render cost, both of which sit");
    console.log("  inside the production launch/first-nav window. A null result therefore bounds the claim to");
    console.log("  \"not reproducible without proxy and remote cost\", NOT \"does not occur\".");
  } else {
    console.log(`  YES — ${launchFailures.length} of ${mainRecs.length} calls produced a CORE_LAUNCH failure. This is a FINDING, and it exits 0.`);
    if (!control1Clean) {
      // Belt and braces: control-1 failing already makes the run unlicensed, so this branch is only
      // reachable when control-1 did not run. Say WHY the YES is not attributable rather than letting a
      // reader assume the contention caused it.
      console.log("  CAUTION: control-1 did not establish that the browser launches cleanly with an EMPTY pool,");
      console.log("  so these failures are NOT attributable to over-subscription — a broken container produces");
      console.log("  the identical output.");
    }
    for (const r of launchFailures.slice(0, MAX_TABLE_ROWS)) {
      console.log(`    [${r.config}] round=${r.round} pos=${r.position} ${r.durationMs}ms  ${r.class}  ${JSON.stringify(clip(r.message))}`);
      console.log(`        ${attributionOf(r).trim()}`);
    }
  }
}

console.log("");
console.log("=== ATTRIBUTION: WHICH CORE_LAUNCH RAISE SITE? =================================");
{
  const sErrors = mainRecs.filter((r) => r.config === "S" && r.outcome === "error");
  const mcpErrors = mainRecs.filter((r) => r.config !== "S" && r.outcome === "error");
  console.log("  The three raise sites do NOT split the way an earlier draft of this report claimed:");
  console.log("    - the DEADLINE site carries its own name in its message, so it is attributable on EVERY");
  console.log("      configuration — including R and D, where .code/.cause are discarded;");
  console.log("    - the FACTORY-THROW and LAUNCH-REJECTION sites share one byte-identical string and are");
  console.log("      separable only by .cause, i.e. only on the in-process S path.");
  console.log("");
  console.log(`  S errors carrying a typed code: ${sErrors.filter((r) => r.code).length} of ${sErrors.length}`);
  const codes = new Map();
  for (const r of sErrors) codes.set(r.code ?? "(none)", (codes.get(r.code ?? "(none)") ?? 0) + 1);
  for (const [code, n] of codes) console.log(`    ${n}x code=${code}`);
  const withCause = sErrors.filter((r) => r.cause);
  console.log(`  S errors carrying a .cause (the factory-throw / rejection discriminator): ${withCause.length}`);
  for (const r of withCause.slice(0, 8)) console.log(`    cause: ${JSON.stringify(`${r.cause.name}: ${clip(r.cause.message, 120)}`)}`);
  // COUNTED, not asserted. The old line printed a hardcoded `0` beside a real denominator, which is the
  // exact shape this project keeps getting bitten by: an empirical claim written as a literal. The value
  // is expected to be 0 (R/D refusals arrive as isError tool RESULTS, never as throws carrying a typed
  // error), so a non-zero here is a genuine contradiction of the model the S configuration exists to
  // work around — and worth shouting about rather than silently printing.
  const mcpWithAttribution = mcpErrors.filter((r) => r.codeSurvived);
  console.log(`  R/D errors carrying a code or cause: ${mcpWithAttribution.length} of ${mcpErrors.length}`);
  if (mcpWithAttribution.length === 0) {
    console.log("    As modelled: GatewayDriveController re-wraps every open error into a plain Error and the");
    console.log("    retrieve closure does the same, so .code and .cause never cross the MCP boundary.");
  } else {
    console.log("    UNEXPECTED — the model says these cannot survive the MCP boundary. Either the re-wrap in");
    console.log("    src/mcp/drive-controller.ts changed or this harness is reading something it should not.");
    console.log(`    e.g. ${JSON.stringify(clip(mcpWithAttribution[0].message))} code=${mcpWithAttribution[0].code ?? "none"}`);
  }
  const ambiguous = byClass(mainRecs, CLASS.LAUNCH_FAILURE);
  const ambiguousOnMcp = ambiguous.filter((r) => r.config !== "S");
  if (ambiguousOnMcp.length) {
    console.log(`  ${ambiguousOnMcp.length} "browser core failed to launch" outcome(s) on an MCP path: factory-throw vs`);
    console.log("  launch-rejection is NOT separable for those. That gap belongs to the classify ticket, and");
    console.log("  this report hands it over rather than guessing.");
  }
  if (byClass(mainRecs, CLASS.LAUNCH_DEADLINE).length) {
    console.log(`  ${byClass(mainRecs, CLASS.LAUNCH_DEADLINE).length} deadline-blown launch(es): fully attributed by message on every configuration.`);
  }
}

console.log("");
console.log("=== IS retrieve REALLY PER-CONSUMER UNCAPPED? ===================================");
{
  const rRecs = mainRecs.filter((r) => r.config === "R");
  const rPerConsumer = rRecs.filter((r) => r.class === CLASS.PER_CONSUMER_LIMIT);
  // From the /health sampler DURING the R bursts — see `burstSummaries`. Reading this off the
  // at-outcome snapshots instead reports 0 for every successful retrieve (the session is released
  // inside `withSession` before the tool returns) and turns a clean positive result into a false
  // INDETERMINATE.
  //
  // The field read is (active + reserved) with NO live orphan present, not bare activeCount, for two
  // independent reasons:
  //   - the per-consumer gate counts ADMISSIONS, not registrations: `#countForConsumer` starts from
  //     `#reservedByConsumer` and the check runs BEFORE `#reserved++`. Two retrieves admitted together
  //     spend most of their life reserved (launching) and only briefly registered, so a 20ms sampler
  //     that misses the narrow both-registered window reads activeCount 1 and prints INDETERMINATE
  //     about a run that had just proved the rule was never consulted;
  //   - activeCount is `#sessions.size + #orphans.size`, so a single wedged launch's orphan can satisfy
  //     the discriminator with only ONE real retrieve session ever having existed — a fabricated
  //     CONFIRMED. Orphan-carrying samples are therefore excluded from the qualifying set.
  const rOccupancy = mainBursts.filter((b) => b.config === "R").map((b) => b.maxCleanOccupancyDuringBurst).filter((v) => typeof v === "number");
  const maxConcurrentR = rOccupancy.length ? Math.max(...rOccupancy) : 0;
  if (!rRecs.length) {
    console.log("  R not run — no answer.");
  } else if (!licensed) {
    console.log("  NO ANSWER FROM THIS INVOCATION — the instrument did not license a conclusion (see above).");
    console.log(`  (debug: per-consumer refusals on R = ${rPerConsumer.length}, max orphan-free admissions during an R burst = ${maxConcurrentR})`);
  } else if (MAX_SESSIONS <= PER_CONSUMER_MAX) {
    console.log(`  INDETERMINATE: maxSessions (${MAX_SESSIONS}) <= perConsumerMax (${PER_CONSUMER_MAX}), so the GLOBAL gate refuses`);
    console.log("  before the per-consumer rule can ever be consulted. The pool is too small to distinguish the two.");
  } else {
    console.log(`  every R slot authenticated as ONE consumer; perConsumerMax=${PER_CONSUMER_MAX}`);
    console.log(`  per-consumer refusals on R: ${rPerConsumer.length}   max concurrent ADMISSIONS (live + in-flight, orphan-free samples only) during an R burst: ${maxConcurrentR}`);
    if (rPerConsumer.length === 0 && maxConcurrentR > PER_CONSUMER_MAX) {
      console.log("  CONFIRMED uncapped: one consumer held more concurrent retrieve admissions than perConsumerMax");
      console.log("  and was never refused by the per-consumer rule — matching `withSession` acquiring with no meta.");
    } else if (rPerConsumer.length > 0) {
      console.log("  CONTRADICTED: retrieve produced a PER-CONSUMER refusal. That is a finding (reported, not fixed).");
    } else {
      console.log("  INDETERMINATE: no burst ever held more than perConsumerMax concurrent retrieve admissions, so");
      console.log("  the discriminating moment never occurred (raise BGW_MAX_SESSIONS to widen the global headroom).");
    }
  }
}


// --- conclusion ------------------------------------------------------------------------------------------

console.log("");
console.log("=== CONCLUSION =================================================================");
if (!licensed) {
  console.log("  NO CONCLUSION IS LICENSED FROM THIS INVOCATION.");
  for (const r of unlicensedReasons) console.log(`    - ${r}`);
} else {
  const launchFailures = launchFailuresOf(mainRecs).length;
  const deadlineFailures = byClass(mainRecs, CLASS.LAUNCH_DEADLINE).length;
  const globals = byClass(mainRecs, CLASS.GLOBAL_LIMIT).length;
  const perConsumer = byClass(mainRecs, CLASS.PER_CONSUMER_LIMIT).length;
  const inBand = byClass(mainRecs, CLASS.RETRIEVE_IN_BAND).length;
  console.log(`  Over-subscribing a ${MAX_SESSIONS}-slot pool at ${CONCURRENCY}x concurrency across ${ROUNDS} round(s) and`);
  console.log(`  ${CONFIGS.length} configuration(s) produced ${mainRecs.length} calls: ${mainRecs.filter((r) => r.outcome === "ok").length} admitted, ${globals} refused by the global`);
  console.log(`  ceiling, ${perConsumer} refused by the per-consumer cap, ${launchFailures} CORE_LAUNCH failures`);
  console.log(`  (${deadlineFailures} of them deadline-blown), ${inBand} in-band retrieve failures.`);
  console.log("");
  console.log("  HANDING TO THE DEADLINE TICKET:");
  if (launchFailures === 0) {
    console.log("    - CORE_LAUNCH failures under pure over-subscription: NONE observed, on EITHER of the two");
    console.log("      strings the code raises (\"browser core failed to launch\" and \"…launch exceeded <N>ms deadline\")");
  } else {
    console.log(`    - CORE_LAUNCH failures under pure over-subscription: ${launchFailures} REPRODUCED, of which ${deadlineFailures} blew the`);
    console.log("      launch deadline (see the attribution section — the deadline site names itself, the other two do not)");
  }
  console.log(`    - launch latency (S, launch-only):${distS ? ` min=${distS.min}ms median=${distS.median}ms p95=${distS.p95}ms max=${distS.max}ms over n=${distS.n}` : " NO SAMPLES"}`);
  if (launchFailures === 0) {
    console.log("    - VALIDITY LIMIT: the fixture path excludes proxy-connect and remote-target render cost,");
    console.log("      both of which sit inside the production launch/first-nav window. A null result therefore");
    console.log("      bounds the claim to \"not reproducible without proxy and remote cost\", NOT \"does not occur\".");
  } else {
    console.log("    - the fix is OUT OF SCOPE for #122; this reports the failure mode, it does not repair it.");
  }
}

// --- JSON record + exit ---------------------------------------------------------------------------------

record.finishedAt = new Date().toISOString();
record.calls = allRecords;
record.controls = controls;
record.swallowedCount = swallowedCount;
record.distributions = { launchOnlyS: distS, openVerbD: distD, wholeRetrieveR: distR, refusalsByConfig: refusalDists };
record.burstSummaries = burstSummaries;
record.partialRun = partial;
record.unlicensedReasons = unlicensedReasons;
record.phases = Object.fromEntries(
  Object.entries(phaseResults).map(([name, p]) => [
    name,
    { maxSessions: p?.maxSessions ?? null, concurrency: p?.concurrency ?? null, rounds: p?.rounds ?? null, healthSamples: p?.samples?.length ?? 0, healthPollErrors: p?.sampleErrors ?? 0 },
  ]),
);
record.healthSamples = Object.fromEntries(Object.entries(phaseResults).map(([k, v]) => [k, v?.samples ?? []]));
record.instrumentFailures = instrumentFailures;
record.notes = notes;
record.conclusionLicensed = licensed;

if (process.env.POOL_LOAD_OUT) {
  try {
    mkdirSync(dirname(process.env.POOL_LOAD_OUT), { recursive: true });
    writeFileSync(process.env.POOL_LOAD_OUT, `${JSON.stringify(record, null, 2)}\n`);
    console.log("");
    console.log(`  json record: ${process.env.POOL_LOAD_OUT} (verbatim messages, per-call occupancy, every health sample)`);
  } catch (err) {
    console.log(`  json record: FAILED to write ${process.env.POOL_LOAD_OUT} — ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log("");
if (instrumentFailures.length === 0) {
  console.log(`=== INSTRUMENT OK${notes.length ? ` (${notes.length} note(s))` : ""} — the numbers above are the measurement; a finding does not fail this run ===`);
} else {
  console.log(`=== INSTRUMENT FAILED (${instrumentFailures.length}) ===`);
  for (const f of instrumentFailures) console.log(`  - ${f}`);
  console.log("=== The exit code reflects the INSTRUMENT, never the finding. ===");
}

/**
 * FLUSH, then exit explicitly.
 *
 * The explicit exit is not optional: a lingering browser child or a timer this harness does not own
 * must not hold the process open after the report is printed. But under `docker run` stdout is a
 * NON-BLOCKING PIPE, and `process.exit()` does not flush libuv's pending writes — so a bare
 * `process.exit()` here can truncate the tail of its own report, and the tail is precisely the part
 * that says whether to trust everything above it (`INSTRUMENT OK` / the `INSTRUMENT FAILED` list).
 * Writing an empty chunk and waiting for its callback drains everything queued ahead of it, because
 * stream writes are ordered. The timeout is the escape hatch for a consumer that has stopped reading
 * the pipe: a truncated report is bad, a harness that hangs forever on a wedged reader is worse.
 */
process.exitCode = instrumentFailures.length === 0 ? 0 : 1;
const STDOUT_FLUSH_TIMEOUT_MS = 5_000;
await new Promise((resolve) => {
  let settled = false;
  const done = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve();
  };
  // NOT unref'd, for the same reason the signal watchdog is not: this timer is the only thing that
  // still has to fire if the write callback never comes, and an unref'd one would let the loop empty
  // out from under the await.
  const timer = setTimeout(done, STDOUT_FLUSH_TIMEOUT_MS);
  process.stdout.write("", done);
});
process.exit(process.exitCode);
