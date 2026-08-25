---
created_at: "2026-08-25T14:41:39-07:00"
branch: "main"
head: "1bf19e4"
resume_focus: "Deploy the three undeployed reliability fixes (VIL-117 / #131 zombie-reaping, VIL-118 / #133 stale X lock) — prod is 7 commits behind at 47e414e since 2026-07-24 and both live incidents are fixed on main but not running. The operator was about to name a different starting ticket and may redirect."
---
# HANDOFF — 2026-08-25, afternoon

A tracking-and-hygiene session, not a build one: **zero repo source changed**. The arc was `/dv:pickup` → discover the checkout was stale and a second agent had shipped a whole subsystem → migrate all issue tracking from GitHub Issues into Linear → file one new architecture ticket → close out a handoff-ownership collision that had been running silently for three weeks. The session's shape was that the two most valuable findings were both *coordination* failures, not code ones.

> Fleet identities are deliberately absent from this file (public repo). "The second agent" throughout is a single specific agent; its name, host, and the consumer roster live in the private vault memory notes named below.

## What We Built

- **Linear project `Obscura`** holding **VIL-85 → VIL-120**. All 35 open GitHub issues migrated with full bodies (not summaries), epic/child hierarchy preserved, each carrying a `Migrated from GitHub #N` line plus a link attachment to the original. Epic map: VIL-85=#91, VIL-86=#92, VIL-87=#93, VIL-88=#94, VIL-89=#114, VIL-90=#115. **The GitHub issues were deliberately NOT closed** — see Decisions.
- **VIL-120** — new: search as a first-class capability (`search(query)`, sanctioned providers, fail-fast on SERP CAPTCHA/429), filed verbatim from an operator brief. The value added on top of the brief is the "repo context at filing" header — in particular that **its fail-fast recommendation and VIL-113 (#125) are the same defect found from opposite directions**, so the 429 classification should land once in the shared detection layer rather than twice.
- **`CLAUDE.md`** — new blockquote under the intro: `HANDOFF.md` is single-owner, overwritten wholesale, and agents with persistent context do not write it. Deliberately agent-neutral. `AGENTS.md` symlinks here, so a second agent reading either path gets it.
- **Three memory notes** (vault, private — these carry the identities this file omits): one on the Linear migration, one on handoff single-ownership, one on the two-writer staleness trap. They are indexed in the vault's `MEMORY.md`; the third is the one most likely to save real time — see Gotchas.
- **A message for the second agent on the macOS clipboard** — the tracking move, the auto-close-on-merge trap, and two decisions put to it (whether to file its four unfiled #140 gauntlet findings as VIL tickets; whether the private-artifact arc wants its own Linear project).

## Decisions Made

- **GitHub issues stay open as read-only history rather than being closed.** Closing 35 issues is outward-facing and hard to undo at scale, and it matches the precedent set in the operator's other repo. Reversible — say the word and they get closed with a comment pointing at each VIL id. **This is still an open operator call.**
- **Migrated full bodies, not pointers.** A pointer-only migration is not a migration; if the GH issues are ever archived the content is gone. Cost was ~35 tool round-trips and a lot of context, paid deliberately.
- **Annotated tickets where the repo has overtaken them**, marked as migration-time notes rather than edits to the original text. The load-bearing ones: VIL-106 (#116) carries a **must-re-scope** warning because #117 measured its target page shape as *surviving*; VIL-117 and VIL-118 carry **merged-but-NOT-deployed** banners and are the only two set to Urgent.
- **`HANDOFF.md` is single-owner as of today.** The operator confirmed the shared-file arrangement was unintentional. The second agent stops writing one because it is long-running with persistent context and never loses state; the thing it was using the file for (recording open threads for a human) is better served by the tracker.
- **This file is scrubbed of fleet identities and the `CLAUDE.md` rule is agent-neutral — by necessity, not preference.** Public repo; the standing hygiene rule forbids fleet agent and host names in committed files. See the pre-existing violation in Gotchas.

## What Didn't Work

- **`/dv:pickup` oriented on the wrong session, and looked completely confident doing it.** It read a `HANDOFF.md` that was three weeks stale because local `main` was 3 commits behind `origin/main`. Nothing in the output flagged this — the file's mtime, its content, and its internal consistency all looked fine. The skill reads the working tree before touching the remote, which is safe with one writer and wrong with two.
- **Git authorship cannot distinguish the two agents.** Every handoff commit carries the operator's identity because both agents commit as the operator. `git log --author` is useless here; the file's own format is the only tell (this file's `# HANDOFF —` title vs the other tool's `scope:` frontmatter — different tools, different schemas).
- **I reported "32 open issues" early in the session; the real count is 35.** The first `gh issue list` was read through a `head -60` that silently truncated. Corrected once the full JSON was exported.
- **Linear's markdown renderer mangles strikethrough around inline code.** A `~~`-wrapped code span came back as nested tildes in VIL-107. Cosmetic, content intact, not worth a fix pass — but don't wrap code spans in `~~` in future tickets.

## What's Next

1. **Deploy the undeployed reliability fixes — VIL-117 (#131) and VIL-118 (#133).** Prod has been on `47e414e` since **2026-07-24**; `main` is now `1bf19e4`, seven commits ahead. The gap includes three image-level fixes for **live production incidents**: #135 zombie group reads as GONE (the pool-wedge fix), #137 a reaping PID 1 baked into the image, #138 stale X lock wedging the browser core while HTTP answers healthy. Deploy is `gh workflow run deploy-http.yml -f image_tag=latest`. **Read the deploy caveat in Gotchas first — the artifact subsystem rides along in the same image.**
2. **Answer the two questions put to the second agent** (they are on the clipboard): file its four unfiled #140 gauntlet findings as VIL tickets, and decide whether the private-artifact arc gets its own Linear project. Neither can be answered from this side.
3. **Decide whether to close the 35 GitHub issues.** Left open deliberately; the decision is the operator's.
4. **VIL-120 phase 1** — the cheap half of the search work is the 429 classification, and it should be scoped together with VIL-113 rather than separately.
5. **VIL-106 (#116) needs re-scoping before any implementation** — its named page shapes were measured to survive, and its link-density criterion is refuted. The ticket says so at the top, but it is easy to start from the old body.

## Gotchas & Watch-outs

- **⚠️ This repo has two writers. `git fetch` before trusting `HANDOFF.md`, always.** The second agent pushes its own branches and merges its own PRs from a remote host. A behind checkout serves a stale committed handoff that looks internally consistent. Check `git rev-list --count HEAD..origin/main` before reading anything.
- **⚠️ PRE-EXISTING HYGIENE VIOLATION, not introduced here and not fixed here.** The handoff committed at `1bf19e4` contains absolute remote-host plan paths under a home directory. This repo is public, so those are already published and are in history regardless of what the current file says. Rewriting history is the operator's call and was not attempted. Flagged so it is a decision rather than an oversight.
- **⚠️ The deploy is not a pure reliability deploy.** The same image carries the artifact subsystem (#139/#140/#141, ~20k lines). It is **inert** — `BGW_ARTIFACT_CAPTURE_ENABLED` appears in no shipped config, deploy script, or CI (verified by its author) — but "inert" is a claim to re-verify before the swap, not to inherit. That work's charter says production release needs explicit approval.
- **⚠️ Naming a `VIL-…` id in a PR body can auto-close that ticket on merge.** Linear's GitHub integration scans PR text and moves the issue to Done even when the PR merely mentions it. Re-check ticket states after any merge that names one.
- **Root-lock staleness is unbuilt and it bricks the artifact root.** A graceful `docker stop -t 45` releases the lock (0.135s, measured). A SIGKILL or OOM abandons it, and recovery is an operator removing the directory by hand.
- **Four #140 gauntlet findings were never filed anywhere** — including a P3 lineage TOCTOU where a careless fix "leaks the global response permit and deadlocks all retrieval." They exist only in the previous handoff's prose, which this file just overwrote. **Recover with `git show 1bf19e4:HANDOFF.md`** — that is the only surviving copy until they are filed.
- **`scripts/deploy/launch-http.sh` is the only production `docker run`.** `docker/compose.yaml` is not on the deploy path.
- **Pool floor is `consumers × perConsumerMax + 1`, fail-closed at boot.** Prod: `MAX_SESSIONS=7`, `PER_CONSUMER_MAX=1` → floor 5, four consumers.
- **`docker restart` is the wrong remedy for the zombie leak** — it preserves HostConfig, so an `--init`-less container stays that way. A re-create through `launch-http.sh` is what clears it.
- **The second agent has no Linear access from its host.** The MCP server is machine-local to the operator's Mac, so tickets on its behalf get filed from here.
- **Measurement JSON carries the egress IP** (`meta.egressIp`); `INPUT_REALISM_OUT` has no redaction. Check before pasting anywhere. (Carried over — still true.)
- **Run `validate-*`/`measure-*` ONLY in-container**; `"${REPO}:latest"` in zsh. (Carried over.)
