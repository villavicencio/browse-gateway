# HANDOFF — 2026-06-10

Indexxx is **solved end-to-end**, and the wins came from reusable tools + a real bug fix, not
one-off patches. Arc this session: WebRTC-leak fix (managed policy, not the ignored switch) →
discovered Indexxx is an *interactive* Turnstile the leak fix didn't clear → built a
**fingerprint-parity harness** → it named the cause (**WebGL absent under Xvfb**) → shipped
software-WebGL + US-timezone + richer-fonts hardening → Indexxx cleared via the held-exit spike
→ but Vault (drive verb) still failed "could not land a working proxied exit (403)" → traced
to a **drive-path bug**: `navigate()` froze status at the CF interstitial's 403 and `#settle`
snapshotted the blank transition, so `navFailed` misread the *cleared* page as a hard block →
fixed → drive path now lands Indexxx (status 200, navFailed false) → **confirmed end-to-end via
Vault's live drive path** (navigate → age-gate → click "I AGREE" → real `/home` content). **Five
PRs merged (#10–#14); prod is on `7855d4b`** (full stack: WebRTC policy + software WebGL + US TZ +
fonts + drive fix). The Indexxx saga is closed.

> Fleet detail (host/IP/tailnet/proxy-provider names) stays in `*.local.md` + agent memory,
> never here — this file is committed to a PUBLIC repo. Placeholders: `<prod-host>`, the
> residential proxy, the CAPTCHA provider.

## What We Shipped
- **PR #10 (`d2554c7`) + PR #11 (`fa1b57c`) — WebRTC leak closed.** The
  `--force-webrtc-ip-handling-policy` launch switch is **ignored by Chrome 149** (verified: on
  the cmdline, srflx still leaked). The fix is the **`WebRtcIPHandling` managed-policy file**
  baked into the image (`docker/policies/webrtc-ip-handling.json` →
  `/etc/opt/chrome/policies/managed/`). ICE probe through the proxy: zero non-proxied
  candidates. Learning: `docs/solutions/runtime-errors/webrtc-ip-leak-needs-managed-policy-not-launch-switch.md`.
- **PR #12 (`836a59e`) — fingerprint-parity harness.** `src/browser/fingerprint.ts` (collector
  + pure, unit-tested flatten/classify/diff), `scripts/fingerprint-snapshot.mjs` (capture one
  host through the shipping core), `scripts/fingerprint-diff.mjs` (diff two snapshots, ranked
  high/geo/info). Snapshots carry the egress IP → `*.fp.json`/`fingerprint-*.json` gitignored.
  This is the durable artifact: "Mac clears / VPS blocks" is now a measurement, not a spike.
- **PR #13 (`f3618b5`) — stealth hardening, driven by the harness diff.** The measured top
  divergences, all fixed:
  - **WebGL absent (`webgl: null`)** under Xvfb → `WEBGL_SWIFTSHADER_ARGS`
    (`--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`) in
    `buildLaunchOptions`. Chrome 149 gates the software fallback behind
    `--enable-unsafe-swiftshader`; found empirically with an in-container flag-finder.
    **This was the determining Indexxx tell.**
  - **Timezone UTC → `TZ=America/New_York`** (+ tzdata + `/etc/localtime`) to match the
    `_country-us` exit. Static US (per the deploy decision).
  - **Sparse fonts → `fonts-{dejavu,freefont-ttf,croscore,noto-core}`** (croscore is
    metric-compatible with Arial/Times/Courier).
  - **Gate:** `validate-stealth` gained a **webgl leg** (FAIL on a null context), mirroring the
    webrtc leg — regression to null is caught at build.
  - Learning: `docs/solutions/runtime-errors/webgl-absent-under-xvfb-trips-interactive-turnstile.md`.
- **PR #14 (`7855d4b`) — drive-path stale-status fix (the last mile for Vault).** After the
  hardening, the held-exit spike cleared Indexxx but Vault's *drive verb* still failed "could
  not land a working proxied exit (403)". Probes (main-frame responses `307→403→200`) showed
  `navigate()` froze `status` at the CF interstitial's first 403 (overwriting the active-page
  response listener that already tracked the last status), and `#settle` exited on the blank
  inter-navigation window — so `navFailed`'s `isHardBlock(403, thin)` misread the *cleared* page
  as a hard block and the escalation discarded a working exit. Fix: `navigate()` resets
  `#lastDocStatus` and lets the listener track the post-clearance 200; `#settle` waits (after a
  block) until the page is non-thin (`isCleared` past `MIN_CONTENT_LENGTH` — the same bar
  `isHardBlock` uses), not just non-blank. Verified on prod (baked image, US sticky exit):
  status 200, tree ~3.1k with refs, `navFailed=false` — was 403 / tree 10 / true. Preserves the
  dead-exit (null → fail), hard-block (403 no-clear → fail), and CF-escalation invariants.

## Verification (real, on the prod VPS)
- Hardened image `f3618b5` deployed: `validate-http` PASS; live container recreated
  (`consumers=[atlas, vault]`, `sticky=true`, `/mcp`→401). Atlas + Vault both served.
