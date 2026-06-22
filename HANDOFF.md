# HANDOFF — 2026-06-22

Session began with a `/pickup` (post-#21) and the question "can we hit Total Wine now?" Probing the
PerimeterX-gated Total Wine product page through the gateway exposed a detection false-negative,
which we fixed across **two PRs (#24, #25)**, deployed to prod, and then hardened through a P1 code
review. Along the way we discovered prod had **never been deployed since 2026-06-10** (so #21 only
went live this session), and we wrote a spike plan for actually *defeating* the press-&-hold. The
gateway now correctly **classifies** PerimeterX with diagnostics; it still does not **clear** it.

## What We Built

- **PR #24 (`4aacb66`) — PX 200-challenge detection, first pass. MERGED + DEPLOYED.**
  `isPerimeterXChallenge(signal, pxHint)` = `pxHint && thin render.text`. Closed the case where a 200
  PX challenge left the top document empty. Files: `src/browser/detect.ts`, `src/browser/index.ts`,
  `src/verbs/retrieve.ts` (classifyBlock gate + blocked decision + proxy retry-break).
- **PR #25 (`b1316ae`) — completed the detection. MERGED + DEPLOYED; reviewer signed off.**
  - `hasPerimeterXChallengeCopy(html)` — matches the press-&-hold copy in page source, **decoding
    `&amp;` first** ("Press & Hold" serializes as "Press &amp; Hold" in outerHTML).
  - **Child-frame capture (the P1 fix):** `patchright-core.ts` `snapshot()` now walks `page.frames()`
    and concatenates each child's `content()` into a new **`frameHtml`** field on `PageSignal` +
    `RenderResult` — **gated on `hasPerimeterXHint(top html)`** so ordinary pages with ad iframes
    don't pay the walk. Needed because `render.html` = `page.content()` = **top frame only**.
  - `retrieve.ts` `hasPxChallengeCopy(render)` reads `render.html` **and** `render.frameHtml`;
    used in the blocked decision + retry-break. `pxCopy` added to `BlockSignal`.
  - **`scripts/validate-frame-capture.mjs`** (+ `npm run validate:frame-capture`) — real-browser proof
    with a cross-origin `data:` child frame. 5/5 PASS.
  - Tests: `test/retrieve.test.mjs` (top-document interstitial + iframe-only-in-`frameHtml` cases),
    `test/block-classifier.test.mjs`. **312 unit tests green.**
- **Solution doc:** `docs/solutions/integration-issues/perimeterx-200-iframe-challenge-false-negative.md`
  (root cause + both follow-ups + the `page.content()`-is-top-frame-only lesson).
- **Spike plan (gitignored):** `docs/plans/2026-06-22-001-spike-defeat-perimeterx-press-hold.local.md`
  — Track A avoidance / Track B gesture / Track C solver, strategy gate, architecture decisions.
- **Deployed to prod 3×** this session via `deploy-http.yml` (`-f image_tag=latest`): #24, then #25
  (twice — the P1 fix re-deployed). Re-probe confirms `retrieve` + `drive` both return
  `reason=perimeterx-challenge` + structured `proxyDiagnostic`.
- **Throwaway probes (gitignored):** `scripts/probe-totalwine-gateway.local.mjs`,
  `scripts/probe-totalwine-200-chase.local.mjs` — keep for post-deploy re-verification.

## Decisions Made

- **Detection keys on the challenge COPY in the page source** (top-doc HTML **+** child-frame HTML),
  gated by `pxHint`. NOT `pxHint` alone (the `px-captcha` marker persists on a *cleared* page — a
  cleared Total Wine page has a dormant `px-captcha-modal` iframe). NOT `render.text` alone (it is
  top-document `innerText` only — iframe-served copy never reaches it).
- **Child-frame walk is gated on a top-doc PX marker** for performance — verified Playwright reads a
  **cross-origin** frame's `content()` (per-frame over CDP, not same-origin in-page JS).
- **PX-defeat = avoidance-first.** Track A (warm-up nav homepage→category→target + session/cookie
  persistence + IP hygiene + fingerprint coherence). Track B (gesture automation) is gated on an
  **`isTrusted=false` kill-test** (browser-enforced; Patchright can't forge synthetic-input trust) +
  a venture need. Track C (commercial solvers) **ruled out** — CapSolver PX "Coming Soon", 2Captcha
  unavailable, no portable token API, `_px3` expires ~60s.
- **Strategy gate:** defeating PX is **substrate-polish unless venture-pulled** — stop after Track A
  if exploratory.
- **Architecture:** gesture automation would need a **new policy-gated internal primitive below the
  verb layer**, NOT raw input/CDP exposed to consumers (preserves the single-policy invariant).
- **Standing workflow pref (saved to memory):** every external code-review round, after addressing
  findings, `pbcopy` a paste-ready reviewer reply (finding → fix+sha → verification → carry-overs →
  "please re-review") until the reviewer is satisfied.

## What Didn't Work

- **#24's thin-content-only test was incomplete** — missed the *boundary-length* 200 (top-doc
  innerText just over the 200-char bar). A live 200-chase caught it still returning as content. → #25.
- **#25's first pass (`hasPerimeterXChallengeCopy(render.html)`) was ALSO incomplete (P1 review):**
  `render.html` = `page.content()` = top frame only, so a challenge whose copy stays inside the
  `px-captcha-modal` child frame was still a false negative; the test put the phrase in a top-level
  `<div>`. → child-frame capture (`frameHtml`).
- **HTML entity gotcha:** "Press & Hold" → "Press &amp; Hold" in `outerHTML` defeats a literal
  `/press\s*&\s*hold/` — `hasPerimeterXChallengeCopy` decodes `&amp;` first.
- **Browserbase remote unusable** on the current API key — proxies + verified/advanced-stealth are
  gated to paid plans (402/403). Used **local Chrome** (residential IP) for recon instead.

## What's Next

1. **PX-defeat spike, Track A** (the plan's recommended first step): build warm-up navigation +
   session/cookie persistence, then **measure the challenge-rate delta** on Total Wine through the
   gateway. That number decides whether Track B (gesture automation) is ever needed. Gated on the
   strategy decision (is this venture-pulled?).
2. **Drive-path frame-capture follow-up:** drive builds its own `PageSnapshot` (ariaSnapshot), not
   `render`/`snapshot`, so it does NOT get `frameHtml` — a fat-iframe-200 on the *drive* path still
   slips. Explicitly out of #25's retrieve-focused scope; the tracked gap.
3. **Cookie/session-state vault** (operator question this session): persistent per-consumer browser
   context (cookies + store-selection + logins), encrypted at rest, R9-redacted, per-consumer
   isolated. Scoped in the spike plan §7; overlaps Track A2. Not built.
4. **Deferred #21 follow-ups:** audit-log `diagnostics` field; per-call `{verifyEgress}` option +
   retrieve-path egress probe.
5. **Operator-only:** IPRoyal monthly → PAYG (fund before cancelling; re-verify the 3 `BGW_PROXY_*`).

## Gotchas & Watch-outs

- **⚠️ ROTATE the Browserbase API key** — its value was echoed to the session transcript twice while
  grepping env / `~/.claude.json`. It wasn't exfiltrated, but it's in transcript history. (browserbase.com/settings)
- **Prod was pre-#21 until this session.** The `deploy-http` workflow had no successful run between
  2026-06-10 and today, so this session shipped #21 + #24 + #25 to prod for the *first* time.
  `keys new --apply` restarts with the *existing* image (no GHCR pull), so consumer onboarding never
  deployed code. Mental-model correction vs. prior handoffs that treated #21 as live.
- **The `:8080` tunnel is currently UP** (brought up this session via
  `launchctl bootstrap … com.dvillavicencio.browse-gateway-tunnel.plist`). Take down with
  `launchctl bootout gui/$(id -u)/com.dvillavicencio.browse-gateway-tunnel` if desired. Ops in `TUNNEL.local.md`.
- **Deploy flow:** merge → CI `build-image` pushes `latest` to GHCR → `gh workflow run deploy-http.yml
  -f image_tag=latest` → watch gate→swap→verify. The `build-image` job is **flaky on a Docker Hub
  oauth-token fetch** (transient `connection reset` pulling the base image) — `gh run rerun <id> --failed`.
- **Agent merges PRs (green+reviewed) but does NOT push `main`** — the main-push classifier is the
  gated path; PR merges via `gh` are fine.
- **PerimeterX is still CLASSIFIED, not CLEARED** — press-&-hold fires even on residential local
  Chrome (behavioral, not IP-reputation). Defeating it is the spike, not done.
- **`BGW_MAX_SESSIONS=7`** sits exactly at the boot floor for 3 consumers (atlas, vault, argus) — a
  4th crosses it; bump it (or drop `perConsumerMax`) in the same change or the boot guard crash-loops.
- **Coded language in force:** "atlas / vault / argus" are public codenames; real ids, prod host,
  paths, tokens live only in agent memory + `*.local.md` (repo is PUBLIC).
- **Untracked `.claude/` + `AGENTS.md`** left as-is (pre-existing).
