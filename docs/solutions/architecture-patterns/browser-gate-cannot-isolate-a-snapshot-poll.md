---
title: A full-render browser gate can't prove a snapshot-time poll is load-bearing — unit-test the poll logic instead
date: 2026-07-24
category: docs/solutions/architecture-patterns
module: browser/patchright-core, scripts/validate-frame-capture
problem_type: architecture_pattern
component: test-methodology
severity: medium
applies_when:
  - "You add a bounded retry/poll inside a snapshot/capture helper (e.g. captureChildFrameHtml's PX copy-poll)"
  - "You reach for a validate-*.mjs full-render() gate to prove the poll recovers a late signal"
  - "A fixture injects the signal after some delay to simulate a late-loading challenge"
---

## Problem

F2 of PR #87 added a bounded **poll** inside `captureChildFrameHtml` so a PerimeterX press-&-hold
whose iframe commits *after* DCL is still detected. The instinct was to prove it with the existing
`validate-frame-capture.mjs` gate: a fixture that attaches/injects the challenge copy ~400 ms late,
asserting `render.frameHtml` carries it.

**That gate can't prove the poll is load-bearing.** Two independent reasons, both found the hard way:

1. **`render()` has its own settle wait that dominates the poll.** Before it calls `snapshot()`,
   `render()` runs a clearance/settle wait (~1 s — a poll interval). By the time the *one-shot* read
   fires, a signal injected at ~400 ms has already landed. A one-shot read passes the gate too — verified
   by building a probe image with the poll reverted to `return readChildFrames(page)` and watching the
   "late-copy" leg **still PASS**. The thing under test (the poll's marginal re-read) is masked by an
   unrelated upstream wait the fixture doesn't control. There is no injection timing that makes *only* the
   poll succeed: land inside render's wait → one-shot passes; land after it → the poll misses too.

2. **A phrase in an inline `<script>` is serialized immediately.** `frame.content()` serializes the
   whole document including `<script>` text, and `hasPerimeterXChallengeCopy()` scans raw HTML without
   stripping scripts — so a fixture that builds the copy from a literal string in the script matches on
   read 0, before the timeout fires. (Codex caught this one.)

## Solution

**Move the load-bearing proof to a deterministic unit test; keep the browser gate as an integration
smoke.** Export the helper and drive it with a fake page whose child frame returns `blank → blank →
copy`, an instant `waitForTimeout`, and read/sleep counters (`test/px-frame-poll.test.mjs`):

- Assert it recovers the copy AND that it re-read (a one-shot returns blank).
- Assert early-exit (copy present → 1 read, 0 sleeps), the non-blank-but-copy-less case (don't exit early),
  the bound (copy never appears → stops after the cap), and the top-doc short-circuit (0 reads).
- **Verify the test itself is load-bearing**: temporarily revert the helper to a one-shot read and confirm
  the test FAILS (3/5 cases did). A gate/test that passes with the feature removed proves nothing.

Corollary for browser fixtures: when a fixture must inject a detected phrase *late*, source it so the
literal phrase is **absent from the initial serialized HTML** — e.g. `atob(base64)` that only materializes
in the DOM after the delay. Embedding it in a script string (even a delayed one) is detected on read 0.

## Why it generalizes

Any "prove a retry/poll works" test routed through a heavyweight caller (`render()`, a settle loop, a
navigation) is fragile: the caller's own waits dominate the timing you're trying to isolate. Unit-test the
poll's *logic* against a fake dependency where you control every read and every tick; reserve the real
browser for the thing only it can prove (here: cross-origin `frame.content()` capture actually works).

See also [[drive-retrieve-shape-invariant-pxcopy]] (the pxCopy surface this polls) and the harness memory
`render-gate-cannot-isolate-a-poll`.