- Fingerprint snapshot of the baked image through the proxy: `webgl` non-null (SwiftShader),
  `timezone=America/New_York`, fontCount 7, `webrtc.udp=0`.
- **Indexxx held-exit spike: ~3/4 CLEARED** (was 0/15). Screenshot confirms the real age-gate
  page, no Turnstile. The one miss is exit-quality variance on a held dirty exit — the verdict
  text itself concludes "exit reputation/rotation was the whole problem"; the production
  escalation ladder rotates past a bad exit, so prod resilience is ≥ the raw probe ratio.

## What's Next
1. **Indexxx — CONFIRMED END-TO-END 2026-06-10 via Vault's live drive path.** ✅ `browser_navigate`
   → 200 real age-gate → click "I AGREE" → `/home` (255 links, live 2026-06-10 content). navFailed
   false on the consumer side too. The whole saga is closed: WebRTC policy + software WebGL + US TZ
   + fonts + the drive stale-status fix, all live on `7855d4b`. (Vault's outage earlier that day was
   a dead SSH tunnel, not the gateway — gateway was healthy throughout; harden Vault's tunnel with
   autossh so a redeploy gap doesn't kill it.)
   - **Access pattern (record in consumers' notes):** interactive-gated sites (age-gates, click-through
     consent) need the `browser_*` drive path (`navigate` → click), NOT `retrieve` — retrieve is
     one-shot and can't click the gate. The gate cookie persists within a drive session (clears once).
2. **Update Vault's `CLAUDE.md` Indexxx caveat** (Vault's repo) — the old "Don't retry Indexxx via
   browser_*; not reachable / could not land a working proxied exit … 403" is now stale. New line:
   "Indexxx ✅ via browser_* drive (navigate → click 'I AGREE' age-gate → real content); retrieve
   alone won't." Vault makes this edit in its own repo, not here.
   That's Vault's repo (separate project) — do it there, not here.
3. **Optional deeper hardening (follow-ups, not needed for Indexxx):** spoof the SwiftShader
   renderer string to a plausible consumer GPU; spoof `hardwareConcurrency`/`deviceMemory`
   (VPS reports 2/8 vs desktop 10/16); dynamic per-exit-geo timezone (only if exits broaden
   beyond US). Re-run the parity harness after any of these to confirm the axis closed.
4. **Carryovers (unchanged):** per-consumer solve budget; success-path solve/escalation
   observability; CI/CD Phase 2 (deploy-over-Tailscale,
   `docs/plans/2026-06-08-001-*.local.md`); GHCR retention/pruning.

## Gotchas & Watch-outs
- **Stealth flags can be silently gated/ignored across Chrome versions.** Two cases this arc:
  the WebRTC launch switch (ignored on 149 → use the managed-policy file) and SwiftShader-WebGL
  (gated behind `--enable-unsafe-swiftshader` on 149). The `validate-stealth` webrtc + webgl
  legs guard both at build. Re-run the parity harness after a Chrome bump.
- **Run the parity harness to diagnose any "clears locally / blocks in prod":**
  `FP_LABEL=mac FP_OUT=mac.fp.json node scripts/fingerprint-snapshot.mjs` on the Mac (load
  `.env.spike` first for the proxy), and in-container on the VPS
  (`-e FP_OUT=/out/vps.fp.json -v /home/node:/out … node scripts/fingerprint-snapshot.mjs`),
  then `node scripts/fingerprint-diff.mjs mac.fp.json vps.fp.json`. Snapshots carry the egress
  IP — keep them out of git (already gitignored) and off the public repo.
- **WebGL forced to SwiftShader everywhere, incl. local dev** — intentional (dev mirrors prod).
  A real-GPU host would want the flags dropped to keep real hardware WebGL.
- **Prod redeploy (unchanged):** pull GHCR sha → `tag … latest` → `validate-http` (log to `~/`,
  not `/tmp`) → `docker rm -f` → recreate with ALL `-e` vars incl. `BGW_PROXY_STICKY_SUFFIX` +
  `BGW_CAPTCHA_API_URL`. Don't skip the pull. Confirm `sticky=true` in the boot log.
- **The gateway env file** sources clean under `sudo -iu node` but its proxy vars aren't
  auto-forwarded into a *nested* `docker run -e NAME` unless re-sourced in the same `bash -lc`.
  `/home/node/run-spike-prod.local.sh` (staged) handles this + maps `BGW_PROXY_* → SPIKE_PROXY_*`.
- **rootless port race** after `docker rm -f`: `export XDG_RUNTIME_DIR=/run/user/1000` then
  `systemctl --user restart docker`.
- **Prod throwaway repro artifacts** in `/home/node/`: `probe-webrtc.local.mjs`,
  `probe-cmdline.local.mjs`, `spike-cf-interstitial.local.mjs`, `run-spike-prod.local.sh`,
  `webrtc-policy.json` (redundant — baked in). The WebGL flag-finder + IP-bearing snapshots were
  cleaned up. Validate logs: `~/validate-http-<sha>.log`.
- **Untracked `.claude/` + `AGENTS.md`** left as-is (pre-existing).
