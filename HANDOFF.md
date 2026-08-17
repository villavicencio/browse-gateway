---
scope: browse-gateway-eid-bill-intelligence
updated_at: 2026-08-17T09:45:00-07:00
status: local-commit-ready
kind: project
review_after: null
---

# Handoff: Bounded stabilization slice — two deferred gauntlet findings closed

## Objective
Build Obscura into a scheduled personal bill-intelligence workflow for EID: at configured times each month, check for a new invoice, reuse an authenticated session through durable cookies with credential re-authentication as fallback, retrieve the private bill, compare it with prior months, and report useful changes, anomalies, or noteworthy details. Extract only the site-neutral primitives demanded by this working flow so the same browser-session, artifact, ingestion, and analysis capabilities can later support other utilities, banking sites, and authenticated services without turning the first implementation into a speculative platform.

## Current State
PR #140 merged earlier this session (`1dfcd1c`, 2026-08-17T16:00:51Z), so the previous handoff's "Exact Next Action" is done and there are **no open PRs**. This worktree (`browse-gateway-eid-bill-intelligence`, branch `atlas/eid-bill-intelligence`) was created immediately after that merge.

This session ran a **bounded stabilization slice** — deliberately scoped to exactly two deferred findings from the #140 gauntlet, no broad review. Both reproduced, both are fixed, and the work is locally committed at `0617556` (1 commit ahead of `origin/main`, working tree clean). Nothing was pushed, deployed, enabled, or run against credentials or the live EID portal.

Both fixed defects remain **latent until `BGW_ARTIFACT_CAPTURE_ENABLED=1`**, which still appears in no shipped config (`docker/compose.yaml`, `Dockerfile`, CI).

## Project Charter
- **Operational outcome:** scheduled detection, retrieval, analysis, month-over-month comparison, and concise reporting for new EID bills.
- **Authentication:** preserve authenticated sessions with cookies; fall back to stored credentials when the session expires, within explicit private-data controls.
- **Reuse:** extract site-neutral capabilities only after the EID path demonstrates the seam.
- **Engineering posture:** keep it simple, safe enough for private financial documents, iterative. Prefer fixing observed bugs over defending against low-probability hypotheticals.
- **Risk tolerance:** medium-high, while preserving hard boundaries around credential leakage, cross-consumer authorization, destructive actions, and production release.
- **Authority:** local commits are standing-authorized. Production release/deployment requires David's explicit approval.

