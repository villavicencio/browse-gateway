---
created_at: "2026-08-25T19:36:34-07:00"
branch: "main"
head: "0e631b1"
---
# HANDOFF — 2026-08-25, evening

Picked up from the afternoon's tracking session and worked its "What's Next" list in order. Prod got deployed off a month-old image, one confident finding turned out to be wrong and was retracted, two learnings landed, and a release-versioning plan was written and then reviewed to a standstill. The session's shape: the most valuable output was a **retraction**, and the plan that consumed the most effort is the thing that is *not* ready.

> Fleet identities are deliberately absent (public repo). Consumer names, host names, and the prod env live in the private vault memory notes.

## What We Built

- **Prod deployed** — run `32904789325`, `deploy-http.yml`, image `sha256:b2e1966f…` (= `b6f236e`), rollback anchor `sha256:36fad1f4…`. Gate → pre-swap smoke → swap → verify all green; `obscura status` confirms pool healthy and every consumer token intact. This closed VIL-117 / VIL-118's undeployed state; both are `In Review` in Linear and were *not* auto-closed by the merge.
- **`docs/solutions/best-practices/comparing-image-id-to-manifest-digest-is-not-a-drift-check.md`** (in `0e631b1`) — the session's main learning. Written from a mistake I made and had to retract; see Decisions.
- **`CONCEPTS.md`** (new, repo root, in `0e631b1`) — 8 entries seeded from the deploy area: Deploy swap, Gate, Pre-swap smoke, Rollback anchor, Apply path, Consumer, Session pool, Pool floor, plus the image-ID/manifest-digest distinction recorded as a settled ambiguity. `CLAUDE.md`'s layout tree now points at it.
- **`docs/solutions/runtime-errors/keys-apply-sizing-guard-crash-loop.md` refreshed** (in `0e631b1`) — it asserted in four places, *including its title*, that `keys --apply` has no pre-swap smoke. That shipped in **#26**. The postmortem is intact and the still-open floor pre-flight recommendation was preserved; only the status framing changed.
- **`docs/plans/2026-08-25-1733-feat-release-versioning-plan.local.md`** — gitignored, 9 units / 15 requirements / 12 KTDs. Reviewed twice by a six-persona team. **Not implementation-ready** despite its frontmatter saying so; see What Didn't Work.

## Decisions Made

- **v1.0.0, not v0.x**, and semver's axis is the **consumer-facing MCP contract** (tool names, argument shapes, response envelopes, failure classifications) rather than repo churn. Six consumers have been coding against this contract in production for months.
- **Two tiers, one generator** — a public GitHub Release at contract altitude, a private note carrying ticket ids and retry triggers. Driven by the repo being public *and* this being anti-bot infrastructure.
- **Releases sit alongside `:latest`**; they do not become the deploy unit. `deploy-http.yml` keeps working unchanged.
- **Item 1 of the afternoon plan — a deploy-path tag/digest fix — was DROPPED**, because the defect was not real. Do not restart it.
- **`failureClass` promotion is in scope**; a semver axis that names "failure classifications" governs nothing while they exist only as prose inside an error string.
- **VIL-112 should be broken down** — its own title bundles two tickets ("its budget, **or** which deployment it reached"). Proposed split: narrow VIL-112 to version identity; new tickets for the budget/limits half (keep the VIL-110 gate, under epic VIL-90), for structured `failureClass`, and for release engineering. **Not filed yet.**
- **The cross-model review pass was held, not run.** `cross_model_review_mode` is unset (defaults to `auto`) and both peer CLIs are installed, so it would have sent the plan to a third-party model. Egress on a default is not consent.

## What Didn't Work

