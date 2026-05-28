---
title: xvfb-run wedges Docker containers when run as PID 1
date: 2026-05-28
category: runtime-errors
module: browse-gateway
problem_type: runtime_error
component: tooling
severity: high
symptoms:
  - "Docker container hangs indefinitely (~24 min before manual kill) with no progress"
  - "`docker logs` returns empty output despite node and Xvfb running inside the container"
  - "`docker top` shows node + Xvfb processes alive but no chrome child process spawned"
  - "Piping `docker run` through `| tail -45` produces zero output because tail only flushes on EOF that never arrives"
  - "Container never exits on its own; requires `docker kill` to terminate"
root_cause: config_error
resolution_type: config_change
related_components:
  - tooling
  - development_workflow
  - testing_framework
tags: [docker, xvfb, pid1, entrypoint, tini, chrome-headful]
---

# xvfb-run wedges Docker containers when run as PID 1

## Problem

A Docker container running headful Chrome under Xvfb hangs indefinitely with no stdout, no exit, and no visible Chrome process — despite `Xvfb` and `node` both being alive inside. Hours go into chasing emulation / anti-bot / driver hypotheses when the actual culprit is the container's entrypoint pattern.

## Symptoms

- Container runs for 24+ minutes with no output and never exits; requires `docker kill`.
- `docker logs <id>` returns empty output.
- `docker run … | tail -N` shows nothing at all.
- `docker top <id>` shows `Xvfb` and `node` running, but **no `chrome` process** ever appears.
- Inner command (the Node script, the browser launch, etc.) never produces its first log line — looks like it never started, even though the wrapper did invoke it.
- Behavior reproduces identically on native Linux and on emulated platforms (e.g. an amd64 image on Apple Silicon via Rosetta), which initially misleads toward an emulation diagnosis.

## What Didn't Work

- **Hypothesis: Chrome-under-Rosetta deadlock.** Assumed running an amd64 image on Apple Silicon through Rosetta was wedging Chrome. Disproved by an isolation harness that ran `Xvfb` + Chrome manually inside the same image with `timeout` and streamed stdout — Chrome launched and rendered a page in ~9 seconds. The platform was fine; the entrypoint wasn't.
- **Reading `docker logs <id>`.** Returned empty. The container's stdout was buffered behind the wedged `xvfb-run` shell wrapper and never flushed, so `docker logs` had nothing to show. Absence of logs was read (incorrectly) as "the process hasn't printed anything yet" rather than "the process can't flush."
- **Piping `docker run` through `| tail -45`.** `tail -N` only emits on EOF. The container never exits, so EOF never comes, so `tail` produces zero bytes — making a wedged container look indistinguishable from a silently-running one. This obscured the real symptom (buffered output trapped behind PID 1) for the entire investigation window.
- **Waiting longer.** No amount of waiting helps when PID 1 is wedged holding its child; the container will sit forever.

## Solution

