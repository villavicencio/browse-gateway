# HANDOFF — 2026-06-28 (Sunday)

> Operator traveling (overseas), low bandwidth until home Friday 2026-07-03. Nothing here is
> time-pressured.

**WIN: warm-open lands LOGGED-IN end-to-end on Total Wine — the parked task is DONE.** Proven live this
session: capture(+localStorage) → strip PX → import → fresh residential exit + Windows-UA → **warmup-nav**
→ `/my-account` "Account Home" (authenticated dashboard: Rewards, Profile & Settings, My Rewards). Two
new findings cracked it — a warmup-navigation requirement and a session-expiry constraint (below).

## What We Did

- **Shipped the localStorage capture fix** (last session's work): `dump-storagestate.mjs` enumerates
  localStorage per live frame; `inspect-localstorage.mjs` pre-capture gate. Captures now produce
  populated `origins` (was `origins:0`). Both wired into `capture.sh` / `capture-proxied.sh`.
- **Diagnosed the warm-open 403 → found it's NOT capture/localStorage.** Cookie-only (origins:0, the
  exact prior state) ALSO 403'd, ruling out localStorage. Prod logs showed ZERO OS-presentation
  failures (Windows-UA applies fine on warm), and the code fails-closed (throws) if it can't mint a
  residential exit — but we got a 403 *snapshot*, so the fresh residential exit + Windows-UA WERE
  engaged. The gateway was doing everything right.
- **Found the real cause: deep-URL-first.** A warm-open's first navigation to the deep authed URL
  (`/my-account`) carries login state but no PX clearance token (stripped) → PX hard-blocks 403.
  Proven by isolation on the same exit: `/my-account` first → 403; homepage `/` first → 200; homepage
  THEN `/my-account` in the same session → 200. **Fix = warmup navigation** (clear PX on a shallow page
  first, then the target). New solution doc:
  `docs/solutions/runtime-errors/perimeterx-warm-open-deep-url-403-needs-warmup-navigation.md`.
- **First logged-in attempt landed logged-OUT — because the captured session had EXPIRED**
  (`twSessionExpiration` 108 min in the past). TW login lives entirely in a short-lived `twSessionId`
  (localStorage, ~hours); NO durable refresh/remember-me token (every long-expiry cookie is
  analytics/consent; only httpOnly are `twm-cart` + `SERVERID`). A **fresh capture replayed fast**
  (28 min window) landed **logged-in** → full pipeline confirmed.
- **Closed loose end #2: store 1111 = Folsom, CA confirmed** — the account page renders "Pickup at
  Folsom, CA" from the restored store cookie.
- **Hardened the validate heuristic** — `validate-warmup.mjs` (and `validate-warm.mjs`) now classify
  login state on the **landing URL/title** (logged-out REDIRECTS to `/login` "Login My Account";
  logged-in STAYS on `/my-account` "Account Home"), not a body regex that false-matched 3×.
- **Tooling added** (in `~/totalwine-onboarding/`, OUTSIDE the repo): `validate-warmup.mjs` (two-step
  warmup-nav validation), `confirm-login.mjs` (full-page logged-in markers).

## What's Next

1. **Build warmup-nav INTO the gateway (durable fix).** Today the warmup is client-side (two
   `browser_navigate` calls). The gateway's warm-open should, on opening a warm session for a host,
   first navigate the host root (or a configured shallow path) to clear PX, THEN the requested target —
   so a single consumer `navigate` to a deep authed URL just works. See the warmup-navigation plan
   (`docs/plans/2026-06-24-001-warmup-navigation-plan.local.md`). This is a reviewed code change — fits
   the codex-review-loop SOP, best done with bandwidth (not mid-flight).
2. **Decide if TW warm-open is worth more investment** given the durability constraint: a capture is
   only good for a few hours (no refresh token), so this supports "capture now → automate for a few
   hours," not persistent login. Fine for short bursts; not a set-and-forget credential.

## Gotchas & Watch-outs

- **Replay FAST after capture** — check `twSessionExpiration`; a logged-out replay may just be an
  expired session, not a restore bug.
- **A PX-site 403 is ambiguous at the gateway** (can't tell burned exit from PX block). If fresh-exit
  retries all 403 but the homepage 200s → it's deep-URL-first, not the exits.
- **Login-state heuristics lie** — trust the landing URL/title, not body text.
- **Prod reads are operator-run or operator-authorized** — the token fetch + `docker logs` this session
  were explicitly authorized; the auto-mode classifier gates them otherwise.
- **Mac→prod `:8080` tunnel** must be up for the validate scripts; bootstrap:
  `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.dvillavicencio.browse-gateway-tunnel.plist`.
- Untracked `AGENTS.md` still parked (decide commit-or-leave when home).
- Local `main` ahead of origin by the doc commits this session; no open PRs.
