---
title: We are invisible on the protocol tells and loud on request latency — the three-way CDP baseline
date: 2026-08-05
category: docs/solutions/architecture-patterns
module: browser/fingerprint, browser/patchright-core, scripts/measure-cdp-baseline
problem_type: architecture_pattern
component: stealth-measurement
severity: medium
applies_when:
  - "You are about to claim the driver hides our automation surface"
  - "You are writing a stealth gate and need a threshold that means something"
  - "You are tempted to compare our stack against one control instead of two"
---

## Problem

The gateway's stealth posture rested on a vendor claim: the driver patches the well-known
automation tells. Nothing in `validate-stealth` asked whether a debugging protocol is observably
attached — it measures whether challenges clear, not whether the automation surface is detectable.

And our own architecture adds protocol surface on top of the driver's. `#installFetchGuard` opens a
browser-level CDP session, enables `Fetch` with `urlPattern: "*"`, and turns on
`Target.setAutoAttach`. Every request in every frame pauses through it.

Issue #101 measured it.

## Method, and why the shape matters

**Four configurations, not two.** A two-way "us vs a clean browser" comparison cannot tell
"automation looks like this" from "*our* automation looks like this".

| Arm | What it is |
|---|---|
| **A** | Chrome launched directly, no driver, no CDP consumer, no debugging port. The floor. |
| **B** | Our actual stack: driver attached, `Fetch.enable` `urlPattern:"*"`, `Target.setAutoAttach`. |
| **C** | Chrome with `--remote-debugging-port` and a raw protocol client attached calling `Runtime.enable`. The ceiling. |
| **B0** | Our driver with the Fetch guard **removed** — diagnostic only, never graded. Attribution. |

**The measurement channel is identical in all four.** The probe result leaves the page by POSTing to
the fixture server, never through the protocol — otherwise measuring A would destroy the property A
exists to represent.

**Launch-arg parity is measured, not constructed.** A and C are spawned from configuration B's
*real* argv, read from `/proc/<pid>/cmdline`: 34 switches observed, 31 cloned verbatim. What remains
irreducible is that B talks over `--remote-debugging-pipe` and A talks over nothing — that
difference *is* the experiment.

Six rounds, A/B/C rotated within each round so position effects spread evenly; B0 runs last, outside
the rotation, precisely so it cannot bias the graded arms.

## Validity first — the check that makes everything else meaningful

A probe suite that cannot detect blatant automation cannot certify our stack. So the positive
control had to separate from the negative control before any result was read:

- `consoleProxy.fired` — **A 0/6, C 6/6**
- `consoleProxy.invocations` — **A 0, C 100** (an exact integer, reproduced every round)
- C genuinely attached: **1452 `Runtime.consoleAPICalled`** events observed across its captures.

Both validators are a boolean and a count — immune to clock coarsening and scheduling noise. The
suite is validated, so **#102 is UNBLOCKED**.

Just as important, the instrument **refused** several comparisons rather than inventing them.
Chrome coarsens `performance.now()` to ~100 µs and a console call costs far less than one tick, so
every console *median* is structurally 0. Those probes report `resolution-limited`, which is not the
same as "no difference": `console.proxyP50Ms`, `harness.stallWarmP50Ms` and
`collector.cdp.consoleTiming.ratioBucket` were all barred from validating anything. **A gate on a
console median is not possible on this browser.**

## Finding 1 — on protocol presence, we are indistinguishable from an undriven browser

On every protocol-presence probe that discriminated the controls, **B sits exactly on A**
(`t = 0.00` on the A→C axis):

| Probe | A | B | C |
|---|---|---|---|
| `consoleProxy.fired` | 0/6 | **0/6** | 6/6 |
| `consoleProxy.invocations` | 0 | **0** | 100 |
| `collector.cdp.consoleProxy.fired` | 0/6 | **0/6** | 6/6 |

Crude automation controls are clean too: `webdriver` 0/6, `cdcKeys` 0, `playwrightKeys` 0,
`puppeteerKeys` 0, `nativeToStringIntact` 6/6 — in every arm including C, which is the reminder that
those probes are about WebDriver, not about CDP attachment.

The driver's central claim holds where it was tested.

## Finding 2 — and it is the headline — we are an outlier on request-dispatch latency

Our stack is separated from **both** controls on two protocol-family probes:

| Probe | A | B | C | B vs A |
|---|---|---|---|---|
| `harness.stallWarmMeanMs` | 0.505 ms | **3.263 ms** | 0.508 ms | **6.5×**, 32.7 noise widths |
| `collector.cdp.resourceTiming.stallMedianBucket` | `{lt1}` | **`{1to4}`** | `{lt1}` | disjoint labels |

`stall` is `requestStart − fetchStart` — the pre-dispatch window, measured inside the browser before
the network starts, which is exactly where a paused-and-continued request lands.

**A and C agree with each other.** An attached protocol client, by itself, does not inflate request
dispatch. This is a signature specific to what we ship, and **no A-vs-C comparison could ever have
found it** — which is the entire argument for building the third arm.

