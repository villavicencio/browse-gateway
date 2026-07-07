# HANDOFF — 2026-07-07 (Tuesday)

Continuation of the Total Wine warm-open arc. The headline win (warm-open lands LOGGED-IN end-to-end)
was proven 2026-06-28; since then this session was operational: two "is the gateway down?" checks
(06-30, 07-06) that were really a dropped local tunnel, then a proper root-cause + fix of the tunnel
keeper so it stops masquerading as gateway outages, and a `/ce-compound` capturing that fix. Repo is
docs-only changes; `main == origin/main` at `11cfc65`; no open PRs.

## What We Built

- **Tunnel keeper made self-healing (`11cfc65` documents it; the keeper itself is Mac-local, not in the
  repo).** Root cause: `~/Library/Application Support/browse-gateway-tunnel/tunnel-keeper.sh` had a
  self-DISABLE valve — after 10 consecutive fast-fails (<30s) it ran `launchctl bootout` on itself, then
  stayed fully unloaded until a manual `bootstrap`. The log showed **7 self-disables in 3 weeks (5 in the
  last 10 days of travel)**, all from transient offline (`Could not resolve hostname …` / `… port 22:
  Operation timed out` on plane/hotel/captive-portal/VPN-down). Fixed: rewrote the keeper to **never boot
  out** — classifies `offline` (cap 60s) vs `config` (cap 300s + loud log) vs `unknown` (cap 120s), quick
  retries for the first 3 fast-fails then escalating capped backoff, KeepAlive keeps retrying so it
  self-heals when prod is reachable. Backup at `tunnel-keeper.sh.bak-selfdisable` (revert = cp it back).
  Verified: `sh -n` clean, classifier dry-run maps both real log strings → `offline`, live tunnel
  undisturbed (new logic applies next cycle).
- **Solution doc (`11cfc65`, on main):**
  `docs/solutions/integration-issues/ssh-tunnel-keeper-self-disable-never-recovers.md` — via `/ce-compound`
  (Full mode, 3 parallel subagents, LOW overlap, frontmatter-validated, fleet-hygiene-clean placeholders).
- **Updated `TUNNEL.local.md`** (gitignored) + the `durable-tunnel-launchagent` memory to the new
  self-healing behavior (both previously said "self-disables").
- **Gateway health confirmed twice** (06-30, 07-06): container `Up 9 days, 0 restarts`, serving HTTP 401
  in ~3ms on the prod loopback, actively handling `vault` + `atlas` sessions. Each "down?" was the local
  `:8080` tunnel, not the gateway — bootstrapped it both times.

### From earlier this arc (still the headline, context for What's Next)

- **Warm-open lands LOGGED-IN end-to-end on Total Wine** (`72dc68b`, proven 2026-06-28): `/my-account`
  "Account Home" dashboard. Cracked by (1) the **localStorage capture fix** (`dump-storagestate.mjs`
  per-frame enumeration + `inspect-localstorage.mjs` gate — captures now have populated `origins`), and
  (2) **warmup navigation** — a warm-open's first nav to a deep authed URL carries login but no PX
  clearance token → hard 403; hit the homepage first (PX issues a token), then the deep URL in the same
  session. Full writeup:
  `docs/solutions/runtime-errors/perimeterx-warm-open-deep-url-403-needs-warmup-navigation.md`.

## Decisions Made

- **Tunnel: capped backoff over terminal disable.** The self-disable's intent (don't reconnect-storm a
  dead VPS) is preserved by a capped retry (≤60s offline / ≤300s config) — not a storm — while staying
  loaded so it self-heals. A terminal `bootout` with only manual recovery is a silent outage on the next
  transient failure; that trade was wrong for a laptop that travels.
- **Solution doc = `integration-issues`, not a new `developer-experience` category** (would require a new
  dir; the repo has only architecture-patterns/integration-issues/runtime-errors).
- **Deferred a repo-wide `CONCEPTS.md` bootstrap.** `/ce-compound` correctly found no qualifying domain
  nouns in the tunnel/ops area to seed; the rich vocab (consumer, gateway, warm-open, vault, fresh-exit,
  drive verbs) is a deliberate `ce-compound-refresh` bootstrap job, not a scoped-run side effect.

## What Didn't Work

- **Hand-bootstrapping the tunnel each time** — a treadmill; it re-disabled on the next offline stretch.
- **Suspecting the gateway/container on a "down" report** — a red herring every time (container healthy).
  The dead-tunnel-misread-as-dead-gateway confusion has now recurred 3×; the solution doc's Prevention
  says verify the server (container + loopback probe) before touching the client.

## What's Next

1. **Build warmup-nav INTO the gateway (the durable fix for warm-open-login).** Today warmup-nav is
   CLIENT-side (two `browser_navigate` calls in `~/totalwine-onboarding/validate-warmup.mjs`). The
   gateway's warm-open should, on opening a warm session, first navigate the host root (or a configured
   shallow path) to clear PX, THEN the requested target — so a single consumer `navigate` to a deep authed
   URL just works. Plan: `docs/plans/2026-06-24-001-warmup-navigation-plan.local.md`. This is a reviewed
   code change (codex-review-loop SOP) — needs real bandwidth, not a mobile/travel session.
2. **Weigh whether TW warm-open is worth that build** given the durability constraint: TW login is a
   short-lived `twSessionId` (localStorage, ~hours) with NO durable refresh/remember-me token, so a
   capture is only good for a few hours ("capture now → automate a few hours," not persistent).
3. **Decide on untracked `AGENTS.md`** — a public-safe near-duplicate of the CLAUDE.md project
   instructions, sitting untracked in the tree across several sessions. Commit it or remove it.

## Gotchas & Watch-outs

- **"Is the gateway down?" is almost always the local `:8080` tunnel.** Verify the container +
  `curl 127.0.0.1:8080/mcp` (401 = healthy) before touching anything. Bootstrap the tunnel:
  `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.dvillavicencio.browse-gateway-tunnel.plist`.
  With the self-healing keeper, it should now recover on its own within ~1–2 min of a network return.
- **Prod reads (SSH, `docker logs`, env-file greps) are gated by the auto-mode classifier** — operator
  runs them, or explicitly authorizes the agent per-session (both happened this session).
- **Replay a TW capture FAST** — check `twSessionExpiration` before concluding a logged-out warm-open is a
  bug; it may just be an expired session.
- **`validate-warm*.mjs` classify login on the landing URL/title** (logged-out redirects to `/login`
  "Login My Account"; logged-in stays on `/my-account` "Account Home") — the old body-text heuristic
  false-matched 3×.
- **Fleet hygiene (public repo):** never commit the prod host/alias/env-path/consumer tokens. The tunnel
  solution doc uses `<prod-host>` placeholders on purpose.
- Local `main == origin/main` (`11cfc65`); no open PRs; only untracked `AGENTS.md`.
- **Memory note:** `operator-traveling-low-bandwidth-2026-06-28` is stale (return date 2026-07-03 has
  passed) — safe to delete on the next memory pass.
