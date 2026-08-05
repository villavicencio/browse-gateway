#!/usr/bin/env node
/**
 * Three-way CDP-presence baseline (#101, epic #92 — blocks the gate ticket #102).
 *
 * WHAT IT ANSWERS. #100 built the probes; it could not tell us whether they measure anything,
 * because every reading it can produce on our own stack is a negative, and a negative with no
 * positive control is indistinguishable from a broken probe. This script supplies the controls:
 *
 *   A — NO PROTOCOL.       Real Chrome, headful under Xvfb, spawned directly from the binary with a
 *                          fresh profile and the fixture as its startup URL. No driver, no CDP
 *                          consumer, no debugging port. The floor: what an undriven browser looks like.
 *   B — OUR STACK.         createBrowserCore() — Patchright over its driver pipe, plus the browser-level
 *                          session the nav guard needs (Fetch.enable urlPattern "*" +
 *                          Target.setAutoAttach). What we actually ship.
 *   C — NAIVE AUTOMATION.  The same binary spawned with --remote-debugging-port=0, a raw WebSocket
 *                          protocol client attached to the page target, Runtime.enable sent, then
 *                          Page.navigate. The ceiling: obvious automation.
 *
 * and then asks, per probe: is B closer to A or to C?
 *
 * THE SINGLE CHECK THAT MATTERS. If C does not separate from A on AT LEAST ONE probe, the honest
 * conclusion is "our probes are inadequate", NOT "we are clean". That branch is real: it prints as
 * the headline, marks the #102 gate BLOCKED, and exits non-zero. It is also reachable for a mundane
 * reason — the one live probe in this family (the prototype-chain Proxy ownKeys trap) is a V8 bug
 * with an upstream fix already landed, so on a new enough Chrome every discrete probe here goes
 * quiet and this script must say "inadequate" rather than "green". Chrome's major version is
 * recorded in every capture so that case is legible instead of mysterious.
 *
 * A separation carried ONLY by a crude control does not count. Measured on Chrome 150 (provisional),
 * attaching a debugging port flips `navigator.webdriver` even with no --enable-automation switch — so
 * a run in which every protocol probe was dead could still show "one probe discriminated" and look
 * validated. Probes therefore carry a family, and only the protocol family can unblock #102. The
 * family tag is also what keeps FIXTURE latency out of the validation: the fixture server's own TTFB
 * and the end-to-end fetch wall time both live in this process, so a busier arm inflates them by the
 * instrument's own doing. They are recorded as `harness`, never as evidence that a probe works.
 *
 * A FOURTH FAMILY, `context`, EXISTS FOR THE SAME REASON ONE LEVEL DOWN: a probe that measures a real
 * browser-side quantity but is CONFOUNDED BY CONFIGURATION. The cold-connection pre-dispatch stall is
 * the case that forced it. Its samples are the ones that had to open a socket, so they are dominated
 * by whatever else the browser was doing in its first seconds — and the three arms do not reach their
 * probe page with the same amount of browser life behind them (A is spawned onto its startup URL; B
 * comes up through a driver handshake; C through DevToolsActivePort + websocket + attach). A verifier
 * measured configuration A running 1.4-2x SLOWER than C on it purely from cold start, and the /warmup
 * page added to fix that then over-corrected the other way. A number that has flipped sign twice for
 * reasons that have nothing to do with the protocol must not be able to validate the probe suite, so
 * it is reported with its numbers — and with each arm's measured browser age at probe time printed
 * beside it — and is barred from `protocolValidated`. `context` is not a soft `protocol`: for the
 * gate it counts exactly as `harness` does, i.e. not at all.
 *
 * AND THE TICKET'S AXIS IS NOT THE WHOLE ANSWER. "Is B closer to A or to C" presumes the two controls
 * differ. For request-interception latency they do not: naive automation does not intercept requests,
 * so C has no more pre-dispatch delay than A, and an A-vs-C test reports INDETERMINATE no matter what
 * B does. Measured on Chrome 150 (provisional) the warm pre-dispatch stall read A 0.17ms / C 0.17ms /
 * B 1.6ms — a signature UNIQUE to our stack that the ticket's framing cannot express. Every probe is
 * therefore also tested B-vs-A and B-vs-C, and "separated from BOTH controls" is its own headline
 * outcome.
 *
 * PROVENANCE OF EVERY "Measured on Chrome 150" NUMBER IN THIS FILE. They come from macOS smoke runs
 * of this script in its DOUBLY CONFOUNDED mode — CDP_BASELINE_HEADLESS=1 (the shipping vehicle is
 * headful) and argSource="constructed-fallback" (no /proc, so A and C did NOT carry Playwright's ~35
 * default switches) — over 2-3 rounds. Every one of them is therefore marked "(provisional)" at its
 * use site and none of them may be quoted into #102: the reading that counts is the in-container
 * headful run, whose numbers arrive in the run output and the JSON record, not in this comment block.
 *
 * AND THE PROVENANCE IS ENFORCED, NOT MERELY LABELLED. The per-probe `floor` values were chosen on
 * those same smoke runs, and a floor is not inert: the old separation rule used it as a SUBSTITUTE
 * for an unmeasured noise band (`max(min(spreadA, spreadC), floor)`), so a probe whose arms both read
 * the same value every round separated on a bar of 2x a constant somebody guessed on a MacBook. For
 * console.proxyMeanMs that bar was 0.01ms — on a clock Chrome coarsens to ~100us. Two rules now stop
 * a provisional constant from becoming a #102 threshold: a CONTINUOUS probe's arms must each show a
 * spread ABOVE the declared floor before they can be compared at all (`separateNumeric`), and
 * `recommendGate` REFUSES any numeric threshold whose headroom would be counted in floor widths
 * rather than in measured ones. The floor's only remaining job on a continuous probe is to say when
 * the comparison is resolution-limited; it can never stand in for a measurement. DISCRETE probes
 * (integer counts: ownKeys invocations, expando key counts) are exempt and say so per spec: their
 * floor of 0.5 is half of an exact quantum, not a guess, and a zero spread there means "the same
 * integer every round", which is reproducibility rather than an unresolvable band.
 *
 * THE TWO CONTROLS ARE MATCHED, NOT MERELY SPAWNED. Anything that differs systematically BY
 * CONFIGURATION lands on the same axis the protocol would, and every timing probe here is host-load
 * and scheduling sensitive. Two such asymmetries were measured and are now equalized rather than
 * disclaimed: configuration A used to be cold-started INTO the measurement (its fixture load WAS
 * browser startup, while B and C had a live browser before their page began), so A now loads a
 * /warmup page first and holds a fixed wall-clock before replacing itself with the probe URL; and
 * configuration C's renderer used to be unfocused in every capture (it attaches to a pre-existing
 * about:blank target rather than owning the startup window), so C now sends Page.bringToFront — one
 * more protocol call in the arm that is defined by having a protocol, which costs nothing in channel
 * terms. A residual per-configuration mismatch in EITHER renderer-scheduling reading — hasFocus or
 * visibilityState — is an INSTRUMENT FAILURE, not a printed note. Both are checked because they are
 * independent: the container's bare Xvfb legitimately gives nobody focus, so a uniform hasFocus=false
 * is accepted, and accepting it is exactly what would let a per-configuration `hidden` renderer (with
 * its clamped timers and background priority) pass as a protocol signature on the console family.
 *
 * THE MEASUREMENT-CHANNEL PROBLEM, AND WHY THE PAGE REPORTS ITSELF. The obvious way to read a probe
 * out of a page is page.evaluate — which IS a protocol call, and would destroy the very property
 * configuration A exists to represent. So the result never leaves through the protocol: one local
 * http.createServer serves ONE fixture page that inlines the probe sources verbatim and POSTs its
 * own result back to /report on the same server. Same fixture, same probe bytes, same exit channel
 * in all three configurations. The only thing that varies is what is attached to the browser.
 *
 * A SECOND, UNPLANNED BENEFIT OF THAT CHANNEL: the probes run in the page's MAIN world here, not in
 * the isolated world page.evaluate uses. #100 flagged that its cdcKeys / puppeteerKeys /
 * playwrightKeys scans are structurally blind to main-world expandos. In this harness they are not.
 *
 * PROBE SOURCE IS IMPORTED, NEVER RE-AUTHORED. CDP_TIMING_RAW_JS and FINGERPRINT_COLLECTOR_JS come
 * from the built browser module, so this baseline and the shipped collector can never drift into
 * measuring two different things. What they ARE is a contract, though, not an assumption: the leaves
 * this file reads out of both sources are declared in RAW_LEAF_CONTRACT / COLLECTOR_LEAF_CONTRACT and
 * asserted against the source text before a browser is launched, because a leaf renamed upstream
 * reads as undefined in every arm and reports as "the probe did not separate the controls".
 *
 * LAUNCH-ARG PARITY IS MEASURED, NOT ASSUMED. Hand-writing "the same args as Playwright" is a lie
 * that survives review. Instead a CALIBRATION step launches configuration B once, finds its browser
 * process by the --user-data-dir we handed it, and reads the REAL argv out of /proc. A and C are
 * then spawned from that exact argv (same binary, same ~35 switches) with only the profile dir and
 * the debugging transport changed. The removed/added switches are printed as the exact residual
 * delta. Where /proc is unavailable (a non-Linux dev run) the script falls back to args built from
 * buildLaunchOptions() and SAYS SO, because in that mode Playwright's default switches are absent
 * from A and C and the residual delta is genuinely unmeasured.
 *
 * WHAT THIS IS NOT. It is not a gate and it changes no production behavior. It exits non-zero only
 * when the INSTRUMENT failed — no separation between the controls, a positive control that never
 * actually attached, self-tests that did not fire, too few valid captures to compare, or any of the
 * instrument-validity checks below failing. Those checks BLOCK; they do not merely print. An earlier
 * revision printed "FAIL console.debug is native code in every configuration" forty lines above a
 * green headline and exited 0 — i.e. the one check written to catch "we measured a dead sink, not an
 * unattached protocol" could not affect the answer. Every check that can make the columns
 * incomparable now sets INSTRUMENT-FAILED and blocks #102. An unflattering finding (B sitting on C's
 * side of a real probe) is DATA: it prints as a CRITICAL finding and still exits 0, because #102 is
 * the ticket that acts on it. Set CDP_BASELINE_STRICT=1 to make a B-matches-C verdict fail too.
 *
 * CONFIGURATION C IS A TEST FIXTURE AND CANNOT BE REACHED FROM PRODUCTION — but not for the reason
 * the ticket assumed. `assertLocalCdpOnly` (src/security/cdp.ts) rejects only
 * `--remote-debugging-address=<non-local>`; it does not look at `--remote-debugging-port` at all.
 * The actual boundary is that `BrowserCoreOptions` has NO args passthrough: `buildLaunchOptions`
 * CONSTRUCTS the arg list from a fixed set (WebRTC policy + SwiftShader + optional --no-sandbox), so
 * no caller can inject a debugging port. C reaches the port by spawning the Chrome binary itself,
 * entirely outside the core. test/cdp-baseline.test.mjs locks that real boundary; it deliberately
 * does NOT assert that assertLocalCdpOnly rejects a port, because it never has.
 *
 * RUN IT
 *   in-container (the reading that counts — headful Chrome under Xvfb, the shipping vehicle):
 *     docker build --platform linux/amd64 -f docker/Dockerfile -t browse-gateway:cdp-baseline .
 *     docker run --rm --platform linux/amd64 --shm-size=1g --init browse-gateway:cdp-baseline \
 *       node scripts/measure-cdp-baseline.mjs
 *   locally (needs a built dist/ and a real Chrome; /proc is absent on macOS so arg parity degrades):
 *     npm run build && node scripts/measure-cdp-baseline.mjs
 *
 * ENV
 *   CDP_BASELINE_ROUNDS=<n>       interleaved rounds, default 6 — a MULTIPLE OF THREE, because the
 *                                 rotation spreads three graded configurations across three
 *                                 within-round positions and a round count that does not divide by
 *                                 three leaves one configuration over-represented in the early
 *                                 (colder, quieter) slot. A non-multiple is still MEASURED but it
 *                                 BLOCKS the #102 gate, exactly as CDP_BASELINE_ROTATE=0 does: the
 *                                 bias it leaves behind is on the same axis the gate is read from.
 *                                 Minimum 2 for any variance figure at all,
 *                                 and the separation rule now needs an OBSERVED band in both arms —
 *                                 so few rounds is how a real effect reports as resolution-limited.
 *   CDP_BASELINE_OUT=<path>       write the full structured record as JSON here (default: no file).
 *                                 Public IP literals (the collector's WebRTC srflx candidates above
 *                                 all) are redacted on the way out — this record is meant to be
 *                                 pasted into a ticket in a PUBLIC repo.
 *   CDP_BASELINE_STRICT=1         also exit non-zero when any probe verdicts B-matches-C
 *   CDP_BASELINE_HEADLESS=1       run all three headless (a CONFOUND — the shipping vehicle is headful)
 *   CDP_BASELINE_COLLECTOR=0      skip FINGERPRINT_COLLECTOR_JS (drops the ~8s WebRTC gather per
 *                                 capture, and with it the A-vs-B environment diff)
 *   CDP_BASELINE_NOGUARD=0        DROP the B0 arm — our stack with NO navigation guard, i.e. the
 *                                 driver pipe WITHOUT Fetch.enable. B0 is ON BY DEFAULT because epic
 *                                 #92's actual question is not "does B separate from A" but "how much
 *                                 of that separation does OUR FETCH GUARD add, versus the driver pipe
 *                                 alone" — and without B0 the run cannot attribute it at all. It
 *                                 costs one extra capture per round (~+33% wall clock: one more
 *                                 headful launch, page load, probe budget and teardown), which is the
 *                                 cheapest attribution available: the alternative is a second full
 *                                 run with a different guard setting, i.e. +100% and no interleaving.
 *                                 B0 is a DIAGNOSTIC — never graded, never counted toward the #102
 *                                 gate, and deliberately outside the rotation (see the ordering note
 *                                 in `main`). Dropping it prints the attribution as UNRESOLVED.
 *   CDP_BASELINE_ROTATE=0         run the fixed ABC order within every round instead of rotating.
 *                                 Rotation is ON by default and turning it off BLOCKS the #102 gate:
 *                                 with A always first and C always third, any within-round drift on
 *                                 this host maps directly onto an "A-vs-C separation", which is the
 *                                 exact reading that would unblock the gate.
 *   CDP_BASELINE_DELAY_MS=<n>     in-page wait before probing, default 6000 (see PROBE_DELAY below)
 *   CDP_BASELINE_WARMUP_MS=<n>    how long configuration A holds on the /warmup page before replacing
 *                                 itself with the probe URL, default 1500. This is what equalizes
 *                                 browser age at probe time across the three arms; 0 disables it and
 *                                 restores the cold-started-A confound.
 *   CDP_BASELINE_REPORT_TIMEOUT_MS=<n>  per-capture wait for the page's report. Default is derived
 *                                 from the probe budgets; raise it for a slow emulated container run
 *                                 rather than reading the resulting timeout as a silent page.
 *   BGW_CHROME_PATH=<path>        Chrome binary for A and C (default: whatever calibration measured,
 *                                 else the usual install locations)
 *   BGW_NO_SANDBOX=1              pass --no-sandbox (root in container)
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, access } from "node:fs/promises";
import { constants as FS } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import {
  createBrowserCore,
  FINGERPRINT_COLLECTOR_JS,
  CDP_TIMING_RAW_JS,
  buildLaunchOptions,
  resolveCoreOptions,
  diffFingerprints,
} from "../dist/browser/index.js";

// ═══ configuration ═══════════════════════════════════════════════════════════════════════════════

/**
 * Six, not five, and the reason is the rotation rather than statistics.
 *
 * Three graded configurations rotate through three within-round positions, so only a round count
 * divisible by three gives every configuration the same number of first, second and third slots. At
 * five rounds configuration A takes the first slot twice and the third once while C takes the first
 * once — and the first slot in a round is systematically the quietest (the previous round's browser
 * has just been reaped, the fixture is idle). That is a per-configuration bias on the exact axis the
 * gate reads, introduced by the very mechanism added to remove it. Six is the smallest multiple of
 * three that still leaves a usable spread when a capture or two is dropped as invalid.
 *
 * BOTH WAYS OF IGNORING THAT ARE ENFORCED RATHER THAN MERELY DOCUMENTED, because a printed NOTE
 * beside a green headline is not a check. A round count that is NOT a multiple of three now BLOCKS
 * the #102 gate on a rotated run (`analyze`'s roundsBalanced reason) — the bias it introduces is the
 * same class of confound as running unrotated, which has always blocked, and a rule that blocks one
 * while printing a note about the other is a rule with a hole in it. The `Math.max(1, ...)` floor
 * below deliberately still permits 1: a single round gives every summary n=1, which the thin-capture
 * guard in `analyze` already turns into INSTRUMENT-FAILED, so clamping it here would only replace a
 * specific diagnosis with a silent adjustment.
 */
const ROUNDS = Math.max(1, Number(process.env.CDP_BASELINE_ROUNDS ?? 6) || 6);
const OUT_PATH = process.env.CDP_BASELINE_OUT ?? "";
const STRICT = process.env.CDP_BASELINE_STRICT === "1";
const HEADLESS = process.env.CDP_BASELINE_HEADLESS === "1";
const WITH_COLLECTOR = process.env.CDP_BASELINE_COLLECTOR !== "0";
/**
 * B0 (our stack, driver pipe, NO Fetch guard) is ON by default — opting out costs the attribution.
 *
 * Epic #92 asks how much of any B-vs-A separation OUR GUARD is responsible for. With arms A, B and C
 * only, a B-vs-A gap has two candidate causes that the run cannot tell apart: the driver's own pipe
 * and session bookkeeping, or the browser-level Fetch.enable urlPattern "*" the nav guard installs.
 * Those imply completely different fixes — one is "change drivers", the other is "stop intercepting
 * everything" — so a run that cannot separate them hands #102 a finding it cannot act on. B0 is the
 * control that separates them, and it costs one extra capture per round rather than a second run.
 */
const WITH_NOGUARD_ARM = process.env.CDP_BASELINE_NOGUARD !== "0";
/**
 * DEFAULT ON, and opting out costs the gate. Every protocol-family probe here is host-load sensitive
 * (console cost is estimated through ~100us clock coarsening; stalls are milliseconds), so with a
 * fixed within-round order — A first, C last, every round — any systematic drift across a round maps
 * one-to-one onto an "A separated from C" reading. That is precisely the reading that unblocks #102,
 * which makes fixed ordering the cheapest possible way to manufacture a false green. Rotation spreads
 * each configuration across every within-round position; a run that declines it is still measured,
 * but `analyze()` refuses to call the protocol family validated on it.
 */
const ROTATE = process.env.CDP_BASELINE_ROTATE !== "0";
const NO_SANDBOX = process.env.BGW_NO_SANDBOX === "1";

/**
 * In-page wait between script parse and the first measurement, identical in all three
 * configurations. Configuration B's `navigate()` does real work AFTER the document loads — an
 * accessibility snapshot, block detection, a clearance pass — all of it protocol traffic. Probing
 * during that burst would measure the gateway's own settle rather than the protocol's steady-state
 * cost, and would do so only for B. The host side records how long navigate() actually took and
 * flags the capture when it outran this delay, so the assumption is checked rather than trusted.
 *
 * SIX SECONDS, AND THE DEFAULT IS SIZED FOR THE RUN THAT COUNTS. The check above is BLOCKING — a
 * single capture whose navigate() outran this delay is an instrument failure that blocks #102 — and
 * the reading that counts is taken in-container: headful Chrome under Xvfb, linux/amd64 under
 * emulation on an aarch64 host, with SwiftShader doing the compositing. Every one of those multiplies
 * the post-load work navigate() does. A 2000ms default was measured against a native macOS run and
 * would, on the container, most likely abort the whole ~20-minute run with zero measurement rather
 * than mis-measure anything — the worst possible failure for an instrument that has never been run.
 * Six seconds is cheap here (it is per capture, not per sample) and buys the margin. If the check
 * still fires, the fix is to raise this further, not to make the check advisory.
 */
const PROBE_DELAY_MS = Math.max(0, Number(process.env.CDP_BASELINE_DELAY_MS ?? 6000) || 0);

/**
 * How long configuration A sits on the /warmup page before replacing itself with the probe URL.
 *
 * WHY IT EXISTS. A's fixture load used to BE browser startup: profile creation, network-service
 * bring-up, GPU/SwiftShader init and the page load all overlapping, with PROBE_DELAY_MS counted from
 * script parse rather than from browser start. B and C never pay that: their browser has been alive
 * through a driver handshake (B) or DevToolsActivePort + websocket connect + attach + Page/Runtime
 * enable (C) before their page begins. The consequence was measurable and backwards — in the smoke
 * runs, connection-setup stalls read ~1.4-2x HIGHER in A, the arm with nothing attached, than in C,
 * the arm with a debugging port. That is a cold-start penalty landing on the level AND the spread of
 * the arm whose spread the separation rule uses as its noise band.
 *
 * The fix needs no protocol in A: the warm-up page is served by the same fixture, holds for a fixed
 * wall-clock, and then does a same-origin location.replace() to the probe URL. Set 0 to restore the
 * old behavior (and the confound).
 */
const WARMUP_MS = Math.max(0, Number(process.env.CDP_BASELINE_WARMUP_MS ?? 1500) || 0);

/**
 * Same-origin sub-resources the probe page references so the collector's PASSIVE interception
 * probe (cdp.resourceTiming.*) has entries to read. Six is enough for a median and a max to both
 * mean something while staying far below anything that would change page-load behaviour; every
 * configuration pays the identical cost, so the count cancels out of the A/B/C comparison and only
 * the per-request pre-dispatch stall remains.
 */
const FIXTURE_ASSET_COUNT = 6;

const DEVTOOLS_PORT_TIMEOUT_MS = 20_000;
/**
 * Every in-page cost this harness knows about, summed, then floored — and the sum FOLLOWS the probe
 * delay rather than being a constant that silently swallows it.
 *
 * The terms: navigation and settle (30s, matching the core's own navigationTimeoutMs), the raw
 * probe's declared wall-clock budget (15s), the collector's cdp section plus its WebRTC gather (15s
 * allowed for an 8s gather because the gather is where an emulated container run stretches most),
 * PROBE_DELAY_MS, and WARMUP_MS.
 *
 * THE ARITHMETIC, STATED CORRECTLY, BECAUSE AN EARLIER VERSION OF THIS COMMENT GOT IT BACKWARDS.
 * With the collector ON and the defaults the sum is 30+15+15+6+1.5 = 67.5s, which already exceeds
 * the 60_000 floor this used to carry — `max(60_000, 67_500)` is 67_500, so at the shipping defaults
 * the SUM was binding and the old floor was inert. The floor bound in the other configuration: with
 * CDP_BASELINE_COLLECTOR=0 the sum drops to 52.5s, and there a 60s floor DID swallow the probe delay,
 * so raising CDP_BASELINE_DELAY_MS by 5s would not have moved the deadline at all and the first slow
 * capture would have reported "no report from the page" — a silent page — for what was an
 * under-budgeted timeout. The 90s floor is above the sum in BOTH configurations at the defaults, so
 * neither a shortened delay nor a dropped collector can shrink the deadline below what the probes
 * alone need, and a raised delay still pushes the deadline out once the sum passes 90s.
 *
 * Env-tunable because the failure it guards against is asymmetric: too high costs one slow run, too
 * low turns a merely slow capture — an emulated linux/amd64 headful launch with SwiftShader and a
 * full WebRTC gather is the realistic case — into a misdiagnosis.
 */
const REPORT_TIMEOUT_MS = Math.max(
  10_000,
  Number(process.env.CDP_BASELINE_REPORT_TIMEOUT_MS) ||
    Math.max(90_000, 30_000 + 15_000 + PROBE_DELAY_MS + WARMUP_MS + (WITH_COLLECTOR ? 15_000 : 0)),
);
/** Grace for a report that may still be in flight after navigate() itself failed (see captureB). */
const NAV_FAILURE_GRACE_MS = 5_000;
const KILL_GRACE_MS = 3_000;
/** Sampling interval for the per-capture event-loop delay histogram (see the capture loop). */
const LOOP_DELAY_RESOLUTION_MS = 20;

/** Separation requires |Δmedian| to clear this many observed-noise widths, on top of disjoint ranges. */
const SEP_MULT = 2;
/** B is called "matching" an end when it sits within this fraction of the A→C axis from that end. */
const MATCH_BAND = 0.25;
/** Boolean probes: a rate this close to an end counts as matching it. */
const RATE_BAND = 0.2;
/**
 * Below this, a "noise band" is not small — it is absent. Every numeric probe here is milliseconds or
 * a count on a clock Chrome coarsens to ~100us, so a spread of 5e-9 is the floating-point residue of
 * averaging quantized samples, not a measurement of round-to-round variation. It matters because the
 * #102 headroom figure is expressed in A's OWN observed noise, and a residue reads as a band.
 */
const NEGLIGIBLE_SPREAD = 1e-6;

/**
 * Bucket labels that mean "the inputs were under the clock's resolution", not "the value fell in
 * this band".
 *
 * `below-resolution` is the shipped collector's stable label for a ratio whose denominator (or
 * numerator) median did not clear a resolution floor; it replaced a `b<=0 -> 'flat' | 'unbounded'`
 * discontinuity in which two arms measuring the same nothing could land on DIFFERENT labels and read
 * as a clean categorical separation. `flat` and `unbounded` are kept here so a run against an older
 * built collector inherits the same refusal instead of the old false green.
 *
 * A label probe whose entire observed set for one arm is drawn from this list is comparing "the
 * clock could resolve this" against "it could not" — which moves with host load, with the number of
 * console sinks the arm happens to drive, and with the sample count. That is not nothing, and it is
 * reported, but it cannot be the evidence that this suite can see an attached consumer.
 */
const RESOLUTION_LIMITED_LABELS = ["below-resolution", "flat", "unbounded"];

