---
title: An apt "invalid signature" in a Docker build can be a full disk, not a GPG problem
date: 2026-08-28
category: docs/solutions/runtime-errors
module: "docker/Dockerfile, scripts/validate-*.mjs, local build environment (colima VM)"
problem_type: build_error
component: tooling
severity: high
symptoms:
  - "`docker build` fails at the `apt-get update` layer with `At least one invalid signature was encountered.`"
  - "`E: The repository ... bookworm InRelease is not signed.` for bookworm, bookworm-updates and bookworm-security alike"
  - "The build exits 100, and nothing anywhere in the output mentions disk space"
  - "Every in-container gate (`scripts/validate-*.mjs`) is blocked, because no image can be built"
  - "Host `df -h /` looks healthy while the colima VM's `/var/lib/docker` sits at 100%"
root_cause: incomplete_setup
resolution_type: environment_setup
framework_version: "colima 0.10.3, Docker Engine 29.6.1, node:22-bookworm-slim base (macOS/Apple Silicon, linux/amd64 emulation)"
related_components:
  - development_workflow
  - testing_framework
  - deployment
tags:
  - docker
  - colima
  - disk-full
  - apt
  - gpg-signature
  - build-cache
  - misleading-error
  - measure-not-reason
---

# A GPG "invalid signature" in a Docker build can be a full disk

**The tell: a cryptographic error that is actually a disk error.** `apt-get update` says the Debian
repository is unsigned. Nothing in the output mentions space. The Docker filesystem was at 100%.

## Problem

Building the browser-core image on Apple Silicon (`docker/Dockerfile:11`, `FROM
node:22-bookworm-slim`) failed at the first `apt-get` layer with a GPG signature-validation error.
The error names a trust problem; the cause was zero bytes free on the colima VM's
`/var/lib/docker`. Because `CLAUDE.md:61-66` requires every `validate-*.mjs` / `measure-*.mjs` gate
to run **only in-container**, an unbuildable image blocks all browser-side verification.

## Symptoms

Running the standard build command from `CLAUDE.md:62` — also printed in the Dockerfile header at
`docker/Dockerfile:9`:

```
docker build --platform linux/amd64 -f docker/Dockerfile -t browse-gateway:vil120 .
```

fails at the `RUN apt-get update && apt-get install ...` block at `docker/Dockerfile:18-28`:

```
#6 2.073 Err:1 http://deb.debian.org/debian bookworm InRelease
#6 2.993 W: GPG error: http://deb.debian.org/debian bookworm InRelease: At least one invalid signature was encountered.
#6 2.993 E: The repository 'http://deb.debian.org/debian bookworm InRelease' is not signed.
(same for bookworm-updates and bookworm-security)
ERROR: process "/bin/sh -c apt-get update ..." did not complete successfully: exit code: 100
```

All three suites fail identically, which is itself a hint: a genuine keyring problem usually does
not corrupt three independently-signed release files at once.

The Dockerfile carries a **second** `apt-get update` layer at `docker/Dockerfile:58-60` (the `tini`
install, kept deliberately after the Chrome layer so a PID-1 change cannot move the browser
version). A disk-full condition can therefore surface at either of two places in the same build.

Nothing in the output mentions disk space at any point.

## What Didn't Work

**Hypothesis: clock skew.** This is a genuinely common cause of signature-validity failures — a
release file has `Valid-Until`, and a container clock far enough off makes a perfectly good
signature fail verification. Under amd64 emulation on an arm64 VM there are three clocks in the
stack (host, colima VM, emulated container), so the hypothesis was reasonable rather than lazy.

It was ruled out by measuring all three rather than reasoning about them. All agreed to within five
seconds:

```
host       2026-08-28 07:37:47 UTC
colima VM  2026-08-28 07:37:48 UTC
container  2026-08-28 07:37:52 UTC
```

Skew eliminated. The next check was disk, which answered immediately.

## Solution

Find it:

```bash
colima ssh -- df -h /var/lib/docker
# BEFORE: /dev/vdb1  40G  39G  0  100% /var/lib/docker     ← zero bytes available
docker system df
# BEFORE: Images 24.72GB · Build Cache 21.23GB
```

Fix it:

```bash
docker builder prune -af      # reclaimed 21.23GB
```

