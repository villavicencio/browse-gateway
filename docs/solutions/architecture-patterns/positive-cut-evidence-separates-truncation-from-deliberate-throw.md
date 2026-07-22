---
title: A success verdict built from absence-of-failure needs POSITIVE cut evidence, or a truncated op counterfeits success
date: 2026-07-22
category: docs/solutions/architecture-patterns
module: browser/patchright-core
problem_type: architecture_pattern
component: navigation
severity: high
applies_when:
  - "A success verdict is derived from the ABSENCE of failure signals (status present, no block phrase, not thin-4xx) rather than a positive completion receipt"
  - "The operation can be cut mid-flight by a timeout/deadline AFTER a partial signal (headers) already landed"
  - "A DELIBERATE-throw path exists (CF clearance relies on goto throwing then settling), so 'the op threw' can never be the failure signal"
tags: [timeout, truncation, navigation, cloudflare, deadline, drive]
---

## Problem (#66, a #45 r11 residual)

Drive `navigate()`'s success verdict (`navFailed`) was pure absence-of-failure: status non-null,
no visible block, not chrome-error, not thin-4xx. A budget/nav-timeout-clamped `goto` whose
response **headers arrive before DCL** throws while the persistent response listener pins
`status=200`; the partially-rendered page passes every arm and the controller **pins it as a
successful navigation**. The naive fix — "goto threw ⇒ failed" — is forbidden: CF clearance
*deliberately* relies on goto throwing, then `#settle` polling the challenge reload to a fat 200.

## Solution shape

Carry **positive cut evidence** through the pipeline, then derive the failure flag as
*evidence AND no real content AND no richer failure*:

1. **Collect each cut receipt where it happens** (they are invisible later): a `TimeoutError`
   goto throw; a swallowed `waitForLoadState` **timeout** (the only residue a non-timeout goto
   abort leaves when a committed document never reaches DCL — codex r1); a clearance poll broken
   by the budget deadline. Discriminate `err.name === "TimeoutError"` — a page-close/frame-detach
   rejection is a session failure with its own story, not a truncation (codex r2).
2. **Derive on the FINAL snapshot**, so content that finished landing during settle/snapshot
   exempts the nav (late-landing success stays success).
3. **Gate on `thin AND !visiblyBlocked`**: substantial content ⇒ success even after a timed-out
   goto (the cleared-CF constraint); a visible interstitial already fails with a *richer* class
   (anti-bot + vendor) that a bare `timeout` must not override.
4. Downstream, the flag is a **snapshot-level timeout verdict below the loop-level verdicts**
   (budget-exhausted, burned-exit) at the classification seam, and each surface path gets a
   truncation-specific message (warm path: NOT the re-capture remediation — wrong fix for a slow nav).

## Why this generalizes

Any "success = nothing looked wrong" verdict over an interruptible pipeline has this hole: the
interrupt can land between the partial signal that satisfies the verdict and the completion that
would have justified it. The repair is never "treat interruption as failure" when deliberate
interruptions exist — it is positive interrupt receipts + a final-state content check + richer-
failure precedence.

## Interlock worth remembering

The same PR wired the #67 response receipt into drive snapshots — and the two compose: a
truncated-but-responded proxied attempt is a LIVE response (`isDeadExit` false via the receipt),
so escalation retries it as a site/timeout story instead of mislabeling the pool `burned-exit`.

## References

- PR #71 (`e6fb131`), issue #66, epic #38. Codex loop: r1 DCL-wait cut, r2 TimeoutError-only, r3 clean.
- Constraint provenance: #45 r10 (status stays null on goto-timeout), #48/#67 evidence-not-class doctrine.
