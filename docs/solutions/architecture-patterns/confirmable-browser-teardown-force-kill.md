---
title: A wedged/failed browser close must not free a capacity slot while the process is alive — confirmable teardown + force-kill
module: gateway/session-manager, browser/patchright-core, mcp/http-server
date: 2026-07-20
problem_type: architecture_pattern
component: session-lifecycle
severity: high
symptoms:
  - "A wedged or failed context.close() frees a pool slot while the Chromium process is still alive, so live browsers can exceed maxSessions/perConsumerMax"
  - "context.close() swallowing failures means a 'resolved' close is not reliable proof the process died"
  - "A hung retrieve render (untagged transient session) leaks a slot the idle reaper never reclaims"
root_cause: design_gap
resolution_type: architecture_change
issues: ["#50", "#49", "#56"]
tags: [teardown, force-kill, sigkill, process-group, patchright, chromium, session-pool, pid-reuse, graceful-shutdown]
---

## Problem

The session pool freed a capacity slot on `context.close()` *resolving* (or, worse, delete-then-close so the
slot freed before the close even ran). But `context.close()` can wedge or fail without the browser dying, so a
freed slot could coexist with a live browser — breaking the cap invariant. There was no primitive to confirm a
browser process actually died, and no way to force-kill a wedged one.

## Solution

**Free a slot ONLY on confirmed whole-process-group death** (clean close OR confirmed SIGKILL).

**Force-kill primitive** (`BrowserCore.kill`, patchright 1.60): patchright runs client+server in one Node
process, so capture the Chromium leader `ChildProcess` at launch via
`context._connection.toImpl(context)._browser.options.browserProcess.process`. Chromium spawns **detached**
(its own process-group leader), so `process.kill(-pid,'SIGKILL')` reaps the whole tree. Confirm the whole
**GROUP** is empty (`process.kill(-pid,0)`→ESRCH) — NOT the leader pid alone (leader death ≠ group empty; a
renderer can linger). Under `pids_limit=512` a freed pgid can be recycled as an unrelated group leader, so bind
signaling to the leader's `/proc/<pid>/stat` **start-time generation marker**: a non-empty group whose pid is a
group leader with a *different* start-time is a recycled group → treated as gone, never signaled. "Terminated"
uses `exitCode !== null || signalCode !== null` (a SIGKILL'd child keeps `exitCode === null`), never
`child.killed` ("signal sent" ≠ "reaped"). On Linux, `forceKillAvailable` requires the marker — a missing one
degrades loudly rather than running reuse-unsafe.

**Accounting** (`SessionManager`): counted-until-confirmed (`#sessions` holds a session until confirmed dead);
`#closing` dedupes teardown; an unconfirmed kill moves the session to a `#unconfirmed` set drained every reaper
tick by a **kill-only reconfirm** (`Session.reconfirm` — never re-runs `close()`, which post-SIGKILL resolves
instantly and would false-confirm). Shutdown drains in-flight acquires and RETAINS anything still unconfirmed
(never erases a possibly-live browser). `withSession` stamps begin/endActivity so a hung transient render is
wedge-reaped (subsumes #49).

**MCP layer** (#56, `mcp/http-server.ts`): once the gateway teardown became async-confirmed, the handler had to
stop fire-and-forgetting it. `cleanup()` is single-flight (callers share ONE dispose and await it); `closeAll`
drains in-flight cleanups CONCURRENTLY under ONE bounded deadline (`awaitBounded`) so a hung drive op (holding
the controller `#lock`) can't deadlock shutdown before `gateway.shutdown()` force-kills. Layering: the gateway
owns browser-slot confirmation; the MCP handler owns the transport/controller lifecycle and awaits
teardown-*completion*, bounded.

## Gotchas

- **A foreground awaited timer must NOT be `unref`'d** (the grace timer, the confirm poll, `awaitBounded`) — an
  unref'd one lets the event loop empty mid-`await` and the teardown hangs forever. Passes locally (other timers
  keep the loop alive), fails in CI. Cost a CI round.
- **The deploy gate (`validate-http`) catches cross-layer regressions** the unit tests and the in-container
  teardown gate miss — #56 existed because of it. It aborts with the live container left running (prod stays
  safe); diagnose, don't force.
- **Driving the MCP fire-and-forget cleanup in a unit test**: `client.close()` sends no DELETE, a TCP drop
  doesn't fire the server `onclose`, and `transport.close()` hangs with a live client. Use the client's explicit
  `transport.terminateSession()` (→ DELETE → `onsessionclosed` → cleanup).

## Verification

`scripts/validate-teardown.mjs` (in-container, real Chrome, Sections A–E: PID capture, group-leader, group-kill
→ ESRCH + zero-pgid-remaining, clean-close group-confirm, leader-dead/child-alive, malformed-restore no-orphan,
generation-marker identity) + `validate-drive` + `validate-stealth` + `validate-http`. Hardened via a 13-round
Claude↔Codex adversarial-review loop across the two PRs.
