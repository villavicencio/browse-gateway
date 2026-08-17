---
scope: browse-gateway-eid-bill-intelligence
updated_at: 2026-08-17T12:05:00-07:00
status: local-commit-ready — gate exits NON-ZERO by design against one open defect
kind: project
review_after: null
---

# Handoff: Artifact-contract Tasks G and H — the gate is built, and it found two defects

## Objective
Build Obscura into a scheduled personal bill-intelligence workflow for EID: at configured times each month, check for a new invoice, reuse an authenticated session through durable cookies with credential re-authentication as fallback, retrieve the private bill, compare it with prior months, and report useful changes, anomalies, or noteworthy details. Extract only the site-neutral primitives demanded by this working flow so the same browser-session, artifact, ingestion, and analysis capabilities can later support other utilities, banking sites, and authenticated services without turning the first implementation into a speculative platform.

## Current State
Branch `atlas/eid-bill-intelligence` is **3 commits ahead of `origin/main`, 0 behind**, working tree clean, **no open PRs**. Nothing pushed, deployed, enabled, or run against credentials or the live EID portal.

This session built artifact-contract **Task G** (the in-container gate) and ran **Task H** (final integration review). The gate is the first thing that has ever run the artifact stack against a real browser, and it found **two defects on its first two runs**. One is fixed; one is evidenced and deliberately left open with a named fix direction.

**`scripts/validate-artifact.mjs` exits NON-ZERO on exactly three checks against this tree, and that is the gate working.** The expected-failing set is named in the script header. Any other failure is a new regression.

## Project Charter
- **Operational outcome:** scheduled detection, retrieval, analysis, month-over-month comparison, and concise reporting for new EID bills.
- **Authentication:** preserve authenticated sessions with cookies; fall back to stored credentials when the session expires, within explicit private-data controls.
- **Reuse:** extract site-neutral capabilities only after the EID path demonstrates the seam.
- **Engineering posture:** keep it simple, safe enough for private financial documents, iterative. Prefer fixing observed bugs over defending against low-probability hypotheticals.
- **Risk tolerance:** medium-high, while preserving hard boundaries around credential leakage, cross-consumer authorization, destructive actions, and production release.
- **Authority:** local commits are standing-authorized. Production release/deployment requires David's explicit approval. **Atlas owns publication of this branch.**

