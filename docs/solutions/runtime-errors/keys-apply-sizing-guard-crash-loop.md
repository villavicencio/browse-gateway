---
title: "`keys --apply` can crash-loop the gateway — the Nth consumer trips the MAX_SESSIONS floor"
module: cli/keys, docker/deploy
date: 2026-06-16
problem_type: runtime_error
component: deployment
severity: high
symptoms:
  - "`obscura keys new <c> --apply` adds a consumer, then `✗ gateway did not come back healthy within 60s of the re-create`"
  - "Container is `restarting` (restarts climbing), `/mcp` returns `000` — EVERY consumer is down, not just the new one"
  - "Logs repeat: `fatal: BGW_MAX_SESSIONS=<n> is too low for <k> consumer(s): need >= <k*perConsumerMax+1>`"
root_cause: config_error
resolution_type: workflow_improvement
related_components:
  - deployment
  - authentication
  - session-pool
tags: [docker, consumer-provisioning, crash-loop, max-sessions, pool-sizing, pre-swap-smoke, keys-apply, fail-closed]
---

# `keys --apply` can crash-loop the whole gateway on the Nth consumer

## What happened
Provisioning a new consumer with `obscura keys new <new> --apply` took the **entire gateway down** —
both the new consumer and the existing, untouched ones. The apply reported `✗ gateway did not come
back healthy within 60s of the re-create`; the container was crash-looping with:

```
fatal: BGW_MAX_SESSIONS=5 is too low for 3 consumer(s): need >= 7 (= 3 × perConsumerMax 2 + 1 retrieve headroom)
```

## Root cause — two things compounding
1. **The pool-sizing boot guard is a hard floor:** `BGW_MAX_SESSIONS ≥ consumers·perConsumerMax + 1`.
   The env was set to `5`, exactly right for **2** consumers (2×2+1). Adding a **3rd** consumer
   raised the floor to `7`; `5 < 7` → the guard fails **closed** (`exit 1`), and
   `--restart unless-stopped` turns that into a crash loop. The fail-closed is correct — it's
   refusing to run undersized — but it takes all consumers with it.
2. **`keys --apply` had no pre-swap smoke at the time.** It re-created the live container directly
   via `launch-http.sh`. The `deploy-on-host.sh` CD path boots the candidate against the **real env +
   consumers.json on a throwaway port FIRST** and aborts the swap on any failure — that smoke would
   have caught this config before touching the live container. The `keys` apply path skipped it and
   swapped straight into the crash loop. **This gap has since been closed — see Prevention.**

So a config-level mistake (env not bumped for the new consumer count) that the CD pipeline is
specifically built to catch went straight to a live outage because provisioning uses a different,
smoke-less re-create.

## Fix / recovery
Get back to a consumer count the configured `BGW_MAX_SESSIONS` satisfies, then re-create. If the
new consumer isn't needed yet (e.g. it was a rename and the old id can go), revoking back to the
prior count clears the floor:

```
node dist/cli/obscura.js keys revoke <id> --apply
# ✓ gateway healthy after re-create — BGW_CONSUMER_TOKEN_<ID> retired
```

If you actually need the higher consumer count, raise `BGW_MAX_SESSIONS` in the on-host env file to
`≥ consumers·perConsumerMax + 1` first, mind the box's RAM (each session is a headful Chrome), then
re-create.

## Prevention
- **Pre-flight the floor before any `keys new --apply`.** The new consumer count and `perConsumerMax`
  are known; read `BGW_MAX_SESSIONS` from the env file and refuse (or warn loudly) when the mint
  would push the count past `(MAX_SESSIONS − 1) / perConsumerMax`. This is the real product gap —
  `keysNew` should not be able to stage a config that the boot guard will reject.
- ✅ **DONE — `keys --apply` now runs the same pre-swap smoke** (PR #26, merged 2026-06-23).
  `scripts/deploy/preswap-smoke.sh` is the single source of truth for it, shared by the CD wrapper
  (`deploy-on-host.sh`, which passes the NEW image) and the `obscura keys|vault --apply` path (which
  passes the CURRENTLY-RUNNING image, since only env/manifest changed). `preswapSmoke()` runs before
  the re-create — `src/cli/keys.ts:148`, inside `applyRecreate`. A malformed env or manifest,
  including an undersized `BGW_MAX_SESSIONS` floor, now aborts the apply with the live container
  untouched.
  **Caveat — the smoke is conditional on `smokeCmd` being configured.** With it unset the apply warns
  loudly and proceeds unsmoked (`src/cli/keys.ts:105-109`), which is the pre-#26 behaviour. An
  operator config without `smokeCmd` still carries the exposure this doc describes.
- Regardless: treat `keys new --apply` as a deploy. When adding the consumer that crosses a
  `perConsumerMax` boundary, bump `BGW_MAX_SESSIONS` in the same change.

## See also
- `docs/solutions/runtime-errors/docker-restart-cannot-activate-env-file-changes.md` — why apply must
  re-create, not restart (the reason `keys --apply` runs `launch-http.sh` at all).
- `scripts/deploy/preswap-smoke.sh` — the shared real-config pre-swap smoke, now run by both the CD
  path (`deploy-on-host.sh` step 4) and `keys|vault --apply`.
- `docs/solutions/best-practices/comparing-image-id-to-manifest-digest-is-not-a-drift-check.md` —
  corrects a later misreading of this doc. `--apply` re-creates the container against a deliberately
  **unchanged** image, so it is not a code deployment; reading it as one led to a wrong conclusion
  about production drift.
