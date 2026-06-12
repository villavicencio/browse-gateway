---
title: docker restart cannot activate env-file changes — container env is frozen at create
module: docker/deploy
date: 2026-06-12
problem_type: runtime_error
component: deployment
severity: high
symptoms:
  - "A consumer token appended to the on-host env file never authenticates after `docker restart` — the container still serves the old token set"
  - "Worse interleaving: the bind-mounted consumers.json IS re-read on restart, so the restarted gateway boots the NEW manifest against the OLD env, hits the fail-closed missing-token check, exits 1, and `--restart unless-stopped` crash-loops it — downing every consumer"
  - "Liveness probes (401 at /mcp) cannot distinguish a real reload from a stale-env no-op"
root_cause: config_error
resolution_type: workflow_improvement
related_components:
  - deployment
  - authentication
tags: [docker, docker-restart, env-file, rootless-docker, consumer-provisioning, crash-loop, restart-to-reload]
---

# docker restart cannot activate env-file changes

## Problem

The gateway's consumer registry is built at boot from two on-host files: the bind-mounted
`consumers.json` manifest and the `BGW_*` env file. The deploy launcher (`launch-http.sh`)
passes env into the container **by name at `docker run` time** (`-e NAME` after sourcing the
env file). "Restart-to-reload" is the documented consumer-change model — but the two files
reload **differently**:

- **File bind-mounts are re-resolved at container start** → a restarted container sees the
  new `consumers.json`.
- **Container env is frozen at `docker create`** → `docker restart` replays the ORIGINAL env;
  the new `BGW_CONSUMER_TOKEN_<ID>` line is invisible.

So after staging a new consumer and running `docker restart`:
new manifest + old env → `buildConsumerSpecs` throws `missing bearer token for consumer <id>`
(fail-closed by design) → `http-main` exits 1 → the `unless-stopped` restart policy crash-loops
the gateway for **all** consumers. There is no interleaving where `docker restart` activates
the new token.

## Resolution

"Reload" for consumer changes means **re-create the container** (the launch script path —
`docker rm -f` + `docker run`, which re-sources the env file), never `docker restart`.

In `obscura keys --apply` this is enforced structurally (`src/cli/keys.ts`):

1. `--apply` requires an operator-configured on-host re-create command (`applyCmd` config key /
   `OBSCURA_APPLY_CMD`); without it the CLI refuses and stages, rather than faking a reload.
2. After the re-create, liveness (poll `/mcp` → 401) is necessary but NOT sufficient — the CLI
   additionally confirms the change landed *inside* the new container:
   `docker exec <container> printenv BGW_CONSUMER_TOKEN_<ID> >/dev/null` (exit code only, the
   value never leaves the container) — present after `new`, absent after `revoke`.

## Prevention

- Treat "the container reads X at boot" as two separate questions: *boot of the process*
  (restart is enough) vs *boot of the container config* (env, mounts, caps — needs re-create).
- Any "apply"/"reload" automation that edits an env file must verify activation in-container,
  not just service liveness.
- Caught pre-merge by an adversarial review pass on PR #20; the original implementation used
  `docker restart` and would have crash-looped prod on first use.
