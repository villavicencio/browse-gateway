#!/usr/bin/env bash
# Run one in-container gate the way CLAUDE.md prescribes, refusing first when the image cannot actually
# start on this machine's amd64 handler (VIL-294).
#
#   scripts/run-gate.sh <image> <gate-script> [extra docker run args...]
#   scripts/run-gate.sh browse-gateway:dev validate-http.mjs
#
# Why the guard: every image's entrypoint is `tini -s`, which needs PR_SET_CHILD_SUBREAPER. On Colima,
# when Rosetta fails to attach at VM boot, binfmt silently falls back to QEMU user-mode, which refuses that
# prctl — so EVERY image dies at startup and looks broken
# (docs/solutions/runtime-errors/tini-s-dies-on-colima-when-amd64-silently-falls-back-from-rosetta-to-qemu.md).
#
# The guard is FUNCTIONAL, not a listing: it runs the image's own `tini -s` as linux/amd64 and refuses
# unless that succeeds. A `rosetta` entry in binfmt_misc can be present but disabled, and a listing says
# nothing about which handler actually runs amd64 (MergeWren on #158); the probe exercises exactly the
# call that fails. It works on any runtime (Colima, OrbStack, Docker Desktop, native amd64), and a probe
# that cannot run at all refuses too — fail closed.
set -uo pipefail

if [ $# -lt 2 ]; then
  echo "usage: scripts/run-gate.sh <image> <gate-script> [extra docker run args...]" >&2
  exit 2
fi
image=$1
gate=$2
shift 2

if ! probe=$(docker run --rm --platform linux/amd64 --entrypoint /usr/bin/tini "$image" -s -- true 2>&1); then
  {
    echo "run-gate: REFUSING — the image's own \`tini -s\` cannot start as linux/amd64 on this machine,"
    echo "run-gate: so every gate would die at startup and look like a broken image."
    echo "run-gate: probe output: ${probe:-<none>}"
    if [ "$(docker context show 2>/dev/null || true)" = "colima" ]; then
      echo "run-gate: Colima: amd64 is probably running through QEMU, not Rosetta. Fix: colima stop && colima start"
      echo "run-gate: then check: colima ssh -- cat /proc/sys/fs/binfmt_misc/rosetta   (expect: enabled)"
    fi
  } >&2
  exit 3
fi

exec docker run --rm --platform linux/amd64 --shm-size=1g --init "$@" "$image" node "scripts/$gate"
