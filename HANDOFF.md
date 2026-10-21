---
created_at: "2026-10-20T21:04:25-07:00"
branch: "main"
head: "e690d24"
worktree: "/Users/dvillavicencio/Projects/browse-gateway"
---
# HANDOFF — 2026-10-20, evening

This session started on 2026-10-12. An IPRoyal usage report showed proxy traffic falling to nothing after the move to the residential prod host. Around the same time IPRoyal published a policy blocking adult sites, which made up almost all of our proxied traffic. That led to VIL-292: the code that limits automatic proxy fallback to named sites is merged, but the setting hasn't been deployed. Nothing has moved since 2026-10-12: no commits and no deploy evidence.

## What We Built

- **PR #169 (`e690d24`, VIL-292): `BGW_ESCALATE_HOSTS`.** Parsed in `parseEscalateHosts` (`src/verbs/escalation.ts`).
  - **Values:** unset means every host may escalate (unchanged); `none` means no host; a host list allows only those.
  - **Scope:** only the *automatic* escalate-on-block path reads it: retrieve, and drive's first navigate. Force-proxy (`forceProxy`, `BGW_FORCE_PROXY_HOSTS`), vault login capture and vault warm-open ignore it.
  - **Boot line:** shows `escalate=all|none|<hosts>`.
  - **Parser:** strict. An entry the URL/IDNA fold would rewrite (`a@b`, `evil%2ecom`, zero-width or fullwidth characters, `*.`) makes the gateway refuse to boot. A real IDN parses whether written in Unicode or punycode.
  - **Tests:** `test/escalate-hosts.test.mjs`, plus 2 boot tests in `test/runtime.test.mjs`. Each one was checked to fail with its fix removed.
- **Linear:** VIL-292 has the measurements (comment from 2026-10-12) and the deploy steps. It auto-closed when #169 merged and was reopened to In Progress, because it isn't done until deployed and verified.
- **Memory:** `iproyal-adult-sites-blocked` records the policy, the measurements, and "never route adult sites through IPRoyal."

## Decisions Made

- **Escalate named hosts only (operator, 2026-10-12)**, chosen over:
  - setting `BGW_ON_DATACENTER_IP=0`, which breaks the vault's pinned and fresh-exit replay (`src/mcp/vault-login.ts:257-279`);
  - separating the flag from the vault entirely (the biggest change);
  - leaving it as is.
- **Keep the logged-in Total Wine flow working (operator).** That's why `BGW_ON_DATACENTER_IP` stays `1` on the prod host, even though the IP is residential. The boot line will keep saying `datacenter=true`, and that is deliberate.
- **Intended prod value: `BGW_ESCALATE_HOSTS=totalwine.com`.** Total Wine isn't an adult site, and its homepage already cleared direct (~11 s).
- **MergeWren: 5 rounds; 4 mediums fixed, 1 declined (`e7d2bed#1`).** A malformed punycode entry like `xn--` boots and matches nothing. That fails safe (less proxy use), and a plain misspelling has the same effect and can't be caught. The reasons are on the thread and in the PR body.

## What Didn't Work

- **Reading `captchaSolveReason: not-configured` as a missing solver key on the prod host.** Retrieve never wires a solver, so it always reports that (`src/verbs/retrieve.ts:1341`). Not a migration gap.
- **Patching the host-list parser one character at a time.** The probes kept finding new ones (`@`, then `%2e`, a zero-width space, fullwidth `．`). What ended it: the folded entry must be a plain hostname, and either be unchanged by the fold or convert back to exactly what was written.
- **`git checkout -- <file>` to undo a deliberate break during a RED check.** It also wiped the uncommitted fix in that file. Back up with `cp` and restore from the copy.

## What's Next

1. **Deploy VIL-292 on the prod host (the operator agent runs it as the service account).**
   - The runbook is the last comment on VIL-292: back up the container env file, append `export BGW_ESCALATE_HOSTS=totalwine.com`, then `deploy-ref.sh e690d24fbc419742c72ded4a7f1d1312b9fc98c7`.
   - Check that the boot line shows `escalate=totalwine.com`. The rollback anchor is `4e8a893`.
   - Have the agent report the `BGW_FORCE_PROXY_HOSTS` and `BGW_WARM_FRESH_EXIT_HOSTS` values. Any adult host on the force list still goes through IPRoyal, because force-proxy ignores the new setting.
2. **Verify from the Mac after the deploy** (time each call; a successful retrieve doesn't report whether the proxy was used):
   - an indexxx retrieve should fail with `proxyUsed=false` in roughly 30 s instead of 90 s;
   - iafd (~6 s) and the Total Wine homepage (~11 s) should still load.

   Then mark VIL-292 Done, with evidence.
3. **File a ticket: indexxx fails both direct and proxied** (Cloudflare 403 "Just a moment…"; one sample each, 2026-10-12). It cleared through the proxy in September.
4. **Carried from the 2026-10-10 handoff:**
   - VIL-293 (operator decision: arm64 image vs reusing browsers; Chrome launch is ~2 s per call);
   - raise `BGW_CPUS` if parallel calls slow down;
   - VIL-131;
   - `obscura keys` still targets the retired host;
   - delete the `browse-gateway:vil313` and `:vil314` images when Colima is next up.

## Gotchas & Watch-outs

- **A successful MCP `retrieve` hides `proxyUsed`.** It only shows on failure, so time the call: a direct render takes ~5–11 s, a proxied attempt 8–58 s. To prove the proxy is in use, compare a direct and a `forceProxy` retrieve of an IP-echo endpoint. Never paste those IPs into a ticket or a commit.
- **Retrieve's `forceProxy` quietly goes direct when no proxy is configured** (`src/verbs/retrieve.ts`, `forced = … && Boolean(proxy) && onDatacenterIp`). A forced success alone doesn't prove the proxy was used.
- **Naming a VIL id in a PR title auto-closes it on merge.** VIL-292 did; reopen after each merge until the deploy is verified.
- **MergeWren on this PR only ever ran incremental rounds after the first full one.** "Still open" with no new text after a fix means it wants the class of input closed, not the single case.
- **The prod host's container env file** is sourced by `launch-http.sh` with `set -a`, and every `BGW_*` variable is forwarded by name. The file's convention is still `export BGW_…=`. Its path, and the deploy procedure, are in `CONTEXT.local.md`.
- **Unchanged:** the zsh shell rules (no variable named `path`; use `--test-reporter=tap` and `tsc --pretty false`), and Colima stays stopped except for in-container gates.
