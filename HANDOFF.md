# HANDOFF — 2026-07-23, later afternoon

Session arc: `/pickup` (same-day continuation of the #54P2+#53 session) → operator: "go, start with
#44" → **#44 closed as NEEDLESS** (verify-and-close, guard test + comment, PR #77) → "pick up #48" →
**#48 closed as (C)+docs** (operator chose via AskUserQuestion; no new gateway surface) → reviewed and
**CLOSED the umbrella epic #38** (all children + follow-ups done), plus closed a dangling-open #67.
**🎉 Epic #38 is COMPLETE.** No production code shipped this session — both closes were
docs/test/comment only, so **prod is UNCHANGED**. Tree clean, no open PRs, main ahead of prod by two
docs/test commits only.

## Prod state (CURRENT — unchanged this session)

- **Prod: `sha256:4becdf0a…` = git `978cc89`** (unchanged — no deploy this session). Rollback anchor
  **`sha256:961e149d…`** (= `754f6a8`, #54P2+#53). `#53` is live + provisioned (prior session):
  `obscura status` → `✓ pool healthy — force-kill armed, 0 unconfirmed, 0/7 sessions`.
- **main is ahead of the prod image by the session's docs/test commits, ALL non-prod-affecting:**
  `33e3e80` (#44 test+comment, PR #77), `7f3f3a6` (#48 solution doc), + this handoff commit (tip of
  main). `docs/` is not COPYed into the image and the #44 change is test-only, so prod needs no redeploy.
  `prodDeployNeeded:false` for all of them.

## What We Did (this session)

- **#44 Turnstile-kind precedence (HOLD #1) — RESOLVED as NEEDLESS.** Verify-and-close, no production
  code. The residual's premise was stale on two counts: (1) Turnstile is now solvable
  (`captcha-solver` `TASK_TYPE.turnstile = "AntiTurnstileTaskProxyLess"`, in `SOLVABLE_CAPTCHA_KINDS`);
  (2) `solverEligible`/`captchaKind` are a projection of the DETECTED widget
  (`activeCaptchaKind(html)` → `isSolvableCaptchaKind`) derived INDEPENDENTLY of the WAF-first
  `reason`/`wafVendor` (`retrieve.ts:1123-1124`, `patchright-core.ts:1624`; the #44-r3 comment at
  `retrieve.ts:1104-1108` names this exact co-fire case). A Turnstile widget co-firing with `cfHint`
  still emits `captchaKind=turnstile`+`solverEligible=true`; only the vendor STRING reads `cloudflare`
  (the correct who-blocked/which-widget split). Promoting `turnstile` precedence would contradict the
  green #40-r2 test and change nothing behavioral. Blocker fixture moot (a managed
  `/cdn-cgi/challenge-platform/` interstitial matches none of the turnstile `WIDGET_EVIDENCE` regexes →
  `activeCaptchaKind` undefined). **Guard:** two `#44 needless:` tests in
  `test/block-classifier.test.mjs` (848 total, +2). `isSolvableCaptchaKind` docblock rewritten to
  RESOLVED-NEEDLESS. **PR #77 → `33e3e80`, CI green.** Design doc `…-003-…` headed with the resolution;
  traceability note on the already-closed issue #44.
- **#48 location-context primitive (HOLD #2) — RESOLVED as option (C) + documented choreography.**
  Operator chose (C) via AskUserQuestion. Grounding showed (A)'s three claimed "reusable parts" already
  exist in the shipped drive model: **persistence** (one MCP session ↔ one `DriveController` ↔ one
  PINNED browser session `drive-controller.ts` `#pinned` — picker state survives a subsequent
  `browser_navigate`), **sequencing** (the full `browser_*` verb suite exposed + serialized on `#lock`),
  **verification** (`navigate()` already annotates `homeFallback:true`, `drive-controller.ts:378`; so
  `!homeFallback` after re-navigating the deep link IS "location established"). Consumers are LLM agents
  that already drive bespoke pickers; no site-agnostic "selected store" signal exists (option B = a
  rot-prone scraper DB, excluded). **Deliverable = knowledge not surface:**
  `docs/solutions/architecture-patterns/location-context-via-pinned-session-and-homefallback.md`
  (choreography: set store via picker verbs → re-navigate deep link → check `homeFallback`). **Committed
  straight to main `7f3f3a6`** (docs policy). Design doc `…-004-…` headed with the resolution;
  **issue #48 CLOSED.**
- **Epic hygiene.** Verified all child tickets #39–#48 + follow-ups #50/#53/#54/#58/#66/#67/#21 are
  CLOSED. Found **#67 was a dangling-open issue** — its fix (`e27497b`, PR #69) shipped and deployed
  (via #66) but the PR title lacked a `Closes` keyword → **closed #67** with a note. Updated the
  **epic #38 body** (checked every child box + completion header) and **CLOSED epic #38** with a
  completion summary.

## Decisions Made

- **Both remaining HOLDs closed WITHOUT code (verify-and-close).** #44 because the premise went stale
  between filing and pickup (Turnstile became solvable; eligibility never rode the vendor label); #48
  because the pinned-session + `homeFallback` re-check already compose "location context" and the callers
  are agents that sequence verbs — a wrapper tool would be renamed-boolean surface sprawl.
- **#48: option (C) + docs over (A) build or (C) pure.** Operator's explicit pick. Captures (A)'s
  cross-agent-reuse intent as a documented pattern at zero code/tool cost.

## What's Next — the epic is done; no active work item

**Epic #38 is fully closed. There is no pending epic work and nothing undeployed that affects prod.**
Future directions all live OUTSIDE this epic and none is approved/active:
- **Durability D-track** (from `[[obscura-durability-external-users-brainstorm]]`): D1 split
  front-door↔workers (keystone), D4 healthcheck + keys-apply pre-flight, D2/D3/D6. First spike = D1+D4.
- **External users (Track 2)** — a STRATEGY REVERSAL gated on the abuse/legal surface; confirm intent
  before any design.
- **Stealth Track A / credential-vault Track B** (`[[obscura-stealth-vault-brainstorm]]`), **PX/Total
  Wine tier** (deferred spike; out of epic scope), **interactive TUI** (north-star; operator wants a
  dedicated design session FIRST — do not draft unprompted).

Pick any of the above only on operator direction.

## Gotchas & Watch-outs

- **colima is STOPPED** (from the prior session). `colima start --vm-type vz --vz-rosetta` before any
  gate. Not needed for unit tests (pure Node) — this session ran `node --test` with no container.
- **main is 2 commits ahead of the prod image, intentionally.** Both are docs/test/comment
  (`prodDeployNeeded:false`). Do NOT trigger a deploy to "sync" — prod digest `4becdf0a` is authoritative
  and the deltas don't enter the image.
- **A docs merge to main rebuilds `:latest` to a new digest**, so latest-digest and prod-digest drift.
  Prod is pinned (manual `workflow_dispatch`); the recorded prod digest is authoritative.
- **Verify-and-close discipline paid off twice.** A HOLD ticket's own premise can go stale between
  filing and pickup — re-verify the premise against current code BEFORE building. Both #44 and #48'
  design docs had predicted their own likely resolution ("may be needless" / "(C) is acceptable").
- **Dangling-issue sweep when wrapping an epic.** #67 stayed OPEN because PR #69's title was `fix(#67):`
  with no `Closes #67` in the body — GitHub doesn't auto-close from the title. When closing an epic,
  cross-check every child/follow-up issue's state against what actually merged; a `fix(#N):`-titled PR is
  the usual straggler.
- **Codex runner** (unchanged, for when code work resumes): `codex exec review --base main`, detached
  (`nohup … &` + a `kill -0` watcher) — it now routinely exceeds the 600s Bash cap.
- **Public repo** — never commit fleet codenames; design docs with fleet detail stay `.local.md`.
