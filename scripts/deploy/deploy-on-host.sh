#!/usr/bin/env bash
#
# deploy-on-host.sh — the CD forced-command target on the prod host. The deploy SSH key is locked
# to `command="…/deploy-on-host.sh"`, so this is the ONLY thing that key can run. The requested
# image arrives as a fully-resolved digest in $SSH_ORIGINAL_COMMAND (the runner resolves tag→digest
# first, decision #5) and is strictly validated here — no arbitrary command runs.
#
# Sequence: validate digest → pull → validate-http GATE (on-host, real daemon) → real-config
# pre-swap smoke (new image booted against the REAL env + consumers.json on a throwaway port) →
# capture the running digest for rollback → swap via launch-http.sh → verify → auto-rollback on any
# verify failure. The gate abort, the smoke abort, and the rollback are non-bypassable (no flags, no skips).
#
# Fleet config is sourced from $BGW_DEPLOY_CONFIG (host-local, NOT committed); it sets the paths
# launch-http.sh needs plus BGW_BIND_ADDR/BGW_HOST_PORT for the verify curl. This file is fleet-clean.
#
# REQUIRED on-host hardening — the validation below is NOT sufficient on its own; the deploy key
# MUST be locked in ~/.ssh/authorized_keys, or this script never runs and the key is a full shell:
#   command="/path/to/deploy-on-host.sh",restrict,from="<tailnet-CIDR>" ssh-ed25519 AAAA…
# (`restrict` = no-pty/-port/-agent/-X11-forwarding; `from=` confines a leaked key to the tailnet.)
# The tailnet ACL MUST scope tag:ci-deploy to this host's SSH port only, and the deploy key must be
# dedicated to this purpose. Without these, the forced-command trust boundary does not hold.
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

# 1 — accept a pinned digest of THIS PROJECT'S package only (forced-command boundary). The runner
# passes the resolved ref; the request arrives in SSH_ORIGINAL_COMMAND. Pinning the package — not
# just "some ghcr digest" — is load-bearing: a leaked key must NOT be able to deploy an arbitrary
# attacker-owned image, which would run as the live container with every BGW_* secret forwarded.
: "${BGW_EXPECTED_REPO:?set BGW_EXPECTED_REPO in the deploy config (e.g. ghcr.io/<owner>/browse-gateway)}"
REQ="${1:-${SSH_ORIGINAL_COMMAND:-}}"
IMAGE="$(printf '%s' "$REQ" | tr -d '[:space:]')"
# Structural floor: lowercase ghcr path ending in our package name + a full sha256 digest.
if ! printf '%s' "$IMAGE" | grep -Eq '^ghcr\.io/[a-z0-9._-]+/browse-gateway@sha256:[0-9a-f]{64}$'; then
  echo "deploy: refused — expected ${BGW_EXPECTED_REPO}@sha256:<64-hex>, got: '${IMAGE}'" >&2
  exit 2
fi
# Exact repo match (incl. owner) against on-host config — no foreign repo can satisfy both checks.
if [ "${IMAGE%@sha256:*}" != "$BGW_EXPECTED_REPO" ]; then
  echo "deploy: refused — repo '${IMAGE%@sha256:*}' != expected '${BGW_EXPECTED_REPO}'" >&2
  exit 2
fi
echo "deploy: target = ${IMAGE}"

# 2 — pull the immutable digest (package is public → anonymous pull).
docker pull "$IMAGE"

# 3 — GATE: run the HTTP kill-gate on the pulled image in the real rootless daemon. validate-http
# is SELF-CONTAINED — it stands up its own server and sets its OWN test config, including the
# per-consumer cap it asserts ("2nd concurrent session refused"). Pass NO BGW_* overrides: an
# injected BGW_PER_CONSUMER_MAX would let the 2nd session through and false-FAIL that check (it
# already forces MAX_SESSIONS≥3 internally). Abort with the live container UNTOUCHED on failure.
echo "deploy: running validate-http gate → $GATE_LOG"
set +e
docker run --rm --init --shm-size="${BGW_SHM_SIZE:-1g}" \
  "$IMAGE" node scripts/validate-http.mjs >"$GATE_LOG" 2>&1
gate_rc=$?
set -e
if [ "$gate_rc" -ne 0 ]; then
  echo "deploy: GATE FAILED (exit $gate_rc) — live container left running, aborting." >&2
  tail -5 "$GATE_LOG" >&2 || true
  exit 1
fi
echo "deploy: gate PASS"

# 4 — REAL-CONFIG PRE-SWAP SMOKE: the gate (step 3) runs validate-http with its OWN test config and
# NO BGW_* overrides, so it never sees the real env file or consumers.json. The likeliest bad deploy
# — a malformed prod env var, a consumers.json typo, or a startup cap-assertion violation
# (maxSessions < consumers×perConsumerMax+1) — would PASS the gate, go live, fail verify, and, being
# config- not image-specific, take the auto-rollback down with it (rollback re-launches the prior
# image against the SAME bad config). So boot the new image against the REAL env + consumers on a
# throwaway container/port FIRST and abort — live container UNTOUCHED — if it can't come up clean.
# This runs before the rollback anchor + swap, so it has the same non-bypassable, no-side-effects
# safety posture as the gate. Probe semantics mirror verify() (running, restarts=0, dnsRebind, /mcp=401).
SMOKE_CONTAINER="${BGW_SMOKE_CONTAINER:-${CONTAINER}-presmoke}"
SMOKE_PORT="${BGW_SMOKE_PORT:-18080}"               # off 8080 (live); override BGW_SMOKE_PORT if 18080 is already bound on the host
SMOKE_BOOT_TIMEOUT="${BGW_SMOKE_BOOT_TIMEOUT:-30}"  # poll seconds for startup; a bad-config crash surfaces in 2-3s, so a generous budget only spares a slow cold boot from a false abort
# Safety net: if the deploy is interrupted (CI cancel / SIGTERM) between launch and teardown, don't
# leave the throwaway smoke container holding the port + RAM. (SIGKILL can't be trapped — the launch
# below also pins --restart no, so even an unkillable orphan stays inert and is reclaimed next run.)
trap 'docker rm -f "$SMOKE_CONTAINER" >/dev/null 2>&1 || true' EXIT

