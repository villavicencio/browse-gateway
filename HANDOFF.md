# HANDOFF — 2026-07-21

Continuation of the site-compat hardening epic (#38), Wave 2. Picked up on `/dv:pickup` → operator said
**"go on #40"** (surface mitigation/CAPTCHA vendor + add a DataDome branch to `classifyBlock`). Ran the
full ultracode pipeline — a pre-code 4-lens adversarial critique panel, implementation, in-container
runtime gates, and an **8-round Claude↔Codex adversarial-review loop** — then **merged #40 (PR #57,
squash `7205567`), filed the follow-ups, and DEPLOYED #40 to prod**. Operator ratified the stopping
point (2 reasoned residuals routed to #41/#44 rather than scope-creeping detection into #40).

**Prod now runs #40 — image `sha256:6f84808f…`** (deployed 2026-07-21, run `29852396208`: gate PASS →
smoke PASS → swap → verify OK, no rollback). **Rollback anchor = `sha256:86ba92ac…`** (the prior #50
image / `580b1ad`). Tree clean, `main == origin/main`, no open PRs. **Three #40 follow-ups filed:
#41** (empty-shell, comment), **#44** (Turnstile kind, comment), **#58** (drive action-failure vendor gap,
standalone issue).

## What shipped (#40, PR #57)

A failure envelope now names WHO blocked, at retrieve↔drive parity:
- **`classifyBlock` + `datadome-challenge` branch** (`ddHint`) — a DataDome block stops falling through
  to generic `blocked`/`hard-block`. Escalation is untouched (it keys off raw `isHardBlock`/
  `isCloudflareBlock`, not the label).
- **`wafVendor` on the #39 envelope** (both paths), a **PROJECTION of `BlockReason`**
  (`wafVendorFromReason`) — never a second classifier, so vendor and reason can't disagree. Shared
  `resolveBlockReason(signal)` keeps retrieve/drive/escalation-diagnostics from drifting.
- **WAF-first precedence**: a specific vendor (cf/px/datadome) wins; a CAPTCHA attributes only an
  otherwise-generic block, so a page that merely preloads a captcha library can't override the WAF.
- **`WafVendor` closed-vocab TYPE** (moved to observability) on the envelope slot — redaction
  pass-through enforced by the compiler, not a comment.
- **`activeCaptchaKind`** (browser/captcha.ts) — CAPTCHA kind from real RENDERED evidence (container
  class-token + real `data-sitekey=` attr / rendered iframe / `<kind>-response` field), catching
  declarative + explicit-render widgets while rejecting loaded libraries, comments/templates, compound/
  pseudo classes, and `data-*` suffixes.

**664 unit tests**; in-container `validate:failure-envelope` PASS (the load-bearing "nav-failed
fabricates no `wafVendor`" assertion held on live evidence) + `validate:stealth` PASS (kill-gate, no
regression — #40 doesn't touch the stealth path).

## Decisions made

- **Design hardened by a 4-lens critique panel BEFORE coding** — it caught that a standalone vendor
  classifier would contradict `classifyBlock`; the derive-from-reason design makes them structurally
  consistent. Higher-signal than a generate-and-judge panel.
- **The Codex loop stopped at r8 without `approve`, by design.** Every *in-scope* finding across 8 rounds
  was fixed (drive parity, WAF-override regression, sitekey cross-labeling, explicit-render regression,
  and a cascade of regex false-positives). `approve` was unreachable because Codex re-flags the
  empty-shell finding every round, and fixing it means scope-creeping #41 into #40 — the
  "verify-don't-blind-accept overrides drive-to-approve" case. Presented to the operator, who ratified.

## Follow-ups filed (residuals, deliberately out of #40's labeling scope)

1. **#41 (empty-shell)** — comment filed. A 200 CAPTCHA/DataDome shell with no visible phrase fails via
   retrieve's empty-markdown arm with `reason=null`, so no vendor surfaces. Folding it into the `blocked`
   DECISION would false-positive real pages with an incidental widget (the class `detect.ts` avoids).
   #41's named "empty-shell" failure class owns it; the pieces (`activeCaptchaKind`, `hasDataDomeHint`,
   `wafVendorFromReason`) are in place.
2. **#44 (Turnstile kind)** — comment filed. A rendered Turnstile widget's iframe carries
   `challenge-platform` → `cfHint` → attributes `cloudflare` (a correct coarser mitigation vendor —
   Turnstile IS Cloudflare). The finer `turnstile` kind matters for solver eligibility; separating an
   embedded widget from a managed challenge needs a captured managed-challenge fixture first.
3. **Drive ACTION-failure envelopes** carry no vendor — a bare `snapshot()` computes no hints (inherited
   #39 gap). Documented in `drive-controller.ts` `#failure` docstring; NOT yet a standalone issue
   (offered to file — operator hasn't said). Fix = compute cf/px/dd hints in the core `#snapshotOf`
   (closes the cf/px gap too; cost = `page.content()` per action).

## What didn't work / gotchas

- **Regex can't verify "a live DOM element."** Six Codex rounds chased ever-more-marginal HTML-substring
  false-positives (compound class, comment, `data-*` suffix). The escape was reframing to RENDERED
  evidence (container+sitekey / iframe / response-field), not more class-substring precision. For a
  diagnostic *label*, robust-best-effort at the regex altitude is correct; perfect active-element
  detection is a DOM-parse concern the whole `detect.ts` layer forgoes. See
  `docs/solutions/architecture-patterns/vendor-label-as-projection-not-parallel-classifier.md`.
- **colima flakiness:** the final gate rebuild hit a Docker layer-cache snapshot corruption
  (`apply layer error … parent snapshot … not found`) — infra, not code. A fresh image tag + retry
  cleared it. colima was brought up for the gates then **stopped** (restored to prior state); `colima
  start` for future gates.
- **`codex-companion.mjs` is gone** (lived in a prior session's scratch). The loop now drives the
  `codex` CLI directly: `codex exec review --base main` (run detached; buffers all output until the end;
  strip the `rmcp::transport::worker`/`codex_models_manager` MCP-noise lines; verdict is the final
  `codex` block). `--base` can't combine with a custom prompt (default review only). Do NOT pass
  `--dangerously-bypass-approvals-and-sandbox` — the harness safety classifier blocks it; the plain
  sandboxed review works read-only.
- **`git pull --ff-only origin main` before committing** — local main goes stale after a GitHub-side merge.

## What's next

1. **#41 (typed failure-class taxonomy)** — the natural next Wave-2 ticket, and it now has the #40
   empty-shell input captured on it. Depends on #39 signals + #40 vendor (both live). This is where the
   200-status empty-shell/hydration-failed/real-zero states get separated.
2. **#42/#43/#44** (per-stage timing, wall-clock budget, CAPTCHA solver eligibility+reason) → #45 → #47 → #48.
3. **#40 is DEPLOYED** (prod = `6f84808f`). The three #40 follow-ups (#41 empty-shell, #44 Turnstile,
   #58 drive action-failure vendor) are open; #58 is a clean standalone hardening (compute hints in the
   core `#snapshotOf`).
4. The two #50 follow-ups (#53 health surface, #54 acquire-side `#reserved` leak) still open.

Plan doc: `docs/plans/2026-07-17-001-site-compatibility-hardening.local.md` (gitignored, self-contained).
