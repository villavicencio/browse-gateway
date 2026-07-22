# HANDOFF — 2026-07-22, late morning

Picked up from the overnight run (which banked #47/#58/#44/#43 to main, undeployed). This session did
two full gate+deploy cycles and one ticket end-to-end: (1) **gated + deployed the overnight #42-batch**;
(2) **reshaped, implemented, 11-round-Codex-reviewed, merged, gated, and deployed #45**. Both are now
**live in prod**. Everything below is committed; the working tree is clean and there are no open PRs.

## What We Built

- **Deployed the overnight batch (#47/#58/#44/#43).** A 4-agent coverage-audit workflow found the pre-chosen
  gate asserted *none* of the tickets' new fields, and that **#43's wall-clock bound was never observed on a
  real browser** (serious — a regression = session starvation on the 2-session gateway). Closed it first with
  **`scripts/validate-call-budget.mjs`** (committed `487e338`) — Leg A proves `budgetDeadlineMs` cuts a real
  clearance poll (via a `clearedTextLength`-unreachable trick), Leg B proves the typed-timeout contract with
  zero proxy spend. Gated (validate-stealth + free stack) → deployed. **Prod → `sha256:2258db74` (git `487e338`).**
- **#45 — burned-exit vs site-block + bounded drive loop — MERGED (PR #65, squash `beb56bf`) + DEPLOYED.**
  - **Reshaped from the ticket-as-written** after a 5-lens pre-code critique panel (a workflow): the literal
    spec (same-exit probe + stop-fast + cooldown) would *regress* CF/reputation re-roll and is largely
    unobservable/inert. You chose the derived v1 via AskUserQuestion.
  - **PART A (reliability):** the drive escalation loop (`#openHealthyAndNavigate`) now consumes the #43
    budget — pre-attempt bail + a shared `budgetDeadlineMs` clamps every drive navigate (direct/pinned/warm/
    warm-up hops/loop) *and* the CAPTCHA render+solve; env-overridable drive timeouts; budget-exhaustion →
    `timeout`. Bounds a previously-unbounded ~200-255s loop. Files: `drive-controller.ts`, `patchright-core.ts`
    (`navigate`/`#settle`), `captcha-solver.ts`, `captcha.ts`, `config.ts`, `http-main.ts`/`main.ts`.
  - **PART B (legibility):** `burned-exit` as orthogonal exit-health evidence, *derived* (not probed) via a
    shared `isDeadExit(status, finalUrl)` predicate; positive-signal-only (non-forced path only), mixed
    live/dead classifies on the last *live* failure, live block stays site-attributed. Re-rolling behavior
    unchanged. Files: `retrieve.ts`, `drive-controller.ts`, `failure-diagnostics.ts`, `verbs/index.ts`.
  - **755 unit tests (+25: `test/burned-exit.test.mjs` + captcha-solver additions), 0 TS errors.**
  - **Gated + deployed:** validate-stealth (CF 1/1 + DataDome 1/1 via IPRoyal ATTEMPTS=1/REQUIRED=1) +
    validate-drive (clean) + failure-envelope + retrieve + call-budget all PASS on the amd64 image. Deploy run
    `29941933028`, no rollback. **Prod → `sha256:0aa02c9477…` (git `7fba0b9` = #45).**
- **Follow-up issues filed:** **#66** (r11 residual) and **#67** (diagnostic residual) — see What's Next.

## Decisions Made

- **#45 reshape (critique-first, ratified by you).** Dropped the same-exit inline probe (unobservable —
  control reachability ≠ per-site IP reputation; sticky decay ≠ same exit; retrieve has no diagnostics-guard
  seam), stop-fast (would regress CF *and* reputation-403 re-roll — F1's whole reason), and exit cooldown
  (ephemeral random ids aren't physical-exit handles). Delivered the acceptance criteria by *deriving*
  burned-exit from classification instead. **Do not relitigate these** — the critique + code prove them out.
- **burned-exit is EVIDENCE, not a competing FailureClass** — a seam-level refinement of `nav-failed` with no
  WAF vendor, nulling the reason (like #43's `timeout`), preserving the #40 one-reason invariant.
- **Merge #45 with 2 residuals tracked** (your call) rather than fixing the subtle r11 item inline — it risks
  the stealth-critical CF-clearance path and needs gate validation.
- **Batched gate discipline held:** each deploy runs one consolidated in-container gate (the ~$10 IPRoyal PAYG
  stealth leg at ATTEMPTS=1/REQUIRED=1) before dispatching `deploy-http.yml`.

## What Didn't Work

- **The #45 ticket as literally written** — the probe/stop-fast/cooldown scheme (see Decisions).
- **r9's "assign observed status on goto-timeout"** (attempt to fix #67) — it made a timed-out-but-responded
  render look *successful* (partial content returned as success, stopping retries). **Reverted in r10.** The
  correct fix needs a response-receipt signal tracked *separately* from the nav-failure `status`.
- **r4's absolute-timestamp CAPTCHA deadline** — mixed `performance.now()` (caller) with `Date.now()` (solver)
  clock domains → would have aborted *every* budgeted solve in prod. **Codex r5 caught it**; fixed by passing a
  remaining-*duration* added to the solver's own clock. (Lesson now in the epic memory.)

## What's Next

1. **Continue the spine: `#48 → #53 → #54`.** #45 is done + deployed. **#48** ships the silent-home-fallback
   detector cleanly (its location-primitive half is operator HOLD #2). **#53** conservative authed-MCP slice
   (HOLD #3). **#54** slot-release + orphan-reap (HOLD #4).
2. **#45 follow-ups (filed, deferred):**
   - **#66 (r11):** a budget-truncated drive `goto` (headers before DCL) can pin a partial-200 as *success*
     not *timeout*. A naive fix breaks CF-clearance (same goto-throw → `#lastDocStatus` path) — needs a
     `deadlineTruncated` snapshot signal gated on not-cleared, **gate-validated against the real CF path**.
   - **#67:** retrieve records a responded-but-slow-DCL exit as status-null → `burned-exit` may over-fire
     (diagnostic-only, re-roll identical). Needs response-receipt tracked *separately* from `status`.
3. **Older tracked:** 4 operator HOLDs (#44 Turnstile precedence, #48 location primitive, #53 auth posture,
   #54 orphan-reap); 3 gate-hardening follow-ups from the morning (#58 drive-action vendor assertion, #44
   fake-solver+fixture, #47 `/health` into validate-http).

## Gotchas & Watch-outs

- **Prod state:** `sha256:0aa02c9477…` (git `7fba0b9` = #45). Rollback anchor: the #42-batch
  `sha256:2258db74…` (git `487e338`). main == prod (nothing undeployed).
- **colima is still running** — `colima stop` to free the VM. The gate env-file lives in the session
  scratchpad (`gate.env`, `SPIKE_PROXY_*`→`BGW_PROXY_*` mapping); regenerate from `.env.spike` if gone.
- **Codex-loop reality:** threading a per-call budget through a stateful multi-path controller *cascades*
  (~11 rounds of budget-completeness; a fix can spawn the next finding — r9→r10→r11 were self-regression
  cleanup). Present-with-documented-residuals is a valid stop (the SOP's "approve isn't always reachable").
- **Codex runner:** `codex exec review --base main`, `run_in_background: true`. Chaining `git commit && codex`
  in one backgrounded call risks the task being killed (happened once — the commit was safe, relaunched).
- **A `wafVendor`/`failureClass`/`timing`/`burnedExit` value can be occasionally-imprecise** on exotic/
  slow-DCL/teardown edges — all are **diagnostics, never behavior/security decisions**.
- **`git pull --ff-only origin main`** before the next branch. **Public repo** — never commit fleet codenames.
