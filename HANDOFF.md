---
created_at: "2026-10-07T06:54:18-07:00"
branch: "main"
head: "1f377f4"
resume_focus: "Deploy 1 on the prod host (VIL-290): run the runbook in VIL-290's latest comment as the container's service account, then check the deploy-ref report lines"
---
# HANDOFF — 2026-10-07, early morning

This session started by getting the search verb (VIL-122, PR #147) merged. Then the move to a new prod host
(the old VPS was deleted 2026-10-05) left no working deploy path. So the session built an operator-run
deploy (PR #148), rehearsed it against a real daemon, and wrote up what that turned up (PR #149). **Search
is merged but not live.** Deploy 1 (new image, search off) and deploy 2 (Brave key, search on) are both
waiting on the operator. Side work: per-branch handoffs so several sessions can run in parallel worktrees
(villavicencio/skills#43), and briefs for the dotfiles session.

## What We Built

- **PR #147 → `768af59`: the `search` verb with a Brave adapter.** It's off unless `BGW_SEARCH_ENABLED=1`.
  The CodeRabbit nitpick that the abort controller is never aborted was declined and moved to VIL-123 as a
  comment. The router rewrites `makeSearchFn` anyway.
- **PR #148 → `a62801a`: `scripts/deploy/deploy-ref.sh <sha|tag>`, plus a `verify()` that polls.** Verify
  checks first, sleeps only between attempts, uses one deadline covering the `/mcp` probe, and validates
  `BGW_VERIFY_TIMEOUT` up front (1..600). **What the PR doesn't tell you:** the prod host's copies of
  `deploy-on-host.sh`, `deploy-ref.sh` and `preswap-smoke.sh` are what actually run, and **they are not
  synced yet.** Step 1 of the deploy-1 runbook does that and checks sha256 hashes.
- **PR #149 → `1f377f4`: the learnings.**
  - `docs/solutions/runtime-errors/grep-q-under-pipefail-fails-on-the-match-it-was-looking-for.md`
  - `docs/solutions/runtime-errors/tini-s-dies-on-colima-when-amd64-silently-falls-back-from-rosetta-to-qemu.md`
  - A refresh of four related docs, and `CONCEPTS.md` *Post-swap verify*.
  - The fix commit merged without a second review (docs only, review slot exhausted); recorded in the PR body.
- **Deploy-1 image:** `a62801a` → `ghcr.io/villavicencio/browse-gateway@sha256:87b39b2b1835fdfcfee22d5f1e87625986ddc069e9dd76a3a8a3efb2ad4728f8`.
  Checked with an anonymous pull: amd64, revision label `a62801a021cb…`.
- **Real-daemon rehearsal** on the dev Mac (Colima, amd64 under Rosetta): gate PASS, smoke OK,
  `verify: OK after 1s`, blip about 3 s, boot 2.2 s. These are dev-Mac numbers, not prod's.
- **The production section of `CONTEXT.local.md`** (local, gitignored) holds the deploy procedure,
  rollback, blip notes and the VIL-290 env vars. The VPS-era sections there are marked STALE.
- **villavicencio/skills#43 (VIL-297): handoff/pickup with a per-branch store,** for parallel worktree
  sessions. Still open. This handoff is in the older 0.4.0 format, because the new version isn't released.
- **Linear:**
  - VIL-290 (turn on search; **runbook in its latest comment**), VIL-291 (deploy path), VIL-292 (datacenter
    flag), VIL-293 (arm64 image), VIL-294 (Colima amd64 handler).
  - In the Dotfiles project: VIL-299 (`wt` helper, workflow doc, `/ops` page), VIL-300 (agent tab status
    over SSH), VIL-301 (the CodeRabbit watcher rule).

## Decisions Made

- **Deploys are operator-run on the prod host, not dispatched from CI.** `deploy-http.yml`'s secrets
  describe the deleted host, so **don't dispatch it.** Never auto-deploy on merge.
- **Search goes live in two deploys.** Deploy 1: image `a62801a` with search off. Deploy 2: the same digest
  after adding `BGW_SEARCH_ENABLED=1` and `BGW_BRAVE_SEARCH_API_KEY` to the prod env file. **Brave only
  for now.** Don't put `google` in `BGW_SEARCH_PROVIDERS` before VIL-123 ships, or boot refuses.
- **The GHCR package is public**, so pulling needs no token. An earlier "404" was a raw manifest request
  made without the registry's token handshake.
- **`BGW_ALLOWED_HOSTS` is the inbound Host-header allowlist,** so the Brave endpoint doesn't belong in it.
- **The operator says `--init` in `launch-http.sh` is load-bearing.** A refresh suggestion to call it
  unnecessary was declined.
- **Herdr is retired.** The operator uses plain iTerm2 with vertical tabs and tab groups.

## What Didn't Work

- **Blaming Rosetta for the Colima failure.** The VM had silently lost its Rosetta handler, and QEMU
  user-mode was running amd64, which refuses `tini -s`. A Colima restart fixed it. An arm64-vs-amd64
  control proves *a* translator is at fault, not *which* one. Check `binfmt_misc` before naming it.
- **The first rehearsal crash-looped with `EISDIR`.** Its sandbox was under `/private/tmp`, which Colima
  doesn't share, so the bind mount became an empty directory. Put rehearsal sandboxes under `$HOME`.
- **deploy-ref first reported a ~32 s "blip"** for a deploy that never swapped, because `/mcp` was already
  down. It now takes a baseline probe first.
- **`verify()` first slept before checking,** so a 1 s budget never inspected anything. The tests' fake
  `sleep` hid it, because it never advanced `$SECONDS`.
- **A CodeRabbit watcher reported "skipped"** while the review was actually running: it read a status from
  before the request. Only trust statuses posted after the request (VIL-301).

## What's Next

1. **Deploy 1 (operator).** Use the runbook in VIL-290's latest comment. Run it as the container's service
   account, not the admin login. Expect `deploy: SUCCESS`, no drift NOTE, `verify: OK after Ns` (the first
   real boot time on prod) and `boot line: search=off`.
2. **Deploy 2.** Back up the prod env file, add the two variables, then rerun the same `deploy-ref.sh`
   command with the same sha. Expect `search=brave`, then make one real query.
3. **villavicencio/skills#43.** A re-review was requested 2026-10-07 13:49Z and was in flight at handoff
   time. Merge it if clean, then the `release(dv): 0.5.0` PR, then
   `claude plugin marketplace update villavicencio-skills && claude plugin update dv@villavicencio-skills`.
4. **VIL-123:** the search router plus Google CSE. It includes the abort-signal fix declined on #147.
5. **VIL-291 leftovers.** Decide what happens to `deploy-http.yml`. `CLAUDE.md`'s deploy-gate section still
   describes the VPS host-sync world beyond the note added in #148.
6. **Later:** VIL-292, VIL-294's guard, VIL-293.

## Gotchas & Watch-outs

- **No shell state carries over between tool calls,** so every block in a skill or runbook must stand on
  its own.
- **Local gates:** before trusting or blaming one, check that `colima ssh -- ls /proc/sys/fs/binfmt_misc/`
  lists `rosetta`. The "failed to install interpreter" line in `dmesg` appears even on a good boot.
- **`npm test` on macOS:** compare the failing set by test name against `main`. Today: no branch-only
  failures, and one timing-flaky artifact test that failed on `main` only.
- **CodeRabbit:**
  - It allows one review per hour across every repo and session.
  - In the skills repo, automatic re-reviews are off, so a push after a completed review shows
    "incremental reviews are disabled". Request the next review explicitly.
- **On the new host, image ID and registry digest are the same hash** (containerd image store), unlike the
  old rootless-Docker VPS.
- **The Linear project "Skills" was renamed.** Look it up by id `P-VIL-5`, not by the old name.
- **Background `sleep` jobs stall while the Mac sleeps.** One scheduled review request fired about 9 hours
  late.
