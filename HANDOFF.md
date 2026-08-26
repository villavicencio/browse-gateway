---
created_at: "2026-08-26T11:14:33-07:00"
branch: "main"
head: "6a03938"
---
# HANDOFF — 2026-08-26, midday

Picked up the previous evening's handoff and worked its item 1: three operator decisions that had held the release-versioning plan at `requirements-only` through two review rounds. Answering them shrank the plan; then running its own first unit — a measurement — **disproved the channel the design was built on**, which shrank it again and deleted a unit outright. What survived was built, reviewed, merged, and verified in the published image. The session's most valuable output is the measurement, not the code.

> Fleet identities are deliberately absent (public repo). Consumer names, host names, and the prod env live in the private vault memory notes.

## What We Built

- **PR #142 → `7fc0230` — U1, the contract version.** Four hardcoded `"0.1.0"` literals replaced by one resolver. The thing that matters and the diff won't tell you: the HTTP launcher now resolves at **boot**, beside the existing DNS-rebind and health-token guards — the previous shape resolved inside the per-connection `buildServer` callback, where a throw is a per-session 500 that no deploy check can see. A structural regression guard locks the placement, and `tsc` catches it independently because the boot line closes over the boot-scoped value.
- **Verified in the published artifact, not just in CI.** `ghcr.io/<owner>/browse-gateway:7fc0230` carries `ddca7448f998` at `/app/.deploy-id`, matching an operator-side recompute done independently before CI ran. That round-trip is the whole premise of the deploy-id design and it previously had no evidence.
- **PR #143 → `ea4ca75` — `.coderabbit.yaml`.** `auto_incremental_review: false`. **Behaviour change for the next session: a push no longer re-reviews.** Round 2+ must be requested with `@coderabbitai review`, and a suppressed round shows as a *passing* check reading `Review skipped: incremental reviews are disabled`.
- **`docs/solutions/architecture-patterns/mcp-side-channels-do-not-reach-a-consumer-agent.md`** (`c393690`) — the U8 measurement. Read this before designing anything that carries data to a consumer.
- **`docs/solutions/workflow-issues/recovering-the-commit-behind-a-deploy-id.md`** (`6a03938`) — the operator-side procedure, with the short-sha trap and both wrong/right values measured for a real commit.
- **`CLAUDE.md`** gained two rules (`f8a0700` and in #142): which deploy gate proves what, and the macOS test baseline. Both cost real time this session before being written down.
- **`docs/plans/2026-08-25-1733-feat-release-versioning-plan.local.md`** (gitignored) reworked twice — once for decisions (a)(b)(c), once for (d).

## Decisions Made

- **(a) Deployment identity is an opaque deploy id, not a git ref.** Keeps VIL-112's need, drops the mechanism three reviewers rejected.
- **(b) No public release note.** Deleted a requirement, two KTDs, and with them a verified allowlist leak. Release output is a git tag, a semver image tag, and a private note.
- **(c) The version promises contract identity, not retryability.** The retry signal moved to VIL-127.
- **(d) R6 dropped and U2 deleted** — forced by the U8 measurement below, not a preference. Identity is connect-time only, with the deploy id riding semver build metadata (`1.0.0+<12 hex>`).
- **The deploy id is keyed on the commit sha, not the manifest digest.** The plan specified the digest; that is circular, since the digest hashes the image the stamp lives in. Keying on the commit also removes the registry lookup and the `read:packages` dependency entirely.
- **CI never falls back to an empty HMAC key.** No secret means no stamp. An HMAC under a known key is forgeable while still looking like an identity.
- **Merged #143 with its `test` check unrun**, documented on the PR. The file enters no build path: `tsc` includes only `src`, tests glob `test/*.test.mjs`, and the Dockerfile COPYs specific paths.
- **Linear ids stay out of PR bodies here.** Naming one can auto-close it on merge, and this work finishes no ticket on its own.
- **Ruled out — do not relitigate:** resurrecting a per-result `_meta` marker, and putting identity into `content` text (that would append gateway chrome to page markdown, which `src/mcp/server.ts:313` exists to prevent).

## What Didn't Work

- **`_meta` does not reach a consumer agent. Neither does `structuredContent`.** Two live probes through prod. The second landed on `src/mcp/server.ts:267-273`, the one return carrying both channels on a single payload — only the `content` text arrived. The first probe's branch (`:296-307`) attaches `_meta` at `:301`, which rules out "that path doesn't carry it." Only `content` text reaches an agent. **This killed a design that had survived two document-review rounds.**
- **The local amd64 image build cannot be done on this host.** The Chrome/apt layer fails with Debian GPG signature errors under emulation — twice, with Rosetta enabled, disk and clock fine, and the builder advertising no amd64. Worked around by building a minimal image reproducing the `/app` layout with no apt, which verified the path resolution and the stamp. CI builds it fine natively.
- **A claim made mid-session and retracted:** that opening a PR would build the image. `build-image` is gated on push to main, so PRs never build it — the workflow header says so. The stamp step's logic was therefore executed locally, in both branches, rather than trusting CI to catch a bug in it.
- **A background build was reported as succeeding when it had failed** — the exit code came from a trailing `tail`, not the build. Check the build's own exit status, not the pipeline's.

## What's Next

1. **U4 — the guard. This is the gap that matters.** The boot line emits `version=` and **nothing checks it**, so a wrong or missing version can still reach prod. Two halves: an opacity guard asserting `serverInfo.version` matches `^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(\+[0-9a-f]{12})?$` with no digest/host/container/commit-shaped substring, RED-verified at the source; and extending `scripts/deploy/preswap-smoke.sh`'s existing boot-line grep (`:78`) to require a well-formed `version=`. The smoke is the only gate that runs the real launcher. **Do this before deploying U1.**
2. **File the pool-floor risk.** Six consumers × `PER_CONSUMER_MAX=1` + 1 = 7 = `MAX_SESSIONS`, `perConsumerMax` already at its minimum, so the 2→1 escape hatch cannot be used again. A seventh consumer crash-loops the gateway at boot and `keys new --apply` is blocked. **It is the only live production risk and it is tracked nowhere but a handoff and a memory note** — it has now survived several sessions in that state.
3. **Deploy U1**, after U4, so the signal arrives with its gate. Prod is on `sha256:b2e1966f…`; main is ahead.
4. **VIL-127** (structured `failureClass`) — blocks the plan's M2. Note the U8 finding sharpens it: `failureClass` is already parseable JSON inside the error text, so the honest framing is "JSON in a string, no schema, no guard", not "prose".
5. **Two small findings from the probes**, neither filed: `homeFallback`'s signal may be inert for consumers (it rides `structuredContent` on the unmeasured *success* path — confirm before filing), and a 404 was classed a hard block, escalated to the residential proxy, and burned 90s plus metered bandwidth on a page that does not exist.

## Gotchas & Watch-outs

- **⚠️ GitHub Actions looked degraded from ~15:22Z.** A PR run sat queued over an hour and could be neither cancelled nor rerun, and **no run was created at all** for `ea4ca75` or `6a03938`. The workflow is `active` and valid — `7fc0230` carries the same edited `ci.yml` and built fine. Nothing was lost (both commits are docs/config that never enter the image, so `:latest` correctly still points at `7fc0230`'s build) but **the next code change may not get built either. Check that a run exists before trusting a merge.**
- **⚠️ `npm test` cannot be green on macOS.** Baseline on main: ~223 failures, ~211 of them `artifact-filesystem-unsupported`, confined to the artifact test files. The count also **varies run to run**, so compare against a fresh baseline on main rather than reading the absolute number. Recorded in `CLAUDE.md`.
- **⚠️ The deploy id is keyed on the FULL commit sha; images are tagged with the SHORT one.** Feeding the short sha to the HMAC returns a well-formed 12 hex characters that match nothing, with no error. Always `git rev-parse` first. See the solutions doc.
- **`BGW_DEPLOY_ID_KEY` is write-only in GitHub.** The macOS Keychain copy (`bgw-deploy-id-key`) is the only readable one — lose it and no past deploy id can ever be interpreted. **Its rotation posture is still undecided**; rotating changes every future id and silently breaks recomputation of past ones.
- **A push no longer triggers a CodeRabbit re-review here** (new as of `ea4ca75`). Request it explicitly. And read the check *description*, never its state — `Review skipped` and `Review rate limited` both sit on passing checks and mean no review ran.
- **`validate-http.mjs` gates the resolver, not the launcher.** It builds its own server. The launcher gate is the pre-swap smoke. Both deploy checks probe only *unauthenticated* `/mcp`, so nothing per-connection is ever reached. In `CLAUDE.md`.
- **Prod sits exactly on the pool floor** — see What's Next item 2.
- **Measurement JSON carries the egress IP** (`meta.egressIp`); `INPUT_REALISM_OUT` has no redaction. (Carried over.)
- **Run `validate-*`/`measure-*` ONLY in-container**; `"${REPO}:latest"` in zsh. (Carried over.)
