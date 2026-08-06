# HANDOFF — 2026-08-05 (measurement session — two PRs merged, three diagnoses refuted)

A **build-and-measure session** that closed the two cheap measurement tickets from the #91–#94 epic
round, then absorbed a field report from a consumer project and measured that too. Everything here
is measurement: **no production behaviour changed anywhere**. The through-line is that nearly every
real finding was something reporting success while the thing it stood for had failed — including,
repeatedly, my own confident assertions, three of which the measurements refuted.

## What We Built

**PR #113 (merged, `cff2772`) — input realism (#109) and CDP detectability (#100, #101).**

- `src/browser/fingerprint.ts` +~730 — a `cdp` section on `FINGERPRINT_COLLECTOR_JS` (error-stack
  side channel, prototype-Proxy `ownKeys` trap, console timing, passive pre-dispatch stall, crude
  automation controls, self-tests) plus a separate snapshot-excluded `CDP_TIMING_RAW_JS`. Both
  re-exported from `src/browser/index.ts`. **No `AXIS_SEVERITY` entry** — grading is #102's job.
- `scripts/measure-input-realism.mjs` (2397) — drives a local fixture through the **real MCP verb
  path** (real stdio launcher, real `PolicyEngine`, real egress filter, `/etc/hosts` mapping to a
  synthetic host so loopback stays blocked) with a page-script negative control that must separate
  before any verdict is reported.
- `scripts/measure-cdp-baseline.mjs` (3599) — four arms: A no-protocol, B our stack, C debugging
  port + attached client, B0 our driver minus the Fetch guard (diagnostic, never graded). Identical
  non-protocol measurement channel; A and C spawned from B's real `/proc` argv (34 switches
  observed, 31 cloned).
- `scripts/probe-evaluate-world.mjs` — settles isolated-vs-main world in two minutes. Exit 0 =
  isolated (safe), 1 = main world, 2 = probe could not run.
- `test/cdp-baseline.test.mjs` (1609), `test/fingerprint.test.mjs` +603. **978 unit tests green.**
- Findings: `docs/solutions/architecture-patterns/input-verbs-emit-no-keystrokes-and-three-untrusted-surfaces.md`,
  `.../cdp-detectability-baseline-three-way.md`,
  `docs/solutions/best-practices/a-test-whose-stub-guarantees-the-assertion-proves-nothing.md`.

**PR #126 (merged, `f72c1be`) — the pool under fleet concurrency (#122).**

- `scripts/measure-pool-under-load.mjs` (1850) — simultaneous burst at configurable
  over-subscription through three labelled paths: **R** `retrieve` over MCP (per-consumer
  *uncapped*), **D** `browser_open` over MCP (capped), **S** direct in-process acquire (the only
  path where `err.code`/`err.cause` survive). Two negative controls plus a blindness self-test.
- Finding: `docs/solutions/architecture-patterns/over-subscription-refuses-cleanly-it-does-not-fail-to-launch.md`.

