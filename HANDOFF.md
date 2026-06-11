# HANDOFF — 2026-06-11 (afternoon PT)

Picked up from the 2026-06-10 handoff (tunnel hardening deferred pending discussion). This session: adopted a
public-safe **codename "Vault"** for the remote consumer and scrubbed the old nickname out of the working tree,
memory, and **all git history** (force-pushed); **activated the hardened durable tunnel**; built + merged a
**real-config pre-swap smoke** into the deploy pipeline (PR #19); pruned 20 stale local branches; and ran a
**brainstorm + implementation plan for "Obscura"** — a boutique brand + one-command-connect CLI over the gateway —
backed by two market-research scans. Obscura design docs are local-only (gitignored); nothing of it is built yet.

> Fleet detail (host/IP/tailnet/proxy/CAPTCHA/consumer identities) stays in `*.local.md` + agent memory, never
> here — this file is committed to a PUBLIC repo. Placeholders: `<prod-host>`, the residential proxy, the CAPTCHA
> provider. "Vault" is the public-safe consumer codename; "Obscura" is the brand-in-progress.

## What We Built
- **Codename Vault + full scrub.** Replaced the remote consumer's old nickname with **Vault** in `HANDOFF.md`,
  the agent memory store, and **every commit (content + messages) across all of `main`** via `git-filter-repo`,
  then force-pushed (`00627b2…3d818a4`). Backup bundle at `~/bgw-pre-scrub.bundle`. Live operational ids (prod
  consumer id, the local vault folder) intentionally unchanged — private, not in the repo.
- **Hardened durable tunnel ACTIVATED.** The Mac→prod gateway tunnel is now a LaunchAgent
  (`com.dvillavicencio.browse-gateway-tunnel`) running a self-disabling keeper over a **restricted, non-root
  `bgwtunnel` SSH user** (key pinned to `permitopen=127.0.0.1:8080` — forward-only, no shell). Self-disables
  after ~10 fast-fail reconnects so a dead/changed prod can't reconnect-storm. Verified live (gateway 401 through
  the tunnel). Ops note: `TUNNEL.local.md` (gitignored); memory `durable-tunnel-launchagent`.
- **PR #19 — real-config pre-swap smoke (MERGED, `6512525`).** Adds a step to `scripts/deploy/deploy-on-host.sh`:
  between the isolated `validate-http` gate and the live swap, boot the new image against the REAL on-host env +
  `consumers.json` on a throwaway container/port, probe `/mcp` (running, RestartCount=0, dnsRebind=true, 401 with
  the live `Host:` header), tear down, abort with the live container untouched on failure. Plus review hardening:
  `--restart no` + EXIT trap (no orphan smoke container), `BGW_SMOKE_SHM_SIZE` cap, configurable boot poll, and a
  `Host`-header hint in the failure message. Touches `deploy-on-host.sh` **and** `launch-http.sh`
  (new `BGW_RESTART` knob). Independently verified by a fake-Docker sim of both pass/abort paths.