const CHROME_CANDIDATES = [
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/opt/google/chrome/chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

/** Switches stripped when cloning B's real argv for A and C: profile and protocol transport. */
const CLONE_DROP_PREFIXES = [
  "--user-data-dir=",
  "--remote-debugging-pipe",
  "--remote-debugging-port",
  "--remote-debugging-address",
];

// ═══ pure analysis (exported for test/cdp-baseline.test.mjs) ══════════════════════════════════════

/** Median of a numeric list; null when nothing usable is in it. */
export function median(values) {
  const v = (values ?? []).filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * Summarize one configuration's per-round values for a NUMERIC probe.
 *
 * `spread` (max − min) is the load-bearing field, not stdev: it is the observed round-to-round noise
 * band, and it is what the separation rule and #102's tolerance are both expressed in. With five
 * rounds a stdev is a fiction; a range is a fact.
 */
export function summarizeNumeric(values) {
  const v = (values ?? []).filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  const nulls = (values ?? []).length - v.length;
  if (!v.length) return { n: 0, nulls, min: null, p50: null, max: null, mean: null, spread: null };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  return {
    n: v.length,
    nulls,
    min: v[0],
    p50: median(v),
    max: v[v.length - 1],
    mean,
    spread: v[v.length - 1] - v[0],
  };
}

/** Summarize one configuration's per-round values for a BOOLEAN probe as a fire rate. */
export function summarizeRate(values) {
  const v = (values ?? []).filter((x) => typeof x === "boolean");
  const nulls = (values ?? []).length - v.length;
  const trueCount = v.filter(Boolean).length;
  return { n: v.length, nulls, trueCount, rate: v.length ? trueCount / v.length : null };
}

/** Summarize one configuration's per-round values for a CATEGORICAL (bucket-label) probe. */
export function summarizeLabel(values) {
  const counts = {};
  let nulls = 0;
  for (const value of values ?? []) {
    if (value === null || value === undefined) { nulls++; continue; }
    const k = String(value);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  const set = Object.keys(counts).sort();
  let modal = null;
  for (const k of set) if (modal === null || counts[k] > counts[modal]) modal = k;
  return { n: set.reduce((a, k) => a + counts[k], 0), nulls, counts, set, modal };
}

/**
 * Do two configurations separate on this numeric probe?
 *
 * THREE conditions, all required, because any one alone lies with n=6:
 *   0. BOTH arms produced an OBSERVABLE noise band — a spread above the probe's declared resolution
 *      floor. Below that the comparison is RESOLUTION-LIMITED and is not a separation at all.
 *   1. the observed RANGES are disjoint — no round of one arm landed inside the other's band;
 *   2. the GAP BETWEEN THE RANGES (not the distance between the medians) is at least SEP_MULT times
 *      the MEASURED noise band of the tighter arm.
 * Condition 1 alone passes on two barely-touching wide distributions; condition 2 alone passes on
 * two heavily overlapping ones whose medians happen to sit far apart.
 *
 * WHY CONDITION 0 EXISTS, AND WHY THE FLOOR NO LONGER ENTERS THE NOISE BAND ON A CONTINUOUS PROBE.
 * The band used to be `max(min(spreadA, spreadC), floor)`. Take either arm's spread to zero — which
 * is ROUTINE, not exotic, on a clock Chrome coarsens to ~100us, where fifty console calls average to
 * the same quantized value every round — and the band collapses onto the floor, so the whole
 * separation test reduces to "is the gap bigger than 2x a constant". For console.proxyMeanMs that
 * constant is 0.005ms, i.e. a 0.01ms bar: one twentieth of a single clock tick. The rule was
 * MANUFACTURING separations out of clock resolution and then handing them to `recommendGate`, which
 * would refuse to threshold the very same probe for having no observable band — the run could print
 * "#102 gate: UNBLOCKED" above "NO THRESHOLD OFFERED" for one probe, in one report.
 *
 * So on a continuous probe the floor now gates the comparison instead of substituting for it: both
 * arms must clear it, and once they do the noise band is `min(spreadA, spreadC)` — always measured,
 * never a constant. That also makes the two rules consistent by construction rather than by
 * coincidence: a continuous probe that separates has `a.spread > floor >= NEGLIGIBLE_SPREAD`, which
 * is exactly the condition `recommendGate` requires before it will hand #102 a number.
 *
 * DISCRETE PROBES ARE EXEMPT, and the exemption is declared per spec (`discrete: true`) rather than
 * inferred. An ownKeys invocation count reading 0/0/0/0/0/0 in one arm and 50/50/50/50/50/50 in the
 * other has a zero spread for the opposite reason: the quantity is an exact integer and the arms
 * reproduced it perfectly. There is no clock in it to be limited by, the gap is fifty whole counts,
 * and the floor of 0.5 is half a quantum rather than a guess. Those are precisely the probes epic #92
 * most needs to be able to unblock the gate — booleans and counts, immune to scheduling and to clock
 * coarsening — so a rule that silenced them would trade one false green for a false red.
 *
 * WHY THE GAP AND THE TIGHTER ARM, AND NOT |Δp50| AGAINST THE WIDER ARM. The earlier rule took the
 * noise band as `max(a.spread, c.spread)`, which makes an arm with a heavy tail unable to separate
 * from anything no matter how large the effect — the bar rises with the very dispersion that is the
 * finding. Measured on the smoke runs (provisional): our stack's warm pre-dispatch stall read
 * p50 4.14ms over [1.04 .. 13.62] against the no-protocol control's 0.15ms over [0.05 .. 0.15] —
 * every round of B above every round of A by at least 0.89ms, 27x the control's median — and the
 * rule reported "not separated" because B's own 12.6ms spread demanded a 25ms delta. That is the
 * B-OUTLIER path, the one this file's header calls its own headline outcome, being structurally
 * unreachable for the one probe family it was built for.
 *
 * The gap form is strictly stricter on the delta side (when the ranges are disjoint the gap is never
 * larger than |Δp50|) and looser only on the noise side, where the floors do the protecting. Read it
 * as: EVERY round of one arm cleared EVERY round of the other by at least SEP_MULT resolution widths
 * of whichever arm was tight enough to define a resolution.
 */
export function separateNumeric(a, c, floor = 0, { discrete = false } = {}) {
  if (!a || !c || a.n < 2 || c.n < 2) {
    return { separated: false, reason: `insufficient valid captures (A n=${a?.n ?? 0}, C n=${c?.n ?? 0})`, delta: null, noise: null, disjoint: false, widths: null, gap: null, resolutionLimited: false };
  }
  const aSpread = a.spread ?? 0;
  const cSpread = c.spread ?? 0;
  // NEGLIGIBLE_SPREAD is the hard lower bound even when a spec declares floor 0: a spread of 5e-9 is
  // the floating-point residue of averaging quantized samples, and letting it count as "an observed
  // band" would reopen the same hole one decimal place down. It is also what keeps this rule and
  // recommendGate's refusal from ever disagreeing about the same probe.
  const resolution = discrete ? 0 : Math.max(floor, NEGLIGIBLE_SPREAD);
  const resolutionLimited = !discrete && !(aSpread > resolution && cSpread > resolution);
  // Discrete probes keep the floor in the band (half a count), continuous probes never do.
  const noise = discrete ? Math.max(Math.min(aSpread, cSpread), floor) : Math.min(aSpread, cSpread);
  const delta = c.p50 - a.p50;
  const disjoint = a.max < c.min || c.max < a.min;
  const gap = disjoint ? (a.max < c.min ? c.min - a.max : a.min - c.max) : 0;
  const widths = noise > 0 ? gap / noise : null;
  const separated = !resolutionLimited && disjoint && gap >= SEP_MULT * noise;
  const reason = resolutionLimited
    ? `RESOLUTION-LIMITED: spreads (${aSpread.toPrecision(3)}, ${cSpread.toPrecision(3)}) do not both exceed the probe's stated resolution floor ${resolution.toPrecision(3)}, so at least one arm produced no observable noise band — a gap of ${gap.toPrecision(3)} here would be measuring the clock, not the protocol (|Δp50|=${Math.abs(delta).toPrecision(3)}; more rounds, or a probe that resolves above this clock)`
    : separated
      ? `disjoint ranges and gap=${gap.toPrecision(3)} >= ${SEP_MULT}x tighter-arm noise ${noise.toPrecision(3)} (|Δp50|=${Math.abs(delta).toPrecision(3)})`
      : disjoint
        ? `ranges disjoint but gap=${gap.toPrecision(3)} < ${SEP_MULT}x tighter-arm noise ${noise.toPrecision(3)}`
        : "observed ranges overlap";
  return { separated, reason, delta, noise, disjoint, widths, gap, resolutionLimited };
}

/** Boolean separation: the two controls must sit at OPPOSITE ends, not merely differ by a round. */
export function separateRate(a, c) {
  if (!a || !c || a.n < 2 || c.n < 2) {
    return { separated: false, reason: `insufficient valid captures (A n=${a?.n ?? 0}, C n=${c?.n ?? 0})`, delta: null };
  }
  const delta = c.rate - a.rate;
  const separated = (a.rate <= RATE_BAND && c.rate >= 1 - RATE_BAND) || (c.rate <= RATE_BAND && a.rate >= 1 - RATE_BAND);
  return {
    separated,
    reason: separated ? `rates at opposite ends (A ${a.rate}, C ${c.rate})` : `rates not at opposite ends (A ${a.rate}, C ${c.rate})`,
    delta,
  };
}

/**
 * Categorical separation: the two controls never produced a label in common — AND neither arm spent
 * the whole run inside a label that means "the inputs were under the clock's resolution".
 *
 * WHY THE SECOND CONDITION. These labels are quantizations of the SAME millisecond medians the
 * numeric probes read, one ladder step wide, so they inherit every resolution problem the numeric
 * rule was just taught to refuse — and they inherit it in a form that hides it, because a label
 * comparison shows no spreads for a reader to check. The collector's ratio ladder is the concrete
 * case: its `below-resolution` label is emitted whenever either median fails a resolution floor, so
 * "A {below-resolution} vs C {3to8x}" is the sentence "in one arm the clock could not resolve the
 * ratio and in the other it could". That is a statement about how much console work each arm's
 * renderer happened to do per tick, and it moves with host load; it is not the demonstration that
 * this suite can see an attached consumer, which is the only thing allowed to unblock #102. It is
 * still reported — a label pair like that is a genuine lead for a follow-up run with more samples.
 *
 * Deliberately NOT applied when both arms sit on real bucket labels: two arms landing in different
 * measured bands is exactly what a working categorical probe looks like.
 */
export function separateLabel(a, c, { resolutionLimitedLabels = RESOLUTION_LIMITED_LABELS } = {}) {
  if (!a || !c || a.n < 2 || c.n < 2) {
    return { separated: false, reason: `insufficient valid captures (A n=${a?.n ?? 0}, C n=${c?.n ?? 0})`, shared: [], resolutionLimited: false };
  }
  const shared = a.set.filter((k) => c.set.includes(k));
  const subResolution = (s) => s.set.length > 0 && s.set.every((k) => resolutionLimitedLabels.includes(k));
  const resolutionLimited = subResolution(a) || subResolution(c);
  const disjoint = shared.length === 0;
  return {
    separated: disjoint && !resolutionLimited,
    reason: resolutionLimited
      ? `RESOLUTION-LIMITED: an arm produced only sub-resolution labels (A {${a.set}} vs C {${c.set}}); labels in {${resolutionLimitedLabels.join(", ")}} say the underlying medians did not clear the probe's resolution floor, so a disjoint label set here compares measurability rather than protocol presence`
      : disjoint
        ? `label sets disjoint (A {${a.set}} vs C {${c.set}})`
        : `label sets share {${shared}}`,
    shared,
    resolutionLimited,
  };
}

/**
 * Where does B sit on the A→C axis? `t` is 0 at A's median and 1 at C's median, so it stays
 * meaningful when B overshoots either end (t<0 or t>1 both read as "past that control").
 */
export function positionNumeric(a, b, c, floor = 0) {
  if (!a || !b || !c || b.n < 1) return { verdict: "no-data", t: null };
  const denom = c.p50 - a.p50;
  if (!denom) return { verdict: "no-data", t: null };
  const t = (b.p50 - a.p50) / denom;
  const verdict = t <= MATCH_BAND ? "B-matches-A" : t >= 1 - MATCH_BAND ? "B-matches-C" : "B-between";
  // How wide the A->C axis is in units of the probe's own resolution floor, and whether MATCH_BAND
  // is therefore deciding this verdict on sub-resolution differences. Measured on the smoke runs
  // (provisional): console.proxyMeanMs had an axis 0.016ms wide against a 0.005ms floor — about
  // three resolution units, so the 0.25 match band is under one unit and two runs five minutes
  // apart placed B on opposite sides of it. The verdict is still reported (it is the ticket's
  // question), but a reader and #102 need to see when it is riding on noise.
  const axisWidths = floor > 0 ? Math.abs(denom) / floor : null;
  return { verdict, t, axisWidths, resolutionLimited: axisWidths !== null && axisWidths * MATCH_BAND < 1 };
}

/** Boolean position: nearest end wins; ambiguity (near both, or near neither) is "between". */
export function positionRate(a, b, c) {
  if (!a || !b || !c || b.n < 1) return { verdict: "no-data", t: null };
  const nearA = Math.abs(b.rate - a.rate) <= RATE_BAND;
  const nearC = Math.abs(b.rate - c.rate) <= RATE_BAND;
  const denom = c.rate - a.rate;
  const t = denom ? (b.rate - a.rate) / denom : null;
  if (nearA && !nearC) return { verdict: "B-matches-A", t };
  if (nearC && !nearA) return { verdict: "B-matches-C", t };
  return { verdict: "B-between", t };
}

/** Categorical position: B matches the control whose label set contains everything B produced. */
export function positionLabel(a, b, c) {
  if (!a || !b || !c || b.n < 1) return { verdict: "no-data", t: null };
  const inA = b.set.every((k) => a.set.includes(k));
  const inC = b.set.every((k) => c.set.includes(k));
  if (inA && !inC) return { verdict: "B-matches-A", t: 0 };
  if (inC && !inA) return { verdict: "B-matches-C", t: 1 };
  return { verdict: "B-between", t: null };
}

/**
 * The #102 hand-off: a concrete threshold plus the tolerance it was derived from.
 *
 * For a numeric probe the threshold is the MIDPOINT OF THE OBSERVED GAP between the controls, not
 * the midpoint of their medians — a gate has to clear the worst round of the passing side, not its
 * typical one. `headroomWidths` says how many of A's own noise bands fit between A's worst round
 * and the threshold; a gate with under ~1 of those will flake on a busy machine no matter how
 * clean the separation looked here.
 */
export function recommendGate(spec, a, b, c, separation) {
  if (!separation.separated) return null;
  if (spec.kind === "rate") {
    const expectTrue = a.rate >= 1 - RATE_BAND;
    return {
      kind: "rate",
      rule: `expect ${expectTrue ? "true" : "false"} — fail when the probe reads ${expectTrue ? "false" : "true"}`,
      threshold: expectTrue,
      tolerance: `0 of ${a.n} rounds may disagree (A was ${a.trueCount}/${a.n} true, C ${c.trueCount}/${c.n})`,
      bMargin: b.n ? `B read ${b.trueCount}/${b.n} true` : "B produced no reading",
      headroomWidths: null,
    };
  }
  if (spec.kind === "label") {
    // A THRESHOLD THAT ACCEPTS "THE CLOCK COULD NOT RESOLVE THIS" IS A GATE THAT PASSES BECAUSE THE
    // MEASUREMENT FAILED, AND IT IS REACHABLE WITHOUT ANY OF THE ABOVE FIRING.
    //
    // `separateLabel` refuses an arm whose WHOLE observed set is sub-resolution, which is the case
    // where nothing was measured at all. It deliberately does not refuse a MIXED set, because an arm
    // that resolved in some rounds and not in others still carries a real reading in the rounds it
    // resolved — that is a lead worth reporting. But the threshold built from such an arm is
    // `a.set` in its entirety, so a mixed set of {below-resolution, lt1_5x} yields the rule "fail
    // when the bucket label is outside {below-resolution, lt1_5x}" — i.e. a #102 gate that PASSES
    // any future run whose console medians fall under the collector's own resolution floor. The
    // stack could go fully visible and the gate would still read green, because the collector would
    // report `below-resolution` and `below-resolution` is on the accept list.
    //
    // The separation is still reported (it is data); what is refused is turning it into a number
    // #102 could ship. `internalConsistencyFailures` deliberately does NOT treat this refusal as a
    // rule contradiction — the separation rule and the threshold rule are answering different
    // questions here and both answers are correct — but `analyze` does count it as "this validator
    // offers no usable threshold", which is its own blocking reason.
    const subResolution = a.set.filter((k) => RESOLUTION_LIMITED_LABELS.includes(k));
    if (subResolution.length) {
      return {
        kind: "label",
        refused: true,
        refusedBecause: "threshold-would-accept-a-sub-resolution-label",
        rule:
          `NO THRESHOLD OFFERED — configuration A's observed label set {${a.set.join(", ")}} includes ` +
          `{${subResolution.join(", ")}}, which mean "the medians behind this bucket did not clear the collector's own ` +
          `resolution floor" rather than naming a measured band. A gate that accepts ${subResolution.length === 1 ? "that label" : "those labels"} passes every future run in ` +
          `which the measurement failed, which is the one outcome a gate must never read as green. Re-run with more ` +
          `rounds, or gate on a probe whose values resolve above this clock.`,
        threshold: null,
        tolerance: `A produced {${a.set.join(", ")}} across ${a.n} rounds (${subResolution.length} of those label(s) are sub-resolution); C produced {${c.set.join(", ")}}`,
        bMargin: b.n ? `B produced {${b.set.join(", ")}} — recorded, not thresholded` : "B produced no reading",
        headroomWidths: null,
      };
    }
    return {
      kind: "label",
      rule: `fail when the bucket label is outside {${a.set.join(", ")}}`,
      threshold: a.set,
      tolerance: `A produced only {${a.set.join(", ")}} across ${a.n} rounds; C produced {${c.set.join(", ")}}`,
      bMargin: b.n ? `B produced {${b.set.join(", ")}}` : "B produced no reading",
      headroomWidths: null,
    };
  }
  const aLow = a.p50 < c.p50;
  const gap = aLow ? c.min - a.max : a.min - c.max;
  const threshold = aLow ? a.max + gap / 2 : a.min - gap / 2;
  const aSpread = a.spread ?? 0;
  const floor = spec.floor ?? 0;
  // NO THRESHOLD FROM A DEGENERATE BAND, AND NONE FROM A PROVISIONAL CONSTANT EITHER.
  //
  // `headroomWidths` is the only thing that tells #102 whether the number will survive a busy host,
  // and it is expressed in A's OWN observed noise. Two ways it stops being that, both of which used
  // to produce a confident-looking figure:
  //
  //  1. NO BAND AT ALL. When A's rounds all read the same value the spread is 0 and the headroom
  //     silently falls back to the probe's hardcoded floor — "1.20 of A's noise widths" reads like a
  //     measured margin when nothing was measured. On the smoke runs (provisional) console.proxyMeanMs
  //     produced A spreads of 0.002ms and 0.000ms in two runs five minutes apart, and the threshold
  //     the second run recommended would have FAILED the stack the first run measured.
  //  2. A BAND NARROWER THAN THE PROBE'S DECLARED FLOOR. The old code took `max(spread, floor)` and
  //     labelled the result headroomBasis "floor" — an honest label on a dishonest number, because
  //     every floor in this file was chosen on a macOS, headless, constructed-args smoke run of n=2-3.
  //     A gate whose margin is counted in widths of THAT is a gate whose provenance is a laptop, and
  //     it would be written into #102 with no way for a reader to tell. The whole point of tagging
  //     the constants provisional is that nothing derived from them can become a threshold, which
  //     means the refusal has to be mechanical rather than a note.
  //
  // Both refusals are unreachable through `analyzeProbe` for a continuous probe, because
  // separateNumeric now requires spread > floor >= NEGLIGIBLE_SPREAD in BOTH arms before it will call
  // anything separated and this function returns null when nothing separated. They stay here as the
  // independent second lock: a caller reaching recommendGate directly, or a future relaxation of the
  // separation rule, cannot turn a provisional constant into a shipped threshold without deleting an
  // explicit refusal that says why.
  //
  // DISCRETE probes are exempt for the reason spelled out on separateNumeric: their floor is half of
  // an exact quantum, not a measurement, and a zero spread across rounds means the arm reproduced the
  // same integer every time. "Every round of A read 0 invocations and every round of C read 50" is
  // the single most reliable statement this instrument can make, and refusing to threshold it would
  // discard the one probe family that survives both clock coarsening and scheduling noise.
  if (spec.discrete !== true && !(aSpread > Math.max(floor, NEGLIGIBLE_SPREAD))) {
    const noBandAtAll = !(aSpread > NEGLIGIBLE_SPREAD);
    return {
      kind: "numeric",
      refused: true,
      refusedBecause: noBandAtAll ? "no-observed-band" : "band-below-provisional-floor",
      rule: noBandAtAll
        ? `NO THRESHOLD OFFERED — configuration A produced no observable noise band (spread ${aSpread.toPrecision(3)} across ${a.n} rounds${spec.unit === "ms" ? ", i.e. every round landed on the same clock tick" : ""}), so any headroom figure would be derived from the hardcoded floor ${floor} rather than from measurement. Re-run with more rounds, or gate on a probe whose values resolve above this clock.`
        : `NO THRESHOLD OFFERED — configuration A's observed noise band (${aSpread.toPrecision(3)}${spec.unit ? " " + spec.unit : ""} across ${a.n} rounds) is narrower than this probe's declared resolution floor ${floor}, so the headroom would be counted in FLOOR widths. That floor is a PROVISIONAL constant measured on a macOS, headless, constructed-args smoke run of n=2-3 — a threshold resting on it has that run's provenance, not this one's. Re-run with more rounds, or gate on a probe whose values resolve above this clock.`,
      threshold: null,
      tolerance: `A read ${a.p50.toPrecision(4)}${spec.unit ? " " + spec.unit : ""} across ${a.n} rounds (spread ${aSpread.toPrecision(3)}); C read ${c.p50.toPrecision(4)}${spec.unit ? " " + spec.unit : ""} (observed gap ${gap.toPrecision(3)})`,
      bMargin: b.n ? `B sits at ${b.p50.toPrecision(4)}${spec.unit ? " " + spec.unit : ""} — recorded, not thresholded` : "B produced no reading",
      headroomWidths: null,
    };
  }
  const aNoise = Math.max(aSpread, floor);
  // WHICH TERM WON, said out loud. For a discrete probe the floor legitimately wins when the arm
  // reproduced one integer every round, and the widths below are then counts of an EXACT quantum —
  // a different and much stronger claim than the old "floor" basis, which meant "a number from a
  // smoke run on somebody's laptop" and is no longer reachable (see the refusal above).
  const headroomBasis = aSpread >= floor ? "observed" : "exact-quantum";
  const headroomWidths = aNoise > 0 ? Math.abs(threshold - (aLow ? a.max : a.min)) / aNoise : null;
  const bMarginValue = b.n ? (aLow ? threshold - b.max : b.min - threshold) : null;
  return {
    kind: "numeric",
    rule: `fail when the value is ${aLow ? ">" : "<"} ${threshold.toPrecision(4)}${spec.unit ? " " + spec.unit : ""}`,
    threshold,
    tolerance: `A's observed noise band across ${a.n} rounds was ${aSpread.toPrecision(3)}${spec.unit ? " " + spec.unit : ""} (floor ${floor}, ${spec.floorBasis ?? "provenance undeclared"})`,
    bMargin: bMarginValue === null
      ? "B produced no reading"
      : `B's worst round clears the threshold by ${bMarginValue.toPrecision(3)}${spec.unit ? " " + spec.unit : ""}${bMarginValue < 0 ? " (NEGATIVE — B is on the wrong side)" : ""}`,
    headroomWidths,
    headroomBasis,
  };
}

// ═══ probe specification ═════════════════════════════════════════════════════════════════════════

const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
const bool = (x) => (typeof x === "boolean" ? x : null);

/**
 * Stall samples restricted to the connection-reuse regime, which is where the number means what
 * we want it to mean: DNS/TCP/TLS have collapsed onto fetchStart, so `requestStart − fetchStart` is
 * close to pure pre-dispatch delay — exactly where a Fetch.enable pause would land. The reuse flag
 * and the stall list are pushed under slightly different conditions in the probe source, so the
 * index pairing is verified rather than assumed; when it cannot be verified we fall back to the
 * whole series and say so through `pairingExact`.
 */
export function stallByReuse(fetchProbe) {
  const stalls = Array.isArray(fetchProbe?.stallMs) ? fetchProbe.stallMs : [];
  const reused = Array.isArray(fetchProbe?.reused) ? fetchProbe.reused : [];
  const pairingExact = stalls.length > 0 && stalls.length === reused.length;
  if (!pairingExact) return { warm: stalls, cold: [], pairingExact };
  return {
    warm: stalls.filter((_, i) => reused[i] === true),
    cold: stalls.filter((_, i) => reused[i] === false),
    pairingExact,
  };
}

/**
 * Split the harness-recovered Resource Timing rows into the two regimes, host-side.
 *
 * `connectStart === fetchStart` is Chrome's way of saying the socket was reused: the connection
 * phases collapsed onto fetchStart, so `requestStart - fetchStart` is close to pure pre-dispatch
 * delay — the window a Fetch.enable pause would land in. Cold samples keep their own bucket rather
 * than being averaged in, because a TCP handshake dwarfs anything the protocol could add.
 */
export function harnessStalls(meta) {
  const rows = Array.isArray(meta?.resourceTiming) ? meta.resourceTiming : [];
  const usable = rows.filter((r) => r && r.fetchStart > 0 && r.requestStart > 0);
  const warm = [];
  const cold = [];
  const dispatch = [];
  const ttfb = [];
  for (const r of usable) {
    (r.connectStart === r.fetchStart ? warm : cold).push(r.requestStart - r.fetchStart);
    if (r.domainLookupStart > 0) dispatch.push(r.domainLookupStart - r.fetchStart);
    if (r.responseStart > 0) ttfb.push(r.responseStart - r.requestStart);
  }
  return { entries: rows.length, usable: usable.length, warm, cold, dispatch, ttfb };
}

/**
 * Every probe compared across the three configurations.
 *
 * `read(capture)` pulls ONE number/boolean/label out of one capture's payload; the per-configuration
 * summary is then taken across rounds. Nothing here grades a probe on its own — the grading is
 * entirely relative to the A/C controls, which is the whole point of the ticket.
 *
 * `family` decides what a separation is worth, and it is not cosmetic bookkeeping — it is what stops
 * the epic's headline check from being satisfiable by the wrong thing:
 *   "protocol" — the mechanisms that actually observe an attached consumer (preview serialization,
 *                its cost, and request-interception latency). ONLY these can unblock #102.
 *   "control"  — crude automation tells. They can and do separate the controls (Chrome 150, provisional, sets
 *                navigator.webdriver once a debugging port is attached), but a suite that detects
 *                naive automation ONLY through navigator.webdriver has learned nothing about the
 *                protocol, and treating that as validation would be exactly the false-green the
 *                ticket exists to prevent.
 *   "harness"  — instrument self-checks AND anything whose value is produced by the instrument
 *                itself rather than by the browser under test. The fixture server runs in THIS Node
 *                process, on the same event loop as the Fetch guard and the raw CDP client, so
 *                server-side latency (TTFB, end-to-end fetch wall time) is a reading of how busy the
 *                harness was in that arm. A run whose only "separation" is fixture noise must report
 *                the probes inadequate, not unblock the gate — which is exactly what happens when
 *                these are tagged protocol, because `analyze()` computes protocolValidated from the
 *                family tag and nothing else.
 *   "context"  — a real browser-side quantity that is CONFOUNDED BY CONFIGURATION, so its separation
 *                cannot be attributed to the protocol. Reported with its numbers and with the
 *                confound's own measurement printed beside it; never counted toward the gate.
 *
 * `discrete: true` marks a probe whose values are exact integers (invocation counts, expando key
 * counts). It changes how `separateNumeric` and `recommendGate` treat a zero spread — for a count it
 * means "reproduced exactly", for a clock reading it means "unresolvable" — and it is declared rather
 * than inferred so nobody can quietly acquire the exemption by rounding a timing to an integer.
 *
 * `floorBasis` records where the probe's `floor` came from, and it is not decoration: `recommendGate`
 * refuses to build a #102 threshold whose margin would be counted in widths of a provisional floor.
 *
 * `mayBeEmpty: true` marks a probe DOCUMENTED to read null everywhere, so the dead-leaf check (which
 * treats "null in every capture of every arm" as a renamed-upstream-leaf instrument failure) does not
 * fire on a known upstream gap.
 */
const FLOOR_PROVISIONAL = "PROVISIONAL: chosen on a macOS/headless/constructed-args smoke run, n=2-3";
const FLOOR_EXACT_COUNT = "EXACT: half of one integer count — not a measurement";

export const PROBE_SPECS = [
  // ── family 1: discrete protocol callbacks ──────────────────────────────────────────────────────
  {
    key: "errorStack.fired",
    kind: "rate",
    family: "protocol",
    note: "probe A, KNOWN DEAD (V8 closed it in 2025). Expected false in ALL THREE. If this separates, the Chrome under test is older than the fix.",
    read: (c) => bool(c.raw?.errorStack?.fired),
  },
  {
    key: "consoleProxy.fired",
    kind: "rate",
    family: "protocol",
    note: "probe B, the ONLY construction reported live on a 2026 Chrome, and it has an upstream fix already landed. This is the probe most likely to carry the whole separation — and the one most likely to go quiet on a Chrome bump.",
    read: (c) => bool(c.raw?.consoleProxy?.fired),
  },
  {
    key: "consoleProxy.invocations",
    kind: "numeric",
    unit: "calls",
    floor: 0.5,
    floorBasis: FLOOR_EXACT_COUNT,
    discrete: true,
    family: "protocol",
    note: "ownKeys trap invocation count; a partial count would mean preview serialization fires for some console sinks only. WITH consoleProxy.fired, one of the two probes in this suite immune to both clock coarsening and scheduling noise — an integer the arms either reproduce or do not.",
    read: (c) => num(c.raw?.consoleProxy?.invocations),
  },
  {
    key: "consoleTiming.getterInvocations",
    kind: "numeric",
    unit: "calls",
    floor: 0.5,
    floorBasis: FLOOR_EXACT_COUNT,
    discrete: true,
    family: "protocol",
    note: "own-property getter reads during console preview — the 2025-closed path, on an ordinary object rather than an Error.",
    read: (c) => num(c.raw?.consoleTiming?.getterInvocations),
  },

  // ── family 2: console-call cost ────────────────────────────────────────────────────────────────
  // Cost rather than callback: even where V8 refuses to invoke page code, an attached consumer still
  // pays to build a preview and ship a Runtime.consoleAPICalled event, while an unattached renderer
  // drops the call. These survive the V8 fixes that kill family 1, which makes them the candidates
  // for a gate with a shelf life.
  //
  // MEAN, NOT MEDIAN, AND THAT IS FORCED. Chrome coarsens performance.now() to ~100us, and a console
  // call costs far less than that, so per-sample readings quantize to exactly 0 or exactly 0.1 and
  // the MEDIAN of fifty samples is structurally 0 in every configuration — measured on Chrome 150 (provisional),
  // where the discrete probe separated 100/100 and every console median still read 0.000. The mean
  // over fifty quantized samples is the rate at which the call crossed a clock tick, which is the
  // only estimator this clock supports. `console.proxyP50Ms` is retained precisely to keep that dead
  // end on the record for #102.
  {
    key: "console.errorStackMeanMs",
    kind: "numeric",
    unit: "ms",
    floor: 0.005,
    floorBasis: FLOOR_PROVISIONAL,
    family: "protocol",
    note: "console.debug(Error with a stack getter), mean of 50.",
    read: (c) => num(c.raw?.errorStack?.summary?.mean),
  },
  {
    key: "console.proxyMeanMs",
    kind: "numeric",
    unit: "ms",
    floor: 0.005,
    floorBasis: FLOOR_PROVISIONAL,
    family: "protocol",
    note: "console.groupEnd(prototype-Proxy carrier), mean of 50.",
    read: (c) => num(c.raw?.consoleProxy?.summary?.mean),
  },
  {
    key: "console.richMeanMs",
    kind: "numeric",
    unit: "ms",
    floor: 0.005,
    floorBasis: FLOOR_PROVISIONAL,
    family: "protocol",
    note: "console.debug(object with an enumerable getter), mean of 50.",
    read: (c) => num(c.raw?.consoleTiming?.richSummary?.mean),
  },
  {
    key: "console.plainMeanMs",
    kind: "numeric",
    unit: "ms",
    floor: 0.005,
    floorBasis: FLOOR_PROVISIONAL,
    family: "protocol",
    note: "console.debug(string), mean of 50 — the cheapest possible console call, interleaved with the rich one so a busy host inflates both arms equally.",
    read: (c) => num(c.raw?.consoleTiming?.plainSummary?.mean),
  },
  {
    key: "console.richOverPlainRatio",
    kind: "numeric",
    unit: "x",
    floor: 0.15,
    floorBasis: FLOOR_PROVISIONAL,
    family: "protocol",
    note: "rich/plain mean ratio — unitless, so it is the one console figure with a chance of surviving a host change.",
    read: (c) => {
      const rich = num(c.raw?.consoleTiming?.richSummary?.mean);
      const plain = num(c.raw?.consoleTiming?.plainSummary?.mean);
      return rich !== null && plain !== null && plain > 0 ? rich / plain : null;
    },
  },
  {
    key: "console.proxyP90Ms",
    kind: "numeric",
    unit: "ms",
    floor: 0.05,
    floorBasis: FLOOR_PROVISIONAL,
    family: "protocol",
    note: "p90 of the same series: at this clock resolution p90 is effectively 'did at least a tenth of the calls cross one tick', which is a coarser but non-degenerate version of the mean.",
    read: (c) => num(c.raw?.consoleProxy?.summary?.p90),
  },
  {
    key: "console.proxyP50Ms",
    kind: "numeric",
    unit: "ms",
    floor: 0.1,
    floorBasis: FLOOR_PROVISIONAL,
    family: "protocol",
    note: "MEDIAN of the same series, kept as documented evidence: it reads 0.000 in every configuration because a console call is cheaper than one clock tick. #102 must not build a console gate on a median.",
    read: (c) => num(c.raw?.consoleProxy?.summary?.p50),
  },

  // ── family 3: request latency under Fetch interception ─────────────────────────────────────────
  // The family with NO published detection method, which is exactly why it is measured rather than
  // assumed. Our guard pauses every request at requestStage "Request" and continues it from the
  // client; if that is visible from page JS at all, it is visible as pre-dispatch delay.
  //
  // ONLY THE PRE-DISPATCH WINDOW IS PROTOCOL-FAMILY. requestStart - fetchStart is browser-side and
  // is where an interception pause lands. Everything downstream of requestStart (TTFB, end-to-end
  // wall time) is the fixture server answering from this same Node process, so it measures the
  // harness's own load in that arm and is tagged accordingly.
  {
    key: "harness.stallWarmP50Ms",
    kind: "numeric",
    unit: "ms",
    floor: 0.05,
    floorBasis: FLOOR_PROVISIONAL,
    family: "protocol",
    note: "requestStart - fetchStart on REUSED connections, median, from the harness-recovered Resource Timing rows. The single most likely place a Fetch.enable pause shows up.",
    read: (c) => median(harnessStalls(c.meta).warm),
  },
  {
    key: "harness.stallWarmMeanMs",
    kind: "numeric",
    unit: "ms",
    floor: 0.05,
    floorBasis: FLOOR_PROVISIONAL,
    family: "protocol",
    note: "mean of the same warm series — like the console family, resistant to clock quantization in a way the median is not.",
    read: (c) => {
      const warm = harnessStalls(c.meta).warm;
      return warm.length ? warm.reduce((a, b) => a + b, 0) / warm.length : null;
    },
  },
  {
    key: "harness.stallColdP50Ms",
    kind: "numeric",
    unit: "ms",
    floor: 0.2,
    floorBasis: FLOOR_PROVISIONAL,
    // CONTEXT, NOT PROTOCOL — DEMOTED, and the demotion is the finding.
    //
    // These are the samples that had to open a socket, so they carry whatever else the browser was
    // doing in its first seconds: profile bring-up, the network service starting, GPU/SwiftShader
    // init, and — decisively — however much browser life each arm had already accumulated before its
    // probe page ran. The three arms do not arrive with the same amount: A is spawned straight onto
    // its startup URL, B comes up through a driver handshake, C through DevToolsActivePort plus a
    // websocket connect, attach and Page/Runtime enable. A verifier measured configuration A running
    // 1.4-2x SLOWER than C here purely from cold start — the arm with NOTHING attached losing to the
    // arm with a debugging port — and the /warmup page added to correct it then over-corrected in the
    // other direction. A number whose sign has been set twice by browser age is a cold-start artifact
    // wearing a protocol probe's clothes, and as protocol-family it could VALIDATE the entire suite
    // and unblock #102 on its own.
    //
    // Demotion, not deletion: it is still measured, still printed with its per-configuration numbers,
    // and printed next to each arm's MEASURED browser age at probe time so a reader can see the
    // confound rather than take this comment's word for it. What it cannot do is count. Note also
    // that the warm series above is the right instrument for the same mechanism anyway — an
    // interception pause lands on pre-dispatch delay whether or not a handshake preceded it, and the
    // warm regime is the one where nothing else is in the window.
    //
    // Do NOT promote this back on the strength of "the warm-up equalized the ages". That claim needs
    // a real run behind it, and even a run that shows equal ages shows it for one host on one day.
    family: "context",
    confound: "cold-start: dominated by browser age at probe time, which differs by configuration (A spawns onto its startup URL; B comes up through a driver handshake; C through DevToolsActivePort + attach + Page/Runtime.enable)",
    note: "same as the warm series, on samples that had to open a socket — kept apart so a TCP handshake is never averaged into the protocol figure, and kept OUT of the protocol family because what it mostly measures is how old each arm's browser was.",
    read: (c) => median(harnessStalls(c.meta).cold),
  },
  {
    key: "harness.dispatchP50Ms",
    kind: "numeric",
    unit: "ms",
    floor: 0.05,
    floorBasis: FLOOR_PROVISIONAL,
    family: "harness",
    note: "domainLookupStart - fetchStart, median. STRUCTURALLY ZERO HERE and kept as the evidence for that: the fixture is http://127.0.0.1:<port>, an IP literal, so there is no DNS phase and domainLookupStart === fetchStart on every sample in every configuration. It reads 0.000 everywhere, it cannot separate anything, and it is tagged harness rather than protocol so it can never look like a protocol probe that 'stayed quiet'.",
    read: (c) => median(harnessStalls(c.meta).dispatch),
  },
  {
    key: "harness.ttfbP50Ms",
    kind: "numeric",
    unit: "ms",
    floor: 0.05,
    floorBasis: FLOOR_PROVISIONAL,
    family: "harness",
    note: "responseStart - requestStart, median: the FIXTURE SERVER's own contribution, here as a control on how noisy the fixture itself is. Explicitly NOT a protocol probe — the server shares this Node process and event loop with the Fetch guard and the raw CDP client, so the arm doing more harness work (C parses hundreds of Runtime.consoleAPICalled payloads while serving the same requests) inflates its own TTFB. Tagging this protocol would let instrument contention alone unblock #102.",
    read: (c) => median(harnessStalls(c.meta).ttfb),
  },
  {
    key: "fetch.wallP50Ms",
    kind: "numeric",
    unit: "ms",
    floor: 0.2,
    floorBasis: FLOOR_PROVISIONAL,
    family: "harness",
    note: "end-to-end fetch() time to response headers, from the probe's own clock. Dominated by the same in-process fixture server as harness.ttfbP50Ms, so it carries that arm's own event-loop load and is recorded for context only.",
    read: (c) => num(c.raw?.fetchProbe?.wallSummary?.p50),
  },
  {
    key: "fetch.stallWarmP50Ms",
    kind: "numeric",
    unit: "ms",
    floor: 0.1,
    floorBasis: FLOOR_PROVISIONAL,
    family: "harness",
    // The one probe here that is SUPPOSED to read null everywhere, so the dead-leaf check must not
    // mistake its documented emptiness for a leaf that was renamed upstream.
    mayBeEmpty: true,
    note: "the PROBE'S OWN reading of the same quantity. Expected empty: it reads Resource Timing immediately after fetch() resolves at response headers, before the entry is queued at responseEnd. Kept as the evidence for that upstream gap — compare against harness.stallWarmP50Ms above.",
    read: (c) => median(stallByReuse(c.raw?.fetchProbe).warm),
  },

  // ── family 4: crude controls ───────────────────────────────────────────────────────────────────
  // NONE of these detect protocol attachment, and configuration C deliberately does NOT pass
  // --enable-automation, so C differs from A ONLY by the debugging port and the attached consumer.
  // Measured on Chrome 150 (provisional), navigator.webdriver nonetheless separates the controls cleanly — which
  // is a genuine finding about Chrome, and precisely why family membership gates the headline: a
  // suite whose ONLY discriminating probe is navigator.webdriver has learned nothing about the
  // protocol mechanisms it was built to test.
  {
    key: "controls.webdriver",
    kind: "rate",
    family: "control",
    note: "navigator.webdriver. No configuration here passes --enable-automation, so any separation is Chrome reacting to the debugging port / attached consumer itself.",
    read: (c) => bool(c.raw?.controls?.webdriver),
  },
  {
    key: "controls.nativeToStringIntact",
    kind: "rate",
    family: "control",
    note: "Function.prototype.toString still reports [native code] — an INVERTED signal: it detects the stealth patch, not the automation.",
    read: (c) => bool(c.raw?.controls?.nativeToStringIntact),
  },
  {
    key: "controls.cdcKeys",
    kind: "numeric",
    unit: "keys",
    floor: 0.5,
    floorBasis: FLOOR_EXACT_COUNT,
    discrete: true,
    family: "control",
    note: "ChromeDriver $cdc_ artifacts. Read in the MAIN world here, unlike the collector's isolated-world run, so a real expando would actually be visible.",
    read: (c) => num(c.raw?.controls?.cdcKeys),
  },
  {
    key: "controls.playwrightKeys",
    kind: "numeric",
    unit: "keys",
    floor: 0.5,
    floorBasis: FLOOR_EXACT_COUNT,
    discrete: true,
    family: "control",
    note: "__pw* / playwright* main-world expandos.",
    read: (c) => num(c.raw?.controls?.playwrightKeys),
  },
  {
    key: "controls.puppeteerKeys",
    kind: "numeric",
    unit: "keys",
    floor: 0.5,
    floorBasis: FLOOR_EXACT_COUNT,
    discrete: true,
    family: "control",
    note: "puppeteer* main-world expandos.",
    read: (c) => num(c.raw?.controls?.puppeteerKeys),
  },

  // ── family 5: the dead-sink check (#100's first stated way this could measure nothing) ─────────
  {
    key: "meta.consoleDebugNative",
    kind: "rate",
    family: "harness",
    note: "console.debug still reports [native code]. If this were false on our stack, every console-family probe above would be measuring a stubbed sink rather than an unattached protocol.",
    read: (c) => bool(c.meta?.consoleDebugNative),
  },

  // ── family 6: the collector's quantized leaves, i.e. what a gate built on the SHIPPED collector
  // would actually see. A bucket ladder that cannot resolve a separation the raw numbers show is a
  // real finding for #102: it would mean the gate has to read raw timings, not snapshot leaves.
  {
    key: "collector.cdp.consoleProxy.fired",
    kind: "rate",
    family: "protocol",
    note: "the same live probe as read through FINGERPRINT_COLLECTOR_JS, at its lower iteration count.",
    read: (c) => bool(c.collector?.cdp?.consoleProxy?.fired),
  },
  // The two quantized console-cost labels were REMOVED from the collector after they were
  // observed churning between two captures of one unchanged environment (lt1 <-> 1to4 — the
  // console cost on this browser sits on the ladder's 1ms edge). This run's own output had
  // already reported the errorStack one as 'varies' inside a single configuration, which is the
  // same defect seen from the other side. The signal those probes carry is the boolean and the
  // invocation count, both of which are read above and both of which validated the suite; the raw
  // per-sample cost still lives in CDP_TIMING_RAW_JS for threshold work.
  {
    key: "collector.cdp.consoleTiming.ratioBucket",
    kind: "label",
    family: "protocol",
    // The ladder that motivated RESOLUTION_LIMITED_LABELS. Its `below-resolution` label is emitted
    // when either median fails a resolution floor, replacing an earlier `b<=0 -> 'flat'/'unbounded'`
    // discontinuity in which two arms that both measured nothing could land on DIFFERENT labels and
    // read as a clean categorical separation of the controls. `separateLabel` now refuses an arm
    // whose whole observed set is drawn from those labels, so this probe can report the collector's
    // resolution honestly without that report becoming the thing that unblocks #102.
    note: "quantized rich/plain ratio, as the SHIPPED collector would see it. A gate written against the snapshot reads this label, not the raw means — so if the raw ratio separates and this does not, #102's gate has to read raw timings and the collector's ladder is too coarse to gate on.",
    read: (c) => c.collector?.cdp?.consoleTiming?.ratioBucket ?? null,
  },
  // ── the collector's PASSIVE Resource Timing section ─────────────────────────────────────────────
  // These used to read `collector.cdp.fetchProbe.*`. That section was an ACTIVE, cache-busted
  // favicon fetch inside FINGERPRINT_COLLECTOR_JS — i.e. the read-only parity harness was issuing
  // network requests against whatever real origin it was pointed at — so the active probe moved into
  // CDP_TIMING_RAW_JS (which only this baseline runs, against its own loopback fixture) and the
  // collector kept a PASSIVE read of performance.getEntriesByType('resource') over requests the page
  // had already made. Same quantity, no traffic of its own.
  //
  // The leaf names below are a CONTRACT with the shipped collector, asserted by assertProbeContracts()
  // BEFORE any browser is launched. That assertion exists because the failure mode of getting a leaf
  // name wrong is silent and maximally misleading: `read` would return undefined in every arm of
  // every round, the probe would summarize as n=0, and the run would report the probe as "did not
  // separate" — a renamed leaf presenting itself as evidence that our stack is invisible.
  {
    key: "collector.cdp.resourceTiming.stallMedianBucket",
    kind: "label",
    family: "protocol",
    note: "quantized pre-dispatch stall (requestStart - fetchStart) over the requests the page already made, as the SHIPPED collector sees it — passively, without issuing traffic of its own. This is the leaf a #102 gate written against the snapshot would actually read.",
    read: (c) => c.collector?.cdp?.resourceTiming?.stallMedianBucket ?? null,
  },
  {
    key: "collector.cdp.resourceTiming.stallMaxBucket",
    kind: "label",
    family: "protocol",
    note: "the WORST sub-resource's pre-dispatch stall, same ladder. A per-request interception pause lands on every request, so if the median moves the max should move with it; a max that separates while the median does not means only some requests were paused, which is a different mechanism and a different gate.",
    read: (c) => c.collector?.cdp?.resourceTiming?.stallMaxBucket ?? null,
  },
  {
    key: "collector.cdp.resourceTiming.entriesBucket",
    kind: "label",
    family: "harness",
    // COMPARABILITY, NOT DETECTION. The two ladders above are computed from whatever sub-resources
    // the page happened to load, and in this harness those are the raw probe's own cache-busted
    // fetches against the in-process fixture. If one arm produced a different NUMBER of entries, its
    // median is drawn from a different sample and the label comparison above is not like-for-like —
    // a difference here is therefore a reason to distrust a separation, never evidence of one.
    note: "how many resource entries the page had produced by collector time, bucketed. A harness property: it says whether the three arms' stall ladders were computed from comparable samples at all.",
    read: (c) => c.collector?.cdp?.resourceTiming?.entriesBucket ?? null,
  },
  {
    key: "collector.cdp.resourceTiming.timedBucket",
    kind: "label",
    family: "harness",
    note: "how many of those entries carried usable timing (requestStart > 0), bucketed — the actual sample count behind the stall ladders. Same role as entriesBucket: a comparability check on the instrument, not a signal from the browser.",
    read: (c) => c.collector?.cdp?.resourceTiming?.timedBucket ?? null,
  },
];

/**
 * The leaves this file reads out of the two IMPORTED probe sources, declared as a contract and
 * checked before the run spends twenty minutes producing nulls.
 *
 * WHY A SEPARATE LIST RATHER THAN AN ASSERTION INSIDE `read`. Every `read` above is written with
 * optional chaining, which is correct — a capture whose probe threw genuinely has no leaf, and that
 * must summarize as a null rather than crash the analysis. But the same tolerance means a leaf that
 * was RENAMED upstream is indistinguishable from a leaf that was empty this round, and the renamed
 * case is the dangerous one: it produces n=0 in every arm, which the analysis reports as "this probe
 * did not separate the controls", which is the exact sentence that reads as good news. The active
 * fetch probe moving out of the collector (`cdp.fetchProbe.*` -> `cdp.resourceTiming.*`) is precisely
 * that kind of change, and it happened while this file was being written.
 *
 * So: names are asserted against the imported SOURCE TEXT at startup, before a browser is launched,
 * and a mismatch aborts with the missing path plus the full set of paths the source actually
 * declares. The fix is then a one-line spec edit rather than a re-run.
 */
export const RAW_LEAF_CONTRACT = [
  ["errorStack", "fired"], ["errorStack", "summary"],
  ["consoleProxy", "fired"], ["consoleProxy", "invocations"], ["consoleProxy", "summary"],
  ["consoleTiming", "getterInvocations"], ["consoleTiming", "richSummary"], ["consoleTiming", "plainSummary"],
  ["fetchProbe", "wallSummary"], ["fetchProbe", "stallMs"], ["fetchProbe", "reused"],
  ["controls", "webdriver"], ["controls", "nativeToStringIntact"],
  ["controls", "cdcKeys"], ["controls", "playwrightKeys"], ["controls", "puppeteerKeys"],
  ["selfTest", "getterFires"], ["selfTest", "ownKeysFires"], ["selfTest", "clockAdvances"],
];

export const COLLECTOR_LEAF_CONTRACT = [
  ["consoleProxy", "fired"],
  ["consoleTiming", "ratioBucket"],
  ["resourceTiming", "stallMedianBucket"], ["resourceTiming", "stallMaxBucket"],
  ["resourceTiming", "entriesBucket"], ["resourceTiming", "timedBucket"],
];

/** `<root>.<section>.<leaf>` paths a probe source assigns into, as written in its source text. */
export function declaredLeafPaths(source, root) {
  const found = new Set();
  const re = new RegExp(`\\b${root}\\.([A-Za-z_$][\\w$]*)\\.([A-Za-z_$][\\w$]*)`, "g");
  for (const m of String(source ?? "").matchAll(re)) found.add(`${m[1]}.${m[2]}`);
  return found;
}

/**
 * Assert that a probe source still declares every leaf this file reads out of it.
 *
 * TWO ACCEPTANCE SHAPES, because the sources legitimately write leaves two ways: assignment
 * (`report.fetchProbe.stallSummary = ...`, which the dotted scan sees) and object-literal
 * initialization (`resourceTiming: { stallMedianBucket: null, ... }`, which it does not). A loose
 * match — the section declared as a key AND the leaf declared as a key — accepts the second shape
 * while still failing on a rename, since a renamed leaf's identifier appears nowhere. Loose matches
 * are returned so the caller can print them: "we found it, but not where we expected" is worth
 * seeing on a run whose whole job is to notice when it is measuring nothing.
 */
export function assertLeafContract(name, source, root, pairs) {
  if (typeof source !== "string" || !source.length) throw new Error(`${name} is not a non-empty string`);
  const found = declaredLeafPaths(source, root);
  const missing = [];
  const loose = [];
  for (const [section, leaf] of pairs) {
    const path = `${section}.${leaf}`;
    if (found.has(path)) continue;
    const sectionDeclared = new RegExp(`(^|[^\\w$.])${section}\\s*:`).test(source) || new RegExp(`\\b${root}\\.${section}\\b`).test(source);
    const leafDeclared = new RegExp(`(^|[^\\w$.])${leaf}\\s*:`).test(source) || new RegExp(`\\.${leaf}\\b`).test(source);
    if (sectionDeclared && leafDeclared) { loose.push(path); continue; }
    missing.push(`${path} (section ${sectionDeclared ? "found" : "MISSING"}, leaf ${leafDeclared ? "found" : "MISSING"})`);
  }
  if (missing.length) {
    throw new Error(
      `${name} no longer declares ${missing.length} leaf/leaves this baseline reads: ${missing.join("; ")}. ` +
        `A renamed leaf reads as undefined in EVERY configuration, which this run would otherwise report as "the probe did not separate the controls" — a measurement failure dressed as a clean result. ` +
        `Paths ${root}.* currently declares: ${[...found].sort().join(", ") || "(none found by the dotted scan)"}. Update PROBE_SPECS and the contract list together.`,
    );
  }
  return { loose };
}

/**
 * The query parameter the imported raw probe puts on its cache-busted sub-resource fetches, and the
 * ONLY thing that tells this harness's post-run Resource Timing read which entries are the probe's.
 *
 * A SECOND CROSS-FILE CONTRACT, AND IT WAS THE UNDECLARED ONE. The leaf contract above covers the
 * shape of the probe's RESULT; this covers the shape of its TRAFFIC. `meta.resourceTiming` is built
 * by filtering performance.getEntriesByType('resource') on this token, and that recovered list is
 * the sole source of pre-dispatch latency data in the whole run — the imported probe reads the
 * entries before Chrome queues them, so without the harness read the entire Fetch-interception
 * family, the one family that survives the V8 fixes retiring the discrete probes, is empty. Rename
 * the parameter upstream and every capture in every arm reports zero rows: a silent, total loss of
 * one probe family that surfaces only in the "harness recovered Resource Timing rows" check, twenty
 * minutes into a container run, rather than in the one second this assertion costs.
 */
export const RAW_CACHE_BUSTER = "bgwfp=";

/**
 * Assert the traffic contract. Exported separately from `assertProbeContracts` so a test can drive
 * the failure with a synthetic source rather than only against today's build output.
 */
export function assertCacheBusterContract(source, token = RAW_CACHE_BUSTER) {
  if (typeof source !== "string" || !source.length) throw new Error("CDP_TIMING_RAW_JS is not a non-empty string");
  if (source.includes(token)) return { token };
  throw new Error(
    `CDP_TIMING_RAW_JS no longer marks its sub-resource fetches with "${token}". This baseline recovers the ` +
      `pre-dispatch stall series by filtering performance.getEntriesByType('resource') on that token — the imported ` +
      `probe reads its own entries before Chrome queues them at responseEnd, so the harness read is the ONLY source ` +
      `of request-interception latency in the run. With the token renamed, meta.resourceTiming is empty in every ` +
      `capture of every configuration and the entire Fetch-interception family reports "did not separate the ` +
      `controls" — a measurement failure dressed as a clean result. Update RAW_CACHE_BUSTER to match the probe source.`,
  );
}

/**
 * The startup gate for both imported sources. Called from `main()` before anything is spawned, and
 * from the unit tests against the built sources, so the two can never disagree about the shape.
 */
export function assertProbeContracts({ withCollector = WITH_COLLECTOR } = {}) {
  const raw = assertLeafContract("CDP_TIMING_RAW_JS", CDP_TIMING_RAW_JS, "report", RAW_LEAF_CONTRACT);
  assertCacheBusterContract(CDP_TIMING_RAW_JS);
  const collector = withCollector
    ? assertLeafContract("FINGERPRINT_COLLECTOR_JS", FINGERPRINT_COLLECTOR_JS, "cdp", COLLECTOR_LEAF_CONTRACT)
    : { loose: [], skipped: true };
  return { raw, collector, cacheBuster: RAW_CACHE_BUSTER };
}

/**
 * A threshold for the case the A-vs-C axis cannot express: B separated from BOTH controls.
 *
 * There is no "correct" side to sit on here — A is the reference simply because it is the browser
 * with nothing attached. The threshold is the midpoint of the observed A→B gap, and it FAILS the
 * current stack on purpose: it is the line a fix has to get back under, not a baseline we pass.
 */
export function recommendOutlierGate(spec, a, b) {
  if (spec.kind === "rate") {
    return {
      kind: "rate",
      rule: `expect ${a.rate >= 0.5 ? "true" : "false"} (configuration A's reading) — our stack currently reads the other way`,
      threshold: a.rate >= 0.5,
      tolerance: `A was ${a.trueCount}/${a.n}; B was ${b.trueCount}/${b.n}`,
      bMargin: "B FAILS this gate by construction — it is the divergence to close",
      headroomWidths: null,
      failsToday: true,
    };
  }
  if (spec.kind === "label") {
    return {
      kind: "label",
      rule: `expect a label in {${a.set.join(", ")}} — our stack currently produces {${b.set.join(", ")}}`,
      threshold: a.set,
      tolerance: `A produced only {${a.set.join(", ")}} across ${a.n} rounds`,
      bMargin: "B FAILS this gate by construction — it is the divergence to close",
      headroomWidths: null,
      failsToday: true,
    };
  }
  const aLow = a.p50 < b.p50;
  const gap = aLow ? b.min - a.max : a.min - b.max;
  const threshold = aLow ? a.max + gap / 2 : a.min - gap / 2;
  const aNoise = Math.max(a.spread ?? 0, spec.floor ?? 0);
  return {
    kind: "numeric",
    rule: `fail when the value is ${aLow ? ">" : "<"} ${threshold.toPrecision(4)}${spec.unit ? " " + spec.unit : ""} (referenced to configuration A, not to C)`,
    threshold,
    // Unlike recommendGate this one is NOT refused on a degenerate band: it fails the current stack
    // by design, so it is a target to get under rather than a line the stack has to hold, and an
    // unmeasured headroom cannot flake a gate nobody passes yet. It still has to say so.
    tolerance: `A's observed noise band across ${a.n} rounds was ${(a.spread ?? 0).toPrecision(3)}${spec.unit ? " " + spec.unit : ""} (floor ${spec.floor ?? 0})${a.spread > 0 ? "" : " — SPREAD 0: the headroom below is derived from the floor, not from measurement"}`,
    bMargin: `B sits at ${b.p50.toPrecision(4)}${spec.unit ? " " + spec.unit : ""}, ${(Math.abs(b.p50 - a.p50) / aNoise).toPrecision(3)} of A's noise widths away — this gate FAILS today by design`,
    headroomWidths: aNoise > 0 ? Math.abs(threshold - (aLow ? a.max : a.min)) / aNoise : null,
    // Same disclosure as recommendGate. Reachable only for a discrete probe: an outlier gate exists
    // only where separationAB separated, and on a continuous probe that already requires A's spread
    // to have cleared the floor — so "exact-quantum" here always means a count, never a smoke-run
    // constant standing in for a measurement.
    headroomBasis: (a.spread ?? 0) >= (spec.floor ?? 0) ? "observed" : "exact-quantum",
    failsToday: true,
  };
}

/**
 * Summarize one probe across every configuration, then grade B.
 *
 * TWO INDEPENDENT QUESTIONS, and the second one is the reason this function does more than the
 * ticket's brief:
 *
 *  1. A vs C — did the probe DISCRIMINATE at all? This is the epic's validity check.
 *  2. B vs A *and* B vs C — is our stack distinguishable from BOTH controls? An A→C axis cannot
 *     express that case at all: whatever B does, "where is B on the A-C line" is meaningless when
 *     A and C sit on top of each other. And it is not a hypothetical — request-interception latency
 *     is exactly that shape, because naive automation does NOT intercept requests, so configuration
 *     C has no more of it than configuration A. Measured on Chrome 150 (provisional) the warm pre-dispatch stall
 *     read A 0.17ms / C 0.17ms / B 1.6ms: a signature UNIQUE to our stack, which an A-vs-C-only
 *     analysis would have reported as "INDETERMINATE, nothing to see".
 */
export function analyzeProbe(spec, valuesByConfig) {
  const summarize = spec.kind === "rate" ? summarizeRate : spec.kind === "label" ? summarizeLabel : summarizeNumeric;
  const separate =
    spec.kind === "rate" ? (x, y) => separateRate(x, y)
      : spec.kind === "label" ? (x, y) => separateLabel(x, y)
        // `discrete` travels from the spec into every one of the three comparisons (A|C, A|B, B|C),
        // so an integer-count probe is exempt from the resolution rule consistently rather than only
        // on the axis the ticket happened to frame.
        : (x, y) => separateNumeric(x, y, spec.floor ?? 0, { discrete: spec.discrete === true });
  const summaries = {};
  for (const [cfg, values] of Object.entries(valuesByConfig)) summaries[cfg] = summarize(values);
  const a = summaries.A;
  const b = summaries.B;
  const c = summaries.C;

  const separation = separate(a, c);
  const separationAB = separate(a, b);
  const separationBC = separate(b, c);
  const bOutlier = separationAB.separated && separationBC.separated;

  const position =
    spec.kind === "rate" ? positionRate(a, b, c) : spec.kind === "label" ? positionLabel(a, b, c) : positionNumeric(a, b, c, spec.floor ?? 0);
  // A verdict on a probe that never discriminated is noise dressed as a finding: without separation
  // "B looks like A" only means "nothing here moved", which is equally true of a broken probe. The
  // outlier case overrides the axis entirely — calling B "matching" a control it is measurably
  // separated from would be a contradiction dressed as reassurance.
  const verdict = bOutlier ? "B-OUTLIER" : separation.separated ? position.verdict : "INDETERMINATE";
  const gate = bOutlier && !separation.separated ? recommendOutlierGate(spec, a, b) : recommendGate(spec, a, b, c, separation);
  return { spec, summaries, separation, separationAB, separationBC, bOutlier, position, verdict, gate };
}

/**
 * Grade the whole run. The headline is the epic's one mandatory check: no separation between the
 * controls means the PROBES are inadequate, and saying anything about B in that state would be
 * inventing a result.
 */
export const GRADED_CONFIGS = ["A", "B", "C"];

/**
 * The sentence the epic says must be printed when the suite did not demonstrate that it can see an
 * attached consumer. It is a PREFIX rather than a status of its own because a finding can outrank it
 * for the headline slot — `bOutlier` is computed per probe, independent of whether the controls ever
 * separated, so a run in which no protocol probe discriminated could still lead with "OUR STACK IS
 * DISTINGUISHABLE FROM BOTH CONTROLS" and read, in the ticket it gets quoted into, as a validated
 * finding about our stack. Instrument validity is not allowed to be displaced by a finding.
 */
const INADEQUACY_PREFIX =
  "OUR PROTOCOL PROBES ARE INADEQUATE (no protocol-family probe separated the positive control from the negative control, so nothing here shows this suite can see an attached consumer at all) — and, separately: ";

/**
 * The contradiction the completeness critic predicted, made unreachable rather than merely unlikely.
 *
 * The two rules that decide "this probe validated the suite" and "this probe can be thresholded" live
 * in different functions and were derived at different times, so they could disagree — and when they
 * did, the run printed "#102 gate: UNBLOCKED" in one section and "NO THRESHOLD OFFERED — configuration
 * A produced no observable noise band" for the SAME probe in the next. A reader quoting the headline
 * into the ticket would be quoting a probe the instrument had already refused to stand behind.
 *
 * After the resolution-floor change the two rules are consistent by construction (a continuous probe
 * that separates has cleared exactly the band recommendGate demands), so this returns nothing on a
 * healthy run. It stays because "consistent by construction" is a property of today's code: it turns
 * any future divergence into a blocking instrument failure at the moment it is introduced, instead of
 * into a confident sentence in a ticket.
 */
/**
 * Refusal reasons that are NOT a disagreement between the separation rule and the threshold rule.
 *
 * Declared as an explicit allowlist rather than as an allowlist's inverse, so the guard keeps its
 * fail-loud-on-the-unknown property: any refusal reason not named here — including one added later —
 * still trips an instrument failure. The one entry is the label refusal above, where both rules are
 * right at the same time: the arm DID resolve in some rounds (so the comparison was made) and the
 * threshold would still accept a sub-resolution label (so no number can be shipped). Treating that
 * as a contradiction would abort a run over a correctly-refused threshold and, worse, would print a
 * message blaming a noise band that was never the issue.
 */
const NON_CONTRADICTORY_REFUSALS = new Set(["threshold-would-accept-a-sub-resolution-label"]);

export function internalConsistencyFailures(probes) {
  const failures = [];
  for (const p of probes) {
    if ((p.spec.family ?? "protocol") !== "protocol") continue;
    if (!p.separation.separated) continue;
    if (p.gate?.refused && !NON_CONTRADICTORY_REFUSALS.has(p.gate.refusedBecause)) {
      failures.push(
        `internal inconsistency: ${p.spec.key} counted as a protocol-family validator while its own #102 threshold was REFUSED (${p.gate.refusedBecause ?? "no reason recorded"}) — the separation rule and the threshold rule disagree about whether this probe has a measured noise band, so one of them is wrong and the gate cannot be trusted either way`,
      );
    }
    if (p.separation.resolutionLimited) {
      failures.push(
        `internal inconsistency: ${p.spec.key} is flagged resolution-limited AND separated, which the separation rule is supposed to make impossible`,
      );
    }
  }
  return failures;
}

/**
 * A leaf that reads null in EVERY configuration of every round is not a quiet probe — it is a leaf
 * that is not being populated, and the run has to say so rather than report "no separation".
 *
 * The startup contract check catches the renames it can see in the source text; this catches the rest
 * (a leaf that exists but is never populated, a section the collector stopped emitting under some
 * condition) using the run's own data. Both have to be blocking for the same reason: the symptom of a
 * dead leaf is "the probe did not separate the controls", which is indistinguishable from good news.
 *
 * BUT THE DIAGNOSIS MUST NOT CONTRADICT WHAT THIS RUN ALREADY ESTABLISHED. When `contractsAsserted`
 * is true the startup check has ALREADY verified, against the imported source text, that the source
 * still declares this leaf — so "renamed or removed upstream" is a claim the same run disproved a
 * second after it started, and it sends the reader to grep for a name that is right there. The live
 * shape is the opposite: a leaf that is CONDITIONALLY assigned upstream and whose condition no arm
 * satisfied. The shipped collector's resource-timing section is exactly that — `entriesBucket` and
 * `timedBucket` are assigned unconditionally while `stallMedianBucket`/`stallMaxBucket` are assigned
 * only when at least one entry carried usable timing — so a page with no timed entries kills the two
 * protocol-family leaves and leaves the two harness comparability leaves alive. That asymmetry is
 * itself the evidence, so the message carries it: which sibling leaves under the same section DID
 * populate and what they read, plus how many captures reported a collector error.
 *
 * Probes that declare `mayBeEmpty` are exempt — there is exactly one, and its emptiness is a
 * documented upstream gap this baseline exists to evidence rather than a defect in the wiring.
 */
export function deadLeafFailures(
  probes,
  { withCollector = true, configs = GRADED_CONFIGS, contractsAsserted = false, collectorErrors = null } = {},
) {
  const describe = (spec, s) => {
    if (!s || s.n === 0) return "n=0";
    if (spec.kind === "label") return `{${s.set.join(",")}}`;
    if (spec.kind === "rate") return `${s.trueCount}/${s.n}`;
    return `p50=${s.p50}`;
  };
  const failures = [];
  for (const p of probes) {
    if (p.spec.mayBeEmpty) continue;
    if (!withCollector && p.spec.key.startsWith("collector.")) continue;
    const graded = configs.map((cfg) => p.summaries[cfg]).filter(Boolean);
    if (!graded.length) continue;
    if (!graded.every((s) => s.n === 0)) continue;

    const head = `${p.spec.key} produced NO readings in any configuration (${configs.map((cfg) => `${cfg} n=0`).join(", ")})`;
    if (!contractsAsserted) {
      failures.push(
        `${head} — the leaf it reads has almost certainly been renamed or removed upstream, and a renamed leaf reports as "this probe did not separate the controls"`,
      );
      continue;
    }
    // Siblings under the same dotted section. A live sibling is proof the section is being emitted,
    // which narrows the diagnosis from "the wire is broken" to "this specific assignment is guarded
    // by a condition no arm met" — a completely different fix, upstream in the probe source.
    const section = p.spec.key.slice(0, p.spec.key.lastIndexOf("."));
    const liveSiblings = probes.filter(
      (q) =>
        q !== p &&
        section.length > 0 &&
        q.spec.key.startsWith(`${section}.`) &&
        configs.some((cfg) => (q.summaries[cfg]?.n ?? 0) > 0),
    );
    const siblingEvidence = liveSiblings.length
      ? ` Sibling leaves under ${section}.* DID populate, so the section is alive and this leaf is guarded by a condition no arm satisfied: ${liveSiblings
          .map((q) => `${q.spec.key} ${configs.map((cfg) => `${cfg}=${describe(q.spec, q.summaries[cfg])}`).join(" ")}`)
          .join("; ")}.`
      : ` No sibling leaf under ${section}.* produced a reading either, so the whole section is missing from the payload — look at whether it is emitted at all before looking at this leaf.`;
    const collectorEvidence =
      p.spec.key.startsWith("collector.") && collectorErrors
        ? ` Collector errors were reported in ${collectorErrors.n}/${collectorErrors.of} reporting capture(s)${collectorErrors.n ? " — read those first, an erroring collector emits no section at all" : ", so the collector itself ran cleanly"}.`
        : "";
    failures.push(
      `${head} — DECLARED UPSTREAM BUT NEVER POPULATED, not renamed: the startup leaf-contract check passed for this path against the imported source text, so the name is still there and the assignment simply never ran in any arm.${siblingEvidence}${collectorEvidence} Either way the probe reports as "this probe did not separate the controls", which is indistinguishable from good news, so it blocks`,
    );
  }
  return failures;
}

/**
 * The sentence that keeps "we could not resolve it" from being read as "there was nothing there".
 *
 * A resolution-limited comparison is the one shape whose honest report ("not separated") and whose
 * dishonest one ("the probe is quiet, our stack is invisible") are the same words. Naming the probes
 * makes the difference visible in the headline itself, which is the part that gets quoted.
 */
function resolutionSuffix(protocolResolutionLimited) {
  if (!protocolResolutionLimited.length) return "";
  return ` NOTE: ${protocolResolutionLimited.length} protocol-family probe(s) were RESOLUTION-LIMITED rather than quiet (${protocolResolutionLimited.map((p) => p.spec.key).join(", ")}): at least one arm produced no noise band above the probe's own stated floor, so the comparison could not be made at all. That is a call for more rounds or a coarser-resolution probe, NOT evidence that nothing is there.`;
}

export function analyze(captures, opts = {}) {
  const configs = opts.configs ?? GRADED_CONFIGS;
  const valid = captures.filter((x) => x.valid);
  const byConfig = {};
  for (const cfg of configs) byConfig[cfg] = valid.filter((x) => x.config === cfg);

  const probes = PROBE_SPECS.map((spec) => {
    const values = {};
    for (const cfg of configs) values[cfg] = byConfig[cfg].map((cap) => spec.read(cap.payload));
    return analyzeProbe(spec, values);
  });

  const discriminating = probes.filter((p) => p.separation.separated);
  // Only a PROTOCOL-family separation validates the suite. A crude control that separates proves
  // the two browsers differ, which we already knew — it says nothing about whether the probes
  // aimed at preview serialization and request interception can see anything. `context` is excluded
  // by the same expression: a cold-start-confounded number is not a protocol observation either.
  const protocolDiscriminating = discriminating.filter((p) => (p.spec.family ?? "protocol") === "protocol");
  const controlOnly = discriminating.filter((p) => p.spec.family === "control");
  // Comparisons the instrument REFUSED to call separations because at least one arm produced no
  // observable noise band (or, for a label probe, produced only sub-resolution labels). These are the
  // readings that used to become separations on a bar of 2x a hardcoded floor. Surfaced as their own
  // list because "we could not resolve this" and "there was nothing here" are different findings and
  // only the first one is fixed by more rounds.
  const resolutionLimited = probes.filter((p) => p.separation.resolutionLimited);
  const protocolResolutionLimited = resolutionLimited.filter((p) => (p.spec.family ?? "protocol") === "protocol");
  const contextProbes = probes.filter((p) => (p.spec.family ?? "protocol") === "context");
  // Everything that separated but cannot validate anything. NOT the same list as controlOnly: two
  // probes are harness-family, so a run whose sole separator is fixture latency or the dead-sink
  // check would otherwise render its own explanation as "CRUDE CONTROLS ()" — an empty parenthetical
  // offered as the reason the suite is inadequate.
  const nonProtocolDiscriminating = discriminating.filter((p) => (p.spec.family ?? "protocol") !== "protocol");
  const bMatchesC = discriminating.filter((p) => p.verdict === "B-matches-C");
  const bBetween = discriminating.filter((p) => p.verdict === "B-between");
  const bMatchesA = discriminating.filter((p) => p.verdict === "B-matches-A");
  // Distinguishable from BOTH controls — a signature no browser in this experiment has except ours.
  const bOutliers = probes.filter((p) => p.bOutlier);
  const protocolOutliers = bOutliers.filter((p) => (p.spec.family ?? "protocol") === "protocol");

  const counts = Object.fromEntries(configs.map((cfg) => [cfg, byConfig[cfg].length]));
  // Only A, B and C are graded. The optional B0 arm is a diagnostic: it attributes any B/A gap to
  // the Fetch guard rather than the driver pipe, and a thin B0 must not fail the run.
  const thin = GRADED_CONFIGS.filter((cfg) => (byConfig[cfg]?.length ?? 0) < 2);

  // Checks the RUNNER performed and could not perform here, because they are properties of the run
  // rather than of the numbers: a stubbed console sink, a renderer that lost focus in exactly one
  // configuration, a driver still settling inside the measurement window. Each of them makes the
  // three columns incomparable, so each of them is an instrument failure — an earlier revision
  // printed them and then computed a green headline anyway, which is the same as not having them.
  // Plus two the analysis CAN perform on its own, both of which make the columns unreadable in a way
  // that looks like a clean result: a rule disagreeing with itself about a probe, and a leaf that
  // produced nothing anywhere.
  //
  // The dead-leaf check is handed two facts it cannot derive from the numbers, both of which change
  // its DIAGNOSIS rather than its verdict: whether the startup contract check already proved the leaf
  // is still declared upstream (in which case "renamed" is a claim this run disproved), and how many
  // captures reported a collector error (an erroring collector emits no section, which is a different
  // fix from a conditional assignment that never ran).
  const reportingCaptures = captures.filter((c) => c?.payload);
  const collectorErrors = {
    n: reportingCaptures.filter((c) => c.payload?.collectorError).length,
    of: reportingCaptures.length,
  };
  const instrumentFailures = [
    ...(opts.instrumentFailures ?? []),
    ...internalConsistencyFailures(probes),
    ...deadLeafFailures(probes, {
      withCollector: opts.withCollector !== false,
      configs: GRADED_CONFIGS.filter((cfg) => configs.includes(cfg)),
      contractsAsserted: opts.contractsAsserted === true,
      collectorErrors,
    }),
  ];
  const probesInadequate = protocolDiscriminating.length === 0;

  let status;
  let headline;
  if (thin.length) {
    status = "INSTRUMENT-FAILED";
    headline = `Too few valid captures to compare: ${thin.map((cfg) => `${cfg}=${counts[cfg] ?? 0}`).join(", ")} (need >= 2 each). Nothing below is a measurement.`;
    // Explicitly false means the caller MEASURED that C never received Runtime events. Undefined
    // means the caller had no receipt to offer, so the check is skipped rather than assumed either
    // way — a default of `true` here would silently retire the epic's most important guard.
  } else if (opts.positiveControlAttached === false) {
    status = "INSTRUMENT-FAILED";
    headline =
      "The positive control never actually attached: configuration C received no Runtime.consoleAPICalled events, so 'C' is a Chrome with an idle debugging port, not an attached consumer. Every negative below is uninterpretable.";
  } else if (instrumentFailures.length) {
    status = "INSTRUMENT-FAILED";
    headline = `The instrument did not hold its own preconditions, so the three columns are not comparable: ${instrumentFailures.join(" | ")}. Nothing below is a measurement.`;
    // A signature neither control has outranks everything below it: it is the only outcome in which
    // our stack is uniquely identifiable, and it is invisible to the A-vs-C axis the ticket framed.
  } else if (protocolOutliers.length) {
    status = "FINDING-B-OUTLIER";
    headline = `${probesInadequate ? INADEQUACY_PREFIX : ""}OUR STACK IS DISTINGUISHABLE FROM BOTH CONTROLS on ${protocolOutliers.length} protocol probe(s): ${protocolOutliers.map((p) => p.spec.key).join(", ")}. Neither an undriven Chrome nor naive automation produces this — it is a signature specific to what we ship, and no A-vs-C comparison can see it because the two controls agree with each other.`;
  } else if (bMatchesC.length) {
    status = "FINDING-B-MATCHES-C";
    headline = `${probesInadequate ? INADEQUACY_PREFIX : ""}${discriminating.length} probe(s) discriminate, and on ${bMatchesC.length} of them OUR STACK SITS ON THE NAIVE-AUTOMATION SIDE: ${bMatchesC.map((p) => p.spec.key).join(", ")}.`;
  } else if (discriminating.length === 0) {
    status = "PROBES-INADEQUATE";
    headline =
      "OUR PROBES ARE INADEQUATE. The positive control (C: --remote-debugging-port + Runtime.enable) did not separate from the negative control (A: no protocol at all) on a SINGLE probe. That is a statement about the instrument, NOT about our stack: a suite that cannot see obvious automation cannot certify that we are clean." +
      resolutionSuffix(protocolResolutionLimited);
  } else if (probesInadequate) {
    status = "PROBES-INADEQUATE";
    headline = `OUR PROTOCOL PROBES ARE INADEQUATE. The only probe(s) that separated the controls are CRUDE CONTROLS, INSTRUMENT SELF-CHECKS or CONFOUNDED CONTEXT (${nonProtocolDiscriminating.map((p) => `${p.spec.key} [${p.spec.family ?? "protocol"}]`).join(", ")}), which reflect the automation surface, this harness's own load, or a difference in browser age rather than protocol attachment. Every probe aimed at preview serialization and request-interception latency measured nothing, so this run cannot certify that our stack is protocol-invisible — it can only say that our stack is not naive automation, which navigator.webdriver already told us.${resolutionSuffix(protocolResolutionLimited)}`;
  } else if (bBetween.length) {
    status = "FINDING-B-BETWEEN";
    headline = `${discriminating.length} probe(s) discriminate (${protocolDiscriminating.length} protocol-family); our stack is measurably between the controls on ${bBetween.length} of them: ${bBetween.map((p) => p.spec.key).join(", ")}.`;
  } else {
    status = "B-MATCHES-A";
    headline = `${discriminating.length} probe(s) discriminate (${protocolDiscriminating.length} protocol-family), and our stack sits with the no-protocol control on all of them.`;
  }

  // The gate's precondition is INDEPENDENT of which finding won the headline: #102 can only be
  // written against a probe family that has been shown to discriminate a known-attached consumer.
  // A B-outlier finding is informative but is not that proof — it validates nothing about whether
  // the console/preview probes can see a consumer, so it does not unblock the gate on its own.
  const protocolValidated = protocolDiscriminating.length > 0;
  const gateBlockedReasons = [];
  if (status === "INSTRUMENT-FAILED") gateBlockedReasons.push("the instrument failed");
  if (!protocolValidated) gateBlockedReasons.push("no protocol-family probe separated the controls");
  // The analysis cannot see the capture ORDER — it only ever receives the values — so the runner has
  // to declare it, and only an explicit `false` counts as the confound. With A always first and C
  // always last in every round, within-round host drift is indistinguishable from the A-vs-C
  // separation that unblocks the gate, and every probe here is host-load sensitive.
  if (opts.rotated === false) {
    gateBlockedReasons.push("configurations ran in fixed within-round order, so an A-vs-C separation cannot be attributed to the protocol rather than to within-round drift (drop CDP_BASELINE_ROTATE=0)");
  }
  // THE SAME CONFOUND AS A FIXED ORDER, ONE STEP WEAKER, AND IT USED TO BE A PRINTED NOTE.
  //
  // The rotation only equalizes position when the round count divides by the number of rotated
  // positions. At five rounds with three positions, one configuration takes the quietest within-round
  // slot twice and another takes it once — a per-configuration bias on exactly the axis the gate
  // reads, produced by the mechanism added to remove it. That is the same class of finding that
  // blocks when rotation is off entirely, so blocking one while printing a NOTE about the other left
  // the cheaper version of the confound able to unblock #102. Declared by the runner for the same
  // reason `rotated` is: the analysis only ever sees values, never the schedule, and only an explicit
  // `false` counts so an unstated schedule is never assumed to be the bad one.
  if (opts.rotated !== false && opts.roundsBalanced === false) {
    gateBlockedReasons.push("the round count is not a multiple of the number of rotated positions, so one configuration got an extra turn in the quietest within-round slot — a per-configuration bias on the same axis an A-vs-C separation is read from (use a multiple of 3, e.g. CDP_BASELINE_ROUNDS=6)");
  }
  // A VALIDATED SUITE THAT CAN HAND #102 NOTHING IS NOT AN UNBLOCKED GATE.
  //
  // `protocolValidated` answers "can this suite see an attached consumer at all", which is the
  // epic's validity question — but #102 is the ticket that has to SHIP A NUMBER, and the two came
  // apart in two ways that both printed "#102 gate: UNBLOCKED" above their own contradiction:
  //
  //  1. A REFUSED THRESHOLD. A label validator whose accept-set contains a sub-resolution label is
  //     refused above (a gate that passes because the measurement failed), and a numeric one can be
  //     refused for a degenerate band. The refusal printed forty lines below the green headline.
  //  2. HEADROOM UNDER ONE NOISE WIDTH. The separation rule compares the gap against the TIGHTER
  //     arm's band while the headroom is expressed in A's OWN band, so a probe where A is the wide
  //     arm can separate cleanly (gap >= 2x C's tight band) and still put the threshold a fiftieth of
  //     A's own spread above A's worst round. The gate section already says "this gate will flake";
  //     the headline said UNBLOCKED anyway. That is the same confident-headline-above-a-caveat shape
  //     the instrument-validity work closed, reached by a different route.
  //
  // Blocking is the honest reading: the suite is validated (that stays in the headline and in
  // `protocolValidated`) but the run produced no threshold #102 could write down, which is a reason
  // to re-run with more rounds or a coarser probe rather than to open the ticket.
  // A NUMERIC gate with no headroom figure at all counts as unusable, not as usable-by-default: the
  // headroom is the only thing that says whether the threshold survives a busy host, and "we could
  // not compute it" is not the same claim as "it is wide". Rate and label gates legitimately carry a
  // null headroom — their tolerance is "0 of n rounds may disagree" / an accept-set, which has no
  // width — so only the numeric kind is held to the number.
  const gateUsable = (gate) => {
    if (!gate || gate.refused) return false;
    if (gate.kind !== "numeric") return true;
    return typeof gate.headroomWidths === "number" && Number.isFinite(gate.headroomWidths) && gate.headroomWidths >= 1;
  };
  const usableThresholds = protocolDiscriminating.filter((p) => gateUsable(p.gate));
  if (protocolValidated && usableThresholds.length === 0) {
    const why = (p) => {
      if (!p.gate) return "no gate produced";
      if (p.gate.refused) return `REFUSED: ${p.gate.refusedBecause ?? "no reason recorded"}`;
      if (typeof p.gate.headroomWidths === "number" && Number.isFinite(p.gate.headroomWidths)) {
        return `headroom ${p.gate.headroomWidths.toFixed(2)} noise widths, under one, so the gate would flake on a busy host`;
      }
      return "numeric gate with no computable headroom, so nothing says whether it survives a busy host";
    };
    gateBlockedReasons.push(
      `every protocol-family probe that validated the suite offers #102 no usable threshold — ${protocolDiscriminating
        .map((p) => `${p.spec.key} (${why(p)})`)
        .join("; ")}. The suite is validated; the NUMBER is not available from this run`,
    );
  }
  const gateBlocked = gateBlockedReasons.length > 0;
  return {
    probes, discriminating, protocolDiscriminating, controlOnly, nonProtocolDiscriminating,
    resolutionLimited, protocolResolutionLimited, contextProbes,
    bMatchesA, bBetween, bMatchesC, bOutliers, protocolOutliers,
    counts, status, headline, gateBlocked, gateBlockedReasons, protocolValidated, probesInadequate,
    usableThresholds,
    instrumentFailures,
    // Carried through from the runner so the context-family printer can put the confound's own
    // measurement next to the probe it confounds, in the same block of output.
    browserAgeByConfig: opts.browserAgeByConfig ?? null,
  };
}

/**
 * What B0 buys: for every probe where OUR STACK separated from the no-protocol control, did the SAME
 * stack without the Fetch guard separate too?
 *
 * This is epic #92's actual question and the reason B0 is on by default. B-vs-A on its own cannot
 * distinguish "the driver's pipe and session bookkeeping are visible" from "our nav guard's
 * Fetch.enable urlPattern '*' is visible", and those imply different work: one is a driver problem,
 * the other is ours to fix in the guard. B0 answers it by holding everything else constant — same
 * core, same launch, same page — and removing only `setNavigationGuard`, which is what installs the
 * browser-level session and the interception.
 *
 * Reported, never graded: B0 is not one of GRADED_CONFIGS, a thin B0 cannot fail the run, and nothing
 * here feeds `protocolValidated`. When B0 was not run at all the rows say UNRESOLVED rather than
 * quietly omitting the question.
 */
export function attributeToGuard(probes, { minCaptures = 2 } = {}) {
  const rows = [];
  for (const p of probes) {
    if (!p.separationAB?.separated) continue;
    const a = p.summaries.A;
    const b0 = p.summaries.B0;
    const base = { key: p.spec.key, family: p.spec.family ?? "protocol" };
    // ABSENT AND THIN ARE DIFFERENT FACTS, and printing one as the other sends the operator to an
    // env var they never set. `!b0` means the arm was never in this run's configuration set — the
    // CDP_BASELINE_NOGUARD=0 case, where the advice is real. `b0.n < minCaptures` means the arm RAN
    // and its captures were dropped as invalid or errored, where the advice is to look at why those
    // captures failed; telling that operator to "drop CDP_BASELINE_NOGUARD=0" is advice for a
    // setting they do not have and hides the actual failure.
    if (!b0) {
      rows.push({ ...base, verdict: "UNRESOLVED", detail: "no B0 arm in this run (CDP_BASELINE_NOGUARD=0 drops it) — a B-vs-A separation here cannot be attributed to the Fetch guard rather than to the driver pipe" });
      continue;
    }
    if (b0.n < minCaptures) {
      rows.push({ ...base, verdict: "UNRESOLVED", detail: `the B0 arm RAN but produced only n=${b0.n} valid capture(s) (need >= ${minCaptures}) — this attribution cannot be attributed to the Fetch guard rather than to the driver pipe until those captures are fixed; look at the B0 rows in the instrument-validity section, not at CDP_BASELINE_NOGUARD` });
      continue;
    }
    if (!a || a.n < minCaptures) {
      rows.push({ ...base, verdict: "UNRESOLVED", detail: `configuration A produced only n=${a?.n ?? 0} valid capture(s) (need >= ${minCaptures}), so there is no reference band to compare B0 against and nothing can be attributed to the Fetch guard rather than to the driver pipe` });
      continue;
    }
    const sep =
      p.spec.kind === "rate" ? separateRate(a, b0)
        : p.spec.kind === "label" ? separateLabel(a, b0)
          : separateNumeric(a, b0, p.spec.floor ?? 0, { discrete: p.spec.discrete === true });
    // "COULD NOT BE MEASURED" IS NOT "MEASURED AND FOUND ABSENT", and collapsing the two here would
    // reintroduce the exact res-vs-no conflation the comparison table was fixed to stop rendering.
    // A resolution-limited A-vs-B0 comparison means the guardless arm produced no observable band
    // above the probe's floor — so the run has no evidence either way, and printing
    // GUARD-ATTRIBUTABLE would state a causal verdict ("the separation is attributable to the
    // navigation guard's Fetch.enable") from a comparison that was never made.
    const verdict = sep.separated ? "DRIVER-PIPE" : sep.resolutionLimited === true ? "UNRESOLVED" : "GUARD-ATTRIBUTABLE";
    rows.push({
      ...base,
      verdict,
      detail: sep.separated
        ? `B0 (no Fetch guard) also separates from A — the signal survives removing the guard, so it belongs to the driver pipe / session, not to our interception: ${sep.reason}`
        : verdict === "UNRESOLVED"
          ? `the A-vs-B0 comparison is RESOLUTION-LIMITED, so this run cannot say whether removing the guard removes the signal — nothing is attributable in either direction: ${sep.reason}`
          : `B0 (no Fetch guard) does NOT separate from A while B does — the separation is attributable to the navigation guard's Fetch.enable: ${sep.reason}`,
      separation: sep,
    });
  }
  return rows;
}

// ═══ fixture ═════════════════════════════════════════════════════════════════════════════════════

/**
 * A probe source is about to be embedded inside a template literal and then inside an HTML inline
 * script. Both embeddings are silent when they go wrong: a backtick or a `${` would corrupt the
 * script into something that still parses but measures something else, and a `</script` would end
 * the block early. #100 states its two strings hold none of those; this asserts it at the seam that
 * depends on it rather than trusting a note in another file.
 */
export function assertEmbeddable(name, source) {
  if (typeof source !== "string" || !source.length) throw new Error(`${name} is not a non-empty string`);
  if (source.includes("`")) throw new Error(`${name} contains a backtick and cannot be embedded verbatim`);
  if (source.includes("${")) throw new Error(`${name} contains a template placeholder and cannot be embedded verbatim`);
  if (/<\/script/i.test(source)) throw new Error(`${name} contains "</script" and would terminate the inline block early`);
}

/**
 * The page script: harness meta, then the two imported probe sources, then the POST home.
 *
 * `withCollector` is a PARAMETER and not a module-scope read so the contract test can assert the
 * collector is embedded verbatim regardless of the ambient CDP_BASELINE_COLLECTOR value; a test that
 * silently changes shape with the environment it runs under is not a contract.
 */
export function buildPageScript({ withCollector = WITH_COLLECTOR } = {}) {
  assertEmbeddable("CDP_TIMING_RAW_JS", CDP_TIMING_RAW_JS);
  if (withCollector) assertEmbeddable("FINGERPRINT_COLLECTOR_JS", FINGERPRINT_COLLECTOR_JS);
  const collectorBlock = withCollector
    ? `  try { collector = await (${FINGERPRINT_COLLECTOR_JS}); } catch (e) { collectorError = String(e); }`
    : "  collectorError = 'skipped (CDP_BASELINE_COLLECTOR=0)';";
  return `(async function () {
  var params = new URLSearchParams(location.search);
  var runId = params.get('run') || '';
  var cfg = params.get('cfg') || '';
  var t0 = performance.now();

  function post(payload) {
    var body = JSON.stringify(payload);
    return fetch('/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body, cache: 'no-store', credentials: 'omit', mode: 'same-origin'
    }).catch(function () {
      // A driver that tears the page down mid-POST would otherwise turn a completed capture into a
      // timeout indistinguishable from a browser that never started.
      try { navigator.sendBeacon('/report', new Blob([body], { type: 'application/json' })); } catch (e) {}
    });
  }

  await new Promise(function (r) { setTimeout(r, ${PROBE_DELAY_MS}); });

  var tos = Function.prototype.toString;
  function isNative(fn) { try { return tos.call(fn).indexOf('[native code]') >= 0; } catch (e) { return null; } }

  var meta = {
    runId: runId, cfg: cfg, href: location.href, world: 'main',
    startedAt: new Date().toISOString(),
    probeDelayMs: ${PROBE_DELAY_MS},
    probeStartOffsetMs: performance.now() - t0,
    // A throttled page is a broken measurement: a hidden or unfocused renderer defers timers and
    // background work, which would depress every timing probe for whichever configuration happened
    // to lose the window. Recorded so that failure mode is visible instead of silently priced in.
    visibility: (typeof document !== 'undefined' && document.visibilityState) || null,
    hasFocus: (function () { try { return document.hasFocus(); } catch (e) { return null; } })(),
    // #100's first stated way its console probes could be measuring nothing: if the driver stubs the
    // Console API, probes A/B/C read a dead sink rather than an unattached protocol, and the
    // in-page self-tests would not notice because they never touch console.
    consoleDebugNative: isNative(console.debug),
    consoleGroupEndNative: isNative(console.groupEnd),
    consoleDebugIsLog: console.debug === console.log,
    consoleOwnKeys: Object.getOwnPropertyNames(console).length,
    hardwareConcurrency: navigator.hardwareConcurrency || null,
    timeOrigin: performance.timeOrigin || null
  };

  var raw = null, rawError = null, collector = null, collectorError = null;
  try { raw = await (${CDP_TIMING_RAW_JS}); } catch (e) { rawError = String(e); }
${collectorBlock}

  // RECOVERED FETCH TIMING — and it is load-bearing, not a nicety.
  //
  // Both imported probes read performance.getEntriesByName() immediately after \`await fetch()\`
  // resolves. fetch() resolves at response HEADERS; a PerformanceResourceTiming entry is only queued
  // at responseEnd. Measured on Chrome 150 (provisional): 20 successful requests, 20 wall timings, and ZERO timing
  // entries — so stallMs / dispatchMs / ttfbMs / reused all come back empty and the entire
  // pre-dispatch-latency family reports nothing. That family is the one with no published detection
  // method AND the only one that survives the V8 fixes retiring the discrete probes, so losing it
  // would gut the baseline.
  //
  // The entries do exist by the time both probe scripts have finished. This reads them HERE, from
  // exactly the requests the probes already issued (matched on their own cache-buster). It is a later
  // read of the same measurement, not a re-authored probe — the fix belongs upstream in the probe
  // source, which is another ticket's file.
  try {
    var entries = performance.getEntriesByType('resource') || [];
    var rows = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      // Interpolated from RAW_CACHE_BUSTER rather than written literally, so the filter and the
      // startup assertion that guards it can never name two different tokens.
      if (String(e.name).indexOf('${RAW_CACHE_BUSTER}') < 0) continue;
      rows.push({
        fetchStart: e.fetchStart, domainLookupStart: e.domainLookupStart, connectStart: e.connectStart,
        requestStart: e.requestStart, responseStart: e.responseStart, responseEnd: e.responseEnd,
        startTime: e.startTime, duration: e.duration
      });
    }
    meta.resourceTiming = rows;
  } catch (e) { meta.resourceTimingError = String(e); }

  meta.finishedOffsetMs = performance.now() - t0;
  await post({ runId: runId, cfg: cfg, meta: meta, raw: raw, rawError: rawError, collector: collector, collectorError: collectorError });
})();`;
}

/**
 * Configuration A's startup page: hold, then hand the SAME query string to the probe URL.
 *
 * It does no measuring and touches nothing the probes read. Its only job is to put a fixed amount of
 * browser life between process start and the probe page, so A's fixture load stops being browser
 * startup (see WARMUP_MS). location.replace keeps A on one history entry and one origin, so the probe
 * page is reached by a same-origin navigation in every configuration.
 */
export function buildWarmupPage(warmupMs) {
  return (
    `<!doctype html><meta charset="utf-8"><title>bgw cdp baseline warmup</title>\n` +
    `<script>setTimeout(function(){location.replace('/probe'+location.search)},${warmupMs});</script>\n` +
    `<body>bgw cdp baseline warmup</body>`
  );
}

/**
 * One local server is the whole measurement channel: it serves the fixture, answers the probe's
 * sub-resource fetches, and receives the result. Identical bytes and identical latency for all three
 * configurations, and — critically — not the protocol.
 */
function startFixture() {
  const pending = new Map(); // runId -> { resolve, timer }
  const settledByFatal = new Set(); // runIds whose capture was resolved by the page's error beacon
  const stats = { fixtureServed: 0, warmupServed: 0, faviconServed: 0, assetServed: 0, reports: 0, orphanReports: 0, fatalReports: 0, lateAfterFatal: 0, fatals: [] };
  const pageScript = buildPageScript();
  const warmupPage = buildWarmupPage(WARMUP_MS);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/warmup") {
      stats.warmupServed++;
      // Connection: close so the probe navigation that follows opens its own socket, exactly as it
      // does in B and C. Without it A would arrive at /probe on a socket the warm-up already
      // established, and the connection-reuse split every stall probe depends on would mean
      // something slightly different in A than in the other two arms.
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", Connection: "close" });
      res.end(warmupPage);
      return;
    }
    if (url.pathname === "/probe") {
      stats.fixtureServed++;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      // The error trap is its OWN script block, parsed before the probe block: a syntax error in the
      // (much larger) probe block would take the trap down with it if they shared one element, and
      // the capture would surface as an unexplained timeout instead of a reported failure.
      // ORDINARY SUB-RESOURCES, and they are load-bearing. The collector's interception probe
      // (cdp.resourceTiming.*) is PASSIVE by design — it reads requestStart-fetchStart off entries
      // the page already produced rather than firing requests of its own, because the same
      // collector runs inside the read-only fingerprint-parity harness against real origins.
      // A bare HTML page produces no entries at all: verified in-container against a bare page,
      // where entriesBucket read "lt1" (zero) and both stall buckets were null. That would leave
      // the ONE probe family that measures OUR added surface — the Fetch guard pausing every
      // request in every frame — silently contributing nothing in all three configurations, which
      // reads identically to "no difference found".
      //
      // Deferred so they load in parallel without blocking the probe script, and every config
      // pays the same cost. PROBE_DELAY_MS (default 6s) is counted from page start, so these have
      // long settled before the probe reads Resource Timing. Same-origin, so requestStart is
      // exposed without needing Timing-Allow-Origin.
      const assets = Array.from(
        { length: FIXTURE_ASSET_COUNT },
        (_, i) => `<script defer src="/asset-${i}.js"></script>`,
      ).join("");
      res.end(
        `<!doctype html><meta charset="utf-8"><title>bgw cdp baseline probe</title>\n` +
          `<script>window.addEventListener('error',function(e){try{var p=new URLSearchParams(location.search);` +
          `navigator.sendBeacon('/report',new Blob([JSON.stringify({runId:p.get('run'),cfg:p.get('cfg'),` +
          `fatal:String((e&&e.message)||'error')})],{type:'application/json'}))}catch(x){}});</script>\n` +
          `${assets}\n` +
          `<script>\n${pageScript}\n</script>\n<body>bgw cdp baseline probe</body>`,
      );
      return;
    }
    if (url.pathname.startsWith("/asset-") && url.pathname.endsWith(".js")) {
      // One trivial statement, not an empty body: a zero-length response can be served from a
      // short-circuit path in some stacks, and the point is to produce a real request that the
      // Fetch guard has to pause and continue.
      stats.assetServed++;
      res.writeHead(200, { "Content-Type": "application/javascript", "Cache-Control": "no-store" });
      res.end("void 0;\n");
      return;
    }
    if (url.pathname === "/favicon.ico") {
      // Both probe scripts hammer this path with cache-busted GETs. Kept to a one-byte body so the
      // measurement is dominated by the request path rather than by transfer time.
      stats.faviconServed++;
      res.writeHead(200, { "Content-Type": "image/x-icon", "Cache-Control": "no-store" });
      res.end("x");
      return;
    }
    if (url.pathname === "/report" && req.method === "POST") {
      const chunks = [];
      let size = 0;
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) { req.destroy(); return; }
        chunks.push(chunk);
      });
      req.on("end", () => {
        res.writeHead(204).end();
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch (err) {
          stats.fatals.push(`unparseable report body: ${String(err)}`);
          return;
        }
        stats.reports++;
        if (body?.fatal) stats.fatalReports++;
        const waiter = pending.get(body?.runId);
        if (!waiter) {
          // A report for a run we are no longer waiting on means a previous capture's page outlived
          // its browser kill. Counted rather than ignored: a nonzero value means captures overlapped
          // and the interleaving is not as clean as the log claims.
          //
          // EXCEPT after an in-page error. The error trap fires its own {fatal} beacon, which
          // resolves the capture; the main script's own post() can still land afterwards and would
          // be counted here — reporting "captures overlapped" for what was a page error, i.e.
          // blaming interleaving for a diagnosis the run already has. Those get their own counter.
          if (settledByFatal.has(body?.runId)) stats.lateAfterFatal++;
          else stats.orphanReports++;
          return;
        }
        pending.delete(body.runId);
        if (body?.fatal) settledByFatal.add(body.runId);
        clearTimeout(waiter.timer);
        waiter.resolve(body);
      });
      return;
    }
    res.writeHead(404, { "Cache-Control": "no-store" }).end("nope");
  });

  const awaitReport = (runId, timeoutMs) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(runId);
        reject(new Error(`no report from the page within ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(runId, { resolve, timer });
    });

  return { server, stats, awaitReport, pending };
}

// ═══ process plumbing ════════════════════════════════════════════════════════════════════════════

const spawned = new Set();

/** argv of a live process, or null where /proc is unavailable (any non-Linux host). */
async function readCmdline(pid) {
  try {
    const buf = await readFile(`/proc/${pid}/cmdline`);
    return buf.toString("utf8").split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Find a Chromium BROWSER process by the profile dir we handed it. The `--type=` filter is what
 * makes it the browser rather than one of its renderers: every child inherits most of the argv,
 * including --user-data-dir, and only the browser lacks a --type. Same identification trick the
 * force-kill work uses (docs/solutions/architecture-patterns/reap-detached-process-by-owned-userdatadir.md).
 */
async function findBrowserByUserDataDir(dir) {
  let entries;
  try {
    entries = await readdir("/proc");
  } catch {
    return null;
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const argv = await readCmdline(Number(name));
    if (!argv) continue;
    if (!argv.some((a) => a === `--user-data-dir=${dir}`)) continue;
    if (argv.some((a) => a.startsWith("--type="))) continue;
    return { pid: Number(name), argv };
  }
  return null;
}

/** Spawn Chrome in its own process group so the whole tree can be reaped by group signal. */
function spawnChrome(execPath, args) {
  const child = spawn(execPath, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  spawned.add(child);
  const stderr = [];
  child.stderr?.on("data", (d) => {
    if (stderr.length < 40) stderr.push(String(d));
  });
  child.stdout?.resume();
  // 'error' (a failed spawn — bad path, EACCES) never emits 'exit', so it has to resolve the same
  // promise: otherwise a mistyped BGW_CHROME_PATH becomes a REPORT_TIMEOUT_MS wait per capture with
  // no explanation, instead of an immediate, named failure.
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal, error: null }));
    child.once("error", (err) => resolve({ code: null, signal: null, error: String(err?.message ?? err) }));
  });
  return { child, stderr, exited };
}

/**
 * Kill a spawned Chrome and its whole tree. A leaked headful Chrome under Xvfb does not merely waste
 * memory — it holds the display and wedges every later capture in the same container run, so this is
 * unconditional and group-scoped rather than a polite SIGTERM to the leader.
 */
async function killChrome(handle) {
  if (!handle?.child?.pid) return;
  const pid = handle.child.pid;
  const signalGroup = (sig) => {
    try { process.kill(-pid, sig); } catch { /* group already gone */ }
  };
  signalGroup("SIGTERM");
  const exited = await Promise.race([
    handle.exited.then(() => true),
    new Promise((r) => setTimeout(() => r(false), KILL_GRACE_MS)),
  ]);
  if (!exited) signalGroup("SIGKILL");
  try { await Promise.race([handle.exited, new Promise((r) => setTimeout(r, KILL_GRACE_MS))]); } catch { /* ignore */ }
  spawned.delete(handle.child);
}

/** Last-resort sweep so an early throw cannot leave a headful Chrome holding the display. */
function sweepSpawned() {
  for (const child of spawned) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
  }
  spawned.clear();
}

async function resolveChromePath() {
  const explicit = process.env.BGW_CHROME_PATH;
  if (explicit) return explicit;
  for (const candidate of CHROME_CANDIDATES) {
    try {
      await access(candidate, FS.X_OK);
      return candidate;
    } catch { /* try the next */ }
  }
  return null;
}

// ═══ the raw protocol client (configuration C only) ══════════════════════════════════════════════

/**
 * A minimum-viable CDP client over node's global WebSocket — no new dependency, and deliberately
 * naive: this is meant to look like the automation everybody writes, not like a hardened driver.
 *
 * It counts inbound events by method. That count is the ONLY hard evidence that the positive control
 * is actually positive: a Chrome with an open debugging port and nothing attached would produce a
 * clean-looking C column that silently invalidates the whole comparison, and a zero
 * `Runtime.consoleAPICalled` count is how that gets caught.
 */
class RawCdpClient {
  #ws;
  #nextId = 1;
  #pending = new Map();
  events = new Map();
  closed = false;

  static connect(url, timeoutMs) {
    return new Promise((resolve, reject) => {
      const client = new RawCdpClient();
      const ws = new WebSocket(url);
      client.#ws = ws;
      const timer = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } reject(new Error(`CDP websocket did not open within ${timeoutMs}ms`)); }, timeoutMs);
      ws.addEventListener("open", () => { clearTimeout(timer); resolve(client); }, { once: true });
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP websocket error")); }, { once: true });
      ws.addEventListener("close", () => {
        client.closed = true;
        for (const [, p] of client.#pending) p.reject(new Error("CDP websocket closed"));
        client.#pending.clear();
      });
      ws.addEventListener("message", (ev) => client.#onMessage(ev));
    });
  }

  #onMessage(ev) {
    let msg;
    try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)); } catch { return; }
    if (msg.id !== undefined) {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message ?? JSON.stringify(msg.error)}`));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (msg.method) this.events.set(msg.method, (this.events.get(msg.method) ?? 0) + 1);
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error(`${method}: websocket already closed`));
    const id = this.#nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      // Every send is bounded. An unbounded protocol await is how a wedged Chrome turns one bad
      // capture into a hung run that never reaches the cleanup in main()'s finally.
      const timer = setTimeout(() => {
        if (!this.#pending.delete(id)) return;
        reject(new Error(`${method}: no protocol response within 15000ms`));
      }, 15_000);
      const settle = (fn) => (v) => { clearTimeout(timer); fn(v); };
      this.#pending.set(id, { resolve: settle(resolve), reject: settle(reject), method });
      try { this.#ws.send(JSON.stringify(payload)); } catch (err) { this.#pending.delete(id); clearTimeout(timer); reject(err); }
    });
  }

  eventTotals() {
    return Object.fromEntries([...this.events.entries()].sort((a, b) => b[1] - a[1]));
  }

  close() {
    try { this.#ws.close(); } catch { /* ignore */ }
  }
}

