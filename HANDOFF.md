---
scope: browse-gateway-eid-artifact-task2
updated_at: 2026-08-17T08:54:20-07:00
status: ready-to-push
kind: project
review_after: null
---

# Handoff: Authorized MCP artifact retrieval — post-gauntlet

## Objective
Build Obscura into a scheduled personal bill-intelligence workflow for EID: at configured times each month, check for a new invoice, reuse an authenticated session through durable cookies with credential re-authentication as fallback, retrieve the private bill, compare it with prior months, and report useful changes, anomalies, or noteworthy details. Extract only the site-neutral primitives demanded by this working flow so the same browser-session, artifact, ingestion, and analysis capabilities can later support other utilities, banking sites, and authenticated services without turning the first implementation into a speculative platform.

## Current State
Task 2 is implemented, adversarially reviewed, and locally checkpointed on `atlas/eid-pdf-artifact-task2` at `a24aec3`. PR #140 is open, non-draft, `MERGEABLE`/`CLEAN`, with zero reviews and zero comments.

**The branch is 2 commits ahead of its own remote.** GitHub's PR head is still `1c19379`, so the green CI run on #140 covers the **pre-fix** tree — it has never seen `f76c236` or `a24aec3`. Local verification of the current HEAD is clean (`npm run typecheck` exit 0; `npm test` 1,485/1,485, 0 failed; loopback acceptance 1/1), but CI has not re-run. Nothing was pushed, merged, deployed, or exercised against live EID, and no credentials were touched.

## Project Charter
- **Operational outcome:** scheduled detection, retrieval, analysis, month-over-month comparison, and concise reporting for new EID bills.
- **Authentication:** preserve authenticated sessions with cookies; fall back to stored credentials when the session expires, within explicit private-data controls.
- **Reuse:** extract site-neutral capabilities only after the EID path demonstrates the seam; future utilities/banks should reuse proven primitives rather than drive speculative abstractions now.
- **Engineering posture:** keep it simple, safe enough for private financial documents, and iterative. Prefer fixing observed bugs over defending against low-probability hypothetical futures.
- **Risk tolerance:** medium-high for this project, while preserving hard boundaries around credential leakage, cross-consumer authorization, destructive actions, and production release.
- **Model/cost posture:** Claude Code carries most implementation work; Atlas uses OpenAI for architecture, acceptance, adjudication, and final judgment while conserving OpenAI usage.
- **Authority:** local commits are standing-authorized. Production release/deployment requires David's explicit approval.

## Canonical Sources
- `/home/node/Projects/browse-gateway-eid-artifact/.hermes/plans/2026-08-16-artifact-retrieval-mcp-transport-task2.md` — reconciled Task 2 implementation plan.
- `/home/node/.hermes/plans/2026-08-13-obscura-private-pdf-artifact-contract.md` and Amendments 3, 4, 6, and 7 — controlling artifact and response-lease contracts.
- `src/mcp/http-response-lease.ts` — Node response tracking and exactly-once lease completion.
- `src/mcp/server.ts` — `browser_get_artifact`, trusted identity snapshots, denial collapsing, and safe metadata projection.
- `src/mcp/artifact-graph-lifecycle.ts` and `src/mcp/http-main.ts` — controller disposal and process shutdown ordering.
- `test/artifact-loopback-acceptance.test.mjs` — real loopback capture/retrieval/one-shot verification.
- `docs/solutions/workflow-issues/an-approving-review-proves-nothing-until-base-and-effort-are-verified.md` — this session's review-process learning.

## What We Built This Session
Ran a staged adversarial review (`/dv:gauntlet`) over PR #140 and fixed the two blockers it produced.

**`f76c236` — `fix(gauntlet): the artifact root lock is the HTTP process's alone, and capture provenance is per-turn`** (5 files, +175/−57)

