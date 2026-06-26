---
title: "PerimeterX press-&-hold login capture needs a plain Chrome, not an automation-launched browser"
module: "credential-capture + cli/obscura-vault"
date: 2026-06-26
problem_type: integration_issue
component: credential-capture
severity: high
symptoms:
  - "Capturing a logged-in session for the vault via the naive path (`playwright codegen --channel=chrome --save-storage=out.json <url>`) on a PerimeterX site loops the 'Press & Hold to confirm you are a human' challenge forever — it returns 'Please try again' and never clears, no matter how the human presses and holds"
  - "The same press-&-hold clears instantly in an ordinary Google Chrome opened by hand on the same machine"
  - "Even after a clean plain-Chrome capture, the imported session warm-opens LOGGED-OUT (redirects to /login): the cookie-only dump captured origins:0 — no localStorage — so a site that stores its auth token client-side has no session restored"
  - "Login-state probe against the wrong slug (`/account`) 404s and reads as 'logged-out' when the account is actually signed in"
root_cause: incorrect_assumption
resolution_type: workaround
related_components:
  - "docs/solutions/runtime-errors/perimeterx-blocks-linux-chrome-os-identity-windows-ua-fix.md"
  - "docs/solutions/integration-issues/perimeterx-200-iframe-challenge-false-negative.md"
  - "docs/solutions/architecture-patterns/vault-observability-redaction-gap.md"
  - "docs/solutions/architecture-patterns/nav-guard-redirect-bypass.md"
---

# PerimeterX press-&-hold login capture needs a plain Chrome, not an automation-launched browser

## Problem

Warm-open (consumer replay of a stored logged-in session) requires that a logged-in session be
**captured first** and imported into the credential vault. The obvious capture path — let Playwright
drive a real Chrome and save its storage state, e.g.
`playwright codegen --channel=chrome --save-storage=out.json <url>` — **cannot get past PerimeterX**
on a press-&-hold site such as `totalwine.com`. The "Before we continue… Press & Hold to confirm you
are a human" challenge loops indefinitely ("Please try again"), and the human operator never gets
through, so there is no logged-in session to dump. This blocks vault onboarding for every PX-gated
host.

## Symptoms

- `playwright codegen --channel=chrome` (or any Playwright/automation-**launched** Chrome) on a PX
  press-&-hold page: the gesture never clears. The operator pressed and held repeatedly and it never
  passed — the challenge just re-served "Please try again".
- An ordinary Google Chrome launched by hand clears the *identical* press-&-hold on the *same*
  machine on the first try.
- Even after a successful plain-Chrome capture, `obscura vault import` + warm-open comes back
  **logged-out** (the replay redirects `/my-account` → `/login`) — see the localStorage gap below.
- Probing login state on `/account` returns 404 ("Not Found"), which looks like "not signed in" but
  is a wrong-slug artifact, not a real logged-out state.

## What Did Not Work

- **`playwright codegen --channel=chrome --save-storage` (the documented capture recipe).** A
  Playwright-launched Chrome carries the automation surface (`--enable-automation`,
  `navigator.webdriver = true`, the CDP-launch markers). PX fingerprints that surface and refuses to
  let *even a real human* clear the press-&-hold — the human gesture is irrelevant because the block
  is keyed on the launch, not the input.
- **Pressing and holding harder / longer / more times.** No amount of human gesture clears it while
  the browser was automation-launched.
