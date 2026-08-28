---
created_at: "2026-08-27T20:33:13-07:00"
branch: "main"
head: "c864947"
resume_focus: "VIL-135 — sync the host's launch-http.sh (and preswap-smoke.sh) so PR #141's graceful stop finally runs; the drift NOTE fires on every deploy until it does"
---
# HANDOFF — 2026-08-27, evening

Picked up the previous handoff's item 1 (VIL-134) and completed it end to end: merged, host synced, and the deploy gate **watched RED in production** — the criterion that had never been met for any gate in this project. The CE-artifact backlog was cleared alongside it. The session's most valuable output is not the fix but what the fix's own drift detector found on its first live run: a *second* merged fix that has never executed in production, now VIL-135.

> Fleet identities are deliberately absent (public repo). Host names, consumer names, the prod env, and the on-host paths live in the private vault memory notes.

## What We Built

- **PR #145 → `b62f14c` — VIL-134.** `deploy-on-host.sh` extracts the pre-swap smoke from the image it is deploying and fails closed without one. The reasoning that is *not* in the diff: `docker create` + `docker cp` was chosen over `docker run … cat` so extraction never starts a process from the image you are about to run on the host, and the launcher deliberately does **not** travel with it — the smoke must boot the candidate with the same launcher step 6's swap uses, or it is a false green.
- **Host forced command replaced.** Original kept at `~/deploy/deploy-on-host.sh.bak-20260827`. The sync turned out *not* to be a one-way door, but only because of the backward-compat fix below — worth knowing before touching it again.
- **`docs/solutions/best-practices/a-gate-must-travel-with-the-code-it-gates.md`** (`c864947`) — the rule plus the live-proof method. Read the "Proving it on the real host" section before verifying any gate here; it is the reusable part.
- **`test/deploy-smoke-sourcing.test.mjs` + `test/preswap-smoke-version-gate.test.mjs`** — 14 assertions, every one watched failing with the fix reverted. The fixtures encode two non-obvious facts: the smoke's launch and the real swap are distinguishable only by *launch target*, and an old-format smoke resolves its launcher by path.
- **`CLAUDE.md`** gained the gate-must-travel rule, including the two live consequences (`--apply` still drifts; `launch-http.sh` stays host-owned on purpose).
- **CE artifacts cleared** — `docs/plans/2026-08-25-1733-*.local.md` now carries per-unit status, and three solution docs were refreshed (see Decisions).

## Decisions Made

- **The launcher stays host-owned; only the gate travels with the image.** A gate should ship with the code it gates; a production *swap* should not be dictated by the artifact being swapped in. Divergence is reported as a NOTE, never fatal. Ruled out sourcing `launch-http.sh` from the image — do not relitigate without addressing the false-green argument.
- **`--apply`'s on-host smoke was deliberately NOT synced.** It would very likely work, but I could not exercise `--apply` to watch its gate report bad news, and this repo's rule is that an unwatched guard is untrusted. Folded into VIL-135 with a five-step procedure. This is a deliberate stopping point, not an oversight.
- **VIL-134 auto-closed on merge** via the Linear integration, exactly as the global rule warns. Here it was correct; the check still has to be done every time.
- **Compound-refresh corrected two claims this session's work invalidated:** `keys-apply-sizing-guard-crash-loop` called the smoke "the single source of truth shared by the CD wrapper" (never true in production), and `comparing-image-id-to-manifest-digest` cites repo line numbers as evidence about prod. The latter's conclusions survive re-checking the host file — same lines, undrifted **by luck, not method** — and that is now recorded, since the doc's whole subject is unsound method.
- **`over-subscription-refuses-cleanly` closed on its stated open question.** The PSS measurement reframes it: admission control is correct, but `maxSessions` is 7 while the box holds ~5, so a *working* admission layer over-admits into a memory wall. Stated explicitly as a mechanism of the right shape, **not** a confirmed diagnosis of the old field report.

## What Didn't Work

