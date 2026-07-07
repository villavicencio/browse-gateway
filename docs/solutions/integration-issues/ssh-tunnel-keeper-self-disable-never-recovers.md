---
title: "SSH-tunnel keeper self-disabled on transient offline and never recovered"
module: "ops/tunnel-keeper"
date: 2026-07-07
problem_type: integration_issue
component: tooling
severity: high
symptoms:
  - "Local MCP-consumer tunnel repeatedly appears down and needs a manual `launchctl bootstrap` to come back"
  - "Keeper self-ran `launchctl bootout` on itself after 10 consecutive fast ssh failures (tunnel dies < 30s)"
  - "7 self-disables logged over 3 weeks (5 in the last 10 days, during operator travel)"
  - "Transient offline conditions (DNS-resolve failure, connect-timeout on plane / hotel / captive-portal / VPN-down / laptop-wake) triggered a permanent disable"
  - "Tunnel stayed fully unloaded until a manual re-bootstrap even after the network returned; the prod gateway was healthy the whole time"
root_cause: logic_error
resolution_type: code_fix
related_components:
  - "docs/solutions/architecture-patterns/local-port-owner-verification-needs-provenance.md"
  - "docs/solutions/runtime-errors/rootless-docker-port-republish-and-remote-reach.md"
tags:
  - "ssh-tunnel"
  - "launchd"
  - "launchagent"
  - "self-healing"
  - "reconnect-backoff"
  - "reliability"
  - "mcp-consumer"
  - "keeper-script"
---

# Self-disabling SSH-tunnel keeper became a silent outage on every transient network drop

## Problem
A launchd LaunchAgent on the operator's Mac holds an SSH tunnel that maps local `127.0.0.1:8080` to the prod gateway's loopback `:8080` (over a restricted, forward-only, `permitopen`-pinned non-root key). Its keeper wrapper had a self-disable safety valve that ran `launchctl bootout` on itself after a burst of fast reconnect failures. That valve fired on ordinary travel-network offline stretches and then never came back — turning every transient DNS/timeout blip into a fully-unloaded agent that only a manual `launchctl bootstrap` could recover, and which was repeatedly misread as "the gateway is down."