- **Blocker 1 — artifact root lock ownership + startup leak.** `buildGatewayRuntime` (`src/mcp/runtime.ts`) constructed the process-owned `ArtifactRuntime` and took its exclusive, `mkdir`-based, never-reclaimed root lock (`src/artifacts/store.ts:310`). Three non-owner callers share that builder: `src/cli/vault-host.ts` (`obscura vault login`, run via `docker exec` **inside the live gateway container**, inheriting the same artifact env), `scripts/validate-vault-host-login.mjs`, and `scripts/measure-input-realism.mjs`. Each would either be refused by the running gateway's lock or, winning it first, exit without releasing it and brick the gateway's next boot. Construction also sat *before* every fail-closed guard inside that same function (manifest, pool sizing, vault key, sticky suffix), so an ordinary config typo abandoned the lock and then masked itself behind `artifact-root-locked` on every later boot — reproduced across three processes against one root. **Fix:** the shared builder no longer constructs it at all; ownership moved to `http-main`, as the first statement inside its existing guard. Also added `httpServer.on("error", …)` — a bind failure (`EADDRNOTAVAIL` on a not-yet-assigned Tailnet address, `EADDRINUSE` on a restart race) is emitted on a later tick, never thrown into that guard, and previously killed the process still holding the lock.
- **Blocker 2 — concurrent-navigate provenance race.** `GatewayDriveController` wrote `#navigateHost` in `navigate()`'s prologue, **outside** `#serialize`. `#serialize` serializes *execution*, not *entry*, so two navigates on one MCP session had turn A read call B's host — committing the wrong `sourceHost` as a captured artifact's provenance, the never-re-derived field a consumer trusts — while A's cleanup cleared the field before B's turn, silently skipping B's capture. **Fix:** assignment, every read, and the clear now happen inside one serialized turn. The field's own doc comment had asserted the invariant the code did not hold; corrected.
- **Regressions added, each verified RED before the fix** (per the repo's "watch the guard report bad news" rule): concurrent navigates cross-attributed `alpha.example`'s capture to `bravo.example`; the shared builder constructed the runtime and took the lock; a failed boot guard abandoned the lock so the corrected config still would not boot.

**`a24aec3` — `docs: record review base and effort failure mode`** (1 file, +173) — `docs/solutions/workflow-issues/an-approving-review-proves-nothing-until-base-and-effort-are-verified.md`, capturing the two review-process failures below.

## Decisions
- **Ownership of the artifact runtime is not opt-out, it is exclusive.** Rather than adding a flag auxiliary callers must remember to pass, the shared builder never constructs the runtime — so a future auxiliary caller cannot inherit the lock by forgetting to opt out, and no guard inside the builder can leak what it never made. `loadArtifactConfig`/`buildArtifactRuntime` remain the one shared construction boundary.
- **Per-call state belongs inside the serialized turn.** The `#navigateHost` fix keeps the instance field (smallest change) but moves its whole lifetime into one turn, rather than threading a host parameter through four call sites.
- **A lineage TOCTOU was found and deliberately NOT fixed.** Two independent finders raised it; refutation established the pre-armed per-POST tracker already fences it (a lease acquired after the fence hits `register()`'s terminal branch and is completed `transport-failed`), so there is no client-visible exposure — it is a P3 runtime-contract violation, not an authorization bypass. Any future fix must `claimTimeout()` and `complete()` the raw lease before throwing, or it leaks the global response permit and deadlocks all retrieval.
- **Review scope was frozen mid-session** to the two reproducible/independently-accepted blockers, rather than fixing everything the finders surfaced. The remainder is listed under Gotchas rather than silently dropped.
- **Pre-production engineering is delegated; production remains gated.** Local commits are standing-authorized. Production release or deploy requires David's explicit approval.

## What Didn't Work
- **Reviewing against local `main`.** `git merge-base HEAD main` used a stale local `main` (`062232b`), one commit behind `origin/main` (`9364e05`, which is exactly PR #140's `baseRefOid`). That would have pulled already-merged PR #139 into scope — ~13k extra lines diluting the 1,515 lines of `src/` actually under review. Always resolve the base from the remote and assert `origin/main` == `gh pr view --json baseRefOid` == `git merge-base`.
- **Trusting the codex CLI's default reasoning effort.** `codex-cli 0.147.0` defaults `gpt-5.6-sol` to `reasoning effort: none`. The first review returned an 18-line blanket approval — no tool calls, no files read — over 1,515 lines of concurrency/authorization code. Re-run with `-c model_reasoning_effort="high"`, the same command on the same diff produced the three findings that became this session's work. Never omit the flag.
- **Refuted and not fixed:** the lineage TOCTOU (see Decisions).

## Active Tasks
- [x] Implement, review, accept, and locally checkpoint Task 2.
- [x] Publish the reviewed branch and open PR #140.
- [x] Run an adversarial review of #140; fix and locally commit the surviving blockers.
- [ ] Push `f76c236` + `a24aec3`, wait for CI green **on the new head**, then merge #140.

## Blockers and Open Questions
- **No technical blocker.** The remaining step is push → CI → merge, all of which need explicit go-ahead per the charter.
- **CI has not validated the fixes.** #140's green check is against `1c19379`; do not read it as covering the current HEAD.

## Evidence and Artifacts
- `npm run typecheck` — exit 0 at `a24aec3`.
- `npm test` — **1,485 passed, 0 failed** at `a24aec3` (was 1,482; +3 net from the new regressions).
- `test/artifact-loopback-acceptance.test.mjs` — **1/1 passed**, real temporary artifact runtime and real loopback MCP HTTP transport.
- `f76c236` — the two blocker fixes plus their regressions.
- `a24aec3` — the review-process learning doc.
- PR #140 — open, `MERGEABLE`/`CLEAN`, 0 reviews, 0 comments, head on GitHub `1c19379`.

## Uncertainty and Freshness
- All verification above applies to local `a24aec3`. GitHub has not built or tested it.
- No live portal, credentials, production deployment, or live EID access was involved at any point.
- Both fixed blockers are **latent until `BGW_ARTIFACT_CAPTURE_ENABLED=1`** — which appears in no shipped config (`docker/compose.yaml`, `Dockerfile`). They fire exactly when the feature this branch adds is switched on.

## Gotchas & Watch-outs
- **Found but NOT fixed (out of frozen scope).** Recorded so they are not lost, with honest confidence:
  - *Unvalidated (refuters were cancelled mid-run — no verdict exists):* (a) a duplicate in-flight JSON-RPC id can route artifact A's bytes to request B's socket on one session — the SDK's `_requestToStreamMapping` is id-keyed and silently overwritten — while A's tracker records `timed-out` for an artifact that actually left the process; (b) `retrieve`'s proxied re-roll loop may commit multiple artifacts per call, since a download leaves `status: null` and so fails the loop's only success-break, burning per-consumer artifact quota on copies whose IDs are never surfaced.
  - *Validated, deliberately deferred:* the P3 lineage TOCTOU (see Decisions); `closeAll`'s added `drain` plus shutdown budgets (5s drain + 8s cleanup + 10s artifact close) exceed Docker's 10s default `stop_grace_period`, risking SIGKILL with the lock held and no `stop_grace_period` set in `docker/compose.yaml`; `activate()` never sets state so a double-activate double-arms listeners, and the test named "idempotent" never calls it twice; the lease tracker is wired to the HTTP handler's `now` rather than the artifact runtime's published clock (`ArtifactRuntime.now()`), which is harmless in production only because both are `Date.now`.
- **The artifact root lock is a plain `mkdir`'d directory with no staleness reclamation.** Nothing releases it on process death and nothing adopts it on a later boot. Any new code path that constructs an `ArtifactRuntime` must own releasing it.
- **`codex exec review` emits its findings block twice, verbatim** — still true on 0.147.0. Dedupe by fingerprint when parsing, or severity counts inflate and an echo can look like a new finding.
- **`test/drive.test.mjs`'s pre-existing concurrency test asserts only that one session opens.** It passed throughout the provenance bug. Concurrency coverage in this controller is narrower than its test names suggest.
- **Gates run in-container only** (headful Chrome under Xvfb); a green host-side unit run is not evidence that browser-side behaviour holds.
- **Measurement JSON carries the egress IP** (`meta.egressIp`) and `INPUT_REALISM_OUT` has no redaction — check before pasting into a ticket, doc, or PR.

## Exact Next Action
Push `f76c236` and `a24aec3` to `origin/atlas/eid-pdf-artifact-task2`, wait for CI to go green **on the new head** (not the stale `1c19379` run), then merge PR #140. Do not deploy, enable production configuration, or use live credentials without David's explicit approval.
