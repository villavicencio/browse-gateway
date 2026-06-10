# HANDOFF — 2026-06-09 (evening, same-day continuation)

Continued from the marathon session's open thread: the WebRTC-leak fix. It shipped,
deployed, and **verified the leak is closed in prod** — but re-testing Indexxx surfaced a
finding that **reframes the whole Indexxx story**: it's an *interactive* Cloudflare
Turnstile, not a passive interstitial, and it still blocks from the VPS after the leak was
closed. The WebRTC leak was a real defect (now fixed) but NOT the determining gate for
Indexxx.

> Fleet detail (host/IP/tailnet/proxy-provider names) stays in `*.local.md` + agent memory,
> never here — this file is committed to a PUBLIC repo. Placeholders: `<prod-host>`, the
> residential proxy, the CAPTCHA provider.

## What We Built / Shipped
- **PR #10 (`d2554c7`) — WebRTC IP-handling launch switch.** Pinned
  `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` unconditionally in
  `buildLaunchOptions` (`WEBRTC_IP_HANDLING_ARG` exported), unit-tested across every config.
  **This turned out to be insufficient on its own** — see PR #11.
- **PR #11 (`fa1b57c`) — WebRtcIPHandling managed-policy file (the actual fix).** An on-host
  ICE probe through the prod proxy proved the launch switch is **silently ignored by Chrome
  149**: the flag was verified present on the browser-process cmdline, yet STUN still gathered
  a `typ srflx` candidate carrying the VPS's real IP. The mechanism that works is the
  enterprise **managed policy** baked into the image:
  `docker/policies/webrtc-ip-handling.json` → `/etc/opt/chrome/policies/managed/` (+ the
  `/etc/chromium/` fallback). With it, the same probe gathers **zero** non-proxied candidates.
  Also added a **webrtc leg to the stealth kill-gate** (`validate-stealth.mjs`): gathers ICE
  candidates in the shipping image, FAILs on any UDP candidate, needs no proxy creds — catches
  the silent-rot case the switch-only image would have shipped. Review fixes: gate on ANY UDP
  candidate (not just srflx, which could pass vacuously if STUN were unreachable) + resolve on
  `icegatheringstatechange=complete` with an 8s cap. 178 unit tests.
- **Deployed to prod (`fa1b57c` live).** Full redeploy: pull GHCR sha → `tag latest` →
  `validate-http` gate PASS → recreate `browse-gateway-http` with all `-e` vars → boot log
  `sticky=true … consumers=[atlas, gooner]`, `/mcp` returns 401. Baked-policy leak-closed
  verified on the live image via the ICE probe (0 candidates through the proxy). Atlas + Gooner
  both served (the container they share was recreated cleanly).
- **Learning:** `docs/solutions/runtime-errors/webrtc-ip-leak-needs-managed-policy-not-launch-switch.md`.

## The Indexxx finding that changes everything
Re-tested Indexxx from prod via the held-exit spike (`spike-cf-interstitial.local.mjs`) on
the fixed image, **3 attempts, 0/3 cleared**. But a **screenshot** (saved this session, sent
to the user) reveals what it actually is:

> **An interactive Cloudflare Turnstile** — "www.indexxx.com / Performing security
> verification / **[ ] Verify you are human**" with the Cloudflare widget. NOT the passive
> "Just a moment…" auto-interstitial we assumed.

This falsifies two earlier conclusions:
1. **"The VPS WebRTC leak is why Indexxx fails"** — the leak is now closed (probe-proven) and
   Indexxx still blocks. The leak was a real tell worth fixing, but not the determining gate.
2. **"Branch A (sticky + held clean exit) clears Indexxx unaided"** — that probe result was
   **macOS-only**. The same spike from the VPS lands a clean held exit and still sits on the
   interactive Turnstile for 45s. Locally the Turnstile auto-passes (clean residential desktop
   env); on the VPS it demands interaction.

So the real Mac-vs-VPS gap is whatever still trips Turnstile into **interactive** mode on the
VPS (a fingerprint/environment tell that survives the proxy + the WebRTC fix), OR Indexxx
simply requires actually solving the interactive challenge.

