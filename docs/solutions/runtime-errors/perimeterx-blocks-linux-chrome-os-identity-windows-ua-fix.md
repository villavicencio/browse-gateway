---
title: PerimeterX 403s the gateway because it presents as Linux Chrome — an opt-in per-host Windows OS-presentation override clears it
module: browser/os-presentation + browser/patchright-core
date: 2026-06-26
problem_type: runtime_error
component: browser-launch
severity: high
symptoms:
  - "A PerimeterX-protected target (Total Wine) 403s ('Access to this page has been denied') from the prod VPS / Docker container even through a clean, fresh residential exit"
  - "The SAME residential exit IP clears (200) from a Mac Patchright and 403s from the container — IP and cookies held constant"
  - "Survives every fingerprint fix tried: SwiftShader WebGL renderer-string spoof, fake media devices (--use-fake-device-for-media-stream), 1920x1080/native window size, re-enabled WebRTC — all still 403"
  - "navigator.webdriver false, window.chrome present, canvas/audio coherent — none of the usual headless tells"
root_cause: environment_divergence
resolution_type: config_fix
related_components:
  - src/browser/os-presentation.ts
  - src/browser/patchright-core.ts
  - src/gateway/config.ts
  - src/security/url.ts
---

## Problem

`U9` consumer warm-open (atlas → `www.totalwine.com`) and any retrieve/drive to the host 403'd with
PerimeterX's "Access to this page has been denied" — from the prod VPS and from a local Docker
container of the shipping image, even on a freshly-minted clean residential exit. A Mac Patchright on
the *same exit* cleared. The long-standing assumption (carried in the handoff and `launch-options.ts`)
was a WebGL/Xvfb fingerprint tell.

## How it was found (the method matters)

The decisive move was a **same-exit A/B**: PerimeterX is exit-IP-reputation gated, so any fingerprint
comparison MUST hold the exit IP constant or reputation noise swamps the signal. Pinning one IPRoyal
sticky session (`PROBE_EXIT_ID`) and running the Mac and the container through it back-to-back gave a
clean contrast — Mac CLEARED, container BLOCKED on the identical IP — proving the differentiator is the
**browser fingerprint, structurally not the exit**.

A local Docker container (same `linux/amd64` image as prod) reproduced the 403 deterministically, so
the whole diagnosis ran on the Mac with no prod access — a fast fix loop. Then, by **elimination on
same-exit A/Bs** (each candidate fixed in isolation, with a Mac positive-control proving the exit was
good):

- **WebGL/SwiftShader — exonerated.** The gateway forces software GL (`--use-angle=swiftshader`) on Mac
  too; the Mac cleared *with* SwiftShader, and a renderer-string spoof did not flip the container.
- **mediaDevices, screen size, window geometry, WebRTC — exonerated.** Populating fake devices, setting
  1280×900/1920×1080, healthy `outerH≠innerH`, and re-enabling WebRTC (srflx present) each still 403'd.
- **timezone — exonerated.** The Mac cleared with `America/Los_Angeles` on an exit where the container
  blocked with `America/New_York` — TZ-coherence is not the deciding signal.

What remained was the **OS identity**. Flipping ONLY the OS — UA string + `navigator.platform` +
`userAgentData`/client-hints → Windows, via CDP `Emulation.setUserAgentOverride`, leaving Linux
fonts/canvas/SwiftShader untouched — **CLEARED PerimeterX on 4/4 fresh exits**, and end-to-end through
the real `core.navigate()` path (paired same-exit: Linux 403, Windows 200), with a nav guard installed.

## Root cause

PerimeterX/HUMAN weights **`Linux x86_64` desktop Chrome** heavily as bot-like — it is the dominant
headless-bot OS — and 403s it even from a clean residential IP. It does NOT cross-check fonts/canvas
against the claimed OS hard enough to catch a UA-level spoof, so presenting as Windows clears it. This
is the same "clears locally / blocks in prod" class as the WebGL-absent tell, but the axis is the OS
string, not GPU.

## Fix

An **opt-in per-host** Windows OS-presentation override (`BGW_WINDOWS_UA_HOSTS`, mirrors
`BGW_FORCE_PROXY_HOSTS`). Default OFF → every host keeps the native, internally-coherent Linux identity;
a listed host (e.g. `totalwine.com`) presents as Windows. Opt-in, not global, because a Windows UA over
the container's Linux fonts/canvas is internally incoherent and a *different* anti-bot could cross-check
it — so we only flip hosts that demonstrably need it.

Mechanics (`src/browser/os-presentation.ts` + `patchright-core.ts`):

- The override is a CDP `Emulation.setUserAgentOverride` with full `userAgentMetadata`, which drives both
  the JS surface and the `User-Agent` + `Sec-CH-UA-Platform*` request headers, applied **before** a
  page's first navigation.
- It **reads the live UA-CH** (`getHighEntropyValues`) and mutates **only** the OS-bearing fields,
  preserving the real `brands`/`fullVersionList` — so the brand list / full version don't become a
  fabricated, version-drifting tell, and the Chrome major tracks auto-updates.
- The active drive page tracks its OS mode and **actively restores native** on a listed→non-listed
  navigation, so the override can never bleed past the opt-in boundary onto an unrelated host.
- **Fail-closed:** if applying or restoring the override fails, the navigation does not proceed with an
  uncertain identity — `navigate()` recreates a fresh (native) page and re-establishes the wanted mode,
  failing loud rather than silently bleeding Windows or downgrading a Windows-required host.

Runtime gate: `scripts/validate-os-presentation.mjs` (flip → restore-native → re-apply → opt-out),
green on Mac and in-container.

## Gotchas

- **Same-exit A/B is mandatory** for any PX fingerprint test — a fresh exit per arm reintroduces
  reputation noise and produces false negatives/positives. Always pin one exit and add a positive
  control (something that clears) so a double-block is interpretable.
- A Windows UA over Linux internals is **incoherent**; keep it opt-in. Coherent Windows fonts/canvas are
  a hardening follow-up if the host set grows.
- The `core` option flows from `config.core` (one wiring point in `loadConfig`) to *every* session —
  warm-drive, cold-drive, and retrieve — so the warm-open prod flow is covered by the same env var.

## Validated in prod (2026-06-26)

`BGW_WINDOWS_UA_HOSTS=totalwine.com` was activated in prod (env file + deploy, stealth gate green) and
exercised end-to-end: **atlas warm-opened `www.totalwine.com` through the real gateway and PerimeterX
cleared** — the page rendered with no press-&-hold and no "Access denied", through the live
residential-exit path. This confirms the OS-identity override works through the production warm-open
pipeline, not just the in-container same-exit A/B harness.

> Probe note: check login state on the **authenticated** slug (`/my-account`), not `/account` — the
> latter is not a route and 404s, which reads as "logged-out" but is not. Capturing the warm-open
> session for a press-&-hold host has its own automation-surface gotcha — see
> `docs/solutions/integration-issues/perimeterx-login-capture-needs-plain-chrome-not-automation-launch.md`.
> (Note: warm-open replay clears PX in prod but currently lands logged-out for Total Wine — a
> capture-completeness/localStorage gap tracked in that doc, not a PX failure.)
