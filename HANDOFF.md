# HANDOFF — 2026-07-22 (morning deploy DONE + #45 shipped to main)

Two things happened this session: (1) the overnight #47/#58/#44/#43 batch was gated in-container and
**deployed to prod**; (2) **#45 was reshaped (critique-first), implemented, driven through an 11-round
Codex loop, and merged to main** — banked, **not yet deployed**.

## ✅ 1. Morning gate + deploy — 4 tickets LIVE

**Prod runs `sha256:2258db74…f54e79b` (git `487e338`).** Rollback anchor: **#42 `sha256:6e9ca1e76a18`**.
Deploy run `29925612591` (gate→swap→verify green, 29s). Image = the 4 overnight tickets (#47/#58/#44/#43)
+ a test-only gate script. A serious #43 coverage gap (the wall-clock bound was never *observed* on a real
browser) was closed first with **`scripts/validate-call-budget.mjs`** before deploying.

## ✅ 2. #45 — burned-exit + bounded drive loop — MERGED to main (squash `beb56bf`, PR #65), NOT deployed

**Reshaped from the ticket-as-written.** A 5-lens pre-code critique found the literal spec (same-exit probe +
stop-fast + cooldown) would *regress* CF/reputation re-roll and is largely unobservable/inert; you chose the
reshaped v1 (AskUserQuestion). Understanding + critique ran as two workflows before any code.
- **PART A** — the drive escalation loop now honors the #43 per-call budget (pre-attempt bail + a shared
  `budgetDeadlineMs` clamps every drive navigate + the CAPTCHA render/solve); env-overridable drive timeouts;
  budget-exhaustion → `timeout`. Bounds a previously-unbounded ~200-255s loop.
- **PART B** — `burned-exit` as orthogonal exit-health evidence, *derived* (not probed) via a shared
  `isDeadExit` predicate; positive-signal-only (non-forced path), site blocks stay attributed. Re-rolling
  behavior unchanged — value is legibility + a bounded loop.
- **755 unit tests (+25), 0 TS errors.** 11 Codex rounds, every finding verified — **caught a real prod
  regression I introduced (r5: a `performance.now()`/`Date.now()` clock-domain mix that would have broken all
  budgeted CAPTCHA solving)** + a solver body-read hang (r7).

## What's next — pick up here

### The immediate options
1. **Gate + deploy #45.** It's the only undeployed thing on main. It touches core `navigate`/`#settle`
   (stealth-critical), so it needs the **batched in-container gate**: `validate-stealth` + `validate-drive` +
   `validate-failure-envelope` + `validate-call-budget` on the amd64 image, then `gh workflow run
   deploy-http.yml -f image_tag=latest`. Same flow + `.env.spike` mapping as this morning. colima is still up.
2. **Continue the spine: `#48 → #53 → #54`.** #45 done. #48 ships the silent-home-fallback detector cleanly
   (HOLD #2 = the location primitive). #53 conservative authed-MCP slice (HOLD #3). #54 slot-release +
   orphan-reap (HOLD #4).

### #45 follow-ups filed (issues #66, #67 — from the Codex loop, deliberately deferred)
- **#66 (r11):** a budget-truncated drive `goto` (headers before DCL) can pin a partial-200 as *success* not
  *timeout*. A naive fix breaks CF-clearance (same goto-throw → `#lastDocStatus` path) — needs a
  `deadlineTruncated` snapshot signal gated on not-cleared, **gate-validated against the real CF path**.
- **#67:** retrieve records a responded-but-slow-DCL exit as status-null → `burned-exit` may over-fire
  (diagnostic-only, re-roll identical). Needs response-receipt tracked *separately* from the nav-failure
  `status` (r9 tried conflating them → made a timed-out render look successful → reverted r10).

### Older tracked items (unchanged)
- **4 operator HOLDs** (#44 Turnstile precedence, #48 location primitive, #53 auth posture, #54 orphan-reap).
- **3 gate-hardening follow-ups** from the morning (#58 drive-action vendor assertion, #44 fake-solver+fixture,
  #47 `/health` into validate-http).

## Gotchas / watch-outs
- **colima is still running** — `colima stop` to free the VM.
- **#45 is banked, not deployed** — prod is behind main by #45. Gate before deploy.
- **Codex loop reality:** threading a per-call budget through a stateful multi-path controller cascades
  (~11 rounds of budget-completeness; a fix can spawn the next finding — r9→r10→r11 were self-regression
  cleanup). Present-with-documented-residuals is a valid stop (the SOP's "approve isn't always reachable").
- **`git pull --ff-only origin main`** before the next branch. **Public repo** — no fleet codenames.
- A `wafVendor`/`failureClass`/`timing`/`burnedExit` value can be occasionally-imprecise on exotic/slow-DCL/
  teardown edges — all are **diagnostics, never behavior/security decisions**.