## Canonical Sources
- `/home/node/.hermes/plans/2026-08-13-obscura-private-pdf-artifact-contract.md` — the controlling contract. **Task G is lines 460–489; Task H is 491–508.** Tasks A–F shipped (#139, #140).
- `/home/node/.hermes/plans/2026-08-13_212203-automate-eid-statement-ingestion-with-obscura.md` — the master ingestion plan. Its Task 1 (live-portal spike) is still blocked on David.
- `scripts/validate-artifact.mjs` — the Task G gate (623 lines). Header names the expected-failing set.
- `scripts/validate-artifact-controls.sh` — the 11-control RED matrix, reproducible from the repo.
- `docs/solutions/integration-issues/driver-disposal-calls-are-mutually-exclusive-not-concurrent.md` — the full write-up of both defects, with the measurement table.
- `~/Obsidian/browse-gateway/verification-logs/2026-08-17-taskg-*.log` — GREEN/RED evidence, container stop timing, final-tree verification, live MCP gate.

## What We Built This Session
**`8f0e3b7` — `feat(task G): the in-container artifact gate, and the capture enablement it proved was never wired`** (7 files, +960/−2)

### The gate — `scripts/validate-artifact.mjs`
Every layer real, nothing weakened: a real `ArtifactRuntime` on a real locked root, real headful Chrome under Xvfb performing **real downloads** through the real driver `download` event and `registerDownload`/`seal` lifecycle, the real `retrieve` verb and `GatewayDriveController`, and a real `StreamableHTTPClientTransport` MCP session for **every** artifact assertion — never a direct `acquireResponseLease` call.

Three design choices that matter:
- **It boots through the PRODUCTION path** (`loadArtifactConfig` → `buildGatewayRuntime` → `buildArtifactRuntime`, in http-main.ts's order) rather than hand-constructing a Gateway. A hand-rolled stack would have proven the harness can capture while the shipped entrypoint could not — which is exactly defect 1.
- **It reaches its loopback fixture by HOSTNAME** (`--add-host bill-fixture.test:127.0.0.1`), because `createOperation` refuses an IP-literal `sourceHost` (`isIP(...) !== 0` → `artifact-config-invalid`, swallowed by `beginCapture()`, so it presents as "capture silently does nothing"). That also lets the gate run against the **unmodified shipped egress filter** — no `policyEgress` override, no injected core factory.
- **The fixture corpus is generated in-process**, so no live site, no credentials, no external network.

Covers every Task G leg: retrieve→metadata→one-shot blob with `%PDF-`/size/hash match, drive→same-controller consume, foreign/wrong-lineage/second-fetch/unknown-id/traversal-id denial, inline-PDF unsupported, non-PDF + sub-magic + oversize refusals, permit-leak check, and orphan cleanup.

### Defect 1 — FIXED. Artifact capture was never enabled on any browser core.
`BrowserCoreOptions.captureEnabled` existed and `PatchrightBrowserCore` honoured it, but **nothing in `src/gateway/`, `src/verbs/` or `src/mcp/` ever set it**. This did not merely fail to capture — `#requireCaptureReady` refuses an operation handed to a capture-disabled session, so the moment `BGW_ARTIFACT_CAPTURE_ENABLED=1` was set, **every `retrieve` and every `browser_navigate` failed**:

```
browse-gateway error: artifact capture: an operation was supplied to a session with capture disabled
```

Fixed with `BuildRuntimeOptions.captureEnabled`, derived by `http-main.ts` from the same `loadArtifactConfig(env).enabled` that decides whether the store is built, applied to `config.core` before `Gateway.create` pools any session. An **option** rather than an env read because the listener installs at core construction; an option rather than a fact of the builder because `cli/vault-host.ts` shares that builder, owns no runtime, and must keep its pre-artifact behaviour. Three host-side tests in `test/artifact-runtime-builder.test.mjs` guard it, each watched RED by unwiring the fix.

### Defect 2 — OPEN, evidenced, NOT fixed. One refused download poisons the runtime permanently.
After a single non-PDF, sub-magic-length or oversize download, **every later `createOperation` throws `artifact-cleanup-failed` for the life of the process** — and both verbs' `beginCapture()` swallow that throw, so capture just silently stops. For EID that means one HTML error page or login redirect served as an attachment kills bill capture until the container restarts.

Root cause, measured in-container against a real Patchright `Download`: `#startCleanup` requires **both** `cancel()` and `delete()` to confirm, but the two are **mutually exclusive**.

| invocation | cancel | delete | bytes gone |
|---|---|---|---|
| concurrent (what ships) | resolved | **rejected** `download.delete: canceled` | true |
| concurrent (other race outcome) | **rejected** `Target page… closed` | resolved | true |
| sequential `cancel()` → `delete()` | resolved | resolved | **true** |
| `delete()` alone | — | resolved | true |
| `cancel()` alone | resolved | — | **false** |

The race makes *which* download poisons the runtime non-deterministic — it moved between `/notpdf.bin` and `/tiny.bin` across runs, which is why it never looked reproducible.

### The RED control matrix — `scripts/validate-artifact-controls.sh`
11 controls; **10 turn the gate red on their own target leg with a non-zero exit.** The contract's two named controls (muted listener, forced capture failure) are **dist patches against the real shipping code**, not harness branches — each asserts its anchor text before and after editing, so a refactor that moves the code fails the **build** rather than silently producing an unsabotaged image that "passes".

## Decisions
- **The sequencing fix for defect 2 was implemented, turned the gate fully GREEN, and was REVERTED.** It broke 10 deliberate tests in `test/artifact-runtime.test.mjs`; the clearest (line 2367) asserts **synchronously, with no await**, immediately after `invalidate()`, that a hung `cancel()` still gets `delete()` invoked in the same turn. `invalidate()` runs during teardown, so deferring the delete trades a silent capture outage for **a private PDF left on disk**. That is the wrong trade to make unilaterally and is outside "fix only the smallest reproducible blocker".
- **Relaxing to `some(Boolean)` was refuted by measurement, not by taste:** `cancel()` alone leaves the bytes on disk, so it would confirm a disposal that deleted nothing.
- **The named fix direction: confirm disposal from filesystem evidence** (the staged path no longer exists) rather than from two mutually-exclusive promises. That keeps `delete()` synchronous and mandatory and makes the confirmation a fact about the bytes. It changes Amendment 7's confirmation predicate — its own reviewed slice.
- **The gate's assertions were NOT relaxed to make it green.** A gate that lowers its bar to match a defect is worth nothing. It exits non-zero and the header names the three expected failures.
- **RED exit codes are not inverted.** An inverted code would turn "this run failed for an unrelated reason" into "the control worked".
- **`captureEnabled` is opt-in per caller, never inferred from the env inside the shared builder** — that is what keeps `vault-host` on its pre-artifact path.

## What Didn't Work
- **A fixture served at `127.0.0.1` can never capture.** `createOperation` rejects IP-literal `sourceHost`. The throw is swallowed, so it looks like "capture does nothing" rather than an error. Cost ~30 minutes of wrong-track debugging; use a hostname.
- **`runtime.accounting?.()` is a vacuous guard** — `ArtifactRuntime` does not re-export the store's `accounting()` seam, so the leg silently skipped. Replaced with a consumer-observable property.
- **Two of the gate's own legs were vacuous and were rewritten.** The foreign-consumer denial ran against a *drive-scoped* artifact, so the lineage check satisfied it and consumer identity was never exercised — **the `foreign-owner` RED control came back GREEN and exposed it**. And the orphan scan ran after every artifact had been consumed, so it read an empty directory either way — caught by the independent review. Fixes: test consumer identity against a **consumer-scoped** artifact and lineage against a **drive-scoped** one; take one artifact that is deliberately never consumed, **before** the refusal legs.
- **`docker rm -f` on a bind-mounted artifact root fails `artifact-root-invalid`** unless the container creates the root itself — it must be mode 0700 owned by the container uid. Mount the parent and point `BGW_ARTIFACT_ROOT` at a subdirectory.

## Active Tasks
- [x] Task G — the in-container gate, all legs, through the real MCP HTTP consumer surface.
- [x] Every RED control verified by construction (10/11 report; 1 masked, recorded).
- [x] Container stop timing measured empirically.
- [x] Task H — build, focused suites, full suite, hygiene, in-container GREEN/RED, live MCP, independent spec/security review.
- [ ] **Close defect 2** — the disposal confirmation predicate. Blocks enabling artifact capture.
- [ ] Fix the SAME defect in `patchright-core.ts#disposeDriverCopy` (see Gotchas) — both must move together.
- [ ] Decide whether to push `8f0e3b7` (Atlas owns publication).

## Blockers and Open Questions
- **Defect 2 blocks `BGW_ARTIFACT_CAPTURE_ENABLED=1`.** Do not enable capture in any deployment until the confirmation predicate is fixed. The flag currently appears in **no** shipped config, deploy script or CI (verified), so the commit is inert until someone opts in.
- **A diagnosability regression worth a decision:** before the fix, enabling capture failed LOUDLY on every verb. After it, capture works until the first refused download and then fails SILENTLY. If defect 2 will not be fixed soon, consider logging when `beginCapture()` swallows a `createOperation` throw.
- **Root lock staleness reclamation is still unbuilt** — now measured, not theorised (see below).
- **Master-plan Task 1 (the live EID portal spike) still needs David:** the portal URL, the interactive login/MFA step, and explicit approval for live EID access. No credentials or live portal have been touched at any point.

## Evidence and Artifacts
On the exact committed tree (`8f0e3b7`):
- `npm run typecheck` — exit 0. `npm run build` — exit 0.
- Focused artifact suites (8 files) — **392/392 passed**.
- `npm test` — **1492/1492 passed, 0 failed** (+3 over the previous 1489: the new `captureEnabled` wiring tests).
- `git diff --check` clean; secrets/private-path/IP scan clean.
- **Live MCP end-to-end gate PASS** (`validate-mcp.mjs`, in-container): a real Cloudflare target round-tripped to markdown, off-allowlist refused, `file://` refused.
- **Artifact gate: 55 PASS / 3 FAIL**, the three being exactly the known-open-defect set.
- Logs in `~/Obsidian/browse-gateway/verification-logs/`: `2026-08-17-taskg-artifact-gate-GREEN.log`, `-RED-controls.log` (+ `-detail`), `-container-stop-timing.log`, `-final-tree-verification.log`, `-validate-mcp.log`, `-full-suite.log`.

### Container stop timing — measured for the first time
| scenario | wall-clock | exit | shutdown ran | next boot |
|---|---|---|---|---|
| `docker stop -t 45` (what `launch-http.sh` now does) | **0.176s** | 0 | yes, full drain | **lock acquired** |
| `SIGKILL` (old `docker rm -f`; also an OOM kill) | — | 137 | **zero lines** | **`fatal: artifact-root-locked`** |

The 45s grace is a **ceiling, not a cost**. This closes the previous handoff's stated freshness gap and confirms the open risk: the graceful path is covered, a crash or OOM still bricks the artifact root until an operator removes the lock directory by hand.

## Gotchas & Watch-outs
- **THE SAME DISPOSAL DEFECT EXISTS TWICE.** `patchright-core.ts#disposeDriverCopy` (~line 1757) has the identical concurrent `cancel`+`delete` / `every(Boolean)` shape. Its consequence is different and worse per-session: it sets `#captureDirty`, and `#assertCaptureUsable` then throws `"core is dirty; session must be replaced"` on **every** later capture-capable verb on that session — including calls that supply no operation. **Verified: nothing outside `patchright-core.ts` reads `captureDirty` or retires a dirty core**, so a pinned drive session stays bricked until the 5-minute idle reaper. Its own docblock says the two halves must not drift — fix both together.
- **`scripts/deploy/launch-http.sh` is still the only production `docker run`.** `docker/compose.yaml` is not on the deploy path.
- **The artifact root lock still has no staleness reclamation** — now with measured proof that a SIGKILL leaves the next boot dead on `artifact-root-locked`.
- **Run the gate with `--add-host bill-fixture.test:127.0.0.1`.** A container's `/etc/hosts` is generated at run time, so an image-baked entry is discarded. Without it the gate cannot resolve its fixture.
- **The gate does NOT cover DNS-rebind protection** — it builds the handler without `allowedHosts`, a configuration `http-main.ts` refuses to boot with. `scripts/validate-http.mjs` owns that surface. Documented in the gate header so the "wired exactly as http-main" claim is not over-read.
- **`serve-small-oversize` is currently an unprovable control** — its target leg already fails at baseline because of defect 2. Re-verify it as part of that fix.
- **Still open from the #140 gauntlet, NOT filed as issues** (open issues top out at `#136`): `retrieve`'s proxied re-roll loop may commit multiple artifacts per call — **unvalidated, no verdict exists**; the P3 lineage TOCTOU (any future fix must `claimTimeout()` and `complete()` the raw lease before throwing, or it leaks the global response permit and deadlocks all retrieval); `activate()` never sets state, so a double-activate double-arms listeners; the lease tracker reads the HTTP handler's `now` rather than `ArtifactRuntime.now()`.
- **`test/drive.test.mjs`'s concurrency test asserts only that one session opens** — narrower than its name suggests.
- **Codex CLI:** never omit `-c model_reasoning_effort="high"`, and dedupe its findings block by fingerprint.
- **Resolve review bases from the remote,** never local `main` — see `docs/solutions/workflow-issues/an-approving-review-proves-nothing-until-base-and-effort-are-verified.md`.
- **Measurement JSON carries the egress IP** (`meta.egressIp`); `INPUT_REALISM_OUT` has no redaction.

## Exact Next Action
Close **defect 2** in its own slice: replace the disposal confirmation predicate in `ArtifactOperation#startCleanup` **and** `PatchrightBrowserCore#disposeDriverCopy` so that confirmation is proven from **filesystem evidence** (the staged path no longer exists) rather than from `cancel()` and `delete()` both resolving — keeping `delete()` synchronously invoked and mandatory, so the 10 tests at `test/artifact-runtime.test.mjs:2367` and around it stay green. Then re-run `bash scripts/validate-artifact-controls.sh` and require **BASELINE exit 0** plus a reporting `serve-small-oversize` control. Update the expected-failing set in the gate header and the four docblocks that assert "both invoked before either is awaited" (`types.ts:223`, `index.ts:254`, `index.ts:639`, `patchright-core.ts:1748`) together. Do not push `8f0e3b7`, deploy, enable `BGW_ARTIFACT_CAPTURE_ENABLED`, or use live credentials without David's explicit approval.
