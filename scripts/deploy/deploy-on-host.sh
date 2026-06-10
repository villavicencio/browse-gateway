#!/usr/bin/env bash
#
# deploy-on-host.sh — the CD forced-command target on the prod host. The deploy SSH key is locked
# to `command="…/deploy-on-host.sh"`, so this is the ONLY thing that key can run. The requested
# image arrives as a fully-resolved digest in $SSH_ORIGINAL_COMMAND (the runner resolves tag→digest
# first, decision #5) and is strictly validated here — no arbitrary command runs.
#
# Sequence: validate digest → pull → validate-http GATE (on-host, real daemon) → capture the
# running digest for rollback → swap via launch-http.sh → verify → auto-rollback on any verify
# failure. The gate abort and rollback are non-bypassable (no flags, no skips).
#
# Fleet config is sourced from $BGW_DEPLOY_CONFIG (host-local, NOT committed); it sets the paths
# launch-http.sh needs plus BGW_BIND_ADDR/BGW_HOST_PORT for the verify curl. This file is fleet-clean.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${BGW_DEPLOY_CONFIG:-$HOME/browse-gateway-deploy.env}"
[ -r "$CONFIG" ] || { echo "deploy: config not readable: $CONFIG" >&2; exit 2; }
# shellcheck disable=SC1090
. "$CONFIG"   # sets BGW_ENV_FILE, BGW_CONSUMERS_HOST_PATH, BGW_BIND_ADDR, BGW_HOST_PORT, BGW_DOCKER_HOST, GATE_LOG

export DOCKER_HOST="${BGW_DOCKER_HOST:-unix:///run/user/$(id -u)/docker.sock}"
CONTAINER="${BGW_CONTAINER:-browse-gateway-http}"
BIND_ADDR="${BGW_BIND_ADDR:-127.0.0.1}"
HOST_PORT="${BGW_HOST_PORT:-8080}"
GATE_LOG="${GATE_LOG:-$HOME/validate-http-deploy.log}"   # ~/ not /tmp (a root-owned /tmp log false-PASSes)

# 1 — accept the digest only (forced-command boundary). The runner passes the resolved ref; the
# interactive request, if any, is in SSH_ORIGINAL_COMMAND. Reject anything that isn't our digest.
REQ="${1:-${SSH_ORIGINAL_COMMAND:-}}"
IMAGE="$(printf '%s' "$REQ" | tr -d '[:space:]')"
if ! printf '%s' "$IMAGE" | grep -Eq '^ghcr\.io/[A-Za-z0-9._/-]+@sha256:[0-9a-f]{64}$'; then
  echo "deploy: refused — expected a pinned ghcr.io/<repo>@sha256:<digest>, got: '${IMAGE}'" >&2
  exit 2
fi
echo "deploy: target = ${IMAGE}"

# 2 — pull the immutable digest (package is public → anonymous pull).
docker pull "$IMAGE"

# 3 — GATE: run the HTTP kill-gate on the pulled image in the real rootless daemon. MAX_SESSIONS is
# forced ≥3 (it false-FAILs at the inherited 2). Abort with the live container UNTOUCHED on failure.
echo "deploy: running validate-http gate → $GATE_LOG"
set +e
docker run --rm --init --shm-size="${BGW_SHM_SIZE:-1g}" \
  -e BGW_MAX_SESSIONS=3 -e BGW_PER_CONSUMER_MAX=2 \
  "$IMAGE" node scripts/validate-http.mjs >"$GATE_LOG" 2>&1
gate_rc=$?
set -e
if [ "$gate_rc" -ne 0 ]; then
  echo "deploy: GATE FAILED (exit $gate_rc) — live container left running, aborting." >&2
  tail -5 "$GATE_LOG" >&2 || true
  exit 1
fi
echo "deploy: gate PASS"

# 4 — capture the currently-running image (by ID = runnable digest) for rollback.
ROLLBACK_IMAGE="$(docker inspect "$CONTAINER" --format '{{.Image}}' 2>/dev/null || true)"
echo "deploy: rollback anchor = ${ROLLBACK_IMAGE:-<none running>}"

# 5 — swap to the new digest.
BGW_DEPLOY_IMAGE="$IMAGE" "$HERE/launch-http.sh"

# 6 — verify; on any miss, auto-rollback to the captured digest and re-verify.
verify() {
  sleep 4
  local state restarts code
  state="$(docker inspect "$CONTAINER" --format '{{.State.Status}}/{{.State.Running}}/{{.RestartCount}}' 2>/dev/null || echo 'missing')"
  docker logs "$CONTAINER" 2>&1 | grep -q 'dnsRebindProtection=true' || { echo "verify: dnsRebindProtection not true ($state)"; return 1; }
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://${BIND_ADDR}:${HOST_PORT}/mcp" || echo 000)"
  restarts="$(docker inspect "$CONTAINER" --format '{{.State.RestartCount}}' 2>/dev/null || echo '?')"
  [ "$code" = "401" ] && [ "$restarts" = "0" ] || { echo "verify: mcp=$code restarts=$restarts state=$state"; return 1; }
  echo "verify: OK (running, restarts=0, dnsRebind=true, /mcp=401)"
}

if verify; then
  echo "deploy: SUCCESS → ${IMAGE}"
  # 7 — retention: keep the newest 5 browse-gateway SHA images + the running + the rollback anchor.
  docker images 'ghcr.io/*/browse-gateway' --format '{{.ID}} {{.CreatedAt}}' \
    | sort -rk2 | awk 'NR>5{print $1}' \
    | grep -v -e "${ROLLBACK_IMAGE#sha256:}" 2>/dev/null \
    | xargs -r -n1 docker rmi >/dev/null 2>&1 || true
  exit 0
fi

echo "deploy: verify FAILED — rolling back to ${ROLLBACK_IMAGE:-<none>}" >&2
if [ -n "$ROLLBACK_IMAGE" ]; then
  BGW_DEPLOY_IMAGE="$ROLLBACK_IMAGE" "$HERE/launch-http.sh"
  if verify; then echo "deploy: ROLLED BACK to ${ROLLBACK_IMAGE}" >&2; else echo "deploy: ROLLBACK ALSO FAILED — manual intervention needed" >&2; fi
fi
exit 1
