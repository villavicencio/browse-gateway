---
title: A self-inflicted refusal is a scope decision to surface, not an exit-death to recover from
date: 2026-07-24
category: docs/solutions/architecture-patterns
module: mcp/drive-controller, policy, browser/patchright-core
problem_type: architecture_pattern
component: session-lifecycle
severity: high
applies_when:
  - "A stateful session controller enforces its OWN policy below the verb layer (a nav guard, an allowlist/owner-host clamp) that aborts a request the caller made"
  - "The failure-handling path treats ANY failed navigation as 'the committed exit/IP went bad' and tears the session down"
  - "The teardown discards live, expensive state (a warm login, a WAF clearance token) and the operator message is then chosen from config, not from the evidence already attached to the failure"
---

## Problem

A warm (credentialed) drive session pins one browser context clamped to one owner host. When the caller
navigated a *different* host, the gateway's **own** owner-host clamp refused it
(`net::ERR_BLOCKED_BY_CLIENT`, status `null`). The pinned handler treated *any* `navFailed` as "the committed
exit went bad," `#discardSession`'d a **still-valid** session (destroying a live PerimeterX clearance), then
cold-reopened on a fresh un-warmed exit that re-triggered the challenge from scratch — and the message
("re-capture this credential" / "retry for a fresh exit") was picked from **host config**, ignoring the rich
`FailureDiagnostics` (class, vendor, `ERR_BLOCKED_BY_CLIENT`) attached to the *same* throw. One self-inflicted
mechanism produced three symptoms (a PX re-trigger, a wasted retry episode, a confidently-wrong diagnosis).

## Solution

**Give the self-inflicted case its own typed class, handled BEFORE the destructive path, and preserve the
healthy session.** Two complementary moves:

- **Refuse before the wire (R1, #79).** The clamp already *forbids* a warm cross-host nav — so the bug is
  purely in how the forbidden case is *handled*. A pre-flight check on the pinned/warm branch
  (`canonicalizeHost(target) !== #warmHost`) returns a typed **`owner-host-mismatch`** result *before*
  `core.navigate`, so the clamp is never tripped and the good context is untouched. It changes the
  **response** to a forbidden nav, never the clamp's **decision** (the no-exfil boundary is untouched).

- **Classify the wire-level self-block (R2, #80).** A main-frame `ERR_BLOCKED_BY_CLIENT` is *always* the
  gateway's own guard (the sole client-blocker). Capture it TOP-FRAME-scoped
  (`req.frame() === page.mainFrame()`, not `isNavigationRequest` alone — that over-classifies
  subframe/prefetch Documents) as a `policy-blocked` `FailureClass` at **top precedence**. It never escalates
  / re-rolls the exit pool (a fresh exit can't reach an off-allowlist target) and — critically — it is
  handled BEFORE `#discardSession` on **every** failure surface (pinned nav, warm-open, cold first-nav,
  forced/escalation loop, and post-action), each **preserving** the healthy session.

**Thread the guard's reason via a DECISION-SAFE side-channel.** The block reason lived only in the guard's
audit record. Surface it with a *write-only* out-param (`NavigationBlockInfo`) the guard fills on a block:
the fail-closed decision is computed independently and never reads it, so the security invariant holds. Treat
the reason as untrusted (scrub it at every caller-visible seam — R9) rather than trusting a closed-vocab
assumption the type doesn't enforce.

## Key insight

> The controller mistook **its own refusal** for a dead exit. A self-refusal is not a failure to *recover*
> from — it's a scope decision to *surface*. Classify it before the destructive path, keep the healthy
> session, and let the *evidence already on the throw* pick the message — never host config alone.

## Gotchas learned

- **Fixing the class isn't enough — audit every surface.** Five review rounds surfaced the same theme on
  successively deeper paths: the retrieve/drive escalation LOOP kept re-rolling (the `isDeadExit` exclusion
  fixed the *label*, not the *loop* — the loop needs an explicit `break`); `navFailed` missed an
  ACTION-triggered self-block that inherited the previous page's stale 200 status; a sticky one-shot marker
  re-fired on later snapshots of the preserved page (consume it in `#snapshotOf`); the retrieve
  mixed-exhaustion swap discarded a policy-blocked final render (`status===null`) in favor of an earlier live
  block. When a class must be honored, grep EVERY failure/return surface for it, not just the primary seam.
- **`policy-blocked` must win the surfaced `reason`, not just the `FailureClass`.** The MCP surface prefers
  `reason` (`BlockReason`) over `failureClass`, so the class was hidden until `resolveFailureReason` also
  returned `policy-blocked` — keep the two vocabularies in agreement (the one-reason invariant).
- See [[post-38-regression-recovery-strategy]] and [[drive-retrieve-detection-parity]].
