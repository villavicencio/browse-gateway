---
title: Reaping a PID-less detached process by a gateway-owned, per-launch unique filesystem key
date: 2026-07-23
category: docs/solutions/architecture-patterns
module: gateway/orphan-sweep
problem_type: architecture_pattern
component: session-lifecycle
severity: high
applies_when:
  - "A subprocess can be spawned by an async launch that NEVER RESOLVES, so no post-resolve PID/handle capture (the #50 primitive) can ever reach it"
  - "You must reap that process without a handle, and account for it against a capacity cap in the meantime"
  - "The process embeds a launch-scoped argument you control (e.g. a profile/data dir) that no other process can carry"
tags: [process-reaping, session-manager, capacity, toctou, proc, chromium, orphan]
---

## Problem (#54 Part 2)

`launchPersistentContext` that never settles leaves a possibly-live Chromium with **no context and no PID**
— #50's force-kill (post-resolve `toImpl` capture) cannot reach it. Part 1 freed the reserved *slot*; the
*process tree* leaked until container restart, and the ephemeral profile dir leaked on every SIGKILL too.

## The key idea: make the process findable by a key you own

The gateway **mints the ephemeral profile dir itself** (`mkdtemp`, unique per launch) and passes it as
`--user-data-dir=<dir>`. That argument is on Chromium's cmdline, and the mkdtemp-unique path is a key
**only this launch's processes can carry** — so a `/proc/<pid>/cmdline` scan (plus cwd/fd references into
the dir, for argless crashpad-shaped survivors whose marker-carrying parent already died) finds the whole
tree with no handle. Reuse the #50 discipline on top: group-SIGKILL, confirm via the `/proc` start-time
**generation marker** (a recycled pid/pgid reads as gone).

## Truthful capacity: count the orphan, don't hide it

The reaped-but-unconfirmed launch is a **live-orphan ledger entry counted in `activeCount`** (and the
per-consumer cap) until confirmed dead — `activeCount` may transiently exceed `maxSessions` (the honest
state after a replacement took the freed slot), and the admission gate **back-pressures** rather than
stacking live browsers past the cap. A still-*pending* launch whose scan is empty can't be finalized (it
may spawn later), so it parks on a **bounded, uncounted watch list**: slot freed, dir retained + re-swept,
a late spawn killed within a tick, a late resolve re-counts, a settled (resolved/rejected) launch's
confirm finalizes.

## The hard part was the concurrency, not the mechanism (13 Codex rounds)

Every round found a distinct **TOCTOU / accounting** hole, all in the same class — "an error path or a
race frees capacity or removes the dir over a still-live process," or "a live process drops out of
accounting." The durable lessons:

- **Re-validate ownership immediately before every destructive syscall.** A scan→signal gap under a small
  pid space can recycle a pgid; re-read the marker/generation right before `kill(-pgrp, SIGKILL)`.
- **Confirm the whole GROUP, not the marker-carriers.** An argless renderer/crashpad with no marker
  survives a marker-only rescan — confirm via `kill(-pgrp, 0)` + generation, and carry **owed group
  stamps across retry attempts** (a fresh scan alone false-confirms once the leader dies).
- **Fail CLOSED on a scan-side error.** ENOENT/ESRCH = vanished, EACCES = foreign — skip; but
  EMFILE/EIO is *our* failure to observe — propagate it (reject → retry, orphan retained) rather than
  read every process as "exited" and false-confirm.
- **Stamp one representative per GROUP (leader-preferred), before the kill.** A per-pid ledger keeps
  non-leader entries whose recycle check can never fire, pinning a reclaimed group forever.
- **Coordinate the two reclaim paths.** A late-resolve teardown and an in-flight dir sweep can both own
  the record — defer settlement to whichever holds the verdict; never finalize ahead of an outstanding
  sweep, and resume a deferred settlement even when that sweep *rejects*.

## Residual (documented, scoped out per ROI)

A 4-deep precondition stack (same-profile pgid reuse in the stamp history + non-leader-only discovery + a
transient stat failure at the generation refresh + a SIGKILL survivor) can still misread a live reused
group as recycled. Bounded by the container's `pids_limit`/namespace teardown; a clean fix needs
seed-path refresh surgery. A parentless sandboxed renderer (no dir reference, no marker) is likewise a
documented residual — nothing to find it by.

## References

PR #72 (`9baaf0c`), issue #54, epic #38. Gate proof: `validate-teardown.mjs` Section F (real headful
Chromium reaped by dir alone). Builds on [[force-kill-teardown-mechanics]] (#50). The health surface
that exposes `orphanCount`/`watchedCount` is #53 (PR #73).
