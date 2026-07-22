# HANDOFF — 2026-07-22, afternoon

Session arc: `/pickup` → operator asked **"what can you work on simultaneously off the remaining list?"** →
ran a **parallelization-analysis workflow** (scope every open work-item + conflict matrix) → executed the
**first simultaneous batch (wave 1) end-to-end** in parallel worktrees: **#21 closed**, **#67 merged**,
**#54 Part 1 merged** (5-round Codex loop). Both merged fixes are **on main but NOT deployed** — operator
chose to stop before the gate/deploy. Tree clean, no open PRs, main == `32c7cf4`. colima still stopped.

## What We Built (wave 1 — all landed)

- **#21 — verify-and-close. CLOSED as shipped.** A verify pass confirmed all six ACs (egress-verify probe,
  structured EscalationDiagnostics/proxyDiagnostic, `BGW_FORCE_PROXY_HOSTS`+`{forceProxy}`, 8-char IPRoyal
  sticky-id, secret redaction, tests) are implemented + deployed (PR #23 + #24/#25/#37). The commenter's
  "hold-served vs 403-pre-challenge" reason-split is **already realized** as `perimeterx-challenge` vs
  `hard-block` (distinct union members, pxHint-before-hard-block precedence, tested) — not re-implemented.
  Close-out comment posted; no code change.

- **#67 — receipt-key `isDeadExit` — MERGED (`e27497b`, PR #69), Codex-clean in 1 round.** Diagnostic-only
  label precision (a #45 residual). `render()` (patchright-core.ts) now registers a `page.on("response")`
  main-frame receipt (`responseReceived`) BEFORE goto, tracked **separately from `status`**. `isDeadExit` is
  re-keyed `(responseReceived, status, finalUrl)` — a proxied exit that RESPONDED but timed out before DCL is
  status-null yet `responseReceived`, so `burnedExit` no longer over-fires and discards the site's WAF
  attribution. **Hard constraint honored:** `status` is never reassigned in the catch; the success-gate
  `deadNav`/`navFailed` stay status-keyed (the #45 r10 lock). Files: `browser/patchright-core.ts`,
  `browser/types.ts` (RenderResult + PageSnapshot `responseReceived?`), `verbs/retrieve.ts`,
  `mcp/drive-controller.ts`, `test/burned-exit.test.mjs`. **779 tests, 0 TS errors.**

- **#54 PART 1 — bound the acquire-side launch — MERGED (`32c7cf4`, PR #70), Codex-clean after 4 fix rounds.**
  A never-resolving `launchPersistentContext` used to pin its `#reserved` slot forever (the reaper only scans
  `#sessions`). Now `#launchAndRegister` races the factory launch against `LAUNCH_DEADLINE_MS` (120s, not
  env-overridable per #43; test override `launchDeadlineMs`); on timeout it fails `CORE_LAUNCH` and acquire's
  existing `finally` releases the slot (no double-decrement). A **late-resolving** core is closed best-effort
  (fire-and-forget, anchorless — an unconfirmed close → `#unconfirmed` + reaper retry). A synchronously-throwing
  factory is normalized to `CORE_LAUNCH`. Files: `gateway/session-manager.ts`, `gateway/index.ts`
  (export `LAUNCH_DEADLINE_MS`), `test/gateway-session.test.mjs` (+ regression tests). **783 tests, 0 TS errors.**
  - **#54 stays OPEN for Part 2 (operator HOLD #4):** reaping the never-returning half-spawned Chromium (no
    core → no PID for #50's post-resolve capture; the userDataDir-sweep needs a gateway-owned `mkdtemp` dir),
    AND **counting a live late-resolve orphan against the running capacity cap** (registering it can push
    `activeCount` above `maxSessions` when a replacement took the freed slot — needs Part 2's holistic reaping
    model, not a Part-1 special-case). Both scoped OUT of Part 1 as the orchestrator's deliberate line.

## Decisions Made

- **Answered "what can run simultaneously" with a real conflict matrix, not a guess.** A workflow scoped each
  open work-item's file footprint. **One HARD conflict: #66↔#67** (same patchright-core goto try/catch + a
  near-identical new PageSnapshot field + a circular dep) → serialize, **#67 first** (its receipt is the
  unified signal #66 reuses). Everything else is soft (shared hot files, disjoint regions). **Waves:** W1 =
  {#67, #54, #21}; W2 = {#66, #53}; W3 = {#48}. Ready-now (no HOLD): #67, #66, #21. HOLD-gated: #48 (#2),
  #53 (#3), #54 (#4).
- **Ran wave 1 in 3 parallel isolated worktrees** (Workflow `isolation: 'worktree'`, node_modules symlinked
  from the primary), then reviewed each diff myself + drove the Codex loop per branch + merged. Worked well.
- **#54 late-orphan accounting → Part 2, not chased in Part 1.** Codex rounds r2/r3 pulled in opposite
  directions (count-it vs don't-exceed-cap); the root is that the late-orphan's capacity accounting IS the
  orphan-reaping surface HOLD #4 gates. Drew the scope line there (per the codex-loop SOP: fix in-scope,
  document scoped-out) rather than a 6th round.
- **Stopped before gate/deploy (operator choice).** Both fixes merged-but-undeployed by design.

## What the Codex loop caught on #54 (5 rounds — all genuine, each round SIMPLIFIED the code)

- **r1:** a late-resolving launch leaked an untracked browser (my own pre-flag); a SYNC-throwing factory
  rejected raw instead of `CORE_LAUNCH` (call moved outside the `try`). Fixed both.
- **r2:** my `git add -A` tracked the machine-local `node_modules` **symlink** (`.gitignore`'s `node_modules/`
  with a trailing slash does NOT match a symlink). Untracked it. **Lesson: stage specific paths in worktrees,
  never `add -A`.**
- **r3:** r2's "register the late core in `#sessions` to count it" pushed `activeCount` ABOVE `maxSessions`
  when a replacement had taken the freed slot → reverted to anchorless best-effort; the accounting → Part 2.
  Also a shutdown drain race.
- **r4 (the real find):** my shutdown-side `launchDrain` bound could truncate a shutdown-orphan teardown that
  had ALREADY started (a launch resolving near the bound), so `process.exit(0)` left detached Chrome alive.
  Root: the bound was **redundant** — `#launchAndRegister`'s internal deadline already bounds every
  `#launching` entry. Removed it; shutdown now awaits launches to completion (bounded internally, no truncation).
- **r5: clean.**

## What's Next

1. **Gate + deploy the wave-1 batch (pending, operator-paused).** Prod is still on #48 `sha256:edb1e576`; main
   has #67+#54 undeployed. Run the **batched in-container gate** (recipe below) on the built amd64 image, then
   `gh workflow run deploy-http.yml -f image_tag=latest`. Optionally fold in **#66** first so it's one gate/deploy.
2. **Wave 2 — #66 (READY, now unblocked).** #67's receipt is merged, so #66 (budget-truncated drive `goto`
   pinning a partial-200 as success) can reuse it: in `patchright-core` `navigate()`/`#ensureActivePage`, add a
   `#lastMainFrameResponseReceived` boolean alongside `#lastDocStatus` and set `responseReceived` on the
   navigate() PageSnapshot — the two drive `isDeadExit` call sites then pick up the real receipt automatically
   (they use a `status` fallback today). Add a `deadlineTruncated` snapshot signal so a goto-threw-but-not-
   isCleared render maps to the timeout FailureClass; **must be gate-validated against the real CF 403→200 path**
   (naive "force status null on any goto-throw" is forbidden — CF clearance relies on goto throwing then settling).
3. **HOLD-gated (need operator sign-off before starting):**
   - **#54 Part 2** (HOLD #4) — orphan reap + late-orphan cap accounting (see above).
   - **#53** (HOLD #3) — health surface to `obscura status`; the auth-posture fork is the HOLD (all consumers
     are peers today; exposing pool internals on `/health` means any consumer token sees degradation counters).
   - **#48 location primitive** (HOLD #2) — the design decision (reusable primitive vs per-site scraper) IS
     the HOLD; there's no site-agnostic "selected store" DOM signal.
   - **#44** Turnstile precedence (HOLD #1).

## Gotchas & Watch-outs

- **Prod state:** `sha256:edb1e576…` (git `1ce789c` = #48). **main is AHEAD of prod** by #67+#54 (undeployed).
  Rollback anchor: `sha256:0aa02c94…` (git `7fba0b9` = #45). Last prod deploy run: `29952128663`.
- **colima is STOPPED** — `colima start --vm-type vz --vz-rosetta` before the gate. Gate env-file is ephemeral;
  regenerate from `.env.spike`.
- **EXACT batched-gate recipe (unchanged — reuse, don't rediscover):** CI `build-image` on main push builds+pushes
  `…:latest` (amd64) — verify `latest` == intended commit via `docker buildx imagetools inspect …:latest
  --format '{{.Manifest.Digest}}'`. Pull `@sha256:<digest>`. `set -a; . ./.env.spike; set +a`, then per-leg:
  `docker run --rm --init --platform linux/amd64 --shm-size 1gb -e BGW_ATTEMPTS=1 -e BGW_REQUIRED=1
  -e BGW_NO_SANDBOX=1 -e BGW_CHANNEL=chrome -e BGW_PROXY_URL/USERNAME/PASSWORD="$SPIKE_*" <img>
  node scripts/validate-{stealth,drive,failure-envelope,retrieve,call-budget}.mjs`. Stream
  `run_in_background:true`, **NO `| tail`** (xvfb/pipe buffering wedges silently). `BGW_ATTEMPTS=1` alone
  false-FAILS — needs `BGW_REQUIRED=1`. Free legs (drive/failure-envelope/retrieve/call-budget) hit udemy CF
  from the Mac's residential IP, no proxy spend.
- **Codex runner:** `codex exec -C <dir> review --base main` (the `-C/--cd` flag goes on `codex exec`, NOT on
  the `review` subcommand — `review -C` errors). `run_in_background:true`; strip rmcp/models_manager noise;
  parse the final `codex` text block. Commit and launch codex in SEPARATE calls. Codex's sandbox EPERMs the
  HTTP `listen` tests — those "failures" in its output are NOT real (verify locally).
- **Parallel-worktree hygiene:** symlink node_modules from the primary (`ln -sfn <primary>/node_modules
  ./node_modules`); typecheck via `npx tsc -p <wt>/tsconfig.json`; **stage specific paths, never `git add -A`**
  (it tracks the node_modules symlink — `.gitignore`'s `node_modules/` misses it). Committed branches persist
  after `git worktree remove`.
- **`git pull --ff-only origin main`** before the next branch. **Public repo** — never commit fleet codenames.
- A `homeFallback`/`responseReceived`/`wafVendor`/`failureClass`/`burnedExit` value can be occasionally-imprecise
  on exotic/slow-DCL/URL edges — all are **diagnostics, never behavior/security decisions**.
