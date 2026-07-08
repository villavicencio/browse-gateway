---
title: "PerimeterX hard-blocks (403) a warm-open whose first navigation is a deep authed URL — warm up on a shallow page first"
module: "mcp/drive-controller + verbs warm-open"
date: 2026-06-28
problem_type: runtime_error
component: warm-open-replay
severity: high
symptoms:
  - "Warm-open (vault-restored logged-in session) to https://www.totalwine.com/my-account returns status=403 on EVERY fresh residential exit; the gateway reports 'warm (logged-in) navigation … was blocked (status=403): the fresh residential exit was likely burned or unreachable — retry navigate to draw a clean exit' and a consumer retry loop burns 4+ exits all 403"
  - "The SAME warm session, same fresh exit, same Windows-UA, navigating the HOMEPAGE (https://www.totalwine.com/) instead returns 200 and a fully-rendered page — PX clears fine"
  - "After the homepage clears PX, navigating /my-account WITHIN THE SAME warm session returns 200 (no 403)"
  - "A logged-in landing shows url=/my-account + title 'Account Home'; a logged-OUT one REDIRECTS to /login + title 'Login My Account' (the reliable signal — body-text heuristics false-matched 3×)"
root_cause: incorrect_assumption
resolution_type: workaround
related_components:
  - "docs/solutions/integration-issues/perimeterx-login-capture-needs-plain-chrome-not-automation-launch.md"
  - "docs/solutions/runtime-errors/perimeterx-blocks-linux-chrome-os-identity-windows-ua-fix.md"
---

# PerimeterX hard-blocks a warm-open's first navigation to a deep authed URL — warm up on a shallow page first

## Problem

Warm-open replays a vault-restored logged-in session and navigates **directly to the requested URL**
as its first navigation. For Total Wine that target was the deep authed page `/my-account`. PerimeterX
returned **403 on every fresh residential exit**, and because the gateway can only see HTTP 403 for a
PX site, its fresh-exit heuristic labelled it "burned exit, retry" — so the consumer retry loop drew
exit after exit, all 403. It looked like an exit-reputation / proxy problem; it was not.

## Root cause

A warm-open's first request to a PX-protected **deep, authenticated** URL carries restored login state
but **no PerimeterX clearance token** (`stripIpBoundTokens` removes all `_px*` at import, by design —
they are IP-bound to the capture). PX treats a logged-in-looking request to a sensitive page with zero
clearance as high-risk and **hard-blocks (403)** rather than serving a passable challenge. A real user
never does this: they land on a shallow page (the homepage) first, where PX issues a clearance token,
*then* navigate to the account page carrying it.

This was proven by isolation, all on the same fresh residential exit + Windows-UA presentation:
- first-nav `/my-account` → **403** (every exit)
- first-nav `/` (homepage) → **200**, full page
- homepage **then** `/my-account` in the same warm session → **200**

So it is neither the exit pool, the residential proxy, nor the OS-identity fix (logs showed zero
OS-presentation failures; the homepage cleared PX). It is the **deep-URL-first** access pattern.

## Solution (proven)

**Warm up on a shallow same-origin page before the target.** Navigate the host root (`/`) first so PX
issues a clearance token into the live session, then navigate the real (deep) target within that SAME
warm session. End-to-end this lands logged-in: homepage clears PX → `/my-account` stays on `/my-account`
with title "Account Home" (the authenticated dashboard: Rewards, Profile & Settings, My Rewards).

Validated 2026-06-28 via a client-side two-step (`~/totalwine-onboarding/validate-warmup.mjs`):
warmup `https://www.totalwine.com/` → target `https://www.totalwine.com/my-account` → **Account Home,
logged in**.

### DONE (2026-07-07): warmup-nav is now server-side in the gateway

The client-side two-step is now a durable server-side capability. When a warm (vault-backed) session
opens on an owner host listed in `BGW_WARMUP_HOSTS`, the gateway navigates a shallow same-owner page
(`BGW_WARMUP_PATHS`, default `/`) FIRST — clearing the edge WAF into the live session — then the
consumer's real (possibly deep) target, which now carries the token. A single consumer `navigate` to a
deep authed URL just works; consumers no longer warm up manually.

