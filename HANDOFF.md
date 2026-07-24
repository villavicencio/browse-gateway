# HANDOFF — 2026-07-24, afternoon (follow-up session)

Autonomous Opus run continuing from the prior epic-#78 handoff. Implemented the **5 post-merge Codex
findings** (F1–F5) on the merged epic-#78 code, drove them through a **4-round Claude↔Codex review loop to
convergence**, fixed a pre-existing stale gate surfaced along the way, **shipped to main across 3 PRs, and
DEPLOYED to prod** — with the live Atlas owner-host sequence re-run and passing on the production path.

## What We Built

- **PR #87** (squash `0ceecdc`) — the 5 post-#78 follow-ups:
  - **F1** (`observability/warm-advice.ts`, `mcp/drive-controller.ts`) — behavioral advice gates on a LIVE
    press-&-hold (`behavioralChallenge = pxHint && pxCopy`, derived at both `#warmError` call sites), NOT the
    persistent `wafVendor` label; dropped the now-dead `wafVendor` field from `WarmFailureEvidence`.
  - **F2** (`browser/patchright-core.ts`) — bounded **poll for the challenge copy** (≤3×250ms) inside the
    shared `captureChildFrameHtml`, short-circuited when the top doc already holds the copy (optional
    `topHtml` arg — retrieve's `snapshot()` passes it; drive's `#snapshotOf` already `||`-guards).
  - **F3** (`browser/patchright-core.ts`) — `#lastNavBlock` keyed by **request URL** (path-sensitive policy)
    + FIFO-**capped** (`MAX_NAV_BLOCK_ENTRIES = 32`) against page-driven growth.
  - **F4** (`observability/warm-advice.ts`, `mcp/drive-controller.ts`) — new **transport** advice branch
    (`failureClass === "nav-failed" && genuineNetworkFailure`), placed after fresh-exit, before the
    re-capture default.
  - **F5** (`mcp/server.ts`) — `formatSnapshot` renders `pxCopy` alongside `pxHint`.
