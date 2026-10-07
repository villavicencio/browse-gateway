---
title: tini -s dies on Colima when amd64 silently falls back from Rosetta to QEMU — check binfmt_misc, then restart Colima
date: 2026-10-06
category: docs/solutions/runtime-errors
module: docker/Dockerfile (ENTRYPOINT tini -s), scripts/validate-*.mjs, local build environment (colima VM)
problem_type: runtime_error
component: tooling
symptoms:
  - "Every current image exits at once under `docker run --rm`, or crash-loops under a restart policy (`restarting`, restarts=9 within ~40 s), before the entrypoint prints anything"
  - "`docker logs` shows only `[FATAL tini (N)] PR_SET_CHILD_SUBREAPER is unavailable on this platform. Are you using Linux >= 3.4?` (N is tini's PID)"
  - "Fails with and without `--init`; as PID 1 it reads `[FATAL tini (1)]`, although the Dockerfile comment says `-s` is a no-op as PID 1"
  - "The same image runs in production, and a gate on the same Colima daemon passed days earlier, so it looks like your change broke it"
  - "Every in-container gate (`scripts/validate-*.mjs`, deploy-script rehearsals) is blocked on the dev Mac"
root_cause: environment_divergence
resolution_type: environment_setup
severity: high
framework_version: "colima 0.10.3 (--vm-type vz --vz-rosetta), macOS 27.0, VM kernel 6.8.0-100-generic"
related_components: [development_workflow, testing_framework, deployment]
tags: [docker, colima, rosetta, qemu, binfmt-misc, tini, entrypoint, in-container-gate]
---

# tini -s dies on Colima when amd64 silently falls back from Rosetta to QEMU — check binfmt_misc, then restart Colima

## Problem

On an Apple-silicon Mac, Colima (`--vm-type vz --vz-rosetta`) normally runs amd64 code through Rosetta. When Rosetta fails to attach to the VM, Colima's QEMU user-mode handler (`qemu-x86_64`) runs amd64 code instead, and nothing tells you. QEMU user-mode refuses `prctl(PR_SET_CHILD_SUBREAPER)`. Every browse-gateway image since PR #137 (merged 2026-08-12 PT) starts with `tini -s`, which makes that call, so no image can start. Every in-container gate on the machine is then blocked: the stealth kill-gate, `validate-http`, and deploy-script rehearsals.

```dockerfile
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/usr/local/bin/entrypoint.sh"]
```

(`docker/Dockerfile:118`)

## Symptoms

- `docker logs`, or the foreground output of `docker run`, shows only this:

  ```
  [FATAL tini (7)] PR_SET_CHILD_SUBREAPER is unavailable on this platform. Are you using Linux >= 3.4?
  ```

  The number in parentheses is tini's PID: with `--init` it is not 1, because docker-init is PID 1. Without `--init` it reads `[FATAL tini (1)]`.
- Under a restart policy the container crash-loops. Booting through `launch-http.sh` showed `restarting restarts=9` within about 40 seconds. Under `--rm` it exits at once. It fails for any command: `node -e 'console.log(1)'` never runs.
- Production runs the same image fine, and an in-container gate passed on this same Colima daemon on 2026-09-30, six days before the failure. Both facts point at your own change, and both are misleading.

## What Didn't Work

- **Suspecting the rehearsal's own config.** The first sighting was a deploy-script rehearsal that crash-looped with `restarts=9`. That pattern looks like a bad env file or a failed boot assertion. `docker logs` showed the tini FATAL instead. Read `docker logs` before suspecting your config. A crash-loop counter tells you the process exits, not why it exits.
- **Dropping `--init`.** The documented gate command passes `--init`, which puts docker-init at PID 1 and makes the image's tini a nested init. Since `-s` exists for exactly that double-init case, removing `--init` looked like the fix. It is not: tini becomes PID 1 and still dies.
- **Trusting the Dockerfile comment about `-s`.** `docker/Dockerfile:107-110` says `-s` "is a no-op when tini IS PID 1". That holds for reaping, because as PID 1 tini already receives orphans. It does not hold for this failure: tini still makes the `prctl` call as PID 1 and treats a refusal as fatal.
- **Blaming Rosetta.** This was the first diagnosis, and it was wrong. An arm64-versus-amd64 control (below) proved the *translation layer* was at fault, and "translation layer on an Apple-silicon Mac" read as Rosetta. It was written into a project note and a ticket before anyone checked which handler the VM was actually using. It was QEMU. The control isolates "the translation layer"; it does not say *which* translator that is.

## Solution

### 1. Recognise it (one minute)

```sh
docker logs <container> 2>&1 | head -3          # look for [FATAL tini ... PR_SET_CHILD_SUBREAPER
colima ssh -- ls /proc/sys/fs/binfmt_misc/       # healthy: lists `rosetta`. Broken: only qemu-x86_64 / qemu-i386
colima ssh -- head -1 /proc/sys/fs/binfmt_misc/qemu-x86_64   # healthy: `disabled` (Rosetta owns amd64)
colima ssh -- sh -c 'mount | grep lima-rosetta'  # healthy: "vz-rosetta on /mnt/lima-rosetta type virtiofs"
```

