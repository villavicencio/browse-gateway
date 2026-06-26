# HANDOFF — 2026-06-26 (morning, PST)

This session was a deep **PerimeterX kill** arc on Total Wine: we tested every lever (cookie `_pxvid`,
IP coherence, warm-up nav, gesture automation), **root-caused PX to exit-IP reputation** (not behavior),
then **designed → reviewed → shipped → activated a durable fix** (fresh-exit warm-open mode, merged to
main + live in prod). The fix is correct and active, but the live validation surfaced the **remaining
blocker: the prod (VPS) browser fingerprint** — PX 403s the gateway's Patchright-under-Xvfb where a Mac
Patchright clears the same exit + cookies. Next session = **Mac↔VPS fingerprint parity**.

## What We Built (all on `main`, synced; nothing unpushed)

- **`50e10a5` — feat: fresh-exit warm-open mode** (the durable fix). New `BGW_WARM_FRESH_EXIT_HOSTS`
  (flat CSV host-suffixes, mirrors `BGW_FORCE_PROXY_HOSTS`): a host on the list replays its stored login
  through a **fresh clean residential exit** instead of re-pinning the captured (decaying/burned) one.
  Files: `src/verbs/drive.ts` (shared `verifiedHeldExit` gate + new `proxyOverrideForFresh`; both
  FAIL-CLOSED, no rotating/unverified exit, never a direct downgrade), `src/mcp/vault-login.ts`
  (`buildWarmOverride` gains `freshExit`, OUTERMOST branch, ignores the captured `stickyExitId`),
  `src/mcp/drive-controller.ts` (`#freshExitHosts`; `#warmError` dispatches fresh-block→"retry for clean
  exit" vs pinned-block→"re-capture", host-derived so it holds on first-nav AND reopen-after-reap),
  `runtime.ts`/`http-main.ts`/`main.ts` (3 wiring points), `test/fresh-exit-warm.test.mjs` (8 tests).
  Also: `hostForcesProxy`/`parseForceProxyHosts` now `canonicalizeHost` both sides (Codex R1 fix —
  trailing-dot FQDN bypass). **507/507 tests pass.**
- **`e290421` — docs: scrubbed a leaked prod env-file path from HANDOFF.md** (the prior handoff tripped
  the `cli-brand` fleet-hygiene guard). CI is green again.
- **Plan + critique**: `docs/plans/2026-06-24-002-fresh-exit-warm-open-plan.local.md` (design + 3-lens
  critique outcome + folded changes). Updated `docs/plans/2026-06-22-001-spike-defeat-perimeterx-press-hold.local.md`
  with two addenda (isTrusted-is-not-a-wall; root-cause=exit-reputation). `docs/plans/2026-06-24-001-warmup-navigation-plan.local.md`
  marked KILLED.
- **Local PX tooling** (in `~/totalwine-onboarding/`, OUTSIDE the repo — names the real host): `capture-proxied.sh`
  + `px-proxy.mjs` (proxied capture through a fixed exit), `warmup-falsify.mjs` + RUNBOOK (the zero-code
  Track-A falsifier), `px-challenge-recon.mjs` + `px-recon-batch.mjs` (PX-structure recon, both DIRECT/proxied),
  `validate-warm.mjs` (prod warm-open validator), `px-cookie-arms.mjs` (the cookies-vs-fingerprint test).
  `totalwine.json` = the 2026-06-24 capture (has `_pxvid` + `__pxvid`, no localStorage).
- **Foreman (side task)**: cloned the Codex review-loop SOP into the Foreman project's memory
  (`~/.claude/projects/-Users-dvillavicencio-Projects-ibmcconstruction-com/memory/codex-review-loop-sop.md`
  + index), adapted to its Next.js/Sanity/Vercel domain.

## Decisions Made

- **PerimeterX on Total Wine is EXIT-IP-REPUTATION-gated, not behavioral.** A clean residential IP clears
  it **0/5** under Patchright automation (Mac direct AND a fresh IPRoyal exit; recon 2026-06-24/25). The
  gateway's 10/10 warm-open failures were **atlas's BOUND exit being stale/burned** (an IPRoyal `lifetime-30m`
  sticky decays past its window). This retired warm-up-nav and gesture automation as unnecessary.
- **Durable fix = fresh-exit warm-open, NOT a press-&-hold solver.** Relaxing R3's re-pin is safe for
  opted-in hosts because IP-bound clearance tokens are stripped at capture (`stripIpBoundTokens`), so the
  restored auth isn't IP-bound. **Opt-in per host; dormant by default** (every non-listed host keeps R3
  re-pin exactly). The fail-closed-never-direct invariant is preserved via the shared `verifiedHeldExit`.
- **Shipped via the full pipeline**: 3-lens plan critique (proceed-with-changes) → Codex adversarial-review
  loop (R1 caught a real trailing-dot fail-open → fixed; R2 approved 0 findings) → squash-merge to main →
  deploy. Per [[codex-review-loop-sop]].
