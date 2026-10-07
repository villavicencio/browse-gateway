---
title: grep -q under pipefail fails the pipeline on exactly the match it was looking for — once the log outgrows a pipe buffer
date: 2026-10-06
category: docs/solutions/runtime-errors
module: scripts/deploy/deploy-on-host.sh, scripts/deploy/preswap-smoke.sh, test/deploy-verify-polls.test.mjs, test/preswap-smoke-version-gate.test.mjs
problem_type: runtime_error
component: deployment
symptoms:
  - "Post-swap verify reports a healthy new container as failed and auto-rolls back a good image; the rollback's own verify can fail the same way (`ROLLBACK ALSO FAILED`)"
  - "Pre-swap smoke times out waiting for a `dnsRebindProtection=true` boot marker that is present in the container log, aborting the deploy"
  - "Pre-swap smoke version gate reports no well-formed `version=` boot line although the line is in the log"
  - "Only bites once `docker logs` output exceeds a pipe buffer (~64 KiB); fresh-container runs and small-fixture tests all pass"
  - "A 3 MB big-log regression test passed on the unfixed smoke script because the fake `docker` ran a hard-coded `exit 0` after its writer was SIGPIPEd"
root_cause: incorrect_assumption
resolution_type: code_fix
severity: high
related_components: [test-methodology]
tags: [bash, pipefail, sigpipe, grep-q, docker-logs, deploy-verify, pre-swap-smoke, test-fake]
---

# grep -q under pipefail fails the pipeline on exactly the match it was looking for — once the log outgrows a pipe buffer

## Problem

In a bash script running `set -euo pipefail`, `docker logs <ctr> 2>&1 | grep -q '<marker>'` returns a failing status on exactly the poll where the marker is present, as soon as the container log is larger than a pipe buffer (about 64 KiB). Three deploy-path checks used this pattern, so a large enough log made a healthy image look broken. One of them rolled back good deploys.

## Symptoms

- Post-swap `verify()` in `scripts/deploy/deploy-on-host.sh` reports `dnsRebindProtection not true` for a container whose log contains `dnsRebindProtection=true`. The deploy then **auto-rolls back a good image**. The rollback's own verify can fail the same way, which ends in "ROLLBACK ALSO FAILED".
- The boot poll in `scripts/deploy/preswap-smoke.sh` never sets `ready`, times out and **aborts the deploy**. That is the safe direction, but the abort is false.
- The smoke's version gate reports `boot line carries no well-formed version=` while the boot line carries a valid `version=`, so the deploy aborts.
- The failure depends on log size. A freshly booted container with a short log passes every time, and small-log unit tests are always green. It shows up only against real, chatty logs.
- The pipeline exit status is `141` (128 + SIGPIPE), not `1`. Nothing prints it, because `if`/`||` consumes it.

## What Didn't Work

- **Small-log tests.** Every existing test used a log of a line or two. The writer finishes before `grep` reads anything, so the bug can't show at that size.
- **The first big-log test of the smoke passed on the unfixed script.** It had a 3 MB log after the marker and was meant to go RED. The fake `docker` on `PATH` in `test/preswap-smoke-version-gate.test.mjs` had this logs branch:

  ```bash
  logs) cat "${dir}/bootline"; exit 0 ;;
  ```

  When `grep -q` closed the pipe, `cat` died of SIGPIPE, and then the fake ran `exit 0`. The fake "docker" therefore always reported success, the pipeline never failed, and the test passed against the broken code. A real `docker` CLI dies of the signal itself and has no chance to exit 0. The fake could not express the failure it was meant to detect. That is the failure mode described in [a test whose stub guarantees the assertion proves nothing](../best-practices/a-test-whose-stub-guarantees-the-assertion-proves-nothing.md). Reproduced in this session:

  ```bash
  set -o pipefail
  sh -c 'cat big.log; exit 0'  | grep -q marker; echo $?   # 0   (fake hides the failure)
  sh -c 'cat big.log; exit $?' | grep -q marker; echo $?   # 141 (what the real CLI does)
  ```

