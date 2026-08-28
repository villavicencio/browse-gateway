---
created_at: "2026-08-28T00:09:06-07:00"
branch: "main"
head: "3067e9d"
resume_focus: "Execute docs/plans/2026-08-28-0000-feat-search-epic-overnight-plan.local.md from Phase 0 — VIL-121 → VIL-122 → VIL-123, deploy VIL-121 only"
---
# HANDOFF — 2026-08-28, just past midnight

A planning-only session. No code changed and nothing was deployed: the search epic (VIL-120) was groomed and pointed, the two provider decisions were made from a live pricing survey, and a prescriptive overnight runbook was written for an unattended lower-model session to execute the whole arc. The tree is clean at the same `main` the previous handoff left.

> Fleet identities, keys, and the epic's research-domain query are deliberately absent (public repo). The runbook itself is gitignored and must stay that way.

## What We Built

- **`docs/plans/2026-08-28-0000-feat-search-epic-overnight-plan.local.md`** — the runbook. Gitignored (`*.local.md`), 614 lines. Its ground-truth section carries `file:line` anchors verified against `main` @ `3067e9d`; if a line has drifted, grep the symbol. **The kickoff prompt for the new session is in its header** and was also put on the clipboard.
- **VIL-120 / 121 / 122 / 123 in Linear** — each carries a dated "Grooming — 2026-08-27" section appended below the original text (originals untouched), estimates 5 / 8 / 5 Fibonacci, and two grooming comments on the epic (sizing rationale; provider decision with the verbatim pricing table + fetch timestamps). VIL-113 carries a note that the `rate-limited` classifier now lands via VIL-121.
- **VIL-121 field-evidence comment** — the automatic-path reproduction captured tonight (thin 404 → `isHardBlock` → 2 proxied exits → `timeout`, 90.3 s). It widens the ticket: 404/410 join CAPTCHA-without-solver and 429 as classes a fresh exit cannot clear.
- **Project memory** — `linear-obscura-project-tracking.md` gained the grooming + provider-decision entries; the MEMORY.md index line was updated.

## Decisions Made

