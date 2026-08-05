---
title: The input verbs emit no keystrokes and three untrusted surfaces — measured, not assumed
date: 2026-08-05
category: docs/solutions/architecture-patterns
module: browser/patchright-core, mcp/server, scripts/measure-input-realism
problem_type: architecture_pattern
component: input-path
severity: medium
applies_when:
  - "You are about to claim the gateway's input looks human to a behavioral-biometric vendor"
  - "You touch BrowserCore.click/type/selectOption/pressKey or the #act seam"
  - "You are deciding whether a driver's input layer needs a timing model on top of it"
---

## Problem

Every piece of stealth work in this gateway before now has been **fingerprint**-shaped: UA and
client-hint coherence, WebGL and WebRTC posture, the parity harness that diffs one environment
against another. The vendors actually on the target list are **behavioral-biometric** systems that
profile keystroke cadence, pointer trajectory, dwell time and event trustedness.

Nobody had ever checked what our input verbs emit. The working assumption — reasonable, and the
reason the driver was chosen — was that a patched Playwright fork produces genuinely trusted,
well-sequenced input. Issue #109 replaced the assumption with a measurement.

## What was measured

`scripts/measure-input-realism.mjs` drives a local fixture through the **real MCP verb path** — the
real stdio launcher, the real `PolicyEngine`, the real egress filter — and records every event the
page receives: `type`, `isTrusted`, `timeStamp`, coordinates, key identity. It then drives the same
fixture from page script (`el.click()`, direct `.value` assignment plus dispatched `Event`s) as a
**negative control**, and refuses to report any verdict unless the two runs are distinguishable on
the instrument.

Run in-container, headful under Xvfb, Chrome 151, Patchright 1.60.0. The control separated on five
axes, including `trustedKeyEvents` (0 for page script vs 6 for the real path) — a property page
script structurally cannot fake, which is what makes the keyboard channel validated rather than
merely counted.

## The finding

**All four questions came back NOT-ACCEPTABLE.** The driver's input layer is not one path; it is
three, and they do not behave alike.

| Verb / target | Mechanism | `isTrusted` | Keystrokes |
|---|---|---|---|
| `browser_type` → `text`/`email`/`password`/`search`/`tel`/`url`/`number`, `<textarea>` | injected `fill()` returns `"needsinput"` → `keyboard.insertText()` → CDP `Input.insertText` | **true** | **none** — whole string, one call |
| `browser_type` → `color`/`date`/`time`/`datetime-local`/`month`/`range`/`week` | `input.value = v` + `dispatchEvent(new Event(...))` from page context | **false** | none |
| `browser_select_option` | `option.selected = true` + `dispatchEvent(new Event(...))` from page context | **false** | none |
| `browser_click` | CDP `Input.dispatchMouseEvent` | true | n/a |
| `browser_press_key`, and the `submit: true` `press("Enter")` | CDP `Input.dispatchKeyEvent` | true | full sequence |

Measured numbers from the run:

- **Q1 trustedness — 6 of 50 verb-generated events carry `isTrusted === false`**, on
  `input[type=date]`, `input[type=range]` and `<select>`. `input[type=text]` (31 events) and the
  button (9 events) were entirely clean.
- **Q2 sequence completeness — `browser_type` over a 13-character string produced
  `keydown=0 keypress=0 keyup=0`, one `beforeinput`, one `input`, and a final value of length 13.**
  A detector counting keystrokes against value length sees the mismatch directly. The
  `submit: true` Enter is a *different mechanism* and emits a real trusted `keydown`/`keyup`.
- **Q3 timing — there is no inter-keystroke distribution, because there are no inter-keystroke
  intervals.** The absence *is* the reading: a cadence profiler gets an empty feature vector.
  Pointer dwell (`mousedown`→`mouseup`) had a median of **0.5 ms** — pressed and released inside
  the same millisecond.