**Filed from the consumer field report: 2 epics + 10 children (#114–#125).**
`#114` silent extraction loss (children #116, #117, #118, #119, #120) and `#115` illegible failure
under load (children #121–#125). Both epics lead with a ticket that can **kill the epic**.

**Durable rules landed in `CLAUDE.md`** (new "Gates and measurement" section): in-container only for
gates; the runtime gate is the only stage that runs real code against a real browser; verify guards
RED by construction; browser-side template literals take **no raw backtick** (broke the build twice);
quantized diffed leaves churn near ladder edges; measure rather than assert; snapshots carry the
egress IP.

## Decisions Made

- **#94 does NOT close verify-and-close** — its body predicted it would. All four input questions
  came back NOT-ACCEPTABLE. **#110 SHOULD OPEN**, scoped to the **fill body only** (`press("Enter")`
  already emits a real keystroke). Remedy is a driver-path change: Patchright ships
  `keyboard.type()` with a delay; `BrowserCore.type()` calls `loc.fill(text)`. One seam: `#act()`.
- **#92's "we are clean" applies to the protocol tells only.** B sits exactly on A on every
  protocol-presence probe, but is an outlier against **both** controls on request-dispatch stall.
  The B0 arm attributes it to the **driver pipe, not our Fetch guard** — so removing the guard would
  not fix it, and #92's non-goal is now backed by data. **#103 SHOULD OPEN**, scoped upstream.
- **#102 UNBLOCKED on three discrete probes only** (`consoleProxy.fired`, `.invocations`,
  `collector.cdp.consoleProxy.fired` — 0 vs 6, 0 vs exactly 100, reproduced in four runs).
  **Do NOT wire a stall threshold in any form.** See "What Didn't Work".
- **#124 (launch deadline) recommended for DEFERRAL, not closure.** The deadline never fired and its
  message is already distinct. Shortening it would convert slow-but-successful production launches
  into failures.
- **#115 re-scoped** away from error legibility and toward **resource pressure under real workloads**
  (memory, `/dev/shm`, PIDs, FDs) — the question left standing.
- **Quantized timing labels may REPORT a difference but may not CERTIFY the instrument works**
  unless a raw numeric measurement independently separates with headroom. Booleans and integer
  counts are exempt — discrete by nature, not quantized from a continuum. Now a rule in the harness.
- **No simplification pass.** I called the 9278-line diff "probably over-built"; the evidence
  refutes it — no duplicated helpers, no unused symbols, 38% "why" comments (repo convention), 2212
  lines of tests. A pass would be cosmetic churn on code that survived three adversarial rounds.
- **Ticket hygiene:** the field report named real people and adult-industry sites; the repo is
  public. Every one scrubbed to a functional description before filing. Verified with a
  word-bounded sweep (an earlier unbounded sweep false-positived on `p·roxy`).

## What Didn't Work

- **Three diagnoses of one incident, all from source reading, all wrong.** The consumer said pool
  exhaustion; I said the 120s launch deadline expiring under contention; then I said `CORE_LAUNCH`
  conflates three causes with one message. The measurement refuted all three: over-subscription
  produces **clean fast refusals** (0.21 ms in-process, <100 ms over MCP), `CORE_LAUNCH` conflates
  **two** causes, and **the deadline branch has always had its own distinct message**
  (`session-manager.ts:459-462`). The consumer quoted the *other* string, so their launches
  genuinely failed to start — they did not time out.
- **"Gate on the bucket, not the millisecond" — published, then overturned.** Runs 1–2 supported it;
  run 4 showed **configuration A itself** straddling the ladder edge. Across four runs the
  divergence is found every time and **no single probe finds it every time**. A quantized label is
  not more stable than the number under it; it is the same number with a discontinuity added.
  Corrected in the doc and in a #101 comment.
- **The native full-diff Codex review died twice** on 9278 lines (1.1 MB of exploration, no
  verdict). Scoped passes over `src/` worked. The measurement scripts got a later scoped pass.
- **Two P1 findings refuted empirically, not by argument** — both claimed a hostile page could swap
  the collector's console sinks or `Object.prototype`. `probe-evaluate-world.mjs` showed
  `marker: null`, both sinks `[native code]`, page counters never incremented. **Isolated world.**
- **Four shell mistakes that looked like success**, all the same shape: a `sed` `#` delimiter
  colliding with issue numbers (fed a reviewer a 1285-byte fragment for 216 KB of wasted work);
  zsh 1-indexed arrays (four tickets filed with wrong titles, one skipped); `$?` capturing `tail`
  instead of `docker`; an unbounded hygiene grep matching `p·roxy`. All caught and repaired.

## What's Next

1. **Decide the two open product calls.** (a) Do the untrusted `select`/set-value surfaces get their
   own ticket or fold into #110 with widened scope? Different defect, different fix — I'd separate.
   (b) Is #103 worth acting on at all? "We measured it, quantified it, and chose not to act" is
   legitimate, and #102 would lock that in place.
2. **#117 before anything else in #114** — prove the extraction loss is actually in extraction.
   `retrieve` extracts from the *rendered DOM*, not a fetched body, so a consent wall or JS-gated
   section produces an identical symptom upstream. **This ticket can close the epic.**
3. **Reply to the consumer project.** Their concurrency cap is not the fix they think it is; ask for
   verbatim error text next time rather than a recollection. Tell them the silent-strip finding was
   the most valuable thing in the report.
4. **#116 (the loss signal)** — highest value per unit of work in either new epic; prevents wrong
   answers rather than slow ones. Co-merges with #117.
5. **Resource pressure under real workloads** — the question #122 left standing and cannot reach.
6. **Pre-existing backlog, unchanged:** R2 apex-vs-www spelling; R5 fast-terminal; live-exercise of
   the untriggered F1/pxHint-only-403/F4 branches; the `atlas` test-consumer scrub (operator call).

## Gotchas & Watch-outs

- **⚠️ 30 open issues, 6 open epics.** Four came from studying another project; two from a real
  consumer being hurt. The latter should outrank the former. Consider closing or deferring before
  opening a seventh front.
- **⚠️ PR #126 did not get a cross-provider `dv:gauntlet` pass** — three Claude-side adversarial
  verifiers plus a fix round, no second provider. Measurement script, not production runtime, so
  risk read as low; flagged at merge.
- **Prod is UNCHANGED: `sha256:d55aa084` (git `47e414e`).** Nothing this session touched prod.
  Rollback anchor `sha256:4becdf0a`. Deploy: `gh workflow run deploy-http.yml -f image_tag=latest`.
- **The instruments have survived three review rounds. That makes them better, not right.** Nothing
  here tested a real anti-bot vendor. Every "acceptable" verdict means "no obvious tell on the axes
  we measure", never "undetectable".
- **`measure-input-realism` now judges per-character keystrokes + one bulk text insert as
  NOT-ACCEPTABLE** (`beforeinput=1 input=1` for 13 chars). That is a plausible way to implement
  #110 and it will fail. The bar is per-character *edits*, not just per-character *keystrokes* —
  documented in a #110 comment. Argue it before building, not after.
- **`retrieve` is per-consumer UNCAPPED** — measured, not inferred (`gateway/index.ts:75` acquires
  with no meta). One consumer can occupy the whole global pool with concurrent retrieves. The
  pool-sizing comment already says the spare slot is deadlock prevention and explicitly *not*
  headroom for concurrent retrieves (`config.ts:104-105`).
- **A gate on a console median is impossible on this browser.** Chrome coarsens `performance.now()`
  to ~100 µs; console calls cost far less than one tick, so every console median is structurally 0.
- **Browser-side script constants take NO raw backtick and no `${`** — including in comments, where
  a backtick used for emphasis closes the template literal. Broke the build twice today. A test now
  asserts it.
- **`#122`'s null result bounds to "not reproducible without proxy and remote cost", NOT "does not
  occur".** Its control proves the harness sees a *capacity refusal*, not a *launch failure* — that
  branch was exercised out-of-band with an injected failing factory, evidence beside the run.
- **Run `validate-*`/`measure-*` ONLY in-container.** `"${REPO}:latest"` in zsh (bare `$REPO:latest`
  hits the `:l` modifier). `gh pr merge --admin` is classifier-blocked — use plain squash.
- **Measurement JSON carries the egress IP** (`meta.egressIp`); `INPUT_REALISM_OUT` has no redaction
  at all. Check before pasting into a ticket, doc, or commit.
