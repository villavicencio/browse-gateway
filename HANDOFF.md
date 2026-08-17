---
scope: browse-gateway-eid-bill-intelligence
updated_at: 2026-08-17T15:10:00-07:00
status: local-commit-ready — the artifact gate now exits 0; no expected-failing set remains
kind: project
review_after: null
---

# Handoff: Defect 2 closed — disposal is confirmed from the bytes, not from the driver's promises

## Objective
Build Obscura into a scheduled personal bill-intelligence workflow for EID: at configured times each month, check for a new invoice, reuse an authenticated session through durable cookies with credential re-authentication as fallback, retrieve the private bill, compare it with prior months, and report useful changes, anomalies, or noteworthy details. Extract only the site-neutral primitives demanded by this working flow so the same browser-session, artifact, ingestion, and analysis capabilities can later support other utilities, banking sites, and authenticated services without turning the first implementation into a speculative platform.

## Current State
Branch `atlas/eid-bill-intelligence` is **4 commits ahead of `origin/main`, 0 behind**, working tree clean, **no open PRs**. Nothing pushed, deployed, enabled, or run against credentials or the live EID portal.

This session closed **defect 2** in one bounded slice. `scripts/validate-artifact.mjs` now exits **0 (60 PASS / 0 FAIL)**; the previous handoff's three-check expected-failing set is **empty**, and any failure is now a regression.

## Project Charter
- **Operational outcome:** scheduled detection, retrieval, analysis, month-over-month comparison, and concise reporting for new EID bills.
- **Authentication:** preserve authenticated sessions with cookies; fall back to stored credentials when the session expires, within explicit private-data controls.
- **Reuse:** extract site-neutral capabilities only after the EID path demonstrates the seam.
- **Engineering posture:** keep it simple, safe enough for private financial documents, iterative. Prefer fixing observed bugs over defending against low-probability hypotheticals.
- **Risk tolerance:** medium-high, while preserving hard boundaries around credential leakage, cross-consumer authorization, destructive actions, and production release.
- **Authority:** local commits are standing-authorized. Production release/deployment requires David's explicit approval. **Atlas owns publication of this branch.**

## Canonical Sources
- `/home/node/.hermes/plans/2026-08-13-obscura-private-pdf-artifact-contract.md` — the controlling contract. Tasks A–H shipped.
- `/home/node/.hermes/plans/2026-08-13_212203-automate-eid-statement-ingestion-with-obscura.md` — the master ingestion plan. Its Task 1 (live-portal spike) is still blocked on David.
- `docs/solutions/integration-issues/driver-disposal-calls-are-mutually-exclusive-not-concurrent.md` — both defects, both measurement tables, and why the two disposal sites use different evidence.
- `~/Obsidian/browse-gateway/verification-logs/2026-08-17-defect2-*.log` — gate GREEN, RED controls, full suite, container stop timing, and the driver measurement (plus the measurement script itself, `-measurement.mjs`).

## What We Built This Session
**`ece46f6` — `fix(defect 2): confirm disposal from the bytes, not from two promises that cannot both succeed`** (8 files, +289/−29)

### The measurement that decided the design
Before writing code, the driver was measured in-container against a real `Download`. The probe reported both answers within each run (`no-disposal` → file PRESENT, `delete-only` → file GONE), so it can report bad news:

| trial | `path()` | existed before | cancel | delete | bytes gone |
|---|---|---|---|---|---|
| no-disposal (control) | resolved | true | — | — | **false** |
| delete-only | resolved | true | — | resolved | true |
| cancel-only | resolved | true | resolved | — | **false** |
| path awaited, then cancel+delete | resolved | true | **rejected** | resolved | **true** |
| path invoked first, awaited last | **non-deterministic** — rejected in 2 of 3 runs; when it resolved, `existedBefore` was already false | | | | |
| cancel+delete, **then** path | **rejected** | — | resolved | resolved | — |

### The fix
Confirmation is now **two independent proofs, either sufficient**: the driver reported success, or the bytes are demonstrably gone.

