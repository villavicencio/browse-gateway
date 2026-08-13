#!/usr/bin/env bash
#
# launch-http.sh — (re)create the browse-gateway HTTP container on a rootless Docker host.
# Single source of truth for the `docker run`, shared by the manual runbook and the CD deploy
# wrapper (deploy-on-host.sh). Fleet-clean: every host-specific value arrives via env, never a
# literal — safe to commit to the public repo.
#
# Required env:
#   BGW_DEPLOY_IMAGE        image ref to run — a digest (ghcr.io/<owner>/browse-gateway@sha256:…)
#                           in CD; may be a local tag (browse-gateway:latest) for a manual run.
#   BGW_ENV_FILE            path to the on-host env file (the `export BGW_*=…` secrets/config).
#   BGW_CONSUMERS_HOST_PATH host path to consumers.json (mounted read-only at the container path
#                           the env file's BGW_CONSUMERS_MANIFEST points to).
# Optional env (sensible defaults; override per host):
#   BGW_VAULT_HOST_PATH     host path to the persistent vault dir (entries + the 0600 master key),
#                           bind-mounted READ-WRITE at /run/vault. Set this to activate the credential
#                           vault (U9 warm-open); the env file's BGW_VAULT_DIR + BGW_VAULT_KEY_FILE must
#                           then point UNDER /run/vault (e.g. /run/vault/entries, /run/vault/kek).
#                           Unset → no mount, vault stays dormant (a no-op for non-vault hosts).
#   BGW_DOCKER_HOST         DOCKER_HOST for the rootless daemon (default: unix:///run/user/$(id -u)/docker.sock)
#   BGW_CONTAINER           container name (default: browse-gateway-http)
#   BGW_BIND_ADDR           host bind address (default: 127.0.0.1 — loopback only; never 0.0.0.0)
#   BGW_HOST_PORT           host port (default: 8080)
#   BGW_CPUS / BGW_MEMORY / BGW_PIDS_LIMIT / BGW_SHM_SIZE   resource caps
#                           (defaults: 1.75 / 4g / 512 / 1g — matches the tuned live container)
#   BGW_RESTART             docker restart policy (default: unless-stopped; the pre-swap smoke uses 'no'
#                           so a throwaway container can't self-resurrect if a deploy is interrupted)
set -euo pipefail

: "${BGW_DEPLOY_IMAGE:?set BGW_DEPLOY_IMAGE (image digest or tag to run)}"
: "${BGW_ENV_FILE:?set BGW_ENV_FILE (path to the on-host env file)}"
: "${BGW_CONSUMERS_HOST_PATH:?set BGW_CONSUMERS_HOST_PATH (host path to consumers.json)}"

export DOCKER_HOST="${BGW_DOCKER_HOST:-unix:///run/user/$(id -u)/docker.sock}"
CONTAINER="${BGW_CONTAINER:-browse-gateway-http}"
BIND_ADDR="${BGW_BIND_ADDR:-127.0.0.1}"
HOST_PORT="${BGW_HOST_PORT:-8080}"

[ -r "$BGW_ENV_FILE" ] || { echo "launch-http: env file not readable: $BGW_ENV_FILE" >&2; exit 1; }
[ -r "$BGW_CONSUMERS_HOST_PATH" ] || { echo "launch-http: consumers.json not readable: $BGW_CONSUMERS_HOST_PATH" >&2; exit 1; }

# Load the secrets/config, then forward EVERY BGW_* var by name (pass-by-name picks up the
# sourced values). Listing names — not values — keeps secrets out of argv and the process table,
# and avoids hardcoding consumer IDs in this committed file (new consumers are forwarded automatically).
set -a
# shellcheck disable=SC1090
. "$BGW_ENV_FILE"
set +a
env_args=()
while IFS='=' read -r name; do
  case "$name" in BGW_*) env_args+=(-e "$name") ;; esac
done < <(compgen -v)

