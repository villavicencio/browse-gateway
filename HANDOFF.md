# HANDOFF — 2026-07-13

Fable session. Built the **server-side warm-up navigation** feature end-to-end (the durable fix for the
PerimeterX deep-URL-first 403 on vault warm-open), drove it through a 3-round Codex adversarial-review
loop to `approve`, shipped it to `main`, deployed + activated it in prod, and **validated it live** — the
real consumer (atlas) pulled a deep authed Total Wine product page in a single `navigate`. Then a live
observation forced a **correction of the long-standing "TW login lasts ~a couple hours" myth** (it lasts
days+), which a secret-safe cookie inspection confirmed and explained. `main == origin/main` at `94ab935`;
no open PRs; only untracked `AGENTS.md`.

## What We Built

- **Server-side warm-up navigation — SHIPPED + DEPLOYED + VALIDATED LIVE** (`5e832c8` feat, `2a6139f` +
  `bbb82d0` fixes; `069eb4d`/`5c0fb5c`/`94ab935` docs). When a warm (vault) session opens on an owner host
  in `BGW_WARMUP_HOSTS`, the gateway first navigates a shallow same-owner page (`BGW_WARMUP_PATHS`, default
  `/`) so PerimeterX mints a clearance token into the live session, THEN the consumer's real (deep, authed)
  target — which now carries the token instead of hard-403'ing. Moves the proven 2026-06-28 client-side
  two-step into the gateway; a single consumer `navigate` to a deep authed URL just works.
  - **Code:** `GatewayDriveController.#warmUpForTarget` → `#runWarmup` (`src/mcp/drive-controller.ts`), run
    in `#openWarmAndNavigate` AND the reopen-after-reap pinned path (symmetric). `#warmUpForTarget` is a
    bounded helper: on a mid-warm-up reap it reopens (re-pin R3) and re-warms the fresh session once, then a
    final `#ensureOpen` guarantees a live handle — bounded so it can't loop. `#runWarmup` reads owner host +
    proxy posture from instance state (`#warmHost`/`#proxiedSession`). Warm-up URL shares the target's
    scheme+port but pins the HOST to the sealed owner.
  - **Config:** flat env — `BGW_WARMUP_HOSTS` reuses `parseForceProxyHosts`; `BGW_WARMUP_PATHS` is a NEW
    fail-closed-at-boot parser (`parseWarmupPaths`, `src/verbs/escalation.ts`, exported via `verbs/index`).
    Wired in all 3 entrypoints (`runtime.ts`, `http-main.ts`, `main.ts`). Dormant unless `BGW_WARMUP_HOSTS`
    is set.
  - **Verified:** 534/534 unit tests (`test/warmup.test.mjs`, 16 new); runtime gate
    `scripts/validate-vault-warm-open.mjs` gained a real-browser warm-up leg (shallow root fetched before
    the deep target on one credentialed session; PASS on this Mac, off-host legs skip — full in-container).
- **Codex adversarial-review loop → `approve`** (3 rounds via `codex-companion.mjs adversarial-review
  --wait --base main --scope branch`). Rounds 1 and 2 each caught a REAL gap self-review missed: R1 — the
  reopen-after-reap path skipped warm-up (a reaped warm session would 403 deep-URL-first + surface a
  misleading "re-capture" error); R2 — a handle-loss DURING warm-up reopened without re-warming the fresh
  session. Both fixed via the bounded shared `#warmUpForTarget`. R3: no material findings.
- **Prod deploy + activation.** Operator set `BGW_WARMUP_HOSTS=totalwine.com` in the server env file
  BEFORE running `gh workflow run deploy-http.yml` (run 28978514784) → green deploy (gate/smoke passed,
  clean swap). The green deploy also proves the `parseWarmupPaths` fail-closed boot guard passed with the
  live config.
- **LIVE VALIDATION (2026-07-08).** atlas did a deep authed TW look-up in ONE `navigate`:
  `https://www.totalwine.com/p/91181175` → logged-in, location-scoped result (Woodford Reserve 1.75L,
  Folsom pickup, aisle 07 / bay 23 / shelf 05, live $53.99, in-stock). Account+location-scoped data =
  genuine logged-in state. Deep-URL-first PX 403 defeated end-to-end. atlas noted "worked with forced
  proxy" (TW is a force-proxy host → warm-open re-pinned the exit, warm-up `/` cleared PX on it).
- **TW capture-durability myth CORRECTED** (`94ab935`, + memory). See "Gotchas." A ~10-day-old capture
  warm-opened logged-in first try; `twSessionExpiration` and the `SERVERID` httpOnly cookie were BOTH
  expired ~10 days by then. So the login is durable for days+ (proven lower bound ~10d), NOT the old
  "~a couple hours" claim. Corrected the solution doc + `warmup-nav-shipped` memory.
- **Secret-safe cookie durability inspector** (scratchpad `tw-durability.mjs`, NOT committed — reads a
  captured storageState and emits ONLY names / expiry timestamps / decoded JWT `exp`-`iat`, never token
  values). Used it to identify what actually persists the TW login (see Gotchas).
- **Memory hygiene:** created `warmup-nav-shipped.md` (+ MEMORY.md pointer); deleted the stale
  `operator-traveling-low-bandwidth-2026-06-28.md` (return date long passed).

## Decisions Made

- **Treated the plan's `KILLED` banner as superseded.** `docs/plans/2026-06-24-001-warmup-navigation-plan.local.md`
  says KILLED, but that kill came from a falsification run on atlas's stale/burned bound exit (§8 admits the
  confound); the 2026-06-28 solution doc + this task both direct the build. Built the plan's §2 design + §7
  MVP cut.
