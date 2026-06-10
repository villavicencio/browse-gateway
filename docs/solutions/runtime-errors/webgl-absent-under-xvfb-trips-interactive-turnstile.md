---
title: WebGL absent under Xvfb trips an interactive Cloudflare Turnstile — software-GL flags fix it, and a fingerprint-parity diff is how you find it
module: docker/browser
date: 2026-06-10
problem_type: runtime_error
component: browser-launch
severity: high
symptoms:
  - "A Cloudflare-protected target clears from a residential desktop but draws an INTERACTIVE Turnstile ('Verify you are human' / 'Performing security verification') from the datacenter VPS"
  - "Same residential proxy account, same clean exit pool, sticky held exit — still 0/15 from the VPS, ~6/6 locally"
  - "navigator.webdriver is false, WebRTC leak already closed, yet the challenge stays interactive"
root_cause: environment_divergence
resolution_type: config_fix
related_components:
  - patchright
  - cloudflare
  - xvfb
  - residential-proxy
tags: [webgl, swiftshader, xvfb, fingerprint, cloudflare, turnstile, parity, stealth, software-gl, headful, datacenter]
---

## Problem

`https://www.indexxx.com/` cleared locally (macOS, ~6/6) but drew an interactive Cloudflare
Turnstile from the prod VPS (0/15) — on the **same** residential proxy account and a clean
pool. The WebRTC IP leak had already been found and closed
([[webrtc-ip-leak-needs-managed-policy-not-launch-switch]]) and it still blocked, so the leak
was not the determining gate. A screenshot proved it was an *interactive* Turnstile, not a
passive auto-clearing "Just a moment…" interstitial — locally the widget auto-passes, on the
VPS it demands interaction.

## How we found the cause (the method is the lesson)

Built a **fingerprint-parity harness** (`src/browser/fingerprint.ts`,
`scripts/fingerprint-snapshot.mjs`, `scripts/fingerprint-diff.mjs`) that captures a browser's
cheap-to-read fingerprint axes (WebGL, timezone, locale, fonts, canvas, WebRTC, navigator,
screen) through the shipping core, and diffs two hosts — ranking each divergence high (likely
tell) / geo (must match the proxy exit) / info. Running it Mac ↔ VPS on the same build turned a
multi-hour guessing spike into a measurement. Top divergences:

| axis | desktop | prod VPS (before) |
|---|---|---|
| **WebGL** | `ANGLE (Apple M1 Pro)` | **`null` — no context at all** |
| timezone | `America/Los_Angeles` | `UTC` |
| fonts | 10 | 5 (`Liberation Sans` Linux tell) |

**WebGL absent** is the headline: under Xvfb with no GPU, Chrome 149 returns *no* WebGL context
(`canvas.getContext('webgl') === null`). A real desktop browser always has WebGL, and Turnstile
fingerprints it heavily — "WebGL missing" reads as automation/headless.

## Root cause

Chrome 149 gates the software (SwiftShader) WebGL fallback behind `--enable-unsafe-swiftshader`
(Google deprecated the automatic fallback for security). Without it, a GPU-less Xvfb host has no
WebGL at all. The original `buildLaunchOptions` set only `--no-sandbox` + the WebRTC arg, so the
production browser shipped with WebGL off.

## Resolution

Pin software-GL launch args in `buildLaunchOptions` (`WEBGL_SWIFTSHADER_ARGS`):

```
--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader
```

`--enable-unsafe-swiftshader` ungates the fallback; `--use-gl=angle --use-angle=swiftshader`
pins the backend explicitly rather than relying on Chrome's default GL picker. **Found
empirically** with an in-container flag-finder probe (baseline → `null`; this trio → a real
`ANGLE (… SwiftShader driver)` context). Applied unconditionally like the WebRTC policy — prod
is GPU-less and it keeps local dev a faithful fingerprint mirror; a real-GPU host should drop
them (real hardware WebGL is the better signal).

Shipped together (PR #13, `f3618b5`): `TZ=America/New_York` (+ tzdata + `/etc/localtime`) so the
wall clock matches the `_country-us` exit, and a richer font set
(`fonts-{dejavu,freefont-ttf,croscore,noto-core}`). A **webgl leg** was added to the stealth
kill-gate (`validate-stealth.mjs`) that FAILs on a null context, mirroring the webrtc leg, so a
regression to null is caught at build.

## Result

After deploy, the VPS fingerprint showed `webgl` non-null (SwiftShader), `timezone`
America/New_York, fontCount 7. Indexxx flipped from **0/15** to **~3/4** clears via the
held-exit probe — and the verdict reads "exit reputation/rotation was the whole problem":
once the fingerprint stops flagging, a clean exit clears the interstitial unaided. The
occasional miss is exit-quality variance on a held dirty exit, which the production escalation
ladder rotates past.

## Takeaways

- **A browser with no WebGL is a strong anti-bot tell.** Headful-under-Xvfb in a container does
  NOT give you WebGL for free on Chrome 149+ — you must force SwiftShader.
- **The command-line switch may be gated.** `--enable-unsafe-swiftshader` was required; assume
  Chrome may demote/gate stealth-relevant switches between versions (cf. the WebRTC switch).
- **Diff, don't guess.** "Clears locally / blocks in prod" is environment divergence; a
  fingerprint-parity diff names the axis in minutes. A clear locally proves nothing about a
  GPU-less datacenter host under Xvfb.