## Symptoms
- The tunnel kept appearing "down" — recurring "is the gateway down?" — each incident requiring a manual `launchctl bootstrap` to bring the agent back.
- The prod gateway container was healthy the entire time: `Up N days`, 0 restarts, serving HTTP 401 in ~3ms on the loopback, actively handling live consumer sessions. A dead tunnel was being misread as a dead gateway.
- The keeper log showed 7 self-disables over 3 weeks (5 in the last 10 days, during operator travel), each preceded by 10 consecutive fast failures of two transient-offline kinds:
  - `ssh: Could not resolve hostname <prod-host>: nodename nor servname provided, or not known` (rc=255, ~0s) — DNS could not resolve (VPN/tailnet down, or the travel network's DNS).
  - `ssh: connect to host <prod-host> port 22: Operation timed out` (rc=255, ~10s = ConnectTimeout) — resolves but no route to prod:22 (plane / hotel / captive portal / restrictive WiFi).

## What Didn't Work
- **Bootstrapping by hand each time it dropped.** A treadmill, not a fix — the agent re-disabled on the very next offline stretch, so every trip generated a fresh silent outage.
- **Suspecting the gateway / container.** A red herring every time: the container was healthy on each incident. The same confusion had happened before (a supposed "Vault outage" that was really a dead tunnel).
- **The self-disable's own premise.** It optimized for "a permanently-dead VPS" (rare) at the cost of "temporary travel offline" (frequent), and offered no automatic recovery path once it went terminal. The design intent — don't reconnect-storm a permanently-dead host for months — was valid, but `launchctl bootout` fully unloaded the agent, so the intent was purchased at the price of a silent, manual-only outage.

## Solution
Rewrote the keeper so it **never boots out**. It keeps a persisted fast-fail counter, classifies the ssh error to pick a backoff cap, and applies a capped backoff — but always stays loaded so `KeepAlive` reconnects the instant prod is reachable again.

The line that was removed:

```sh
# BEFORE — terminal self-disable after MAX_FAILS consecutive fast failures:
[ "$fails" -ge "$MAX_FAILS" ] && launchctl bootout "gui/$(id -u)/$LABEL"
```

The classify + capped-backoff core that replaced it:

```sh
# Capture ssh stderr and its exit status; measure how long the tunnel held.
start=$(date +%s)
err=$(/usr/bin/ssh -N -T -L 8080:127.0.0.1:8080 "$ALIAS" 2>&1); rc=$?
elapsed=$(( $(date +%s) - start ))

if [ "$elapsed" -ge "$GRACE" ]; then          # GRACE=30s: a healthy, long-lived drop
    echo 0 > "$FAILS_FILE"                      # reset the fast-fail counter
    exit 0                                      # launchd reconnects fast via ThrottleInterval
fi

# Fast-fail path: increment the persisted counter and classify the error.
n=$(( $(cat "$FAILS_FILE" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$FAILS_FILE"

case "$err" in
    *"Could not resolve hostname"*|*"Operation timed out"*|\
    *"Network is unreachable"*|*"No route to host"*|*"Host is down"*)
        cap=60 ;;                              # transient offline: recover fast
    *"Permission denied"*|*"Connection refused"*|\
    *"remote host identification"*|*"administratively prohibited"*|*"open failed"*)
        cap=300                                # real config breakage: back off harder
        echo "*** tunnel config error (n=$n): $err" >&2
        echo "*** likely: key/user/sshd/permitopen/HostName changed" >&2 ;;
    *)
        cap=120 ;;                             # unknown: middle ground
esac

# First 3 fast-fails: rely on ThrottleInterval alone (brief blips). Then ramp.
if [ "$n" -gt 3 ]; then
    backoff=$(( (n - 3) * 15 ))
    [ "$backoff" -gt "$cap" ] && backoff="$cap"
    sleep "$backoff"
fi
exit 0                                          # NEVER launchctl bootout
```

Behavior summary:
- **Healthy drop** (`elapsed ≥ GRACE`, 30s): reset the counter and exit 0; launchd reconnects fast via `ThrottleInterval=10`.
- **Fast-fail** (`elapsed < GRACE`): increment the persisted counter, classify the ssh stderr into `offline` (cap 60s), `config` (cap 300s + a loud periodic `***` log naming likely causes), or `unknown` (cap 120s).
- **Backoff:** 0 for the first 3 fast-fails (let `ThrottleInterval` cover brief blips), then `backoff=(n-3)*15` capped at `cap`, `sleep`-ed before exit.
- **No terminal state:** `KeepAlive=true` keeps the agent loaded and retrying, so it self-heals the moment prod is reachable — no manual `launchctl bootstrap` ever needed.

## Why This Works
The original keeper conflated "temporarily offline" with "permanently broken," and picked the terminal action (`bootout`) for both. A capped backoff is not a reconnect-storm — retrying at most every ~60s while offline (or ~300s on a hard config error) preserves the original "don't hammer a dead host" intent — while remaining **loaded**, which is the property that lets it recover automatically when connectivity returns. Classifying the ssh error separates the common transient case (offline/DNS/timeout: back off gently, recover fast) from the rare real-breakage case (auth/refused/permitopen: back off harder and log loudly so a genuinely dead config stays visible), without ever crossing into a state that only a human at the keyboard can undo.

## Prevention
- **A self-disabling watchdog on a mobile/laptop client must have an automatic re-enable path.** A terminal `bootout`/disable whose only recovery is manual becomes a silent outage on the very next transient failure. Prefer capped backoff over terminal disable.
- **Distinguish transient from persistent failures before escalating.** Offline/DNS/timeout are transient and should recover fast; only persistent failures (auth denied, connection refused, `permitopen`/host-identity changes) justify aggressive backoff and loud logging.
- **When a client tunnel "looks down," verify the server independently first.** Check container status and hit a loopback health probe before touching the client — the dead-tunnel-vs-dead-gateway confusion recurred here (and once before as a phantom "Vault outage").
- **Keep a backup of the prior keeper and a documented one-line revert** so a keeper change can be rolled back instantly.
- **Verification checklist for a keeper change:** `sh -n` the script; dry-run the classifier's `case` statement against the *real* failure strings from the log; and confirm the live tunnel is undisturbed (the new logic applies on the next reconnect cycle, not mid-connection). In this change all three passed — `sh -n` clean, both real log strings classified `offline`, and the live ssh forwarder pid stayed up with new logic deferred to the next cycle.

## Related
- [`local-port-owner-verification-needs-provenance.md`](../architecture-patterns/local-port-owner-verification-needs-provenance.md) — the SAME keeper/tunnel, orthogonal concern: verifying the forwarded `:8080` port is genuinely ours (port-owner provenance) before registering a consumer token. Security posture, not resilience — cross-reference, do not merge.
- [`rootless-docker-port-republish-and-remote-reach.md`](../runtime-errors/rootless-docker-port-republish-and-remote-reach.md) — why this tunnel exists at all: reaching a loopback-published (`127.0.0.1:PORT`) rootless-Docker gateway from a remote machine via `ssh -N -L`. This keeper is what keeps that tunnel durably alive.
- No related GitHub issue (searched tunnel / launchagent / ssh — none open or closed).