- **Dwell-free minimal warm-up.** The plan §7 kept dwell+scroll; §8 falsified the behavioral-trust theory,
  and the proven fix is just `nav(/) → nav(target)`. Implemented the proven minimal (no dwell, no scroll).
- **Flat env, not per-host JSON** (§7 MVP cut): `BGW_WARMUP_HOSTS` + `BGW_WARMUP_PATHS`, default `["/"]`.
- **Bounded shared helper `#warmUpForTarget`** (Codex R2 recommendation) so first-open and reopen-after-reap
  can't diverge — the source of both R1 and R2 gaps was two divergent warm-up paths.
- **Landed direct to `main` via fast-forward** (per `authorized-to-push-main`; validated + dormant-by-default
  = safe). Left **activation** (setting `BGW_WARMUP_HOSTS` in prod) to the operator — it's a prod-env change.
- **Corrected the durability doc rather than leaving the wrong claim**, and did the cookie analysis locally
  with metadata-only output — never pasting the live TW credential into the transcript.

## What Didn't Work / Ruled Out

- **Plan §7 dwell + scroll behavioral theory** — falsified in §8; the proven fix is dwell-free. Not built.
- **Hardcoding `https://${owner}` with no port in the warm-up URL** — the first gate run caught it (the
  warm-up hop hit `https://127.0.0.1/` against an http-on-random-port fixture, failed, fell through). Fixed:
  warm-up shares the TARGET's scheme+port while pinning the host to the sealed owner.
- **`twSessionExpiration` as a validity signal** — it's a RED HERRING. Expired ~10 days ago in the working
  capture. Do not gate replay decisions on it (prior sessions did; it's wrong).

## What's Next

1. **Decide on untracked `AGENTS.md`** — public-safe near-dupe of the CLAUDE.md project instructions,
   untracked across many sessions now. Commit or remove. (The one loose end in the working tree.)
2. **Audit follow-up #2 (still open, RECOMMENDED): wrap drive session-*open* / `fail()` in `redactSecrets`.**
   `openConsumerSession` → launch + warm-cookie restore is outside the controller's `#run` scrub
   (`src/mcp/server.ts`, `src/gateway/index.ts:160`); neutralized today only by a static re-wrap in
   `session-manager.ts:111` — fragile to one refactor. Small, non-breaking. Details in
   `audit/FABLE-AUDIT-REPORT.md` #2 (LOCAL ONLY).
3. **Audit follow-up #6:** one-line guard so a `*.www.<domain>` allowlist rule isn't www-stripped into
   `*.<domain>` (`src/policy/allowlist.ts:40`), or lint it. Operator-authored config footgun, Low.
4. **Optional — liveness-probe tool** (offered, not built): a one-shot "is atlas's TW login still alive?"
   check (warm-open `/my-account`, report alive/dead by landing URL/title). Because TW validity is
   server-side, a probe is the only reliable check — there's no offline expiry to trust.
5. **Optional — tighten the durability doc** to name `REMEMBER_ME` as the likely persistence mechanism
   (currently marked "suspect"/inferred). Concrete evidence found (see Gotchas).
6. **Optional observability — add `warmup=[...]` to the http-main listening banner** so activation is
   visible at a glance (today only `datacenter=`/`sticky=` are logged; there's no boot line for warm-up).

## Gotchas & Watch-outs

- **Env vars are read at container LAUNCH** (`launch-http.sh` sources the env file), NOT live. A new
  `BGW_WARMUP_*` only takes effect on the next deploy/restart. (This caused a brief "is it dormant or
  active?" confusion this session — the operator had set it BEFORE the deploy, so it shipped active.)
- **TW capture durability is days+ (proven ~10d), NOT ~hours** — the OLD claim (prior handoff #5, old
  solution-doc section) is WRONG and now corrected. **Do not gate on `twSessionExpiration`** — it and the
  `SERVERID` httpOnly cookie were both expired ~10 days in the working capture. What actually persists the
  login: localStorage `twSessionId` + `CSID` + **`REMEMBER_ME`** (the latter refutes the old "no durable
  refresh/remember-me token" claim), re-validated **server-side** on the first cleared navigate. Every
  390-day cookie in the blob is analytics/adtech (Adobe/Forter/Bloomreach/DoubleClick/Dotomi/AdRoll), not
  auth.
- **If a warm-open lands logged-OUT, don't assume expiry first** — confirm warm-up actually cleared PX
  (page LOADED, not a 403). A genuine expiry redirects to `/login` ("Login My Account"); a warm-up failure
  is a 403/press-&-hold with no page. Classify on landing URL/title, never body text.
- **No boot-banner line for warm-up config** — to confirm activation, check the running container's env
  (`grep WARMUP`) or watch stderr for a `warm-up: https://www.totalwine.com/ → ok` line on a warm-open.
- **Warm-up is dormant unless `BGW_WARMUP_HOSTS` is set; it is currently SET to `totalwine.com` in prod
  (ACTIVE).** Unset = exact prior behavior everywhere.
- **Never paste a live captured session into the chat** — it's a credential; the gateway's whole design
  keeps secrets out of logs/context. Use the scratchpad `tw-durability.mjs` (metadata-only) to inspect a
  capture's durability without exposing values.
- **"Is the gateway down?" is almost always the local `:8080` tunnel** — verify the container +
  `curl 127.0.0.1:8080/mcp` (401 = healthy) first. Self-healing keeper recovers within ~1–2 min.
- **Prod reads/interactions (SSH, `docker logs`, env greps, live warm-open) are gated by the auto-mode
  classifier** — operator runs them or authorizes the agent per-session.
- **Fleet hygiene (public repo):** never commit prod host/alias/env-path/consumer tokens.
- **Carry-over:** `audit/FABLE-AUDIT-REPORT.md` is LOCAL ONLY (gitignored) — not on origin, won't survive a
  fresh clone.
