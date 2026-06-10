---
title: Drive verb fails "could not land a working proxied exit (403)" on a page that actually cleared — navigate() froze status at the CF interstitial's 403
module: browser/drive
date: 2026-06-10
problem_type: runtime_error
component: drive-controller
severity: high
symptoms:
  - "A consumer's drive/navigate fails with 'could not land a working proxied exit for <url> after N attempts (last status=403)'"
  - "The SAME image clears the target via a raw held-exit spike (which only checks isVisiblyBlocked, not status)"
  - "The page genuinely cleared the Cloudflare interstitial (real content rendered) but the gateway rotated/discarded the exit anyway"
root_cause: logic_error
resolution_type: code_fix
related_components:
  - patchright
  - cloudflare
  - proxy-escalation
tags: [drive, navigate, navFailed, cloudflare, interstitial, status, 403, isHardBlock, settle, detection-parity]
---

## Problem

After the stealth hardening that let Indexxx clear via a raw held-exit spike, a remote consumer
driving Indexxx through the gateway's `drive`/`navigate` verb still failed with
`could not land a working proxied exit … after 3 attempts (last status=403)`. The proxy, pool,
and fingerprint were all fine — the spike cleared 2–3/3. The gap was the drive path itself.

## Root cause

A Cloudflare interstitial answers the first navigation with **HTTP 403** (the challenge page),
then — once the challenge auto-solves — does a **full main-frame reload to 200** (the real page).
On Indexxx the main-frame responses were `307 → 403 → 200`.

Two compounding bugs in `PatchrightBrowserCore` (`src/browser/patchright-core.ts`):

1. **`navigate()` froze the status at the first goto response (403).** It captured
   `status = resp.status()` from the initial `page.goto()` and assigned
   `this.#lastDocStatus = status`, *overwriting* the active-page `response` listener (installed in
   `#ensureActivePage`) that was already tracking the last main-frame status. So after the 403→200
   clearance reload, the snapshot still reported **403**.
2. **`#settle()` exited on the blank inter-navigation window.** Its loop ran only
   `while (isVisiblyBlocked(signal))`; when the interstitial unloaded and the real document had not
   yet loaded, the page was momentarily blank (`document.body` null) — not "visibly blocked" — so
   the loop exited and the snapshot was taken on the **blank transitional page** (aria tree length
   ~10), missing the real content that landed ~3s later.

Then `navFailed` (`src/verbs/drive.ts`) called `isHardBlock(tree, status)` =
`status >= 400 && tree < MIN_CONTENT_LENGTH` → `403 + thin` → **true**. The drive escalation
treated the genuinely-cleared page as a hard block, discarded the working exit, and after
`PROXY_OPEN_ATTEMPTS` reported "could not land a working proxied exit (403)". The raw spike never
saw this because it only checks `isVisiblyBlocked` (title/text), ignoring status and thinness.

## How it was found

Probes on prod (gitignored `*.local.mjs`) running the REAL `core.navigate()` + `navFailed()`
through a proxied US sticky exit, logging every main-frame document response and re-sampling
content over time:
- main-frame responses `307 → 403 → 200`;
- at settle-exit (14s): `body` null, aria tree length 10, `status` 403 → `isHardBlock` true →
  `navFailed` true;
- +3s later: the real age-gate rendered (2193 chars body / ~3120-char tree).

## Resolution (PR #14)

- **`navigate()`**: stop capturing/overriding status from the goto's first response. Reset
  `#lastDocStatus = null` before the goto and let the active-page response listener track the last
  main-frame status *through* `#settle` (so a post-clearance 200 wins). A dead exit (no response)
  leaves it null → still a failed nav; a genuine hard 403 that never reloads keeps 403 → still
  failed (escalation/rotation intact).
- **`#settle()`**: after a block has been seen, wait until the page is genuinely non-thin
  (`isCleared(signal, MIN_CONTENT_LENGTH)` — the same thinness bar `isHardBlock` uses), not just
  non-blank, so it rides through the blank/residual transition instead of snapshotting it. Gated on
  `sawBlock`, so clean pages still return immediately (no added latency). Bounded by the clearance
  budget.

Verified on prod (baked image, US sticky exit): `status 200`, tree ~3.1k with actionable refs,
`isHardBlock false`, **`navFailed false`** — was `403 / tree 10 / true`.

## Takeaways

- **A CF interstitial's HTTP status is transient** — 403 then 200 after the reload. Never freeze a
  drive/render status at the first response; track the LAST main-frame navigation status.
- **"Challenge cleared" ≠ "page settled".** Clearing a full-reload interstitial leaves a blank
  window; wait for real (non-thin) content before snapshotting, or you capture the transition.
- **A passing raw spike can hide a verb-layer bug.** The spike checked a narrower signal
  (`isVisiblyBlocked`) than the production verb (`navFailed` = status + thinness + block phrase).
  Reproduce through the REAL code path, not just a convenience probe. See
  [[webgl-absent-under-xvfb-trips-interactive-turnstile]] for the fingerprint half of this saga.