/** Chrome writes the chosen port and the browser-level websocket path here once it is listening. */
async function waitForDevToolsEndpoint(userDataDir, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const path = join(userDataDir, "DevToolsActivePort");
  let lastErr = "not written";
  while (Date.now() < deadline) {
    try {
      const text = await readFile(path, "utf8");
      const [port, wsPath] = text.split("\n");
      if (port && wsPath) return { port: Number(port.trim()), wsPath: wsPath.trim() };
      lastErr = "written but incomplete";
    } catch (err) {
      lastErr = String(err?.code ?? err);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`DevToolsActivePort never appeared in ${timeoutMs}ms (${lastErr})`);
}

// ═══ the three configurations ════════════════════════════════════════════════════════════════════

const guardAllowLoopback = (nav) => (nav.host === "127.0.0.1" ? "allow" : "block");

/**
 * Wait for the page's report, but stop waiting the moment the browser dies — a Chrome that refuses
 * to start would otherwise cost a full REPORT_TIMEOUT_MS per capture and report as "silent page"
 * rather than "dead browser", which are very different diagnoses.
 *
 * BOTH branches get a no-op catch. The loser of a `Promise.race` keeps settling after the race is
 * decided, and an unhandled rejection from the losing branch would kill the process mid-run —
 * taking the cleanup that reaps spawned Chromes with it.
 */
function raceReportAgainstExit(report, handle) {
  const guard = handle.exited.then(({ code, signal, error }) => {
    throw new Error(
      `chrome exited before reporting (code=${code} signal=${signal}${error ? ` error=${error}` : ""}) ${handle.stderr.join("").slice(-400)}`,
    );
  });
  report.catch(() => {});
  guard.catch(() => {});
  return Promise.race([report, guard]);
}

/**
 * Configuration A: the binary, a fresh profile, the fixture as startup URL. Nothing attached.
 *
 * The startup URL is /warmup, not /probe: A is the only arm whose page load would otherwise coincide
 * with browser startup, and that cold-start cost lands on the same probes the protocol would (see
 * WARMUP_MS). The warm-up page replaces itself with the probe URL, carrying the query string through.
 */
async function captureA(ctx, runId, dir) {
  const startUrl = WARMUP_MS > 0 ? ctx.warmupUrl(runId, "A") : ctx.probeUrl(runId, "A");
  const args = [...ctx.cloneArgs, `--user-data-dir=${dir}`, startUrl];
  const spawnedAtMs = Date.now();
  const handle = spawnChrome(ctx.chromePath, args);
  try {
    const payload = await raceReportAgainstExit(ctx.awaitReport(runId, REPORT_TIMEOUT_MS), handle);
    return { payload, argv: await readCmdline(handle.child.pid), extra: { spawnedAtMs, warmupMs: WARMUP_MS } };
  } finally {
    await killChrome(handle);
  }
}

/** Configuration B: the shipped core, with the navigation guard that installs the Fetch session. */
async function captureB(ctx, runId, dir, { withGuard = true } = {}) {
  const spawnedAtMs = Date.now();
  const core = await createBrowserCore({
    headless: HEADLESS,
    channel: "chrome",
    noSandbox: NO_SANDBOX,
    userDataDir: dir,
    navigationTimeoutMs: 30_000,
  });
  try {
    // Without this call the core installs NO interception at all (fail-open) and never opens its
    // browser-level CDP session — so the guardless arm is not "B with a smaller guard", it is the
    // driver pipe alone. That is exactly what makes it useful for attributing any separation.
    if (withGuard) await core.setNavigationGuard(guardAllowLoopback);
    const cfg = withGuard ? "B" : "B0";
    const reportPromise = ctx.awaitReport(runId, REPORT_TIMEOUT_MS);
    const navStart = Date.now();
    let navError = null;
    try {
      await core.navigate(ctx.probeUrl(runId, cfg));
    } catch (err) {
      navError = String(err?.message ?? err);
    }
    const navigateMs = Date.now() - navStart;
    // A and C race their report against the browser's exit; B has no such signal to race — the core
    // owns its process and exposes no exit event — so navigate()'s own rejection is the substitute.
    // When Chrome dies under the driver, navigate() rejects with the driver's target/browser-closed
    // error, and waiting the full REPORT_TIMEOUT_MS after that would diagnose a dead browser as a
    // silent page: the exact distinction raceReportAgainstExit exists to preserve. A report may
    // still be in flight (the page can complete and POST while navigate() reports a teardown), so a
    // short grace is allowed before the navigation error becomes the diagnosis.
    let payload;
    if (navError) {
      let graceTimer;
      const grace = new Promise((_, reject) => {
        graceTimer = setTimeout(
          () => reject(new Error(`navigate() failed and no report arrived within ${NAV_FAILURE_GRACE_MS}ms: ${navError}`)),
          NAV_FAILURE_GRACE_MS,
        );
      });
      // The losing branch of a race keeps settling; an unhandled rejection from it would kill the
      // process before the cleanup that closes the core.
      reportPromise.catch(() => {});
      grace.catch(() => {});
      try {
        payload = await Promise.race([reportPromise, grace]);
      } finally {
        clearTimeout(graceTimer);
      }
    } else {
      payload = await reportPromise;
    }
    return {
      payload,
      argv: null, // measured once during calibration; a per-capture /proc scan is not worth the cost
      extra: {
        spawnedAtMs,
        navigateMs,
        navError,
        // The in-page delay exists so the driver's post-navigation protocol burst is over before the
        // first measurement. If navigate() outran it, this capture's timings include that burst.
        probeOverlappedNavigate: navigateMs > PROBE_DELAY_MS,
      },
    };
  } finally {
    try {
      await core.close();
    } catch {
      try { await core.kill(5_000); } catch { /* nothing left to do */ }
    }
  }
}

/** Configuration C: the binary with a debugging port, plus a raw client that enables Runtime. */
async function captureC(ctx, runId, dir) {
  const args = [...ctx.cloneArgs, `--user-data-dir=${dir}`, "--remote-debugging-port=0", "about:blank"];
  const spawnedAtMs = Date.now();
  const handle = spawnChrome(ctx.chromePath, args);
  let client = null;
  try {
    const { port, wsPath } = await waitForDevToolsEndpoint(dir, DEVTOOLS_PORT_TIMEOUT_MS);
    client = await RawCdpClient.connect(`ws://127.0.0.1:${port}${wsPath}`, 10_000);

    const { targetInfos } = await client.send("Target.getTargets");
    let target = (targetInfos ?? []).find((t) => t.type === "page");
    if (!target) {
      const created = await client.send("Target.createTarget", { url: "about:blank" });
      target = { targetId: created.targetId, type: "page" };
    }
    const { sessionId } = await client.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });

    // The whole point of configuration C. Runtime.enable is what makes V8's inspector eagerly
    // preview-serialize every console argument, which is the mechanism every probe in the console
    // family is trying to observe. Page.enable is what a naive script adds next; nothing else is
    // enabled, so C differs from A by the port and this pair and nothing more.
    await client.send("Page.enable", {}, sessionId);
    await client.send("Runtime.enable", {}, sessionId);

    // FOCUS PARITY, and it is not cosmetic bookkeeping. C attaches to a target that already exists
    // rather than owning the startup window, so its renderer came back document.hasFocus() === false
    // in every capture of every smoke run while A and B read true. An unfocused renderer is
    // deprioritized by the browser's scheduler, and every probe in the console-cost family is
    // renderer-side wall clock — a uniform multiplier across rich AND plain console calls is exactly
    // what a scheduling difference looks like, and also exactly what protocol attachment looks like.
    // Leaving it unmatched means the timing half of the run cannot attribute its own separation.
    // Sending one more protocol call in the arm whose definition is "has a protocol attached" costs
    // nothing in channel terms; failing to bring it to front is recorded, not fatal, because the
    // instrument-validity check downstream will catch the resulting mismatch on its own.
    let broughtToFront = null;
    try {
      await client.send("Page.bringToFront", {}, sessionId);
      broughtToFront = true;
    } catch (err) {
      broughtToFront = String(err?.message ?? err);
    }

    const reportPromise = ctx.awaitReport(runId, REPORT_TIMEOUT_MS);
    await client.send("Page.navigate", { url: ctx.probeUrl(runId, "C") }, sessionId);
    const payload = await raceReportAgainstExit(reportPromise, handle);
    // The page's HTTP POST can beat the websocket's own event delivery through the Node event loop,
    // so reading the counters the instant the report lands can report zero Runtime events for a
    // session that plainly had them. Drain briefly first — this counter is the positive control's
    // only receipt, and a racy zero would read as "the control never attached".
    await new Promise((r) => setTimeout(r, 250));
    const events = client.eventTotals();
    return {
      payload,
      argv: await readCmdline(handle.child.pid),
      extra: {
        spawnedAtMs,
        devtoolsPort: port,
        broughtToFront,
        cdpEvents: events,
        // The positive control's receipt. Zero here means the port was open but the consumer was not
        // actually receiving Runtime events, and C is not a positive control at all.
        consoleApiCalled: events["Runtime.consoleAPICalled"] ?? 0,
      },
    };
  } finally {
    client?.close();
    await killChrome(handle);
  }
}