## Canonical Sources
- `/home/node/.hermes/plans/2026-08-13_212203-automate-eid-statement-ingestion-with-obscura.md` — the master ingestion plan (Tasks 1–12). Its Task 1 is the live-portal spike, still blocked on David.
- `/home/node/.hermes/plans/2026-08-13-obscura-private-pdf-artifact-contract.md` + Amendments 1–7 — the controlling artifact contract. Tasks A–F shipped (#139, #140); **Tasks G and H remain**.
- `/home/node/Projects/browse-gateway-eid-artifact/.hermes/plans/2026-08-16-artifact-retrieval-mcp-transport-task2.md` — the reconciled Task 2 plan (lives in the task1 worktree; the task2 worktree's copy is gone).
- `src/mcp/http-server.ts` — the duplicate-request-id gate, alongside the existing batch gate.
- `src/mcp/artifact-graph-lifecycle.ts` — `runShutdownSequence` plus the now-exported budgets and `worstCaseShutdownMs`.
- `scripts/deploy/launch-http.sh` — the SINGLE source of truth for the production `docker run`. Compose is **not** on the deploy path.
- `~/Obsidian/browse-gateway/verification-logs/2026-08-17-*.log` — RED evidence for both findings plus the full final-tree verification run.

## What We Built This Session
**`0617556` — `fix(stabilization): a duplicate in-flight request id cross-routes artifact bytes, and the stop grace cannot cover the lock`** (8 files, +581/−10)

**Finding 1 — duplicate in-flight JSON-RPC id. REPRODUCED, fixed.**
- Root cause is in the installed SDK 1.29.0: `webStandardStreamableHttp.js` does an **unconditional** `_requestToStreamMapping.set(message.id, streamId)` per dispatched request (lines 485 and 531), and `send()` resolves a response through `_requestToStreamMapping.get(message.id)` (line 697). Two concurrent POSTs on one session sharing an id collapse onto one entry.
- **Measured** over a real loopback session with a real captured fixture artifact (`test/artifact-request-id-routing.test.mjs`, new): the *second* POST's response returned **HTTP 200 carrying the first POST's private PDF bytes**; the artifact POST itself **never received a response**; and the lease recorded **`transport-failed`** for bytes already delivered to the client — an audit saying "not sent" about a completed transfer, contradicting Task 2 §5.3's meaning of `sent`.
- **Severity is bounded and was checked, not assumed.** One-shot semantics hold (`types.ts:192–194` — "No outcome … returns it to available"), and there is no cross-consumer exposure: both requests live on one session, hence one consumer. It requires a client that reuses an in-flight id, which the SDK cannot honour either way (its own `send()` throws `No connection established` for the loser).
- **Fix:** refuse the newcomer *before dispatch*, in the same place and the same class as the existing §3.6 batch gate. Per-session `inFlightIds` set; ids released inside the existing `finally` blocks **after** `await tracker.settled`, so the artifact branch's ordering is byte-identical. `jsonRpcRequestIds()` covers batch bodies too, since the SDK's collision does not care whether the colliding dispatch arrived alone or in a batch.

**Finding 2 — shutdown budget vs container stop grace. REPRODUCED, fixed.**
- The artifact root lock is released **only** by `ArtifactRuntime.close()`, the last bounded step of `runShutdownSequence`. Worst case to reach the end of that step is **31s**: 5s drain + **2×8s inside `closeAll`** + 10s artifact close. Docker's default grace is **10s** → SIGKILL lands mid-sequence, and the lock is a plain `mkdir`'d directory with no staleness reclamation, so every later boot against that root fails `artifact-root-locked`.
- The `closeAll` doubling is **measured, not assumed**: it spends `cleanupAwaitMs` once on its own `drain()` and again on the bounded settle. Timed at **1207ms against a 1200ms prediction** using the real handler with a hung in-flight call and a hung dispose.
- **Worse than the finding described:** compose is not on the deploy path. `launch-http.sh` is the single `docker run` source, and its swap did **`docker rm -f`** — SIGKILL with *no grace at all*, so the shutdown sequence never ran, taking #129's drain with it.
- **Fix:** `docker stop -t "$STOP_TIMEOUT"` then `docker rm` on the swap; `--stop-timeout` on the run; `BGW_STOP_TIMEOUT` defaulting to 45s; `stop_grace_period: 45s` on the compose service. A test derives the requirement from the **real exported constants** (moved from `http-main.ts` into `artifact-graph-lifecycle.ts`, and `DEFAULT_CLEANUP_AWAIT_MS` exported from `http-server.ts`) so the config and the code cannot drift.

**Every guard was watched RED by construction**, per the repo rule:
| Guard | How it was made to report bad news |
|---|---|
| Cross-route regression | RED on the unfixed tree — "second POST's response carried the first POST's artifact bytes (status 200)" |
| Accounting half | Throwaway probe: `cross-routed: true`, `respA timed out: true`, `outcome ["transport-failed"]` |
| Disabled parity | Ungated the fix → "a disabled build refused a request it used to dispatch" |
| Budget composition | Formula forced to 1× → "understates the real worst case"; to 3× → "bounds are not additive" |
| Stop grace (4 legs) | compose grace removed / lowered to 10s; `docker rm -f` restored; default lowered to 20s — each RED |

## Decisions
- **The duplicate-id gate is gated on `artifactsEnabled`,** matching the batch gate's precedent. A build without artifacts has no response-scoped lease to protect and must accept every request it accepted before Task 2. Parity is proven by **dispatch** (both calls reach a tool handler), not by a status code, so it cannot pass vacuously.
- **Refuse the newcomer, not the incumbent.** The already-dispatched call owns its stream; rejecting it instead would break a well-behaved request in favour of a protocol-violating one.
- **Raise the stop grace rather than shrink the budgets.** Shrinking would truncate real cleanup — abandoning a browser or a half-written artifact — and the user's constraint was to preserve cleanup ordering. 45s is a ceiling, not a cost: the ordinary path finishes in milliseconds.
- **Fixed the deploy script, not just compose.** A compose-only grace would have been a fix that fixes nothing that ships.
- **Staleness reclamation for the root lock was deliberately NOT built.** It is the only thing that closes the crash/OOM case, and it is a larger change than this slice's scope.
- **Verification log re-run after comment-only edits,** so the recorded evidence describes the exact committed tree rather than a near-miss.

## What Didn't Work
- **Grepping the SDK for `_requestToStreamMapping` in `server/streamableHttp.js` found nothing** — that file is a thin `getRequestListener` wrapper in 1.29.0. The id-keyed routing lives in `server/webStandardStreamableHttp.js`. Look there for any future transport-level question.
- **A regex expecting a literal `--stop-timeout 45`** failed against the script, which passes `"$STOP_TIMEOUT"`. The guard now resolves the default from the assignment line instead.
- **The MCP SDK *client* cannot express this bug.** It mints unique ids, so the regression needs raw `fetch` POSTs against the loopback server. A gated `consumeForServer` and a gated `retrieve` dep make the race deterministic instead of timing-dependent.

## Active Tasks
- [x] Validate finding 1 (duplicate in-flight id) — reproduced, fixed, guarded, parity preserved.
- [x] Validate finding 2 (stop grace vs lock) — reproduced, fixed on both the compose and the real deploy path.
- [x] Full verification to a durable log; local commit `0617556`.
- [ ] **Artifact-contract Task G** — the in-container artifact gate. There is still no `validate-artifact*.mjs`.
- [ ] Artifact-contract Task H — final integration review.
- [ ] Decide whether to push `0617556` (needs David; it is a local-only commit by design).

## Blockers and Open Questions
- **No technical blocker.** `0617556` is local-only and clean; pushing/PRing it needs a go-ahead.
- **Master-plan Task 1 (the live EID portal spike) still needs David:** the portal URL, the interactive login/MFA step, and explicit approval for live EID access. No credentials or live portal have been touched at any point.
- **Open question:** should the root lock get staleness reclamation (adopt-on-boot with an owner/pid check) before artifacts are enabled? The 45s grace closes the *graceful* path; a crash or OOM kill still abandons the lock.

## Evidence and Artifacts
On the exact committed tree (`0617556`):
- `npm run typecheck` — exit 0.
- Focused suites (artifact ×7 + http + drive) — **409/409 passed**.
- `test/artifact-loopback-acceptance.test.mjs` — **1/1 passed**, real artifact runtime + real loopback MCP HTTP transport.
- `npm test` — **1489/1489 passed, 0 failed** (+4 over #140's 1485: 2 new in `artifact-request-id-routing`, 2 new in `artifact-http-lifecycle`).
- `bash -n` clean on both changed shell scripts; `git diff --check` clean; secrets/private-path/IP scan clean.
- Logs: `~/Obsidian/browse-gateway/verification-logs/2026-08-17-stabilization-slice-findings-1-and-2.log` (final tree), plus `-f1-duplicate-request-id-RED.log` and `-f2-stop-grace-RED.log`.

## Uncertainty and Freshness
- All verification is host-side (`node --test`). **Nothing here ran in-container**, so per the repo's own rule this is not evidence about browser-side behaviour — that is exactly what Task G exists to cover.
- CI has not seen `0617556`; it is unpushed.
- The `stop_grace_period`/`--stop-timeout` values are **not** empirically validated against a real container stop. The arithmetic and the composition are measured; the Docker-side effect is not.

## Gotchas & Watch-outs
- **`scripts/deploy/launch-http.sh` is the only production `docker run`.** `docker/compose.yaml` is not on the deploy path — changing container behaviour in compose alone changes nothing that ships. `deploy-on-host.sh` delegates the swap to `launch-http.sh` (lines 97, 132) and has no force-remove of its own.
- **The remaining `docker rm -f`s are scoped to `$SMOKE_CONTAINER`** in `preswap-smoke.sh` and are correct — a throwaway with `--restart no`, evicted before `launch-http.sh` runs, so the new graceful stop is a no-op there.
- **The artifact root lock still has no staleness reclamation.** Any new code path constructing an `ArtifactRuntime` must own releasing it, and a SIGKILL/OOM still abandons it.
- **Still open from the #140 gauntlet, NOT filed as issues** (open issues top out at `#136`): `retrieve`'s proxied re-roll loop may commit multiple artifacts per call (a download leaves `status: null`, failing the loop's only success-break) burning per-consumer quota on copies whose IDs are never surfaced — **unvalidated, no verdict exists**; the P3 lineage TOCTOU (fenced by the pre-armed per-POST tracker, so no client-visible exposure — any future fix must `claimTimeout()` and `complete()` the raw lease before throwing, or it leaks the global response permit and deadlocks all retrieval); `activate()` never sets state, so a double-activate double-arms listeners while the test named "idempotent" never calls it twice; the lease tracker reads the HTTP handler's `now` rather than `ArtifactRuntime.now()`, harmless only because both are `Date.now`.
- **`test/drive.test.mjs`'s concurrency test asserts only that one session opens** — it passed straight through the #140 provenance bug. Concurrency coverage in that controller is narrower than its test names suggest.
- **Codex CLI:** never omit `-c model_reasoning_effort="high"` (0.147.0 defaults `gpt-5.6-sol` to effort *none* — an 18-line blanket approval over 1,515 lines), and dedupe its findings block by fingerprint since it emits verbatim twice.
- **Resolve review bases from the remote,** never local `main` — see `docs/solutions/workflow-issues/an-approving-review-proves-nothing-until-base-and-effort-are-verified.md`.
- **Measurement JSON carries the egress IP** (`meta.egressIp`); `INPUT_REALISM_OUT` has no redaction. Check before pasting anywhere.

## Exact Next Action
Build `scripts/validate-artifact.mjs` and drive **artifact-contract Task G** green in-container (headful Chrome under Xvfb), verifying each RED control by construction first: retrieve→metadata→one-shot blob with `%PDF-`/size/hash match, drive→same-controller consume, second/foreign/wrong-controller denial, inline-PDF unsupported, non-PDF and oversize controls, muted-listener and forced-capture-failure turning the gate RED with non-zero exit, and no orphan artifacts after cleanup — driven through the real MCP HTTP consumer surface, not an internal method. Do not push `0617556`, deploy, enable artifact capture, or use live credentials without David's explicit approval.
