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

# The gate is promised to run as linux/amd64, the platform the probe just checked. An extra
# `--platform` would override that (MergeWren on #158), so refuse it rather than reorder and hope.
for arg in "$@"; do
  case "$arg" in
    --platform|--platform=*)
      echo "run-gate: REFUSING — extra args may not set --platform; gates always run as linux/amd64." >&2
      exit 2 ;;
  esac
done

if ! probe=$(docker run --rm --platform linux/amd64 --entrypoint /usr/bin/tini "$image" -s -- true 2>&1); then
  {
    echo "run-gate: REFUSING — the start-up probe (the image's own \`tini -s\` as linux/amd64) failed."
    echo "run-gate: probe output: ${probe:-<none>}"
    # Diagnose only what the output proves (MergeWren on #158): the QEMU-fallback advice is for tini's own
    # PR_SET_CHILD_SUBREAPER refusal, not for a missing image, a stopped daemon or any other failure.
    # tini's own fatal line, not a bare substring anywhere in Docker's output (MergeWren on #158).
    case "$probe" in
      *"[FATAL tini"*"] PR_SET_CHILD_SUBREAPER is unavailable"*)
        # The fatal line proves the prctl failed, not WHY (MergeWren on #158): name the known cause as a
        # likely one, and say how to check it, rather than asserting it.
        echo "run-gate: amd64 refuses PR_SET_CHILD_SUBREAPER here, so every gate would die at startup and look"
        echo "run-gate: like a broken image. One known cause (not established by this probe): amd64 running"
        echo "run-gate: through QEMU user-mode instead of Rosetta."
        if [ "$(docker context show 2>/dev/null || true)" = "colima" ]; then
          echo "run-gate: Colima: Rosetta may not be attached. Likely fix: colima stop && colima start"
          echo "run-gate: then check: colima ssh -- cat /proc/sys/fs/binfmt_misc/rosetta   (expect: enabled)"
        fi ;;
      *)
        echo "run-gate: the probe could not run at all (is the image built and the docker daemon up?)." ;;
    esac
  } >&2
  exit 3
fi

exec docker run --rm --platform linux/amd64 --shm-size=1g --init "$@" "$image" node "scripts/$gate"
