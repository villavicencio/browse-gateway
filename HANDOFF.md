# HANDOFF — 2026-06-10 (evening)

Long multi-arc session. Picked up from the WebRTC-leak open thread and ran through: closing the
WebRTC leak (managed policy, not the ignored switch) → discovering Indexxx is an interactive
Turnstile the leak didn't fix → **building a fingerprint-parity harness** that named the real cause
(**WebGL absent under Xvfb**) → stealth hardening → a **drive-path stale-status bug** that was the
last mile → **Indexxx solved end-to-end** → characterizing StashDB (auth-walled) → hardening the
Vault SSH tunnel (plist written, NOT activated — user has concerns, deferred) → **building +
ACTIVATING CI/CD Phase 2** (one-button deploy-over-Tailscale). **Nine PRs merged (#10–#18); prod is
on the latest `main` image, deployed via the new pipeline.**

> Fleet detail (host/IP/tailnet/proxy/CAPTCHA names) stays in `*.local.md` + agent memory, never
> here — this file is committed to a PUBLIC repo. Placeholders: `<prod-host>`, `<prod-tailnet-ip>`,
> the residential proxy, the CAPTCHA provider.

## What We Built
- **WebRTC leak CLOSED (PR #10 + #11).** The `--force-webrtc-ip-handling-policy` launch switch is
  **ignored by Chrome 149** (proven: on the cmdline, srflx still leaked the VPS IP). The fix is the
  **`WebRtcIPHandling` managed-policy file** baked into the image (`docker/policies/…` →
  `/etc/opt/chrome/policies/managed/`). ICE probe through the proxy: zero non-proxied candidates.
- **Fingerprint-parity harness (PR #12).** `src/browser/fingerprint.ts` (collector + pure,
  unit-tested flatten/classify/diff, ranks axes high/geo/info), `scripts/fingerprint-snapshot.mjs`,
  `scripts/fingerprint-diff.mjs`. Turns "Mac clears / VPS blocks" into a measurement. Snapshots carry
  the egress IP → `*.fp.json` gitignored. **The durable diagnostic for any future divergence.**
- **Stealth hardening (PR #13).** Harness diff named the top tells, all fixed: **WebGL absent**
  (`webgl: null`) → `WEBGL_SWIFTSHADER_ARGS` (`--use-gl=angle --use-angle=swiftshader
  --enable-unsafe-swiftshader`; Chrome 149 gates the fallback behind the last flag); **TZ=America/
  New_York** (+tzdata) to match the US exit; **richer fonts**; a **webgl leg** added to
  `validate-stealth` (FAIL on null context).
- **Drive stale-status fix (PR #14).** `navigate()` froze status at the CF interstitial's first 403
  (CF reloads 403→200 on clear) and `#settle` snapshotted the blank transition, so `navFailed`
  misread the *cleared* page as a hard block ("could not land a working proxied exit"). Fix: let the
  active-page response listener track the post-clearance 200; `#settle` waits for non-thin content.
- **CI/CD Phase 2 — ACTIVATED (PR #15 + dry-run fixes #16/#17/#18).** One-button manual deploy:
  `gh workflow run deploy-http.yml -f image_tag=latest` → resolve tag→immutable digest → tailnet
  (OAuth, `tag:ci-deploy`) → ssh to a forced-command on-host wrapper that gates (validate-http),
  swaps, verifies, auto-rolls-back. `scripts/deploy/{launch-http,deploy-on-host}.sh` (fleet-clean) +
  `.github/workflows/{deploy-http,ghcr-cleanup}.yml`. Security-reviewed (P0 package-pin, P1
  template-injection, P2 action-SHA-pins all fixed).
- **Learnings (committed):** `docs/solutions/runtime-errors/{webrtc-ip-leak-needs-managed-policy-not-launch-switch,
  webgl-absent-under-xvfb-trips-interactive-turnstile,drive-nav-status-frozen-at-cf-interstitial-403}.md`.

## Decisions Made
- **WebGL software-GL applied UNCONDITIONALLY** (like the WebRTC policy) — prod is GPU-less; keeps
  local dev a faithful fingerprint mirror. A real-GPU host should drop the flags.
- **Static US timezone** (America/New_York), not dynamic per-exit-geo (revisit only if exits broaden).
- **CI/CD #1 (pull auth) = public package** → anonymous pull, no auth plumbing (reality overtook the
  doc's private+ephemeral recommendation). **#2 = OAuth + `tag:ci-deploy`.** **#6 = retain 5 host/10 GHCR.**
- **Tailscale SSH DISABLED on prod** (`RunSSH:false`) — it intercepted tailnet:22, **bypassed the
  authorized_keys forced command**, and presented its own host key. Interactive prod access stays on
  the public-IP `<prod-host>` alias. (If public SSH is ever closed, move the deploy to a 2nd non-22
  sshd port — "Option C" — so the forced-command security survives.)
- **Indexxx needs the `browser_*` drive path, not `retrieve`** (retrieve is one-shot, can't click the
  18+ age-gate). General rule for interactive-gated sites.

## What Didn't Work / Ruled Out
- **WebRTC launch switch** — a decoy on Chrome 149; only the managed-policy file works.
- **"VPS WebRTC leak is why Indexxx fails"** — falsified; leak closed, Indexxx still blocked. The real
  cause was WebGL-absent (fingerprint), found by the harness.
- **"Branch B cf_clearance solver tier"** — briefly hypothesized for Indexxx, disproven (it was
  fingerprint + a drive bug, not a missing solver).
- **Geo pin as Indexxx's blocker** — tested: US-pinned exits clear ~2/3, non-US ~3/3; minor, not the
  cause. (The cause was the drive stale-status bug + fingerprint.)
- **Deploy gate with `-e BGW_*` overrides** — broke validate-http's self-contained per-consumer-cap
  assertion (#17). **`{{.State.RestartCount}}`** in verify — errors; it's top-level `{{.RestartCount}}` (#18).

## What's Next
1. **Tunnel hardening (autossh/LaunchAgent) — DEFERRED, user has concerns to discuss.** The
   LaunchAgent plist is WRITTEN at `~/Library/LaunchAgents/com.dvillavicencio.browse-gateway-tunnel.plist`
   (validated, matched to the working tunnel) but **NOT activated** — the manual `ssh -L 8080` tunnel
   is still what Vault uses. Activating means killing the manual tunnel (one Vault reconnect) then
   `launchctl bootstrap`. **Pick this up next session and talk through the concerns before activating.**
2. **Reconnect Vault's MCP** — it was blipped several times by the Phase 2 dry-run recreates. One
   `mcp__browse-gateway__*` reconnect when next used.
3. **Optional: clean-rollback test** for Phase 2 — force a verify failure (e.g. wrong port in the
   on-host deploy config) and confirm it restores the prior digest GREEN. The dry-run proved gate-abort
   and exercised the rollback machinery, but a green rollback wasn't explicitly captured.
4. **StashDB** — auth-walled (account or API key), not a render-timing issue: `retrieve` → "Loading…"
   shell; `browser_*` drive + `wait_for` → renders but to a LOGIN page; GraphQL needs an `ApiKey`
   header (a direct call, outside the gateway). Record in Vault's notes if pursuing.
5. **Carryovers:** per-consumer solve budget; success-path solve/escalation observability; GHCR
   retention now handled by `ghcr-cleanup.yml`.

## Gotchas & Watch-outs
- **⚠️ Fleet leak in git history:** `<prod-host>`'s alias name slipped into commit `f169caf`'s HANDOFF
  (one line, now scrubbed at HEAD). It's a local SSH alias (not the real hostname/IP), low-sensitivity,
  but it's in public history. Decide whether to history-scrub (force-push main) — I did NOT do it
  unilaterally.
- **On-host `~/deploy/*.sh` are STATIC COPIES** — when `deploy-on-host.sh`/`launch-http.sh` change in
  the repo, **re-`scp` them to `<prod-host>:/home/node/deploy/`** (the workflow can't self-update the
  mechanism it runs). This bit us 3× in the dry-run.
- **Stealth flags get silently gated/ignored across Chrome versions** — WebRTC switch (use the policy
  file) and SwiftShader-WebGL (needs `--enable-unsafe-swiftshader`) on 149. The `validate-stealth`
  webrtc + webgl legs guard the build; re-run the parity harness after a Chrome bump.
- **Diagnose any "clears locally / blocks in prod" with the parity harness**, not by guessing flags.
- **Each Phase 2 (or manual) deploy recreates the container (~10-20s)** → MCP-over-HTTP sessions don't
  survive a server restart → consumers reconnect after every deploy.
- **Manual deploy is now one command too:** `BGW_DEPLOY_IMAGE=<digest> BGW_ENV_FILE=… BGW_CONSUMERS_HOST_PATH=…
  ~/deploy/launch-http.sh` (still pull + `validate-http` first; `CUTOVER.local.md` is the fallback runbook).
- **Untracked `.claude/` + `AGENTS.md`** left as-is (pre-existing). Prod throwaway probes/runners live
  in `<prod-host>:/home/node/*.local.*` (gitignored-style).
