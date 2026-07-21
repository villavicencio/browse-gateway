---
title: Derive a caller-facing label as a projection of the single-source-of-truth classifier, not a parallel one
date: 2026-07-21
category: docs/solutions/architecture-patterns
module: verbs/retrieve
problem_type: architecture_pattern
component: classification
severity: medium
applies_when:
  - "A ticket asks to surface a new label (vendor, class, kind) alongside an existing classifier's output"
  - "You are tempted to write a second function that classifies the same signal a different way"
  - "You are detecting an 'active DOM widget' from an HTML string with regex"
related_components:
  - observability
  - browser-core
tags: [classification, vendor-attribution, captcha, detection, parity, codex-review, waf]
---

# Derive a caller-facing label as a projection of the single-source-of-truth classifier, not a parallel one

## Context

Issue #40 surfaced a `wafVendor` label (cloudflare / perimeterx / datadome / a captcha kind) on the #39
failure envelope, and added a `datadome-challenge` branch to `classifyBlock`. Two design lessons came
out of it — one from the pre-code critique panel, one from an 8-round Codex adversarial-review loop —
that generalize to any "surface a new label next to an existing verdict" ticket in this repo.

## Lesson 1 — a label that must agree with a verdict should be a PROJECTION of it, not a second classifier

The first design had a standalone `wafVendorOf({cf, px, dd, captchaKind})` with its own precedence. All
four critique-panel lenses independently flagged the same flaw: its ordering *contradicted*
`classifyBlock`'s (the code's self-described "single source of truth for vendor attribution"). A page
tripping overlapping markers could ship `reason='cf-challenge'` with `wafVendor='datadome'` in the SAME
envelope — and a drive-vs-retrieve parity test can't catch it (both paths agree with each other while
both disagree with `reason`).

The fix collapsed the design: **`wafVendor` is a pure projection of the already-computed `BlockReason`**
(`wafVendorFromReason(reason, captchaKind)` — `cf-challenge → cloudflare`, `datadome-challenge →
datadome`, `captcha → the kind`, everything else → `undefined`). Now the two are *structurally* unable
to disagree, not merely tested to usually-agree. When retrieve and drive both need it, share ONE
`resolveBlockReason(signal)` so the reason itself can't drift between paths either.

Corollaries that fell out of the same principle:
- **Consistency is transitive.** The escalation-diagnostics reason (`escalationDiagnostics` → `classifyBlock`)
  had to switch to `resolveBlockReason` too, or one `EscalationError` carries a `captcha` failure vendor
  next to a `hard-block` escalation reason. Thread the discriminating input (captcha kind, `ddHint`) onto
  the *shared signal* so every consumer of that signal resolves identically.
- **Absence is the empty state.** `wafVendorFromReason` returns `undefined` (not a `none`/`unknown`
  sentinel) when unattributable — which keeps the load-bearing #39 gate green (a failed nav must fabricate
  no vendor) and avoids a three-way none/unknown/undefined split.
- **A closed vocabulary must be a TYPE, not a `string`.** The envelope slot passes `wafVendor` through
  redaction untouched; that is safe *only* because the value can never be page-derived free text. Define
  the union in the lowest layer that all producers can import (here: observability) and type the slot to
  it, so the safety invariant is enforced by the compiler, not a comment.

## Lesson 2 — "is this an ACTIVE DOM widget?" is not a regex question; use rendered evidence, and know when to stop

`classifyBlock`'s original CAPTCHA signal (`detectCaptcha`) matched a *loaded library*
(`recaptcha/api.js`, `grecaptcha`) as readily as a placed widget. Surfacing that as a *vendor* made the
imprecision visible, and Codex walked it down through six rounds of ever-more-marginal regex holes:

| Round | The false signal | Why the obvious regex failed |
|---|---|---|
| r2 | loaded library overrides a real WAF | fixed by WAF-first precedence, not by the regex |
| r3 | library-load on a generic/unknown block | required "active widget" evidence |
| r4 | `detectCaptcha` pairs the first `data-sitekey` with any kind | kind must be bound to its own widget |
| r5 | `\bg-recaptcha\b` matches `g-recaptcha-wrapper` | `\b` treats a hyphen as a boundary |
| r6 | a widget in a comment / `<template>` / `<script>` | raw-text substrings aren't live DOM |
| r7 | `class="g-recaptcha:disabled"`, `data-config="data-sitekey"` | token/attribute boundaries, not `\b` |
| r8 | `data-name="…-response"`, `data-src="…"` | `\b` after a hyphen matches a `data-*` suffix |

Two structural takeaways instead of one-more-regex:
1. **Key on the signal that only exists when the thing is REAL.** An active/rendered captcha shows a
   container(class-token + a real `data-sitekey=` attribute), a rendered iframe (`recaptcha/api2/anchor`,
   distinct from the `api.js` library URL), or a `<kind>-response` field — none of which a mere `<script
   src=…api.js>` produces. That single reframing (`activeCaptchaKind`, browser/captcha.ts) closed r3
   (library-only), r4 (cross-label), and r7's under-detection (explicit `grecaptcha.render` widgets that
   have no standard container) at once, where chasing the class substring could not.
2. **A regex layer cannot verify "a live element"; bound it and say so.** `detect.ts` matches HTML
   strings by design (vendor scripts persist after a challenge clears — matching raw HTML false-positived
   real pages during U1). Strip the inert contexts you *can* (comments, `<script>`/`<style>`/`<template>`/
   `<noscript>`), require *real* attributes (`(?<![-\w])name|id|src` — reject `data-*` suffixes; class
   token delimited by quote/space — reject compound/pseudo classes), and accept that perfect
   active-element detection is a DOM-parse concern the whole layer forgoes. For a diagnostic *label*
   (never a behavior/security decision), robust-best-effort is the right altitude.

## When to stop the review loop

The empty-shell case (a 200 challenge with `reason=null` that fails only via the empty-markdown arm)
was flagged 4×. It was declined every time and routed to #41, because fixing it means folding new
*detection* into the `blocked` DECISION — which would false-positive real pages carrying an incidental
captcha widget, the exact class `detect.ts` avoids. A reviewer that keeps re-raising an out-of-scope
change is a legitimate stop-and-present trigger: fix every in-scope finding, document the scoped-out
ones against the ticket that owns them, and let the operator decide ship-vs-expand. "Drive to approve"
yields to "verify, don't blind-accept" when `approve` is only reachable by scope-creep.

## See also
- PR #57; issues #41 (empty-shell failure class), #44 (Turnstile solver-eligibility granularity).
- `docs/solutions/best-practices/redact-before-serialize.md` — the closed-vocabulary-slot safety it relies on.