- **Rewriting every `| grep -q` was not needed.** `printf '%s' "$state" | grep -q '^running/true/'` (`scripts/deploy/preswap-smoke.sh:105`) writes one short string. That write fits in the pipe buffer before `grep` can close the pipe, so it was left as is, along with the similar `printf '%s' "$X" | grep -Eq` input validators in `scripts/deploy/deploy-ref.sh` and `scripts/deploy/deploy-on-host.sh`, which the finder command below also lists. The risk grows with how much the writer outputs; `grep -q` alone does not cause it. This was a judgment call and was not measured separately.

## Solution

Capture the output first, then match it without a pipe: use `case` on the captured string, or a here-string for `grep`. The fix is in PR #148 (open as of 2026-10-06).

**`verify()` in `scripts/deploy/deploy-on-host.sh`.** Before (on `main`):

```bash
docker logs "$CONTAINER" 2>&1 | grep -q 'dnsRebindProtection=true' || { echo "verify: dnsRebindProtection not true ($state)"; return 1; }
```

After (`scripts/deploy/deploy-on-host.sh:237-238`):

```bash
logs="$(docker logs "$CONTAINER" 2>&1)" || continue
case "$logs" in *dnsRebindProtection=true*) ;; *) continue ;; esac
```

**Boot poll in `scripts/deploy/preswap-smoke.sh`.** Before:

```bash
if docker logs "$SMOKE_CONTAINER" 2>&1 | grep -q 'dnsRebindProtection=true'; then ready=1; break; fi
```

After (`scripts/deploy/preswap-smoke.sh:98`):

```bash
case "$(docker logs "$SMOKE_CONTAINER" 2>&1 || true)" in *dnsRebindProtection=true*) ready=1; break ;; esac
```

**Version gate in `scripts/deploy/preswap-smoke.sh`.** Before:

```bash
if ! docker logs "$SMOKE_CONTAINER" 2>&1 | grep -q " version=${vsem}\(+[0-9a-f]\{12\}\)\{0,1\} "; then
```

After (`scripts/deploy/preswap-smoke.sh:123-125`):

```bash
local boot_logs
boot_logs="$(docker logs "$SMOKE_CONTAINER" 2>&1 || true)"
if ! grep -q " version=${vsem}\(+[0-9a-f]\{12\}\)\{0,1\} " <<<"$boot_logs"; then
```

The regex needs `grep` here, so the version gate uses a here-string instead of `case`. A here-string is not a pipeline, so `pipefail` does not apply. Each fixed site has a comment explaining why the code captures first (`deploy-on-host.sh:234-236`, `preswap-smoke.sh:96-97`, `preswap-smoke.sh:122`).

The test fake was fixed as well. `test/preswap-smoke-version-gate.test.mjs:37` is now:

```bash
logs) cat "${dir}/bootline"; exit $? ;;
```

With that fake, the 3 MB smoke test went RED on the unfixed script. The verify fake in `test/deploy-verify-polls.test.mjs:53-59` writes `head -c 3000000 /dev/zero | tr '\0' x` after the marker and ends with `exit $?`, so its big-log test went RED on the first run.

## Why This Works

Three things combine to cause the bug:

1. **`grep -q` exits at its first match.** It doesn't need the rest of the input, so it stops reading and closes its end of the pipe. This is not one implementation's quirk. The big-log repro below returns `141` with macOS `/usr/bin/grep` (BSD grep 2.6.0, which `bash -c` resolves), with GNU grep 3.8 (in a Debian container), and with ugrep 7.8.4, all measured 2026-10-06.
2. **The writer gets SIGPIPE.** `docker logs` is still writing the rest of the log. Its next `write()` to a pipe with no reader raises SIGPIPE, and the process dies with status 141.
3. **`pipefail` reports that death.** Without `pipefail`, a pipeline's status is the last command's status (`grep`: 0, found). With `pipefail`, it is the last nonzero status in the pipeline, which is the writer's 141. `if` and `||` treat 141 as failure, so `if pipeline; then <found>` skips the found branch. `! pipeline` *inverts* 141 to success, so `if ! pipeline; then <not found>` (the version gate's shape) runs its not-found branch. Either way the code takes the "not found" path because the marker *was* found early.