// ═══ capture validity ════════════════════════════════════════════════════════════════════════════

/**
 * A capture only counts if its own machinery demonstrably worked. #100's in-page self-tests exercise
 * a getter, a Proxy ownKeys trap and the clock LOCALLY, where the answer must be true; if any of them
 * is false the probes' negatives mean "nothing measured", not "nothing detected", and averaging such
 * a capture in would manufacture a clean result out of a broken one.
 *
 * TWO REASONS HERE ARE NOT SELF-TESTS, and both were soft warnings that could not affect the answer:
 *
 *  - A STUBBED CONSOLE SINK. #100's first stated way its console probes could be measuring nothing is
 *    the driver replacing console.debug. If that happened on our stack only, B's console family would
 *    read clean because its sink is dead — a false "B-MATCHES-A" produced by the one failure mode the
 *    consoleDebugNative check was written to catch.
 *  - A C CAPTURE THAT RECEIVED NO Runtime EVENTS. The positive-control receipt used to be summed
 *    across all C captures, so one round whose consumer never actually received events was averaged
 *    into C's column, widening its band and killing separations that were really there. The receipt
 *    belongs to the capture that earned it.
 */
export function assessCapture(payload, { config, extra } = {}) {
  const reasons = [];
  if (!payload) return { valid: false, reasons: ["no payload"] };
  if (payload.fatal) reasons.push(`page threw: ${payload.fatal}`);
  if (payload.rawError) reasons.push(`raw probe error: ${payload.rawError}`);
  if (!payload.raw) reasons.push("raw probe produced nothing");
  const st = payload.raw?.selfTest;
  if (st) {
    if (st.getterFires !== true) reasons.push("selfTest.getterFires not true");
    if (st.ownKeysFires !== true) reasons.push("selfTest.ownKeysFires not true");
    if (st.clockAdvances !== true) reasons.push("selfTest.clockAdvances not true");
    if (st.error) reasons.push(`selfTest error: ${st.error}`);
  } else if (payload.raw) {
    reasons.push("raw probe carried no selfTest block");
  }
  if (payload.meta?.consoleDebugNative === false) {
    reasons.push("console.debug is not native code — the console-family probes read a stubbed sink, not an unattached protocol");
  }
  if (config === "C" && extra && (extra.consoleApiCalled ?? 0) === 0) {
    reasons.push("positive control received no Runtime.consoleAPICalled events in THIS capture — an open debugging port with nothing arriving is not an attached consumer");
  }
  return { valid: reasons.length === 0, reasons };
}

