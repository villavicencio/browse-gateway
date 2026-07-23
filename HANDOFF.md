# HANDOFF — 2026-07-23, afternoon

Session arc: `/pickup` (same repo, day after the #66 session) → operator: "stop colima, then what's
next?" → picked the two **reliability HOLDs** per my recs → "go ahead with #54 Part 2 and #53" → both
**SHIPPED (13- and 12-round Codex loops) + one combined 6-leg gate + DEPLOYED**, then #53 **provisioned
and confirmed live in prod** (`obscura status` → `pool healthy`). Tree clean, no open PRs, main == prod.

## Prod state (CURRENT)

- **Prod: `sha256:4becdf0a…` = git `978cc89`** — the docs-commit rebuild of `:latest`; **functionally
  identical** to the gated `961e149d`/`754f6a8` (only delta is HANDOFF.md + a solution doc, and `docs/`
  is NOT COPYed into the image, so the 6-leg gate on `961e149d` fully covers it). Deploy run
  `30044094837` (2026-07-23 ~20:55Z) — also activated #53.
- **Rollback anchor: `sha256:961e149d…`** (= `754f6a8`, #54P2+#53 — the prior prod).
- **#53 is LIVE + confirmed:** `obscura status` shows `✓ pool healthy — force-kill armed, 0 unconfirmed,
  0/7 sessions` (prod `MAX_SESSIONS=7`). No further #53 action needed.
- main == `82cab58`.

## What We Built

- **#54 Part 2 — orphan reap + truthful capacity (PR #72, squash `9baaf0c`, 13-round Codex loop).**
  New `src/gateway/orphan-sweep.ts`: a never-resolving `launchPersistentContext` (no context, no PID —
  #50's post-resolve capture can't reach it) is now reapable because the gateway MINTS every ephemeral
  profile dir (`mkdtemp`), so its Chromium is findable by `--user-data-dir=<dir>` on the cmdline (plus
  cwd/fd references into the dir, for argless crashpad-shaped survivors). Sweep = observe-and-stamp per
  process GROUP (leader-generation preferred, revalidated) → group-SIGKILL → confirm via the #50 /proc
  start-time generation marker, with cross-attempt owed stamps and fail-CLOSED errno triage
  (EMFILE/EIO reject-and-retry, never read-as-exited). `session-manager.ts`: a live-orphan ledger
  counted in `activeCount` + the per-consumer cap until confirmed dead (activeCount may transiently
  exceed maxSessions — truthful back-pressure), a bounded uncounted **watch list** for still-pending
  wedges, and shutdown drains all of it. New getters `orphanCount`/`watchedCount`/`reservedCount`.
  Gate: `scripts/validate-teardown.mjs` Section F (real headful Chromium reaped by dir alone).
  Learning: `docs/solutions/architecture-patterns/reap-detached-process-by-owned-userdatadir.md`.
- **#53 — operator-tier /health surface (PR #73, squash `754f6a8`, 12-round loop, r12 clean).**
  `src/mcp/http-server.ts`: `GET /health` fail-closed tiers — rebind-Host guard → operator
  `BGW_HEALTH_TOKEN` (timing-safe, hashed-length compare) → consumer liveness → 401. The token
  authenticates NOTHING but /health; `http-main.ts` fails closed at boot if it collides with a consumer
  token. `buildOperatorHealth` derives ONE degraded verdict (force-kill unavailable OR unconfirmed>0 OR
  orphans>0; watch/capacity informational). CLI: `src/cli/{verify,status,config,brand,obscura}.ts` —
  `healthProbe` sends the token ONLY to a re-verified owned tunnel (credential-leak guard), `obscura
  status` renders the pool section; a degraded pool = **impaired** squinting owl `(o,~)` (distinct from
  down). `healthToken`/`OBSCURA_HEALTH_TOKEN` config.
- **846 tests** (from 788 at session start), 0 TS errors throughout. PRs #74/#75 = docs (handoff,
  solution doc, prod-state refresh).

## Decisions Made

- **Took the two reliability HOLDs (#54P2, #53), left the two site-shaped ones (#44, #48).** They form a
  coherent unit (#53 surfaces the counters #54P2 makes truthful); the site HOLDs are softer and need
  fixtures/product calls.
- **#53 = operator-only token (design option A).** Pool internals are cross-tenant telemetry; a
  dedicated `BGW_HEALTH_TOKEN` (not a consumer key — no manifest, no pool-sizing) keeps them off the
  consumer tier. Upgradeable to two-tier later without breaking the consumer contract.
- **#54P2 capacity model = count orphans truthfully, back-pressure.** `activeCount` includes live
  orphans and may transiently exceed `maxSessions` — the honest state; acquire refuses rather than
  stacking live browsers past the cap. Rejected: soft-headroom slack (invents a second cap) and
  don't-count (relies on pids_limit, the blunt backstop).
- **ROI stop on both loops (operator-directed).** When a loop's tail converged into same-theme
  permutations, fix the LAST finding AT ITS SOURCE (not another bolt-on) to close the theme, and stop
  paying for further permutations. #54P2 r13 (a 4-deep-rare reused-pgid/stale-stamp race) was
  documented as a scoped residual rather than chased.

## What Didn't Work

- **Bolt-on fixes spawned repeat rounds.** #53 r6→r10 were all the same mid-check-takeover output
  coherence issue; each round I patched one more output (verdict, then tunnel field, then gateway field)
  as a separate boolean, which just surfaced the next inconsistency. Only making the refreshed tunnel
  reading the AUTHORITATIVE state (r9/r10) closed the whole theme. Same shape on #54P2 (per-pid stamps →
  per-group; catch-any → errno-triage). Lesson recorded in Gotchas.
- **`codex exec review` as a plain `run_in_background` Bash** kept getting killed at the 600s harness
  cap (the review now routinely runs 8–12 min). Switched to `nohup … &` + a `kill -0` watcher.
- **A per-pid orphan stamp ledger** false-retained reclaimed groups (a non-leader entry's recycle check
  can never fire) — had to key stamps per process GROUP with a leader representative.

## What's Next — remaining epic #38 = TWO site-shaped HOLDs

Both have decision-ready design docs from 2026-07-22 (`docs/plans/2026-07-22-00{3,4}-*.local.md`):
1. **#44 Turnstile precedence** (HOLD #1) — `…-003-…`. Blocker: capture a CF managed-challenge fixture
   first; the doc flags the fix **may be needless** — verify whether only the vendor STRING is lost
   (`solverEligible` may already resolve `turnstile` → unsolvable correctly). **Cheapest remaining item.**
2. **#48 location primitive** (HOLD #2) — `…-004-…`. Recommends caller-supplied-steps choreography (not
   per-site recipes); (C) do-nothing is the acceptable fallback. Softest / most site-shaped.

The #54P2/#53 design docs (`…-001-…`, `…-002-…`) are **consumed** (both shipped).

## Gotchas & Watch-outs

- **colima is STOPPED** (stopped at session end). `colima start --vm-type vz --vz-rosetta` before any gate.
- **Codex runner:** `codex exec review --base main`, run **detached** — `nohup … > out 2>&1 &` + a
  `until ! kill -0 <pid>; do sleep 15; done` watcher (a plain `run_in_background` Bash dies at the 600s
  cap; the review often exceeds it). Parse the final `codex` text block from the out file. Sandbox EPERM
  on loopback `listen` / socket tests in its run are NOT real failures — verify locally.
- **ROI discipline (operator-reinforced):** long Codex loops converge into same-theme permutations in the
  tail. Fix the LAST finding AT ITS SOURCE (make the right thing authoritative), not as another bolt-on
  boolean — that closes the theme instead of spawning the next round. Stop once findings are same-theme
  micro-variants bounded by a backstop; document the residual.
- **Batched-gate recipe (now 6 legs):** verify `:latest` digest == intended commit, pull by digest,
  per-leg `docker run --rm --init --platform linux/amd64 --shm-size 1gb -e BGW_ATTEMPTS=1 -e
  BGW_REQUIRED=1 -e BGW_NO_SANDBOX=1 -e BGW_CHANNEL=chrome -e BGW_PROXY_*="$SPIKE_*" <img> node
  scripts/validate-{stealth,drive,failure-envelope,retrieve,call-budget,teardown}.mjs`. Stream in
  background, NO `| tail`. The **teardown leg is now part of the gate** (`--init` load-bearing; scripts
  ship in the image). `.env.spike` keys are `export`-prefixed (a bare `^[A-Z_]*=` grep misses them).
- **A docs merge to main rebuilds `:latest` to a new digest**, so prod-digest and latest-digest drift.
  Prod is pinned (deploy is manual `workflow_dispatch`); the recorded prod digest above is authoritative.
- **`BGW_HEALTH_TOKEN` provisioning is done** — but if it's ever rotated: set it in the prod env AND
  `healthToken` in `~/.config/obscura/config.json` to the SAME value, re-create the container (env is
  frozen at `docker run`; a plain restart won't do). A value that collides with a consumer token makes
  the gateway refuse to boot → deploy verify fails → auto-rollback (self-protecting).
- **Public repo** — never commit fleet codenames. Design docs with fleet detail stay `.local.md`.