- **`ArtifactOperation#startCleanup` uses filesystem evidence.** The staging job already read the driver's staged path on its way to `store.capture()`, so it records it (`#stagedPath`) and — once the disposal calls settle *or* the budget expires — asks whether that path still names a file. It never calls back into the driver. The path is recorded **only if it exists at that instant**, making the later absence a *positive cut* rather than the vacuous absence of a file that was never written.
- **`PatchrightBrowserCore#disposeDriverCopy` cannot reach that evidence** (rows 5 and 6 above), so it confirms from **one success across two mandatory invocations**. The pre-existing `offered < 2` guard excludes the single measured row where bytes survive — `cancel()` alone.
- Evidence only ever **adds** confirmation, so nothing existing was withdrawn: the ten tests around `test/artifact-runtime.test.mjs:2367` stayed green untouched, and `delete()` is still invoked synchronously, mandatorily, immediately after `cancel()`.

### Tests and controls
- Two RED regressions written first and **watched failing** on the unfixed tree: runtime-wide poisoning, and per-session `captureDirty`.
- Three guards each **watched RED by construction** by unwiring them one at a time: the staged-path recording, the positive-cut existence check, and `offered < 2`.
- Three core tests that encoded "one failed disposal call ⇒ dirty" were **retargeted onto cases that genuinely prove nothing** (both calls fail, cancel-only, no disposal offered) rather than having their assertions flipped.
- New dist-patch control **`revert-disposal-evidence`** restores the old predicate in the built output. It fails on **exactly** the three legs the gate header now names as this fix's regression alarm — verified, not asserted.

## Decisions
- **The two disposal halves now prove the same contract from different evidence, and that is not drift.** They know different things: the operation staged the download and holds its path; the core disposes of orphans, late events and refusals it never staged. Both docblocks state this and cite the measurement.
- **Filesystem evidence is `OR`, never authoritative-in-both-directions.** Making a still-present file force *unconfirmed* would have been safer in theory but broke deliberate host tests whose fakes resolve `delete()` without touching the file. `OR` fixes the defect with zero churn on the operation side; the residual is recorded below.
- **The positive-cut requirement was added deliberately.** Without it, a driver returning a path it never wrote would have its "disposal" confirmed by a file that never existed — the one way this evidence could be *weaker* than the promises it replaces.
- **`some(Boolean)` at the core does not resurrect the refuted relaxation.** That refutation was of an *unguarded* `some`; `offered < 2` excludes `cancel()`-alone, which is the row that refuted it.
- **The gate's assertions were never relaxed.** The three legs went green because the defect is fixed, and `revert-disposal-evidence` proves that is why.

## What Didn't Work
- **Filesystem evidence at the core's site — measured impossible, not merely awkward.** `path()` rejects once disposal has been invoked; invoked-before-and-awaited-after is non-deterministic (rejected 2 of 3 runs, and when it resolved the file was already gone so "existed before" was unobservable); awaiting it *before* invoking disposal works but defers the mandatory `delete()` behind an unbounded untrusted call — the exact trade the contract forbids and the previous session rejected.
- **Running the controls matrix from a copied script.** `validate-artifact-controls.sh` derives `REPO_ROOT` from `BASH_SOURCE`, so a snapshot in another directory fails the build immediately. Run the repo copy.
- **Editing a bash script while it is executing.** Bash reads scripts incrementally; the first matrix run had to be killed and restarted after the new control was appended mid-run.

## Active Tasks
- [x] Close defect 2 — the disposal confirmation predicate, at both sites, together.
- [x] Baseline exit 0 plus every deliberate control reporting, including `serve-small-oversize`.
- [x] Update the four coupled contract docblocks, the gate header, and the solutions doc.
- [ ] Decide whether to push `8f0e3b7` and `ece46f6` (Atlas owns publication).
- [ ] Master-plan Task 1 — the live EID portal spike. **Still blocked on David.**

## Blockers and Open Questions
- **Master-plan Task 1 needs David:** the portal URL, the interactive login/MFA step, and explicit approval for live EID access. No credentials or live portal have been touched at any point.
- **Enabling capture is now unblocked *technically*, but is still a deliberate decision.** `BGW_ARTIFACT_CAPTURE_ENABLED` appears in **no** shipped config, deploy script or CI (verified), so both commits are inert until someone opts in.
- **The diagnosability question from the last handoff is still open and now matters more.** `beginCapture()` still swallows a `createOperation` throw. The catastrophic silent-outage cause is gone, but a swallowed throw is still invisible; consider logging it.
- **Root lock staleness reclamation is still unbuilt.** Re-measured this session: graceful `docker stop -t 45` takes **0.135s**, exits 0, drains fully and releases the lock, and the next boot reacquires it. A SIGKILL or OOM still abandons the lock and bricks the root until an operator removes the directory by hand.

