#!/usr/bin/env bash
#
# deploy-ref.sh — the operator's one-command deploy, run ON the prod host by a person or an agent.
# Give it a commit or a tag of THIS project's image:
#
#   deploy-ref.sh <ref>
#     <ref>  a 7-hex short sha (the tag CI pushes for every main build), a full 40-hex sha, or a tag
#            such as `latest`.
#
# It resolves the ref to the image's pinned registry digest, proves the image was built from the commit
# you named, and hands the digest to deploy-on-host.sh beside it. deploy-on-host.sh owns EVERY gate —
# validate-http, the real-config pre-swap smoke, verify, auto-rollback — and nothing here duplicates or
# bypasses them. What this adds is only what used to be manual:
#
#   - tag -> digest resolution (what the CI deploy workflow did before its SSH hop);
#   - provenance: a sha ref is refused unless the image's org.opencontainers.image.revision label is
#     that commit — a tag that moved, or a mistyped sha, cannot deploy something else. A non-sha tag
#     has nothing to check against, so its revision is reported instead;
#   - a drift NOTE when the host's copies of these scripts differ from the image's (the host copies
#     are what run; a stale one is exactly how a gate silently stops running — see VIL-134);
#   - a log follower on the OLD container, started before the swap (`docker rm` destroys its log);
#   - a /mcp prober that times the swap blip, and a short report of what is running afterwards.
#
# It never deploys on its own: it runs only when invoked. Exit status is deploy-on-host.sh's.
#
# Config: the same host-local $BGW_DEPLOY_CONFIG deploy-on-host.sh reads (default
# ~/browse-gateway-deploy.env). Optional BGW_DEPLOY_LOG_DIR (default: the directory of GATE_LOG, else
# $HOME) receives the old container's log. Fleet-clean: no host-specific literal here — safe to commit.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${BGW_DEPLOY_CONFIG:-$HOME/browse-gateway-deploy.env}"
[ -r "$CONFIG" ] || { echo "deploy-ref: config not readable: $CONFIG" >&2; exit 2; }
# shellcheck disable=SC1090
. "$CONFIG"
: "${BGW_EXPECTED_REPO:?set BGW_EXPECTED_REPO in the deploy config (e.g. ghcr.io/<owner>/browse-gateway)}"

export DOCKER_HOST="${BGW_DOCKER_HOST:-unix:///run/user/$(id -u)/docker.sock}"
CONTAINER="${BGW_CONTAINER:-browse-gateway-http}"
BIND_ADDR="${BGW_BIND_ADDR:-127.0.0.1}"
HOST_PORT="${BGW_HOST_PORT:-8080}"
if [ -n "${BGW_DEPLOY_LOG_DIR:-}" ]; then LOG_DIR="$BGW_DEPLOY_LOG_DIR"
elif [ -n "${GATE_LOG:-}" ]; then LOG_DIR="$(dirname "$GATE_LOG")"
else LOG_DIR="$HOME"; fi
DEPLOY="$HERE/deploy-on-host.sh"
[ -x "$DEPLOY" ] || { echo "deploy-ref: deploy-on-host.sh not executable beside this script: $DEPLOY" >&2; exit 2; }

REF="${1:-}"
[ -n "$REF" ] || { echo "usage: deploy-ref.sh <7-hex sha | 40-hex sha | tag>" >&2; exit 2; }
# Docker's tag charset. Also keeps the ref out of anything a shell or a format string could interpret.
if ! printf '%s' "$REF" | grep -Eq '^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$'; then
  echo "deploy-ref: refused — '$REF' is not a commit sha or an image tag" >&2
  exit 2
fi

# A sha ref is checked against the image's revision label; anything else is a tag and only reported.
EXPECT_REV=""
TAG="$REF"
if printf '%s' "$REF" | grep -Eq '^[0-9a-f]{40}$'; then
  EXPECT_REV="$REF"
  TAG="$(printf '%s' "$REF" | cut -c1-7)"   # CI tags each main build with the 7-char short sha
elif printf '%s' "$REF" | grep -Eq '^[0-9a-f]{7}$'; then
  EXPECT_REV="$REF"
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/bgw-deploy-ref.XXXXXX")"
STAGE_CID=""
FOLLOW_PID=""
PROBE_PID=""
cleanup() {
  rm -f "$TMP/probing"
  [ -n "$PROBE_PID" ] && kill "$PROBE_PID" >/dev/null 2>&1 || true
  [ -n "$FOLLOW_PID" ] && kill "$FOLLOW_PID" >/dev/null 2>&1 || true
  [ -n "$STAGE_CID" ] && docker rm -f "$STAGE_CID" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

# 1 — resolve the ref to exactly one pinned digest of THIS project's package.
SRC="${BGW_EXPECTED_REPO}:${TAG}"
echo "deploy-ref: pulling ${SRC}"
docker pull -q "$SRC" >/dev/null
# RepoDigests can list digests for other repos the same image was pulled from; keep only ours, matched
# by exact prefix (not a regex: the repo path contains dots).
DIGESTS="$(docker image inspect "$SRC" --format '{{range .RepoDigests}}{{println .}}{{end}}' \
  | awk -v p="${BGW_EXPECTED_REPO}@sha256:" 'index($0, p) == 1 && length($0) == length(p) + 64' | sort -u)"
N="$(printf '%s' "$DIGESTS" | grep -c . || true)"
if [ "$N" != "1" ]; then
  echo "deploy-ref: refused — expected exactly one ${BGW_EXPECTED_REPO}@sha256 digest for ${SRC}, found ${N}:" >&2
  printf '%s\n' "$DIGESTS" | sed 's/^/  /' >&2
  exit 1
fi
IMAGE="$DIGESTS"

# 2 — provenance. An image without a well-formed revision label cannot be proven to be any commit.
REV="$(docker image inspect "$SRC" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || true)"
printf '%s' "$REV" | grep -Eq '^[0-9a-f]{40}$' || REV=""
if [ -n "$EXPECT_REV" ]; then
  case "$REV" in
    "$EXPECT_REV"*) ;;
    *)
      echo "deploy-ref: refused — ${SRC} carries revision '${REV:-<none>}', not commit ${REF}" >&2
      exit 1 ;;
  esac