- **PR #88** (`47e414e`) — fixed a **pre-existing stale gate**: `validate-failure-envelope.mjs` leg 1
  asserted `nav-failed` for an off-allowlist nav; #80 (merged) made that `policy-blocked`. Re-asserted
  `policy-blocked`, kept the load-bearing "no fabricated `wafVendor`" check. (Was red on main since #80.)
- **PR #89** (`9f3f070`) — compounded the sharpest learning:
  `docs/solutions/architecture-patterns/browser-gate-cannot-isolate-a-snapshot-poll.md`.
- **Tests:** 893 unit (+13): `test/warm-advice.test.mjs` (F1/F4 + regression guards, controller wiring),
  `test/failure-diagnostics.test.mjs` (F5 pxCopy header), **new** `test/px-frame-poll.test.mjs` (7
  deterministic poll cases — the F2 load-bearing proof).
- **In-container gates** all green on the deployed image (`sha256:d55aa084`): `validate-frame-capture`,
  `validate-policy-block`, `validate-drive-pxcopy`, `validate-owner-host`, `validate-failure-envelope`.

## Decisions Made

- **F3 fix = URL-key + cap, NOT request-GUID.** Codex asked for request/frame identity; the CDP Fetch event
  and the Playwright request share no public join key, so keying by the request URL (the identity both
  layers DO share, and policy is deterministic per URL) resolves the same-host-different-path case.
- **F2's load-bearing proof is a unit test, not the browser gate.** A full-`render()` gate can't isolate the
  poll (render's settle wait outlasts a late injection → a one-shot read passes the gate too — proven with a
  one-shot probe image). Moved the proof to a fake-page unit test verified to fail on a one-shot revert.
- **F2 poll-for-copy over poll-for-non-blank** (Codex r1): the copy can hide behind an unrelated ad frame or
  an empty challenge skeleton. Accepted trade-off (documented in-code): a cleared PX page pays the full
  bounded ceiling — correctness over latency, pxHint-scoped.
- **Deploy is guarded + reversible.** `deploy-http.yml` resolves `:latest` → immutable digest; the on-host
  wrapper gates (validate-http), pre-swap smokes real-config, swaps, verifies, auto-rolls-back. Prod is now
  `sha256:d55aa084` (= main `47e414e`); **rollback anchor `sha256:4becdf0a`**.

## What Didn't Work

- **First F2 exit condition ("any non-blank markup")** — missed a late copy behind an ad frame / empty
  skeleton. Codex r1. Fixed → poll for the copy.
- **First F2 gate fixture wasn't load-bearing** — the phrase lived in an inline `<script>` string that
  `frame.content()` serializes immediately (matched on read 0), AND render's settle wait masks the poll.
  Codex r2/r3. Fixed → deterministic unit test + `atob`-sourced late injection.
- **Retrieve `snapshot()` didn't short-circuit like drive** — a top-frame PX challenge burned the full poll
  every render (near-deadline timeout risk). Codex r3. Fixed → `topHtml` short-circuit in the helper.
- **`gh pr merge --admin`** is blocked by the auto-mode classifier — use a plain squash merge (docs/green
  PRs merge fine without `--admin`).

## What's Next

- **Live-exercise the untriggered advice branches (optional, belt-and-suspenders).** The clean Atlas re-run
  did NOT trigger F1 behavioral / pxHint-only-403 / F4 transport messages (a clean run has no adverse
  conditions). They're covered by unit tests + gates on the deployed image; a future adversarial live check
  (force a PX press-&-hold, a reputation 403 on a fresh-exit host, a transport failure) would confirm the
  live strings.
- **Pre-existing backlog (unchanged):** R2 cold-path apex-vs-www spelling confirmation; R5 fast-terminal
  (unfiled latency-only stretch).
- **Operator hygiene calls (open):** repo-wide `atlas` test-consumer scrub — declined for now (pervasive,
  established convention across cli-args/cli-vault/warm-advice); left as-is pending your call.

## Gotchas & Watch-outs

- **Prod is now `sha256:d55aa084` (git `47e414e`).** Rollback: `gh workflow run deploy-http.yml -f
  image_tag=<prior-sha-or-anchor>`; anchor is `sha256:4becdf0a`.
- **Live Atlas re-run PASSED on prod** (2026-07-24): TW deep URL warm-open 200 (10.7s) → cross-host→Costco
  refused typed owner-host-mismatch in **4ms before the wire** (exact "pinned to www.totalwine.com — open a
  separate drive session" advice; NO stale/dead-exit/fresh-exit mis-advice; session NOT discarded) → return
  to TW 200 reusing the SAME warm session (**2.9s, not a cold re-open**). R1+R2 confirmed live.
- **Run `validate-*.mjs` gates ONLY via `docker run`** (in-container, Chrome-under-Xvfb) — the standing
  warning still holds. Build: `docker build --platform linux/amd64 -f docker/Dockerfile -t
  browse-gateway:<tag> .`; run: `docker run --rm --platform linux/amd64 --shm-size=1g --init <tag> node
  scripts/validate-<x>.mjs`. (Note: `$REPO:latest` in **zsh** triggers the `:l` lowercase modifier — use
  `"${REPO}:latest"`.)
- **`build-image` CI runs only on push to main** (gated on `test`), tags `:latest` + the short SHA. Verify
  `:latest` == the SHA-tag digest before deploying (`docker buildx imagetools inspect "${REPO}:latest"`).
- **Smoke tooling:** `obscura status` (+ `--stealth`, `vault status`) works over the durable `:8080`
  LaunchAgent tunnel. The live warm-cross-host / TW→Costco browsing re-run needs the **Atlas agent** (MCP
  conn + vaulted creds) — not drivable from the repo session (no gateway MCP here, no consumer token).
- **Codex loop lesson (compounded):** long loops converge into same-theme tails (all 4 rounds were F2-poll
  refinements) — each round caught a real defect the inline verification missed. Drive `codex exec review
  --base main` detached (>600s); verify, don't blind-accept.
- Memory `[[render-gate-cannot-isolate-a-poll]]` + the solution doc capture the deepest learning.
  Public-repo hygiene held throughout (no fleet host/agent/path names introduced).