preswap_smoke() {
  docker rm -f "$SMOKE_CONTAINER" >/dev/null 2>&1 || true   # evict any stale smoke container from a prior crashed deploy
  # Reuse launch-http.sh (single source of truth for the `docker run`) with the REAL env + consumers
  # from the sourced config, but a throwaway name/port, --restart no, and tiny caps incl. a small shm
  # (the smoke never opens a browser session, so it doesn't need the live 1g shm — keeps the live +
  # smoke pair within the small box's RAM during the brief overlap). The app reads its listen port
  # from BGW_HTTP_PORT (not BGW_HOST_PORT), so it still listens on 8080 inside; BGW_HOST_PORT only
  # moves the host-side -p mapping. launch-http's own `docker rm -f` is scoped to $SMOKE_CONTAINER,
  # so the live container is never touched.
  if ! BGW_DEPLOY_IMAGE="$IMAGE" BGW_CONTAINER="$SMOKE_CONTAINER" BGW_HOST_PORT="$SMOKE_PORT" \
       BGW_RESTART=no \
       BGW_CPUS="${BGW_SMOKE_CPUS:-0.5}" BGW_MEMORY="${BGW_SMOKE_MEMORY:-1g}" \
       BGW_SHM_SIZE="${BGW_SMOKE_SHM_SIZE:-256m}" \
       BGW_PIDS_LIMIT="${BGW_SMOKE_PIDS_LIMIT:-256}" "$HERE/launch-http.sh" >/dev/null; then
    echo "smoke: new image failed to launch against the real config" >&2
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
    echo "smoke: new image did not boot clean against the real config (state=$state)" >&2
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

echo "deploy: running real-config pre-swap smoke ($SMOKE_CONTAINER on ${BIND_ADDR}:${SMOKE_PORT})"
smoke_rc=0
preswap_smoke || smoke_rc=$?
docker rm -f "$SMOKE_CONTAINER" >/dev/null 2>&1 || true   # tear down before the swap, pass or fail (the EXIT trap is only the interrupted-run backstop)
if [ "$smoke_rc" -ne 0 ]; then
  echo "deploy: PRE-SWAP SMOKE FAILED — live container left running, aborting." >&2
  exit 1
fi
echo "deploy: smoke PASS"

# 5 — capture the currently-running image (by ID = runnable digest) for rollback.
ROLLBACK_IMAGE="$(docker inspect "$CONTAINER" --format '{{.Image}}' 2>/dev/null || true)"
echo "deploy: rollback anchor = ${ROLLBACK_IMAGE:-<none running>}"

# 6 — swap to the new digest.
BGW_DEPLOY_IMAGE="$IMAGE" "$HERE/launch-http.sh"

# 7 — verify; on any miss, auto-rollback to the captured digest and re-verify.
verify() {
  sleep 4
  local state restarts code
  state="$(docker inspect "$CONTAINER" --format '{{.State.Status}}/{{.State.Running}}/{{.RestartCount}}' 2>/dev/null || echo 'missing')"
  docker logs "$CONTAINER" 2>&1 | grep -q 'dnsRebindProtection=true' || { echo "verify: dnsRebindProtection not true ($state)"; return 1; }
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://${BIND_ADDR}:${HOST_PORT}/mcp" || echo 000)"
  # RestartCount is a TOP-LEVEL field ({{.RestartCount}}), NOT {{.State.RestartCount}} (which errors
  # "map has no entry"). The state line already captured it as the 3rd '/'-field — reuse that.
  restarts="${state##*/}"
  [ "$code" = "401" ] && [ "$restarts" = "0" ] || { echo "verify: mcp=$code restarts=$restarts state=$state"; return 1; }
  echo "verify: OK (running, restarts=0, dnsRebind=true, /mcp=401)"
}

if verify; then
  echo "deploy: SUCCESS → ${IMAGE}"
  # 8 — retention: keep the newest 5 project images; never the running or rollback-anchor image.
  # Full (--no-trunc) IDs so they compare equal to inspect's sha256:… refs; a glob reference filter
  # to scope to the project package; explicit skips (docker also refuses to rmi an in-use image).
  local_keep="$(docker inspect "$CONTAINER" --format '{{.Image}}' 2>/dev/null || true)"
  docker images --no-trunc --filter=reference='ghcr.io/*/browse-gateway' --format '{{.ID}} {{.CreatedAt}}' \
    | sort -rk2 | awk 'NR>5{print $1}' \
    | while read -r id; do
        [ -n "$id" ] || continue
        [ "$id" = "$local_keep" ] && continue
        [ -n "$ROLLBACK_IMAGE" ] && [ "$id" = "$ROLLBACK_IMAGE" ] && continue
        docker rmi "$id" >/dev/null 2>&1 || true
      done
  exit 0
fi

echo "deploy: verify FAILED — rolling back to ${ROLLBACK_IMAGE:-<none>}" >&2
if [ -n "$ROLLBACK_IMAGE" ]; then
  BGW_DEPLOY_IMAGE="$ROLLBACK_IMAGE" "$HERE/launch-http.sh"
  if verify; then echo "deploy: ROLLED BACK to ${ROLLBACK_IMAGE}" >&2; else echo "deploy: ROLLBACK ALSO FAILED — manual intervention needed" >&2; fi
fi
exit 1