- **Extracting the smoke into a bare temp file.** The deployed image's smoke predates `BGW_LAUNCH_SCRIPT` and resolves `$HERE/launch-http.sh`, so it would have found no launcher and aborted any redeploy of an older digest. Only caught by running the extraction against the real prod image — no test or review would have. Fixed by extracting into a temp *directory* carrying the host launcher.
- **Two of my own tests proved less than they appeared to.** First, `swapped()` checked only that the marker file existed — but `deploy-on-host` copies the launcher next to the smoke, so the smoke's own launch created it; the assertion passed with the swap never running. Then the path-based fix still failed for a *current-format* smoke, which honours `BGW_LAUNCH_SCRIPT` and runs the same deploy-dir launcher the swap does. Both found by review, both the exact failure family in `a-test-whose-stub-guarantees-the-assertion-proves-nothing.md` — which this PR cites. The discriminator has to be the launch **target**.
- **`docker build` cannot build `FROM` a bare image ID** — BuildKit resolves it as a Docker Hub repo (`pull access denied`). Tag the image locally first.
- **Compound SSH commands are blocked by the auto-mode classifier**, as `CONTEXT.local.md` warns. Atomic single-purpose commands work; expect to split every multi-step host operation.

## What's Next

1. **VIL-135 — sync the host's `launch-http.sh`. Highest value.** Prod's copy is from 2026-06-24 and predates PR #141's graceful `docker stop -t 45`, so **every container swap still SIGKILLs in-flight work** — the VIL-114 mechanism, with its own fix sitting undeployed since 2026-08-17. Same backup → stage → sha256 → atomic `mv` procedure that worked today. Sync `~/deploy/preswap-smoke.sh` in the same visit so `--apply` gets the `version=` assertion, then exercise `--apply` once and *watch* its smoke run. Acceptance signal: the drift NOTE disappears from the next deploy.
2. **VIL-130 — the health surface** folds every fault into one `degraded` bit and cannot see the browser core.
3. **VIL-133 — pre-flight the pool floor in `keys new --apply`.** `poolSizingError` is pure and exported, so the CLI can call the identical function the boot check uses.
4. **M2 of the versioning plan (U6/U7/U5/U9) is entirely unbuilt** and is optional follow-on, not an outstanding obligation of v1.0.0. U6/U9's axes are blocked on VIL-127.
5. **Still unexplained, carried over:** two successful `retrieve` calls showed no Chrome process across ~79 samples, contradicting `src/verbs/retrieve.ts:42-50`. Do not assume `docker top` sees the whole tree until settled.

## Gotchas & Watch-outs

- **⚠️ The drift NOTE now fires on every deploy** until VIL-135 lands. That is intended and non-fatal — do not "fix" it by silencing it.
- **⚠️ An on-host copy of a repo script is stale until you have watched it run.** Two files were caught this session by the same mechanism. Count the copies before trusting one; if a script exists in N places, exactly one executes and it is not automatically the one you edited.
- **⚠️ Capturing `docker create` with `2>&1` is a real bug here** — this daemon prints `WARNING: IPv4 forwarding is disabled` to stderr, which would be folded into the container id.
- **⚠️ Verifying a gate live needs both directions and a verbatim probe.** `eval` the real block out of the installed file rather than re-implementing it, and give the RED image build its own `grep` guards — without them a drifted pattern yields a *working* image and you record a green run as proof the gate bites. Check the live container's **uptime did not reset**, not merely that it is running.
- **PSS values are MiB, not MB** (`smaps_rollup` KiB ÷ 1024). The measurement doc mislabelled its own output and the slip reached two other docs before review caught it.
- **`main` is not branch-protected** — confirm a CI run exists for the head sha before merging.
- **A push aborts an in-flight CodeRabbit review**; land edits first, then request the round. Read the check *description*, never its state.
- **`npm test` cannot be green on macOS** — 223 failures is the baseline, all `artifact-filesystem-unsupported`. Compare a delta, never the absolute number.
- **Measurement JSON carries the egress IP**; run `validate-*`/`measure-*` only in-container. (Carried over.)
- **The deploy id is keyed on the FULL commit sha**; images are tagged with the short one. (Carried over.)