## Evidence and Artifacts
On the exact committed tree (`ece46f6`):
- `npm run typecheck` — exit 0. `npm run build` — exit 0.
- Focused artifact suites (8 files) — **395/395 passed**.
- `npm test` — **1495/1495 passed, 0 failed** (+3 over 1492: two RED regressions plus the never-existed-path case).
- **Artifact gate, in-container: 60 PASS / 0 FAIL, exit 0** (was 55 PASS / 3 FAIL).
- **RED control matrix: `BASELINE exit=0 pass=60 fail=0`**, and all **11** controls non-zero on their own legs — including `serve-small-oversize`, which was *unprovable* while the defect stood, and the new `revert-disposal-evidence` (fail=3, exactly the named alarm legs).
- **Container stop check: 0.135s, exit 0, full drain, lock released and reacquired by the next boot.**
- `git diff --check` clean; secrets/private-path/IP scan clean.

## Gotchas & Watch-outs
- **A residual this fix does NOT close:** a driver that reports a successful `delete()` while leaving the bytes on disk is still believed at both sites. The operation site would catch it only if the staged path happened to be the surviving file. Recorded in the solutions doc under "Residual risk".
- **The disposal halves must still move together.** They now differ by mechanism *on purpose*; if you change one, read both docblocks first — each explains why the other is shaped differently.
- **`revert-disposal-evidence`'s anchor is the literal built line** `settle(reported || this.#stagedBytesGone())`. Renaming `#stagedBytesGone` or restructuring `confirm` fails the control's **build**, loudly, by design — re-derive the anchor rather than dropping the control.
- **Run the gate with `--add-host bill-fixture.test:127.0.0.1`.** A container's `/etc/hosts` is generated at run time, so an image-baked entry is discarded.
- **`createOperation` refuses an IP-literal `sourceHost`**, and `beginCapture()` swallows the throw — it presents as "capture silently does nothing". Reach loopback fixtures by hostname.
- **The controls matrix takes ~30 minutes** (12 gate runs against a real browser) and exits **non-zero by design** — its last statement is a control that correctly went RED. Read the table, not the exit code.
- **`scripts/deploy/launch-http.sh` is still the only production `docker run`.** `docker/compose.yaml` is not on the deploy path.
- **Still open from the #140 gauntlet, NOT filed as issues** (open issues top out at `#136`): `retrieve`'s proxied re-roll loop may commit multiple artifacts per call — unvalidated, no verdict exists; the P3 lineage TOCTOU (any fix must `claimTimeout()` and `complete()` the raw lease before throwing, or it leaks the global response permit and deadlocks all retrieval); `activate()` never sets state, so a double-activate double-arms listeners; the lease tracker reads the HTTP handler's `now` rather than `ArtifactRuntime.now()`.
- **The orphan path dirties the core unconditionally** (`#routeDownload`, ~line 1617), so the two synchronous-throw disposal tests at `test/browser-artifact-capture.test.mjs:1843` pass on orphan-ness alone — their dirty assertion does not exercise the confirmation predicate. Pre-existing; not touched in this slice.
- **`test/drive.test.mjs`'s concurrency test asserts only that one session opens** — narrower than its name suggests.
- **Codex CLI:** never omit `-c model_reasoning_effort="high"`, and dedupe its findings block by fingerprint.
- **Resolve review bases from the remote,** never local `main`.
- **Measurement JSON carries the egress IP** (`meta.egressIp`); `INPUT_REALISM_OUT` has no redaction.

## Exact Next Action
Two candidates, both David's call rather than obvious defaults:

1. **Publication.** Decide whether to push `8f0e3b7` and `ece46f6`. Atlas owns this; nothing is pushed.
2. **Master-plan Task 1 — the live EID portal spike**, which needs the portal URL, the login/MFA step and explicit approval for live access.

If neither is ready, the highest-value unblocked work is the **diagnosability decision**: make `beginCapture()` log when it swallows a `createOperation` throw, so a future capture outage is visible rather than silent. Do not push, deploy, enable `BGW_ARTIFACT_CAPTURE_ENABLED`, or use live credentials without David's explicit approval.
