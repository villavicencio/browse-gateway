#!/bin/sh
# Start a virtual display, then hand off to the real command.
#
# We deliberately do NOT use `xvfb-run`: as the container's main process it fails to
# exit/reap after the inner command finishes, wedging the container indefinitely and
# trapping all stdout (observed during U1 bring-up). Starting Xvfb ourselves and
# `exec`-ing the command makes the command the container process, so it exits cleanly.
set -e

: "${DISPLAY:=:99}"
export DISPLAY

# Issue #133: clear the PREVIOUS run's display state before starting Xvfb.
#
# `docker stop` / `docker start` keeps the container filesystem, so /tmp keeps the lock file and the
# socket from last time. Xvfb then refuses to start ("Server is already active for display 99") —
# while the old readiness check below happily accepted the leftover socket, so the container served
# HTTP with no display and every browser launch failed. A graceful stop was enough to set this up.
#
# Safe by construction, not by assumption: this runs as the container's first process, nothing else in
# the image starts an X server, and /tmp is not a shared mount (only /run/consumers.json and
# /run/vault are mounted in). There is no other X server whose lock this could be.
#
# The screen suffix is stripped deliberately: `${DISPLAY#*:}` yields "99.0" for DISPLAY=":99.0",
# which points at files that never exist — so a cleanup keyed off it would silently remove nothing.
display_num="${DISPLAY#*:}"
display_num="${display_num%%.*}"
rm -f "/tmp/.X${display_num}-lock" "/tmp/.X11-unix/X${display_num}" 2>/dev/null || true

Xvfb "$DISPLAY" -screen 0 "${BGW_SCREEN:-1920x1080x24}" -ac -nolisten tcp \
  >/tmp/xvfb.log 2>&1 &

# Wait for the display to be genuinely USABLE before launching anything that needs it.
#
# This used to be `[ -S "$sock" ]` — "is there a file of type socket here". A socket file outlives the
# server that created it, so that test passed against the previous run's leftover and could not tell a
# live server from a dead one. It now connects and completes the X11 handshake.
#
# NOT done by checking the Xvfb pid with `kill -0`: a SIGKILLed Xvfb becomes a zombie child of this
# script, and a zombie answers signal 0 — the same lie behind issue #131. And not with xdpyinfo/xset,
# which this image does not install.
if ! node /app/scripts/xdisplay-probe.mjs "$DISPLAY" "${BGW_XVFB_READY_TIMEOUT_MS:-10000}"; then
  echo "entrypoint: no usable X display on $DISPLAY — refusing to start" >&2
  # A non-empty log is a reliable NEGATIVE signal (Xvfb writes a Fatal server error). An empty log is
  # NOT a positive one, so it is only ever printed as a diagnostic, never trusted as health.
  cat /tmp/xvfb.log >&2 || true
  exit 1
fi

exec "$@"