When the handler list is uncertain, this control isolates the translation layer from both the kernel and this repo's image:

```sh
docker run --rm --platform linux/arm64 alpine:3.20 sh -c 'apk add -q tini && tini -s -- echo "tini -s OK"'
docker run --rm --platform linux/amd64 alpine:3.20 sh -c 'apk add -q tini && tini -s -- echo "tini -s OK"'
```

If arm64 succeeds and amd64 fails on the same VM, the kernel supports the call, so the amd64 handler is refusing it.

### 2. Fix: restart Colima

```sh
colima stop && colima start
```

Verified 2026-10-06. After the restart, `binfmt_misc` listed `rosetta`, `/mnt/lima-rosetta` was mounted, the amd64 control printed `tini -s OK`, and the image production runs booted under the gate command's `--init`: the entrypoint's X-display probe passed and `node` reported `x64`. Containers with `restart: unless-stopped` came back on their own.

Don't misread the boot log. `dmesg` (run with `sudo` inside the VM) shows `binfmt_misc: register: failed to install interpreter file /mnt/lima-rosetta/rosetta` early in **every** boot, including the good one after the restart. That is an early attempt, made before the share is mounted, and a later registration succeeds. **Check the live `binfmt_misc` list, not `dmesg`.**

### What not to do

Don't remove `-s` from the image. It would bring back the false "Tini is not running as PID 1 … zombie reaping won't work" warning on every boot under the deploy path's `--init` (the reason `-s` was added, `docker/Dockerfile:107-110`). It would also change a production property to work around a dev-VM fault.

## Why This Works

`binfmt_misc` decides which interpreter runs a foreign-architecture binary. This VM had two amd64 handlers available: Lima's `rosetta` entry, backed by the `vz-rosetta` virtiofs share at `/mnt/lima-rosetta`, and the distro's `qemu-x86_64`. In the failing state the Rosetta share was not mounted and no `rosetta` entry existed, so every amd64 binary, tini included, ran under QEMU user-mode. That emulator (a 2022 build in this VM) refuses `PR_SET_CHILD_SUBREAPER`, and tini aborts. A restart re-mounts the share and re-registers `rosetta`, and Rosetta then takes over amd64.

Production runs the same amd64 image on an Apple-silicon host under OrbStack, which also uses Rosetta, without trouble. That is consistent with the cause being QEMU rather than translation as such.

**Not established: how the handler was lost.** The VM ran about 12 days without a restart. A gate passed on it on 2026-09-30 (`validate-http`, 15/15, an image with `tini -s` under `--init`), and on 2026-10-06 amd64 was running under QEMU. The host's macOS-side Rosetta links under `/Library/Apple/usr/libexec/oah/` changed at 19:31 on 2026-09-30, after that passing run, and an update dropping the share is a plausible cause. That is timestamps lining up, not a bisection. Treat "Rosetta detaches during a long VM uptime" as something that happens, and check for it, rather than as a known mechanism.

## Prevention

- **Name the translator only after you check it.** On an Apple-silicon Mac an amd64 failure can come from Rosetta or from QEMU, and the two behave differently. `colima ssh -- ls /proc/sys/fs/binfmt_misc/` answers it in one command. An arm64-versus-amd64 control proves *a* translator is at fault, not which one.
- **A container that won't start: read `docker logs` first,** before suspecting your config or your change.
- **Before trusting a local amd64 gate result, confirm `rosetta` is registered,** especially after the VM has been up for days or the host has taken an OS update. A gate that ran under QEMU, or could not start at all, tells you nothing about the code under test. A cheap guard that refuses to run an amd64 gate when `rosetta` is missing is tracked in VIL-294.
- **A comment calling a flag a "no-op" covers the behaviour it describes, not the system calls behind it.** When a flag is described as harmless in some case, check whether it still makes a call that can fail in that case.
- **Re-check every place gates run after any PID-1 or entrypoint change.** PR #137 changed the entrypoint. The documented gate command kept working until the platform under it changed.

## Related Issues

- VIL-294: the ticket for this failure. The restart fix is verified; it remains open for how the handler got lost and for the guard.
- VIL-293: an arm64 image, which would remove translation from local runs altogether.
- PR #137: introduced `tini -s` as the image's PID 1 (issue #131, piece 2).
- PR #148 (open as of 2026-10-06): its deploy-script rehearsal was first blocked by this failure and ran after the Colima restart. It also corrects the project `CLAUDE.md` gate note.
- [xvfb-run wedges the container as PID 1](xvfb-run-wedges-container-as-pid1.md): the earlier PID-1 and entrypoint problem that produced the current `entrypoint.sh`.
- [An apt "invalid signature" in a docker build can be a full disk](apt-invalid-signature-in-docker-build-can-be-a-full-disk.md): another local-Colima failure that blocks every in-container gate while looking like something else.
- Project `CLAUDE.md`, "Gates and measurement": the in-container-only rule and the note about this failure (added in PR #148).
