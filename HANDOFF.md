---
created_at: "2026-08-27T22:22:03-07:00"
branch: "main"
head: "279719d"
---
# HANDOFF — 2026-08-27, late evening

Picked up the previous handoff's item 1 (VIL-135) and closed it: the host launcher was synced and the graceful stop was **watched draining real in-flight sessions in production**, ending the on-host-copy drift class that VIL-134 opened. A follow-up round then closed five loose ends from that work — including a credential this session itself leaked through a redaction filter that could not fail visibly.

> Fleet identities are deliberately absent (public repo). Host names, consumer names, the prod env, the on-host paths, and both token fingerprints live in the private vault memory notes and on VIL-135.

## What We Built

- **VIL-135 closed — host launcher + on-host smoke synced.** No PR: this is a host-side operation, so the *only* repo trace is `d88c5ab`. Both files now hash-match the repo, joining `deploy-on-host.sh` from VIL-134 — all three deploy scripts are finally identical to source. Backups retained beside each. **The evidence is on the ticket, not in the diff**, which is the whole reason VIL-135 existed.
- **`docs/solutions/best-practices/a-gate-must-travel-with-the-code-it-gates.md`** (`d88c5ab`) gained an outcome section: the drift NOTE's first real catch, the both-directions verification method, and the two instrument traps below. Read it before verifying any gate here — the method is the reusable part.
- **`docs/solutions/best-practices/redacting-a-secret-needs-a-verified-redactor-not-a-regex-you-eyeballed.md`** (`279719d`) — new. The BSD/GNU regex failure, the structural `jq` alternative, and two verification checks that assert no *real* value from the file survives the filter.
- **`CLAUDE.md`** (both commits) — the gate rule updated to reflect that the launcher is now synced, plus two new Secrets-&-hygiene bullets: never hand-roll a redaction regex, and the health-token rotation procedure (which requires a container **re-create**, not a restart).
- **VIL-135 carries two long evidence comments** — acceptance criteria with hashes, the captured shutdown sequences, and the follow-up round. That is the durable record; this handoff is the pointer.

## Decisions Made

- **Swapped via `applyCmd` directly rather than the `keys new`/`revoke --apply` round-trip** for the first production swap (operator choice, asked before touching prod). Reason: the CLI's only `--apply` verbs mutate the consumer manifest, and the pool floor was one slot below cap with VIL-133's pre-flight still unbuilt. The CLI wrapper was exercised separately afterwards with a throwaway consumer, so nothing was given up.
- **Rotated the leaked credential rather than scrubbing the transcript.** Scrubbing does not un-disclose. Verified in both directions — the old token must be *refused* before the new one working means anything.
- **The launcher stays host-owned.** Carried forward from VIL-134 and not relitigated: the smoke must boot the candidate with the same launcher the swap will use, or the gate is a false green. Drift is reported as a NOTE, never fatal.
- **The five-consumer count is correct and deliberate** — one consumer was retired earlier the same day because it had been idle 44 hours, and revoking *lowers* the pool floor. Not drift. **Do not re-add it without a reason.**
- **Verification of a negative needs its own control.** Before trusting "the Keychain entry is absent," the lookup was validated against entries that *do* exist — otherwise a wrong service name reads identically to a clean removal.

## What Didn't Work