/**
 * Are the per-configuration RENDERER SCHEDULING STATES a confound, or just the environment?
 *
 * BLOCKING ON A DISAGREEMENT, ACCEPTING A UNIFORM ANSWER — INCLUDING A UNIFORM FALSE.
 *
 * An unfocused or hidden renderer is deprioritized by the browser's scheduler — a hidden one also
 * gets its timers clamped — and every console-cost probe here is renderer-side wall clock, so a
 * state that differs BY CONFIGURATION produces exactly the shape protocol attachment would: a
 * uniform multiplier on one arm's timings. That is not a wobble to note, it is a reason the columns
 * cannot be compared, and it blocks.
 *
 * A uniform reading is the opposite case. The container runs bare `Xvfb -ac -nolisten tcp` with NO
 * window manager; with no WM nothing sets the X input focus, PointerRoot is in effect, and
 * document.hasFocus() can legitimately read false in every arm — including configuration A, which
 * has no protocol attached at all and is therefore the proof that the false is environmental. No
 * differential, no confound. Blocking there would abort the in-container run — the only reading that
 * counts — over a condition that harms nothing, which is how an instrument that has never been run
 * fails to run.
 *
 * WHY VISIBILITY IS CHECKED HERE AND NOT LEFT AS A PER-CAPTURE WARNING. document.hasFocus() and
 * document.visibilityState are two independent readings of the same confound, and accepting a
 * uniform false on the first REMOVES the guard that used to cover the second by accident. The gap is
 * concrete and lands on the one arm most able to produce it: configuration C attaches to a
 * pre-existing target instead of owning the startup window, and its `Page.bringToFront` is
 * explicitly allowed to fail because "the instrument-validity check downstream will catch the
 * resulting mismatch" — which, under a uniform-false focus reading, it no longer does. A C whose
 * renderer is `hidden` in every capture while A and B are `visible` gets timer clamping and
 * background priority: a uniform multiplier on C's console-cost timings, A|C separates on the
 * console family, protocolValidated goes true and the #102 gate unblocks, with nothing on the record
 * but a soft per-capture warning. Same rule, same two outcomes, applied to both readings.
 *
 * CAPTURES WITH NO META BLOCK ARE EXCLUDED RATHER THAN READ AS A STATE. The page's error trap posts
 * `{runId, cfg, fatal}` and nothing else, and that beacon resolves the capture — so the capture is
 * `ok` and reaches this function carrying no `meta` at all. Stringifying its absent reading yielded
 * the literal state "undefined", which joined the state set and turned ONE in-page error into a
 * per-configuration focus DISAGREEMENT: the run reported INSTRUMENT-FAILED and blamed a scheduling
 * confound, while the check that actually describes the event (the in-page self-tests) is
 * deliberately non-blocking. Excluded and counted, so the beacon shows up as what it is.
 *
 * The detail is assembled to separate the two causes of a false, because they need different
 * responses: `Page.bringToFront` failing is a broken instrument (C was given a protocol call
 * precisely to obtain focus parity and did not get it), while "no WM, nobody has focus" is the box.
 * C's protocol traffic totals ride along for the same reason — an arm that received Runtime events
 * demonstrably had a live consumer, so a false there is about windows, not about attachment.
 */