- **I reported a production drift finding that was wrong, and reported it as the session's most important discovery.** I compared a deploy's rollback anchor against the recorded prod digest, saw a mismatch, and concluded prod had silently drifted and that `obscura … --apply` was an unrecorded code deployment. Both false. The anchor is the container's **image ID** (`docker inspect <container> --format '{{.Image}}'`, `deploy-on-host.sh:93`); the recorded value is the **registry manifest digest**. Different hashes of the same image, by construction. Two consecutive deploy logs print both and they never match in either row. Prod was running exactly what history said. The wrong finding reached agent memory and a plan before it was caught; memory is corrected and the learning is committed.
- **`--apply` is safe and always was.** It pins to the running image (`docker inspect … --format '{{.Image}}'`), so it cannot ship code. The CD path independently regex-validates a full registry digest before `launch-http.sh` runs.
- **The release-versioning plan is not converging.** Round 1: 19 actionable findings, four at anchor 100. I reworked it end to end. Round 2: **three of the four repairs were verified broken against the tree** — KTD1's fail-closed boot does not hold on the HTTP launcher (the server is built inside a per-connection callback, after bearer auth, so a throw is a per-session 500 and both deploy checks only probe *unauthenticated* `/mcp`); `validate-http.mjs` builds its own server with no `version` dep and never touches the launcher it claims to gate; and the public-render allowlist leaks the ticket ids it forbids, because in this repo the conventional-commit **scope** is frequently an issue ref (18 of 59 scoped commits — `fix(#131)`, `feat(#100,#101,#109)`, and two with free prose inside the parens).
- **Two repairs made things worse.** KTD9's build ref drew three independent reviewers: no source mechanism (the design diagram's arrow has no origin node), no guard, discloses stealth source on every call in a public repo, and once shipped is MAJOR to remove. KTD12's draft-then-promote hold has no owner and nothing checkable to review, since the draft is machine-composed.
- **A claim I put in the plan is factually wrong and should not be carried forward:** adopting `structuredContent` does *not* require declaring an `outputSchema`. This repo already emits it on artifact, homeFallback and retrieve results with none declared.

## What's Next

1. **Decide the three questions the plan cannot answer itself**, then rework or shelve it. (a) Does the consumer-visible build ref stay, given three reviewers said drop it? (b) Is the public release note actually for consumers, or for you — because the retry criterion passes with an *empty* note, and its central transition (`failureClass` → `ok`) cannot appear on the wire at all, since `ok` is documented RESERVED and never returned. (c) Is v1.0.0's honest promise "a release happened" rather than "this source is worth retrying"?
2. **File the VIL-112 breakdown** described in Decisions. It is designed but not entered.
3. **Consider shipping only U8/U1/U2/U3/U4 as a first milestone** — the units that actually reach a consumer. Everything from U5 on exists to make notes safe to publish, and per (b) above the public note may carry nothing the per-result version marker does not.
4. **Answer the two questions still parked for the second agent** (carried from the afternoon handoff): file its four unfiled #140 gauntlet findings as VIL tickets, and whether the private-artifact arc gets its own Linear project.
5. **Decide whether to close the 35 migrated GitHub issues.** Still open deliberately; still the operator's call.

## Gotchas & Watch-outs

- **⚠️ Never diff a rollback anchor against a manifest digest.** They are different identifier kinds and their mismatch is structural, carrying no information. Read `RepoDigests`, not `{{.Image}}`, to learn what a container is running. This cost most of an hour and a wrong memory write today — see the committed learning.
- **⚠️ Prod sits exactly on the pool floor.** Six consumers × `PER_CONSUMER_MAX=1` + 1 = 7 = `MAX_SESSIONS`. Zero headroom, and `perConsumerMax` is already at its minimum, so the 2→1 escape hatch that rescued the last consumer onboarding **cannot be used again**. A seventh consumer crash-loops the gateway at boot. Treat any `obscura keys new … --apply` as blocked pending a sizing decision. (The afternoon handoff said "four consumers, floor 5, two slots slack" — that is stale.)
- **⚠️ The plan's frontmatter says `implementation-ready`. It is not.** Round 2 verified three repairs broken. Do not hand it to an executor.
- **`gh` here lacks `read:packages`** — GHCR version queries 403, so an image digest cannot be mapped back to a commit from this machine. That gap is the real residue of today's false-drift finding, and it is VIL-112's territory.
- **`FailureClass` is a type alias, not an enum** (`src/observability/failure-diagnostics.ts:96-109`), re-exported `export type` from both barrels and therefore **erased in `dist/`**. Any test importing from `dist/` can hardcode today's 13 strings but can never fail when a 14th is added. The verbs barrel re-exports it from `./retrieve.js`, not from observability — that hop is deliberate and documented at `src/verbs/index.ts:7-8`.
- **`scripts/validate-mcp.mjs` is in no deploy path** — no npm script, no workflow, no reference. The deploy gate is `validate-http.mjs`, invoked from `deploy-on-host.sh:66`.
- **The auto-mode classifier blocks `gh workflow run deploy-http.yml`** and also blocked the settings skill and reading `.claude/settings.json`. A permission rule was added this session; if it stops working, `! gh workflow run deploy-http.yml -f image_tag=latest` still works.
- **A tagged release and `package.json` are two independent human acts** with nothing tying them together. Zero git tags exist today, so this lands on the very first release if the plan ever ships.
- **Measurement JSON carries the egress IP** (`meta.egressIp`); `INPUT_REALISM_OUT` has no redaction. (Carried over.)
- **Run `validate-*`/`measure-*` ONLY in-container**; `"${REPO}:latest"` in zsh. (Carried over.)