After: `/var/lib/docker` went from 100% used to 62% used, ~15G available (all figures measured
during this session's diagnosis).

**Why build cache and not images.** `docker system prune -a` or an image prune would also have
freed space, but the two are not equivalent in cost:

- **Build cache is purely recomputable.** Deleting it costs one cold build and nothing else.
- **Tagged images are artifacts an operator may still want** — a previously-gated local image is
  something you can re-run a gate against or compare behaviour with. Deleting those to reclaim
  space destroys work that cannot be regenerated from the current tree.

Build cache was also where the bulk sat (21.23GB of the pressure), so the cheap option was
sufficient on its own. The price paid is a fully cold next build: every layer rebuilds, including
the Chrome `.deb` download at `docker/Dockerfile:24-25` and `npm ci` at `docker/Dockerfile:38`.

**Verification, by measurement rather than assumption.** Three steps, cheapest first:

```bash
# 1. Does apt work at all now, in the smallest possible reproduction?
docker run --rm --platform linux/amd64 debian:bookworm-slim \
  sh -c 'apt-get update >/dev/null 2>&1 && echo "APT UPDATE OK"'
# → APT UPDATE OK

# 2. Does the real image build?
docker build --platform linux/amd64 -f docker/Dockerfile -t browse-gateway:vil120 .
# → exit 0

# 3. Does a real gate run in it? (the run form from CLAUDE.md:63)
docker run --rm --platform linux/amd64 --shm-size=1g --init browse-gateway:vil120 \
  node scripts/validate-http.mjs
# → === HTTP GATE: PASS ✅ (0 failure(s), 0 note(s)) ===
```

Step 1 matters: it isolates "apt can reach and verify Debian" from "this project's Dockerfile
works," so a still-failing build after the prune would not be mistaken for a still-full disk.

**Environment where this was observed:** macOS on Apple Silicon; colima 0.10.3 with an
`aarch64` VM and virtiofs mounts; Docker Engine 29.6.1 (client 29.7.2); `linux/amd64` builds under
Rosetta emulation; `node:22-bookworm-slim` base.

## Why This Works

**The most likely mechanism** — reasoned from the evidence, not observed directly; no truncated
`InRelease` was inspected during the incident, so treat this paragraph as explanation rather than
measurement. `apt-get update` downloads each suite's `InRelease` file — a signed manifest — and hands
it to `gpgv`. With no space on the Docker filesystem, those downloads fail or are **truncated**: the
bytes that reach disk are a prefix of a valid file, or nothing at all.

`gpgv` then does exactly its job on the bytes it was given. A truncated or empty `InRelease` has no
intact detached signature block, so `gpgv` reports *"At least one invalid signature was
encountered"* — a correct cryptographic verdict about a file that was never fully written. apt
translates that into *"The repository … is not signed"* and exits 100.

Two consequences that make this hard to spot cold:

1. **The layer that fails is not the layer that filled the disk.** Whatever consumed the space —
   here, 21.23GB of accumulated build cache — may have been written days earlier by an unrelated
   build. The failing layer is simply the first one that needs to write.
2. **`ENOSPC` did not appear anywhere in the output.** The write failure is swallowed inside apt's fetch
   path and only re-emerges downstream as a verification verdict. The signal you get describes the
   *symptom's symptom*, one full layer of abstraction away from the cause.

The reason it reads as a trust failure rather than a resource failure is that the last component to
touch the broken artifact is a cryptographic one, and cryptographic components fail loudly and
specifically. The disk failed quietly, upstream.

## Prevention

**1. When a container build fails on any signature, keyring, or repository-trust error, check disk
FIRST — before touching keyrings, mirrors, or `Acquire::` options.** One command:

```bash
colima ssh -- df -h /var/lib/docker
```

Anything at or near 100% is your answer; stop investigating GPG. On Docker Desktop or a native
Linux daemon the equivalent is `df -h $(docker info -f '{{.DockerRootDir}}')`.

**Do not substitute a host `df`.** The Docker filesystem lives inside the colima VM and is a
different volume from the Mac's. Measured during this session: the Mac host reported 28G available
on `/` while the VM's `/var/lib/docker` had **zero bytes**. A green host `df` is not evidence.

**2. Know where the space went before you delete anything:**

```bash
docker system df          # Images vs Build Cache vs Volumes, with a RECLAIMABLE column
docker builder prune -af  # cache only — recomputable, safe, usually the bulk
```

Reach for `docker image prune -a` or `docker system prune -a` only after `builder prune` proves
insufficient, and only knowing it deletes gate-able artifacts you cannot regenerate from the
current tree.

**3. Capture the real exit code; never trust a pipeline's last command.** Observed in this same
episode: the build was run as a background shell command shaped like

```bash
docker build ... > log 2>&1; echo "exit=$?" >> log; tail -3 log
```

The harness reported the task as **completed, exit code 0** — because the pipeline's last command
was `tail`, which succeeded. The build's real exit code was **1**, recorded inside the log file.
Reading the harness's summary instead of the recorded status would have hidden a hard failure and
sent the session on to a gate that could not possibly run.

Two rules, both cheap:

```bash
# Make the wrapper's exit status BE the build's exit status:
docker build ... > log 2>&1; rc=$?; tail -3 log; exit $rc
```

- Put the status capture *last*, or `exit $rc` explicitly, so the reported code is the one you care
  about.
- **Read the recorded `exit=` line in the log, not the harness's task summary**, whenever a
  command was wrapped in a pipeline.

This is the exit-status face of a hazard this repo already documents in its output-visibility face:
`docs/solutions/runtime-errors/xvfb-run-wedges-container-as-pid1.md:133` — *"Never pipe `docker run`
through `| tail -N` when debugging a possible hang … Silent output from a `tail` pipe is not
evidence the process is silent — it's evidence you've blinded yourself."* Same trap, different
channel: there it swallows the output, here it swallows the status.

**4. A cheap standing guard worth adding.** As verified by grep, **no local free-space check exists anywhere in
`scripts/`, `.github/`, or `package.json` today** (the only `prune` in the tree is
`.github/workflows/ghcr-cleanup.yml`, a remote GHCR retention job, not a disk check) — the `validate:*` npm scripts
(`package.json`) go straight from `npm run build` to `node scripts/<gate>.mjs`, and nothing in the
deploy scripts checks free space either. A pre-build one-liner turns a 20-minute GPG goose chase
into a one-line message:

```bash
# Refuse to start a build with less than 5G free on the Docker filesystem.
avail=$(colima ssh -- df -BG --output=avail /var/lib/docker 2>/dev/null | tail -1 | tr -dc '0-9')
if [ -n "$avail" ] && [ "$avail" -lt 5 ]; then
  echo "REFUSING BUILD: only ${avail}G free on /var/lib/docker — run: docker builder prune -af" >&2
  exit 1
fi
```

Note the guard must fail *closed only on a real reading*: if `colima ssh` is unavailable (Docker
Desktop, a native Linux daemon, CI), `$avail` is empty and the guard skips rather than blocking a
legitimate build on a machine where the probe does not apply. Per this repo's standing rule that
*"a guard, probe or control must be able to report bad news, and you must have watched it do so"*
(`CLAUDE.md`, gates section; see
`docs/solutions/best-practices/a-test-whose-stub-guarantees-the-assertion-proves-nothing.md`), verify
this one RED by temporarily raising the threshold above current free space before keeping it — and
GREEN as well. The `if`/`fi` form above is deliberate: the terser
`[ -n "$avail" ] && [ "$avail" -lt 5 ] && { ...; }` returns **exit 1 on the healthy path**, because the
`-lt` test fails when there is plenty of space and its status becomes the list's. As the last line of a
wrapper that is the script's own status, a passing disk check would report a failed build.

**5. Prune proactively when switching build contexts.** Build cache accumulates per distinct layer
graph, so a period of Dockerfile churn — or several tags built in a row — grows it fast and
silently. `docker system df` is a cheap thing to glance at before starting a long gate session.

## Related

- `docs/solutions/runtime-errors/xvfb-run-wedges-container-as-pid1.md` — the other half of the
  "your tooling is lying to you about a container" pair; covers output visibility (`docker logs`
  empty, `| tail` swallowing a wedge) where this doc covers exit status and build-time disk.
- **No in-repo doc covers Docker-on-Apple-Silicon setup.** That material lives *outside* the repo,
  as the harness memory note `docker-headful-chrome-on-apple-silicon` (colima+Rosetta bring-up, the
  `xvfb-run` trap, `$HOME`-not-`/tmp` mount scope). That note covers **bring-up and mounts**; it
  does **not** mention disk exhaustion, build-cache growth, or apt/GPG failures — so this doc
  complements it rather than duplicating it. The `/private/tmp` mount limitation it describes is
  the same one recorded at `CLAUDE.md:65-66`.
- `docs/solutions/best-practices/measuring-browser-session-memory-needs-pss-not-docker-stats-or-rss.md`
  — same family of mistake: an instrument that answers a different question than the one you asked.
  There, `docker stats` MemUsage; here, `gpgv`'s verdict.
