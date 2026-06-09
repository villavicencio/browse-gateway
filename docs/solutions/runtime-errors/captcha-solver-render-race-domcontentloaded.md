---
title: Interactive-CAPTCHA solver silently no-ops — detect fires at domcontentloaded, before the widget renders its response field
module: browser/captcha
date: 2026-06-09
problem_type: runtime_error
component: captcha-solver
severity: high
symptoms:
  - "The drive-path auto-solver never fires on real reCAPTCHA/Turnstile/hCaptcha widgets, even with a valid provider key and balance"
  - "No solve attempted: no provider (CapSolver) task is created, no error is logged, the page is left challenged"
  - "A form submit on the unsolved page is rejected ('Please verify that you are not a robot')"
  - "Detection logic looks correct and returns a valid challenge when probed AFTER the page fully loads"
root_cause: logic_error
resolution_type: code_fix
related_components:
  - drive-path
  - patchright
tags: [captcha, recaptcha, turnstile, render-race, domcontentloaded, async-widget, drive-path, solver, false-negative]
---

# Interactive-CAPTCHA solver silently no-ops — detection runs before the widget's response field renders

## Problem

The drive-path interactive-CAPTCHA solver (reCAPTCHA/Turnstile/hCaptcha) never attempted a solve on
real widgets: no provider task, no error log, page left challenged — indistinguishable at a glance
from "solver not configured." Environment, secrets, wiring, and provider balance were all correct.

## Root cause

A **render race**. `navigate()` resolves at `waitUntil: "domcontentloaded"`, then `#settle` runs
`#trySolveCaptcha` immediately. But an interactive widget injects its **response field**
(`g-recaptcha-response` etc.) from an **async** script that executes *after* `domcontentloaded`. So the
one-shot detect saw the widget **container** (`.g-recaptcha[data-sitekey]`) but **no response field
yet**.

The detector reported the field via `tokLen()` (`-1` absent / `0` empty / `>0` filled) but the gate
**collapsed it to a boolean** `responseEmpty = (tokLen === 0)`. That conflated two very different
states: "field absent (not rendered yet)" and "field filled (already solved)" both became
`responseEmpty: false` → `liveCaptchaToChallenge` returned `null` → `#trySolveCaptcha` bailed at
`if (!challenge) return false`. The only other detect pass is the next action, which for a form submit
re-navigates and re-races — so an async-rendered widget was **never** solvable.

The original code even documented the skip as intentional ("a missing field means the widget hasn't
rendered yet, so we skip") — correct only if a *later* detect pass would catch it. With detection
firing solely at `domcontentloaded`, "skip until next pass" silently became "never solve."

## Why it hid so long

The solver shipped validated against `solve()` in isolation and already-rendered widgets (the spike
harness), so the full `navigate → settle → detect` **timing** was never exercised end-to-end on the
HTTP/drive path. It only surfaced on the first real drive-path solve in production. A black-box probe
of the detection JS *after* page load returns a clean hit — which misleads, because the gateway checks
*pre-load*.

## Solution

Distinguish the tri-state and **poll out the render race** instead of one-shot skipping:

1. `DETECT_LIVE_CAPTCHA_JS` returns the raw `respLen` (`-1`/`0`/`>0`), not a boolean.
2. `liveCaptchaToChallenge` is solvable **only** on `respLen === 0` (present-and-empty).
3. `liveCaptchaPendingRender` is true **only** on `respLen === -1` with a sitekey — "container present,
   field not drawn yet," the one state worth waiting on.
4. `awaitSolvableCaptcha(detect, urlOf, wait, {pollMs, timeoutMs})` (pure, injected I/O): return as
   soon as the field renders empty; stop immediately when there's no widget or it's already filled
   (no speculative solve); give up after a short render budget (~2s) if a container never draws its
   field. `#trySolveCaptcha` wires `page.evaluate`/`page.url`/`page.waitForTimeout` to it.

## Prevention

- When a gate depends on **async-injected DOM** (CAPTCHA widgets, late-hydrated fields), never decide
  on a single read taken right after `domcontentloaded`. Either wait for the specific element or poll a
  bounded window — `domcontentloaded` is not "the page is interactive."
- Don't collapse a meaningful tri-state (absent / empty / filled) into a boolean at the detection
  boundary — keep "not ready yet" distinguishable from "nothing to do," or the wait logic can't exist.
- Exercise a capability through its **real entry path** end-to-end, not just its leaf function. The
  solve worked in isolation; the navigate→settle→detect *timing* was the untested seam.
- Observability gap that made this expensive: nothing logged whether the solver was even constructed,
  and the drive snapshot has no `captchaSolved` field — so diagnosis required reading code + a
  black-box probe. A `captchaSolver=on/off` boot line + a drive `captchaSolved` signal would have made
  it a one-liner (deferred follow-ups).