Replace `xvfb-run` with a small entrypoint script that starts `Xvfb` in the background, waits for the X socket, then `exec`s the real command so it becomes PID 1 (or PID 1's direct child under `--init`).

**`docker/entrypoint.sh`** — runs as the container's entrypoint:

```sh
#!/bin/sh
# Start a virtual display, then hand off to the real command.
#
# We deliberately do NOT use `xvfb-run`: as the container's main process it
# fails to exit/reap after the inner command finishes, wedging the container
# indefinitely and trapping all stdout behind it.
set -e

: "${DISPLAY:=:99}"
export DISPLAY

# Xvfb in the background. Logs go to a file so they don't mix with the app's stdout.
Xvfb "$DISPLAY" -screen 0 "${SCREEN:-1920x1080x24}" -ac -nolisten tcp \
  >/tmp/xvfb.log 2>&1 &

# Wait for the X socket before launching anything that needs the display.
# DISPLAY ":99" maps to /tmp/.X11-unix/X99. Racing Xvfb startup hangs the browser.
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

# exec so the inner command replaces this shell and inherits PID 1 (or becomes
# tini's direct child under --init). This is what lets the container exit cleanly.
exec "$@"
```

**`docker/Dockerfile`** — wire the entrypoint in, keep `CMD` overridable:

```dockerfile
# (Install Chrome + Xvfb + xauth + your runtime above this line.)

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# ENTRYPOINT runs the display bootstrap; CMD is the default app command and
# stays overridable from `docker run … <image> <override>`.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "scripts/your-command.mjs"]
```

**`docker/compose.yaml`** — encode `init: true` and `shm_size` so the contract travels with the service definition, not the invocation site:

```yaml
services:
  app:
    build: { context: ., dockerfile: docker/Dockerfile }
    init: true        # tini as PID 1 → reaps Chrome's many children, no zombies
    shm_size: "1gb"   # headful Chrome blows past the 64MB /dev/shm default
```

**Ad-hoc run command** — always include `--init` when running outside compose:

```sh
docker run --rm --init --shm-size=1g <image> [optional command override]
```

## Why This Works

`xvfb-run` is a shell wrapper intended to be invoked interactively: it starts `Xvfb`, runs the given command, then tears `Xvfb` down. That teardown logic assumes a normal shell lifecycle — it does not behave correctly when promoted to PID 1 inside a container. As PID 1 it holds the `Xvfb` child but doesn't propagate signals or exit cleanly when the inner command returns, so the container sits forever. Worse, because PID 1 is the wrapper shell rather than the app, the app's stdout is buffered behind it and never makes it to `docker logs`. That single mistake produces the entire "no logs, no exit, no Chrome" symptom set.

The fix has three independent pieces, each load-bearing:

1. **Manual `Xvfb &` instead of `xvfb-run`** — we control the display lifecycle and don't rely on a wrapper's teardown contract.
2. **Socket-wait loop** — Chrome connects to the X server immediately on launch; if `Xvfb` isn't ready, the browser hangs or crashes nondeterministically. Polling `/tmp/.X11-unix/X<n>` until the socket exists removes the race.
3. **`exec "$@"`** — the inner command replaces the shell rather than being a child of it, so the app becomes the process the container's lifecycle is bound to. When the app exits, the container exits, and its stdout flows directly to `docker logs`.

`--init` is the fourth piece. Chrome forks aggressively (zygote, renderer, GPU, utility processes). Without an init process reaping them, exited children become zombies and accumulate; under longer-lived sessions you'll eventually exhaust the PID table. tini (injected by `--init`) reaps them transparently. Encoding `init: true` in `compose.yaml` keeps this guarantee with the service definition rather than the runbook.

## Prevention

- **Never use `xvfb-run` as a container's main process.** It is not designed to be PID 1. Use a tiny entrypoint that starts `Xvfb` in the background, waits for the X socket, and `exec`s the real command.
- **Encode `init: true` in `compose.yaml`** (and always pass `--init` for ad-hoc `docker run` invocations). Chrome spawns enough children that an unmanaged PID 1 will leak zombies; this is non-optional, not a nice-to-have. Putting it in compose means the contract travels with the service definition, not the runbook.
- **Never pipe `docker run` through `| tail -N` when debugging a possible hang.** `tail -N` waits for EOF, and a wedged container never produces one. Use `docker run -d` + `docker logs -f <id>`, or stream the container's stdout to a file you can `tail -f` independently. Silent output from a `tail` pipe is not evidence the process is silent — it's evidence you've blinded yourself.
- **When a container hangs with no output, run `docker top <id>` first, not last.** If you see `Xvfb` and `node` (or your runtime) but no `chrome`, suspect the entrypoint/PID-1 pattern before suspecting the browser, the emulation layer, or the anti-bot stack. The "platform deadlock" hypothesis is seductive and expensive; the entrypoint check is cheap and almost always right.
- **Keep Xvfb logs out of the app's stdout.** Redirect `Xvfb` to `/tmp/xvfb.log` so display-server chatter doesn't pollute the structured logs your gateway/app layer produces — and so a real app crash isn't drowned in X11 noise.
- **Don't conflate "no logs" with "no progress."** In containerized headful pipelines, missing output is almost always a flush/PID-1 problem, not a "not started yet" problem. Treat empty `docker logs` as a symptom to debug, not a state to wait out.

## Related

- The in-repo implementation of this pattern: `docker/Dockerfile`, `docker/entrypoint.sh`, and `docker/compose.yaml`.
