---
title: A test whose stub guarantees the assertion proves nothing — three ways it happened in one change
date: 2026-08-05
category: docs/solutions/best-practices
module: browser/fingerprint, test/fingerprint.test.mjs, scripts/measure-input-realism
problem_type: best_practice
component: test-methodology
severity: high
applies_when:
  - "You are writing a unit test for browser-side code against hand-built global stubs"
  - "You are writing a guard, gate, or probe whose job is to be able to report bad news"
  - "A test is green and you are about to treat that as evidence the behaviour holds"
---

## Problem

Across one change that added measurement probes, **seven defects were found. Three of them were in
the very code written to prevent that class of defect** — the tests and controls. Each was green.
Each proved nothing. None of them would have been caught by reading the test, because each one
*looks* correct; the flaw is in the stub or the fixture the test runs against.

This is the highest-value pattern from that work, and it generalizes well beyond it.

## The three instances

### 1. The stub returned an entry for any name, so a broken read passed

`CDP_TIMING_RAW_JS` fetched a URL, then immediately read its Resource Timing entry with
`performance.getEntriesByName(url)`. That entry is not queued until `responseEnd`, and the probe
awaits response *headers* and then cancels the body — so in a real browser the entry did not exist
yet. It recovered rows in **0 of 24** in-container captures.

The unit test asserted `stallMs.length === 20` and passed every time, because the stub's
`getEntriesByName` returned a fabricated entry for whatever name it was handed. The stub could not
express "the entry is not there yet", so the test could not fail.

**The fix that matters is not the probe, it is the stub.** `getEntriesByName` now returns nothing —
what the browser actually does at that moment — so only the corrected by-type harvest passes.

### 2. The clock advanced by a fixed step, so the value under test was constant

A ratio was quantized into labels, and a test asserted two captures of an unchanged environment
produce no diff. It passed. It could not have failed: the stub clock advanced by a fixed amount on
every read, so both inputs to the ratio were always equal and the label was constant by
construction.

The real browser coarsens its clock to ~100 µs and the measurement is far below one tick, so the
two inputs land on 0 or one tick essentially at random — three different labels from one unchanged
environment.

**Test the regime the code actually runs in.** The stub now models coarsening, and the step value is
pinned in a comment with the arithmetic, because a "tidier" number silently makes the test
decorative again.

### 3. The negative control could not distinguish the channel it claimed to validate

An instrument compared real input against page-script fakery and reported which axes separated. One
axis was raw key-event count. The synthetic path emits `3 × (len + 1)` events; a per-character real
path emits `3 × len + 3`. **Those are equal.** The axis could never separate, so the control silently
validated only the mouse channel while appearing to validate the keyboard.

**The fix was to separate on a property the control cannot fake** — event trustedness, which page
script structurally cannot forge — rather than on a count that happens to collide.

## The rule

**A test is evidence only to the extent its fixture can express the failure.** Before trusting a
green assertion, ask the question that actually decides it:

> *Construct the input that makes the production code wrong. Can the fixture even represent it?*

If the stub cannot represent the failure, the test is documentation, not verification.

Three cheap habits that catch this:

1. **Verify the test red.** Break the production code deliberately, watch the test fail, restore.
   Every non-trivial guard in this repo should have been observed failing once. The churn test in
   `test/fingerprint.test.mjs` was verified red against the pre-fix ladder before it was kept — and
   an earlier draft of it *would have passed either way*, which is exactly how the habit paid.
2. **Make the stub model the awkward truth, not the convenient one.** An entry that is not there
   yet, a clock that does not resolve, a value at a boundary. A stub built for the happy path tests
   the happy path.
3. **Run it against the real thing.** Two of the three above were only visible in-container. A
   green unit-test run asserted a no-churn property while the real browser churned one capture pair
   in five. **The runtime gate is not a formality; it is the only stage that ran the actual code
   against the actual browser.**

## Related

The same session produced a fourth instance in a different shape — an assertion that searched the
whole collector for `fetch(` and concluded "this issues no requests of its own", while the
pre-existing WebRTC probe opens a STUN connection on every capture. Certifying a broad invariant by
searching for one function name is the same failure: the check cannot see the thing it claims to
rule out. The claim is now scoped to the section it is true of, checks seven request primitives, and
names the exception explicitly. See
[the CDP baseline write-up](../architecture-patterns/cdp-detectability-baseline-three-way.md).