# Optional credential-vault mount (U9). MUST come AFTER sourcing BGW_ENV_FILE above — that file is where
# BGW_VAULT_HOST_PATH is defined; reading it earlier mounts a stale/empty value (or nothing) and the key
# file ends up missing inside the container (the smoke would fail with /run/vault/kek ENOENT). When set,
# bind-mount the persistent vault dir (entries + the 0600 master key) READ-WRITE at /run/vault — the
# gateway writes entries on capture, and the key file's owner-only perms are preserved from the host
# (loadVaultKey refuses a group/world-readable key). Unset → no mount; the vault stays dormant.
vault_args=()
if [ -n "${BGW_VAULT_HOST_PATH:-}" ]; then
  [ -d "$BGW_VAULT_HOST_PATH" ] || { echo "launch-http: BGW_VAULT_HOST_PATH is not a directory: $BGW_VAULT_HOST_PATH" >&2; exit 1; }
  vault_args+=(-v "${BGW_VAULT_HOST_PATH}:/run/vault")
fi

echo "launch-http: (re)creating ${CONTAINER} on ${BIND_ADDR}:${HOST_PORT} from ${BGW_DEPLOY_IMAGE}"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

docker run -d --name "$CONTAINER" \
  --restart "${BGW_RESTART:-unless-stopped}" --init \
  --cpus="${BGW_CPUS:-1.75}" --memory="${BGW_MEMORY:-4g}" --memory-swap="${BGW_MEMORY:-4g}" \
  --pids-limit="${BGW_PIDS_LIMIT:-512}" --shm-size="${BGW_SHM_SIZE:-1g}" \
  -p "${BIND_ADDR}:${HOST_PORT}:8080" \
  -v "${BGW_CONSUMERS_HOST_PATH}:/run/consumers.json:ro" \
  ${vault_args[@]+"${vault_args[@]}"} \
  "${env_args[@]}" \
  "$BGW_DEPLOY_IMAGE" node dist/mcp/http-main.js

# Issue #131: report what is actually reaping in this container.
#
# TWO SEPARATE CHECKS, because they answer different questions and one cannot substitute for the other:
#
#  1. PID 1's identity — what is reaping RIGHT NOW. Read from the process table, not from HostConfig,
#     because `--init` and a baked ENTRYPOINT are different mechanisms and only /proc knows which took
#     effect.
#  2. Whether the IMAGE carries tini. `--init` is hard-coded on the docker run above, so /proc/1/comm
#     is always `docker-init` on this path and check 1 CANNOT see a missing tini — it would print the
#     happy line for an image with no init baked in at all. This script can still deploy an older
#     image tag that predates piece 2, and the defense-in-depth layer silently disappearing is exactly
#     what check 2 exists to notice.
#
# Both WARN rather than fail: while `--init` is on the run command above, reaping still works even with
# no tini in the image, so a missing tini is a lost safety layer, not an outage.
sleep 1
pid1="$(docker exec "$CONTAINER" cat /proc/1/comm 2>/dev/null | tr -d '\n' || true)"
case "$pid1" in
  tini|docker-init)
    echo "launch-http: PID 1 is ${pid1} — orphan reaping active"
    ;;
  "")
    echo "launch-http: WARNING could not read /proc/1/comm (container not up yet?) — verify reaping manually" >&2
    ;;
  *)
    echo "launch-http: WARNING PID 1 is '${pid1}', not a known reaping init." >&2
    echo "launch-http:   Exited browser children will accumulate as zombies, the teardown confirmation" >&2
    echo "launch-http:   will never confirm, and the session pool will saturate with zero live browsers." >&2
    echo "launch-http:   See issue #131. Expect tini (baked into the image) or docker-init (--init)." >&2
    ;;
esac

if docker exec "$CONTAINER" test -x /usr/bin/tini 2>/dev/null; then
  echo "launch-http: image carries /usr/bin/tini — reaping survives a run without --init"
else
  echo "launch-http: WARNING this image has no /usr/bin/tini — it predates issue #131 piece 2." >&2
  echo "launch-http:   Reaping currently depends ENTIRELY on the --init flag on the docker run above." >&2
  echo "launch-http:   Any other creation path (a hand-written docker run) will wedge the pool." >&2
fi
