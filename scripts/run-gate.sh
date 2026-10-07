#!/usr/bin/env bash
# Run one in-container gate the way CLAUDE.md prescribes, refusing first when the local amd64 handler
# is wrong (VIL-294).
#
#   scripts/run-gate.sh <image-tag> <gate-script> [extra docker run args...]
#   scripts/run-gate.sh browse-gateway:dev validate-http.mjs
#
# Why the guard: on Colima, amd64 is meant to run through Rosetta. If Rosetta fails to attach when the VM
# boots, binfmt silently falls back to QEMU user-mode, which refuses tini's PR_SET_CHILD_SUBREAPER — so
# EVERY image dies at startup with "[FATAL tini] PR_SET_CHILD_SUBREAPER is unavailable on this platform".
# That reads like a broken image or a bad change, and cost real time to diagnose
# (docs/solutions/runtime-errors/tini-s-dies-on-colima-when-amd64-silently-falls-back-from-rosetta-to-qemu.md).
# The guard checks the LIVE handler list, not dmesg: the "failed to install interpreter" boot line can
# appear even on a good boot. Other runtimes (Docker Desktop, OrbStack, native amd64) are not checked.
set -euo pipefail

if [ $# -lt 2 ]; then
  echo "usage: scripts/run-gate.sh <image-tag> <gate-script> [extra docker run args...]" >&2
  exit 2
fi
tag=$1
gate=$2
shift 2

if [ "$(docker context show 2>/dev/null || true)" = "colima" ]; then
  # Captured, then matched in-shell with no pipe — never `… | grep -q`, which can turn a match into a
  # failure under pipefail (docs/solutions/runtime-errors/grep-q-under-pipefail-fails-on-the-match-it-was-looking-for.md).
  handlers=$(colima ssh -- ls /proc/sys/fs/binfmt_misc/ 2>/dev/null || true)
  have_rosetta=no
  case $'\n'"$handlers"$'\n' in *$'\n'rosetta$'\n'*) have_rosetta=yes ;; esac
  if [ "$have_rosetta" != yes ]; then
    {
      echo "run-gate: REFUSING — Colima has no 'rosetta' binfmt handler, so amd64 would run through QEMU"
      echo "run-gate: user-mode, which refuses tini -s; every image would die at startup and look broken."
      echo "run-gate: handlers present: $(printf '%s' "$handlers" | tr '\n' ' ')"
      echo "run-gate: fix: colima stop && colima start   (then re-check: colima ssh -- ls /proc/sys/fs/binfmt_misc/)"
    } >&2
    exit 3
  fi
fi

exec docker run --rm --platform linux/amd64 --shm-size=1g --init "$@" "$tag" node "scripts/$gate"
