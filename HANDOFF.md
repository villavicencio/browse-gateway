# HANDOFF — 2026-06-06 (afternoon)

Picked up from the U7a cutover handoff with "go with the spike" on the CAPTCHA-solver feature, and ran
the full arc: spike → re-scope → build → two review rounds → merge. The spike's real value was
**inverting the premise**: the Cloudflare *managed-challenge* tier needs no solver (the stealth browser
on a residential exit clears it on its own — that's the existing R7 escalation, screenshot-verified), so
the solver was re-scoped to **interactive token-CAPTCHAs** (reCAPTCHA/Turnstile) on the **drive** path,
where the browser genuinely can't pass an image grid. Feature shipped to `main` (PR #6), config-gated and
dormant until enabled.

## What We Built
- **PR #6 (merged, `ff45413`) — interactive CAPTCHA solver on the drive path.** Five commits:
  - `HttpCaptchaSolver` (`src/verbs/captcha-solver.ts`) — provider-neutral `createTask`/`getTaskResult`
    client. Endpoint is config (`BGW_CAPTCHA_API_URL`), key is a BYO secret (`BGW_CAPTCHA_API_KEY`). Typed
    failures (`CaptchaSolveError`), per-window solve budget (`DEFAULT_CAPTCHA_BUDGET` = 5/60s), a hard
    deadline enforced **per HTTP request** (AbortController) so a stalled vendor call can't hang the caller,
    R9 (key never reaches an error/log). 18 unit tests.
  - **Seam moved to the browser layer** (`src/browser/captcha.ts`) — `CaptchaSolver`/`detectCaptcha`/
    `NullCaptchaSolver` + new live helpers (`DETECT_LIVE_CAPTCHA_JS`, `liveCaptchaToChallenge`,
    `injectTokenJs`); `src/verbs/captcha.ts` re-exports for back-compat.
  - **Core auto-solve** (`src/browser/patchright-core.ts` `#trySolveCaptcha`, called from `#settle`) —
    reads the live widget + real sitekey, gates on an empty response field (never speculative), solves,
    re-verifies url+sitekey, injects the token **in the page's main world** (`addScriptTag`), and replays
    the triggering action once for submit-gated forms (skipping replay when a callback advanced the page).
  - Wired via `BrowserCoreOptions.solver` in both entrypoints (`src/mcp/main.ts`, `src/mcp/http-main.ts`).
    `render()`/`retrieve` never invoke it.
- **159 unit tests green; typecheck clean; `validate-drive/http/retrieve` pass.**
- **Plan updated:** `docs/plans/2026-06-05-001-feat-captcha-solver-plan.local.md` (gitignored) carries the
  spike conclusion, the re-scope, the review fixes, and the deferred follow-ups.
- **Memory updated** (gitignored agent memory): captcha-solver conclusion, Evomi/sticky proxy research,
  and a new **`patchright-evaluate-isolated-world`** learning.

## Decisions Made
- **Solver tier = interactive reCAPTCHA/Turnstile on the drive path**, NOT CF managed challenges (those
  are cleared by residential escalation). The original "scrapingcourse needs a solver" premise was an
  artifact of testing from a non-residential IP — falsified by the spike.
- **Mechanism = token path** (`*-response` inject + action replay), NOT a `cf_clearance` cookie. reCAPTCHA
  tokens aren't IP-bound, so the solve is proxyless and no sticky proxy is needed (the sticky/cookie
  analysis applied only to the descoped CF tier).
- **Transparent auto-solve** (during settle), not an explicit agent verb — matches how proxy escalation /
  clearance polling already work; satisfies agent-native parity for the "get past a CAPTCHA" capability.
- **Provider-neutral by design** for public-repo hygiene: no provider/endpoint named in committed source;
  provider is purely deployment config.
- **Inject in the page MAIN world** (`addScriptTag`), because `page.evaluate` is isolated-world and can't
  see the page's `window` (so firing a site's data-callback silently no-ops there).
- **Action-replay continuation**: replay the triggering action once after a solve to complete a
  submit-gated form; skip the replay when the page already advanced (URL **or** visible-body-text change)
  to avoid double-submitting callback-driven flows.

## What Didn't Work
- **A vendor `AntiCloudflareTask`-style call for the CF managed challenge** — fast-failed ($0) because,
  once the stealth browser clears the interstitial, there's no challenge left to solve. Wrong tool/tier.
- **hCaptcha via the chosen provider** — its proxyless hCaptcha task is rejected ("we don't support this
  service"); hCaptcha is absent from its current supported-types list. Deferred to a second provider behind
  the same seam (the browser DOES get stuck on hCaptcha, so the need is real).
- **First continuation attempt (callback-only)** — left submit-gated forms stalled (PR review P1 #1).
- **URL-only "did it advance" guard** — double-submitted callback-driven flows (PR review P1 #2). Root
  cause was the isolated-world inject: the callback never fired, so the page never advanced, so the guard
  always replayed. Fixed by main-world inject + body-text guard.

## What's Next
1. **(When ready) Activate in prod** — set `BGW_CAPTCHA_API_URL` + `BGW_CAPTCHA_API_KEY` in the deployment
   secrets, rebuild the amd64 image, redeploy `browse-gateway-http` (the `validate-http` gate + rollback tag
   still apply, per the cutover runbook). Dormant until then.
2. **Deferred follow-ups** (documented in the captcha plan, non-blocking): per-consumer budget keying (the
   budget is per-process — http-main noisy-neighbor); tighten live detection so invisible/v3/enterprise
   reCAPTCHA isn't solved as v2; add a `captchaSolved` signal to the drive snapshot (retrieve has one —
   observability parity); wire a second provider for hCaptcha; remove `retrieve`'s vestigial solver hook
   (changes its result contract).
3. **CI/CD Phase 1** (build→GHCR on `main`) — still the pure-upside next infra step (plan 002).
4. **retrieve short-page clearance fix** + the Wikipedia transient — pre-existing backlog from prior handoff.

## Gotchas & Watch-outs
- **`page.evaluate` is isolated-world** (Patchright/Playwright) — shares the DOM but NOT page `window`
  globals. To reach page globals or fire a site's callback, inject main-world JS via `addScriptTag`. This
  cost two debugging passes; see memory `patchright-evaluate-isolated-world`.
- **PUBLIC repo** — no provider/proxy/endpoint/exit-IP/pricing in source, comments, commit messages, this
  file, or PR bodies. Named detail lives only in `*.local.md` / agent memory.
- **The solver is config-gated** — absent `BGW_CAPTCHA_API_URL`+key, it's simply not constructed and a
  detected CAPTCHA is left to fail. Enabling it has no effect until a redeploy carries the new image AND
  the config.
- **Budget is per-process** (5 solves/60s on one shared instance) — fine for the stdio-per-agent model;
  under the HTTP multi-consumer transport it's a shared bucket (noisy-neighbor). Key per consumer before
  leaning on it at scale.
- **Replay is bounded to once** and skipped on same-page/AJAX advance; if a site reads the widget's JS
  response API rather than the form field, neither inject nor replay helps (known limitation — needs deeper
  widget integration).
- **Untracked `.claude/` + `AGENTS.md`** left as-is (not created this session). Gitignored spike harnesses
  (`scripts/spike-*.local.mjs`) + `.env.spike` remain as repro/verification artifacts.
