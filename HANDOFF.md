---
created_at: "2026-08-28T09:05:24-07:00"
branch: "main"
head: "1a28d69"
resume_focus: "Phase 2 of the search epic — VIL-122, the search verb with a Brave adapter (merge-only, no deploy; no API keys exist)"
---
# HANDOFF — 2026-08-28, early morning

Executed Phase 0 and Phase 1 of the overnight search-epic runbook. **VIL-121 is merged and live in production** with the watched RED→GREEN captured through prod; two learnings were compounded to `docs/solutions/`. Phases 2–4 (VIL-122, VIL-123, epilogue) have not been started — this session stopped after Phase 1's tail rather than continuing, so the runbook picks up cleanly at Phase 2.

> The runbook remains gitignored and uncommitted, as required. No keys, fleet identities, or research-domain queries were written anywhere.

## What We Built

- **PR #146 → `1471f12`, deployed** — VIL-121. The escalation ladder no longer spends residential exits on failures a fresh exit cannot change. What the PR does not tell you: `DECISIVE_FAILURE_CLASSES` ships **narrower than the runbook specified** (`{rate-limited, captcha, policy-blocked}`, not including `hard-block`/`anti-bot-block`) — see Decisions, and do not "restore" the other two.
- **`isTerminalUnclearableRender`** (`src/browser/detect.ts`) — the one predicate both re-roll loops consult. It exists because the entry gate and the loops are *different* enforcement points; adding a rule to the gate alone leaves `forceProxy` unguarded.
- **`docs/solutions/architecture-patterns/a-fresh-exit-cannot-clear-a-404-a-429-or-a-captcha.md`** (`b7b5ca5`) — the VIL-121 learning. Its second half is the part worth reading: three of four review findings were "the same rule applied at one of several enforcement points."
- **`docs/solutions/runtime-errors/apt-invalid-signature-in-docker-build-can-be-a-full-disk.md`** (`1a28d69`) — the Phase 0 blocker, compounded. Contains a pre-build disk guard that is **proposed, not installed**.
- **VIL-136 (High) and VIL-137 (Medium)** — follow-ups filed with full reproduction detail. VIL-136 came out of reading the *success* measurement, not a failure.

## Decisions Made

- **`DECISIVE_FAILURE_CLASSES` excludes `hard-block` and `anti-bot-block`.** The runbook listed them as decisive *and* asserted the existing #43 budget tests stay green; both cannot hold, because one of those tests drives a CF challenge whose root is `anti-bot-block`. Narrowing was chosen over rewriting the test: those two are the *exit-clearable* classes, where "we ran out of time, try again" is correct advice. The surviving membership test is **"if the caller acts on this label by asking again, are they wrong?"**
- **The terminal break keys on STATUS, never on the block reason.** A review suggestion to use the reason was investigated and **rejected**: `cfHint` is a persistent marker with no liveness requirement, so `classifyBlock` labels an ordinary thin 404 from *any* Cloudflare-fronted origin `cf-challenge`. Reason-gating would re-roll every exit on the most common shape the ticket exists to stop. A regression test pins this — do not relitigate.
- **Cloudflare is the only vendor exempted from the terminal break.** PerimeterX/DataDome are behavioral: a fresh exit does not clear them and a retry re-triggers them. One attempt then stop is correct, and is now documented on the predicate.
- **Drive's loop was fixed; the login-runner's third copy was not.** Deliberate scope call — credential-capture path with its own vault gates. Routed to VIL-137, not dropped.
- **Fixture rule sharpened:** a string identifying a *site* is banned; a string the *classifier matches on* is required. CodeRabbit asked to remove `g-recaptcha`; the rule was the thing that was wrong, not the fixture.
- **Deploy rode `b7b5ca5`, not the merge commit.** The docs push to `main` cancelled `1471f12`'s CI via same-branch concurrency. Same code plus docs, so this was correct — but "the merge commit's CI went green" was *false*.

## What Didn't Work

