---
scope: browse-gateway-eid-artifact-task1
updated_at: 2026-08-15T11:35:43-07:00
status: done
kind: project
review_after: null
---

# Handoff: Site-neutral browser artifact capture

## Objective
Complete the reusable browser-to-artifact slice for private statement ingestion: capture one attributed browser download before teardown, publish it atomically through `ArtifactRuntime` / `ArtifactCaptureOperation`, and fail closed across lifecycle and cleanup races. MCP/HTTP retrieval, authentication, deployment, and live EID access remain out of scope.

## Current State
The site-neutral artifact runtime/browser integration is complete in the approved tree. Operation/runtime internals use JavaScript private fields; public operation identity remains directly readable but non-enumerable, and serializing either object yields `{}`. `createOperation()` and public `store.capture()` snapshot untrusted properties exactly once and normalize getter/proxy failures without exposing raw exceptions. Controller verification, a fresh real-browser/container run, targeted specification review, code-quality review, and final adversarial-security review all passed. David explicitly authorized committing and pushing the exact approved tree; this handoff is the terminal record for the completed slice.

## Canonical Sources
- `/home/node/.hermes/plans/2026-08-13-obscura-private-pdf-artifact-contract.md` — base artifact contract.
- `/home/node/.hermes/plans/2026-08-13-obscura-private-pdf-artifact-contract-amendment-1.md` through `-amendment-6.md` — normative amendments in precedence order; later amendments override.
- `/tmp/bgw-page-scoped-disposal-correction.md` — approved page-owned disposal correction matrix.
- `src/artifacts/index.ts` — operation state, immutable identity, settlement, cleanup, publication, and invalidation.
- `src/browser/patchright-core.ts` — generation routing, page ownership, disposal accounting, and teardown.
- `test/artifact-runtime.test.mjs` and `test/browser-artifact-capture.test.mjs` — strict lifecycle/security regressions.

## Completed
- Implemented caller-created owner-bound artifact operations with atomic publication, invalidation precedence, fixed 5,000 ms operation deadline, bounded hostile-accessor handling, exactly-once attributed cleanup, runtime poison, and reservation safety.
- Implemented site-neutral browser generation routing for render, navigate, click, type, selectOption, pressKey, and waitFor.
- Implemented pre-accounted, independently invoked, bounded cancel/delete disposal for orphan, late, refused, and duplicate downloads.
- Added immutable page ownership for browser-owned disposal records: orphan uses emitting page; late/duplicate/refused uses generation owner iff captured, otherwise emitting page.
- Added one-turn fixed-snapshot owner-filtered drains for active-page and transient-render teardown; graceful close drains all owners; kill remains synchronous and non-draining.
- Fixed delayed `closeActivePage()` race: it closes the captured page identity and clears active state only if that identity remains current.
- Strengthened fake browser pages to retain page-local listeners and corrected the full-close test to hold records from two real owner identities.
- Current hostile-input-hardened tree: build/typecheck passed; focused 170/170; browser suite 10/10 repeated; full suite 1,261/1,261; diff/mutation/NUL hygiene clean. Separate compiling mutations for `createOperation()` and `store.capture()` made the hostile-input regression RED; both were restored. Direct built-JavaScript probe still shows operation/runtime keys empty, JSON `{}`, readable identity, and source-compatible runtime store access.
- Fresh `browse-gateway:eid-artifact-final7` container passed teardown; deterministic measurement was VALID with 6 events, 0 unattributed events, and 0 stat/accessor/settlement/cleanup errors.
- Final hostile-input-hardened tree passed targeted specification (`deleg_6915a23a`), code quality (`deleg_471ac6f4`), and adversarial security (`deleg_a87c28c2`) in order.

## Decisions
- **Operation owns attributed staging; browser core owns only unattributed disposal.** No core-wide operation staging ledger.
- **Owner identity is immutable object identity.** Closed/detached/liveness state never erases ownership; fallback occurs only when a generation owner was never captured.
- **Teardown snapshots once after exactly one injected event-loop turn.** No polling, resnapshotting, or admission extension.
- **Identity-bearing public operation properties must be runtime immutable.** TypeScript `readonly` is insufficient at the JavaScript boundary; own properties are non-writable and non-configurable.
- **Commit and push required explicit authorization.** David provided it on 2026-08-15 for the exact approved tree.

## Active Tasks
- [x] Close this slice by committing and pushing the exact approved tree.
- [ ] Begin the separately bounded Streamable HTTP `browser_get_artifact` retrieval slice.

## Blockers and Open Questions
- **Real private portal capture remains intentionally untested.** Only site-neutral fake-driver and local real-browser/container validation is authorized.

## Failed or Ruled-Out Approaches
- **Stale Claude supervisor.** A queued prompt sat unexecuted at exhausted capacity for about 5.5 hours; the supervisor was killed.
- **Standalone `codex` fallback.** Exit 127: `codex` is not installed on this host. Do not retry without installing/configuring it explicitly.
- **Global unattributed-disposal drain on page close.** Rejected because one page could block teardown of another.
- **TypeScript-only `readonly`.** Built JavaScript allowed replacement of operation owner/ID/host properties; strict runtime descriptors are required.
- **Enumerable TypeScript-private constructor properties.** They exposed store roots and private operation identity through `Object.keys`/JSON; internal authority now uses JavaScript private fields and public identity is non-enumerable.
- **Pre-validation public property reads.** `createOperation(null)` and hostile operation/store getters previously leaked raw exceptions; both boundaries now structurally validate, snapshot once, and emit closed artifact errors.

## Evidence and Artifacts
- `/home/node/.hermes/cache/delegation/subagent-summary-0-20260814_221941_036772.txt` — page-scoped implementation report and mutation evidence.
- `/home/node/.hermes/cache/delegation/subagent-summary-0-20260814_222904_325426.txt` — specification rejection that found delayed-close identity race.
- `/home/node/.hermes/cache/delegation/live/deleg_8471fd20/task-0.log` — subsequent targeted specification approval.
- `/home/node/.hermes/cache/delegation/live/deleg_30c14fc2/task-0.log` — code-quality rejection finding runtime-writable operation identity.
- `/home/node/.hermes/cache/delegation/live/deleg_6915a23a/task-0.log` — final targeted specification approval.
- `/home/node/.hermes/cache/delegation/live/deleg_471ac6f4/task-0.log` — final code-quality pass.
- `/home/node/.hermes/cache/delegation/live/deleg_a87c28c2/task-0.log` — final adversarial-security approval.
- `browse-gateway:eid-artifact-final7` — latest fully exercised local container image including hostile-input hardening.

## Uncertainty and Freshness
- Test counts, container evidence, and all three ordered reviews describe the current exact hostile-input-hardened tree.
- This capsule describes the exact tree authorized for commit and push on `atlas/eid-pdf-artifact-task1`; verify the remote branch tip and clean status before starting the next slice.
- No live EID account, private credentials, MCP retrieval, HTTP response tracking, auth changes, deployment, or production injection were used.

## Exact Next Action
Verify the pushed branch and clean working tree, then begin a new bounded slice for authenticated `browser_get_artifact` retrieval over Streamable HTTP. Do not add stdio artifact delivery, deployment, or live EID access without separate authorization.
