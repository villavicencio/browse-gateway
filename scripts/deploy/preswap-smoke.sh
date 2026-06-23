#!/usr/bin/env bash
#
# preswap-smoke.sh — boot a candidate image against the REAL on-host env + consumers.json on a
# throwaway container/port, assert it comes up clean (running, restarts=0, dnsRebind=true, /mcp=401),
# then tear it down. Exit 0 = safe to swap; non-zero = ABORT, live container UNTOUCHED.
#
# Single source of truth for the pre-swap smoke, shared by:
#   - the CD deploy wrapper (deploy-on-host.sh) — passes the NEW image being deployed;
#   - the `obscura keys|vault --apply` provisioning path — passes the CURRENTLY-RUNNING image (only
#     the env file / manifest changed), so a malformed mutation is caught before it touches the live
#     container instead of crash-looping it (the documented `keys --apply` crash-loop vector).
# Both validate the exact config the live container is about to (re)read, before the swap.
#
# This catches the failure class the HTTP gate cannot: a malformed prod env var, a consumers.json
# typo, or a startup cap-assertion violation (maxSessions < consumers×perConsumerMax+1). It reuses
# launch-http.sh (the single `docker run` source) with a throwaway name/port, --restart no, and tiny
# caps, so the smoke can't self-resurrect or collide with the live container.
#
# Image to smoke (BGW_DEPLOY_IMAGE): the CD path (deploy-on-host.sh) sets it explicitly to the NEW
# digest. The `--apply` provisioning path changes only env/manifest, not the image — so leave it UNSET
# and the script defaults to the CURRENTLY-RUNNING container's image, validating the staged config
# against the live image. This lets a literal `smokeCmd=~/deploy/preswap-smoke.sh` work with no image
# plumbing in the keys/vault path.
# Config: sourced from $BGW_DEPLOY_CONFIG (default ~/browse-gateway-deploy.env) — the SAME host-local,
# uncommitted file launch-http.sh needs (sets BGW_ENV_FILE, BGW_CONSUMERS_HOST_PATH, BGW_BIND_ADDR,
# BGW_HOST_PORT, BGW_DOCKER_HOST). This file is fleet-clean — safe to commit to the public repo.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${BGW_DEPLOY_CONFIG:-$HOME/browse-gateway-deploy.env}"
[ -r "$CONFIG" ] || { echo "smoke: config not readable: $CONFIG" >&2; exit 2; }
# shellcheck disable=SC1090
. "$CONFIG"

export DOCKER_HOST="${BGW_DOCKER_HOST:-unix:///run/user/$(id -u)/docker.sock}"
CONTAINER="${BGW_CONTAINER:-browse-gateway-http}"
BIND_ADDR="${BGW_BIND_ADDR:-127.0.0.1}"
HOST_PORT="${BGW_HOST_PORT:-8080}"

# Default the image to smoke to the currently-running container's (the --apply case); the CD path
# passes BGW_DEPLOY_IMAGE explicitly so this default never fires there. Only a box with neither an
# explicit image nor a running container to derive one from is an error.
if [ -z "${BGW_DEPLOY_IMAGE:-}" ]; then
  BGW_DEPLOY_IMAGE="$(docker inspect "$CONTAINER" --format '{{.Image}}' 2>/dev/null || true)"
  [ -n "$BGW_DEPLOY_IMAGE" ] \
    || { echo "smoke: BGW_DEPLOY_IMAGE unset and no running '$CONTAINER' to derive it from" >&2; exit 2; }
fi
SMOKE_CONTAINER="${BGW_SMOKE_CONTAINER:-${CONTAINER}-presmoke}"
SMOKE_PORT="${BGW_SMOKE_PORT:-18080}"               # off 8080 (live); override if 18080 is already bound on the host
SMOKE_BOOT_TIMEOUT="${BGW_SMOKE_BOOT_TIMEOUT:-30}"  # poll seconds; a bad-config crash surfaces in 2-3s, so a generous budget only spares a slow cold boot from a false abort

# Safety net: if interrupted (CI cancel / SIGTERM) between launch and teardown, don't leave the
# throwaway smoke container holding the port + RAM. (SIGKILL can't be trapped — the launch also pins
# --restart no, so even an unkillable orphan stays inert and is reclaimed by the rm -f next run.)
trap 'docker rm -f "$SMOKE_CONTAINER" >/dev/null 2>&1 || true' EXIT