- **The runbook's prod probe URL cannot verify anything.** `example.com/does-not-exist-vil121` has a **288-char body** — over the 200-char `MIN_CONTENT_LENGTH` — so it is not a hard block, never escalates, and returns fast-and-clean both before *and* after the fix. Used `https://api.github.com/vil121-does-not-exist` (~100 chars) instead. **Check any future probe against the threshold before trusting it.**
- **Clock skew as the docker-build diagnosis** — reasonable (three clocks under emulation) but wrong; ruled out by measuring all three before finding the full disk.
- **Two fixture comments named vendors while explaining the fixtures had no vendor markers**, which gave them markers — the hint scanners read raw HTML *including comments*. Three tests failed until the comments were rewritten.
- **`callBudgetMs: 0` does not reach drive's escalation throw** — it is refused earlier at the queue boundary as a plain `Error`. A non-escalating direct failure that outruns a small budget is the reachable path.

## What's Next

1. **Phase 2 — VIL-122**, the `search` verb with a Brave adapter, per the runbook's §2. Merge-only; prod has no keys so the tool stays unregistered. Provider docs for **both** Brave and Google CSE are already fetched and saved with URLs + timestamps in this session's scratchpad under `provider-docs/` — re-fetch if that scratch is gone.
2. **Phase 3 — VIL-123** (router + Google CSE), then **Phase 4** (epilogue: follow-up tickets, epic comment, memory, handoff). Note Phase 4's follow-up list is now partly done — VIL-136/137 are filed.
3. **Morning, operator:** create the Brave Search API account and the Google Cloud project + Programmable Search Engine (verify the "search the whole web" toggle wording), then the enable-in-prod ticket: keys into prod env, `BGW_SEARCH_ENABLED=1`, container **re-create** (not restart), boot line reads `search=brave,google`.
4. **`browse-gateway` MCP dropped its connection** (`ConnectionRefused` on the tunnel at `127.0.0.1:8080`) after the deploy. The deploy's own post-swap verify passed and `obscura status` was healthy immediately after, so this looks like the local tunnel/session, not the gateway. Does not block Phases 2–3; **does** block any further live prod verification.
5. Recommended maintenance: `/ce-compound-refresh xvfb-run-wedges-container-as-pid1` — its `| tail` rule covers only EOF-buffering and is now incomplete (the same pipe also masks *exit status*).
6. Still open, unchanged: VIL-130 (health surface), VIL-131 (pool floor, Medium), VIL-133 (pool-floor pre-flight), the never-watched `--apply` smoke refusal, M2 of the versioning plan.

## Gotchas & Watch-outs

- **⚠️ The clearance poll is now the dominant cost on a thin 404** — 20.2 s of the post-fix 22.0 s. That is VIL-136, and it means a "still slow" report after VIL-121 is expected, not a regression.
- **⚠️ Do not re-add `hard-block`/`anti-bot-block` to `DECISIVE_FAILURE_CLASSES`,** and do not switch the terminal break to the block reason. Both look like obvious cleanups and both are wrong; each has a test pinning it and a rationale in the PR body.
- **⚠️ Pushing to `main` right after a merge cancels the merge commit's CI run.** Confirm *which* run actually produced the image before deploying — "the PR was green" is not the same claim.
- **The proposed disk guard in the new solutions doc is NOT installed.** If you install it, watch it RED *and* GREEN — the terser `&&`-chain form returns exit 1 on the healthy path.
- **A host `df` is not evidence for Docker disk pressure** — the Mac showed 28G free while the colima VM's `/var/lib/docker` had zero. Use `colima ssh -- df -h /var/lib/docker`.
- **`validate-call-budget` leg B silently self-skips without `BGW_PROXY_*`.** It ran this session by mapping the local spike creds by *name* (no proxy request is made). A "PASS with 1 note" there means the leg did not run.
- **`npm test` baseline on `main` is now 1529 / 1306 / 223** (fail count unchanged from the documented 223). Compare the failing set **by name**, not by count.
- **PR bodies auto-close named Linear ids on merge** — VIL-121 went to Done automatically. Re-check VIL-113/122/123/127 after every merge; they were verified untouched this session.
- Carried over: assume BSD userland and redact structurally with `jq`, testing the redactor against a known value first; the deploy id is an HMAC of the full commit sha, not a git revision.