- **Q4 pointer trajectory — every click teleports.** Two move events per click, spanning **0.85–0.97
  px**: `pointermove` reports sub-pixel coordinates and `mousemove` reports the integer ones, so it
  is one logical position at two precisions, not travel.

The click *sequence* is otherwise correct and trusted:
`pointermove → mousemove → pointerdown → mousedown → focus → pointerup → mouseup → click`.

## Why it matters

The comparative review that prompted epic #94 found a third-party "stealth browser" implementing
typing as a direct value assignment plus synthetic `input`/`change` events, while claiming to beat
these exact vendors. The epic asked whether we had made a quieter version of the same mistake.

We had, on two surfaces — and they are *literally* the same mechanism, not an analogue: the driver's
injected script assigns `.value` and dispatches page-context `Event`s for the set-value input types
and for `<select>`. The text path is better (it goes through the browser's own input pipeline, so
the `input` event is trusted) but it still emits **zero keystrokes**, which is the specific thing a
keystroke-cadence model reads.

## Resolution

**#94 does NOT close verify-and-close.** Its body predicted it probably would — the measurement says
otherwise, which is the entire reason the ticket existed.

- **#110 (the conditional timing model) SHOULD OPEN**, scoped to the **fill body only**. The
  `press("Enter")` path already produces a real keystroke and must not have a model bolted onto it
  a second time.
- The remedy is a driver-path change, not jitter on top of synthetic events: Patchright already
  ships the per-character path (`keyboard.type()` with a `delay` option). We simply do not call it —
  `BrowserCore.type()` calls `loc.fill(text)`.
- The whole input surface funnels through one seam, `#act(op, target, fn)` in
  `browser/patchright-core.ts`. That is where a remedy lands.
- **Nothing was changed in this work.** #109 is measurement-only by design, so that a remedy is
  designed against complete data rather than the first anomaly noticed.

## What this measurement does NOT say

- It is **not** a vendor test. "NOT-ACCEPTABLE" means "a self-evident tell was measured on a local
  fixture", never "this vendor blocks us". No challenge was cleared or failed here.
- The instrument reads `isTrusted`, event sequence, timing and coordinates. It does **not** model
  `movementX/Y`, `pressure`, `tiltX/Y`, path curvature, focus/idle rhythm, or cross-page history. A
  clean reading on these axes is not a clean reading on the axes it never looked at.
- The negative control proves separation from **one** shape of fakery. A more careful forger,
  dispatching full `mousedown`/`mouseup` pairs with plausible coordinates and jittered timings,
  would defeat every discriminator defined here.
- Headful-under-Xvfb is what was measured, and the mode is recorded in the output. One run cannot
  say whether headless differs.

## Gotchas for whoever picks this up

- **A text-only fixture reports a falsely clean Q1.** The untrusted branches only appear if the
  fixture contains an input from the set-value list *and* a `<select>`. The first draft of this
  fixture had neither.
- **"Distinct pointer positions ≥ 2" is not a travel test.** The first in-container run reported
  `travelled` off a 0.97 px span, because a sub-pixel `pointermove` and an integer `mousemove` are
  two distinct coordinate pairs. Q4 tests the widest *distance* between any two approach points
  against an 8 px threshold. Counting positions would have understated the finding.
- **Raw key-event counts cannot validate the keyboard channel.** A page-script control emitting
  `3 × (len + 1)` events collides exactly with a hypothetical per-character path emitting
  `3 × len + 3`. Trustedness is the property the control cannot fake; the count is not.
- **Run it in-container** (`docker run … node scripts/measure-input-realism.mjs`). It maps a
  synthetic hostname to loopback in `/etc/hosts` so the fixture is reachable with the real egress
  filter intact — `isBlockedEgressHost` never resolves DNS, so a non-loopback *name* passes while
  loopback *literals* stay blocked. The technique is for the fixture only; it is not a statement
  that loopback is reachable through the gateway.
- The script exits non-zero only when the **instrument** failed. An unflattering finding exits 0 —
  do not read `INSTRUMENT OK` as "we passed". #111 is the gate; this is the measurement.
