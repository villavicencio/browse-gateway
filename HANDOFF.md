# HANDOFF — 2026-07-22, evening

Session arc: `/pickup` → operator: **"go — fold in #66, then one gate/deploy; do the rest autonomously"**
(operator away ~2h) → **#66 implemented + Codex-clean (3 rounds) + merged (PR #71, `e6fb131`) → 5-leg gate
PASS → DEPLOYED to prod**. All remaining work-items are operator-HOLD-gated; instead of crossing HOLDs,
**4 decision-ready design docs** were drafted (see below). Tree clean, no open PRs, main == prod.

## Prod state (CURRENT)

- **Prod: `sha256:f45dc6eb…` = git `e6fb131`** (= #66 + #67 + #54 Part 1 + everything prior). Deploy run
  `29964498653` (gate → swap → verify SUCCESS, 2026-07-22 ~22:56Z).
- **Rollback anchor: `sha256:edb1e576…`** (= `1ce789c`, #48 — the previous prod), auto-recorded by the
  deploy workflow.
- Gate evidence: all 5 legs PASS on the deployed digest — stealth (CF 1/1, DataDome 1/1, WebRTC/WebGL/
  secret-leak/negative-control), **drive (incl. "a CF challenge cleared during navigate()'s poll" — the
  #66-critical proof that truncation gating did NOT break CF clearance)**, failure-envelope (1 benign
  note: cleared page carries no wafVendor — expected), retrieve, call-budget.

## What shipped this session — #66 (PR #71, squash `e6fb131`)

Deadline-truncated goto must not pin a partial-200 as drive success (#45 r11 residual):
- **Core:** `navigate()` tracks a TimeoutError-cut goto; `#settle` returns `deadlineCut` (budget-cut
  clearance poll) + `dclTimedOut` (r1: swallowed DCL-wait timeout — the only residue of a non-timeout
  goto abort; r2: TimeoutError-only, page-close/frame-detach keeps its own story). Snapshot carries
  `deadlineTruncated` ONLY when cut AND thin AND !visiblyBlocked, derived on the FINAL snapshot —
  cleared-CF fat 200 stays success (stealth-critical), interstitial keeps its richer anti-bot class.
- **#67 receipt wired into drive:** `#lastMainFrameResponseReceived` (same listener/resets as
  `#lastDocStatus`) → `PageSnapshot.responseReceived` on every snapshot → `isDeadExit` keys off the real
  receipt; a truncated-but-responded proxied attempt is LIVE (not `burned-exit`).
- **Seams:** `navFailed` fails a truncated snapshot; drive `#failure` classifies `timeout` (below
  budget/burned loop verdicts); pinned/warm/direct paths emit truncation-specific messages (warm ≠
  re-capture remediation). 788 tests, 0 TS errors.
- Learning: `docs/solutions/architecture-patterns/positive-cut-evidence-separates-truncation-from-deliberate-throw.md`

## What's Next — EVERYTHING remaining is operator-HOLD-gated

Four decision-ready design docs drafted (all `docs/plans/*.local.md`, gitignored — read then decide):

1. **#54 Part 2** (HOLD #4) — `2026-07-22-001-54-part2-orphan-reap-design.local.md`.
   Recommends: gateway-owned mkdtemp userDataDir registry + /proc cmdline sweep (Linux-only) for the
   half-spawned-Chromium reap; count-in-`#unconfirmed`-immediately for late-orphan cap accounting
   (truthful back-pressure). 3 decision questions listed.
2. **#53 health surface** (HOLD #3) — `2026-07-22-002-53-health-surface-design.local.md`.
   The HOLD is the auth-posture fork; recommends operator-only token (option A, upgradeable to
   two-tier C). Degraded-state semantics + provisioning notes (NOT a consumer key — #20 lesson).
3. **#44 Turnstile precedence** (HOLD #1) — `2026-07-22-003-44-turnstile-precedence-design.local.md`.
   Blocker = capture a CF managed-challenge fixture first (does the Under-Attack interstitial carry
   cf-turnstile markers?); also flags: verify whether the actual loss is only the vendor STRING
   (solverEligible may already be correct) — the fix may be needless.
4. **#48 location primitive** (HOLD #2) — `2026-07-22-004-48-location-primitive-design.local.md`.
   Recommends option A: caller-supplied steps + gateway-owned sequencing/persistence/verification
   ("session-state choreography, not store-picker knowledge"); (C) do-nothing is the fallback; (B)
   per-site recipes contradicts the ticket's non-goals. 3 operator questions listed.

## Gotchas & Watch-outs (carried forward + new)

- **colima is RUNNING** (started this session for the gate). Stop it if you want the RAM back.
- **Batched-gate recipe unchanged** (see previous handoffs / this session proved it again): verify
  `:latest` digest, pull by digest, per-leg `docker run --rm --init --platform linux/amd64 --shm-size 1gb
  -e BGW_ATTEMPTS=1 -e BGW_REQUIRED=1 -e BGW_NO_SANDBOX=1 -e BGW_CHANNEL=chrome -e BGW_PROXY_*="$SPIKE_*"`,
  stream in background, NO `| tail`. `.env.spike` keys are `export`-prefixed (a bare `^[A-Z_]*=` grep misses them).
- **Codex runner:** `codex exec review --base main` from the repo dir worked directly this session
  (3 rounds, ~7-10 min each). Sandbox EPERM listen "failures" in its full-suite run are NOT real.
- **Foreground `sleep` is blocked in this harness** — use `run_in_background` until-loops for waits.
- A `homeFallback`/`responseReceived`/`wafVendor`/`failureClass`/`burnedExit`/`deadlineTruncated` value can
  be occasionally-imprecise on exotic edges — diagnostics/verdict precision, never security decisions.
  (`deadlineTruncated` DOES gate the drive success verdict — by design, positive-evidence-only.)
- **Public repo** — never commit fleet codenames. Design docs with fleet detail stay `.local.md`.