fi
echo "deploy-ref: ${REF} -> ${IMAGE} (revision ${REV:-<none>})"

# 3 — drift NOTE: the host's copies run; the image's are what the repo shipped with this build.
sha256_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
if STAGE_CID="$(docker create "$IMAGE" 2>/dev/null)" && [ -n "$STAGE_CID" ]; then
  for f in deploy-on-host.sh deploy-ref.sh; do
    if docker cp "${STAGE_CID}:/app/scripts/deploy/$f" "$TMP/$f" >/dev/null 2>&1 && [ -s "$TMP/$f" ]; then
      if [ "$(sha256_of "$TMP/$f")" != "$(sha256_of "$HERE/$f")" ]; then
        echo "deploy-ref: NOTE — host $f differs from the copy in ${REF}'s image. The host copy is what runs; if the repo has moved on, sync it from the merged commit." >&2
      fi
    fi
  done
  docker rm -f "$STAGE_CID" >/dev/null 2>&1 || true
else
  echo "deploy-ref: NOTE — could not stage the image to compare script copies (deploy continues; deploy-on-host.sh stages it again)" >&2
fi
STAGE_CID=""

# 4 — what is running now, and keep the old container's log through the swap.
echo "deploy-ref: before: $(docker inspect "$CONTAINER" --format '{{.Config.Image}} id={{.Image}} started={{.State.StartedAt}}' 2>/dev/null || echo "<no ${CONTAINER} container>")"
if docker inspect "$CONTAINER" >/dev/null 2>&1; then
  OLD_LOG="${LOG_DIR}/bgw-predeploy-$(date +%Y%m%d-%H%M%S).log"
  docker logs -f "$CONTAINER" >"$OLD_LOG" 2>&1 &
  FOLLOW_PID=$!
  echo "deploy-ref: following the old container's log -> ${OLD_LOG}"
fi

# 5 — time the blip: sample unauthenticated /mcp (401 = up; it is not logged by the gateway) twice a
# second for the whole run. The gate and smoke run first and leave the live container serving.
touch "$TMP/probing"
(
  while [ -e "$TMP/probing" ]; do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://${BIND_ADDR}:${HOST_PORT}/mcp" 2>/dev/null || true)"
    printf '%s %s\n' "$(date +%s)" "${code:-000}" >> "$TMP/probe"
    sleep 0.5
  done
) &
PROBE_PID=$!

# 6 — the deploy itself. Every gate, the swap and any rollback happen in here.
set +e
"$DEPLOY" "$IMAGE"
rc=$?
set -e

rm -f "$TMP/probing"
wait "$PROBE_PID" 2>/dev/null || true
PROBE_PID=""
[ -n "$FOLLOW_PID" ] && { kill "$FOLLOW_PID" >/dev/null 2>&1 || true; FOLLOW_PID=""; }

# 7 — report.
BLIP="$(awk '$2 != "401" { n++; if (!f) f = $1; l = $1 }
  END { if (n) printf "/mcp unavailable for ~%d s (%d failed probes, 0.5 s apart)", l - f + 1, n; else print "none observed (0.5 s sampling)" }' "$TMP/probe" 2>/dev/null || echo "not measured")"
echo "deploy-ref: ---- report ----"
echo "deploy-ref: result: exit ${rc} for ${REF} (${IMAGE})"
echo "deploy-ref: blip: ${BLIP}"
echo "deploy-ref: now: $(docker inspect "$CONTAINER" --format '{{.Config.Image}} id={{.Image}} started={{.State.StartedAt}} restarts={{.RestartCount}}' 2>/dev/null || echo "<no ${CONTAINER} container>")"
NOW_REV="$(docker image inspect "$(docker inspect -f '{{.Image}}' "$CONTAINER" 2>/dev/null)" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || true)"
echo "deploy-ref: running revision: ${NOW_REV:-<unknown>}"
BOOT="$(docker logs "$CONTAINER" 2>&1 | grep 'dnsRebindProtection' | tail -1 | grep -oE '(version|search)=[^ ]+' | tr '\n' ' ' || true)"
echo "deploy-ref: boot line: ${BOOT:-<not found>}"
exit "$rc"
