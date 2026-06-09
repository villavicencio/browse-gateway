---
title: Rootless Docker port re-publish fails with "address already in use"; reach a loopback-published container via SSH tunnel, not a second -p
module: docker/deploy
date: 2026-06-09
problem_type: runtime_error
component: container-networking
severity: medium
symptoms:
  - "docker run fails: 'failed to set up container networking: driver failed programming external connectivity … failed to bind host port 127.0.0.1:PORT/tcp: address already in use'"
  - "The failure repeats on retry right after a successful `docker rm -f` of the previous container — nothing else is obviously using the port"
  - "`ss -ltn` in the shell shows the port FREE, yet the next `docker run` still fails to bind it"
  - "Attempting to publish the same container port to two host IPs (`-p 127.0.0.1:PORT:PORT -p <other-ip>:PORT:PORT`) fails on the loopback bind"
  - "`systemctl --user restart docker` fails with 'Failed to connect to bus: No medium found'"
  - "A failed `docker run` leaves a container in `Created` state that still holds the --name"
root_cause: config_error
resolution_type: workflow_improvement
related_components:
  - rootlesskit
  - systemd-user
tags: [rootless-docker, rootlesskit, port-publish, address-already-in-use, ssh-tunnel, remote-consumer, systemd-user, container-networking, xdg-runtime-dir]
---

# Rootless Docker port re-publish fails with "address already in use"; reach a loopback-published container via SSH tunnel

## Context

The gateway runs as a **rootless Docker** container owned by a non-root service user (uid 1000),
publishing its HTTP port on host loopback (`-p 127.0.0.1:PORT:PORT`) — a long-lived, single-port,
loopback-only deployment. Two tasks collided during a redeploy: recreating the container to pick up
a config change, and trying to expose the same port on a second host IP so a **remote** consumer
could reach it directly. Both ran into rootless-specific networking behavior that wasted a recovery
cycle and briefly took the live service down.

## Symptoms

- `docker run` → `failed to bind host port 127.0.0.1:PORT/tcp: address already in use`, **immediately
  after** a `docker rm -f` of the only container that used the port.
- A `sleep 3` + `ss -ltn | grep :PORT` reported the port **free**, yet the very next `docker run`
  failed to bind it (false "free").
- Publishing the same container port to **two** host IPs in one `docker run` failed on the loopback
  bind.
- `systemctl --user restart docker` → `Failed to connect to bus: No medium found`.
- Each failed `docker run` left a `Created` (never-started) container holding the `--name`, so the
  next run would have hit a name conflict if not removed first.

## What didn't work

- **`docker rm -f` + immediate re-run.** `rm -f` returning does **not** guarantee rootlesskit has
  released the published-port forward. The new run races the lingering forward and loses with
  `address already in use`.
- **Trusting `ss`/`netstat` to confirm the port is free.** In rootless mode the published-port
  forward is held by **rootlesskit** in its own network namespace, not the shell's. A plain
  `ss -ltn` in the service user's login shell cannot see it, so it reports the port free when it is
  not. The only authoritative test is whether `docker run` actually binds.
- **`systemctl --user restart docker` from a bare shell.** It needs the user-systemd bus, which
  requires `XDG_RUNTIME_DIR` (and `DBUS_SESSION_BUS_ADDRESS`) to be set. Without them it fails
  `No medium found` and the daemon is **not** restarted — so the stuck forward is never cleared and
  the bind keeps failing.
- **Publishing the same container port to two host IPs (`-p loopback:PORT -p other-ip:PORT`).**
  Failed repeatedly on the loopback bind. (Not fully isolated from the concurrent stuck forward, so
  treat this as "unreliable on rootless," not a proven hard limit — but the tunnel below avoids the
  question entirely.)

## Solution

**To clear a stuck rootless port forward, restart the rootless daemon properly:**
```sh
export XDG_RUNTIME_DIR=/run/user/<uid>
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/<uid>/bus
systemctl --user restart docker
systemctl --user is-active docker        # expect: active
docker rm -f <name>                      # remove the leftover Created container holding the name
```
Then re-run with the **single, proven loopback publish** (`-p 127.0.0.1:PORT:PORT`). The bind
succeeds once the forward is actually gone.

**To reach a loopback-published rootless container from a remote machine, use an SSH tunnel — not a
second `-p`:**
```sh
ssh -N -L PORT:127.0.0.1:PORT <permitted-user>@<host>
```
The `-L` forward terminates on the host's `127.0.0.1:PORT`, where rootlesskit's builtin port driver
binds the published port in the **host** netns — so it is reachable by the SSH session regardless of
which user authenticated (the publishing service user need not be an allowed SSH login). Keep the
client-side local port equal to the remote port so the `Host` header still matches the gateway's
allowed-hosts list (DNS-rebind guard).

## Why this works

- Rootless port publishing is a **rootlesskit forward**, decoupled from the container lifecycle and
  from the shell's namespace. `docker rm -f` tears down the container faster than rootlesskit
  reconciles the forward; restarting the rootless daemon is what deterministically clears it.
- `ss` "free" is a **namespace false-negative** — the forward lives where the shell can't see it.
- The SSH tunnel keeps the container **loopback-only** (no port exposed on any external/overlay
  interface), which is the safer posture on a public host, and sidesteps the dual-publish problem
  altogether: there is only ever one `-p`, on loopback.

## Prevention

- After `docker rm -f`, **don't trust `ss` and don't immediately re-run**. If a re-publish fails with
  `address already in use`, restart the rootless daemon (with `XDG_RUNTIME_DIR` set) to clear the
  forward, then run.
- For **remote reach** to a loopback-published rootless service, default to an **SSH tunnel** (or an
  overlay-network proxy that preserves the `Host` header), not a second host-IP `-p`.
- When scripting a rootless restart, **always export `XDG_RUNTIME_DIR=/run/user/<uid>`** first, or
  `systemctl --user` fails `No medium found`.
- A failed `docker run` leaves a `Created` container holding the name — `docker rm -f <name>` before
  every retry.