- **Branch prune.** Removed 20 stale local branches (all merged PRs #1–#19 + `pr/*` mirrors); only `main` remains.
  Corrected the stale "PR #1 OPEN" note in memory — all of #1–#19 are merged.
- **Obscura brainstorm + plan (LOCAL, gitignored).** `docs/brainstorms/2026-06-11-obscura-brand-and-connect-experience-requirements.local.md`
  and `docs/plans/2026-06-11-001-feat-obscura-cli-brand-plan.local.md`. First cut = `obscura connect`/`keys`/`status`
  CLI (automates the manual key+tunnel+`mcp add`+verify dance), a reactive ASCII owl mascot, and an Obscura README;
  brand rides on top of the unchanged `BGW_`/`browse-gateway`/`mcp__browse-gateway__*` plumbing.

## Decisions Made
- **Brand = Obscura** (camera-obscura optics + "obscured"/stealth; owl mascot, Athena-pantheon-adjacent). The
  technical handle (`BGW_`, image, MCP prefix) is **NOT** renamed in the first cut — experiential rename first;
  full technical rename is a deferred, staged migration (it touches the just-hardened deploy pipeline + live
  consumer re-registration).
- **Connect model = key + tunnel + register + verify** (the "Browserbase split"), reusing the operator's SSH
  trust; **no new gateway enroll/admin API** (keeps the public box's surface minimal). `obscura keys` mutates
  prod files over admin SSH; `obscura connect` is Mac-local. Literal bearer token via `claude mcp add` (avoids the
  documented env-ref verify false-negative); tunnel local port hardcoded 8080 (Host-header/allowed-hosts rule).
- **Pre-swap smoke over a live rollback drill.** Judged a full green-rollback rehearsal low-value (narrow
  scenario, prod-disruption cost); built the real-config smoke instead — it *prevents* the config-specific bad
  deploy the auto-rollback can't recover from, rather than recovering after the swap.
- **Market research → the moat is governance, not stealth.** Two cited scans confirmed: MCP-native browser tools
  are commoditized and Steel/Browserless already self-host the browser, but **no player ships owned
  navigation-allowlist policy + per-consumer auth + audit/retention** — exactly this gateway's architecture. If
  ever productized, lead with that wedge (open-core). Detail in the local brainstorm's Positioning section.

## What Didn't Work
- **Full live green-rollback drill** — staging a *clean* one needs a purpose-built gate-passing-but-verify-failing
  image or script instrumentation, and a real prod swap/rollback window; ruled out as disproportionate. The
  pre-swap smoke is the higher-value substitute (now shipped).
- **A gateway enroll/admin HTTP API for `keys`** — ruled out; adds a privileged surface to a public-IP box. SSH
  file-orchestration reuses existing trust instead.
- **Literal `-base` brand compounds** (Fetchbase/Glassbase) — avoided as derivative of the very inspiration
  (Browserbase).

## What's Next
1. **Build the Obscura first cut** — `/ce-work docs/plans/2026-06-11-001-feat-obscura-cli-brand-plan.local.md`.
   6 dependency-ordered units (CLI scaffold + owl/brand kernel → README → `keys` → tunnel module → `connect` →
   `status`), each with file paths + test scenarios.
2. **Next deploy validates PR #19 on-host.** Before the next `gh workflow run deploy-http.yml`, **re-`scp` BOTH
   `scripts/deploy/deploy-on-host.sh` and `scripts/deploy/launch-http.sh`** to `<prod-host>:~/deploy/` (static
   copies). The deploy will then run the smoke against the real config — the on-host confidence step.
3. **Optional:** the clean green-rollback rehearsal against a throwaway container/port (zero live blast radius),
   if you still want rollback proven end-to-end. Lower priority now that the smoke prevents the common case.

## Gotchas & Watch-outs
- **History was force-pushed** (the scrub rewrote `main`). Any old clone/fork diverges; the pre-rewrite objects
  linger on GitHub until GC. Recovery bundle: `~/bgw-pre-scrub.bundle`.
- **On-host `~/deploy/*.sh` are STATIC COPIES.** PR #19 changed *two* deploy scripts — re-`scp` both, or the
  smoke step does nothing on prod.
- **Tunnel LaunchAgent is active + self-disabling.** If Vault's MCP can't reach the gateway, check
  `launchctl print gui/$(id -u)/com.dvillavicencio.browse-gateway-tunnel` and
  `~/Library/Logs/browse-gateway-tunnel.log`; stop with `launchctl bootout …`. Each prod deploy recreates the
  container (~10–20s) → the tunnel drops + launchd reconnects → MCP consumers reconnect.
- **Obscura docs are gitignored `.local.md`** (they name consumers, tunnel internals, prod-admin SSH, and private
  productization/market context) — they are NOT in the repo and must not be committed or pushed to Proof.
- **Untracked `.claude/` + `AGENTS.md`** left as-is (pre-existing).
