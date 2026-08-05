# HANDOFF — 2026-08-04 (planning session — no code shipped)

A **comparative-analysis and backlog session**, not a build session. Operator asked for a detailed
comparison of the public `anythingwithawire/clawbrowser` project against Obscura, then for the gaps it
surfaced to be filed as Agile epics + tickets. Outcome: **4 epics and 16 child tickets filed (#91–#111)**,
grounded in a full read of both codebases. **No commits, no PRs, no deploys** — working tree clean, on
`main` at `0d2fe91`, prod unchanged at `sha256:d55aa084`.

## What We Built

- **Comparative analysis of ClawBrowser (1,535 LOC, 6 files) vs Obscura (~16.8k LOC TS, 893 unit tests,
  21 gates).** Cloned and read the whole thing: `browser.py` (901 lines), `claw.sh`, `SKILL.md`,
  `PROMPT.md`, `README.md`. Delivered a feature-parity table, a stealth-axis table, and a ranked
  hole-list. Their stack: PyQt6 WebEngine driven by Qt signals + `runJavaScript`, localhost REST API.
- **Filed epic #91 — sub-resource request filtering on the proxy path.** Children #95 (evaluator),
  #96 (list provenance), #97 (escape hatches), #98 (byte accounting), #99 (gate).
- **Filed epic #92 — measure CDP detectability.** Children #100 (probes), #101 (three-way baseline),
  #102 (red line in `validate-stealth`), #103 (conditional mitigation).
- **Filed epic #93 — live session view + human takeover.** Children #104 (read-only view),
  #105 (frame retention/redaction), #106 (leased takeover), #107 (pause-for-human on login),
  #108 (`obscura view` CLI).
- **Filed epic #94 — behavioral realism audit.** Children #109 (measure input), #110 (conditional
  timing model), #111 (guard test).
- **All 20 issues follow the #39 house format** — Problem / Current behavior with verified `file:line` /
  Proposed change / Acceptance criteria / Scope & non-goals / epic backlink + hygiene footer. Epic bodies
  follow #38's format and carry child checklists with explicit ordering. Labels drawn from the existing
  set (`epic`, `enhancement`, `reliability`, `observability`, `site-compat`).

## Decisions Made

- **Stayed on Opus 5; did NOT switch to Fable 5.** Operator asked whether to switch before the writeup.
  Three reasons against: (1) **caches are model-scoped with no escape hatch** — switching mid-session
  re-processes the whole loaded context (both codebases + the `claude-api` skill) at Fable's $10/$50 per
  MTok vs Opus 5's $5/$25; (2) Fable's documented edge is demanding reasoning and long-horizon autonomous
  execution, but the analysis was already done — what remained was disciplined writing against a known
  template; (3) raising `/effort` is the cheaper lever for depth. Checked against the `claude-api` skill
  rather than answered from memory, per the standing never-answer-from-memory rule.
- **Negative controls are acceptance criteria in #99, #102, and #111** — each gate must be *observed
  failing* against a deliberately broken config before merge, with the red result recorded in the PR.
  Direct application of the #87/#89 lesson (`[[render-gate-cannot-isolate-a-poll]]`): #99 explicitly calls
  out that a naive "page still renders" check would pass whether or not the filter does anything.
- **#101 can conclude "our probes are inadequate."** If the positive control (debugging port + attached
  client) doesn't separate from the negative control (no protocol at all) on any probe, the finding is a
  probe-inadequacy result and #102 is blocked — not a green gate. This is what stops #92 from producing a
  gate that measures nothing.
