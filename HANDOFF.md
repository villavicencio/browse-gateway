---
created_at: "2026-10-10T14:47:18-07:00"
branch: "main"
head: "4e8a893"
worktree: "/Users/dvillavicencio/Projects/browse-gateway"
---
# HANDOFF — 2026-10-10, afternoon

This session ran from 2026-10-07 to 2026-10-10. It took the search router and a batch of fixes (PRs #151–#167) from merged to live, through three operator-run deploys. It moved PR review onto MergeWren and retired the dead CI deploy path. Measuring prod latency end to end then showed that every `retrieve` was paying ~5 s for a VPS-era CPU cap, and that a policy-refused URL waited out a whole clearance poll. Both are fixed and live. Nothing is in flight.

## What We Built

- **Prod is `main` `4e8a893`** (digest `sha256:bf48a34d…`), running with `BGW_CPUS=4`. The rollback anchor is `4d83c8c` (`sha256:b2bfa6ea…`).
  - Deploy history, the procedure and the host paths are in `CONTEXT.local.md` ("Production…" section).
  - Deploys run from `scripts/deploy/deploy-ref.sh <40-hex sha>` on the prod host, using the host's copies of the scripts. Those were sha256-verified against `163c628`, and the deploy scripts haven't changed since.
- **PR #166 (VIL-313): `Timing` now accounts for the whole call.** New fields: `sessionAcquireMs` (Chrome launch), `pageSetupMs` and `sessionReleaseMs`. Since the deploy, a thin-404 `retrieve` leaves only 35–71 ms unattributed. The fields describe the *surfaced* render, the same scope as every existing stage.
- **PR #167 (VIL-314): a navigation the gateway's own guard refused runs no clearance-poll rounds.** It now returns `policy-blocked` about 19 s sooner in prod.
  - The decision lives in the pure `clearancePollLimitMs` (`src/browser/patchright-core.ts`).
  - Proof: `scripts/validate-failure-envelope.mjs` asserts the core's poll sleep counter `clearanceWaitedMs === 0`.
- **PR #157 (VIL-133): `obscura keys new` checks the pool floor before staging anything, and `--apply` (new and revoke) refuses without `smokeCmd`.** Bash sources the env file once, exactly as the launcher does. A value the file leaves to the environment produces a warning, never a refusal.
- **PR #158 (VIL-294): `scripts/run-gate.sh <image> <gate>`.** It runs the image's own `tini -s` as amd64 first, and refuses to start a gate if Colima has fallen back to QEMU.
- **Earlier in the arc:**
  - #151: the search router (VIL-123);
  - #152: the captcha solver refuses redirects;
  - #154, #155, #163: poll and escalation fixes for 404/410/429;
  - #161: `_meta` session-failure kind (VIL-110);
  - #162: `deploy-http.yml` deleted;
  - #164: image retention;
  - #156, #153, #160, #159, #165: smaller changes.
- **Off-repo:**
  - **MergeWren** now reviews every browse-gateway PR within minutes; it replaces CodeRabbit's one-review-per-hour throttle.
  - **GitHub:** the six deploy secrets and the empty `prod` environment are deleted. `BGW_DEPLOY_ID_KEY` stays, because `ci.yml:90` uses it.
  - **Tailscale:** the old deploy workflow's OAuth client is revoked.
- **Linear:** VIL-133, VIL-136, VIL-294, VIL-313 and VIL-314 are Done, with evidence on each. VIL-293 carries the launch-cost numbers.

## Decisions Made

- **#157, option 2 (operator):** the gateway's boot check, run inside the pre-swap smoke, is the one authority on whether a config boots. The CLI pre-flight is advisory: it refuses a certain breach and warns on doubt.
- **The MergeWren stopping rule (operator):** after a trade-off is picked, fix highs and anything that breaks the chosen option. Decline the rest, with reasons on the thread and in the PR body, and merge when no high remains. It's in agent memory.
- **`BGW_CPUS=4` (operator), from a measured curve.** Whole call at each cap:

  | CPUs | whole call (s) |
  |---|---|
  | 2 | 5.4 |
  | 3 | 4.0 |
  | 4 | 3.5 |
  | 6 | 3.0 |
  | uncapped | 3.0 |

  It's set in the host's deploy config. `launch-http.sh`'s own default is still the VPS-era `1.75`, deliberately left alone, since the host config overrides it.
- **VIL-314 keeps the poll's single opening read** (~0.7–1.3 s on Chrome's error page). Skipping it was measured: it only moved the same time into `snapshotMs`.
- **Prod checks of policy blocks use the gate inside prod's image, run on the prod host.** Never use private or metadata IPs; the permission classifier rightly denies those.

## What Didn't Work

- **Parsing the env file by hand in #157.** Seven review rounds each found another bash rule it got wrong. Bash itself evaluates the file now.
- **#157's middle rounds (cleared env, sentinels, two-environment agreement).** Each fix drew an opposite medium finding. That's what produced the stopping rule.
- **Waiting for the block event in VIL-314.** A debug build showed the guard has already recorded the block when `goto` throws (73 ms), so the wait was removed.
- **Timing drive calls batched in one message.** Parallel `browser_navigate` calls on one session inflated each other; issue them one at a time.

## What's Next

1. **VIL-293 (operator decision):** Chrome launch is now the largest per-call cost, about 2.0 s at 4 CPUs (1.7 s uncapped). The options are an arm64 image, or reusing browsers across `retrieve` calls. Browser reuse gives up the fresh browser per call, which matters for isolation and stealth. Compare arm64 at the same CPU setting.
2. **If agents start fetching in parallel and calls slow down, raise `BGW_CPUS`** (6 measured as fast as uncapped) before suspecting a regression.
3. **Backlog:**
   - VIL-292: the boot line still says `datacenter=true` on a residential host.
   - VIL-131: the Docker VM has ~8 GB of memory and prod takes 4 GiB of it.
   - `obscura keys` still targets the retired host (README documents the on-host path, #165).
4. **Minor:** `browse-gateway:vil313` and `:vil314` test images are left inside Colima's VM. Delete them when Colima is next up.

## Gotchas & Watch-outs

- **The host deploy config is sourced without `set -a`.** A setting must be written as `export NAME=value` to reach `launch-http.sh`; a bare assignment is silently ignored. Verify with `docker inspect -f '{{.HostConfig.NanoCpus}}' browse-gateway-http`.
- **`BGW_CPUS` caps the whole container,** so all concurrent sessions share it. The curve was measured one fetch at a time.
- **A successful `retrieve` returns no timing.** Measure through the thin-404 URL `https://api.github.com/vil121-does-not-exist`. To separate session cost from page work, use drive's `browser_navigate` inside an open session.
- **The Bash tool here runs zsh:**
  - Never name a variable `path`; it wipes `PATH`. This happened twice.
  - `$var` doesn't word-split.
  - Test output is coloured, so use `node --test --test-reporter=tap <files>` (with the flag before the files) and `tsc --pretty false`.
- **MergeWren:**
  - A declined finding stays "still open" in every later round.
  - Reviews run one PR at a time.
  - The incremental round is "not a pass"; wait for the full confirmation review.
  - The full write-up is in agent memory.
- **Colima is stopped.** Start it only for in-container gates, run them through `scripts/run-gate.sh`, and stop it afterwards.