## What's Next (user decision — this is a scope fork, not a continuation)
1. **Most promising: solve the interactive managed-challenge ("Branch B").** The captcha
   solver already DETECTS Turnstile and can inject a `cf-turnstile-response` token
   (`src/browser/captcha.ts`), and it's wired on the **drive path** — but Indexxx is a
   *full-page managed-challenge* interstitial (hidden/dynamic sitekey, IP-bound `cf_clearance`
   cookie), which is NOT the same as an embedded `.cf-turnstile[data-sitekey]` widget the
   current token-inject path handles. CapSolver has a dedicated Cloudflare-challenge /
   `cf_clearance` task type for exactly this (solve-from-the-exit-IP + cookie inject). This is
   a **new build**, descoped twice before. **Key cheap experiment first:** drive Indexxx
   through the *actual gateway drive verb* (not the raw spike) so the existing captcha hook
   runs — confirm whether the embedded-widget path already does anything before building the
   cf_clearance tier.
2. **If chasing the fingerprint instead:** the VPS still differs from the Mac in ways the
   WebRTC fix didn't touch — Chrome 149 in-container vs the Mac's Chrome, software GL under
   Xvfb (llvmpipe canvas/WebGL fingerprint), timezone/locale vs the proxy geo. Capture what the
   VPS browser renders/fingerprints on a Turnstile demo page vs the Mac. Lower-confidence,
   higher-effort.
3. **Update the remote consumer's `CLAUDE.md` Indexxx caveat:** the *reason* is now "interactive
   CF Turnstile requiring the unbuilt managed-challenge solve tier", NOT a WebRTC leak (fixed)
   and NOT pool/proxy. The drive signature it lists (`could not land a working proxied exit …
   403`) is now slightly off — it lands the exit fine and gets a 403-equivalent interactive
   challenge.
4. **Non-blocking carryovers:** per-consumer solve budget; success-path solve/escalation
   observability; CI/CD Phase 2 (deploy-over-Tailscale, decisions doc
   `docs/plans/2026-06-08-001-*.local.md`); GHCR retention/pruning.

## Gotchas & Watch-outs
- **The WebRTC launch switch is a decoy on Chrome 149** — only the managed-policy file works.
  If the `srflx` leak ever returns, check the policy file is in the image
  (`/etc/opt/chrome/policies/managed/`), not the launch arg. The new `validate-stealth` webrtc
  leg is the guard.
- **Prod redeploy (unchanged):** pull GHCR sha → `tag … latest` → `validate-http` gate (log to
  `~/`, not `/tmp`) → `docker rm -f` → recreate with ALL `-e` vars incl. `BGW_PROXY_STICKY_SUFFIX`
  + `BGW_CAPTCHA_API_URL`. Don't skip the pull. Confirm `sticky=true` in the boot log.
- **The gateway env file sources clean under `sudo -iu node`** but the proxy vars are NOT
  auto-forwarded into a *nested* `docker run -e NAME` unless you re-source inside the same
  `bash -lc`. The spike runner (`/home/node/run-spike-prod.local.sh`, staged) does this and
  maps `BGW_PROXY_* → SPIKE_PROXY_*`. (An earlier inline attempt saw the vars as unset because
  the source and the `docker run` were in different shell invocations.)
- **Prod throwaway repro artifacts staged in `/home/node/`** (gitignored-style, like the
  existing `/root/bgw-spike/`): `probe-webrtc.local.mjs`, `probe-cmdline.local.mjs`,
  `spike-cf-interstitial.local.mjs`, `run-spike-prod.local.sh`, `webrtc-policy.json` (now
  redundant — baked into the image). Validate-http logs: `~/validate-http-<sha>.log`.
- **rootless port race** after `docker rm -f`: `export XDG_RUNTIME_DIR=/run/user/1000` then
  `systemctl --user restart docker`.
- **Untracked `.claude/` + `AGENTS.md`** left as-is (pre-existing).
- **Local probe ≠ prod env** is now the *whole* Indexxx story: macOS residential desktop Chrome
  vs Linux Chrome 149 under Xvfb on a datacenter VPS. A clear locally proved nothing about prod
  — exactly how the "Branch A clears it" conclusion went wrong.
