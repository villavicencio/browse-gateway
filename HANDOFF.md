---
scope: browse-gateway-eid-artifact-task2
updated_at: 2026-08-17T01:09:26-07:00
status: done
kind: project
review_after: null
---

# Handoff: Authorized MCP artifact retrieval

## Objective
Build Obscura into a scheduled personal bill-intelligence workflow for EID: at configured times each month, check for a new invoice, reuse an authenticated session through durable cookies with credential re-authentication as fallback, retrieve the private bill, compare it with prior months, and report useful changes, anomalies, or noteworthy details. Extract only the site-neutral primitives demanded by this working flow so the same browser-session, artifact, ingestion, and analysis capabilities can later support other utilities, banking sites, and authenticated services without turning the first implementation into a speculative platform.

## Current State
Task 2 is implemented and locally checkpointed on `atlas/eid-pdf-artifact-task2` at commit `9217f8b96f0e2af0910581637f79a5477c63d805`. Typecheck, the complete 1,482-test suite, and a real loopback capture-to-`browser_get_artifact` acceptance test pass. One independent final specification/security review found a disabled-mode HTTP parity defect; the two HTTP gates were scoped behind a snapshotted `artifactsEnabled` flag, regression tests were added, and the full suite passed afterward. Nothing was pushed, deployed, or exercised against live EID.

## Project Charter
- **Operational outcome:** scheduled detection, retrieval, analysis, month-over-month comparison, and concise reporting for new EID bills.
- **Authentication:** preserve authenticated sessions with cookies; fall back to stored credentials when the session expires, within explicit private-data controls.
- **Reuse:** extract site-neutral capabilities only after the EID path demonstrates the seam; future utilities/banks should reuse proven primitives rather than drive speculative abstractions now.
- **Engineering posture:** keep it simple, safe enough for private financial documents, and iterative. Prefer fixing observed bugs over defending against low-probability hypothetical futures.
- **Risk tolerance:** medium-high for this project, while preserving hard boundaries around credential leakage, cross-consumer authorization, destructive actions, and production release.
- **Model/cost posture:** Claude Code carries most implementation work; Atlas uses OpenAI for architecture, acceptance, adjudication, and final judgment while conserving OpenAI usage.
- **Authority:** local commits are standing-authorized. Production release/deployment requires David’s explicit approval.

## Canonical Sources
- `/home/node/Projects/browse-gateway-eid-artifact/.hermes/plans/2026-08-16-artifact-retrieval-mcp-transport-task2.md` — reconciled Task 2 implementation plan.
- `/home/node/.hermes/plans/2026-08-13-obscura-private-pdf-artifact-contract.md` and Amendments 3, 4, 6, and 7 — controlling artifact and response-lease contracts.
- `src/mcp/http-response-lease.ts` — Node response tracking and exactly-once lease completion.
- `src/mcp/server.ts` — `browser_get_artifact`, trusted identity snapshots, denial collapsing, and safe metadata projection.
- `src/mcp/artifact-graph-lifecycle.ts` and `src/mcp/http-main.ts` — controller disposal and process shutdown ordering.
- `test/artifact-loopback-acceptance.test.mjs` — real loopback capture/retrieval/one-shot verification.

## Completed
- Added runtime acquisition that owns permit acquisition, file verification, hashing, base64 MCP-resource construction, and one-shot consumption.
- Added per-POST response tracking correlated through SDK `extra.requestId`, with `sent`, `transport-failed`, and fenced `timed-out` completion.
- Added queued-reset cancellation, artifact-containing batch rejection, tracker-aware `inFlight` drain, and exactly-once cleanup/reference release.
- Added conditional `browser_get_artifact` registration with server-derived consumer/controller authorization and indistinguishable denial responses.
- Wired fresh artifact capture operations into retrieve attempts and drive controllers without reusing operation identity across attempts.
- Added fail-closed artifact-enabled stdio refusal before artifact filesystem/runtime construction.
- Added idempotent controller lifecycle disposal and ordered process shutdown: stop intake, drain HTTP responses, close consumer graphs, close artifact runtime, then gateway shutdown.
- Added disabled-mode parity gating after final review found unconditional HTTP artifact interception.
- Final verification: `npm run typecheck` passed; `npm test` passed 1,482/1,482; loopback acceptance passed 1/1.
- Created local checkpoint commit `9217f8b` (`feat: add authorized MCP artifact retrieval`).

## Decisions
- **Node `ServerResponse` finish is the local success boundary.** It does not claim remote receipt.
- **Timeout authority transfers from store to HTTP tracker.** The tracker fences the actual response before completing `timed-out` and releasing the permit.
- **Artifact IDs are not bearer credentials.** Consumer and controller identities are immutable server-derived snapshots.
- **Disabled deployments take the legacy HTTP path.** Batch rejection and tracker/context installation run only when the process artifact runtime exists.
- **Pre-production engineering is delegated; production remains gated.** Local commits are standing-authorized. Branch/PR work follows repository policy, while any production release or deploy requires David's explicit approval.

## Active Tasks
- [x] Implement, review, accept, and locally checkpoint Task 2.
- [ ] Publish the reviewed branch and open a pull request as the next pre-production step.

## Blockers and Open Questions
- **No technical blocker remains.** Production release is intentionally approval-gated; pre-production engineering may continue under the project charter.

## Evidence and Artifacts
- `/tmp/task2-full-final.log` — final complete-suite output: 1,482 passed, 0 failed.
- `/home/node/.claude/plans/final-independent-specification-security-magical-glacier.md` — final independent review and its single corrected finding.
- `9217f8b96f0e2af0910581637f79a5477c63d805` — verified local checkpoint commit.

## Uncertainty and Freshness
- Verification applies to exact implementation checkpoint `9217f8b`; this handoff/project-charter update is documentation-only and should remain a separate local commit.
- The acceptance test uses a real temporary artifact runtime and real loopback MCP HTTP transport, but no live portal, credentials, production deployment, or live EID access.

## Exact Next Action
Commit this handoff/project-charter update separately, then prepare the reviewed branch and PR as the next pre-production step. Do not release, deploy, enable production configuration, or use live credentials without the production approval gate.
