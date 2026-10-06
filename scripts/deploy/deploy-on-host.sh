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

# The post-swap verify budget (step 7), validated HERE — before the pull, the gate, or the swap. An
# unusable value (0, "abc", "2.5") would make verify's loop run zero times and report failure, so the
# deploy would roll back a healthy image and the rollback's verify would fail the same way. A typo in
# config must be refused while the live container is still untouched. Whole seconds, 1..600; leading
# zeros are stripped before the range check so "007" is 7 and a long digit string cannot overflow it.
VERIFY_TIMEOUT="${BGW_VERIFY_TIMEOUT:-30}"
case "$VERIFY_TIMEOUT" in
  *[!0-9]*) VERIFY_TIMEOUT="" ;;
  *) VERIFY_TIMEOUT="${VERIFY_TIMEOUT#"${VERIFY_TIMEOUT%%[!0]*}"}" ;;
esac
if [ -z "$VERIFY_TIMEOUT" ] || [ "${#VERIFY_TIMEOUT}" -gt 3 ] || [ "$VERIFY_TIMEOUT" -gt 600 ]; then
  echo "deploy: refused — BGW_VERIFY_TIMEOUT must be whole seconds in 1..600, got '${BGW_VERIFY_TIMEOUT}'" >&2
  exit 2
fi

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

# 4 — REAL-CONFIG PRE-SWAP SMOKE, SOURCED FROM THE IMAGE BEING DEPLOYED (VIL-134).
#
# What it catches: the gate (step 3) runs validate-http with its OWN test config and NO BGW_*
# overrides, so it never sees the real env file or consumers.json. The likeliest bad deploy — a
# malformed prod env var, a consumers.json typo, or a startup cap-assertion violation (maxSessions <
# consumers×perConsumerMax+1) — would PASS the gate, go live, fail verify, and, being config- not
# image-specific, take the auto-rollback down with it. So boot the new image against the REAL env +
# consumers on a throwaway container/port FIRST and abort — live container UNTOUCHED — if it can't
# come up clean. Runs before the rollback anchor + swap, same non-bypassable posture as the gate.
#
# WHY IT IS EXTRACTED FROM THE IMAGE RATHER THAN RUN FROM $HERE: a gate must travel with the code it
# gates. This step used to be an inline copy of the smoke living in this file. The repo hardened the
# smoke (a well-formed `version=` assertion on the boot line); the host kept running its own older
# function; the new assertion never executed in production, while CI stayed green and the repo looked
# gated. Three copies of the smoke existed and prod ran the stalest. THIS FILE is the deploy key's
# forced command, so it is the one piece that cannot travel with the image — which is exactly why
# everything it can delegate to the image must be delegated. Any future hardening of
# scripts/deploy/preswap-smoke.sh is then live on the very next deploy with no host sync at all.
#
# FAIL CLOSED: an image that does not carry the smoke aborts the deploy. A missing gate must never
# read as a passing one — that is precisely the failure this change exists to end.
#
# Extraction uses `docker create` + `docker cp`, NOT `docker run ... cat`: create starts no process,
# so pulling the script out of the image never executes image code, and it does not depend on the
# image shipping a `cat`.
SMOKE_IN_IMAGE="/app/scripts/deploy/preswap-smoke.sh"
# A DIRECTORY, not a bare temp file. The extracted smoke is placed in it alongside a copy of the
# host's launch-http.sh, which is what makes this safe to install ahead of the matching image:
# a smoke predating VIL-134 does not know BGW_LAUNCH_SCRIPT and resolves "$HERE/launch-http.sh"
# instead — "$HERE" being wherever we put it. Without a launcher beside it, deploying any older
# image (a manual redeploy, a rollback to a pinned digest) would abort at the smoke with a
# confusing "launcher not executable". Both old and new smokes now find the same host launcher.
SMOKE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/bgw-preswap.XXXXXX")"
SMOKE_TMP="$SMOKE_DIR/preswap-smoke.sh"
SMOKE_ERR="$SMOKE_DIR/create.err"
LAUNCH_TMP="$SMOKE_DIR/image-launch-http.sh"   # the IMAGE's launcher, for the drift NOTE only
SMOKE_CID=""
cleanup_smoke() {
  [ -n "$SMOKE_CID" ] && docker rm -f "$SMOKE_CID" >/dev/null 2>&1 || true
  rm -rf "$SMOKE_DIR"
}
trap cleanup_smoke EXIT