- **The two conditional tickets (#103, #110) open with a do-not-start banner**, empty Problem sections, and
  explicit instructions not to scope/estimate/prototype before their blocking ticket reports. Both are
  expected to close as not-needed. Per #38's ROI lesson — unmotivated complexity in a hot path is
  expensive to carry and hard to remove.
- **#106 states takeover is not a policy bypass, in the acceptance criteria** — owner-host clamping holds
  under human control, with a test asserting a credential-bearing session can't be walked cross-host by an
  operator, producing #78's typed owner-host-mismatch advice rather than a discard.
- **#105 must ship WITH #104, not after.** A viewer that ships before its redaction policy has already
  created the exposure the policy exists to prevent.
- **#105 states honestly that frame content is not redactable.** We can't OCR frames to scrub secrets;
  mitigations are procedural (operator-tier auth, zero default retention, bounded TTL) plus documentation
  saying plainly that a captured frame may contain anything the page displayed. An honest boundary beats a
  redaction claim that doesn't hold.
- **#94 is expected to resolve verify-and-close** — same shape as #44 and #48. Filed anyway because
  "probably fine" is not a thing to have on record about the input path of a stealth gateway pointed at
  behavioral-biometric vendors.

## What Didn't Work

- **Nothing failed** — no code was written or run this session. The only false start was reaching for
  memory on the Fable-vs-Opus question before loading `claude-api`; corrected immediately.
- **Explicitly ruled out for adoption from ClawBrowser:** bookmarks, history, tabs-as-API, `/eval`, and
  their transport. Their `/eval` on an unauthenticated `127.0.0.1` listener, in a browser holding a global
  cookie jar with live logins, is the exact failure mode Obscura's policy/auth layer exists to prevent —
  and `_read_body` parses JSON regardless of `Content-Type`, so a visited page can CSRF it. Do not
  relitigate; the only thing worth taking is the domain-blocklist idea, which is #91.

## What's Next

1. **#109 (measure input realism) and #101 (three-way CDP baseline) are the cheap ones to run first.**
   Both epics rest on assumptions — that Patchright's input layer emits trusted events, and that we're not
   CDP-detectable. Both are measurements, not builds. Running them before committing to build order tells
   you whether #94 closes verify-and-close and whether #103 ever opens.
2. **#95 (request-filter evaluator) is the highest-ROI build.** Rides an interception hook we already own
   (`patchright-core.ts:965`, `urlPattern: "*"`), and pays in proxy GB — which is real money on the
   residential tier.
3. **Answer the CapSolver hygiene question** (see blockers below).
4. **Pre-existing backlog, unchanged from the prior handoff:** R2 cold-path apex-vs-www spelling
   confirmation; R5 fast-terminal (unfiled latency-only stretch); live-exercise of the untriggered F1
   behavioral / pxHint-only-403 / F4 transport advice branches (covered by unit tests + gates on the
   deployed image; needs real adverse conditions to confirm live strings).
5. **Operator hygiene call still open:** repo-wide `atlas` test-consumer scrub — declined previously as
   pervasive/established convention; left as-is pending your call.

## Gotchas & Watch-outs

- **⚠️ Open decision — #107 names CapSolver.** Already public in
  `docs/solutions/runtime-errors/captcha-solver-render-race-domcontentloaded.md`, so it discloses nothing
  new, but it's a judgment call you may want differently. Say the word and it scrubs to "the solver tier."
- **Hygiene scan came back clean otherwise** across all 20 published bodies — no fleet identifiers,
  consumer names, image digests, tunnel details, local paths, or target-site names. Note that existing
  issue **#21's title does name a target site**, so your actual bar may be looser than what was applied
  here; the tickets were written to the stricter standard regardless.
- **File:line anchors in the tickets are pinned to `0d2fe91`** and every ticket says "grep the symbol if
  drifted." Anchors were verified live this session, not recalled — but they will rot.
- **The four epics assume two things that are unverified:** that Patchright emits trusted input events,
  and that we're not CDP-detectable. #109 and #101 exist specifically to test them. Don't treat #110 or
  #103 as scoped work until those report.
- **Prod is unchanged: `sha256:d55aa084` (git `47e414e`).** Rollback anchor `sha256:4becdf0a`. Deploy via
  `gh workflow run deploy-http.yml -f image_tag=latest`. Nothing this session touched prod.
- **Run `validate-*.mjs` gates ONLY via `docker run`** (in-container, Chrome-under-Xvfb) — standing rule.
  Build: `docker build --platform linux/amd64 -f docker/Dockerfile -t browse-gateway:<tag> .`; run:
  `docker run --rm --platform linux/amd64 --shm-size=1g --init <tag> node scripts/validate-<x>.mjs`.
  (`$REPO:latest` in **zsh** triggers the `:l` lowercase modifier — use `"${REPO}:latest"`.)
- **In-container gates needing bind-mounts require the overlay-image approach** (#50 lesson — colima won't
  share `/private/tmp`), plus `--init`. #99 and #111 both inherit this.
- **`gh pr merge --admin` is blocked by the auto-mode classifier** — use a plain squash merge.
- **Adversarial review routes through `dv:gauntlet`**, not hand-rolled `codex exec review` loops
  (standing order; supersedes the older SOP note in memory).
