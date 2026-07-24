---
title: Shape-invariant PerimeterX on the drive path — port retrieve's frame-copy arm, and why the aria tree misleads the test
date: 2026-07-24
category: docs/solutions/architecture-patterns
module: browser/patchright-core, verbs/drive
problem_type: architecture_pattern
component: block-detection
severity: medium
applies_when:
  - "Two verbs (retrieve/drive) classify the SAME block via a SHARED classifier but feed it different signal surfaces"
  - "A challenge renders in a cross-origin child frame while the top frame is FAT, so top-frame-only signals (page.content HTML, thin-body hard-block) miss it"
  - "You are writing an in-container test that a top-frame signal misses a challenge — beware the accessibility tree"
---

## Problem

The drive path classified the **same** PerimeterX press-&-hold 403 two ways depending on top-frame thinness.
A PX challenge renders as a widget (canvas/button) in a cross-origin `px-captcha-modal` **child frame**; when
the top frame is thin, `isHardBlock` (4xx/5xx + thin body) catches it, but when the top frame is FAT
(store/product modal chrome ≥200 chars) it slips through as a returnable snapshot. Retrieve already had the
shape-invariant arm (it scans child-frame HTML); drive never captured frame HTML — a fresh instance of the
standing **drive↔retrieve detection-parity** lesson (a shared classifier fed two different signal surfaces
drifts).

## Solution

Port retrieve's arm to drive. In `#snapshotOf`, gated on `pxHint`, derive a **scrubbed boolean**
`pxCopy = hasPerimeterXChallengeCopy(topHtml) || hasPerimeterXChallengeCopy(await captureChildFrameHtml(page))`
— the *same* child-frame walk retrieve uses — and carry `pxCopy` as a first-class `PageSnapshot` field
(**never** the raw frame HTML — the drive path is deliberately content-free). Add the `(pxHint && pxCopy)` arm
to `navFailed` (mirroring retrieve's `isRetrieveFailure` / `classifyBlock`), and plumb `pxCopy` through
`#signalOf` so `classifyFailure`/`wafVendorFromFailure` keep attributing `perimeterx`. Gate on `pxHint` so
ordinary pages with ad iframes never pay the child-frame walk. Do **NOT** add it to `shouldEscalateDrive` — a
behavioral challenge is IP-independent, so re-rolling the exit is useless.

## Key insight (the test trap)

> **Playwright's `ariaSnapshot` STITCHES cross-origin (OOPIF) child-frame *accessible text* into the top
> frame's tree.** Retrieve's `render.text` is top-frame innerText (excludes child frames); the drive
> snapshot's `tree` is the aria tree (includes them). So a fixture whose child-frame copy is *accessible
> text* fails to reproduce the gap on the drive path — the copy leaks into `snap.tree`, `isVisiblyBlocked`
> catches it, and `pxCopy` is not load-bearing.

To reproduce the real "aria/innerText detection misses it, but a frame-HTML source scan catches it" gap, the
in-container fixture must put the challenge copy in the child frame **source but not as accessible text** — a
canvas widget + the copy in an HTML comment. Then `hasPerimeterXChallengeCopy` (which scans raw
`frame.content()`) matches it, the aria tree does not, and the `pxCopy` arm is provably the load-bearing
reason (`navFailed({ ...snap, pxCopy: undefined }) === false`). This also mirrors reality: the real
press-&-hold is a canvas, not accessible prose.

## See also

- The standing parity lesson: [[drive-retrieve-detection-parity]].
- The child-frame capture primitive it reuses: `captureChildFrameHtml` (PR #25 P1,
  `scripts/validate-frame-capture.mjs`).
- [[self-inflicted-refusal-classify-dont-discard]] (the sibling R1/R2 work in the same epic).