- **Activated in prod**: `BGW_WARM_FRESH_EXIT_HOSTS=totalwine.com` is set (confirmed: warm-open returns the
  FRESH-exit error, not the stale one). Image `e290421` built to `latest` (CI 15:34Z), deployed via
  `gh workflow run deploy-http.yml` (run 28185511595, success).

## What Didn't Work (don't relitigate)

- **Track A — warm-up navigation: KILLED.** Zero-code falsifier: baseline 10/10 PX-fired, warm-up 10/10
  fired, **homepage itself fired 10/10**. A no-human warm-up can't clear a behavioral challenge — but that
  was on atlas's *burned* exit; the real story is exit reputation (above).
- **Experiment #1 — keep `_pxvid`: NOT the blocker.** The cookie-arms test proved it: the gateway-equivalent
  stripped cookie set (which DROPS `_pxvid`) **clears PX on the Mac**; keeping `_pxvid` also clears. So
  `_pxvid` is not what's 403ing the gateway. (Note: `/^_px/i` strips `_pxvid` but KEEPS `__pxvid` — a
  partial device identity — yet it clears anyway on a good fingerprint.)
- **Experiment #2 — IP coherence (capture==replay exit): confounded** (sticky lifetime + Mac/VPS fingerprint
  + behavioral void). Tooling built, not pursued.
- **`isTrusted` is NOT a wall (myth refuted).** The gateway's Patchright produces `isTrusted=true` on
  synthesized holds (page.mouse AND raw CDP Input). The "CDP input is isTrusted=false" belief conflates
  CDP injection with in-page JS dispatchEvent. So Track B gesture automation was never blocked on isTrusted
  — but it's moot given the exit-reputation root cause.

## What's Next

1. **Mac↔VPS fingerprint parity (THE blocker).** Decisive evidence: same fresh residential exit + same
   stripped cookies → **Mac Patchright clears PX, VPS gateway 403s**. Classic "clears locally / blocks in
   prod" — exactly what the **fingerprint-parity harness** solves (`scripts/fingerprint-snapshot` +
   `-diff`; how Indexxx's WebGL-absent tell was found). Diff the Mac (clears) vs the VPS gateway (403s),
   find + close the PX-tripping tell (WebGL/canvas/UA/fonts/screen under Xvfb are prime suspects).
2. **Re-capture atlas's Total Wine credential** — the 2026-06-24 session cookies have expired (warm-open
   would land logged-OUT even once PX clears). Now easy: a clean exit clears PX with no challenge, so the
   gateway could even auto-login through a fresh exit (no human plain-Chrome capture needed) — a tracked
   follow-up.
3. **Re-validate** once fingerprint parity closes: `~/totalwine-onboarding/validate-warm.mjs` (drives atlas
   → totalwine.com/account, retries across fresh exits, classifies logged-in/out/blocked).

## Gotchas & Watch-outs

- **The fresh-exit 403 is the VPS FINGERPRINT, structurally proven NOT a datacenter fallback.** Fail-closed-
  never-direct means a warm-open that *navigated* (and 403'd) used a verified residential exit — a datacenter
  fallback would have THROWN, not 403'd. So don't chase the exit/proxy; it's the browser fingerprint.
- **`BGW_DIAG_VERIFY_EGRESS` won't help diagnose warm-open egress** — `#verifyEgress()` is called ONLY in
  the COLD escalation path (`#openHealthyAndNavigate`, drive-controller.ts:519), never the warm path. It's
  diagnostic-only and off by default; its absence is normal. For a direct residential-egress readout you'd
  need a *cold* proxied probe.
- **cli-brand fleet-hygiene guard**: never commit the prod adminSsh / tunnel host / remote manifest / remote
  env-file literals to any committed file (HANDOFF, docs, source). Consumer codenames (`atlas`) and
  `totalwine.com` ARE public-safe and allowed. This handoff is clean; keep it that way.
- **Cookie-arms 404 reading**: `status=404 "Not Found | Total Wine & More"` with no challenge = PX CLEARED +
  logged-out (the TW app 404s `/account` when not authed), NOT a block. Only a PX challenge page / 403-with-
  PX-markers is a block.
- **Validation needs atlas's token** (prod secret, harness won't let the agent read it) — operator pulls it
  via ssh into `BGW_TOKEN`, then runs `validate-warm.mjs` with `BGW_URL=http://127.0.0.1:8080/mcp` (the
  durable tunnel must be up; LaunchAgent).
- **Don't bundle the `_pxvid` strip change** — it was disproven as the blocker this session; the critique's
  predicted dependency did not bind. Leave `stripIpBoundTokens` as-is unless fingerprint parity reopens it.
- Local `main` == `origin/main` (`e290421`); 507/507 tests pass; no open PRs. Untracked `.claude/` + `AGENTS.md`
  pre-existing, left as-is.
