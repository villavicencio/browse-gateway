---
title: An approving review proves nothing until you verify its base and its reasoning effort
date: 2026-08-17
category: docs/solutions/workflow-issues
module: "code review workflow (dv:gauntlet), codex CLI, git base selection"
problem_type: workflow_issue
component: code-review-tooling
severity: high
applies_when:
  - "You are running an automated or agent-driven code review over a diff"
  - "You are choosing the base ref for a PR review and reaching for a local branch name"
  - "A reviewer returned no findings and you are about to treat that as evidence the change is clean"
  - "You are invoking the codex CLI non-interactively and have not set model_reasoning_effort"
tags:
  - code-review
  - codex-cli
  - reasoning-effort
  - git-base
  - false-negative
  - review-gate
---

## Context

A full adversarial review of PR #140 (Task 2, authorized MCP artifact retrieval) produced **two
silent failures in a row, before a single line of the diff was actually judged.** Both failures
share one shape: the review *looked* like it ran, and looked clean, while the thing it was supposed
to do had not happened. Neither would have announced itself.

Caught and corrected, the same review then found two real P1 defects, both fixed in `f76c236`.
Run as originally configured, it would have reported "no findings" over a diff that had them.

This is the review-gate instance of the rule already in `CLAUDE.md`: *a guard, probe or control must
be able to report bad news, and you must have watched it do so.*

## Guidance

### 1. Resolve the review base from the remote, and verify it against the PR

`git merge-base HEAD main` silently uses **local** `main`, which is only as fresh as the last fetch.
On this run local `main` was one commit behind:

```
local  main         062232b     # stale by one commit
origin/main                     9364e05
PR #140 baseRefOid              9364e05
```

`062232b` predates `9364e05` (Task 1, PR #139 — already merged). Reviewing against it would have
pulled an already-merged, already-reviewed PR into scope: **~13k additional lines**, diluting the
1,515 lines of `src/` that were actually under review, and spending reviewer attention re-judging
code that had already shipped.

Before launching any reviewer, fetch and assert all three agree:

```bash
git fetch origin --prune
git rev-parse origin/main                                   # 9364e05...
gh pr view <N> --json baseRefOid -q .baseRefOid             # 9364e05...  <- must match
git merge-base HEAD origin/main                             # 9364e05...  <- must match
git log --oneline origin/main..HEAD                         # exactly the PR's commits
```

Then pass the **remote** ref to the reviewer (`--base origin/main`), never the bare local branch
name. A local branch checked out in another worktree cannot be fast-forwarded anyway, so "just
update main first" is not always available — passing `origin/main` always is.

### 2. Set the reasoning effort explicitly; never inherit the CLI default

On `codex-cli 0.147.0` with no `model_reasoning_effort` configured in `~/.codex/config.toml`, the
model's own default applies. Here that was:

```
model: gpt-5.6-sol
reasoning effort: none
```

The resulting review of 1,515 added lines of concurrency, authorization, and lifecycle code was
**18 lines long, contained no tool calls, read no files, and returned a blanket approval**:

```
codex
No actionable findings were identified in the patch.
No actionable findings were identified in the patch.
```

Re-run with effort set explicitly, the same command against the same diff behaved like a review —
`Read repository context`, `Inspect the diff and affected code paths`, `Validate candidate bugs`,
several minutes of work — and returned three findings:

```bash
codex exec review --base origin/main \
  -c sandbox_mode="read-only" \
  -c model_reasoning_effort="high"
```

Two of the three survived independent refutation and were real:

- `buildGatewayRuntime` took an exclusive, unreclaimable artifact root lock on behalf of three
  non-owner callers, and took it *before* the fail-closed guards in its own function — so an
  ordinary config typo bricked the container permanently.
- `#navigateHost` was written outside `#serialize`, so concurrent navigates cross-attributed a
  captured artifact's `sourceHost` — wrong provenance on a private financial document.

The third (a lineage TOCTOU) was refuted on a concrete mechanism and correctly did not become a fix.

### 3. Treat a null review as a broken instrument until proven otherwise

An empty finding list has two possible causes — the diff is clean, or the reviewer did not review —
and **the output looks identical either way.** The distinguishing evidence is not the verdict; it is
whether the reviewer demonstrably did work: tool calls, files read, wall-clock time, and at minimum
one occasion on which you have watched that reviewer emit a finding on this diff.

If a reviewer has never reported bad news in a given run, its silence carries no information.
Corroborate with a second independent finder before recording `ready`.

## Why This Matters

Both failures are false negatives on a **gate**, which is the most expensive place to have one. A
review that misses defects does not merely fail to help — it manufactures unearned confidence and
closes the question. The PR in question had green CI (1,482/1,482 tests) and a prior independent
specification/security review; the zero-effort pass would have added a third clean signal on top of
two others, and the two P1s would have shipped with an unusually strong evidentiary record behind
them.

The base-drift failure is worse than it looks because it fails *open and quietly*: the review still
runs, still produces findings, still reports success. Nothing in the output says "your scope was
wrong." Only comparing against the PR's own `baseRefOid` reveals it.

## When to Apply

- Every agent-driven or CLI-driven review of a PR or branch diff — the base check costs one
  `git fetch` and three `rev-parse`s.
- Any non-interactive `codex exec` / `codex exec review` invocation: set `model_reasoning_effort`
  explicitly rather than inheriting whatever the model or config defaults to.
- Any time a review pass returns zero findings on a non-trivial diff.

## Examples

**Base selection — wrong vs right:**

```bash
# WRONG — silently uses local main, which may be stale
codex exec review --base main

# RIGHT — remote ref, after fetch, verified against the PR's own base
git fetch origin --prune
[ "$(git rev-parse origin/main)" = "$(gh pr view 140 --json baseRefOid -q .baseRefOid)" ] \
  || { echo "base mismatch — do not review"; exit 1; }
codex exec review --base origin/main -c sandbox_mode="read-only" -c model_reasoning_effort="high"
```

**Smoke-testing that a reviewer can still speak before trusting its silence:**

```bash
# A reviewer that has never emitted a finding in this run is an unvalidated instrument.
# Cheapest check: confirm the run did work at all.
grep -cE "^(mcp:|  →|  •)" review.log   # 0 tool calls + instant return == null pass, not a clean diff
```

### Related gotcha, still live on 0.147.0

The duplicate-emission bug reproduces on `codex-cli 0.147.0`: the summary line and the entire
`Full review comments:` block are emitted **twice, verbatim**, at the end of stdout. Parse findings
once and dedupe by fingerprint at the normalization boundary — a naive read doubles every finding,
inflates severity counts, and can fabricate a "new" finding out of an echo. Previously recorded
against 0.144.1; it has not been fixed.

## Related

- `docs/solutions/best-practices/a-test-whose-stub-guarantees-the-assertion-proves-nothing.md` —
  the same failure class one layer down: a green control whose stub could not express the failure.
  That doc is about tests that cannot fail; this one is about reviewers that cannot find.