The second row matters operationally: it is the leaf the *shipped* collector reads, passively,
without issuing traffic of its own. A #102 gate written against a snapshot would see it.

## Finding 3 — it is the driver pipe, not our Fetch guard

This is what the B0 arm was for, and it inverted the obvious guess.

`harness.stallWarmMeanMs`: **A 0.505 → B0 2.518 → B 3.263 ms.** B0 — our driver with the Fetch guard
removed — *also* separates from A. The signal survives removing the guard, so it belongs to the
driver pipe and session, not to our interception. Our guard adds roughly a further 25% on top of an
inflation that is already ~5× the floor.

Two consequences:

- **Removing the Fetch guard would not fix this**, so the epic's non-goal ("it stays regardless of
  what the probes find") is now backed by data rather than asserted.
- Any mitigation work is aimed **upstream at the driver's request path**, not at our policy hook.

## Two runs, and what the second one taught

The report refuses to let one run become a threshold, so it was run twice on the same host.

Stable across both runs — identical values, identical verdicts:

| Probe | A | B | C |
|---|---|---|---|
| `consoleProxy.fired` | 0/6 | 0/6 | 6/6 |
| `consoleProxy.invocations` | 0 | 0 | 100 |
| `collector.cdp.consoleProxy.fired` | 0/6 | 0/6 | 6/6 |
| `collector.cdp.resourceTiming.stallMedianBucket` | `{lt1}` | `{1to4}` | `{lt1}` — **B-OUTLIER both runs** |

Not stable — the verdict flipped between the two runs:

| Probe | run 1 | run 2 |
|---|---|---|
| `harness.stallWarmMeanMs` | B-OUTLIER | INDETERMINATE |
| `harness.stallWarmP50Ms` | INDETERMINATE | B-OUTLIER |

**The underlying measurement did not move** — B read 2.90/3.26 ms and 2.90/3.15 ms against A's
0.50/0.505 ms and 0.45/0.479 ms. What moved is which raw-millisecond *variant* cleared the
separation bar, because A's own noise band sits right at the probe's resolution floor and crossed it
in one run and not the other.

The lesson generalizes: **the quantized label probe carried the finding stably; the raw millisecond
probes did not.** Hand #102 the bucket leaf. A millisecond threshold here would be a gate whose
colour depends on which side of a 0.05 ms floor the control's noise happened to land — i.e. a flaky
stealth gate, which gets disabled, which is worse than not having one.

## Resolution

- **#102 UNBLOCKED.** Three probes offer a usable threshold: `consoleProxy.fired`,
  `consoleProxy.invocations`, `collector.cdp.consoleProxy.fired`. A fourth,
  `collector.cdp.resourceTiming.stallMedianBucket` ∈ `{lt1}`, **fails the current stack by design** —
  it is the divergence to close, not a baseline we hold. Wire it knowingly or not at all; a red gate
  nobody intends to fix gets disabled. Do **not** wire a raw-millisecond stall threshold: see above.
- **#103 (conditional mitigation) SHOULD OPEN.** The baseline found separation, which is its stated
  trigger. Scope it to the driver's request path.
- **#92 does not close verify-and-close.** Its "we are clean" branch applies to the protocol tells
  only.

## Gotchas

- **Do not gate on a console median.** Structurally 0 on this browser. Only means and p90s carry
  information, and even those sit close enough to the clock that the report refuses them.
- **`resolution-limited` ≠ "no difference".** The report separates the two deliberately. A probe
  that could not be evaluated must never count as evidence of cleanliness.
- **Every `floor` constant in the script is PROVISIONAL** — measured on a macOS/headless/
  constructed-args smoke run of n=2–3. Any threshold whose margin would be counted in widths of one
  is refused rather than softened.
- **One run on one host is not a threshold.** The report says so itself. Re-run before writing a
  number into #102.
- **`fetch.wallP50Ms` looks like a great signal and is not one.** It is harness-family: the fixture
  server, the Fetch guard's client side and the raw CDP client all share this Node event loop, so
  each arm's end-to-end latency carries its own harness load. It is tagged
  `<-- NOT a protocol-presence signal` in the output for exactly this reason.
- **`harness.stallColdP50Ms` is context-family and barred from the gate** — cold-connection numbers
  are dominated by browser age at probe time, which differs by arm by construction. The warm-up
  brought the arms within 1.12× of each other; the age line is printed next to the number so a
  reader can judge it.
- **An incidental fingerprint divergence turned up**: A reports a 1920×1080 screen and B reports
  1280×720 — the driver sets a viewport. Out of scope here, but it is a real A-vs-B difference on a
  graded fingerprint axis.
- **The raw probe had a bug this run found.** `CDP_TIMING_RAW_JS` read `getEntriesByName()`
  immediately after awaiting response *headers*, but a `PerformanceResourceTiming` entry is not
  queued until `responseEnd` — it recovered rows in **0 of 24** captures while the harness's own
  post-run read of the same requests recovered them every time. Fixed by harvesting once after the
  loop via `getEntriesByType('resource')`. The unit test could not see it because the stub returned
  an entry for any name; the stub now returns nothing, so only the by-type path passes.