preswap_smoke() {
  docker rm -f "$SMOKE_CONTAINER" >/dev/null 2>&1 || true   # evict any stale smoke container from a prior crashed run
  # Reuse launch-http.sh (single source of truth for the `docker run`) with the REAL env + consumers
  # from the sourced config, but a throwaway name/port, --restart no, and tiny caps incl. a small shm
  # (the smoke never opens a browser session). The app reads its listen port from BGW_HTTP_PORT (not
  # BGW_HOST_PORT), so it still listens on 8080 inside; BGW_HOST_PORT only moves the host-side -p map.
  # launch-http's own `docker rm -f` is scoped to $SMOKE_CONTAINER, so the live container is never touched.
  if ! BGW_DEPLOY_IMAGE="$BGW_DEPLOY_IMAGE" BGW_CONTAINER="$SMOKE_CONTAINER" BGW_HOST_PORT="$SMOKE_PORT" \
       BGW_RESTART=no \
       BGW_CPUS="${BGW_SMOKE_CPUS:-0.5}" BGW_MEMORY="${BGW_SMOKE_MEMORY:-1g}" \
       BGW_SHM_SIZE="${BGW_SMOKE_SHM_SIZE:-256m}" \
       BGW_PIDS_LIMIT="${BGW_SMOKE_PIDS_LIMIT:-256}" "$HERE/launch-http.sh" >/dev/null; then
    echo "smoke: image failed to launch against the real config" >&2
    return 1
  fi
  # Poll up to BGW_SMOKE_BOOT_TIMEOUT seconds for the server to bind + emit its startup line; bail
  # early on a boot crash (a bad env / unparseable consumers.json / failed cap assertion shows as
  # not-running, surfacing in 2-3s — well before the budget).
  local i=0 ready=""
  while [ "$i" -lt "$SMOKE_BOOT_TIMEOUT" ]; do
    if docker logs "$SMOKE_CONTAINER" 2>&1 | grep -q 'dnsRebindProtection=true'; then ready=1; break; fi
    [ "$(docker inspect "$SMOKE_CONTAINER" --format '{{.State.Running}}' 2>/dev/null || echo false)" = "true" ] || break
    sleep 1; i=$((i + 1))
  done
  local state restarts code
  state="$(docker inspect "$SMOKE_CONTAINER" --format '{{.State.Status}}/{{.State.Running}}/{{.RestartCount}}' 2>/dev/null || echo 'missing')"
  restarts="${state##*/}"
  if [ -z "$ready" ] || ! printf '%s' "$state" | grep -q '^running/true/'; then
    echo "smoke: image did not boot clean against the real config (state=$state)" >&2
    docker logs "$SMOKE_CONTAINER" 2>&1 | tail -8 >&2 || true
    return 1
  fi
  # Connection is to the smoke port, but Host MUST equal the real bind:port the env whitelists in
  # BGW_ALLOWED_HOSTS, or the SDK's DNS-rebind Host check rejects a perfectly good image.
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 --retry 3 --retry-connrefused --retry-delay 1 \
            -H "Host: ${BIND_ADDR}:${HOST_PORT}" "http://${BIND_ADDR}:${SMOKE_PORT}/mcp" || echo 000)"
  [ "$code" = "401" ] && [ "$restarts" = "0" ] \
    || { echo "smoke: /mcp=$code restarts=$restarts (sent Host: ${BIND_ADDR}:${HOST_PORT}; a 403 means that host:port isn't in BGW_ALLOWED_HOSTS)" >&2; return 1; }
  echo "smoke: OK (real env+consumers boot clean, restarts=0, dnsRebind=true, /mcp=401)"
}

echo "smoke: pre-swap ($SMOKE_CONTAINER on ${BIND_ADDR}:${SMOKE_PORT}) image=${BGW_DEPLOY_IMAGE}"
rc=0
preswap_smoke || rc=$?
docker rm -f "$SMOKE_CONTAINER" >/dev/null 2>&1 || true   # tear down before returning, pass or fail (the EXIT trap is only the interrupted-run backstop)
exit "$rc"