export function assessRendererParity(reporting, cCaptures = []) {
  const byConfig = {};
  const visibilityByConfig = {};
  let withoutMeta = 0;
  for (const c of reporting ?? []) {
    if (!c?.payload?.meta) { withoutMeta++; continue; }
    byConfig[c.config] ??= new Set();
    byConfig[c.config].add(String(c.payload.meta.hasFocus));
    visibilityByConfig[c.config] ??= new Set();
    visibilityByConfig[c.config].add(String(c.payload.meta.visibility));
  }
  const states = new Set(Object.values(byConfig).flatMap((s) => [...s]));
  const visibilityStates = new Set(Object.values(visibilityByConfig).flatMap((s) => [...s]));
  const focusOk = states.size <= 1;
  const visibilityOk = visibilityStates.size <= 1;
  const ok = focusOk && visibilityOk;
  const uniformWithoutFocus = focusOk && states.size === 1 && !states.has("true");
  const bringFailures = (cCaptures ?? []).filter((c) => c.extra?.broughtToFront !== true);
  const protocolTotals = {};
  for (const c of cCaptures ?? []) {
    for (const [method, n] of Object.entries(c.extra?.cdpEvents ?? {})) protocolTotals[method] = (protocolTotals[method] ?? 0) + n;
  }
  const render = (m) => Object.entries(m).map(([cfg, s]) => `${cfg}=${[...s].sort().join("/")}`).join(" ");
  const readings = render(byConfig);
  const visibilityReadings = render(visibilityByConfig);
  const detail =
    `hasFocus ${readings || "(none)"}` +
    `; visibilityState ${visibilityReadings || "(none)"}` +
    (withoutMeta ? `; ${withoutMeta} reporting capture(s) carried no meta block and were EXCLUDED (an in-page error beacon posts {runId,cfg,fatal} only — see the self-test check, not this one)` : "") +
    `; C Page.bringToFront ${(cCaptures ?? []).length === 0 ? "n/a (no C captures)" : bringFailures.length === 0 ? `confirmed in all ${cCaptures.length} capture(s)` : `did NOT confirm on ${bringFailures.map((c) => `r${c.round}`).join(",")} (${bringFailures[0].extra?.broughtToFront})`}` +
    `; C received ${protocolTotals["Runtime.consoleAPICalled"] ?? 0} Runtime.consoleAPICalled + ${Object.values(protocolTotals).reduce((a, b) => a + b, 0)} protocol events total`;
  return {
    ok, focusOk, visibilityOk, uniformWithoutFocus,
    states: [...states].sort(), visibilityStates: [...visibilityStates].sort(),
    byConfig, visibilityByConfig, readings, visibilityReadings, withoutMeta,
    detail, protocolTotals, bringFailures,
  };
}

/** Soft warnings: they do not disqualify a capture, but they change how much it is worth. */
export function captureWarnings(payload, extra) {
  const warnings = [];
  if (payload?.meta?.visibility && payload.meta.visibility !== "visible") {
    warnings.push(`page was ${payload.meta.visibility} (a throttled renderer depresses every timing probe)`);
  }
  // consoleDebugNative is deliberately NOT here any more: a stubbed sink invalidates the capture in
  // assessCapture rather than annotating it, because a warning on a counted capture is how the
  // console family ends up being read off a dead sink.
  if (payload?.collectorError) warnings.push(`collector error: ${payload.collectorError}`);
  if (extra?.probeOverlappedNavigate) {
    warnings.push(`navigate() took ${extra.navigateMs}ms, longer than the ${PROBE_DELAY_MS}ms probe delay — the driver's post-navigation work overlapped the measurement`);
  }
  if (extra?.navError) warnings.push(`navigate() reported: ${extra.navError}`);
  const budget = payload?.raw?.budgetExceeded;
  if (budget) warnings.push("raw probe hit its own wall-clock budget and stopped early");
  return warnings;
}

// ═══ redaction ═══════════════════════════════════════════════════════════════════════════════════

/**
 * The record this script writes is meant to be pasted into a ticket in a PUBLIC repo, and with the
 * collector on it carries a full fingerprint snapshot per capture — including WebRTC ICE candidates,
 * whose `srflx` lines contain the HOST'S PUBLIC IP. A smoke run's CDP_BASELINE_OUT file contained
 * exactly that. Nothing in the analysis needs the values (the environment diff needs the PATHS, to
 * say which axes moved), so they never reach the console or the file.
 *
 * Loopback and RFC1918/CGNAT/link-local literals are kept: the fixture URL is 127.0.0.1 and a
 * redacted one would make the record unreadable for no privacy gain.
 */
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
// At least five groups, so a wall-clock time ("22:45:12") and an ISO timestamp cannot match.
const IPV6_RE = /\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b/gi;

export function isBenignIpLiteral(text) {
  if (/^127\./.test(text) || text === "0.0.0.0" || text === "::1" || text === "::") return true;
  if (/^10\./.test(text) || /^192\.168\./.test(text) || /^169\.254\./.test(text)) return true;
  const m = /^172\.(\d{1,3})\./.exec(text);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  const cg = /^100\.(\d{1,3})\./.exec(text);
  if (cg && Number(cg[1]) >= 64 && Number(cg[1]) <= 127) return true;
  return /^f[cd][0-9a-f]{2}:/i.test(text) || /^fe80:/i.test(text);
}

export function redactIps(text) {
  return String(text)
    .replace(IPV4_RE, (m) => (isBenignIpLiteral(m) ? m : "<redacted-ip>"))
    .replace(IPV6_RE, (m) => (isBenignIpLiteral(m) ? m : "<redacted-ip>"));
}

/**
 * Deep copy with routable IP literals replaced — but SCOPED, not blanket.
 *
 * A blanket string scrub is worse than none here: `Chrome/150.0.0.0` in a user-agent is a valid IPv4
 * literal by shape, and redacting it would silently corrupt the very axis the A-vs-B environment
 * diff exists to report. Only two shapes can carry the host's address, and both are addressed
 * directly: anything nested under a `webrtc` key (the collector's ICE section), and any string
 * carrying an ICE candidate line wherever it turns up — including inside a `{path, a, b}` diff entry,
 * which is nested under `path`, not under `webrtc`.
 */
export function redactDeep(value, sensitive = false) {
  if (typeof value === "string") return sensitive || value.includes("candidate:") ? redactIps(value) : value;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, sensitive));
  if (value && typeof value === "object") {
    // The diff-entry shape: its values belong to whatever axis `path` names.
    const pathIsWebrtc = typeof value.path === "string" && /^webrtc\b/i.test(value.path);
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, sensitive || /webrtc/i.test(k) || (pathIsWebrtc && k !== "path"));
    return out;
  }
  return value;
}

// ═══ reporting ═══════════════════════════════════════════════════════════════════════════════════

// Both truncate from the TAIL. `slice(-w)` would chop the HEAD off an over-long cell, which turns
// "{flat,unbounded}" into "at,unbounded}" — an unreadable value that still looks like data.
const pad = (s, w) => (String(s).length > w ? String(s).slice(0, w - 1) + "~" : String(s).padEnd(w));
const padL = (s, w) => (String(s).length > w ? String(s).slice(0, w - 1) + "~" : String(s).padStart(w));
const fmt = (v, digits = 3) =>
  v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v)) ? "n/a" : typeof v === "number" ? v.toFixed(digits) : String(v);

function cellFor(spec, summary) {
  if (!summary || summary.n === 0) return "n/a";
  if (spec.kind === "rate") return `${summary.trueCount}/${summary.n}`;
  if (spec.kind === "label") return summary.set.length === 1 ? summary.set[0] : `{${summary.set.join(",")}}`;
  return fmt(summary.p50, spec.unit === "ms" || spec.unit === "x" ? 3 : 1);
}

function spreadFor(spec, summary) {
  if (!summary || summary.n === 0) return "n/a";
  if (spec.kind === "rate") return summary.nulls ? `${summary.nulls} null` : "-";
  if (spec.kind === "label") return summary.set.length > 1 ? "varies" : "-";
  return fmt(summary.spread, 3);
}

const FAMILY_TAG = { protocol: "prot", control: "ctrl", harness: "harn", context: "ctxt" };

function printComparisonTable(analysis, configs) {
  const keyWidth = 42;
  const cellWidth = 13;
  const header =
    pad("probe", keyWidth) +
    padL("fam", 6) +
    configs.map((c) => padL(c, cellWidth)).join("") +
    padL("A spread", 11) +
    padL("A|C", 6) +
    padL("A|B", 6) +
    "  verdict";
  console.log(header);
  console.log("-".repeat(header.length));
  // "res" is deliberately NOT rendered as "no". A resolution-limited comparison and a genuinely
  // quiet probe print the same word under the old rendering, and they are opposite findings: one
  // says the instrument could not make the measurement, the other says the measurement came back
  // negative. Only the second is evidence about our stack.
  const sepCell = (sep) => (sep.separated ? "YES" : sep.resolutionLimited ? "res" : "no");
  for (const p of analysis.probes) {
    const row =
      pad(p.spec.key, keyWidth) +
      padL(FAMILY_TAG[p.spec.family ?? "protocol"] ?? "?", 6) +
      configs.map((c) => padL(cellFor(p.spec, p.summaries[c]), cellWidth)).join("") +
      padL(spreadFor(p.spec, p.summaries.A), 11) +
      padL(sepCell(p.separation), 6) +
      padL(sepCell(p.separationAB), 6) +
      "  " +
      p.verdict;
    console.log(row);
  }
  console.log("\n  fam: prot = protocol-presence mechanism (the only family that can validate the suite)");
  console.log("       ctrl = crude automation tell (separates for reasons unrelated to the protocol)");
  console.log("       harn = instrument self-check, or a value this harness produces itself (fixture latency) rather than reading off the browser");
  console.log("       ctxt = a real browser-side quantity that is confounded BY CONFIGURATION (cold start); reported, never graded");
  console.log("  A|C: did the probe discriminate the controls at all? (the epic's validity check)");
  console.log("  A|B: is OUR STACK separated from the no-protocol control? (the column #102 would gate on)");
  console.log("  res: RESOLUTION-LIMITED — an arm produced no noise band above the probe's stated floor, so the comparison could not be made. NOT the same as 'no'.");
  console.log("  cells: rate probes show true/total; label probes show the observed label set; numeric probes show the median across rounds.");
}