Where it lives: `GatewayDriveController.#warmUpForTarget` → `#runWarmup` (`src/mcp/drive-controller.ts`),
run inside `#openWarmAndNavigate` AND the reopen-after-reap path (symmetric — a reaped warm session that
reopens is warmed up too, so long-lived sessions don't regress to deep-URL-first). Load-bearing invariants
held (verified in a 3-round Codex adversarial-review loop): runs AFTER the exit is pinned on the SAME
sealed bound session (R3 fail-closed unchanged); every hop targets only the SEALED owner host and passes
the credential-owner nav-clamp; it reuses the existing clearance detection/poll (a second call through the
same `core.navigate`); best-effort — a blocked hop never discards the session, and the target navigate
stays the authoritative gate (a stale login still fails LOUD). Config is flat env (`BGW_WARMUP_HOSTS`
reuses the force-proxy host-suffix parser; `BGW_WARMUP_PATHS` is fail-closed at boot on a non-relative
path). Runtime gate: `scripts/validate-vault-warm-open.mjs` gained a real-browser warm-up leg (shallow
root fetched before the deep target on one credentialed session).

**Deployment:** set `BGW_WARMUP_HOSTS=totalwine.com` (and optionally `BGW_WARMUP_PATHS`) in the prod env
file to activate for Total Wine. Unset = warm-up off everywhere (exact prior behavior).

**VALIDATED LIVE IN PROD (2026-07-08).** Activated (`BGW_WARMUP_HOSTS=totalwine.com`) + deployed, and the
real consumer (atlas) did a deep authed look-up in ONE `navigate`: `https://www.totalwine.com/p/91181175`
returned logged-in, location-scoped data (Folsom pickup store, aisle 07 / bay 23 / shelf 05, live price,
in-stock) — no client-side two-step. The account+location-scoped store/aisle detail confirms genuine
logged-in state, not an anonymous page. The deep-URL-first PX 403 is defeated end-to-end. TW is a
force-proxy host, so warm-open re-pinned the exit and the warm-up `/` cleared PX on it (atlas noted "worked
with forced proxy"). The green deploy also confirmed the fail-closed `parseWarmupPaths` boot guard passed
with the live config.

## Total Wine capture durability — CORRECTED 2026-07-08: lasts days+, NOT ~a couple hours

**The earlier "~a couple hours" claim was WRONG.** Corrected by a direct operator observation
(2026-07-08): a TW capture left **untouched for 7+ days** (across a work trip) warm-opened and landed
logged-in **first try**. So a captured session is durable for **at least ~7 days** (proven lower bound;
true upper bound unknown), and "capture once, automate for a week+" is the right model — which removes
the main reason-to-not-invest in TW warm-open.

Why the earlier claim was off (do not re-inherit it):
- It rested on ONE reading — `twSessionExpiration` was 108 min past on an old capture that landed
  logged-out (2026-06-28), plus one fresh capture that worked. n=2, and measured **before warmup-nav
  existed**, when a warm-open went deep-URL-first straight into a PX 403. So that "logged-out" verdict
  was plausibly the **deep-URL PX block misread as expiry**, not a truly dead session. Now that the
  homepage warm-up clears PX first, a week-old capture works.
- `twSessionExpiration` (localStorage) therefore does **not** govern the real login lifetime — don't
  gate replay decisions on it. The doc's old claim that TW has "no durable refresh/remember-me token"
  is also suspect: something keeps the session alive for a week+ (unidentified — a longer-lived cookie
  or a server-side session revived on the first cleared navigate). Re-inspect if it ever matters.
- Practical rule: if a warm-open lands logged-OUT, don't assume expiry — first confirm warm-up actually
  cleared PX (page loaded, not a 403), then check whether it's a genuinely different/older account
  state before re-capturing.

## Prevention / gotchas

- **Don't trust a body-text login heuristic** — `/my-account` "My Account" / "Sign In" strings
  false-matched a logged-out `/login` page (title "Login My Account") AND a logged-in one 3×. The
  reliable signal is the **landing URL + title**: logged-out REDIRECTS to `/login`; logged-in STAYS on
  `/my-account` ("Account Home"). The validate scripts now classify on URL/title first.
- **A 403 from a PX site is ambiguous** at the gateway — it cannot distinguish a burned exit from a PX
  block. If fresh-exit retries all 403 but the homepage 200s, suspect deep-URL-first, not the exits.
- **Replay FAST after capture** for short-session hosts; check `twSessionExpiration` before concluding a
  logged-out replay is a capture/restore bug — it may just be expiry.
