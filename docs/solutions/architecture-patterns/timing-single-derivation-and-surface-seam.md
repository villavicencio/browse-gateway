---
title: Per-stage timing — one derivation, surface-seam attach, wall-clock stages, and where measurement can't reach
date: 2026-07-21
category: docs/solutions/architecture-patterns
module: observability/failure-diagnostics
problem_type: architecture_pattern
component: observability
severity: medium
applies_when:
  - "Adding a measured/derived field that must ride BOTH a normal result AND a failure envelope"
  - "The acceptance criteria say a field is present on success AND failure, but the failure envelope is failure-only"
  - "A pre-declared envelope slot's placeholder type can't hold the real value (Record<string,number> vs an array)"
  - "You're measuring stage durations across a browser-automation path with retries, queues, and locator auto-waits"
---

# Per-stage timing (#42) — the load-bearing decisions

Adding `Timing` (totalMs + domContentLoaded/clearancePoll/captchaSolve/snapshot) to retrieve/drive and the #39
failure envelope. The value was less in the plumbing than in the decisions the 5-lens pre-code critique + a
4-round Claude↔Codex loop forced. Reusable patterns:

## 1. One derivation, referenced twice — never two clocks for "the same" number
The AC wanted timing on the result AND (for a slow *block*) in the failure envelope. The trap: assembling
`totalMs = now()-t0` once for the result and again for the envelope → two totals that differ by the gap between
the reads. Fix: assemble **one** `Timing` at the verb seam, set `result.timing = it` and fold the *same object*
into the redacted envelope. `result.timing` then deep-equals `result.diagnostics.timing` by construction — a
test locks it. Same lesson as the #40/#41 "one reason" invariant: derive once, project everywhere.

## 2. Attach at the surface seam (like #40/#41), not by widening the builder
`buildFailureDiagnostics` stays untouched; timing folds in at the redaction seam (`retrieve.ts` /
drive `#failure`) exactly like `wafVendor`/`failureClass`. The #39 JSDoc *aspires* to a "widened input"
path, but the actual code precedent is the surface seam — follow the precedent, and the slot-discipline test
("buildFailureDiagnostics leaves every downstream slot unset") stays green for free.

## 3. Present on success too ⇒ a first-class field, not just the failure-only envelope
The failure envelope is failure-only; an AC of "every result carries timing" means a first-class
`RenderResult.timing`/`PageSnapshot.timing`/`RetrieveResult.timing` field, *plus* a folded copy in the failure
envelope. Making the result fields `optional` (except the always-assembled `RetrieveResult.timing`) avoided
churning every `renderOf(...)` test fixture.

## 4. A per-attempt array belongs next to the attempt COUNT, not in the scalar breakdown
The pre-declared slot was `Record<string,number>`, which literally can't hold `perAttempt: number[]`. Rather
than reshape the envelope, per-attempt durations went onto `EscalationDiagnostics.attemptMs`, 1:1 with the
existing `attempts` count — self-describing (it IS the proxied-attempt tally), surfaced for free on both paths
(already JSON-dumped), and it keeps `Timing` all-scalar so redaction pass-through is trivially safe.

## 5. Measurement HAS to be wall-clock, and the risky stages don't exist where you need them
The original design proposed dns/connect/ttfb via `resp.request().timing()`. The critique killed it:
binding the goto Response to read it *throws on an aborted challenge nav* (undefined resp) and can destroy the
#39 envelope; and DNS/connect are `-1` on exactly the proxied/redirect paths that dominate the 160–220s budget
(DNS resolves at the proxy; a reused connection reports -1). **Dropped them.** The 200s lives entirely in
`performance.now()` wall-clock stages (clearancePoll, per-attempt, captchaSolve, nav) — measure those.

- `clearancePollMs` is the **wall-clock of the poll loop**, not the sleep-interval counter (`waited`): each
  `pollSignal` round-trip costs real time in the capped container, so a "15s" loop can take materially longer.
  Keep the old `clearanceWaitedMs` counter too — the stealth **kill-gate reads it** (a "zero readers" claim
  that ignores `scripts/` is how you almost delete a load-bearing field).
- `snapshotMs` must span the opt-in failure-screenshot capture (a 10s timeout) or `totalMs` gets a 10s
  unattributed gap.
- A verb's `totalMs` must be captured **before** the serialization queue (`#serialize`), or a queued call's
  total excludes minutes of queue latency. On a **failure** the thrown envelope's `totalMs` must be
  overridden with the whole-verb elapsed, or it reports the last core-nav only and contradicts `attemptMs`.

## 6. Where measurement genuinely can't reach — document, don't fake
- A **drive ACTION** that submits a form: the Patchright *locator auto-waits* the synchronous nav *inside*
  `loc.click()`, so a post-action `#settle` `waitForLoadState` is already satisfied (~0ms). The nav time lands
  in the verb `totalMs`; `domContentLoadedMs` on an action captures only a *deferred* (post-resolve) nav.
- **Direct-attempt** stage timing after escalation: the surfaced stages are the final proxied render's;
  the direct attempt's duration is `totalMs − sum(attemptMs) − extraction`, not a separate stage.
- **Drive success-after-retries**: a bare `PageSnapshot` has no escalation-diagnostics channel (a pre-#42
  asymmetry vs retrieve's result-level `proxyDiagnostic`), so per-attempt durations surface only on the
  failure `EscalationError`. These are **diagnostic labels that never gate behavior** — a less-precise number
  misleads a reader, nothing more — so the right move at the margin is a code comment, not fragile machinery.

## Process note
The Codex loop converged P1→0 over 4 rounds: r1 caught a **real P1** (an in-container validator asserting
`diagnostics.timing === undefined`, which the feature deterministically breaks) plus substantive P2s; r2/r3
were accuracy refinements; the tail was marginal-precision on a diagnostic field. Stop at that line (as #40/#41
did) — fix the trivially-correct, document the inherent limits, present.
