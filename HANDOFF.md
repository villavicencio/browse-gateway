# HANDOFF — 2026-06-10

Indexxx is **solved**, and the win came from a reusable tool rather than another one-off
patch. Arc this session: WebRTC-leak fix (managed policy, not the ignored switch) → discovered
Indexxx is an *interactive* Turnstile that the leak fix didn't clear → built a
**fingerprint-parity harness** to measure Mac↔VPS divergence → it named the cause (**WebGL
absent under Xvfb**) → shipped software-WebGL + US-timezone + richer-fonts hardening → Indexxx
flipped from **0/15 to ~3/4** clears from the prod VPS. Four PRs merged (#10, #11, #12, #13);
prod is on the hardened image `f3618b5`.

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
1. **Confirm Indexxx through the real drive verb from a consumer** (not just the raw held-exit
   spike). The spike holds one exit by design; the gateway's escalation rotates on failure, so
   a consumer-driven retrieve/drive of Indexxx should clear reliably. This is the last
   end-to-end confirmation.
2. **Update the remote consumer's (Vault) `CLAUDE.md` Indexxx caveat** — it now clears after
   the hardening; the old "could not land a working proxied exit … 403" signature is stale.
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
