# HANDOFF — 2026-07-23

Session arc: `/pickup` (same repo, next day) → operator: **"stop colima, then what's next?"** → picked the
two reliability HOLDs per my own recs → **"go ahead with #54 Part 2 and #53"** → **both SHIPPED (13- and
12-round Codex loops) + one combined 6-leg gate + DEPLOYED to prod.** Tree clean, no open PRs, main == prod.

## Prod state (CURRENT)

- **Prod: `sha256:4becdf0a…` = git `978cc89`** (the docs-commit rebuild of `:latest`; **functionally
  identical** to the gated `961e149d`/`754f6a8` — the only delta is HANDOFF.md + a solution doc, and
  `docs/` is NOT COPYed into the image, so the 6-leg gate on `961e149d` fully covers this). Deploy run
  `30044094837` (2026-07-23 ~20:55Z) — this run also **activated #53** (picked up `BGW_HEALTH_TOKEN`).
- **Rollback anchor: `sha256:961e149d…`** (= `754f6a8`, #54P2+#53 — the prior prod).
- Gate evidence (on `961e149d`, the equivalent image): stealth (CF 1/1, DataDome 1/1, WebRTC/WebGL/
  secret-leak/negative-control), drive, failure-envelope (1 benign note: cleared CF → no wafVendor),
  retrieve, call-budget, **teardown 21/21 incl. Section F (the #54P2 orphan sweep vs a real headful
  Chromium reaped by userDataDir alone)**.

## #53 ACTIVATED + confirmed in prod (2026-07-23 ~20:55Z)

`BGW_HEALTH_TOKEN` set in the prod env + `healthToken` in `~/.config/obscura/config.json`; container
re-created via deploy run `30044094837` (verify OK, no rollback → the token did NOT collide with a
consumer). **End-to-end confirmed:** `obscura status` now shows
`✓ pool healthy — force-kill armed, 0 unconfirmed, 0/7 sessions` (prod `MAX_SESSIONS=7`). The
`force-kill armed` line is the meaningful one — the #50 PID-capture primitive is proven working on the
LIVE prod build (previously only in container stderr). A degraded pool would render impaired
(`(o,~)`, nonzero exit). **No further #53 action needed.**

## What shipped this session

- **#54 Part 2 — orphan reap + truthful capacity (PR #72, `9baaf0c`).** Gateway mints every ephemeral
  profile dir (`mkdtemp`) so a never-resolving launch's Chromium is findable by `--user-data-dir=<dir>`
  (cmdline + cwd/fd refs); `gateway/orphan-sweep.ts` group-SIGKILLs + confirms via the #50 generation
  marker, cross-attempt owed stamps. Live-orphan ledger counted in `activeCount`+consumer cap;
  bounded uncounted watch list for still-pending wedges; `orphanCount`/`watchedCount`/`reservedCount`
  getters. **13-round Codex loop** (all TOCTOU/accounting; r13 = a 4-deep-rare residual documented, scoped
  out per ROI). Learning: `docs/solutions/architecture-patterns/reap-detached-process-by-owned-userdatadir.md`.
- **#53 — operator-tier /health (PR #73, `754f6a8`).** `GET /health` fail-closed tiers (rebind-Host →
  operator token timing-safe → consumer liveness → 401); the health token authenticates nothing but
  /health; boot-guard on token collision. `obscura status` sends the token ONLY to a re-verified owned
  tunnel (credential-leak guard), renders the pool section, degraded = impaired owl. **12-round Codex loop**
  (r1–r5 substantive incl. the credential-leak P1; r6–r10 takeover-output coherence fixed at source;
  r11 contract fix; **r12 clean/approved**).
- **846 tests** total (from 788 at session start), 0 TS errors.

## What's Next — remaining epic #38 work is TWO operator HOLDs

Both have decision-ready design docs from last session (`docs/plans/2026-07-22-00{3,4}-*.local.md`):
1. **#44 Turnstile precedence** (HOLD #1) — `…-003-…`. Blocker: capture a CF managed-challenge fixture
   first; the doc flags the fix **may be needless** (verify whether only the vendor STRING is lost —
   `solverEligible` may already be correct). Cheapest remaining item.
2. **#48 location primitive** (HOLD #2) — `…-004-…`. Recommends caller-supplied-steps choreography (not
   per-site recipes); (C) do-nothing is the acceptable fallback. Softest / most site-shaped.
The #54P2 and #53 design docs (`…-001-…`, `…-002-…`) are now **consumed** (both shipped).

## Gotchas & Watch-outs

- **colima is RUNNING** (started this session for the gate). Stop it for the RAM if you want.
- **Codex runner:** `codex exec review --base main`. It now regularly exceeds the 600s Bash timeout — run
  it **detached via `nohup … > out 2>&1 &`** + a `until ! kill -0 <pid>; do sleep 15; done` watcher
  (a plain `run_in_background` Bash still gets killed at 600s). Parse the final `codex` text block from the
  out file. Sandbox EPERM on loopback `listen` / the socket tests in its run are NOT real failures.
- **ROI discipline paid off:** both loops converged into same-theme permutations in their tails (#54P2
  r10–r13 TOCTOU micro-variants; #53 r6–r10 takeover-output coherence). Fixing the LAST one **at its
  source** (not as another bolt-on boolean) closed the theme instead of spawning the next round.
- **Batched-gate recipe unchanged** — verify `:latest` digest, pull by digest, per-leg `docker run --rm
  --init --platform linux/amd64 --shm-size 1gb -e BGW_ATTEMPTS=1 -e BGW_REQUIRED=1 -e BGW_NO_SANDBOX=1
  -e BGW_CHANNEL=chrome -e BGW_PROXY_*="$SPIKE_*"`, stream in background, NO `| tail`. The **teardown leg
  is now part of the gate** (scripts ship in the image; `--init` is load-bearing for it). `.env.spike`
  keys are `export`-prefixed.
- A `homeFallback`/`responseReceived`/`wafVendor`/`orphanCount`/`deadlineTruncated` value can be
  occasionally-imprecise on exotic edges — diagnostics. (`orphanCount`/`activeCount` gate admission — by
  design truthful-but-strict; a documented residual can transiently misaccount under a 4-rare-event stack.)
- **Public repo** — never commit fleet codenames. Design docs with fleet detail stay `.local.md`.