- **A redaction filter that silently matched nothing, leaking a token into session output.** `\s` is a GNU extension; BSD `sed` treats it as a literal `s`. The filter exited 0 and printed plausible output. This is the `a-test-whose-stub-guarantees-the-assertion-proves-nothing` family applied to a redactor: one that *cannot* match looks exactly like one with nothing to redact. Cost: a live credential rotation.
- **The same BSD/GNU class bit twice more.** A GNU `stat` shadows BSD `stat` on the Mac, so `stat -f '%Lp'` printed filesystem info instead of permissions; and `docker events --until <UTC timestamp>` parses the value as *local* time, reads it as future, and streams forever — burned two backgrounded commands before switching to a pre-started log follower.
- **`.HostConfig.StopTimeout` is not where `--stop-timeout` lives** (it is `.Config.StopTimeout` on Docker 29.x). Its absence was briefly recorded as evidence the old launcher created the container. The conclusion was right by luck; the key is absent on *every* container under this daemon. The sound evidence — the launcher files themselves — needed no container at all.
- **The bare SSH host alias lands as `root`, on the rootful daemon**, where the gateway container does not exist. That reads exactly like "production is down." The admin identity is the non-root deploy user; check `id` before believing an empty `docker ps`.
- **Shell history and repo docs were both dead ends** for explaining a fleet change made by an agent session — it runs the CLI through its tool layer, which never writes shell history, and had recorded nothing in any ticket or doc.

## What's Next

1. **VIL-130 — the health surface.** Folds every fault into one `degraded` bit and cannot see the browser core. Highest-value remaining item, and this session leaned on `obscura status` repeatedly as the only end-to-end signal, which is exactly the thing that is too coarse.
2. **VIL-133 — pre-flight the pool floor in `keys new --apply`.** `poolSizingError` is pure and exported, so the CLI can call the identical function the boot check uses. This session had to reason about the floor by hand twice; that is the ticket's whole argument.
3. **The one gate still never watched refusing: the `--apply` wrapper aborting on a smoke failure.** It has now run green twice, but a deliberate smoke-fail was not manufactured in production. Closing it needs a staged bad config against a throwaway container — the VIL-134 RED-image method is the template.
4. **M2 of the versioning plan (U6/U7/U5/U9) is entirely unbuilt** — optional follow-on, not an outstanding obligation of v1.0.0. U6/U9's axes are blocked on VIL-127.
5. **Still unexplained, carried over:** two successful `retrieve` calls showed no Chrome process across ~79 samples, contradicting `src/verbs/retrieve.ts:42-50`. Do not assume `docker top` sees the whole tree until settled.

## Gotchas & Watch-outs

- **⚠️ The drift NOTE is now silent. If it reappears, the host drifted again** — that is its job, not a bug to suppress. All three deploy scripts currently hash-match the repo; count the copies before trusting any one of them.
- **⚠️ `docker rm` follows `docker stop` within seconds, destroying the old container's shutdown log.** Start a `docker logs -f --tail 0` follower *before* a swap or the graceful-stop evidence is unrecoverable. Do not reach for `docker events` afterwards (see above).
- **⚠️ A redactor is a guard — test it against a known secret before pointing it at real output.** Prefer structural `jq` redaction over regex, and assert that no actual value from the file survives. Assume BSD userland on the Mac; `\s`/`\d`/`\w`, `sed -i`, and `grep -P` all diverge silently, and coreutils on `PATH` can shadow the BSD tool you think you are calling.
- **Rotating the health token requires a container RE-CREATE** — a `docker restart` keeps the old env. Verify the old token is *refused* before concluding the rotation took.
- **`keys new` without `--apply` stages the manifest and env but leaves the container untouched**, so the running gateway does not see the new consumer until something re-creates it. `keys revoke` removes the macOS Keychain entry itself.
- **When a fleet change has no explanation, grep the session transcripts before calling it accidental** — for an agent-run CLI they are the only audit trail. Cross-check against the manifest/env mtimes; an `--apply` writes both within a second and re-creates the container minutes later.
- **`npm test` cannot be green on macOS** — 223 failures is the baseline, all `artifact-filesystem-unsupported`. Compare a delta, never the absolute number.
- **`main` is not branch-protected** — confirm a CI run exists for the head sha before merging.
- **A push aborts an in-flight CodeRabbit review**; land edits first, then request the round. Read the check *description*, never its state.
- **Measurement JSON carries the egress IP**; run `validate-*`/`measure-*` only in-container. (Carried over.)
- **The deploy id is keyed on the FULL commit sha**, is an HMAC rather than a sha prefix, and does not resolve as a git revision — `git log <deploy-id>` fails by design. (Carried over; bit again this session.)
