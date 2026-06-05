# HANDOFF — 2026-06-05 (afternoon)

Picked up at the **U7a prod cutover** (the only "What's Next" from the prior handoff) and ran it
end-to-end: both consumer instances are now migrated from the per-session **stdio** MCP launcher to
the shared **Streamable-HTTP** transport. Then, prompted by a "shouldn't it use the proxy?" question,
shipped + deployed a `retrieve` observability improvement (block-reason), fixed a stale test gate,
and queued two plans (CAPTCHA solver, CI/CD). Prod is live on the new image; stdio is retired but kept
as the one-release rollback.

## What We Built
- **U7a prod cutover COMPLETE** (you-run/I-guide). Verified the runtime speaks native HTTP MCP
  (url + `--auth header`), built the amd64 image, passed the in-container `validate-http` deploy gate,
  stood up the long-lived `browse-gateway-http` container (host-loopback `127.0.0.1:8080`, caps
  `--cpus=1.5 --memory=3g --shm-size=1g`), registered + enabled the HTTP MCP entry, cut **both**
  consumers over. Named runbook + the cutover gotchas live in `CUTOVER.local.md` (gitignored).
- **PR #4** (`3017ba9`) — `retrieve` block-reason + escalation diagnostics. `RetrieveResult.reason`
  (`nav-failed | captcha | cf-challenge | hard-block | blocked`, derived from the final
  post-escalation render, captcha-first) + `proxyUsed`/`captchaSolved` now surface in the `retrieve`
  MCP **error** text, with a "no solver configured" hint on a captcha block. `src/verbs/retrieve.ts`,
  `src/mcp/server.ts`. 135 tests.
- **PR #5** (`db61da0`) — `scripts/validate-mcp.mjs` stale-gate fix: asserted `tools.length === 1`,
  but the live surface is `retrieve` + 10 `browser_*` since PR #2; now asserts both. (Was red on
  `main` since 2026-06-02.)
- **Prod redeployed** to image `db61da0` (`browse-gateway-http` now on `bcf9a50`; `:u7a` = rollback
  anchor). `reason=` diagnostics are LIVE.
- **docs/solutions** — `runtime-errors/retrieve-short-page-clearance-timeout.md` (`1dc4030`) and
  `integration-issues/mcp-client-env-ref-bearer-false-negative.md` (`c24ba66`).
- **Plans (local, gitignored `docs/plans/*.local.md`)** — `2026-06-05-001-feat-captcha-solver-plan`
  and `2026-06-05-002-feat-cicd-build-deploy-plan`. Plus the retrieve short-page-clearance plan in
  Proof ("Plan: 2026-06-05 retrieve short-page clearance fix").

## Decisions Made
- **reason precedence captcha-first**, derived from the FINAL render so it stays consistent with
  `blocked` (the residential-proxy learning requires post-retry derivation).
- **Conservative container caps** (`1.5cpu/3g`, down from the runbook's `1.75/4g`) given the box's
  headroom + don't-disturb-the-agents; revisit under measured load.
- **Build images `--provenance=false --sbom=false`** for a clean single-arch tarball that `docker load`s
  cleanly on the prod rootless daemon.
- **CI/CD shape**: build→GHCR auto on `main`; deploy is a **manual** `workflow_dispatch` over the
  **Tailnet** (no public SSH); **no self-hosted runner** (PUBLIC repo); keep the `validate-http` gate +
  rollback; fleet detail stays in Actions secrets, never the YAML. (Plan 002.)
- **Code-review pushback**: declined the "hoist detectCaptcha" finding — the two calls are on different
  renders (direct vs final post-escalation); hoisting would misreport the reason.
- **New standing rules saved to memory**: plans stay local (not Proof); always commit handoff +
  solution docs straight to `main`; **authorized to merge PRs** (squash green+reviewed, delete branch).

## What Didn't Work
- **~1hr lost** chasing the cutover `401` as an auth/scheme bug (raw token, `Bearer <token>`,
  double-Bearer). Root cause: the MCP client expands `${MCP_<NAME>_API_KEY}` and its **inline add-time
  connect-test runs in a stale-env process** → sends the literal `${...}` → 401. A fresh `mcp test`
  passes. Fully documented in `docs/solutions/integration-issues/mcp-client-env-ref-bearer-false-negative.md`.
- **scrapingcourse.com/cloudflare-challenge as a litmus test** — it's the stealth validator's own
  *negative control* (an interactive CF managed challenge / Turnstile). The stealth core is healthy:
  the kill-gate passed **4/4** (udemy, glassdoor, seloger, leboncoin, all `waited=0ms`). scrapingcourse
  needs the CAPTCHA solver, which is detect-only in v1.

## What's Next
1. **CAPTCHA solver** — the "all the web" unlock (interactive Turnstile/CAPTCHA tier). Plan
   `2026-06-05-001-feat-captcha-solver-plan.local.md`, **spike-first** (prove a vendor can clear a CF
   managed-challenge interstitial before building). The hook exists (`detectCaptcha` + `CaptchaSolver`
   + `BGW_CAPTCHA_API_KEY`); missing = a real solver + solve→inject→resume in `patchright-core`.
2. **retrieve short-page clearance fix** — own PR (Proof plan). `render()` polls the full ~20s on
   legit short pages (`<200` chars) because `isCleared` gates on text length; mirror `navigate()`'s
   block-phrase gating + a drive↔retrieve **parity test**.
3. **Code-review follow-ups** (in the captcha plan Phase 4): mirror `reason` on the drive `navigate`
   path (parity); structured MCP `content` item instead of free-text; `proxyUsed` on the success path.
4. **CI/CD** — Phase 1 (build→GHCR on `main`) is pure upside, do first. Phase 2 (Tailscale manual
   deploy) needs the GHCR-private + Tailscale-key + deploy-key decisions.
5. **Wikipedia `render().goto` transient** — `retrieve` once timed out + reported blocked while
   `navigate` got it in 3.1s. Separate from the length gate; re-test, investigate the silent goto catch.
6. **Parked**: bump `@mozilla/readability` ≥ 0.6.0 (low-sev ReDoS GHSA-3p6v-hrg8-8qj7), own PR.

## Gotchas & Watch-outs
- **The `${ENV_VAR}` false-negative** (above) is the #1 thing to not re-learn — capture request
  headers EARLY when debugging an MCP auth 401, before theorizing about scheme/format.
- **drive↔retrieve parity is load-bearing** — `reason` now exists on retrieve but NOT drive; the
  parity learnings flag this. Change both sides together + a parity test (tracked in the captcha plan).
- **PUBLIC repo** — no fleet detail (host/agent/path/vendor/pricing/exit-IP) in source, comments,
  commit messages, committed docs, or this file. Named detail lives in `CUTOVER.local.md` /
  `CONTEXT.local.md` / agent memory. Proof plan/doc share-links carry tokens — reference by title.
- **Container caps are conservative** (`1.5cpu/3g`) — watch `docker stats browse-gateway-http` under a
  real 2-concurrent-session load before trusting/raising.
- **Redeploy = ~10–20s browse blip** (container recreate); agents stay up, reconnect on next turn.
  Pick a quiet moment. `validate-http` gates the NEW image before the swap; `:u7a` is the rollback tag.
- **Prod image cruft** accreting on the rootless daemon (`u1`, `hardblock`, `proxyretry`, `u7a`,
  `db61da0`) — prune later (a step in CI/CD plan 002).
- **Untracked `AGENTS.md` + `.claude/`** left as-is (not created by these sessions; `.claude/` holds the
  local SSH/recon allow-rules).