Log size matters because of the pipe buffer. If the writer's whole output fits in the pipe buffer (64 KiB by default on Linux), every write succeeds before `grep` exits, and the writer ends normally with status 0. The race appears only when the writer still has output left after the reader has gone. A long-running gateway's log easily passes that size. Measured in this session:

```bash
bash -c 'set -o pipefail; { echo marker; head -c 3000000 /dev/zero | tr "\0" x; } | grep -q marker; echo "rc=$?"'
# rc=141
bash -c 'set -o pipefail; echo marker | grep -q marker; echo "rc=$?"'
# rc=0
```

Capturing with `$(...)` reads the writer to EOF, so it never gets SIGPIPE. The match then runs on a string in memory, with no pipeline involved.

## Prevention

- **Never pipe output of unbounded size into a reader that exits early when the pipeline's status decides something.** This covers `grep -q`, `grep -m`, `head`, `sed q`, `awk '...; exit'` and the like under `set -o pipefail`. Capture to a variable, then use `case "$x" in *needle*)` for a fixed string or `grep -q PATTERN <<<"$x"` for a regex.
- **A pipe is fine when the reader drains to EOF and the status doesn't matter.** The diagnostic lines that remain, `docker logs ... | tail -8 >&2 || true` (`preswap-smoke.sh:107`) and `... | grep -o 'version=[^ ]*' | tail -1 >&2 || true` (`preswap-smoke.sh:127`), print on a path that has already failed and end in `|| true`, so their status decides nothing.
- **Test fakes for CLIs must exit with the status their writer actually got.** End a fake's output branch with `exit $?`, never a hard-coded `exit 0`. A fake that always succeeds can't produce the SIGPIPE a real CLI produces, and a test built on it proves nothing about pipeline status.
- **Give the fake a log larger than a pipe buffer, with the marker before the bulk.** Both regression tests do this:
  - `test/deploy-verify-polls.test.mjs:143`, "a large container log does not make verify miss a marker it found (grep -q + pipefail SIGPIPE)". It expects deploy success and exactly one live launch (no rollback).
  - `test/preswap-smoke-version-gate.test.mjs:107`, "PASS — a log far larger than a pipe buffer still lets the smoke find its marker". It puts a boot line followed by `"x".repeat(3_000_000)` and expects `smoke: OK`.
- **Watch the test go RED before trusting it.** Each new test was run against the unfixed code and failed there. As a mutation check, putting the `grep -q` pipe back into `verify()` turned its test red, and putting it back into the smoke version check turned the smoke big-log test red. Per this session's run, all 34 deploy-script tests pass under bash 5 and macOS `/bin/bash` 3.2.
- **Find the pattern:**

  ```bash
  grep -rnE '\|[[:space:]]*grep[[:space:]]+(-[a-zA-Z]*q|--quiet|-m)' scripts/
  ```

  For each hit, check whether the script runs with `pipefail`, whether the left side can produce more than a few KiB, and whether the pipeline's status drives a branch. If all three hold, capture first.

## Related Issues

- [A test whose stub guarantees the assertion proves nothing](../best-practices/a-test-whose-stub-guarantees-the-assertion-proves-nothing.md): the `exit 0` fake above is another case of that rule.
- [An apt "invalid signature" in a docker build can be a full disk](apt-invalid-signature-in-docker-build-can-be-a-full-disk.md): the other side of the same pipeline-status trap. Without `pipefail`, a pipeline's status is its last command's, so `| tail` hides a failed build. Turning `pipefail` on fixes that, but it is also what makes the early-exit reader here report a false failure. Both are fixed the same way: capture first, then act on the captured value.
- [xvfb-run wedges the container as PID 1](xvfb-run-wedges-container-as-pid1.md): a third way a pipe on Docker output misleads you. There the `| tail` never sees EOF, so a hang shows no output at all.
- [A gate must travel with the code it gates](../best-practices/a-gate-must-travel-with-the-code-it-gates.md): the same two scripts, and the fake-daemon testing approach. A fake daemon has to exit with its writer's real status for any pipeline assertion in it to mean anything.
- PR #148 (open as of 2026-10-06): moves `verify()` to polling and fixes all three call sites. CodeRabbit flagged the `verify()` call site in a review thread on `deploy-on-host.sh`. The two smoke call sites turned up in a sweep for the same pattern.