- **Reusing a previously-created isolated profile to skip re-login.** A reused `--user-data-dir` can
  **auto-log-in from a prior run**, so the capture grabs a stale/expired session shell, not a live
  token → warm-open later lands logged-out (see Prevention #1).
- **Cookie-only capture for a localStorage-auth site (still open).** `connectOverCDP` +
  `storageState` reliably dumps cookies (including httpOnly), but the dump captured **`origins: 0` —
  no localStorage**. Total Wine has no httpOnly session cookie (only `twm-cart`/`SERVERID`) and
  appears to hold its auth token client-side, so the cookie-only capture warm-opens **logged-out**
  even after a fresh, live sign-in. The plain-Chrome capture defeats PX *for the capture step*; it is
  not yet a complete-session capture for a client-side-auth site. See "Still open" below.

## Solution

Separate the two phases that the naive recipe fused: **log in as a human in a clean browser**, then
**read the state passively over a CDP attach**. Encapsulated in a `capture.sh` helper, Mac-side
(prod is headless, so capture must run on the Mac):

1. **Launch a plain Google Chrome with NO automation flags**, pointed at an isolated profile and a
   debugging port:

   `Google Chrome --remote-debugging-port=9222 --user-data-dir=<isolated-profile> <url>`

   This is a normal Chrome — no `--enable-automation`, no Playwright launch. PX sees an ordinary
   browser.

2. **Clear the Press & Hold as a human, sign in, and confirm the logged-in account.** Because this is
   a real Chrome, the gesture clears. Confirm login on the **authenticated** slug (e.g. `/my-account`),
   not `/account` (see Prevention #2).

3. **Attach READ-ONLY and dump the session** with `playwright-core`:

   ```js
   const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
   const ctx = browser.contexts()[0];
   await ctx.storageState({ path: 'out.json' });
   await browser.close(); // disconnects only — does NOT close the human Chrome
   ```

   `connectOverCDP` attaches to the already-running human browser; it does not relaunch and does not
   add automation flags. `browser.close()` on a `connectOverCDP` handle only **disconnects** — it does
   not close or disturb the human Chrome.

4. **Import into the vault** (the import strips the IP-bound `_px*` clearance tokens and keeps the
   durable cookies):

   `obscura vault import --consumer atlas --host totalwine.com --session out.json --creds creds.json --exit <8hex>`

## Why This Works

PX scores the browser's **automation surface at launch** — flags, `navigator.webdriver`, the
CDP-launch markers — and that score gates whether the press-&-hold is even passable. A
normally-launched Chrome has none of that, so a human can clear the gesture. Reading state over a CDP
attach is **passive instrumentation**: `connectOverCDP` + `storageState` observe an already-running
browser without relaunching it or flipping any automation flag, and disconnecting does not re-touch
the surface. So the captured cookies come from a genuinely clean human session — exactly what PX
would have minted for a real visitor.

This solves the *capture-past-PX* problem. It does **not** by itself guarantee a *complete* session —
`storageState` over `connectOverCDP` captured only cookies here, not localStorage (see below).

## Still open: localStorage auth not captured

The plain-Chrome capture clears PX and the warm-open *replay also clears PX* (confirmed in prod — the
page renders, no challenge), but the replay still lands **logged-out**. The captured `out.json` had
**125 cookies but `origins: 0`** (no localStorage), and Total Wine exposes **no httpOnly session
cookie** — the auth token is almost certainly held in `localStorage`, which the cookie-oriented dump
did not grab. Next step for full warm-open-login on a client-side-auth host: extend the capture to
**evaluate `localStorage` on the live logged-in page** (`page.evaluate(() => ({...localStorage}))`)
and fold it into the imported `storageState.origins`, rather than relying on `connectOverCDP`'s
`storageState` to enumerate it. (Verify first that the live logged-in page actually has an auth-looking
`localStorage` key.)

## Prevention

1. **Mint a live session, don't capture a stale shell.** A reused isolated `--user-data-dir` may
   auto-log-in from a prior session and yield an expired token. Before capturing, do an explicit
   **sign out, then a fresh sign in** (re-enter credentials) so the dump holds a live session.
2. **Probe login state on the real authenticated slug.** `totalwine.com/account` 404s because it is
   not a route; the signed-in page is `/my-account`. A 404 on the wrong slug looks like "logged-out"
   but is not — always verify against the actual authenticated path.
3. **Capture localStorage too for client-side-auth sites.** A cookie-only `storageState` (`origins:0`)
   silently drops localStorage; if the site has no httpOnly session cookie, the warm-open will be
   logged-out. Evaluate and include localStorage at capture time.
4. **Validation harness must close consumer-bound sessions on the success path too.** The warm-open
   validation script only called `browser_close` on the error path, so successful runs leaked
   consumer-bound drive sessions and repeated runs hit "per-consumer session limit reached (2)". The
   gateway's 5-min idle reaper (60s tick) eventually frees them, but the fix is to **always**
   `browser_close` before disconnecting.
5. **Capture is Mac-side, prod is headless.** This whole path lives on the Mac plus the obscura CLI;
   nothing here runs on the prod host.

> Once captured and imported, the *replay* must (a) clear PX through the gateway and (b) carry a
> complete session. PX-clearance on the gateway side is solved by the OS-identity presentation fix
> (related OS-identity doc) and the 200/iframe challenge-detection work (related PerimeterX-iframe
> doc) — both confirmed clearing in prod. The remaining logged-out symptom is the localStorage gap
> above, a *capture-completeness* issue, not a PX issue. Vault material on the observability/egress
> surface and redirect-boundary handling are tracked in the redaction-gap and nav-guard-redirect docs.