/**
 * Rank the numeric probes by how far OUR STACK sits from the no-protocol control, separation test
 * or not.
 *
 * A separation verdict is deliberately conservative: it demands disjoint ranges AND a gap of twice
 * the tighter arm's noise band, so with five rounds an effect whose rounds interleave with the
 * control's reports "no". That is the right call for a gate and the wrong one for a report —
 * measured on Chrome 150 (provisional), our stack's warm pre-dispatch stall ran ~27x configuration
 * A's while its own rounds ranged over two orders of magnitude. A reader who saw only "no" in that
 * column would conclude nothing was there. This section exists so the biggest number in the run
 * cannot hide behind a conservative threshold, and so "large effect, insufficient consistency" reads
 * as the call for more rounds that it is.
 */
export function rankEffects(probes, { minRatio = 2, limit = 8 } = {}) {
  const rows = [];
  for (const p of probes) {
    if (p.spec.kind !== "numeric") continue;
    const a = p.summaries.A;
    const b = p.summaries.B;
    if (!a || !b || a.n < 1 || b.n < 1) continue;
    const noise = Math.max(a.spread ?? 0, p.spec.floor ?? 0);
    const widths = noise > 0 ? Math.abs(b.p50 - a.p50) / noise : null;
    const ratio = a.p50 ? b.p50 / a.p50 : null;
    const big = (ratio !== null && (ratio >= minRatio || ratio <= 1 / minRatio)) || (widths !== null && widths >= SEP_MULT);
    if (!big) continue;
    rows.push({ key: p.spec.key, family: p.spec.family ?? "protocol", unit: p.spec.unit ?? "", floor: p.spec.floor ?? 0, a, b, ratio, widths, separated: p.separationAB.separated, reason: p.separationAB.reason });
  }
  rows.sort((x, y) => (y.widths ?? 0) - (x.widths ?? 0));
  return rows.slice(0, limit);
}

function printEffects(analysis) {
  const rows = rankEffects(analysis.probes);
  if (!rows.length) {
    console.log("  none — no numeric probe puts our stack materially away from the no-protocol control.");
    return;
  }
  for (const r of rows) {
    const unit = r.unit ? ` ${r.unit}` : "";
    // The widths below fall back to the probe's declared floor when A produced no band of its own,
    // and that floor is a provisional constant from a macOS smoke run. This section is a RANKING, so
    // the fallback is allowed here where it is refused for a threshold — but it has to say so, or a
    // reader lifts "8.4 noise widths" out of the ranking and into the ticket as if it were measured.
    const basis = (r.a.spread ?? 0) >= (r.floor ?? 0) ? "noise widths" : "FLOOR widths (A produced no band of its own — provisional constant, not a measurement)";
    // THE FAMILY TAG IS PRINTED HERE TOO, and this was the one printer that dropped it. Every other
    // section carries it because the family is what decides whether a number means anything for
    // #102 — and this section exists precisely so the BIGGEST number in the run cannot hide, i.e. it
    // is the section a reader lifts a row out of and pastes into a ticket. Two rows here are read
    // off the same Resource Timing series and render identically without the tag:
    // harness.stallWarmP50Ms is protocol-family (the pre-dispatch window an interception pause lands
    // in) while harness.ttfbP50Ms is harness-family (the fixture server in THIS process answering).
    // Untagged, a big TTFB row reads as a protocol finding.
    console.log(
      `  ${pad(r.key, 30)} ${padL(`[${FAMILY_TAG[r.family] ?? r.family}]`, 7)} A p50=${fmt(r.a.p50)}${unit}  B p50=${fmt(r.b.p50)}${unit}` +
        `  ${r.ratio === null ? "" : `(${fmt(r.ratio, 1)}x)`}  ${r.widths === null ? "" : `${fmt(r.widths, 1)} ${basis}`}  ${r.separated ? "SEPARATED" : "not separated"}` +
        `${r.family !== "protocol" ? "  <-- NOT a protocol-presence signal" : ""}`,
    );
    if (!r.separated) console.log(`    ${r.reason}  — B min..max = ${fmt(r.b.min)}..${fmt(r.b.max)}${unit}; more rounds would settle it`);
  }
}

/**
 * The finding the ticket's A-vs-C framing cannot express, printed on its own so it cannot be lost
 * in a table of INDETERMINATEs: probes where our stack is separated from the undriven control AND
 * from naive automation.
 */
function printOutliers(analysis) {
  if (!analysis.bOutliers.length) {
    console.log("  none — our stack is not separated from both controls on any probe.");
    return;
  }
  for (const p of analysis.bOutliers) {
    const a = p.summaries.A;
    const b = p.summaries.B;
    const c = p.summaries.C;
    console.log(`\n  ${p.spec.key}  [${p.spec.family ?? "protocol"}]`);
    if (p.spec.kind === "rate") {
      console.log(`    A ${a.trueCount}/${a.n} true   B ${b.trueCount}/${b.n} true   C ${c.trueCount}/${c.n} true`);
    } else if (p.spec.kind === "label") {
      console.log(`    A {${a.set}}   B {${b.set}}   C {${c.set}}`);
    } else {
      const unit = p.spec.unit ? ` ${p.spec.unit}` : "";
      console.log(`    A p50=${fmt(a.p50)}${unit} [${fmt(a.min)}..${fmt(a.max)}]   B p50=${fmt(b.p50)}${unit} [${fmt(b.min)}..${fmt(b.max)}]   C p50=${fmt(c.p50)}${unit} [${fmt(c.min)}..${fmt(c.max)}]`);
      const ratio = a.p50 ? b.p50 / a.p50 : null;
      if (ratio !== null && Number.isFinite(ratio)) console.log(`    our stack is ${fmt(ratio, 1)}x configuration A on this axis`);
    }
    console.log(`    vs A: ${p.separationAB.reason}`);
    console.log(`    vs C: ${p.separationBC.reason}`);
    console.log(`    A vs C: ${p.separation.reason}`);
    console.log(`    why it matters: ${p.spec.note}`);
  }
}

/**
 * The context family, printed with its numbers AND with the confound's own measurement beside it.
 *
 * The point of the section is that a reader should not have to take "this is cold-start confounded"
 * on trust: the per-configuration browser age at probe time is the quantity that decides whether the
 * cold-stall column means anything, so it is printed in the same block rather than 40 lines earlier
 * in the instrument-validity section.
 */
function printContextProbes(analysis) {
  if (!analysis.contextProbes.length) {
    console.log("  none.");
    return;
  }
  for (const p of analysis.contextProbes) {
    console.log(`\n  ${p.spec.key}  [context — reported, NEVER counted toward #102]`);
    for (const cfg of Object.keys(p.summaries)) {
      const s = p.summaries[cfg];
      if (!s || s.n === 0) { console.log(`    ${cfg}: no valid readings`); continue; }
      if (p.spec.kind === "rate") console.log(`    ${cfg}: ${s.trueCount}/${s.n} true`);
      else if (p.spec.kind === "label") console.log(`    ${cfg}: ${JSON.stringify(s.counts)}`);
      else console.log(`    ${cfg}: p50=${fmt(s.p50)} min=${fmt(s.min)} max=${fmt(s.max)} spread=${fmt(s.spread)} n=${s.n}`);
    }
    console.log(`    A vs C: ${p.separation.reason}`);
    console.log(`    A vs B: ${p.separationAB.reason}`);
    console.log(`    confound: ${p.spec.confound ?? "(none declared)"}`);
    if (analysis.browserAgeByConfig) {
      const ages = Object.entries(analysis.browserAgeByConfig)
        .map(([cfg, ms]) => `${cfg}=${ms === null || ms === undefined ? "n/a" : `${Math.round(ms)}ms`}`)
        .join(" ");
      console.log(`    browser age at probe time, median per configuration: ${ages}`);
      console.log("      ^ THIS is the number that decides whether the column above means anything. Arms that reached their probe page with materially different amounts of browser life behind them are not comparable on a cold-connection measurement, whichever direction the difference runs.");
    } else {
      console.log("    browser age at probe time: NOT MEASURED in this run — the confound is therefore unquantified, which is a reason to trust this row less, not more.");
    }
  }
}

/**
 * Comparisons the instrument refused to make, with what it would take to make them.
 *
 * Printed as its own section because these rows are invisible in a table of "no"s and they are the
 * ones that change what the next run should do: a resolution-limited protocol probe is asking for
 * more rounds or a coarser probe, while a genuinely quiet one is asking for a different mechanism.
 */
function printResolutionLimited(analysis) {
  if (!analysis.resolutionLimited.length) {
    console.log("  none — every comparison had an observable noise band in both arms.");
    return;
  }
  for (const p of analysis.resolutionLimited) {
    const a = p.summaries.A;
    const c = p.summaries.C;
    console.log(`\n  ${p.spec.key}  [${p.spec.family ?? "protocol"}]${(p.spec.family ?? "protocol") === "protocol" ? "  <-- a protocol-family probe that could NOT be evaluated" : ""}`);
    if (p.spec.kind === "label") {
      console.log(`    A {${a?.set ?? []}}   C {${c?.set ?? []}}`);
    } else {
      console.log(`    A p50=${fmt(a?.p50)} spread=${fmt(a?.spread)}   C p50=${fmt(c?.p50)} spread=${fmt(c?.spread)}   floor=${p.spec.floor ?? 0} (${p.spec.floorBasis ?? "provenance undeclared"})`);
    }
    console.log(`    ${p.separation.reason}`);
  }
}

/** B0's whole reason for existing: attributing a B-vs-A separation to the guard or to the driver. */
function printGuardAttribution(analysis, configs) {
  const rows = attributeToGuard(analysis.probes);
  if (!configs.includes("B0")) {
    console.log("  ATTRIBUTION UNRESOLVED — the B0 arm (our stack, driver pipe, NO Fetch guard) did not run.");
    console.log("  Every B-vs-A separation below is therefore ambiguous between two causes with different fixes:");
    console.log("  the driver's own pipe and session bookkeeping, or the navigation guard's Fetch.enable urlPattern '*'.");
    console.log("  Drop CDP_BASELINE_NOGUARD=0 to restore it; it costs one extra capture per round.");
  }
  if (!rows.length) {
    console.log("  no probe separated our stack from the no-protocol control, so there is nothing to attribute.");
    return;
  }
  for (const r of rows) {
    console.log(`  ${pad(r.key, 42)} [${r.family}]  ${r.verdict}`);
    console.log(`    ${r.detail}`);
  }
}

function printProbeDetail(analysis) {
  for (const p of analysis.probes) {
    if (!p.separation.separated) continue;
    console.log(`\n  ${p.spec.key}  [${p.spec.family ?? "protocol"}]  ->  ${p.verdict}`);
    console.log(`    separation: ${p.separation.reason}`);
    if (p.position.t !== null && p.position.t !== undefined) {
      console.log(
        `    B position on the A->C axis: t=${fmt(p.position.t, 2)} (0 = A's median, 1 = C's median)` +
          (p.position.axisWidths !== null && p.position.axisWidths !== undefined
            ? `; the axis is ${fmt(p.position.axisWidths, 1)} probe-resolution widths wide${p.position.resolutionLimited ? "  <-- RESOLUTION-LIMITED: the match band is under one resolution width, so this placement can flip between runs" : ""}`
            : ""),
      );
    }
    for (const cfg of Object.keys(p.summaries)) {
      const s = p.summaries[cfg];
      if (!s || s.n === 0) { console.log(`    ${cfg}: no valid readings`); continue; }
      if (p.spec.kind === "rate") console.log(`    ${cfg}: ${s.trueCount}/${s.n} true${s.nulls ? ` (${s.nulls} null)` : ""}`);
      else if (p.spec.kind === "label") console.log(`    ${cfg}: ${JSON.stringify(s.counts)}`);
      else console.log(`    ${cfg}: p50=${fmt(s.p50)} min=${fmt(s.min)} max=${fmt(s.max)} spread=${fmt(s.spread)} n=${s.n}${s.nulls ? ` (${s.nulls} null)` : ""}`);
    }
    console.log(`    why it matters: ${p.spec.note}`);
  }
}

function printGateRecommendations(analysis) {
  const gated = analysis.probes.filter((p) => p.gate);
  if (!gated.length) {
    console.log("  none — no probe discriminated, so there is nothing for #102 to threshold.");
    return;
  }
  for (const p of gated) {
    const family = p.spec.family ?? "protocol";
    console.log(`\n  ${p.spec.key}  [${family}]${family !== "protocol" ? "  <-- NOT a protocol-presence signal; gating on it would test the wrong thing" : ""}`);
    if (p.gate.refused) console.log(`    REFUSED:   no threshold is offered for this probe (${p.gate.refusedBecause ?? "reason not recorded"}).`);
    if (p.gate.failsToday) console.log("    NOTE:      this threshold FAILS the current stack by design — it is the divergence to close, not a baseline we hold.");
    console.log(`    rule:      ${p.gate.rule}`);
    console.log(`    tolerance: ${p.gate.tolerance}`);
    if (p.gate.headroomWidths !== null && p.gate.headroomWidths !== undefined) {
      const flake = p.gate.headroomWidths < 1 ? "  <-- UNDER ONE NOISE WIDTH: this gate will flake on a busy host" : "";
      // Naming the basis is the whole point: "1.20 of A's observed noise widths" read as a measured
      // margin in a run where A's observed spread was 0.002ms and the number came from a constant
      // measured on somebody's laptop. That case is now refused outright; the only surviving
      // non-observed basis is an exact integer quantum, which is a stronger claim, not a weaker one.
      const basis = p.gate.headroomBasis === "exact-quantum"
        ? "the probe's EXACT quantum — A reproduced the same integer every round"
        : "A's observed noise band";
      console.log(`    headroom:  ${fmt(p.gate.headroomWidths, 2)} widths of ${basis}, above A's worst round${flake}`);
    }
    console.log(`    our stack: ${p.gate.bMargin}`);
  }
}

// ═══ main ════════════════════════════════════════════════════════════════════════════════════════