# Capture stdout ONLY. This daemon prints warnings ("WARNING: IPv4 forwarding is disabled") to
# stderr, and folding them into the container id with 2>&1 would hand an unusable ref to `docker cp`
# and then to `docker rm`, leaking the staged container on every deploy.
if ! SMOKE_CID="$(docker create "$IMAGE" 2>"$SMOKE_ERR")" || [ -z "$SMOKE_CID" ]; then
  echo "deploy: refused — could not stage ${IMAGE} to extract the pre-swap smoke:" >&2
  tail -3 "$SMOKE_ERR" >&2 || true
  SMOKE_CID=""
  exit 1
fi
if ! docker cp "${SMOKE_CID}:${SMOKE_IN_IMAGE}" "$SMOKE_TMP" >/dev/null 2>&1; then
  echo "deploy: refused — image does not carry ${SMOKE_IN_IMAGE}; the pre-swap smoke cannot run." >&2
  exit 1
fi
if [ ! -s "$SMOKE_TMP" ]; then
  echo "deploy: refused — ${SMOKE_IN_IMAGE} extracted EMPTY from the image; refusing to deploy ungated." >&2
  exit 1
fi
# Same staged container: pull the image's launcher too, for the drift NOTE below. Best-effort — an
# image without it is not a reason to refuse a deploy, unlike the smoke.
docker cp "${SMOKE_CID}:/app/scripts/deploy/launch-http.sh" "$LAUNCH_TMP" >/dev/null 2>&1 || true
docker rm -f "$SMOKE_CID" >/dev/null 2>&1 || true
SMOKE_CID=""
chmod +x "$SMOKE_TMP"

# The host launcher, beside the extracted smoke, under the name a pre-VIL-134 smoke looks for.
# New smokes take it via BGW_LAUNCH_SCRIPT below; old ones find it as "$HERE/launch-http.sh".
# Either way it is the HOST's launcher — the one step 6 will use for the real swap.
cp "$HERE/launch-http.sh" "$SMOKE_DIR/launch-http.sh"
chmod +x "$SMOKE_DIR/launch-http.sh"

# Provenance in the deploy log, so a stale or unexpected gate is VISIBLE rather than silently absent.
echo "deploy: pre-swap smoke sourced from image:${SMOKE_IN_IMAGE} sha256=$(sha256sum "$SMOKE_TMP" | cut -c1-16)"

# Drift NOTE on the launcher. The host owns launch-http.sh — step 6's swap runs the host copy, so the
# smoke must boot the candidate with that same launcher (see BGW_LAUNCH_SCRIPT in preswap-smoke.sh)
# and the image's copy goes unused. A divergence is therefore not dangerous, but it does mean the repo
# has moved on; report it rather than let it rot invisibly the way the smoke did. Not fatal: if the
# smoke actually needs a knob the host launcher lacks, it fails closed on its own.
if [ -s "$LAUNCH_TMP" ]; then
  IMG_LAUNCH="$(sha256sum "$LAUNCH_TMP" | cut -d" " -f1)"
  HOST_LAUNCH="$(sha256sum "$HERE/launch-http.sh" 2>/dev/null | cut -d" " -f1 || true)"
  if [ -n "$HOST_LAUNCH" ] && [ "$IMG_LAUNCH" != "$HOST_LAUNCH" ]; then
    echo "deploy: NOTE — host launch-http.sh differs from the image's copy (host $(printf %.12s "$HOST_LAUNCH") vs image $(printf %.12s "$IMG_LAUNCH")). The host copy is authoritative for the swap; the repo has moved on." >&2
  fi
