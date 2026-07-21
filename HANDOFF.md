# HANDOFF — 2026-07-21, afternoon

Continuation of the site-compat hardening epic (#38), **Wave 2**. Picked up on `/dv:pickup` → operator
said **"go on #40"** (surface mitigation/CAPTCHA vendor + add a DataDome branch to `classifyBlock`). Ran
the full ultracode pipeline — a pre-code 4-lens adversarial critique panel, implementation, in-container
runtime gates, and an **8-round Claude↔Codex adversarial-review loop** — then **merged (PR #57), filed
three follow-ups, and DEPLOYED #40 to prod**. Prod moved off the #50 image for the first time since
yesterday.

## What We Built

- **#40 — surface mitigation/CAPTCHA vendor + DataDome branch (PR #57, squash `7205567`).** A retrieve/
  drive failure envelope now names WHO blocked, at retrieve↔drive parity. Files: `verbs/retrieve.ts`
  (BlockReason `+datadome-challenge`, BlockSignal `+ddHint/+captchaKind`, `resolveBlockReason`,
  `wafVendorFromReason`), `browser/detect.ts` (`DD_VENDOR_HINTS`/`hasDataDomeHint`), `browser/captcha.ts`
  (`activeCaptchaKind`), `observability/failure-diagnostics.ts` (`WafVendor` type + typed slot),
  `browser/patchright-core.ts` (`navigate()` carries the hints), `mcp/drive-controller.ts` (`#signalOf`/
  `#failure` derive the vendor), `mcp/server.ts` (`formatSnapshot` shows `ddHint`).
  - `classifyBlock` gains a `datadome-challenge` branch (`ddHint`) — DataDome stops falling through to
    generic `blocked`/`hard-block`. Escalation untouched (keys off raw `isHardBlock`/`isCloudflareBlock`).
  - `wafVendor` is a **PROJECTION of `BlockReason`** (`wafVendorFromReason`), never a second classifier —
    vendor and reason can't disagree. Shared `resolveBlockReason(signal)` keeps retrieve/drive/escalation-
    diagnostics from drifting. **WAF-first precedence**: a specific vendor (cf/px/dd) wins; a CAPTCHA
    attributes only an otherwise-generic block.
  - `WafVendor` is a **closed-vocab TYPE** on the envelope slot (moved to observability) — redaction
    pass-through enforced by the compiler.
  - `activeCaptchaKind` attributes the CAPTCHA kind from **real RENDERED evidence** (container class-token
    + real `data-sitekey=` attr / rendered iframe / `<kind>-response` field), catching declarative +
    explicit-render widgets while rejecting loaded libraries, comments/templates, compound/pseudo classes,
    and `data-*` suffixes.
  - **664 unit tests** (+29); in-container `validate:failure-envelope` PASS (the load-bearing "nav-failed
    fabricates no `wafVendor`" assertion held on live evidence) + `validate:stealth` PASS (kill-gate).
- **Deployed #40 to prod** (run `29852396208`): gate PASS → smoke PASS → swap → verify OK, no rollback.
- **Docs → main**: `docs/solutions/architecture-patterns/vendor-label-as-projection-not-parallel-classifier.md`
  (the two durable lessons below).
- **Three follow-ups filed:** **#41** (empty-shell) + **#44** (Turnstile kind) as comments on those
  tickets; **#58** as a standalone issue (drive action-failure vendor gap).

## Decisions Made

- **`wafVendor` is a projection of the classifier, not a parallel one.** The first design had a
  standalone `wafVendorOf` with its own precedence; all four critique-panel lenses caught that it
  *contradicted* `classifyBlock` (a page could ship `reason=cf-challenge` with `wafVendor=datadome`).
  Deriving vendor FROM `BlockReason` makes them structurally unable to disagree. Pattern doc'd for #41.
- **The Codex loop stopped at r8 WITHOUT `approve`, and that was correct.** Every *in-scope* finding
  across 8 rounds was fixed. `approve` was unreachable only because Codex re-flags the **empty-shell**
  case every round — fixing it means folding new detection into the `blocked` DECISION (false-positives
  real pages with an incidental widget) which is **#41's** scope. "Verify-don't-blind-accept" overrides
  "drive-to-approve" when `approve` is only reachable by scope-creep. Presented; operator ratified.
- **Turnstile → `cloudflare` shipped as-is** (not `turnstile`). Turnstile IS Cloudflare; a coarser-but-
  correct mitigation-vendor label. Finer kind is a #44 solver concern needing a captured managed-challenge
  fixture — chose not to guess. (→ #44)
- **Deployed immediately after merge** on operator instruction ("merge + file the two follow-ups" → then
  "file it and deploy"). #40 is pure classification/labeling (no stealth/browser/network-path change), so
  low prod risk; the on-host gate confirmed it.

## What Didn't Work

- **Regex can't verify "a live DOM element."** Six Codex rounds chased ever-more-marginal HTML-substring
  false-positives (compound class `g-recaptcha-wrapper` → comment/`<template>` → `data-*` suffix). The
  escape was NOT more class-substring precision — it was reframing to RENDERED evidence (container+sitekey
  / iframe / response-field). For a diagnostic *label*, robust-best-effort at the regex altitude is
  correct; perfect active-element detection is a DOM-parse concern the whole `detect.ts` layer forgoes.
- **The final gate rebuild hit a Docker layer-cache snapshot corruption** (`apply layer error … parent
  snapshot … not found`) — infra, not code. A fresh image tag + retry cleared it.

## What's Next

1. **#41 (typed failure-class taxonomy)** — the natural next Wave-2 ticket; it now has the #40 empty-shell
   input captured on it (comment). Depends on #39 signals + #40 vendor (both live in prod). Where the
   200-status empty-shell / hydration-failed / real-zero-results states get separated.
2. **#58 (drive action-failure vendor)** — clean standalone hardening: compute cf/px/dd hints in the core
   `#snapshotOf` so action-failure envelopes carry the vendor too (also closes the pre-existing cf/px gap;
   cost = `page.content()` per action snapshot).
3. **#44** (CAPTCHA solver eligibility — carries the Turnstile-kind follow-up) → **#42/#43** (timing,
   budget) → **#45** → **#47** → **#48**, per the plan's dependency spine.
4. The two **#50 follow-ups** (#53 health surface, #54 acquire-side `#reserved` leak) still open.

Plan doc: `docs/plans/2026-07-17-001-site-compatibility-hardening.local.md` (gitignored, self-contained).

## Gotchas & Watch-outs

- **Prod runs `sha256:6f84808f…`** (#40, deployed 2026-07-21). **Rollback anchor `sha256:86ba92ac…`**
  (the #50 / `580b1ad` image). Deploy flow unchanged: merge → **ci.yml** builds+pushes GHCR `latest`
  from main → `gh workflow run deploy-http.yml -f image_tag=latest` → on-host `validate-http` gate →
  real-config pre-swap smoke → swap → verify → rollback.
- **The Codex runner CHANGED:** `codex-companion.mjs` is GONE (prior plugin-cache version). The loop now
  drives the `codex` CLI directly — `codex exec review --base main` (run detached; buffers ALL output
  until the end, so 0 interim lines is normal — check liveness with `ps`, not the log; strip the
  `rmcp::transport::worker`/`codex_models_manager` MCP-noise lines; the verdict is the final `codex`
  block). `--base` can't combine with a custom prompt (default review only). Do NOT pass
  `--dangerously-bypass-approvals-and-sandbox` — the harness safety classifier blocks it. (Also updated
  in the `codex-review-loop-sop` memory.)
- **colima was brought up for the gates then STOPPED** (restored to pre-session state). `colima start`
  for future in-container gates.
- **`git pull --ff-only origin main` before committing** — local main goes stale after a GitHub-side merge.
- **A vendor `wafVendor` label can be occasionally-wrong on exotic pages** (the regex-vs-DOM residual) —
  it is a DIAGNOSTIC, never a behavior/security decision, so a wrong label misleads a reader, nothing more.
