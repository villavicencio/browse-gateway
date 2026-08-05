/**
 * Unit tests for the three-way CDP baseline's VERDICT MATH (#101).
 *
 * WHY THESE EXIST. The instrument itself cannot be unit-tested — it needs three real browsers — but
 * the part that decides what the run MEANS is pure, and it carries the epic's one mandatory branch:
 * "if the positive control does not separate from the negative control, our probes are inadequate,
 * NOT clean." A decorative version of that branch (unreachable, or reachable only through a code
 * path no run takes) would let the whole epic conclude "green" from a suite that measures nothing.
 * These tests drive that branch, and the two neighbouring ones, from synthetic captures.
 *
 * AND, SINCE THE COMPLETENESS REVIEW, THE FALSE-GREEN PATHS THEMSELVES. Four of the cases below
 * exist because a critic traced a way for this instrument to report good news it had not earned: a
 * noise band collapsing onto a hardcoded floor, a bucket label produced from sub-resolution medians,
 * a cold-start artifact validating the suite, and a probe leaf renamed upstream reading as "the
 * probe did not separate the controls". Each has a test that fails if the refusal is removed.
 *
 * IMPORT DEVIATION, DELIBERATE. Every other test file here imports from `../dist/`; this one imports
 * the helpers from `../scripts/measure-cdp-baseline.mjs` directly, because the helpers live in a
 * script and `dist/` is built from `src/` only. The script guards its entry point on argv, so
 * importing it launches nothing. The two `dist/` imports below are the real ones under test in the
 * last cases.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  analyze,
  analyzeProbe,
  assertCacheBusterContract,
  assertEmbeddable,
  assertLeafContract,
  assertProbeContracts,
  assessCapture,
  assessRendererParity,
  attributeToGuard,
  buildPageScript,
  buildWarmupPage,
  COLLECTOR_LEAF_CONTRACT,
  deadLeafFailures,
  declaredLeafPaths,
  harnessStalls,
  internalConsistencyFailures,
  median,
  positionNumeric,
  PROBE_SPECS,
  RAW_LEAF_CONTRACT,
  rankEffects,
  recommendGate,
  redactDeep,
  redactIps,
  separateLabel,
  separateNumeric,
  separateRate,
  stallByReuse,
  summarizeLabel,
  summarizeNumeric,
  summarizeRate,
} from "../scripts/measure-cdp-baseline.mjs";
import { assertLocalCdpOnly } from "../dist/security/index.js";
import {
  buildLaunchOptions,
  resolveCoreOptions,
  FINGERPRINT_COLLECTOR_JS,
  CDP_TIMING_RAW_JS,
} from "../dist/browser/index.js";

// ── synthetic captures ────────────────────────────────────────────────────────────────────────────
// One knob per probe family that the tests actually move; everything else holds a fixed, clean value
// so a probe that is supposed to stay quiet cannot drift and accidentally supply the separation a
// test is trying to withhold.
//
// EVERY NUMERIC KNOB CARRIES A PER-ROUND JITTER, and that is load-bearing rather than realism for
// its own sake. The separation rule now REFUSES to compare two arms unless both produced an observed
// noise band above the probe's stated resolution floor — which is the whole fix for "a degenerate
// zero spread collapses the band onto a hardcoded constant". Captures that repeat one value exactly
// are precisely that degenerate shape, so a fixture built from them could no longer express a
// separation at all, and every headline test would pass for the wrong reason. The jitter is
// deterministic and IDENTICAL across configurations, so two arms given the same base value still
// produce identical ranges and still refuse to separate: it adds a band, never a difference.
const JITTER_STEP = 0.12;

function capture(config, over = {}, round = 0) {
  const jitter = 1 + JITTER_STEP * round;
  const proxyFired = over.proxyFired ?? false;
  const stall = (over.stall ?? 0.2) * jitter;
  const consoleMs = (over.consoleMs ?? 0.02) * jitter;
  const webdriver = over.webdriver ?? false;
  // Server-side latency, moved independently of the browser-side stall: `ttfb` is the fixture
  // server's own response time and `wall` the end-to-end fetch. Both are produced by the harness
  // process, not by the browser under test, and a test needs to be able to move ONLY them.
  const ttfb = (over.ttfb ?? 1) * jitter;
  const wall = (over.wall ?? 3) * jitter;
  // The collector's quantized leaves. `ratioLabel` exists so a test can drive the collector's
  // `below-resolution` label, which is the shipped ladder's way of saying "the medians behind this
  // bucket did not clear a resolution floor" and must never read as a categorical separation.
  const ratioLabel = over.ratioLabel ?? "lt1_5x";
  const stallBucket = over.stallBucket ?? "lt1";
  const hasFocus = over.hasFocus ?? true;
  return {
    config,
    valid: true,
    extra: over.extra ?? {},
    payload: {
      meta: {
        consoleDebugNative: true,
        visibility: "visible",
        hasFocus,
        // One cold sample then two on a reused socket, mirroring the real shape. Built so ONLY the
        // stall moves with the stall knob: dispatch stays fixed and ttfb has its own knob, so a test
        // that raises `stall` moves the stall probes and nothing else.
        resourceTiming: [10, 20, 30].map((base, i) => ({
          fetchStart: base,
          domainLookupStart: i === 0 ? base + 0.05 : base,
          connectStart: i === 0 ? base + 0.1 : base,
          requestStart: base + stall,
          responseStart: base + stall + ttfb,
          responseEnd: base + stall + ttfb + 0.2,
        })),
      },
      raw: {
        selfTest: { getterFires: true, ownKeysFires: true, clockAdvances: true, error: null },
        errorStack: { fired: false, invocations: 0, summary: { p50: 0, p90: 0, mean: consoleMs } },
        consoleProxy: {
          fired: proxyFired,
          invocations: proxyFired ? 50 : 0,
          summary: { p50: 0, p90: 0, mean: consoleMs },
        },
        consoleTiming: {
          getterInvocations: 0,
          richSummary: { p50: 0, mean: consoleMs },
          plainSummary: { p50: 0, mean: consoleMs },
        },
        fetchProbe: {
          stallMs: [stall, stall, stall],
          reused: [false, true, true],
          dispatchMs: [0.05, 0.05, 0.05],
          stallSummary: { p50: stall, p90: stall },
          wallSummary: { p50: wall },
          ttfbSummary: { p50: ttfb },
        },
        controls: { webdriver, nativeToStringIntact: true, cdcKeys: 0, playwrightKeys: 0, puppeteerKeys: 0 },
      },
      collector: {
        cdp: {
          consoleProxy: { fired: proxyFired, consoleBucket: "lt1" },
          errorStack: { consoleBucket: "lt1" },
          consoleTiming: { ratioBucket: ratioLabel },
          // RENAMED UPSTREAM. The collector's ACTIVE cache-busted fetch probe (`cdp.fetchProbe.*`)
          // was removed — a read-only parity harness must not issue network requests against real
          // origins — and the active version now lives in CDP_TIMING_RAW_JS, which only this
          // baseline runs, against its own loopback fixture. What the collector keeps is a PASSIVE
          // read of the resource timings the page already produced, under a different section name
          // and with different leaves. These four are the ones the shipped collector declares.
          resourceTiming: {
            stallMedianBucket: stallBucket,
            stallMaxBucket: over.stallMaxBucket ?? stallBucket,
            entriesBucket: "8to32",
            timedBucket: "8to32",
          },
        },
      },
    },
  };
}

const rounds = (config, n, over = {}) => Array.from({ length: n }, (_, i) => capture(config, over, i));

// ── summaries ─────────────────────────────────────────────────────────────────────────────────────

test("summarizeNumeric reports the observed RANGE, and counts what it had to drop", () => {
  const s = summarizeNumeric([3, 1, 2, null, Number.NaN]);
  assert.equal(s.n, 3);
  assert.equal(s.nulls, 2);
  assert.equal(s.min, 1);
  assert.equal(s.max, 3);
  assert.equal(s.p50, 2);
  assert.equal(s.spread, 2);
  assert.deepEqual(summarizeNumeric([]), { n: 0, nulls: 0, min: null, p50: null, max: null, mean: null, spread: null });
});

test("summarizeRate ignores nulls rather than scoring them as false", () => {
  const s = summarizeRate([true, false, null, true]);
  assert.equal(s.n, 3);
  assert.equal(s.nulls, 1);
  assert.equal(s.trueCount, 2);
  assert.equal(s.rate, 2 / 3);
});

test("summarizeLabel keeps the whole observed label set, not just the mode", () => {
  const s = summarizeLabel(["lt1", "1to4", "lt1", null]);
  assert.deepEqual(s.set, ["1to4", "lt1"]);
  assert.equal(s.modal, "lt1");
  assert.equal(s.nulls, 1);
});

test("median tolerates a series with nothing usable in it", () => {
  assert.equal(median([]), null);
  assert.equal(median([null, Number.NaN]), null);
  assert.equal(median([2, 1, 3]), 2);
});

// ── separation ────────────────────────────────────────────────────────────────────────────────────

test("separateNumeric needs BOTH disjoint ranges and a gap of 2x the tighter arm's MEASURED noise", () => {
  // clean: tight bands, far apart, and both bands are above the floor so they can be compared
  const clean = separateNumeric(summarizeNumeric([1.0, 1.1, 1.2]), summarizeNumeric([5.0, 5.1, 5.2]), 0.1);
  assert.equal(clean.separated, true);
  assert.equal(clean.resolutionLimited, false);
  assert.ok(Math.abs(clean.noise - 0.2) < 1e-9, "the noise band is the MEASURED min spread, never the floor");

  // overlapping ranges never separate, however far the medians sit
  const overlap = separateNumeric(summarizeNumeric([1, 9]), summarizeNumeric([2, 20]), 0.1);
  assert.equal(overlap.separated, false);
  assert.match(overlap.reason, /overlap/);

  // barely disjoint but both bands are wide: the gap is inside the noise, so this must NOT pass
  const noisy = separateNumeric(summarizeNumeric([1, 5]), summarizeNumeric([5.1, 9]), 0.1);
  assert.equal(noisy.disjoint, true);
  assert.equal(noisy.separated, false);
  assert.match(noisy.reason, /disjoint but/);

  // one sample is not a band
  assert.equal(separateNumeric(summarizeNumeric([1]), summarizeNumeric([9]), 0.1).separated, false);
});

test("separateNumeric REFUSES a comparison when either arm produced no noise band above the floor", () => {
  // THE FALSE GREEN. The old rule took the band as `max(min(spreadA, spreadC), floor)`, so an arm
  // whose rounds all landed on the same value — routine on a clock Chrome coarsens to ~100us —
  // collapsed the band onto the probe's hardcoded floor and reduced the whole test to "is the gap
  // bigger than 2x a constant somebody measured on a laptop". For console.proxyMeanMs that constant
  // is 0.005ms: a 0.01ms bar, one twentieth of a single clock tick. It manufactured separations out
  // of clock resolution, and handed them to recommendGate, which would refuse to threshold the very
  // same probe for having no observable band.
  const flat = separateNumeric(summarizeNumeric([1, 1]), summarizeNumeric([1.4, 1.4]), 0.1);
  assert.equal(flat.separated, false, "a 0.4 gap between two arms that each produced NO band is not a separation");
  assert.equal(flat.resolutionLimited, true);
  assert.match(flat.reason, /RESOLUTION-LIMITED/);

  // one arm with a band is not enough: the tighter arm is the one that defines the resolution, and
  // if IT has no band there is nothing to define
  const oneSided = separateNumeric(summarizeNumeric([1.0, 1.3, 1.6]), summarizeNumeric([5, 5, 5]), 0.1);
  assert.equal(oneSided.separated, false);
  assert.equal(oneSided.resolutionLimited, true);

  // a band narrower than the probe's own declared floor is below its stated resolution too
  const underFloor = separateNumeric(summarizeNumeric([1.0, 1.02]), summarizeNumeric([5.0, 5.3]), 0.1);
  assert.equal(underFloor.resolutionLimited, true);
  assert.equal(underFloor.separated, false);

  // and float residue from averaging quantized samples is not a band, whatever the floor says
  const residue = separateNumeric(summarizeNumeric([0.008, 0.008 + 4.77e-9]), summarizeNumeric([0.02, 0.03]), 0);
  assert.equal(residue.resolutionLimited, true, "a spread of ~5e-9 is the arithmetic's rounding, not variation");
});

test("separateNumeric exempts DISCRETE probes, because a repeated integer is reproduction, not blindness", () => {
  // The counterpart to the rule above, and the reason it is declared per spec rather than inferred.
  // An ownKeys invocation count reading 0 in every round of one arm and 50 in every round of the
  // other has a zero spread for the opposite reason: the quantity is an exact integer and both arms
  // reproduced it perfectly. There is no clock in it to be limited by. These are also the probes
  // epic #92 most needs — booleans and counts, immune to scheduling and clock coarsening — so a rule
  // that silenced them would trade one false green for a false red.
  const counts = separateNumeric(summarizeNumeric([0, 0, 0]), summarizeNumeric([50, 50, 50]), 0.5, { discrete: true });
  assert.equal(counts.separated, true);
  assert.equal(counts.resolutionLimited, false);

  // the floor still does its original job for a discrete probe: a sub-count difference is nothing
  const adjacent = separateNumeric(summarizeNumeric([0, 0]), summarizeNumeric([0.4, 0.4]), 0.5, { discrete: true });
  assert.equal(adjacent.separated, false);

  // and without the flag the same shape is refused — the exemption cannot be acquired by accident
  assert.equal(separateNumeric(summarizeNumeric([0, 0, 0]), summarizeNumeric([50, 50, 50]), 0.5).separated, false);
});

test("separateNumeric sees a large effect carried by the arm with the heavy tail", () => {
  // THE REGRESSION. Taking the noise band as max(spreadA, spreadB) makes the bar rise with the very
  // dispersion that IS the finding, so the arm with the heavy tail can never separate from anything.
  // These are the shapes from a real smoke run's warm pre-dispatch stall (provisional): every round
  // of B above every round of A, by 0.89ms at the closest, and the old rule answered "not separated"
  // because B's own 12.6ms spread demanded a 25ms median gap. That silenced the B-OUTLIER path — the
  // one this suite's header calls its own headline outcome — for the entire latency family.
  const a = summarizeNumeric([0.05, 0.10, 0.15]);
  const b = summarizeNumeric([1.039, 4.139, 13.622]);
  const sep = separateNumeric(a, b, 0.05);
  assert.equal(sep.disjoint, true);
  assert.equal(sep.separated, true);
  assert.ok(Math.abs(sep.gap - 0.889) < 1e-9, `gap should be the distance between the ranges, got ${sep.gap}`);
  assert.ok(Math.abs(sep.noise - 0.1) < 1e-9, `the tighter arm defines the resolution, not the heavy-tailed one (noise=${sep.noise})`);

  // and it stays conservative where it should: overlap still wins over any ratio
  const overlapping = separateNumeric(a, summarizeNumeric([0.10, 4.0, 13.0]), 0.05);
  assert.equal(overlapping.separated, false);
});

test("separateRate requires the controls to sit at OPPOSITE ends, not merely to differ", () => {
  assert.equal(separateRate(summarizeRate([false, false, false]), summarizeRate([true, true, true])).separated, true);
  assert.equal(separateRate(summarizeRate([true, true, true]), summarizeRate([true, true, true])).separated, false);
  assert.equal(separateRate(summarizeRate([false, true, true]), summarizeRate([true, true, true])).separated, false);
  assert.equal(separateRate(summarizeRate([false]), summarizeRate([true])).separated, false);
});

test("separateLabel separates only when the controls never produced a label in common", () => {
  assert.equal(separateLabel(summarizeLabel(["lt1", "lt1"]), summarizeLabel(["4to16", "4to16"])).separated, true);
  assert.equal(separateLabel(summarizeLabel(["lt1", "4to16"]), summarizeLabel(["4to16", "4to16"])).separated, false);
});

test("separateLabel REFUSES a label pair fed by sub-resolution medians", () => {
  // The same false green as the numeric case, one level of quantization up and harder to see: a
  // label comparison shows no spreads for a reader to check. The collector's ratio ladder emits
  // `below-resolution` whenever a median fails a resolution floor — the stable label that replaced a
  // `b<=0 -> 'flat' | 'unbounded'` discontinuity in which two arms measuring the same nothing could
  // land on DIFFERENT labels and read as a clean categorical separation of the controls.
  const refused = separateLabel(summarizeLabel(["below-resolution", "below-resolution"]), summarizeLabel(["3to8x", "3to8x"]));
  assert.equal(refused.separated, false, "an arm that only ever said 'I could not measure this' has not separated from anything");
  assert.equal(refused.resolutionLimited, true);
  assert.match(refused.reason, /RESOLUTION-LIMITED/);

  // A SINGLE ROUND PER ARM IS NOT A COMPARISON, and the early return must not dress itself up as
  // one. This line used to read `assert.equal(separateLabel(...).n, undefined)` under a comment
  // claiming it locked the legacy-label refusal: `separateLabel` never returns an `n`, so the
  // assertion passed for every possible implementation — a test that could not fail, sitting where a
  // reader would believe the refusal was pinned. What is actually true here is that the n<2 guard
  // fires FIRST, so the labels were never looked at and `resolutionLimited` must not claim otherwise.
  const single = separateLabel(summarizeLabel(["flat"]), summarizeLabel(["8to32x"]));
  assert.equal(single.separated, false);
  assert.equal(single.resolutionLimited, false, "the labels were never evaluated, so this must not report a resolution refusal it did not make");
  assert.match(single.reason, /insufficient valid captures/);

  // the legacy discontinuity labels inherit the same refusal, so a run against an older built
  // collector does not get the old false green back
  assert.equal(separateLabel(summarizeLabel(["flat", "flat"]), summarizeLabel(["8to32x", "8to32x"])).separated, false);
  assert.equal(separateLabel(summarizeLabel(["unbounded", "unbounded"]), summarizeLabel(["flat", "flat"])).separated, false);

  // two arms on REAL buckets still separate: this is a rule about unmeasurable labels, not a blanket
  assert.equal(separateLabel(summarizeLabel(["lt1_5x", "lt1_5x"]), summarizeLabel(["8to32x", "8to32x"])).separated, true);
  // and an arm that produced a sub-resolution label only SOMETIMES is not wholly unmeasured: in the
  // rounds it DID resolve it read a different band from C, which is a real lead. The refusal for that
  // shape lives one step downstream, at the threshold — see "recommendGate REFUSES a label threshold
  // that would accept a sub-resolution label", because the accept-set built from a mixed arm contains
  // "the clock could not resolve this" and a gate carrying that passes whenever measurement fails.
  assert.equal(separateLabel(summarizeLabel(["below-resolution", "lt1_5x"]), summarizeLabel(["8to32x", "8to32x"])).separated, true);
});

// ── position ──────────────────────────────────────────────────────────────────────────────────────

test("positionNumeric places B on the A->C axis and keeps meaning past both ends", () => {
  const a = summarizeNumeric([1, 1, 1]);
  const c = summarizeNumeric([5, 5, 5]);
  assert.equal(positionNumeric(a, summarizeNumeric([1.2, 1.2]), c).verdict, "B-matches-A");
  assert.equal(positionNumeric(a, summarizeNumeric([3, 3]), c).verdict, "B-between");
  assert.equal(positionNumeric(a, summarizeNumeric([4.9, 4.9]), c).verdict, "B-matches-C");
  // beyond C is still C's side, and t records how far beyond
  const beyond = positionNumeric(a, summarizeNumeric([9, 9]), c);
  assert.equal(beyond.verdict, "B-matches-C");
  assert.equal(beyond.t, 2);
});

// ── the gate hand-off ─────────────────────────────────────────────────────────────────────────────

test("recommendGate thresholds the observed GAP, not the midpoint of the medians", () => {
  const spec = { kind: "numeric", unit: "ms", floor: 0.1 };
  const a = summarizeNumeric([1.0, 1.2, 1.4]); // worst round 1.4
  const b = summarizeNumeric([1.1, 1.3]);
  const c = summarizeNumeric([5.0, 5.4]); // best round 5.0
  const sep = separateNumeric(a, c, 0.1);
  assert.equal(sep.separated, true);
  const gate = recommendGate(spec, a, b, c, sep);
  assert.equal(gate.kind, "numeric");
  assert.equal(gate.threshold, 1.4 + (5.0 - 1.4) / 2); // gap midpoint, above A's WORST round
  assert.ok(gate.headroomWidths > 1, "a usable gate must clear A's worst round by more than one noise width");
  assert.equal(gate.headroomBasis, "observed");
  assert.match(gate.bMargin, /clears the threshold/);
  assert.doesNotMatch(gate.bMargin, /NEGATIVE/);

  // no separation, no threshold: there is nothing honest to hand #102
  assert.equal(recommendGate(spec, a, b, c, { separated: false }), null);
});

test("recommendGate names B as being on the wrong side when it is", () => {
  const spec = { kind: "numeric", unit: "ms", floor: 0.1 };
  const a = summarizeNumeric([1.0, 1.2, 1.5]);
  const b = summarizeNumeric([5.1, 5.3]); // sitting with the naive-automation control
  const c = summarizeNumeric([5.0, 5.4]);
  const gate = recommendGate(spec, a, b, c, separateNumeric(a, c, 0.1));
  assert.match(gate.bMargin, /NEGATIVE/);
});

test("recommendGate REFUSES a threshold whose headroom would rest on a provisional constant", () => {
  // TWO LOCKS ON THE SAME DOOR, and this test drives the second one directly.
  //
  // The first lock is separateNumeric: a continuous probe whose arms have no band above the floor is
  // never called separated, so recommendGate is never reached (asserted first, below). The second is
  // this refusal, which stands even when a caller hands in a separation verdict of its own. It has to
  // stand independently because the number at stake is the one that gets written into #102, and its
  // headroom — the only figure that says whether the gate survives a busy host — would otherwise be
  // counted in widths of a floor measured on a macOS, headless, constructed-args smoke run of n=2-3.
  // Two such runs minutes apart produced thresholds that disagreed about whether the current stack
  // passes. A refusal with a reason is the honest output.
  const spec = { kind: "numeric", unit: "ms", floor: 0.005, floorBasis: "PROVISIONAL: chosen on a smoke run" };
  const b = summarizeNumeric([0.012, 0.012]);
  const c = summarizeNumeric([0.020, 0.030]);

  // lock 1: the comparison itself is refused, so nothing downstream can be asked for a threshold
  const flat = summarizeNumeric([0.004, 0.004, 0.004]);
  assert.equal(separateNumeric(flat, c, 0.005).resolutionLimited, true);
  assert.equal(recommendGate(spec, flat, b, c, separateNumeric(flat, c, 0.005)), null);

  // lock 2: forced past the separation rule, the threshold is still refused — no band at all
  const forced = recommendGate(spec, flat, b, c, { separated: true });
  assert.equal(forced.refused, true);
  assert.equal(forced.refusedBecause, "no-observed-band");
  assert.equal(forced.threshold, null);
  assert.equal(forced.headroomWidths, null);
  assert.match(forced.rule, /NO THRESHOLD OFFERED/);

  // lock 2, second reason: a band narrower than the declared floor would make the headroom a count
  // of FLOOR widths, i.e. a margin whose provenance is the smoke run rather than this run
  const narrow = summarizeNumeric([0.003, 0.004, 0.006]);
  const floorDerived = recommendGate(spec, narrow, b, c, { separated: true });
  assert.equal(floorDerived.refused, true);
  assert.equal(floorDerived.refusedBecause, "band-below-provisional-floor");
  assert.match(floorDerived.rule, /PROVISIONAL/);

  // a genuinely measured band still produces a number, and says the headroom is its own
  const wide = summarizeNumeric([0.001, 0.006, 0.014]);
  const wideC = summarizeNumeric([0.09, 0.10, 0.11]);
  const withBand = recommendGate(spec, wide, b, wideC, separateNumeric(wide, wideC, 0.005));
  assert.equal(withBand?.refused, undefined);
  assert.ok(typeof withBand.threshold === "number");
  assert.equal(withBand.headroomBasis, "observed");
  assert.match(withBand.tolerance, /PROVISIONAL/, "the floor's provenance travels with the threshold either way");
});

test("recommendGate REFUSES a label threshold that would accept a sub-resolution label", () => {
  // A GATE THAT PASSES BECAUSE THE MEASUREMENT FAILED, reachable without any resolution rule firing.
  //
  // `separateLabel` only refuses an arm whose WHOLE set is sub-resolution, so a MIXED arm —
  // {below-resolution, lt1_5x}, i.e. the clock resolved in some rounds and not in others — separates
  // cleanly from a C sitting at {ge32x}. That separation is real and is reported. But the threshold
  // built from it is A's set in its entirety, so the shipped #102 rule becomes "fail when the label
  // is outside {below-resolution, lt1_5x}": every future run whose console medians fall under the
  // collector's own resolution floor emits `below-resolution` and PASSES. The stack could go fully
  // visible and the gate would still read green.
  const a = summarizeLabel(["below-resolution", "lt1_5x", "below-resolution", "lt1_5x"]);
  const b = summarizeLabel(["lt1_5x", "lt1_5x"]);
  const c = summarizeLabel(["ge32x", "ge32x", "ge32x", "ge32x"]);
  const sep = separateLabel(a, c);
  assert.equal(sep.separated, true, "the separation itself is real and must still be reported");

  const gate = recommendGate({ kind: "label" }, a, b, c, sep);
  assert.equal(gate.refused, true);
  assert.equal(gate.refusedBecause, "threshold-would-accept-a-sub-resolution-label");
  assert.equal(gate.threshold, null);
  assert.match(gate.rule, /NO THRESHOLD OFFERED/);
  assert.match(gate.rule, /below-resolution/);
  assert.match(gate.tolerance, /sub-resolution/);

  // A clean label pair is untouched — this is a rule about what the accept-set MEANS, not a blanket
  // refusal of categorical gates.
  const clean = recommendGate(
    { kind: "label" },
    summarizeLabel(["lt1_5x", "lt1_5x"]),
    b,
    c,
    separateLabel(summarizeLabel(["lt1_5x", "lt1_5x"]), c),
  );
  assert.equal(clean.refused, undefined);
  assert.deepEqual(clean.threshold, ["lt1_5x"]);

  // And the refusal must NOT be misread as the separation rule contradicting the threshold rule:
  // both are right here, so it is not an instrument failure — it is a blocked gate (asserted in the
  // analyze() case below).
  assert.deepEqual(
    internalConsistencyFailures([
      { spec: { key: "collector.cdp.consoleTiming.ratioBucket", family: "protocol" }, separation: sep, gate },
    ]),
    [],
  );
});

test("recommendGate DOES threshold a discrete count whose arms each read one exact integer", () => {
  // The exemption, at the threshold end. A zero spread on an integer count is reproduction; refusing
  // to threshold it would discard the one probe family that survives clock coarsening and scheduling
  // noise, which is exactly the family epic #92 needs to be able to gate on.
  const spec = { kind: "numeric", unit: "calls", floor: 0.5, discrete: true, floorBasis: "EXACT" };
  const a = summarizeNumeric([0, 0, 0]);
  const b = summarizeNumeric([0, 0]);
  const c = summarizeNumeric([50, 50, 50]);
  const sep = separateNumeric(a, c, 0.5, { discrete: true });
  assert.equal(sep.separated, true);
  const gate = recommendGate(spec, a, b, c, sep);
  assert.equal(gate.refused, undefined);
  assert.equal(gate.threshold, 25);
  assert.equal(gate.headroomBasis, "exact-quantum");
  assert.ok(gate.headroomWidths > 1);
});

// ── capture validity ──────────────────────────────────────────────────────────────────────────────

test("assessCapture rejects a capture whose own self-tests did not fire", () => {
  const good = capture("A");
  assert.equal(assessCapture(good.payload).valid, true);

  const clockFrozen = capture("A");
  clockFrozen.payload.raw.selfTest.clockAdvances = false;
  const assessed = assessCapture(clockFrozen.payload);
  assert.equal(assessed.valid, false);
  assert.match(assessed.reasons.join(" "), /clockAdvances/);

  assert.equal(assessCapture(null).valid, false);
  assert.equal(assessCapture({ fatal: "boom" }).valid, false);
});

test("assessCapture rejects a capture whose console sink was stubbed", () => {
  // #100's first stated way its console probes could be measuring nothing. If the driver replaces
  // console.debug on OUR stack only, B's whole console family reads clean because its sink is dead —
  // and the run reports "B-MATCHES-A, gate UNBLOCKED". This was a printed warning on a counted
  // capture, which is the same as not having the check.
  const stubbed = capture("B");
  stubbed.payload.meta.consoleDebugNative = false;
  const assessed = assessCapture(stubbed.payload, { config: "B" });
  assert.equal(assessed.valid, false);
  assert.match(assessed.reasons.join(" "), /stubbed sink/);
});

test("assessCapture rejects a C capture whose OWN consumer received no Runtime events", () => {
  // The positive-control receipt used to be summed across all C captures, so a round in which the
  // consumer received nothing was averaged into C's column — widening C's band and killing
  // separations that were really there. The receipt belongs to the capture that earned it.
  const good = capture("C");
  assert.equal(assessCapture(good.payload, { config: "C", extra: { consoleApiCalled: 137 } }).valid, true);

  const idle = assessCapture(good.payload, { config: "C", extra: { consoleApiCalled: 0 } });
  assert.equal(idle.valid, false);
  assert.match(idle.reasons.join(" "), /no Runtime.consoleAPICalled events in THIS capture/);

  // The same receipt is meaningless for the arms that have no raw client, and must not invalidate them.
  assert.equal(assessCapture(capture("A").payload, { config: "A", extra: {} }).valid, true);
  assert.equal(assessCapture(capture("B").payload, { config: "B", extra: {} }).valid, true);
});

test("stallByReuse only splits the series when the index pairing is verifiable", () => {
  const paired = stallByReuse({ stallMs: [9, 1, 1], reused: [false, true, true] });
  assert.deepEqual(paired.warm, [1, 1]);
  assert.deepEqual(paired.cold, [9]);
  assert.equal(paired.pairingExact, true);

  // The probe source pushes stalls and reuse flags under slightly different conditions, so a
  // length mismatch means the indices do not correspond — silently zipping them would attribute
  // cold-connection samples to the warm regime.
  const mismatched = stallByReuse({ stallMs: [9, 1], reused: [false, true, true] });
  assert.equal(mismatched.pairingExact, false);
  assert.deepEqual(mismatched.warm, [9, 1]);
  assert.deepEqual(mismatched.cold, []);
});

test("harnessStalls splits the recovered Resource Timing rows by connection reuse", () => {
  const s = harnessStalls({
    resourceTiming: [
      // cold: connectStart moved off fetchStart, so a handshake happened
      { fetchStart: 10, domainLookupStart: 10.05, connectStart: 10.1, requestStart: 12, responseStart: 13 },
      // warm: connection phases collapsed onto fetchStart
      { fetchStart: 20, domainLookupStart: 20.05, connectStart: 20, requestStart: 20.3, responseStart: 21 },
      // unusable: no timing at all
      { fetchStart: 0, domainLookupStart: 0, connectStart: 0, requestStart: 0, responseStart: 0 },
    ],
  });
  assert.equal(s.entries, 3);
  assert.equal(s.usable, 2);
  assert.deepEqual(s.cold, [2]);
  assert.deepEqual(s.warm.map((x) => Number(x.toFixed(3))), [0.3]);
  assert.equal(s.ttfb.length, 2);

  // No recovered rows must read as "nothing measured", never as a clean zero.
  const empty = harnessStalls({});
  assert.equal(empty.usable, 0);
  assert.deepEqual(empty.warm, []);
  assert.equal(median(empty.warm), null);
});

// ── the headline branches ─────────────────────────────────────────────────────────────────────────

test("HEADLINE: no separation between the controls reports PROBES-INADEQUATE and blocks #102", () => {
  // Every configuration reads identically — which is what a run on a Chrome that has closed every
  // probe in this family looks like. The wrong answer here is "B-MATCHES-A, we are clean".
  const captures = [...rounds("A", 6), ...rounds("B", 6), ...rounds("C", 6)];
  const result = analyze(captures, { positiveControlAttached: true });
  assert.equal(result.status, "PROBES-INADEQUATE");
  assert.equal(result.gateBlocked, true);
  assert.equal(result.discriminating.length, 0);
  assert.match(result.headline, /INADEQUATE/);
  assert.match(result.headline, /NOT about our stack/);
});

test("HEADLINE: a signature our stack has and NEITHER control has is the top finding", () => {
  // The case the ticket's "is B closer to A or to C" framing cannot express. Naive automation does
  // not intercept requests, so the two controls agree on pre-dispatch latency and the A-vs-C test
  // reports INDETERMINATE however far B sits from both. Measured on Chrome 150 (provisional: macOS, headless, constructed args) with a real Fetch
  // guard installed: A 0.17ms / C 0.17ms / B 1.6ms.
  const captures = [
    ...rounds("A", 6, { stall: 0.2 }),
    ...rounds("B", 6, { stall: 1.6 }),
    ...rounds("C", 6, { stall: 0.2 }),
  ];
  const result = analyze(captures, { positiveControlAttached: true });
  assert.equal(result.status, "FINDING-B-OUTLIER");
  assert.match(result.headline, /DISTINGUISHABLE FROM BOTH CONTROLS/);

  const stall = result.probes.find((p) => p.spec.key === "harness.stallWarmP50Ms");
  assert.equal(stall.separation.separated, false, "the controls agree — the A/C axis is blind here");
  assert.equal(stall.separationAB.separated, true);
  assert.equal(stall.separationBC.separated, true);
  assert.equal(stall.bOutlier, true);
  assert.equal(stall.verdict, "B-OUTLIER");

  // The gate handed to #102 is referenced to A, and it is explicit that it fails today on purpose.
  assert.equal(stall.gate.failsToday, true);
  assert.ok(stall.gate.threshold > 0.2 && stall.gate.threshold < 1.6);
  assert.match(stall.gate.bMargin, /FAILS today by design/);

  // And the gate stays BLOCKED: an outlier finding proves our stack is visible, it does NOT prove
  // that the console/preview probes can see a known-attached consumer.
  assert.equal(result.protocolValidated, false);
  assert.equal(result.gateBlocked, true);
});

test("HEADLINE: a separation carried ONLY by a crude control does not validate the suite", () => {
  // Measured on Chrome 150 (provisional: macOS, headless, constructed args): attaching a debugging port flips navigator.webdriver even without
  // --enable-automation, so this branch is not hypothetical. Counting it as validation would let a
  // run in which every protocol probe was dead report "we are clean" on the strength of a signal
  // that says nothing about protocol attachment.
  const captures = [
    ...rounds("A", 6),
    ...rounds("B", 6),
    ...rounds("C", 6, { webdriver: true }),
  ];
  const result = analyze(captures, { positiveControlAttached: true });
  assert.equal(result.status, "PROBES-INADEQUATE");
  assert.equal(result.gateBlocked, true);
  assert.equal(result.discriminating.length, 1);
  assert.equal(result.protocolDiscriminating.length, 0);
  assert.deepEqual(result.controlOnly.map((p) => p.spec.key), ["controls.webdriver"]);
  assert.match(result.headline, /CRUDE CONTROLS/);
});

test("HEADLINE: fixture-server latency cannot unblock #102, however cleanly it separates", () => {
  // THE REGRESSION, and it is the cheapest false green available. The fixture server, the Fetch
  // guard's client side and the raw CDP client all run on the harness's ONE Node event loop, and the
  // work is per-configuration: C parses several hundred Runtime.consoleAPICalled payloads while the
  // same loop answers the probe's cache-busted GETs; A is idle. So C's server-side latency is
  // systematically above A's BY THE INSTRUMENT. These two probes were tagged protocol-family, which
  // is the tag analyze() computes protocolValidated from — so a run whose ONLY difference was
  // fixture noise reported "1 probe(s) discriminate (1 protocol-family) ... #102 gate: UNBLOCKED".
  const captures = [
    ...rounds("A", 6, { ttfb: 0.2, wall: 2.5 }),
    ...rounds("B", 6, { ttfb: 0.2, wall: 2.5 }),
    ...rounds("C", 6, { ttfb: 0.6, wall: 9.0 }),
  ];
  const result = analyze(captures, { positiveControlAttached: true });

  const separated = result.discriminating.map((p) => p.spec.key).sort();
  assert.deepEqual(separated, ["fetch.wallP50Ms", "harness.ttfbP50Ms"], "the fixture-latency probes DID separate — that is the point");
  assert.equal(result.protocolDiscriminating.length, 0);
  assert.equal(result.protocolValidated, false);
  assert.equal(result.gateBlocked, true);
  assert.equal(result.status, "PROBES-INADEQUATE");

  // and the explanation names them instead of printing an empty parenthetical: the "crude controls"
  // list was built from the control family alone, so a harness-family sole separator rendered as
  // "The only probe(s) that separated the controls are CRUDE CONTROLS ()".
  assert.match(result.headline, /harness\.ttfbP50Ms \[harness\]/);
  assert.match(result.headline, /fetch\.wallP50Ms \[harness\]/);
});

test("HEADLINE: a cold-start-confounded probe cannot validate the suite, and is still reported", () => {
  // DEFECT: harness.stallColdP50Ms was protocol-family. It is the pre-dispatch stall on the samples
  // that had to open a socket, so it is dominated by how much browser life each arm had accumulated
  // before its probe page ran — and the three arms do not arrive equal (A is spawned onto its startup
  // URL; B comes up through a driver handshake; C through DevToolsActivePort + attach + Page/Runtime
  // enable). A verifier measured A running 1.4-2x SLOWER than C on it purely from cold start, and the
  // /warmup page added to fix that then over-corrected the other way. As protocol-family, a number
  // whose sign has been set twice by browser age could validate the whole suite on its own.
  //
  // Here the cold stall separates the controls cleanly and NOTHING else does. The run must still
  // report PROBES-INADEQUATE and block #102.
  // Move ONLY the cold row, and give every arm a band of its own so the comparison is not refused
  // as resolution-limited: the point of this case is a probe that DOES separate cleanly and still
  // must not count. The warm rows keep their base stall, so the warm probes stay quiet.
  const coldStall = (caps, base) =>
    caps.map((c, i) => {
      c.payload.meta.resourceTiming[0].requestStart = c.payload.meta.resourceTiming[0].fetchStart + base + i * 0.5;
      return c;
    });
  const captures = [
    ...coldStall(rounds("A", 6), 9),
    ...coldStall(rounds("B", 6), 9),
    ...coldStall(rounds("C", 6), 30),
  ];
  const result = analyze(captures, { positiveControlAttached: true, browserAgeByConfig: { A: 400, B: 2100, C: 2600 } });

  const cold = result.probes.find((p) => p.spec.key === "harness.stallColdP50Ms");
  assert.equal(cold.spec.family, "context", "the probe stays in the run — it is DEMOTED, not deleted");
  assert.equal(cold.separation.separated, true, "and it really did separate the controls; that is why the family tag has to do the work");
  assert.ok(cold.spec.confound, "a context-family probe must name its confound");

  assert.equal(result.protocolDiscriminating.length, 0);
  assert.equal(result.protocolValidated, false);
  assert.equal(result.gateBlocked, true);
  assert.equal(result.status, "PROBES-INADEQUATE");
  assert.deepEqual(result.contextProbes.map((p) => p.spec.key), ["harness.stallColdP50Ms"]);
  // the confound's own measurement travels with the analysis so the printer can put it next to the
  // probe rather than 40 lines earlier in the instrument-validity section
  assert.deepEqual(result.browserAgeByConfig, { A: 400, B: 2100, C: 2600 });
});

test("HEADLINE: a RESOLUTION-LIMITED protocol probe cannot contribute to protocolValidated", () => {
  // The defect in one picture. Configuration C's console mean sits above A's, both arms read the
  // same value in every round, and the old noise band — max(min(0, 0), 0.005) — made the bar 0.01ms.
  // Every console probe in the suite "separated", protocolValidated went true, and the run printed
  // "#102 gate: UNBLOCKED" above a gate section that refused to threshold the same probes.
  const flat = (config, consoleMs) =>
    Array.from({ length: 6 }, () => capture(config, { consoleMs }, 0)); // round 0 for every capture => no jitter, no band
  const captures = [...flat("A", 0.02), ...flat("B", 0.02), ...flat("C", 0.06)];
  const result = analyze(captures, { positiveControlAttached: true });

  const proxyMean = result.probes.find((p) => p.spec.key === "console.proxyMeanMs");
  assert.equal(proxyMean.separation.resolutionLimited, true);
  assert.equal(proxyMean.separation.separated, false);
  assert.equal(proxyMean.gate, null, "a refused comparison hands #102 nothing");

  assert.equal(result.protocolDiscriminating.length, 0);
  assert.equal(result.protocolValidated, false);
  assert.equal(result.gateBlocked, true);
  assert.equal(result.status, "PROBES-INADEQUATE");
  // and the headline distinguishes "could not be evaluated" from "measured nothing", because those
  // read identically as "not separated" and only the second says anything about our stack
  assert.match(result.headline, /RESOLUTION-LIMITED/);
  assert.ok(result.protocolResolutionLimited.some((p) => p.spec.key === "console.proxyMeanMs"));
});

test("HEADLINE: a label probe fed by sub-resolution medians cannot unblock #102 either", () => {
  // Same defect through the collector's quantized ladder, which is the surface a gate written
  // against the SHIPPED snapshot would actually read. `below-resolution` means the medians behind
  // the bucket did not clear a resolution floor; a disjoint label set built from it compares
  // measurability, not protocol presence.
  const captures = [
    ...rounds("A", 6, { ratioLabel: "below-resolution" }),
    ...rounds("B", 6, { ratioLabel: "below-resolution" }),
    ...rounds("C", 6, { ratioLabel: "8to32x" }),
  ];
  const result = analyze(captures, { positiveControlAttached: true });
  const ratio = result.probes.find((p) => p.spec.key === "collector.cdp.consoleTiming.ratioBucket");
  assert.equal(ratio.separation.resolutionLimited, true);
  assert.equal(ratio.separation.separated, false);
  assert.equal(result.protocolValidated, false);
  assert.equal(result.gateBlocked, true);

  // a real bucket difference on the same probe still validates: the refusal is about the label's
  // meaning, not about the collector being coarse
  const real = analyze(
    [...rounds("A", 6, { ratioLabel: "lt1_5x" }), ...rounds("B", 6, { ratioLabel: "lt1_5x" }), ...rounds("C", 6, { ratioLabel: "8to32x" })],
    { positiveControlAttached: true },
  );
  assert.equal(real.protocolValidated, true);
});

test("HEADLINE: the robust validators — a boolean and a count — DO unblock #102", () => {
  // The other half of the resolution rule. Everything above refuses a separation built out of clock
  // resolution; this asserts that the two probes epic #92 most needs are untouched by that refusal.
  // consoleProxy.fired is a boolean and consoleProxy.invocations an exact integer: neither can be
  // moved by scheduling noise or by a 100us clock, and both read 0 in every round of A and 50 in
  // every round of C — a zero spread that means "reproduced exactly", not "unresolvable".
  const captures = [
    ...rounds("A", 6),
    ...rounds("B", 6),
    ...rounds("C", 6, { proxyFired: true }),
  ];
  const result = analyze(captures, { positiveControlAttached: true });
  const fired = result.probes.find((p) => p.spec.key === "consoleProxy.fired");
  const invocations = result.probes.find((p) => p.spec.key === "consoleProxy.invocations");

  assert.equal(fired.separation.separated, true);
  assert.equal(invocations.separation.separated, true);
  assert.equal(invocations.separation.resolutionLimited, false, "an integer count is not resolution-limited by a zero spread");
  assert.equal(invocations.spec.discrete, true);
  assert.equal(invocations.gate.refused, undefined, "and it can be thresholded: the gate is 25 invocations, with an exact quantum behind it");
  assert.equal(invocations.gate.headroomBasis, "exact-quantum");

  assert.equal(result.protocolValidated, true);
  assert.equal(result.gateBlocked, false);
});

test("HEADLINE: an instrument-validity failure blocks the gate instead of printing next to a green verdict", () => {
  // Every check in the runner's "instrument validity" section used to be a console.log. A run could
  // print FAIL for a stubbed console sink, an unfocused renderer in exactly one configuration, or a
  // driver still settling inside the measurement window, and then compute B-MATCHES-A / UNBLOCKED /
  // exit 0 forty lines below.
  const captures = [
    ...rounds("A", 6),
    ...rounds("B", 6),
    ...rounds("C", 6, { proxyFired: true }),
  ];
  const clean = analyze(captures, { positiveControlAttached: true });
  assert.equal(clean.status, "B-MATCHES-A");
  assert.equal(clean.gateBlocked, false);

  const failed = analyze(captures, {
    positiveControlAttached: true,
    instrumentFailures: ["document.hasFocus() AGREES across configurations (readings A=true B=true C=false)"],
  });
  assert.equal(failed.status, "INSTRUMENT-FAILED");
  assert.equal(failed.gateBlocked, true);
  assert.match(failed.headline, /not comparable/);
  assert.match(failed.headline, /hasFocus/);
});

test("HEADLINE: a non-rotated run is measured but never validates the protocol family", () => {
  // With A always first and C always last in every round, within-round drift on the host is
  // indistinguishable from the A-vs-C separation that unblocks the gate — and every probe here is
  // host-load sensitive. The analysis cannot see the order, so the runner declares it.
  const captures = [
    ...rounds("A", 6),
    ...rounds("B", 6),
    ...rounds("C", 6, { proxyFired: true }),
  ];
  const fixed = analyze(captures, { positiveControlAttached: true, rotated: false });
  assert.equal(fixed.status, "B-MATCHES-A", "the finding is still reported — it is the GATE that is withheld");
  assert.equal(fixed.protocolValidated, true);
  assert.equal(fixed.gateBlocked, true);
  assert.match(fixed.gateBlockedReasons.join(" "), /fixed within-round order/);

  // and an unstated order is not treated as the confound: only an explicit declaration counts
  assert.equal(analyze(captures, { positiveControlAttached: true }).gateBlocked, false);
});

test("HEADLINE: a validated suite that can hand #102 no usable threshold still BLOCKS the gate", () => {
  // TWO ROUTES TO "UNBLOCKED" PRINTED ABOVE ITS OWN CONTRADICTION, closed by one rule.
  //
  // Route 1 — A REFUSED THRESHOLD. The collector's ratio ladder is protocol-family, so a mixed
  // {below-resolution, lt1_5x} arm separating from C sets protocolValidated on its own; its
  // threshold is then refused for containing a label that means "unmeasurable", and the run used to
  // print "#102 gate: UNBLOCKED" with "NO THRESHOLD OFFERED" forty lines below it.
  const mixed = (cfg, labels) => labels.map((ratioLabel, i) => capture(cfg, { ratioLabel }, i));
  const refusedRun = analyze(
    [
      ...mixed("A", ["below-resolution", "lt1_5x", "below-resolution", "lt1_5x", "below-resolution", "lt1_5x"]),
      ...mixed("B", ["below-resolution", "lt1_5x", "below-resolution", "lt1_5x", "below-resolution", "lt1_5x"]),
      ...mixed("C", ["ge32x", "ge32x", "ge32x", "ge32x", "ge32x", "ge32x"]),
    ],
    { positiveControlAttached: true },
  );
  const ratio = refusedRun.probes.find((p) => p.spec.key === "collector.cdp.consoleTiming.ratioBucket");
  assert.equal(ratio.separation.separated, true, "the separation is real and stays in the report");
  assert.equal(refusedRun.protocolValidated, true, "the suite IS validated — that claim is untouched");
  assert.equal(ratio.gate.refused, true);
  assert.equal(refusedRun.gateBlocked, true, "but no number can be shipped, so #102 stays blocked");
  assert.match(refusedRun.gateBlockedReasons.join(" "), /no usable threshold/);
  assert.match(refusedRun.gateBlockedReasons.join(" "), /REFUSED: threshold-would-accept-a-sub-resolution-label/);
  // and it is a BLOCKED GATE, not an instrument failure: both rules were right at the same time
  assert.deepEqual(refusedRun.instrumentFailures, []);
  assert.notEqual(refusedRun.status, "INSTRUMENT-FAILED");

  // Route 2 — HEADROOM UNDER ONE NOISE WIDTH. separateNumeric compares the gap against the TIGHTER
  // arm's band while the headroom is expressed in A's OWN band, so a probe where A is the wide arm
  // separates cleanly and still puts the threshold a fiftieth of A's spread above A's worst round.
  // The gate section already printed "this gate will flake"; the headline said UNBLOCKED anyway.
  const spec = { key: "console.proxyMeanMs", kind: "numeric", unit: "ms", floor: 0.05, family: "protocol", note: "", read: () => null };
  const flaky = analyzeProbe(spec, {
    A: [1.0, 2.0, 3.0, 4.0, 5.0, 6.0], // spread 5.0 — the wide arm
    B: [1.1, 2.1, 3.1],
    C: [6.2, 6.23, 6.26], // spread 0.06 — tight, and only 0.2 above A's worst round
  });
  assert.equal(flaky.separation.separated, true, "2x the TIGHTER arm's band is cleared, so this really does separate");
  assert.ok(flaky.gate.headroomWidths < 1, `the threshold sits ${flaky.gate.headroomWidths} of A's own noise widths above A's worst round`);
  assert.equal(flaky.gate.refused, undefined, "the threshold itself is not refused — it is unusably tight, which is a different fact");

  // Route 2 end to end, through a real protocol-family probe rather than a synthetic spec: A wide,
  // C tight and only just above it, B sitting on A. The run reports its finding and blocks the gate.
  const warmStall = (caps, values) =>
    caps.map((c, i) => {
      for (const idx of [1, 2]) { // rows 1 and 2 are the reused-connection samples in the fixture
        const r = c.payload.meta.resourceTiming[idx];
        r.requestStart = r.fetchStart + values[i];
        r.responseStart = r.requestStart + 1;
        r.responseEnd = r.responseStart + 0.2;
      }
      return c;
    });
  const wide = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0];
  const flakyRun = analyze(
    [
      ...warmStall(rounds("A", 6), wide),
      ...warmStall(rounds("B", 6), wide),
      ...warmStall(rounds("C", 6), [6.2, 6.23, 6.26, 6.2, 6.23, 6.26]),
    ],
    { positiveControlAttached: true },
  );
  const warm = flakyRun.probes.find((p) => p.spec.key === "harness.stallWarmP50Ms");
  assert.equal(warm.spec.family, "protocol");
  assert.equal(warm.separation.separated, true);
  assert.ok(warm.gate.headroomWidths < 1);
  assert.equal(flakyRun.protocolValidated, true, "the suite is validated — that claim survives");
  assert.equal(flakyRun.status, "B-MATCHES-A", "and the finding is still reported");
  assert.equal(flakyRun.gateBlocked, true, "but every validator's threshold would flake, so #102 gets no number");
  assert.deepEqual(flakyRun.usableThresholds, []);
  assert.match(flakyRun.gateBlockedReasons.join(" "), /under one, so the gate would flake/);

  // A probe whose gate IS usable clears the reason, so this cannot become a blanket block.
  const usable = analyze([...rounds("A", 6), ...rounds("B", 6), ...rounds("C", 6, { proxyFired: true })], { positiveControlAttached: true });
  assert.equal(usable.gateBlocked, false);
  assert.ok(usable.usableThresholds.length > 0);
  assert.ok(usable.usableThresholds.every((p) => (p.spec.family ?? "protocol") === "protocol"));
});

test("HEADLINE: a rotated run whose round count is not a multiple of the positions blocks the gate", () => {
  // The same confound as a fixed within-round order, one step weaker, and it used to be a printed
  // NOTE beside a green headline. The rotation only equalizes position when the round count divides
  // by the number of rotated positions; at 4 or 5 rounds one configuration takes the quietest slot
  // more often than the others, which is a per-configuration bias on exactly the axis an A-vs-C
  // separation is read from. Blocking one version of that while printing a note about the other left
  // the cheaper version able to unblock #102.
  const captures = [...rounds("A", 6), ...rounds("B", 6), ...rounds("C", 6, { proxyFired: true })];
  const unbalanced = analyze(captures, { positiveControlAttached: true, roundsBalanced: false });
  assert.equal(unbalanced.protocolValidated, true, "the finding is still reported — it is the GATE that is withheld");
  assert.equal(unbalanced.gateBlocked, true);
  assert.match(unbalanced.gateBlockedReasons.join(" "), /not a multiple of the number of rotated positions/);

  // Declared, never inferred: an unstated schedule is not assumed to be the bad one.
  assert.equal(analyze(captures, { positiveControlAttached: true }).gateBlocked, false);
  assert.equal(analyze(captures, { positiveControlAttached: true, roundsBalanced: true }).gateBlocked, false);

  // and it is moot when the run was not rotated at all — that already blocks for the stronger reason
  const fixedOrder = analyze(captures, { positiveControlAttached: true, rotated: false, roundsBalanced: false });
  assert.equal(fixedOrder.gateBlockedReasons.filter((r) => /not a multiple/.test(r)).length, 0);
});

test("HEADLINE: 'our probes are inadequate' cannot be displaced by a finding", () => {
  // bOutlier is computed per probe, independent of whether the controls ever separated, so a run in
  // which NO protocol probe discriminated could still lead with "OUR STACK IS DISTINGUISHABLE FROM
  // BOTH CONTROLS" — and that headline is what gets quoted into the ticket. It is also the expected
  // shape on a newer Chrome: the discrete probes go quiet while the interception-latency signature
  // stays. The mandatory statement has to survive its own headline slot being taken.
  const captures = [
    ...rounds("A", 6, { stall: 0.2 }),
    ...rounds("B", 6, { stall: 1.6 }),
    ...rounds("C", 6, { stall: 0.2 }),
  ];
  const result = analyze(captures, { positiveControlAttached: true });
  assert.equal(result.status, "FINDING-B-OUTLIER");
  assert.equal(result.probesInadequate, true);
  assert.ok(result.headline.startsWith("OUR PROTOCOL PROBES ARE INADEQUATE"), `headline led with: ${result.headline.slice(0, 60)}`);
  assert.match(result.headline, /DISTINGUISHABLE FROM BOTH CONTROLS/);

  // when a protocol probe DID discriminate, the prefix is absent — it is a statement about validity,
  // not a disclaimer stapled to every finding
  const validated = analyze(
    [...rounds("A", 6, { stall: 0.2 }), ...rounds("B", 6, { stall: 1.6 }), ...rounds("C", 6, { stall: 0.2, proxyFired: true })],
    { positiveControlAttached: true },
  );
  assert.equal(validated.probesInadequate, false);
  assert.ok(!validated.headline.startsWith("OUR PROTOCOL PROBES ARE INADEQUATE"));
});

test("HEADLINE: a discriminating probe with B on the no-protocol side reports B-MATCHES-A", () => {
  const captures = [
    ...rounds("A", 6),
    ...rounds("B", 6),
    ...rounds("C", 6, { proxyFired: true }),
  ];
  const result = analyze(captures, { positiveControlAttached: true });
  assert.equal(result.status, "B-MATCHES-A");
  assert.equal(result.gateBlocked, false);
  const fired = result.probes.find((p) => p.spec.key === "consoleProxy.fired");
  assert.equal(fired.separation.separated, true);
  assert.equal(fired.verdict, "B-matches-A");
  assert.equal(fired.gate.rule, "expect false — fail when the probe reads true");

  // A probe that did NOT discriminate must not be graded, however clean it looks: without
  // separation "B looks like A" is equally true of a probe that measured nothing.
  const dead = result.probes.find((p) => p.spec.key === "errorStack.fired");
  assert.equal(dead.verdict, "INDETERMINATE");
  assert.equal(dead.gate, null);
});

test("HEADLINE: B landing on the naive-automation side is a FINDING, not an instrument failure", () => {
  const captures = [
    ...rounds("A", 6),
    ...rounds("B", 6, { proxyFired: true }),
    ...rounds("C", 6, { proxyFired: true }),
  ];
  const result = analyze(captures, { positiveControlAttached: true });
  assert.equal(result.status, "FINDING-B-MATCHES-C");
  // #101 measures; #102 gates. A real, reproduced finding is data, so the instrument still reports
  // success — the run only fails when the instrument itself did not work.
  assert.equal(result.gateBlocked, false);
  // Every probe that reads the same underlying leak flips together — the boolean, its invocation
  // count, and the collector's quantized copy of the same probe. The finding names all of them.
  assert.deepEqual(
    result.bMatchesC.map((p) => p.spec.key).sort(),
    ["collector.cdp.consoleProxy.fired", "consoleProxy.fired", "consoleProxy.invocations"],
  );
  assert.match(result.headline, /NAIVE-AUTOMATION SIDE/);
});

test("HEADLINE: a positive control that never attached invalidates every negative below it", () => {
  const captures = [
    ...rounds("A", 6),
    ...rounds("B", 6),
    ...rounds("C", 6, { proxyFired: true }),
  ];
  const result = analyze(captures, { positiveControlAttached: false });
  assert.equal(result.status, "INSTRUMENT-FAILED");
  assert.equal(result.gateBlocked, true);
  assert.match(result.headline, /never actually attached/);
});

test("HEADLINE: too few valid captures is an instrument failure, not a thin measurement", () => {
  const captures = [...rounds("A", 6), capture("B"), ...rounds("C", 6, { proxyFired: true })];
  const result = analyze(captures, { positiveControlAttached: true });
  assert.equal(result.status, "INSTRUMENT-FAILED");
  assert.equal(result.gateBlocked, true);
  assert.match(result.headline, /B=1/);
});

test("invalid captures are excluded from the comparison rather than averaged in", () => {
  const broken = capture("B");
  broken.valid = false;
  broken.payload.raw.consoleProxy.fired = true;
  const captures = [...rounds("A", 6), ...rounds("B", 6), broken, ...rounds("C", 6, { proxyFired: true })];
  const result = analyze(captures, { positiveControlAttached: true });
  assert.equal(result.counts.B, 6);
  assert.equal(result.status, "B-MATCHES-A");
});

// ── the dead-leaf and self-consistency guards ─────────────────────────────────────────────────────

test("a leaf that reads null in EVERY configuration is an instrument failure, not a quiet probe", () => {
  // THE FAILURE MODE THIS CLOSES. Rename a leaf upstream — `cdp.fetchProbe.*` becoming
  // `cdp.resourceTiming.*` is exactly the change that happened while this file was written — and
  // every `read` returns undefined, every summary comes back n=0, and the run reports "this probe did
  // not separate the controls". That sentence is indistinguishable from good news.
  const captures = [...rounds("A", 6), ...rounds("B", 6), ...rounds("C", 6, { proxyFired: true })];
  for (const c of captures) delete c.payload.collector.cdp.resourceTiming;

  const result = analyze(captures, { positiveControlAttached: true });
  assert.equal(result.status, "INSTRUMENT-FAILED");
  assert.equal(result.gateBlocked, true);
  assert.match(result.instrumentFailures.join(" "), /collector\.cdp\.resourceTiming\.stallMedianBucket produced NO readings/);
  assert.match(result.instrumentFailures.join(" "), /renamed or removed upstream/);

  // the one probe DOCUMENTED to read empty everywhere is exempt, so a known upstream gap does not
  // masquerade as a broken wire
  const withCollectorOff = deadLeafFailures(result.probes, { withCollector: false });
  assert.equal(withCollectorOff.length, 0, "with the collector disabled, its leaves are absent by request, not by breakage");
  assert.ok(!deadLeafFailures(result.probes).some((f) => f.startsWith("fetch.stallWarmP50Ms")));
});

test("the dead-leaf diagnosis does not assert a cause the same run already disproved", () => {
  // THE CONTRADICTION. The startup leaf-contract check asserts, against the imported source text and
  // before a browser is launched, that every leaf the specs read is still DECLARED upstream. When it
  // has passed, "the leaf has almost certainly been renamed or removed upstream" is a claim the same
  // run refuted a second after it started — and it sends the reader to grep for a name that is right
  // there in the source.
  //
  // The live shape is the opposite and is reachable today: the shipped collector assigns
  // entriesBucket/timedBucket unconditionally but stallMedianBucket/stallMaxBucket only when at
  // least one entry carried usable timing. A page with no timed entries therefore kills exactly the
  // two protocol-family leaves and leaves the two harness comparability leaves alive — so the
  // asymmetry is itself the diagnosis, and the message has to carry it.
  const captures = [...rounds("A", 6), ...rounds("B", 6), ...rounds("C", 6, { proxyFired: true })];
  for (const c of captures) {
    c.payload.collector.cdp.resourceTiming.stallMedianBucket = null;
    c.payload.collector.cdp.resourceTiming.stallMaxBucket = null;
    c.payload.collector.cdp.resourceTiming.timedBucket = "0";
  }
  captures[0].payload.collectorError = "TypeError: cannot read properties of undefined";

  const asserted = analyze(captures, { positiveControlAttached: true, contractsAsserted: true });
  assert.equal(asserted.status, "INSTRUMENT-FAILED", "it still BLOCKS — only the diagnosis changed");
  const text = asserted.instrumentFailures.join(" ");
  assert.match(text, /collector\.cdp\.resourceTiming\.stallMedianBucket produced NO readings/);
  assert.match(text, /DECLARED UPSTREAM BUT NEVER POPULATED, not renamed/);
  assert.doesNotMatch(text, /renamed or removed upstream/);
  // the surviving siblings are named WITH their observed values, because they are the evidence that
  // the section is alive and the assignment is conditional
  assert.match(text, /collector\.cdp\.resourceTiming\.timedBucket A=\{0\}/);
  assert.match(text, /collector\.cdp\.resourceTiming\.entriesBucket A=\{8to32\}/);
  // and the collector's own error count rides along: an erroring collector emits no section at all,
  // which is a different fix from a guarded assignment that never ran
  assert.match(text, /Collector errors were reported in 1\/18 reporting capture\(s\)/);

  // With NO contract assertion behind it the older phrasing is correct and is kept: nothing has
  // established that the name still exists, so "renamed" is a live hypothesis.
  const unasserted = analyze(captures, { positiveControlAttached: true });
  assert.match(unasserted.instrumentFailures.join(" "), /renamed or removed upstream/);

  // A whole section going missing says so instead of blaming one leaf.
  const sectionGone = [...rounds("A", 6), ...rounds("B", 6), ...rounds("C", 6, { proxyFired: true })];
  for (const c of sectionGone) delete c.payload.collector.cdp.resourceTiming;
  const gone = analyze(sectionGone, { positiveControlAttached: true, contractsAsserted: true });
  assert.match(gone.instrumentFailures.join(" "), /No sibling leaf under collector\.cdp\.resourceTiming\.\* produced a reading either/);
});

test("internalConsistencyFailures makes 'UNBLOCKED above NO THRESHOLD OFFERED' impossible", () => {
  // The contradiction a completeness review predicted: the rule that decides "this probe validated
  // the suite" and the rule that decides "this probe can be thresholded" lived in different
  // functions, so a run could print "#102 gate: UNBLOCKED" in one section and, for the same probe,
  // "NO THRESHOLD OFFERED — configuration A produced no observable noise band" in the next. After the
  // resolution-floor change the two are consistent by construction, so this returns nothing on real
  // data — it exists to turn a FUTURE divergence into a blocking failure at the moment it appears.
  const contradiction = {
    spec: { key: "console.proxyMeanMs", family: "protocol" },
    separation: { separated: true, resolutionLimited: false },
    gate: { refused: true, refusedBecause: "no-observed-band" },
  };
  const failures = internalConsistencyFailures([contradiction]);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /counted as a protocol-family validator while its own #102 threshold was REFUSED/);

  // separated AND resolution-limited is the same class of bug from the other direction
  assert.equal(
    internalConsistencyFailures([{ spec: { key: "x", family: "protocol" }, separation: { separated: true, resolutionLimited: true }, gate: null }]).length,
    1,
  );

  // a refused threshold on a probe that did NOT separate is not a contradiction — it is the normal
  // shape of a quiet probe
  assert.deepEqual(
    internalConsistencyFailures([{ spec: { key: "x", family: "protocol" }, separation: { separated: false }, gate: { refused: true } }]),
    [],
  );
  // and a non-protocol family cannot validate anything, so its gate cannot contradict the headline
  assert.deepEqual(
    internalConsistencyFailures([{ spec: { key: "x", family: "harness" }, separation: { separated: true }, gate: { refused: true } }]),
    [],
  );

  // the real analysis carries none of these
  const clean = analyze([...rounds("A", 6), ...rounds("B", 6), ...rounds("C", 6, { proxyFired: true })], { positiveControlAttached: true });
  assert.deepEqual(clean.instrumentFailures, []);
});

// ── focus parity: the check that must not abort the only run that counts ──────────────────────────

test("assessRendererParity accepts a UNIFORM false and blocks a DISAGREEMENT", () => {
  const cap = (config, hasFocus, extra = {}) => ({ config, payload: { meta: { hasFocus } }, extra, round: 1 });

  // The container runs bare `Xvfb -ac -nolisten tcp` with NO window manager: nothing sets the X
  // input focus, PointerRoot is in effect, and document.hasFocus() can legitimately read false in
  // every arm — including configuration A, which has no protocol attached and is therefore the proof
  // that the false is environmental. No differential, no confound. Blocking here would abort the
  // in-container run — the only reading that counts — over a condition that harms nothing.
  const noWm = assessRendererParity(
    [cap("A", false), cap("B", false), cap("C", false, { broughtToFront: true, cdpEvents: { "Runtime.consoleAPICalled": 212 } })],
    [cap("C", false, { broughtToFront: true, cdpEvents: { "Runtime.consoleAPICalled": 212 } })],
  );
  assert.equal(noWm.ok, true);
  assert.equal(noWm.uniformWithoutFocus, true);
  // and it prints enough to tell "no WM" from "bringToFront failed": the parity call CONFIRMED and
  // the consumer was demonstrably live, so a false is about windows, not about attachment
  assert.match(noWm.detail, /bringToFront confirmed/);
  assert.match(noWm.detail, /212 Runtime\.consoleAPICalled/);

  // A per-configuration difference is systematic BY CONFIGURATION, which is the protocol's own
  // shape: an unfocused renderer is deprioritized by the scheduler and every console-cost probe is
  // renderer-side wall clock. That still blocks.
  const disagree = assessRendererParity(
    [cap("A", true), cap("B", true), cap("C", false, { broughtToFront: "Page.bringToFront: Not attached to an active page" })],
    [cap("C", false, { broughtToFront: "Page.bringToFront: Not attached to an active page" })],
  );
  assert.equal(disagree.ok, false);
  assert.equal(disagree.uniformWithoutFocus, false);
  assert.match(disagree.detail, /A=true B=true C=false/);
  assert.match(disagree.detail, /did NOT confirm/, "the reader must be able to tell a failed bringToFront from a missing window manager");

  // a uniform TRUE is fine and is not annotated as the no-WM case
  const focused = assessRendererParity([cap("A", true), cap("B", true), cap("C", true)], [cap("C", true, { broughtToFront: true })]);
  assert.equal(focused.ok, true);
  assert.equal(focused.uniformWithoutFocus, false);

  // a uniform null (document.hasFocus() threw everywhere) is also no differential
  assert.equal(assessRendererParity([cap("A", null), cap("B", null), cap("C", null)]).ok, true);
});

test("assessRendererParity blocks a per-configuration VISIBILITY difference under a uniform focus reading", () => {
  // THE HOLE THE FOCUS FIX OPENED. Accepting a uniform hasFocus=false — correct, because bare Xvfb
  // with no window manager gives nobody focus — retired the only per-configuration renderer-throttling
  // guard, and its sibling reading was never checked anywhere that could block. The arm most able to
  // produce the difference is the one whose parity call is explicitly allowed to fail:
  // `Page.bringToFront` is recorded-not-fatal in configuration C "because the instrument-validity
  // check downstream will catch the resulting mismatch", which under a uniform-false focus reading it
  // no longer did. A hidden renderer gets timer clamping and background priority — a uniform
  // multiplier on C's console-cost timings, which is exactly the shape protocol attachment has, so
  // A|C separates on the console family, protocolValidated goes true and #102 unblocks. The only
  // trace was a soft per-capture warning.
  const cap = (config, visibility) => ({ config, payload: { meta: { hasFocus: false, visibility } }, extra: {}, round: 1 });
  const hiddenC = assessRendererParity([cap("A", "visible"), cap("B", "visible"), cap("C", "hidden")], []);
  assert.equal(hiddenC.ok, false, "a per-configuration visibility difference must block");
  assert.equal(hiddenC.focusOk, true, "and it must block on VISIBILITY, not by accident through focus");
  assert.equal(hiddenC.visibilityOk, false);
  assert.match(hiddenC.detail, /visibilityState A=visible B=visible C=hidden/);

  // uniformly hidden is the no-differential case again: accepted, because the negative control reads
  // the same way as the driven arms (the runner separately notes that the LEVELS are throttled)
  const allHidden = assessRendererParity([cap("A", "hidden"), cap("B", "hidden"), cap("C", "hidden")], []);
  assert.equal(allHidden.ok, true);
  assert.deepEqual(allHidden.visibilityStates, ["hidden"]);

  // and a WITHIN-configuration flip is a difference too: that arm's own rounds are not comparable
  const flip = assessRendererParity(
    [cap("A", "visible"), cap("B", "visible"), cap("C", "visible"), { config: "C", payload: { meta: { hasFocus: false, visibility: "hidden" } }, extra: {}, round: 2 }],
    [],
  );
  assert.equal(flip.ok, false);
});

test("assessRendererParity excludes a capture that carries no meta block instead of reading it as a state", () => {
  // ONE IN-PAGE ERROR ESCALATING A DELIBERATELY SOFT FAILURE INTO A BLOCKING CONFOUND. The fixture's
  // error trap posts `{runId, cfg, fatal}` and nothing else, and that beacon RESOLVES the capture —
  // so the capture is `ok`, reaches this function, and had its absent reading stringified into the
  // literal state "undefined". One page error therefore produced a per-configuration focus
  // DISAGREEMENT: INSTRUMENT-FAILED, #102 blocked, exit 1, blaming a scheduling confound — while the
  // check that actually describes the event (the in-page self-tests) is non-blocking by design.
  const ok = (config) => ({ config, payload: { meta: { hasFocus: false, visibility: "visible" } }, extra: {}, round: 1 });
  const beacon = { config: "B", payload: { runId: "r", cfg: "B", fatal: "ReferenceError: x is not defined" }, extra: {}, round: 2 };

  const parity = assessRendererParity([ok("A"), ok("B"), beacon, ok("C")], []);
  assert.equal(parity.ok, true, "a page error is not a focus disagreement");
  assert.deepEqual(parity.states, ["false"]);
  assert.equal(parity.withoutMeta, 1);
  // excluded, but not silently: the count is in the detail so the beacon is visible as what it is
  assert.match(parity.detail, /1 reporting capture\(s\) carried no meta block and were EXCLUDED/);

  // a REAL disagreement among the captures that do carry meta still blocks
  const stillBlocks = assessRendererParity(
    [ok("A"), beacon, { config: "C", payload: { meta: { hasFocus: true, visibility: "visible" } }, extra: {}, round: 1 }],
    [],
  );
  assert.equal(stillBlocks.ok, false);
});

// ── the B0 arm: what it is FOR ────────────────────────────────────────────────────────────────────

test("the optional guardless arm is reported but never grades the run", () => {
  const captures = [
    ...rounds("A", 6),
    capture("B0"), // deliberately thin: a diagnostic arm must not fail the run
    ...rounds("B", 6),
    ...rounds("C", 6, { proxyFired: true }),
  ];
  const result = analyze(captures, { configs: ["A", "B0", "B", "C"], positiveControlAttached: true });
  assert.equal(result.status, "B-MATCHES-A");
  assert.equal(result.counts.B0, 1);
  const fired = result.probes.find((p) => p.spec.key === "consoleProxy.fired");
  assert.equal(fired.summaries.B0.n, 1);
});

test("attributeToGuard answers epic #92's actual question: the guard, or the driver pipe?", () => {
  // WHY B0 IS ON BY DEFAULT. A B-vs-A separation has two candidate causes that A/B/C alone cannot
  // tell apart — the driver's own pipe and session bookkeeping, or the browser-level Fetch.enable
  // urlPattern "*" our nav guard installs — and they imply different work. B0 holds everything
  // constant and removes only setNavigationGuard.

  // the separation survives removing the guard => it belongs to the driver pipe
  const driverPipe = analyze(
    [
      ...rounds("A", 6, { stall: 0.2 }),
      ...rounds("B0", 6, { stall: 1.5 }),
      ...rounds("B", 6, { stall: 1.6 }),
      ...rounds("C", 6, { stall: 0.2 }),
    ],
    { configs: ["A", "B0", "B", "C"], positiveControlAttached: true },
  );
  const pipeRow = attributeToGuard(driverPipe.probes).find((r) => r.key === "harness.stallWarmP50Ms");
  assert.equal(pipeRow.verdict, "DRIVER-PIPE");
  assert.match(pipeRow.detail, /survives removing the guard/);

  // the guardless arm sits with A => the separation is ours to fix in the guard
  const guardOwned = analyze(
    [
      ...rounds("A", 6, { stall: 0.2 }),
      ...rounds("B0", 6, { stall: 0.2 }),
      ...rounds("B", 6, { stall: 1.6 }),
      ...rounds("C", 6, { stall: 0.2 }),
    ],
    { configs: ["A", "B0", "B", "C"], positiveControlAttached: true },
  );
  const guardRow = attributeToGuard(guardOwned.probes).find((r) => r.key === "harness.stallWarmP50Ms");
  assert.equal(guardRow.verdict, "GUARD-ATTRIBUTABLE");
  assert.match(guardRow.detail, /attributable to the navigation guard/);

  // and with no B0 arm the question is UNRESOLVED rather than quietly omitted
  const noB0 = analyze([...rounds("A", 6, { stall: 0.2 }), ...rounds("B", 6, { stall: 1.6 }), ...rounds("C", 6, { stall: 0.2 })], {
    positiveControlAttached: true,
  });
  const unresolved = attributeToGuard(noB0.probes).find((r) => r.key === "harness.stallWarmP50Ms");
  assert.equal(unresolved.verdict, "UNRESOLVED");
  assert.match(unresolved.detail, /cannot be attributed to the Fetch guard/);
});

test("attributeToGuard never states a causal verdict from a comparison it could not make", () => {
  // TWO WAYS THE ROW USED TO ASSERT MORE THAN IT KNEW.
  //
  // 1. `sep.separated ? "DRIVER-PIPE" : "GUARD-ATTRIBUTABLE"` — a binary over a THREE-valued answer.
  //    `separated:false` also covers `resolutionLimited:true`, i.e. "the guardless arm produced no
  //    observable band above the probe's floor, so the comparison was never made". Printed as
  //    GUARD-ATTRIBUTABLE, that reads "the separation is attributable to the navigation guard's
  //    Fetch.enable" — the exact res-vs-no conflation the comparison table was fixed to stop.
  const flatB0 = analyze(
    [
      // A carries a band; B0 repeats one value every round, so A-vs-B0 is resolution-limited while
      // A-vs-B separates cleanly. Round 0 for every B0 capture removes the fixture's jitter.
      ...rounds("A", 6, { stall: 0.2 }),
      ...Array.from({ length: 6 }, () => capture("B0", { stall: 0.2 }, 0)),
      ...rounds("B", 6, { stall: 1.6 }),
      ...rounds("C", 6, { stall: 0.2 }),
    ],
    { configs: ["A", "B0", "B", "C"], positiveControlAttached: true },
  );
  const flatRow = attributeToGuard(flatB0.probes).find((r) => r.key === "harness.stallWarmP50Ms");
  assert.equal(flatRow.separation.resolutionLimited, true);
  assert.equal(flatRow.verdict, "UNRESOLVED", "an unmade comparison is not evidence that the guard owns the signal");
  assert.match(flatRow.detail, /RESOLUTION-LIMITED/);
  assert.doesNotMatch(flatRow.detail, /attributable to the navigation guard/);

  // 2. A THIN B0 IS NOT AN ABSENT ONE. Both used to print "no B0 arm in this run
  //    (CDP_BASELINE_NOGUARD=0)" — false when the arm ran, and it points the operator at a setting
  //    they never touched instead of at the captures that failed.
  const thinB0 = analyze(
    [...rounds("A", 6, { stall: 0.2 }), capture("B0", { stall: 0.2 }), ...rounds("B", 6, { stall: 1.6 }), ...rounds("C", 6, { stall: 0.2 })],
    { configs: ["A", "B0", "B", "C"], positiveControlAttached: true },
  );
  const thinRow = attributeToGuard(thinB0.probes).find((r) => r.key === "harness.stallWarmP50Ms");
  assert.equal(thinRow.verdict, "UNRESOLVED");
  assert.match(thinRow.detail, /RAN but produced only n=1 valid capture/);
  assert.doesNotMatch(thinRow.detail, /CDP_BASELINE_NOGUARD=0 drops it/, "the arm ran — do not blame a setting the operator did not use");
});

test("analyzeProbe grades a numeric probe end to end, including the #102 threshold", () => {
  const spec = { key: "fetch.stallWarmP50Ms", kind: "numeric", unit: "ms", floor: 0.1, note: "", read: () => null };
  const graded = analyzeProbe(spec, {
    // both arms carry a band wider than the probe's declared 0.1ms floor, which is now a
    // precondition for the comparison being made at all
    A: [0.20, 0.28, 0.35],
    B: [0.21, 0.29, 0.34],
    C: [1.90, 1.95, 2.05],
  });
  assert.equal(graded.separation.separated, true);
  assert.equal(graded.verdict, "B-matches-A");
  assert.ok(graded.gate.threshold > 0.35 && graded.gate.threshold < 1.9);
  assert.match(graded.gate.rule, /fail when the value is > /);
});

// ── the probe specification's own invariants ──────────────────────────────────────────────────────

test("every probe declares the provenance of any constant a threshold could rest on", () => {
  // The floors are not inert: before the fix, the separation rule used one as a SUBSTITUTE for an
  // unmeasured noise band, so a constant chosen on a macOS smoke run of n=2-3 decided whether a probe
  // separated. They are now declared, and `recommendGate` refuses any threshold whose margin would be
  // counted in widths of a provisional one. A floor with no declared provenance would slip that.
  for (const spec of PROBE_SPECS) {
    if (spec.kind !== "numeric") continue;
    assert.ok(spec.floor > 0, `${spec.key} has no floor`);
    assert.ok(spec.floorBasis, `${spec.key} declares a floor with no provenance`);
    assert.match(spec.floorBasis, /PROVISIONAL|EXACT/, `${spec.key}: floor provenance must say whether it was measured or is exact`);
    // the discrete exemption is only defensible for an exact quantum
    if (spec.discrete) assert.match(spec.floorBasis, /EXACT/, `${spec.key} claims the discrete exemption on a provisional floor`);
  }
  // and the counts that carry the suite are the ones flagged discrete
  const discrete = PROBE_SPECS.filter((s) => s.discrete).map((s) => s.key).sort();
  assert.deepEqual(discrete, [
    "consoleProxy.invocations",
    "consoleTiming.getterInvocations",
    "controls.cdcKeys",
    "controls.playwrightKeys",
    "controls.puppeteerKeys",
  ]);
});

test("only the protocol family can validate the suite, and the confounded probe is not in it", () => {
  const families = new Set(PROBE_SPECS.map((s) => s.family ?? "protocol"));
  assert.deepEqual([...families].sort(), ["context", "control", "harness", "protocol"]);
  const cold = PROBE_SPECS.find((s) => s.key === "harness.stallColdP50Ms");
  assert.equal(cold.family, "context");
  assert.ok(cold.confound.includes("browser age"), "a demoted probe must name what confounds it");
  // the fixture server's own latency stays out too — that is this harness measuring itself
  for (const key of ["harness.ttfbP50Ms", "fetch.wallP50Ms", "harness.dispatchP50Ms"]) {
    assert.equal(PROBE_SPECS.find((s) => s.key === key).family, "harness");
  }
});

// ── the effect ranking, which is what surfaces what the separation test suppresses ────────────────

test("rankEffects surfaces a large B-vs-A effect the separation test declined to call separated", () => {
  // This section is the only place a big-but-inconsistent effect appears at all: the separation
  // verdict is deliberately conservative, so an effect whose rounds interleave with the control's
  // reports "no" and would otherwise vanish from the report entirely. Shapes taken from a real smoke
  // run's warm pre-dispatch stall (provisional).
  const spec = { key: "harness.stallWarmMeanMs", kind: "numeric", unit: "ms", floor: 0.05, family: "protocol", note: "", read: () => null };
  const jittery = analyzeProbe(spec, {
    A: [0.05, 0.10, 0.15],
    B: [0.10, 4.0, 13.0], // B's best round lands inside A's band, so the ranges overlap
    C: [0.05, 0.10, 0.15],
  });
  assert.equal(jittery.separationAB.separated, false, "overlapping ranges must not report as separated");

  const rows = rankEffects([jittery]);
  assert.equal(rows.length, 1, "a ~40x effect must not disappear because the separation test said no");
  assert.equal(rows[0].key, "harness.stallWarmMeanMs");
  assert.equal(rows[0].separated, false);
  assert.ok(rows[0].ratio > 10);
  assert.match(rows[0].reason, /overlap/);

  // an effect that IS separated still ranks, and says so
  const clean = analyzeProbe(spec, { A: [0.05, 0.10, 0.15], B: [1.039, 4.139, 13.622], C: [0.05, 0.10, 0.15] });
  const cleanRows = rankEffects([clean]);
  assert.equal(cleanRows.length, 1);
  assert.equal(cleanRows[0].separated, true);

  // and a probe that moved nothing is not padded into the list
  assert.deepEqual(rankEffects([analyzeProbe(spec, { A: [0.10, 0.11], B: [0.10, 0.11], C: [0.10, 0.11] })]), []);
});

// ── what leaves this process ──────────────────────────────────────────────────────────────────────

test("the JSON record cannot carry the host's public IP out of the run", () => {
  // With the collector on, every capture serializes a full fingerprint snapshot — including WebRTC
  // ICE candidates, whose srflx line contains the host's public address. A smoke run's output file
  // contained exactly that, and this record is written to be pasted into a ticket in a PUBLIC repo.
  const record = {
    captures: [{
      payload: {
        collector: {
          userAgent: "Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36",
          href: "http://127.0.0.1:5511/probe?run=x",
          webrtc: { total: 2, srflxCount: 1, srflx: ["candidate:1528091227 1 udp 1677729535 203.0.113.37 56959 typ srflx raddr 0.0.0.0 rport 0"] },
        },
      },
    }],
    analysis: {
      environmentDiffAB: [
        { path: "webrtc.srflx", a: ["203.0.113.37"], b: ["198.51.100.9"], severity: "info" },
        { path: "userAgent", a: "Chrome/150.0.0.0", b: "Chrome/150.0.0.1", severity: "high" },
      ],
    },
    startedAt: "2026-08-04T22:45:12.000Z",
  };
  const out = JSON.stringify(redactDeep(record));
  assert.ok(!out.includes("203.0.113.37"), "the srflx candidate's address must not survive");
  assert.ok(!out.includes("198.51.100.9"), "nor the same axis inside an environment-diff entry");
  assert.match(out, /<redacted-ip>/);

  // SCOPED, not blanket: a Chrome version is a valid IPv4 literal by shape, and redacting it would
  // corrupt the axis the environment diff exists to report. Loopback and timestamps stay readable.
  assert.ok(out.includes("Chrome/150.0.0.0"), "a user-agent version string is not an address");
  assert.ok(out.includes("127.0.0.1:5511"), "the fixture URL must stay legible");
  assert.ok(out.includes("2026-08-04T22:45:12.000Z"), "an ISO timestamp is not an IPv6 address");
});

test("redactIps keeps the literals that carry no information about the host", () => {
  assert.equal(redactIps("bound to 127.0.0.1 and 192.168.1.20 and 10.0.0.5"), "bound to 127.0.0.1 and 192.168.1.20 and 10.0.0.5");
  assert.equal(redactIps("srflx 203.0.113.37 rport 0"), "srflx <redacted-ip> rport 0");
  assert.equal(redactIps("v6 2001:0db8:85a3:0000:0000:8a2e:0370:7334"), "v6 <redacted-ip>");
  assert.equal(redactIps("link-local fe80:0000:0000:0000:0202:b3ff:fe1e:8329"), "link-local fe80:0000:0000:0000:0202:b3ff:fe1e:8329");
});

// ── the embedding contract with #100's probe sources ──────────────────────────────────────────────

test("the shipped probe sources can still be embedded verbatim in the fixture page", () => {
  // The baseline inlines these strings inside a template literal inside an HTML <script>. A
  // backtick, a `${`, or a `</script` added upstream would corrupt the embedded copy into something
  // that still parses and measures something else — a silent failure with no error to notice.
  assertEmbeddable("CDP_TIMING_RAW_JS", CDP_TIMING_RAW_JS);
  assertEmbeddable("FINGERPRINT_COLLECTOR_JS", FINGERPRINT_COLLECTOR_JS);
  assert.throws(() => assertEmbeddable("x", "a `b`"), /backtick/);
  assert.throws(() => assertEmbeddable("x", "a ${b}"), /template placeholder/);
  assert.throws(() => assertEmbeddable("x", "a </script> b"), /would terminate/);
  assert.throws(() => assertEmbeddable("x", ""), /non-empty/);
});

test("declaredLeafPaths / assertLeafContract fail LOUDLY on a renamed leaf", () => {
  // The startup half of the dead-leaf guard, tested against synthetic sources so it pins the RULE
  // rather than today's build output.
  const src = "const report = { fetchProbe: { stallSummary: null } };\nreport.fetchProbe.stallSummary = summarize(x);\nreport.controls.webdriver = nav.webdriver;";
  assert.deepEqual([...declaredLeafPaths(src, "report")].sort(), ["controls.webdriver", "fetchProbe.stallSummary"]);

  assert.doesNotThrow(() => assertLeafContract("S", src, "report", [["fetchProbe", "stallSummary"], ["controls", "webdriver"]]));

  // a renamed leaf is named, and so is what the source DOES declare, so the fix is one line
  assert.throws(
    () => assertLeafContract("S", src, "report", [["fetchProbe", "wallSummary"]]),
    (err) => {
      assert.match(err.message, /no longer declares/);
      assert.match(err.message, /fetchProbe\.wallSummary \(section found, leaf MISSING\)/);
      assert.match(err.message, /currently declares: controls\.webdriver, fetchProbe\.stallSummary/);
      // and the message says WHY it matters, because the symptom is a clean-looking negative
      assert.match(err.message, /did not separate the controls/);
      return true;
    },
  );

  // a whole section renamed is caught the same way
  assert.throws(() => assertLeafContract("S", src, "report", [["resourceTiming", "stallMedianBucket"]]), /section MISSING/);

  // an object-literal declaration the dotted scan cannot see is accepted LOOSELY and reported, not
  // silently: the collector legitimately writes some leaves that way
  const literal = "const cdp = { resourceTiming: { stallMedianBucket: null, durationMedianBucket: null } };\ncdp.resourceTiming = rt;";
  const loose = assertLeafContract("C", literal, "cdp", [["resourceTiming", "stallMedianBucket"]]);
  assert.deepEqual(loose.loose, ["resourceTiming.stallMedianBucket"]);
});

test("the imported probe's cache-buster token is a checked contract, not an assumption", () => {
  // THE SECOND CROSS-FILE CONTRACT, and it was the undeclared one. The leaf contract covers the shape
  // of the probe's RESULT; this covers the shape of its TRAFFIC. `meta.resourceTiming` is built by
  // filtering performance.getEntriesByType('resource') on this token, and that recovered list is the
  // ONLY source of pre-dispatch latency in the run — the imported probe reads its own entries before
  // Chrome queues them at responseEnd. Rename the parameter upstream and every capture in every arm
  // recovers zero rows: the whole Fetch-interception family, the one family that survives the V8
  // fixes retiring the discrete probes, reports "did not separate the controls". Unchecked, that
  // surfaced twenty minutes into a container run; checked, it costs one second.
  assert.doesNotThrow(() => assertCacheBusterContract(CDP_TIMING_RAW_JS));
  assert.throws(() => assertCacheBusterContract("const url = origin + '/favicon.ico?nocache=' + i;"), /no longer marks its sub-resource fetches/);
  assert.throws(() => assertCacheBusterContract(""), /non-empty/);

  // and the page script filters on the SAME token rather than a second literal that could drift
  assert.ok(buildPageScript({ withCollector: false }).includes("indexOf('bgwfp=')"));
});

test("the imported probe sources still declare every leaf this baseline reads", () => {
  // THE REAL CONTRACT, against the built sources. This is the check that runs at startup before a
  // browser is launched, and it is the one that catches an upstream rename in the ~20 minutes before
  // a container run would otherwise spend them producing nulls and reporting "no separation".
  //
  // It fails until dist/ is rebuilt from a src/browser/fingerprint.ts that (a) has moved the ACTIVE
  // favicon fetch probe out of FINGERPRINT_COLLECTOR_JS into CDP_TIMING_RAW_JS and (b) exposes the
  // collector's passive resource timings as cdp.resourceTiming.*. A failure here naming
  // `resourceTiming` is that rebuild being pending, not a defect in the analysis.
  assert.doesNotThrow(() => assertProbeContracts({ withCollector: true }));
  assert.ok(RAW_LEAF_CONTRACT.length > 0 && COLLECTOR_LEAF_CONTRACT.length > 0);
});

test("the fixture page carries both probe sources verbatim and reports through the non-protocol channel", () => {
  // withCollector is passed EXPLICITLY: buildPageScript defaults it from CDP_BASELINE_COLLECTOR, and
  // a contract test whose shape changes with the environment it runs under is not a contract.
  const page = buildPageScript({ withCollector: true });
  assert.ok(page.includes(CDP_TIMING_RAW_JS), "the raw timing probe must be the imported source, not a re-authored copy");
  assert.ok(page.includes(FINGERPRINT_COLLECTOR_JS), "the collector must be the imported source, not a re-authored copy");
  // The result leaves the page over HTTP, never over the protocol — that is the whole reason
  // configuration A, which has no protocol to read it out with, can be measured at all.
  assert.ok(page.includes("fetch('/report'"), "the report must leave over the fixture's own HTTP channel");
  assert.ok(page.includes("navigator.sendBeacon('/report'"), "a torn-down page must still be able to deliver its result");
  // The in-page delay is what keeps configuration B's post-navigation protocol burst out of the
  // measurement window; a page script that lost it would quietly measure the driver's settle.
  assert.match(page, /setTimeout\(r, \d+\)/);

  // Dropping the collector must drop the collector, not silently embed it under a different name.
  const withoutCollector = buildPageScript({ withCollector: false });
  assert.ok(!withoutCollector.includes(FINGERPRINT_COLLECTOR_JS));
  assert.ok(withoutCollector.includes(CDP_TIMING_RAW_JS), "the raw probe is not optional");
});

test("configuration A's warm-up page hands the SAME run to the probe URL and measures nothing itself", () => {
  // A's fixture load used to be browser startup — profile creation, network-service bring-up, GPU
  // init and the page load overlapping — while B and C both had a live browser before their page
  // began. The smoke runs showed connection-setup stalls reading 1.4-2x HIGHER in A, the arm with
  // NOTHING attached, than in C, the arm with a debugging port: a cold-start penalty landing on the
  // level and the spread of the arm whose spread the separation rule uses as its noise band.
  const page = buildWarmupPage(1500);
  assert.match(page, /setTimeout\(function\(\)\{location\.replace\('\/probe'\+location\.search\)\},1500\)/);
  // It must not touch anything the probes read: no console traffic, no fetch, no timing API.
  assert.ok(!/console\.|fetch\(|performance\./.test(page), `the warm-up page must stay inert: ${page}`);
});

// ── the production-reachability boundary the ticket got wrong ──────────────────────────────────────

test("configuration C is unreachable from a production launch — but NOT because assertLocalCdpOnly blocks a port", () => {
  // Documented reality. #101's acceptance criterion asks for a test asserting that
  // assertLocalCdpOnly "still rejects the debugging-port configuration". It never has: the guard
  // inspects --remote-debugging-ADDRESS only. Writing a test that pretended otherwise would encode
  // a false belief about where the boundary is.
  assert.throws(() => assertLocalCdpOnly(["--remote-debugging-address=0.0.0.0"]), /non-local/);
  assert.doesNotThrow(() => assertLocalCdpOnly(["--remote-debugging-port=9222"]));
  assert.doesNotThrow(() => assertLocalCdpOnly(["--remote-debugging-port=0"]));

  // The REAL boundary, and the one worth regression-guarding: the core CONSTRUCTS its arg list, and
  // BrowserCoreOptions exposes no passthrough, so no caller — verb, drive(), MCP tool or CLI — can
  // put a debugging port on the command line. Configuration C reaches one only by spawning the
  // Chrome binary itself, entirely outside the core.
  const optionSets = [
    {},
    { noSandbox: true },
    { headless: true },
    { channel: "" },
    { channel: "chrome", noSandbox: true },
    { proxy: { server: "http://proxy.example:8080", username: "u", password: "p" } },
  ];
  for (const opts of optionSets) {
    const args = buildLaunchOptions(resolveCoreOptions(opts)).args ?? [];
    assert.ok(
      !args.some((a) => a.startsWith("--remote-debugging")),
      `buildLaunchOptions emitted a debugging switch for ${JSON.stringify(opts)}: ${args.join(" ")}`,
    );
  }

  // No args passthrough: an extra `args` key is dropped on the floor rather than forwarded.
  const resolved = resolveCoreOptions({ args: ["--remote-debugging-port=9222"], channel: "chrome" });
  assert.ok(!("args" in resolved));
  const launched = buildLaunchOptions(resolved).args ?? [];
  assert.ok(!launched.some((a) => a.startsWith("--remote-debugging")));
});