fi

echo "deploy: running real-config pre-swap smoke"
if ! BGW_DEPLOY_IMAGE="$IMAGE" BGW_DEPLOY_CONFIG="$CONFIG" BGW_LAUNCH_SCRIPT="$HERE/launch-http.sh" "$SMOKE_TMP"; then
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
#
# POLL, don't take one look after a fixed sleep (VIL-291). This used to be `sleep 4` and a single
# check, tuned on a native host. On a slower host — an amd64 image under binary translation boots
# measurably slower — a healthy image is still starting at the 4 s mark: verify fails, the deploy rolls
# back a good image, and the rollback's own one-shot verify can fail the same way, ending in "ROLLBACK
# ALSO FAILED" with nothing actually wrong. The pre-swap smoke already polls (30 s); this matches it.
# Polling costs nothing on a fast host — it returns on the first passing check.
#
# What does NOT get the benefit of the wait: a container that has restarted, or is not running. Those
# will not heal by waiting, so they fail at once — the poll must not turn a fast failure into a slow one.
#
# The budget (VERIFY_TIMEOUT, validated at the top) is ONE wall-clock deadline covering the sleeps AND
# the /mcp probe: each probe's --max-time is capped to what is left, so a stalled probe cannot stretch
# a 30 s verify to 4x that. The attempt count is also capped, as a second bound that holds even if the
# clock does not advance.
#
# CHECK FIRST, sleep only BETWEEN attempts. Sleeping before the first check let the smallest budget
# (1 s) spend itself on the sleep and exit having inspected nothing — so a healthy image was rolled back
# and the rollback's verify failed the same way. The first attempt therefore always runs, whatever the
# budget; `continue` lands on the between-attempts bound below, never on an unbounded loop.
verify() {
  local polls=0 start=$SECONDS left state="" restarts="" code="000" logs
  while :; do
    if [ "$polls" -gt 0 ]; then
      left=$((VERIFY_TIMEOUT - (SECONDS - start)))
      { [ "$polls" -lt "$VERIFY_TIMEOUT" ] && [ "$left" -ge 1 ]; } || break
      sleep 1
    fi
    polls=$((polls + 1))
    left=$((VERIFY_TIMEOUT - (SECONDS - start)))
    [ "$left" -ge 1 ] || left=1   # whatever remains, an attempt's probe gets at least 1 s
    state="$(docker inspect "$CONTAINER" --format '{{.State.Status}}/{{.State.Running}}/{{.RestartCount}}' 2>/dev/null || echo 'missing')"
    # RestartCount is a TOP-LEVEL field ({{.RestartCount}}), NOT {{.State.RestartCount}} (which errors
    # "map has no entry"). The state line captures it as the 3rd '/'-field — reuse that.
    restarts="${state##*/}"
    case "$state" in
      running/true/0) ;;
      *) echo "verify: container not healthy (restarts=$restarts state=$state)"; return 1 ;;
    esac
    # Capture, THEN match. `docker logs | grep -q` is wrong under pipefail: grep -q exits at the first
    # match, the still-writing docker CLI dies of SIGPIPE, and the pipeline reads as FAILED on exactly
    # the poll that found the marker — every poll, once the log outgrows a pipe buffer.
    logs="$(docker logs "$CONTAINER" 2>&1)" || continue
    case "$logs" in *dnsRebindProtection=true*) ;; *) continue ;; esac
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time "$(( left < 3 ? left : 3 ))" "http://${BIND_ADDR}:${HOST_PORT}/mcp" || echo 000)"
    if [ "$code" = "401" ]; then
      echo "verify: OK after $((SECONDS - start))s, attempt ${polls} (running, restarts=0, dnsRebind=true, /mcp=401)"
      return 0
    fi
  done
  echo "verify: timed out after ${VERIFY_TIMEOUT}s (mcp=$code restarts=$restarts state=$state)"
  return 1
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
