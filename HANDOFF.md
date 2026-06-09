# HANDOFF — 2026-06-09

Marathon session. Started on CI/CD Phase 1, then onboarded the first **remote** consumer, then
chased a CAPTCHA-solver activation that surfaced a real bug, then built CF-interstitial escalation —
and ended deep in an investigation of why one anti-bot site (an interactive-CAPTCHA target) clears
locally but not from the prod VPS. Three PRs merged (#7, #8, #9); the open thread is a one-line
stealth fix, fully diagnosed and ready to implement.

> Fleet detail (host/IP/tailnet/proxy-provider names) stays in `*.local.md` + agent memory, never
> here — this file is committed to a PUBLIC repo. Placeholders below: `<prod-host>`, the residential
> proxy, the CAPTCHA provider.

## What We Built
- **PR #7 (`846e70f`) — CI/CD Phase 1: build→GHCR on `main`.** A `build-image` job in
  `.github/workflows/ci.yml`, `needs: test`, main-push-gated; native amd64; pushes
  `ghcr.io/<owner>/browse-gateway` tagged short-SHA + `latest`; `provenance/sbom: false`. Retired the
  local Rosetta build→save→scp→load. GHCR package is **public** (flipped during the CAPTCHA deploy so
  prod can `docker pull` anonymously).
- **First REMOTE consumer onboarded** (a second project, the gateway's first off-box consumer).
  Reached via an **SSH tunnel** (`ssh -N -L 8080:127.0.0.1:8080 root@<prod-host>`), NOT a tailnet
  bind — rootless Docker can't dual-publish one container port to two host IPs, and the tunnel keeps
  the gateway loopback-only. Consumer provisioned (`consumers.json` + `BGW_CONSUMER_TOKEN_*`,
  `BGW_MAX_SESSIONS` 3→5); MCP registered local-scope; its `CLAUDE.md` fetch policy cut over to
  `mcp__browse-gateway__*` (Browserbase dropped). Learnings:
  `docs/solutions/runtime-errors/rootless-docker-port-republish-and-remote-reach.md`.
- **CAPTCHA solver ACTIVATED in prod + render-race fixed.** It was dormant (prod ran a pre-PR-#6
  image AND the launch never passed `-e BGW_CAPTCHA_API_URL`). Activating it surfaced **PR #8
  (`e7970fc`)** — a render-race: `navigate()` resolves at `domcontentloaded`, but the widget's
  response field is injected by a later async script, so the one-shot detect saw the container with no
  field (`respLen -1`) and never solved. Fixed with a tri-state `respLen` + `awaitSolvableCaptcha`
  (polls out the render race; pure + unit-tested). Verified live: Google reCAPTCHA-v2 demo →
  "Verification Success". Learning:
  `docs/solutions/runtime-errors/captcha-solver-render-race-domcontentloaded.md`.
- **PR #9 (`967b688`) — sticky held exits + raised clearance for CF-interstitial escalation.**
  `mintStickyProxy()` appends a deployment-config password suffix (`BGW_PROXY_STICKY_SUFFIX`,
  `{id}` minted fresh per attempt — provider-neutral, no proxy syntax in source); each escalation
  attempt holds ONE exit (a CF challenge is IP-bound) while retries still rotate; `PROXY_CLEARANCE_TIMEOUT_MS`
  (45s) on proxied attempts both verbs. Plus review fixes: escalated clearance on the proxied
  pinned-reopen path, `stickySuffixBootError` (fail-closed on a missing `{id}`), `sticky=` in the boot
  log, distinct mid-retry error, `randomBytes(8)` id, and a `fix(deploy)` forwarding
  `BGW_PROXY_STICKY_SUFFIX` + `BGW_CAPTCHA_API_URL` in the committed stdio launcher. 177 unit tests.
  Plan: `docs/plans/2026-06-09-001-feat-sticky-cf-escalation-plan.local.md`.
- **Reviews:** PR #9 got an in-repo multi-agent `ce-code-review` (10 personas) + an external review;
  all findings resolved (one P1 dropped as a verified false positive — the reaper can't reap mid-op
  because `touch()` fires at op-start, `gateway/index.ts:139`).

## Decisions Made
- **Remote reach = SSH tunnel, not a tailnet/0.0.0.0 bind** (rootless can't dual-publish; tunnel keeps
  loopback-only on a public box — safer).
- **GHCR package = public** (image bakes no secrets; source already public; lets prod pull
  anonymously without an on-host token). Phase-2 private-pull deferred.
- **Sticky id per ATTEMPT** (not per session) — keeps the rotate-past-dirty-exits property the
  reputation-403 path needs, while each attempt holds one IP for its challenge.
- **CF-interstitial Branch A (sticky+wait); Branch B (cf_clearance solver) descoped** — a probe proved
  a clean held exit clears the interstitial unaided, so no solver tier needed.
- **Indexxx root cause is NOT the proxy/pool/config** — ruled out methodically (see below). It's the
  **VPS browser environment**, almost certainly a WebRTC IP leak.

## What Didn't Work
- **Indexxx (interactive-CAPTCHA target) still ❌ from prod** — but the *reason* is now pinned. The
  sticky feature deployed correctly (`sticky=true`), yet Gooner drives 403 at the exit layer. Ruled
  out, in order:
  1. **Deploy** — first tests ran on the OLD image (the pull/`tag latest` step was skipped). Re-pulled
     `967b688`, confirmed `sticky=true` in the boot log.
  2. **Env config** — masked dump of the prod env file is structurally correct; the suffix
     `'_country-us_session-{id}_lifetime-30m'` produces the same final password the local probe used.
     (Lone drift: `BGW_PROXY_URL` lacked the `http://` scheme — now added; harmless, Playwright treats
     schemeless as http.)
  3. **Proxy account** — scheme-normalized `sha256(url|username)` hashes **match** between prod and the
     local probe → identical residential-proxy account + endpoint.
  4. **Pool quality** — the local probe (same creds) cleared Indexxx **6/6**. Clean exits are the norm;
     prod is **0/15**. So it is NOT variance and NOT pool quality.
- That leaves only the **VPS browser environment** (same proxy, same clean pool, Mac clears / VPS not).

## What's Next
1. **Implement the WebRTC-leak fix (the open thread).** Add
   `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` to the browser launch args in
   `src/browser/launch-options.ts` (`buildLaunchOptions` currently sets only `--no-sandbox`). Theory,
   fully reasoned: the `403` is the CF *challenge* status; it CLEARS on the Mac but not the VPS because
   during the challenge JS, WebRTC/STUN leaks the host IP — residential on the Mac (matches the proxy,
   CF clears), **datacenter on the VPS** (CF sees residential-proxy-IP + datacenter-IP = proxy detected
   → refuses `cf_clearance` → stays 403). The flag forces WebRTC through the proxy only. Add a stealth
   test, rebuild via CI, redeploy, re-test Indexxx from Gooner. A clear = leak confirmed + fixed.
   - Optional confirm-first: a from-VPS WebRTC-leak probe (load a leak detector through the prod proxy,
     check whether the host IP appears) before deploying.
2. **If the flag doesn't fully fix it** — next suspects are the Docker-Chrome fingerprint (version vs
   the Mac's Chrome) or other Xvfb/headless tells; capture what the VPS browser actually renders on
   Indexxx (stuck "Just a moment…" vs a hard block page) via a containerized probe + screenshot.
3. **Update the remote consumer's `CLAUDE.md` Indexxx caveat** once the fix lands — the *reason* is a
   VPS WebRTC leak (now fixable), not the cf_clearance tier or pool. The drive signature it lists
   (`could not land a working proxied exit … 403`) stays accurate.
4. **Deferred (non-blocking):** per-consumer solve budget (currently shared 5/60s per process);
   success-path escalation/solve observability (agent-native review flag); CI/CD Phase 2 (manual
   deploy over Tailscale — decisions doc at `docs/plans/2026-06-08-001-*.local.md`); GHCR
   retention/pruning.

## Gotchas & Watch-outs
- **Prod redeploy = pull GHCR SHA → `tag … latest` → gate (`validate-http`) → recreate** via the
  inline `docker run` in `CUTOVER.local.md` (the committed stdio launcher is a separate artifact; the
  live path is HTTP). Every redeploy must carry ALL `-e` vars incl. `-e BGW_PROXY_STICKY_SUFFIX` and
  `-e BGW_CAPTCHA_API_URL` (both were silently missing at different points this session and cost hours
  — the boot log now prints `sticky=true` to catch it).
- **Don't skip the pull.** A recreate without `docker pull <sha>` + `tag latest` runs the OLD image —
  two Indexxx tests this session were invalid for exactly this.
- **rootless port race:** after `docker rm -f`, an immediate `docker run` can hit `address already in
  use` (rootlesskit forward lingers; `ss` can't see it). Fix: `export XDG_RUNTIME_DIR=/run/user/<uid>`
  then `systemctl --user restart docker`. `systemctl --user` fails `No medium found` without
  XDG_RUNTIME_DIR set.
- **`validate-http` gate:** write its log to `~/` not `/tmp` (a root-owned `/tmp/validate-http.log`
  from a prior run causes a `Permission denied` redirect that silently shows a STALE prior PASS).
- **`BGW_PROXY_STICKY_SUFFIX` MUST contain `{id}`** or the gateway fails closed at boot. Quote it in
  the env file so bash doesn't touch `{id}`.
- **Untracked `.claude/` + `AGENTS.md`** left as-is (pre-existing). Spike harnesses
  `scripts/spike-*.local.mjs` (incl. `spike-cf-interstitial.local.mjs`, the held-exit probe) are
  gitignored repro artifacts; the local probe reads creds from `.env.spike`.
- **Local probe ≠ prod env:** macOS windowed Chrome on a residential host vs Linux Chrome under Xvfb
  on a datacenter VPS — that gap is the whole Indexxx story. A clear locally is necessary but not
  sufficient proof for prod.
