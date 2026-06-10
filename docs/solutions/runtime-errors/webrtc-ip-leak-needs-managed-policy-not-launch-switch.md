---
title: WebRTC leaks the host IP past the proxy — the --force-webrtc-ip-handling-policy launch switch is ignored by Chrome 149; the managed-policy file is load-bearing
module: docker/browser
date: 2026-06-09
problem_type: runtime_error
component: browser-launch
severity: high
symptoms:
  - "An anti-bot target (full-page Cloudflare challenge) clears from a residential/desktop host but stays blocked from the datacenter VPS, on the SAME residential proxy account and a clean exit pool"
  - "WebRTC/STUN gathers a `typ srflx` ICE candidate carrying the host's real (datacenter) IP, even with --force-webrtc-ip-handling-policy=disable_non_proxied_udp on the browser-process command line"
  - "The launch switch is verifiably present on the spawned chrome process cmdline (no --type=) yet has no effect on candidate gathering"
root_cause: external_behavior_change
resolution_type: config_fix
related_components:
  - patchright
  - cloudflare
  - residential-proxy
tags: [webrtc, ice, stun, srflx, ip-leak, proxy, cloudflare, chrome-policy, managed-policy, launch-args, datacenter]
---

## Problem

The gateway runs headful Chrome in Docker on a datacenter VPS behind a residential
proxy. A full-page Cloudflare challenge target cleared 6/6 locally (macOS, residential
host) but 0/15 from the VPS, on the **same** proxy account and a pool that was otherwise
clean. The methodical ruling-out (deploy, env config, proxy account hash, pool quality)
pointed at the VPS browser environment, and the lead suspect was a WebRTC IP leak: during
the challenge JS, STUN over plain UDP gathers ICE candidates **outside** the proxy and
exposes the host IP. On a datacenter host that residential-proxy-IP + datacenter-IP
mismatch reads as "proxy detected".

## What was tried (and the trap)

The first fix (PR #10) added `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`
to the launch args. Unit tests confirmed the flag was in `buildLaunchOptions`' output;
an on-host `cmdline` probe confirmed it was on the actual browser process. **It made no
difference** — an in-container ICE probe through the proxy still gathered a `typ srflx`
candidate with the VPS's public IP on the flagged image. The launch switch is silently
ignored by current branded Chrome (verified on 149): present on the cmdline, zero effect.

## Root cause

The WebRTC IP-handling policy is honored as an **enterprise managed policy**, not
(reliably) as a command-line switch on branded Chrome. Modern Chrome reads
`WebRtcIPHandling` from the managed-policy directory; the `--force-webrtc-ip-handling-policy`
switch has been demoted/ignored.

## Resolution

Bake a managed-policy file into the image (PR #11):

```json
// docker/policies/webrtc-ip-handling.json
{ "WebRtcIPHandling": "disable_non_proxied_udp" }
```

```dockerfile
COPY docker/policies/webrtc-ip-handling.json /etc/opt/chrome/policies/managed/webrtc-ip-handling.json
COPY docker/policies/webrtc-ip-handling.json /etc/chromium/policies/managed/webrtc-ip-handling.json
```

With the policy present, the same ICE probe through the proxy gathers **zero** non-proxied
candidates (verified on the baked prod image, `fa1b57c`). The launch switch is kept as
belt-and-braces for Chromium variants where it may still work, but it is not load-bearing.

A WebRTC leg was added to the stealth kill-gate (`scripts/validate-stealth.mjs`): it
gathers ICE candidates in the shipping image and FAILS on any UDP candidate. It needs no
proxy creds (under the policy, no non-proxied UDP is allowed at all) and catches the
silent-rot case directly — a switch-only image fails it.

## Verify the mechanism

```sh
# In-container, through the proxy — expect "candidates=0" with the policy baked in:
docker run --rm --init --shm-size=1g \
  -e BGW_PROXY_URL -e BGW_PROXY_USERNAME -e BGW_PROXY_PASSWORD \
  <image> node scripts/probe-webrtc.local.mjs   # gitignored throwaway probe
```

## Caveat — this was NOT the whole story for the original target

Closing the leak was a real, verified fix, but the target that motivated it (a full-page
Cloudflare **interactive Turnstile** "Verify you are human" interstitial) **still did not
clear** from the VPS after the leak was closed. A screenshot revealed it is an interactive
managed-challenge widget, not a passive auto-clearing "Just a moment…" interstitial — so
the leak was a contributing tell, not the determining gate. The interactive
managed-challenge (IP-bound `cf_clearance`) tier is a separate, unbuilt capability. See the
session handoff: don't assume "Mac clears / VPS blocks" is fully explained by the WebRTC
leak.