- **Providers: Brave Search (VIL-122 primary), Google Custom Search JSON (VIL-123 fallback).** Both first-party, both $5/1k past free tiers that cover current volume, different indexes. Scrapers rejected (5× entry price, Google-ToS exposure). **Bing is retired** (Microsoft hub, 2025-08-11) — never propose it. Pricing was fetched 2026-08-27 ≈23:05 PDT; the table with sources is the VIL-120 comment.
- **No API keys exist during the overnight run** (operator). Adapters are built from provider docs fetched at kickoff plus scrubbed fixtures and a deterministic fake; live verification is a filed morning ticket.
- **Deploy scope: merge all three, deploy VIL-121 only** (operator). The `search` tool is registered only when `BGW_SEARCH_ENABLED=1`, so merging VIL-122/123 is byte-identical for prod until keys land.
- **Mechanism correction recorded on the tickets:** the observed 90 s was *not* the automatic ladder — `shouldEscalateToProxy` fires only on CF-challenge or hard block, and the reCAPTCHA page was a 200. It was the consumer's own `forceProxy` retry re-rolling an unclearable page until `BGW_CALL_BUDGET_MS`, then #43's timeout override erasing the root class. Tonight's 404 case showed the same burn on the automatic path, so the fix goes in the shared loop.
- **The #43 conflict is resolved by rule, not by deletion:** budget exhaustion becomes a `budgetExhausted` field; it overrides the class only when the root is non-decisive. `validate-call-budget.mjs` leg B stays green by construction (its synthetic render has no decisive root).
- **Scope cuts:** browser-SERP fallback adapter (no owner for HTML result extraction), query cache and URL dedup (Brave's storage-rights clause) — all deferred to follow-up tickets the runbook files in Phase 4.
- **Vocabulary spelling:** kebab-case (`rate-limited`), matching the repo's closed enums, not the tickets' snake_case.
- **Points:** Fibonacci; children only, epic unpointed. Estimates ARE enabled on the team — the Linear MCP just cannot read the scale, so it was asked.

## What Didn't Work

- **Serper's `/pricing` page 404s and its tiers are not on any fetchable page** — recorded as "not listed" rather than guessed. Tavily's paid tier price renders as an animation placeholder on both fetch tiers; only its per-credit rate from the docs was usable.
- **The Linear MCP exposes neither the team's estimation type nor its scale** (`get_team` returns name/timestamps only) — a decision question to the operator, not a lookup.

## What's Next

1. **Start the overnight session** in this directory on the lower model and paste the kickoff prompt (clipboard, or the header of the runbook). It reads CLAUDE.md → the runbook → this file, then runs Phase 0 → Phase 4. Timebox ≈ 10.75 h wall-clock.
2. **Morning, if the run completed:** verify per the runbook's "Verification" section — three squash-merges, one green `deploy-http` run, `obscura status` healthy with five consumers, a thin-404 retrieve through prod returning in < 30 s with `proxyUsed=false`, the `search` tool still absent from prod, four follow-up tickets filed.
3. **Morning, regardless:** create the Brave Search API account and the Google Cloud project + Programmable Search Engine (set to search the whole web — verify that toggle's wording), then work the "Enable search in prod" ticket the runbook files: keys into the prod env, `BGW_SEARCH_ENABLED=1`, container **re-create** (not restart), boot line reads `search=brave,google`, one live search.
4. **If the run stopped early:** the runbook's stop rules leave a pushed branch with a `WIP:` draft PR and a rewritten HANDOFF.md naming the exact gate it stopped on. Pick up from there, not from Phase 0.
5. Still open from the previous handoff, unchanged: VIL-130 (health surface), VIL-133 (pool-floor pre-flight), the never-watched `--apply` smoke refusal, M2 of the versioning plan, the two `retrieve` calls with no Chrome process across ~79 samples.

## Gotchas & Watch-outs

- **⚠️ The runbook is gitignored and must never be committed** — it names the research-domain context by reference and is operator-private by convention (`plans-stay-local-not-proof`). `git check-ignore -q docs/plans/2026-08-28-0000-*.local.md` must print nothing and exit 0.
- **⚠️ PR bodies auto-close named Linear ids on merge.** The runbook restricts each PR body to the one ticket it completes; after every merge re-check VIL-113/121/122/123/127 states.
- **⚠️ `main` is not branch-protected and CodeRabbit's check state is not a review verdict.** The runbook copies the exact check-description and unresolved-thread commands from CLAUDE.md; an executor that reads `mergeStateStatus: CLEAN` as reviewed will merge unreviewed code.
- **The only sanctioned prod mutation overnight is `gh workflow run deploy-http.yml -f image_tag=latest` for VIL-121**, after CI's build-and-push on the merge commit succeeds. No host `docker`, no prod env edits, no `~/.config/obscura/config.json` changes.
- **Brave's FAQ forbids storing results without a storage-rights plan** — one more reason the cache stays out; do not let a "small TTL cache" slip back in during review.
- **Google CSE caps `num` at 10 and the free tier at 100/day with a 10k/day hard cap** — the adapter must clamp and must classify the daily cap as `quota-exhausted`, not retry.
- **A `retrieve` of a thin 404 through prod currently costs ~90 s and two residential exits** — that is the pre-deploy baseline the runbook captures before the VIL-121 deploy and re-runs after; it is the watched RED→GREEN for the night.
- **`npm test` cannot be green on macOS** (223 baseline failures, all `artifact-filesystem-unsupported`); the runbook records a baseline in Phase 0 and compares deltas only.
- **Assume BSD userland; redact structurally with `jq` and test the redactor against a known value first.** (Carried over — it cost a token rotation last session.)
- **The deploy id is an HMAC of the full commit sha, not a git revision.** (Carried over.)
