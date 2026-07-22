---
title: A derived-evidence signal that can occur on a SUCCESS needs a success-shaped carrier, not just the failure envelope
date: 2026-07-22
category: docs/solutions/architecture-patterns
module: verbs/retrieve
problem_type: architecture_pattern
component: classification
severity: medium
applies_when:
  - "A ticket adds a new derived signal (like #48 home-fallback) that a pre-wired FailureDiagnostics slot was reserved for"
  - "The condition the signal describes can occur on a result that isRetrieveFailure() classifies as SUCCESS"
  - "You are tempted to make the signal a FailureClass, or to widen the failure-envelope build to fire on success"
related_components:
  - observability
  - mcp
---

## Problem

Issue #48 asks for a **silent home-fallback** signal: a deep link (non-root path / query) that silently
lands on the site's bare root, so the homepage — not the requested page — is handed back. The `#39`
author pre-wired a `FailureDiagnostics.homeFallback?: boolean` slot for it, which reads like an
instruction to just populate that slot.

But the failure envelope is built **only** `if (failed && render.diagnostics)` and is documented as
*absent on a successful retrieve, so the success shape is unchanged*. A home-fallback splits across **two
result shapes**:

- **Thin / app-shell fallback** (deep link → home that extracts to ~nothing) → `isRetrieveFailure()` is
  true → the envelope exists → the pre-declared slot surfaces it. This is AC#1's literal "bare zero-result".
- **Fat-homepage fallback** (deep link → real homepage content, 200, non-empty markdown) → a **SUCCESS
  shape** → no envelope is built → the reserved slot **never surfaces on the exact case #48 also targets**
  (the ticket's "app shell with no selected store").

A pre-declared slot on a failure-only envelope silently under-covers a signal whose triggering condition
is often a success.

## What did NOT work

- **Making home-fallback a `FailureClass`.** `burned-exit` (#45) is allowed to be a class *value* only
  because it REFINES an existing failure (`nav-failed`) reached via the same dead-nav path — there was
  already a failure to refine. A home-fallback on a fat homepage has NO underlying failure to refine (the
  call succeeded); forcing it to be a class would flip a returnable success into a failure and, on the
  mixed thin case, compete with `empty-shell`/`real-zero-results` for the one reason slot — breaking the
  #40 one-reason invariant.
- **Widening the envelope build to `(failed || homeFallback)`.** This makes a *successful* retrieve carry
  a failure-evidence envelope for the first time, contradicting the "success shape is unchanged" invariant.

## The pattern

Treat it as **orthogonal derived EVIDENCE** (mirror burned-exit's `EscalationDiagnostics.burnedExit` half,
skip its `FailureClass` half), and give the evidence a carrier on **each shape it can occur on**, all from
**one shared pure predicate** so the surfaces can't drift:

- Pure predicate `isHomeFallback(requestedUrl, finalUrl)` beside `isDeadExit` — positive-signal-only
  (same-host, requested depth actually LOST: deep path collapsed to root, or a query-only deep link whose
  keys didn't survive), computed on the **RAW** urls *before* redaction collapses the path.
- **retrieve** surfaces a **top-level `RetrieveResult.homeFallback`** (carries the SUCCESS shape) **and**
  folds the same boolean into the failure envelope when one is built (co-located with the other failure
  evidence). One derivation → the two can't disagree.
- **MCP success** surfaces it via `structuredContent` (the MCP-native metadata channel), keeping the
  returned markdown byte-for-byte pure — do NOT inject gateway chrome into page content.
- **drive** ANNOTATES the returned snapshot (`PageSnapshot.homeFallback`) at the `navigate()` seam and
  **returns** — a homepage is a legitimately returnable snapshot, never a drive failure. Shared detector,
  **differentiated disposition** (retrieve surfaces an outcome flag; drive annotates and returns). This is
  the same allowed asymmetry the content-family classes already have, and it does not violate the
  detection-parity invariant (which is about detection not drifting, not disposition).

## Lesson

A reserved slot on a failure-only envelope tells you the *shape of the value*, not the *set of result
shapes it can occur on*. Before populating it, ask "can the condition this describes be TRUE on a success?"
If yes, the failure envelope is a necessary-but-insufficient carrier — add a success-shaped surface too,
and derive every surface from one predicate. A boolean is safe to pass through redaction untouched (it can
never be page-derived free text), which is exactly why it can ride multiple surfaces cheaply.

Deferred (documented, not built): the location-context primitive (postal/store pre-seed — operator HOLD),
www↔apex host normalization, hash-router (`/#/deep`) fallbacks, and the drive-failure envelope slot (a
home page that also nav-fails is a rare corner where the block/nav class is the real story).
