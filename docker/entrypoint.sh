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

Xvfb "$DISPLAY" -screen 0 "${BGW_SCREEN:-1920x1080x24}" -ac -nolisten tcp \
  >/tmp/xvfb.log 2>&1 &

# Wait for the X socket before launching anything that needs the display
# (DISPLAY ":99" -> /tmp/.X11-unix/X99). Racing Xvfb startup can hang the browser.
sock="/tmp/.X11-unix/X${DISPLAY#*:}"
i=0
while [ ! -S "$sock" ] && [ "$i" -lt 50 ]; do
  i=$((i + 1))
  sleep 0.1
done
if [ ! -S "$sock" ]; then
  echo "entrypoint: Xvfb did not create $sock" >&2
  cat /tmp/xvfb.log >&2 || true
  exit 1
fi

exec "$@"