async function main() {
  const started = Date.now();
  // Both of these are INSIDE the try below, not above it. startFixture() calls buildPageScript(),
  // which runs assertEmbeddable over the imported probe sources — the guard that exists to catch a
  // backtick or a `${` drifting into upstream probe source. Constructing the fixture before the try
  // meant that guard could only ever surface as an unhandled rejection: no "INSTRUMENT FAILED: ..."
  // line, and no `finally`, so CDP_BASELINE_OUT was never written for the one failure the guard was
  // written to report.
  let fixture = null;
  let tmpRoot = null;
  const record = {
    tool: "measure-cdp-baseline",
    issue: 101,
    startedAt: new Date().toISOString(),
    env: {
      rounds: ROUNDS, headless: HEADLESS, withCollector: WITH_COLLECTOR, noGuardArm: WITH_NOGUARD_ARM,
      rotate: ROTATE, probeDelayMs: PROBE_DELAY_MS, warmupMs: WARMUP_MS, reportTimeoutMs: REPORT_TIMEOUT_MS,
      noSandbox: NO_SANDBOX,
    },
    calibration: null,
    captures: [],
    analysis: null,
  };
  let exitCode = 0;

  try {
    // BEFORE ANYTHING IS SPAWNED. This asserts that both imported probe sources still declare every
    // leaf the probe specs read out of them. A leaf renamed upstream — `cdp.fetchProbe.*` becoming
    // `cdp.resourceTiming.*` is exactly the change that prompted this — reads as undefined in every
    // arm of every round, summarizes as n=0, and reports as "this probe did not separate the
    // controls": twenty minutes of container time spent producing a clean-looking negative from a
    // broken wire. Failing here costs a second and names the path.
    const contracts = assertProbeContracts({ withCollector: WITH_COLLECTOR });
    record.leafContracts = contracts;
    const loose = [...contracts.raw.loose, ...(contracts.collector.loose ?? [])];
    if (loose.length) {
      console.log(`note: ${loose.length} probe leaf/leaves matched loosely (declared as object keys rather than as assignments): ${loose.join(", ")}`);
    }

    fixture = startFixture();
    tmpRoot = await mkdtemp(join(tmpdir(), "bgw-cdp-baseline-"));
    await new Promise((r) => fixture.server.listen(0, "127.0.0.1", r));
    const port = fixture.server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const ctx = {
      awaitReport: fixture.awaitReport,
      probeUrl: (runId, cfg) => `${base}/probe?run=${runId}&cfg=${cfg}`,
      // Same query string, so the warm-up page can hand it straight to /probe.
      warmupUrl: (runId, cfg) => `${base}/warmup?run=${runId}&cfg=${cfg}`,
      chromePath: null,
      cloneArgs: [],
    };

    console.log("=== browse-gateway :: three-way CDP-presence baseline (#101) ===");
    console.log(`fixture ${base}/probe   rounds=${ROUNDS}   ${HEADLESS ? "HEADLESS (confound: the shipping vehicle is headful)" : "headful"}   collector=${WITH_COLLECTOR ? "on" : "off"}`);

    // ── calibration: learn B's real binary and argv, so A and C can be spawned from it ───────────
    console.log("\n--- calibration: measuring configuration B's real launch ---");
    const calibDir = join(tmpRoot, "calibration");
    await mkdir(calibDir, { recursive: true });
    let measured = null;
    let calibError = null;
    {
      let core = null;
      try {
        core = await createBrowserCore({ headless: HEADLESS, channel: "chrome", noSandbox: NO_SANDBOX, userDataDir: calibDir });
        await core.setNavigationGuard(guardAllowLoopback);
        measured = await findBrowserByUserDataDir(calibDir);
      } catch (err) {
        calibError = String(err?.message ?? err);
      } finally {
        if (core) { try { await core.close(); } catch { try { await core.kill(5_000); } catch { /* ignore */ } } }
      }
    }

    const constructed = buildLaunchOptions(resolveCoreOptions({ headless: HEADLESS, channel: "chrome", noSandbox: NO_SANDBOX }));
    let argSource;
    let dropped = [];
    if (measured) {
      ctx.chromePath = process.env.BGW_CHROME_PATH || measured.argv[0];
      // Everything the driver passes, minus the profile and the protocol transport, minus the
      // startup URL. What is left is the shared baseline for A and C, which is as close to argv
      // parity as three different launch mechanisms can get.
      const kept = [];
      for (const arg of measured.argv.slice(1)) {
        if (CLONE_DROP_PREFIXES.some((p) => arg === p || arg.startsWith(p))) { dropped.push(arg); continue; }
        if (!arg.startsWith("-")) { dropped.push(arg); continue; } // the startup URL / about:blank
        kept.push(arg);
      }
      ctx.cloneArgs = kept;
      argSource = "measured-from-proc";
      console.log(`  binary:     ${ctx.chromePath}`);
      console.log(`  B argv:     ${measured.argv.length - 1} switches read from /proc/${measured.pid}/cmdline`);
      console.log(`  cloned:     ${kept.length} switches reused verbatim for A and C`);
      console.log(`  dropped:    ${dropped.join(" ") || "(none)"}`);
    } else {
      ctx.chromePath = await resolveChromePath();
      ctx.cloneArgs = [
        ...(constructed.args ?? []),
        // The minimum needed for an unattended launch from a fresh profile. Everything else
        // Playwright passes (~35 switches) is ABSENT in this mode, which is why the arg delta is
        // reported as unmeasured rather than small.
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-search-engine-choice-screen",
        "--no-service-autorun",
        "--password-store=basic",
        "--use-mock-keychain",
        ...(HEADLESS ? ["--headless=new"] : []),
      ];
      argSource = "constructed-fallback";
      console.log(`  /proc unavailable or B did not launch${calibError ? ` (${calibError})` : ""} — args CONSTRUCTED, not measured.`);
      console.log(`  binary:     ${ctx.chromePath ?? "NOT FOUND"}`);
      console.log(`  args:       ${ctx.cloneArgs.length} switches; Playwright's own defaults are NOT reproduced in A and C.`);
      console.log("  RESIDUAL LAUNCH-ARG DELTA IS UNMEASURED IN THIS MODE.");
    }
    record.calibration = {
      argSource,
      chromePath: ctx.chromePath,
      calibError,
      measuredPid: measured?.pid ?? null,
      measuredArgv: measured?.argv ?? null,
      cloneArgs: ctx.cloneArgs,
      dropped,
      constructedArgs: constructed.args ?? [],
    };

    if (!ctx.chromePath) {
      throw new Error("no Chrome binary found for configurations A and C (set BGW_CHROME_PATH); without them there are no controls and nothing can be concluded");
    }

    // ── interleaved captures ─────────────────────────────────────────────────────────────────────
    //
    // B0 IS OUTSIDE THE ROTATION, ON PURPOSE, AND THAT IS A TRADE RATHER THAN AN OVERSIGHT.
    //
    // The rotation exists so that within-round drift on the host cannot masquerade as an A-vs-C
    // separation, and it only works when the round count divides evenly by the number of positions
    // being rotated. Three graded configurations and six rounds do that; adding B0 to the cycle would
    // make it four positions into six rounds and hand two configurations an extra turn in the
    // quietest slot — reintroducing, in the graded arms, exactly the bias the rotation was added to
    // remove. So the graded triple keeps its clean three-position cycle and B0 always runs last.
    //
    // The cost is real and is stated in the residual confounds: B0's OWN numbers carry a fixed
    // position, so they are not protected against within-round drift the way A, B and C are. That is
    // acceptable only because B0 is never graded — it answers "does the guardless stack also separate
    // from A", a comparison used to attribute a finding, never to establish one. If B0 is ever
    // promoted to a graded arm, it has to join the rotation and ROUNDS has to become a multiple of 4.
    const gradedOrder = ["A", "B", "C"];
    const configs = WITH_NOGUARD_ARM ? ["A", "B0", "B", "C"] : ["A", "B", "C"];
    console.log(`\n--- captures (interleaved ${configs.join(",")} per round${ROTATE ? ", A/B/C rotated" : ""}${WITH_NOGUARD_ARM ? "; B0 runs last, outside the rotation" : ""}) ---`);
    for (let round = 1; round <= ROUNDS; round++) {
      const rotatedGraded = ROTATE ? gradedOrder.map((_, i) => gradedOrder[(i + round - 1) % gradedOrder.length]) : gradedOrder;
      const order = WITH_NOGUARD_ARM ? [...rotatedGraded, "B0"] : rotatedGraded;
      const line = [];
      for (const cfg of order) {
        const runId = randomUUID();
        const dir = join(tmpRoot, `${cfg}-r${round}`);
        await mkdir(dir, { recursive: true });
        const t0 = Date.now();
        const capture = { config: cfg, round, runId, ok: false, valid: false, error: null, durationMs: 0, warnings: [], payload: null, extra: {}, argv: null };
        // THE HARNESS'S OWN CONTENTION, MEASURED PER CAPTURE. The fixture server, the Fetch guard's
        // client side and the raw CDP client all live on THIS event loop, and the amount of work
        // each one does is per-configuration: C parses several hundred Runtime.consoleAPICalled
        // payloads while the same loop answers the probe's ~26 cache-busted GETs; A is idle. That
        // contention lands on the fixture's own latency, which is why TTFB and end-to-end wall time
        // are harness-family. This turns the confound from an argument in a comment into a number in
        // the record: a per-configuration difference here is the size of the instrument's footprint.
        const loop = monitorEventLoopDelay({ resolution: LOOP_DELAY_RESOLUTION_MS });
        loop.enable();
        try {
          const result =
            cfg === "A" ? await captureA(ctx, runId, dir)
              : cfg === "C" ? await captureC(ctx, runId, dir)
                : await captureB(ctx, runId, dir, { withGuard: cfg === "B" });
          capture.ok = true;
          capture.payload = result.payload;
          capture.extra = result.extra ?? {};
          capture.argv = result.argv ?? null;
          const assessed = assessCapture(result.payload, { config: cfg, extra: capture.extra });
          capture.valid = assessed.valid;
          capture.invalidReasons = assessed.reasons;
          capture.warnings = captureWarnings(result.payload, capture.extra);
          // Browser age at probe time, recoverable from the JSON rather than inferable from it: the
          // page stamps meta.startedAt after its in-page delay, and the host knows when it spawned
          // the process. Both clocks are this machine's, so the difference is a real interval — and
          // it is the number that says whether the warm-up actually equalized the three arms.
          const probeStartedAt = Date.parse(result.payload?.meta?.startedAt ?? "");
          if (Number.isFinite(probeStartedAt) && capture.extra.spawnedAtMs) {
            capture.browserAgeAtProbeMs = probeStartedAt - capture.extra.spawnedAtMs;
          }
        } catch (err) {
          capture.error = String(err?.message ?? err);
        }
        loop.disable();
        // The histogram's values include the sampling interval itself, so an idle loop reads ~one
        // resolution. Excess is what this is for; the raw mean is kept so the subtraction is visible.
        capture.loopDelay = {
          resolutionMs: LOOP_DELAY_RESOLUTION_MS,
          meanMs: loop.mean / 1e6,
          excessMeanMs: Math.max(0, loop.mean / 1e6 - LOOP_DELAY_RESOLUTION_MS),
          p99Ms: loop.percentile(99) / 1e6,
          maxMs: loop.max / 1e6,
        };
        capture.durationMs = Date.now() - t0;
        record.captures.push(capture);
        // A failed round is printed, never silently dropped: a shrinking sample that nobody notices
        // is how a three-way comparison quietly turns into a two-way one.
        line.push(
          `${cfg}=${capture.error ? "ERROR" : capture.valid ? "ok" : "INVALID"}(${(capture.durationMs / 1000).toFixed(1)}s${capture.warnings.length ? `,${capture.warnings.length}w` : ""})`,
        );
        // Cleaned per capture rather than at the end: fifteen headful Chrome profiles is gigabytes.
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
      console.log(`  round ${round}:  ${line.join("   ")}`);
    }

    // ── instrument validity, before any interpretation ───────────────────────────────────────────
    //
    // EVERY CHECK BELOW THAT CAN MAKE THE THREE COLUMNS INCOMPARABLE IS BLOCKING. `check()` records
    // into `instrumentFailures`, which `analyze()` turns into INSTRUMENT-FAILED and a blocked #102
    // gate. The previous revision printed these and computed the headline anyway — so a run could
    // print "FAIL console.debug is native code in every configuration" forty lines above
    // "B-MATCHES-A ... #102 gate: UNBLOCKED" and exit 0, which is precisely the false green the dead
    // sink check was written to catch.
    //
    // A check is SOFT (`blocking: false`) only when its failure merely shrinks the sample, because
    // the thin-capture guard in analyze() already refuses to grade a shrunken run.
    //
    // AND EVERY BLOCKING CHECK IS SCOPED TO THE GRADED ARMS, because a blocking check on an ungraded
    // one can only ever produce a false failure. B0 is a DIAGNOSTIC: it is not in GRADED_CONFIGS, its
    // captures feed no summary that any verdict reads, `analyze` refuses to fail the run on a thin B0
    // by design, and the RT check below already restricts itself to GRADED_CONFIGS for exactly this
    // reason. Left unscoped, one slow B0 navigate() in the container — B0 goes through the same
    // captureB path, so it carries probeOverlappedNavigate — declared six rounds of good graded data
    // "not a measurement", blocked #102 and exited 1 over an arm that cannot move a single verdict.
    // B0 anomalies are still surfaced, as warnings, in their own check.
    console.log("\n--- instrument validity ---");
    const instrumentFailures = [];
    const failures = record.captures.filter((c) => c.error);
    const invalid = record.captures.filter((c) => c.ok && !c.valid);
    const gradedCaptures = record.captures.filter((c) => GRADED_CONFIGS.includes(c.config));
    const diagnosticCaptures = record.captures.filter((c) => !GRADED_CONFIGS.includes(c.config));
    const cCaptures = record.captures.filter((c) => c.config === "C" && c.ok);
    const consoleEvents = cCaptures.reduce((a, c) => a + (c.extra?.consoleApiCalled ?? 0), 0);
    const positiveControlAttached = consoleEvents > 0;
    const check = (label, ok, detail, { blocking = true } = {}) => {
      console.log(`  ${ok ? "PASS" : blocking ? "FAIL" : "warn"}  ${label}${detail ? `  — ${detail}` : ""}`);
      if (!ok && blocking) instrumentFailures.push(`${label}${detail ? ` (${detail})` : ""}`);
    };

    check(`every capture produced a report`, failures.length === 0, failures.length ? failures.map((c) => `${c.config}/r${c.round}: ${c.error}`).join(" | ") : "", { blocking: false });
    check(`every reporting capture passed its in-page self-tests`, invalid.length === 0, invalid.length ? invalid.map((c) => `${c.config}/r${c.round}: ${c.invalidReasons?.join("; ")}`).join(" | ") : "", { blocking: false });
    check(
      `the positive control actually attached (C received Runtime events)`,
      positiveControlAttached,
      `Runtime.consoleAPICalled total across C captures = ${consoleEvents}`,
    );
    check(
      `no orphan reports (captures did not overlap)`,
      fixture.stats.orphanReports === 0,
      `orphans=${fixture.stats.orphanReports}` +
        (fixture.stats.lateAfterFatal ? `, plus ${fixture.stats.lateAfterFatal} late report(s) after an in-page error (counted separately — those are page errors, not interleaving)` : ""),
    );
    const sinkStubbed = gradedCaptures.filter((c) => c.payload?.meta?.consoleDebugNative === false);
    check(`console.debug is native code in every GRADED configuration`, sinkStubbed.length === 0, sinkStubbed.map((c) => `${c.config}/r${c.round}`).join(","));
    const overlapped = gradedCaptures.filter((c) => c.extra?.probeOverlappedNavigate);
    check(
      `no GRADED capture probed while the driver was still settling`,
      overlapped.length === 0,
      overlapped.length
        ? `${overlapped.map((c) => `${c.config}/r${c.round} nav=${c.extra.navigateMs}ms`).join(", ")} — raise CDP_BASELINE_DELAY_MS above the slowest navigate() and re-run; B's timing column includes the driver's post-navigation burst as it stands`
        : "",
    );
    // The same two conditions on the DIAGNOSTIC arm, reported and never blocking. B0's only job is to
    // say whether a B-vs-A separation survives removing the Fetch guard; a B0 capture that probed
    // during the driver's settle, or read a stubbed sink, weakens THAT attribution and nothing else,
    // so it belongs in `attributeToGuard`'s reader's field of view rather than in the run's exit code.
    if (diagnosticCaptures.length) {
      const diagOverlapped = diagnosticCaptures.filter((c) => c.extra?.probeOverlappedNavigate);
      const diagStubbed = diagnosticCaptures.filter((c) => c.payload?.meta?.consoleDebugNative === false);
      check(
        `the diagnostic arm(s) (${[...new Set(diagnosticCaptures.map((c) => c.config))].join(",")}) probed cleanly — reported only, they grade nothing`,
        diagOverlapped.length === 0 && diagStubbed.length === 0,
        [
          diagOverlapped.length ? `probed during the driver's settle: ${diagOverlapped.map((c) => `${c.config}/r${c.round} nav=${c.extra.navigateMs}ms`).join(", ")}` : "",
          diagStubbed.length ? `stubbed console sink: ${diagStubbed.map((c) => `${c.config}/r${c.round}`).join(",")}` : "",
        ].filter(Boolean).join("; ") + (diagOverlapped.length || diagStubbed.length ? " — trust the guard-attribution section below less, but nothing graded is affected" : ""),
        { blocking: false },
      );
    }
    // The harness's own Resource Timing read is the ONLY source of pre-dispatch latency data, since
    // the imported probe reads the entries before they exist. Zero recovered rows silently retires
    // the whole Fetch-interception family — the one family that survives the V8 fixes retiring the
    // discrete probes — without any probe reporting an error, so a run that recovered none of them
    // in some configuration is an instrument failure rather than a quiet result.
    const reporting = record.captures.filter((c) => c.ok);
    const noRt = reporting.filter((c) => (harnessStalls(c.payload?.meta).usable ?? 0) === 0);
    const rtByConfig = GRADED_CONFIGS.filter((cfg) => {
      const own = reporting.filter((c) => c.config === cfg);
      return own.length > 0 && own.every((c) => (harnessStalls(c.payload?.meta).usable ?? 0) === 0);
    });
    check(
      `harness recovered Resource Timing rows in every capture`,
      reporting.length > 0 && noRt.length === 0,
      noRt.map((c) => `${c.config}/r${c.round}`).join(", "),
      // Blocking only when a whole configuration produced none: a single capture without rows just
      // contributes a null to that probe's series, which the summaries already count.
      { blocking: reporting.length === 0 || rtByConfig.length > 0 },
    );
    const probeRt = reporting.filter((c) => (c.payload?.raw?.fetchProbe?.stallMs?.length ?? 0) > 0);
    console.log(
      `  note: the IMPORTED probe's own Resource Timing read produced rows in ${probeRt.length}/${reporting.length} captures` +
        `${probeRt.length === 0 ? " — it reads performance.getEntriesByName() before the entry is queued at responseEnd (upstream gap, reported not fixed)" : ""}`,
    );
    // See assessRendererParity: a DISAGREEMENT between configurations blocks (it has the protocol's
    // own shape), a uniform answer does not — including the uniform false that bare Xvfb with no
    // window manager legitimately produces. GRADED captures only, for the reason given at the top of
    // this section: a B0 disagreement cannot move a verdict, so it must not fail the run.
    const focus = assessRendererParity(gradedCaptures.filter((c) => c.ok), cCaptures);
    const cProtocolTotals = focus.protocolTotals;
    check(
      `document.hasFocus() AND document.visibilityState AGREE across configurations (a per-configuration focus/visibility difference is a scheduling confound with the protocol's own shape: an unfocused renderer is deprioritized and a hidden one has its timers clamped, which is a uniform multiplier on one arm's console-cost timings)`,
      focus.ok,
      focus.detail,
    );
    if (focus.uniformWithoutFocus) {
      console.log(`  note: every configuration read hasFocus=${focus.states.join("")} — accepted. Under bare Xvfb with no window manager the X input focus is PointerRoot and no renderer holds focus; the negative control reads the same way as the driven arms, so there is no per-configuration differential to confound the timing probes. A DISAGREEMENT would still block.`);
    }
    // A uniformly non-visible run is accepted on the same no-differential logic, but it is worth
    // saying out loud that it changes what the ABSOLUTE numbers mean: a hidden renderer has its
    // timers clamped, so every console-cost figure in the run is depressed by the same factor. The
    // comparisons survive; a threshold lifted out of such a run into #102 would be measured against
    // a throttled clock and would not hold on a visible page.
    if (focus.visibilityOk && focus.visibilityStates.length === 1 && !focus.visibilityStates.includes("visible")) {
      console.log(`  note: every configuration read visibilityState=${focus.visibilityStates.join("")} — accepted (no per-configuration differential), but every timing figure in this run was taken on a throttled renderer, so the LEVELS are not transferable even though the comparisons are.`);
    }
    // Browser age at probe time, per configuration: the number that says whether the warm-up page
    // actually equalized what it was added to equalize, and the confound the context-family
    // cold-stall probe is reported against.
    const ageByConfigMs = {};
    for (const cfg of GRADED_CONFIGS) {
      const ages = reporting.filter((c) => c.config === cfg).map((c) => c.browserAgeAtProbeMs).filter((x) => typeof x === "number");
      ageByConfigMs[cfg] = ages.length ? median(ages) : null;
    }
    const ageByConfig = GRADED_CONFIGS.map((cfg) => `${cfg}=${ageByConfigMs[cfg] === null ? "n/a" : `${ageByConfigMs[cfg].toFixed(0)}ms`}`).join(" ");
    console.log(`  browser age at probe time (median): ${ageByConfig}${WARMUP_MS ? `  (A holds ${WARMUP_MS}ms on /warmup first)` : "  (warm-up DISABLED: A is cold-started into its own measurement)"}`);
    // WHETHER THE WARM-UP ACTUALLY WORKED, computed rather than asserted. The /warmup page was added
    // to stop A from being cold-started into its own measurement; a verifier then measured it
    // over-correcting the other way. Neither direction is visible in the number above without doing
    // this division, and the direction is what tells the operator which way to move WARMUP_MS.
    // Reported, not blocking: the threshold at which an age difference starts to matter is exactly
    // what has never been measured, so blocking on a guessed one would trade a stated confound for an
    // invented gate. The cold-stall probe is already demoted out of the protocol family for this.
    const knownAges = GRADED_CONFIGS.map((cfg) => ageByConfigMs[cfg]).filter((x) => typeof x === "number" && x > 0);
    if (knownAges.length === GRADED_CONFIGS.length) {
      const oldest = Math.max(...knownAges);
      const youngest = Math.min(...knownAges);
      const ratio = oldest / youngest;
      const oldestCfg = GRADED_CONFIGS.find((cfg) => ageByConfigMs[cfg] === oldest);
      const youngestCfg = GRADED_CONFIGS.find((cfg) => ageByConfigMs[cfg] === youngest);
      console.log(
        `  warm-up equalization: ${oldestCfg} reaches its probe with ${ratio.toFixed(2)}x the browser life of ${youngestCfg} (${oldest.toFixed(0)}ms vs ${youngest.toFixed(0)}ms). ` +
          (ratio < 1.25
            ? "Within 25% — the three arms are close to age-matched."
            : `Above 25%: ${oldestCfg === "A" ? `CDP_BASELINE_WARMUP_MS=${WARMUP_MS} is over-correcting — lower it by roughly ${(oldest - youngest).toFixed(0)}ms` : `A is still the young arm — raise CDP_BASELINE_WARMUP_MS by roughly ${(oldest - youngest).toFixed(0)}ms`}. Any cold-connection reading in this run carries that difference.`),
      );
    } else {
      console.log("  warm-up equalization: NOT COMPUTABLE (an arm produced no browser-age reading), so the cold-start confound is unquantified in this run.");
    }
    // The instrument's own footprint on this event loop, per configuration. Not blocking: it is the
    // magnitude of a confound the harness cannot remove without moving the fixture into another
    // process, so it is reported as a number rather than adjudicated.
    const loopByConfig = GRADED_CONFIGS.map((cfg) => {
      const own = record.captures.filter((c) => c.config === cfg && c.loopDelay);
      return `${cfg}=${own.length ? `${median(own.map((c) => c.loopDelay.excessMeanMs)).toFixed(1)}/${median(own.map((c) => c.loopDelay.p99Ms)).toFixed(1)}ms` : "n/a"}`;
    }).join(" ");
    console.log(`  harness event-loop delay, excess-mean/p99 (median across rounds): ${loopByConfig}`);
    if (cCaptures.length) {
      console.log(`  C protocol traffic (summed over ${cCaptures.length} captures): ${JSON.stringify(cProtocolTotals)}`);
    }
    const allWarnings = record.captures.flatMap((c) => c.warnings.map((w) => `${c.config}/r${c.round}: ${w}`));
    if (allWarnings.length) {
      console.log("  warnings:");
      for (const w of allWarnings) console.log(`    - ${w}`);
    }

    // ── analysis ─────────────────────────────────────────────────────────────────────────────────
    const analysis = analyze(record.captures, {
      configs, positiveControlAttached, instrumentFailures, rotated: ROTATE,
      withCollector: WITH_COLLECTOR,
      browserAgeByConfig: ageByConfigMs,
      // Declared, not inferred, for the same reason `rotated` is: the analysis sees values, never the
      // schedule. `roundsBalanced` says whether every rotated configuration got the same number of
      // within-round positions; false is a per-configuration bias on the axis the gate reads.
      roundsBalanced: ROUNDS % gradedOrder.length === 0,
      // assertProbeContracts() ran at the top of this try and did not throw, so every leaf the probe
      // specs read is still DECLARED in the imported source text. That turns the dead-leaf diagnosis
      // from "renamed upstream" — a claim this run has already disproved — into "declared but never
      // populated". Collector leaves are the only ones this could mis-state, and they are excluded
      // from the dead-leaf check entirely when the collector is off, which is the only case where
      // their half of the contract was skipped.
      contractsAsserted: true,
    });
    record.analysis = {
      status: analysis.status,
      headline: analysis.headline,
      gateBlocked: analysis.gateBlocked,
      gateBlockedReasons: analysis.gateBlockedReasons,
      // The MERGED list, not the runner's: analyze() adds the failures it can detect from the
      // numbers alone (a dead leaf, a rule contradicting itself), and a failure that blocked the
      // gate but did not appear in the record would be invisible to anyone reading the JSON.
      instrumentFailures: analysis.instrumentFailures,
      counts: analysis.counts,
      positiveControlAttached,
      consoleApiCalledTotal: consoleEvents,
      protocolValidated: analysis.protocolValidated,
      probesInadequate: analysis.probesInadequate,
      protocolDiscriminating: analysis.protocolDiscriminating.map((p) => p.spec.key),
      // The subset of those that actually hand #102 a number: not refused, and not so tight that the
      // gate would flake. Recorded separately because "the suite is validated" and "this run produced
      // a shippable threshold" are different claims, and a reader working from the JSON alone would
      // otherwise have to re-derive the second one from the per-probe gate blocks.
      usableThresholds: analysis.usableThresholds.map((p) => p.spec.key),
      controlOnlyDiscriminating: analysis.controlOnly.map((p) => p.spec.key),
      // Comparisons the instrument REFUSED to make. In the record because "not separated" and
      // "could not be evaluated" are different facts and only the first one belongs in a sentence
      // about our stack; a reader working from the JSON alone must be able to tell them apart.
      resolutionLimited: analysis.resolutionLimited.map((p) => `${p.spec.key} [${p.spec.family ?? "protocol"}]`),
      protocolResolutionLimited: analysis.protocolResolutionLimited.map((p) => p.spec.key),
      browserAgeByConfigMs: ageByConfigMs,
      guardAttribution: attributeToGuard(analysis.probes),
      // Everything that separated but cannot validate the suite — controls AND harness-produced
      // values. Kept alongside the control-only list because a reader who sees only the latter can
      // conclude "nothing else separated" from a run where fixture latency did.
      nonProtocolDiscriminating: analysis.nonProtocolDiscriminating.map((p) => `${p.spec.key} [${p.spec.family ?? "protocol"}]`),
      bOutliers: analysis.bOutliers.map((p) => p.spec.key),
      largestEffectsBvsA: rankEffects(analysis.probes),
      probes: analysis.probes.map((p) => ({
        key: p.spec.key,
        kind: p.spec.kind,
        family: p.spec.family ?? "protocol",
        unit: p.spec.unit ?? null,
        note: p.spec.note,
        summaries: p.summaries,
        separation: p.separation,
        separationAB: p.separationAB,
        separationBC: p.separationBC,
        bOutlier: p.bOutlier,
        position: p.position,
        verdict: p.verdict,
        gate: p.gate,
      })),
    };

    console.log(`\n--- per-probe comparison (${configs.map((c) => `${c} n=${analysis.counts[c]}`).join(", ")}) ---`);
    printComparisonTable(analysis, configs);
    console.log("\n--- discriminating probes (A vs C), in detail ---");
    if (!analysis.discriminating.length) console.log("  none.");
    else printProbeDetail(analysis);

    console.log("\n--- comparisons the instrument REFUSED to make (resolution-limited: not the same as 'quiet') ---");
    printResolutionLimited(analysis);

    console.log("\n--- context-family probes: measured, reported, and BARRED from the #102 gate ---");
    printContextProbes(analysis);

    console.log("\n--- probes where OUR STACK is separated from BOTH controls ---");
    printOutliers(analysis);

    console.log("\n--- attribution: is a B-vs-A separation the Fetch guard, or the driver pipe? (the B0 arm) ---");
    printGuardAttribution(analysis, configs);

    console.log("\n--- largest B-vs-A effects, separated or not (where the next round count should go) ---");
    printEffects(analysis);

    console.log("\n=== HEADLINE ===");
    console.log(`  ${analysis.status}: ${analysis.headline}`);
    console.log(`  #102 gate: ${analysis.gateBlocked ? "BLOCKED" : "UNBLOCKED"}`);
    for (const reason of analysis.gateBlockedReasons) console.log(`    - ${reason}`);
    if (!analysis.gateBlocked) {
      // Both halves are stated, because "the suite is validated" and "this run produced a number
      // #102 can ship" are different claims and only printing the first is how an UNBLOCKED headline
      // ended up sitting above a refused threshold or a sub-one-width flake warning.
      console.log(
        `    (${analysis.protocolDiscriminating.length} protocol-family probe(s) discriminated the controls on a rotated run; ` +
          `${analysis.usableThresholds.length} of them offer a usable threshold: ${analysis.usableThresholds.map((p) => p.spec.key).join(", ") || "(none)"})`,
      );
    }

    console.log("\n--- recommended #102 gate thresholds ---");
    console.log("  Every threshold below comes from ONE run on ONE host. Re-run before writing any of");
    console.log("  them into #102: a number whose two runs disagree is a coin flip with a decimal point,");
    console.log("  and the console family in particular sits close enough to the clock's resolution that");
    console.log("  it has been observed to flip sides between two runs minutes apart.");
    console.log("  PROVENANCE RULE: every per-probe `floor` in this file is a PROVISIONAL constant measured");
    console.log("  on a macOS, headless, constructed-args smoke run of n=2-3. A threshold whose margin would");
    console.log("  be counted in widths of one is REFUSED rather than softened, so any headroom printed below");
    console.log("  is either this run's own measured variance or an exact integer quantum.");
    printGateRecommendations(analysis);

    // ── residual confounds, stated rather than papered over ──────────────────────────────────────
    console.log("\n--- residual confounds ---");
    if (argSource === "measured-from-proc") {
      console.log(`  launch args: A and C were spawned from configuration B's REAL argv (${ctx.cloneArgs.length} switches, same binary).`);
      console.log(`    removed for all clones: ${dropped.join(" ") || "(none)"}`);
      console.log(`    added for A: --user-data-dir=<fresh>  <warm-up url as startup URL>`);
      console.log(`    added for C: --user-data-dir=<fresh>  --remote-debugging-port=0  about:blank`);
      console.log(`    IRREDUCIBLE: B talks over --remote-debugging-pipe and A talks over nothing; that difference IS the experiment.`);
    } else {
      console.log("  launch args: UNMEASURED. A and C ran on constructed args and do NOT carry Playwright's ~35 default switches.");
      console.log("    Any difference between B and the controls in this mode may be a switch, not the protocol. Re-run in-container.");
    }
    console.log(
      WARMUP_MS
        ? `  navigation shape: A reaches the probe page by location.replace() from a ${WARMUP_MS}ms warm-up page (its startup URL); B and C navigate to it from about:blank. Browser age at probe time is printed above — that is the number that says whether this worked. What remains irreducible is the navigation MECHANISM: A's is same-origin script-initiated, B's is the driver's, C's is Page.navigate.`
        : "  navigation shape: A loads the fixture as its STARTUP URL, so its page load IS browser startup while B and C both had a live browser first. CDP_BASELINE_WARMUP_MS=0 disabled the equalizer; the cold-start penalty lands on A's level AND on A's spread, which is the noise band the separation rule uses.",
    );
    console.log(
      `  ordering: the GRADED configurations (${gradedOrder.join(",")}) run ${ROTATE ? "rotated per round" : "in fixed order"} within each round, so ` +
        (ROTATE
          ? `position effects are spread across them (${ROUNDS % gradedOrder.length === 0 ? `${ROUNDS} rounds divide evenly across ${gradedOrder.length} positions` : `${ROUNDS} rounds do NOT divide evenly across ${gradedOrder.length} positions, so one configuration gets an extra turn in the quietest slot — the #102 gate is BLOCKED for that reason alone; re-run with a multiple of ${gradedOrder.length}`})`
          : "B always follows A and C always follows B, and the #102 gate is BLOCKED for that reason alone (drop CDP_BASELINE_ROTATE=0)"),
    );
    if (WITH_NOGUARD_ARM) {
      console.log("    B0 runs LAST in every round, deliberately outside the rotation: adding it to the cycle would make four positions into a round count chosen to divide by three, which would bias the GRADED arms. The price is that B0's own numbers are not protected against within-round drift — acceptable only because B0 is never graded and is used to attribute a finding, never to establish one.");
    } else {
      console.log("    B0 arm ABSENT (CDP_BASELINE_NOGUARD=0): any B-vs-A separation in this run cannot be attributed to the Fetch guard rather than to the driver pipe. That attribution is epic #92's actual question.");
    }
    console.log("  harness co-location: the fixture server, the Fetch guard's client side and the raw CDP client all run on THIS Node event loop, so each arm's fixture latency carries that arm's own harness load. That is why server-side latency (TTFB, end-to-end wall) is harness-family and cannot validate anything; the per-configuration event-loop delay printed above is the size of the effect.");
    console.log("  probe order inside the page: raw timing first, then the collector — so the collector's own fetch samples always run on a warmed connection. Same in all three.");
    console.log("  clock: Chrome coarsens performance.now() to ~100us. Console calls cost less than one tick, so every console MEDIAN is structurally 0 and only the mean/p90 carry information. A gate on a console median is not possible on this browser.");
    console.log("  fetch timing: the pre-dispatch numbers come from the HARNESS's post-run Resource Timing read, not from the imported probe (which reads the entries before Chrome queues them). Same requests either way — but the probe source needs the fix, not this script.");
    console.log("  main world: these probes run in the page's MAIN world, unlike the shipped collector's isolated-world page.evaluate. The key scans are therefore NOT blinded here — which also means their readings are not directly comparable to a snapshot's.");

    // Empirical consequence of whatever arg delta is left: diff the two environments the shipped
    // collector reports, excluding the cdp.* section (which is the measured signal, already tabled).
    if (WITH_COLLECTOR) {
      const firstValid = (cfg) => record.captures.find((c) => c.valid && c.config === cfg && c.payload?.collector)?.payload?.collector ?? null;
      const fpA = firstValid("A");
      const fpB = firstValid("B");
      if (fpA && fpB) {
        // Redacted here as well as at write time: this console output is what gets copied into a
        // ticket, and webrtc.* diffs carry ICE candidate lines with the host's public address in
        // them. The PATH is the finding ("the two environments differ on this axis"); the value is
        // only ever illustrative.
        const diffs = redactDeep(diffFingerprints(fpA, fpB).filter((d) => !d.path.startsWith("cdp.")));
        record.analysis.environmentDiffAB = diffs;
        console.log(`\n  environment diff A vs B (shipped collector, cdp.* excluded): ${diffs.length} divergent axis/axes`);
        for (const d of diffs.slice(0, 25)) {
          console.log(`    [${d.severity}] ${d.path}: A=${JSON.stringify(d.a)?.slice(0, 80)}  B=${JSON.stringify(d.b)?.slice(0, 80)}`);
        }
        if (diffs.length > 25) console.log(`    ... and ${diffs.length - 25} more (full list in the JSON record)`);
      } else {
        console.log("\n  environment diff A vs B: unavailable (one side produced no collector snapshot)");
      }
    }

    // The instrument working and the answer being flattering are different questions: a real,
    // reproduced divergence is DATA and still exits 0 so #102 can act on it. STRICT is for a caller
    // that wants any unflattering finding to fail the run.
    if (analysis.gateBlocked) exitCode = 1;
    else if (STRICT && (analysis.bMatchesC.length || analysis.protocolOutliers.length)) exitCode = 1;

    console.log(`\ncompleted in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } catch (err) {
    console.error(`\nINSTRUMENT FAILED: ${String(err?.stack ?? err)}`);
    record.instrumentError = String(err?.message ?? err);
    exitCode = 1;
  } finally {
    sweepSpawned();
    if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    fixture?.server.close();
    record.finishedAt = new Date().toISOString();
    record.fixtureStats = fixture?.stats ?? null;
    if (OUT_PATH) {
      try {
        // Redacted on the way out, never in memory: the analysis above needs the real values (the
        // A-vs-B environment diff is computed from the collector snapshots), and this file is the
        // artifact that gets pasted into a public ticket.
        await writeFile(OUT_PATH, JSON.stringify(redactDeep(record), null, 2));
        console.log(`\nfull record written to ${OUT_PATH}`);
      } catch (err) {
        console.error(`could not write ${OUT_PATH}: ${String(err?.message ?? err)}`);
      }
    }
  }

  process.exit(exitCode);
}

// Importable for unit tests without launching a browser: the verdict math above is the part most
// worth pinning down, and the epic's mandatory "probes are inadequate" branch has to be provably
// reachable rather than taken on faith.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
