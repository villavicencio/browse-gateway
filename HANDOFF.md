# HANDOFF — 2026-07-21, late afternoon

Continuation of the site-compat hardening epic (#38), **Wave 2**. Picked up on `/dv:pickup` → operator
said **"go on #41"** (typed failure-class taxonomy). Ran the full ultracode pipeline — a 4-lens pre-code
adversarial critique panel, implementation, in-container runtime gates, and an **8-round Claude↔Codex
adversarial-review loop** — then **opened PR #59, merged it, and DEPLOYED #41 to prod**. Mid-session the
operator switched IPRoyal to pay-as-you-go; verified the switch is non-breaking (CF+DataDome still clear
through the new pool).

## What We Built

- **#41 — typed failure-class taxonomy (PR #59, squash `b861ad0`).** A typed `failureClass` enum on the
  #39 failure envelope, derived by `classifyFailure` — a classifier **layered on** the block classifier
  (`resolveBlockReason`), never a parallel one. A failed call now names WHAT KIND of failure it is instead
  of opaque `blocked`/`empty-content`. Files: `observability/failure-diagnostics.ts` (`FailureClass` closed
  vocab + typed slot), `verbs/retrieve.ts` (`classifyFailure`, `wafVendorFromFailure`, `resolveFailureReason`,
  `genuineNetworkFailure`, `isChromeErrorUrl`, `FailureSignal`; chrome-error folded into the `blocked`/`reason`
  decision), `browser/detect.ts` (`hasEmptyStateMarker` / `hasUnsupportedBrowserPhrase` / `hasFrameworkRoot`
  + shared `stripInertHtml`), `mcp/drive-controller.ts` (`#failure` gated on `navFailed`), `mcp/server.ts`
  (`why` → typed class). Formalizes the old MCP `empty-content` fallback into the enum. Retrieve emits the
  full taxonomy; drive emits only the block/nav subset (a thin-200 shell on a drive navigate is a returnable
  snapshot, never auto-failed). `wafVendor` stays a **projection** of the classification (the #40 doctrine).
  **691 unit tests** (+27).
- **Deployed #41 to prod** (deploy run `29869813871`): image build (ci.yml) → `gh workflow run deploy-http.yml
  -f image_tag=latest` → gate PASS → real-config pre-swap smoke PASS → swap → verify OK, no rollback.
  **Prod now on `sha256:3c9c6e84…`; rollback anchor `sha256:6f84808f…`** (the #40 image). Tunnel health
  check `/mcp=401` ✓.
- **IPRoyal PAYG switch verified (operator switched mid-session, funded $10, cancelled subscription).** Ran
  `validate:stealth` in-container with `BGW_PROXY_*` from `.env.spike` (the sub-user creds) → **CF 3/3 +
  DataDome 3/3 cleared** through the residential exit. The "loses high-end residential IPs" warning had no
  impact on representative targets; creds unchanged (switch doesn't rotate the sub-user), as predicted.
- **Memory:** new `iproyal-payg-switch-verified.md`; updated the site-compat epic + build-progress notes;
  **compacted MEMORY.md 20.4KB→11.9KB** (moved two giant crammed index lines' detail into their topic files,
  per the read-limit hook).

## Decisions Made

- **`failureClass` is a projection-layered classifier, not a parallel one.** Block/nav classes come off
  `resolveBlockReason`; the reason===null arm sub-classifies the 200-states. `wafVendor` is set ⟺ the block
  reason is non-null, so class/vendor/proxyDiagnostic.reason can never disagree (the #40 r3 one-reason invariant).
- **chrome-error:// folded into the failure DECISION (safe); unsupported-browser phrases NOT (unsafe).** A
  `chrome-error://` URL is the browser's own error-page URL a real page can never have → zero false-positive
  → safe to fail the call. An interstitial PHRASE appears on real pages → folding it re-opens the #40
  HTML-marker false-positive class → held out (Codex re-flagged it r3+r5; scoped out and documented).
- **The Codex loop stopped at r8 WITHOUT `approve`, and that was correct.** r1–r5 were architectural
  (chrome-error consistency across gate/retry-loop/reason/diagnostics; the one-reason invariant) — all fixed,
  confirmed clean by r6. r6–r8 were regex-boundary precision on the two diagnostic detectors; fixed the cheap
  robust cases and stopped at the #40 regex-vs-DOM line (robust-best-effort is correct for a diagnostic label).
- **Three #41 deferrals, documented in code:** (1) unsupported-browser into the failure gate (false-positive
  risk); (2) `hydration-failed` is best-effort — `networkFailed` keys on request-level failures, not 4xx/5xx
  subresource *responses* (those degrade to `empty-shell`, never misclassify); (3) captcha-shell /
  DataDome-shell VENDOR attribution — needs a rendered-evidence challenge-shell detector that folds into the
  block decision (attributing a vendor while the classifier says not-blocked breaks the one-reason invariant).
- **PAYG proxy: pool test is sufficient** (operator confirmed) — no prod-tunnel double-check needed.

## What Didn't Work

- **The deploy trigger (`gh workflow run deploy-http.yml`) was blocked by the harness auto-mode classifier**
  (prod-mutating action) even with operator authorization. Worked around by having the operator run it via the
  `!` prefix so the output landed in-session. If this recurs, add a Bash permission rule for `gh workflow run`.
- **Regex can't perfectly identify a live DOM element** (the #41 restatement of the #40 lesson). Codex r6–r8
  chased ever-more-marginal false-positives in `hasFrameworkRoot` / `networkFailed` (benign `ERR_ABORTED`, a
  URL *containing* an error code, `data-id="root"`, `<p title="id='root'">`). Fixed the cheap robust cases;
  `title=" id='root' "`-style residuals are the accepted robust-best-effort limit — these are DIAGNOSTIC
  labels that never gate behavior.

## What's Next

1. **#42 (per-stage timing)** or **#43 (bounded per-call budget)** — the next Wave-2 tickets per the plan's
   dependency spine (`#39 → #40, #42 → #41 → #43 + #44 → #45 → #47 → #48`). #42 wraps `render()`/`navigate()`
   with a `timing{}` slot already declared on the envelope; #43 adds `BGW_CALL_BUDGET_MS` + fast-terminal for
   unsolvable vendors.
2. **#58 (drive action-failure vendor)** — clean standalone: compute cf/px/dd hints in the core `#snapshotOf`
   so action-failure envelopes carry the vendor too.
3. **#41 follow-ups (all documented, none blocking):** a rendered-evidence DataDome/captcha **challenge-shell
   detector** (would let a thin challenge shell attribute its vendor consistently); richer subresource-response
   capture for `hydration-failed` (4xx/5xx). If the operator wants unsupported-browser interstitials to *fail*
   the call, that's a deliberate failure-gate change to design separately.
4. The two **#50 follow-ups** (#53 health surface, #54 acquire-side `#reserved` leak) still open.

## Gotchas & Watch-outs

- **Prod runs `sha256:3c9c6e84…`** (#41, deployed 2026-07-21). **Rollback anchor `sha256:6f84808f…`** (#40).
  Deploy flow unchanged: merge → **ci.yml** builds+pushes GHCR `latest` from main → `gh workflow run
  deploy-http.yml -f image_tag=latest` → on-host `validate-http` gate → real-config pre-swap smoke → swap →
  verify → rollback. The workflow-dispatch may need the operator's `!`-prefix (classifier block, see above).
- **IPRoyal is now PAYG with a $10 balance (~1.3 GB).** Watch the burn — a gap (balance→0) means dead exits →
  `nav-failed` on escalation/warm-open. Prod uses the same sub-user creds tested (`.env.spike`); the pool
  clears CF/DataDome. The hardest PerimeterX tier (Total Wine) is untested but was never cleared pre-switch
  anyway (deferred press-&-hold spike), so no regression.
- **`git pull --ff-only origin main` before committing** — local main goes stale after a GitHub-side merge.
- **colima** was brought up for the gates (vz + Rosetta, `--platform linux/amd64` — the Dockerfile hardcodes
  the amd64 Chrome .deb, so a default `colima start` fails on `libasound2:amd64`) then STOPPED (restored to
  pre-session state). `colima start --vm-type vz --vz-rosetta --cpu 4 --memory 8 --disk 30` for future gates.
- **Codex runner** unchanged from #40: `codex exec review --base main`, run detached (buffers all output till
  the end, 0 interim lines is normal — check liveness with `ps`); strip the rmcp/codex_models_manager noise;
  the verdict is the final `codex` block. No `--dangerously…` flag (classifier blocks it). One r3-round run was
  killed mid-review and simply re-run.
- **A `wafVendor`/`failureClass` label can be occasionally-wrong on exotic pages** (the regex-vs-DOM residual)
  — it is a DIAGNOSTIC, never a behavior/security decision, so a wrong label misleads a reader, nothing more.
