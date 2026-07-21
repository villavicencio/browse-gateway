# HANDOFF — 2026-07-20, evening

Continuation of the site-compat hardening epic (#38). Picked up on `/dv:pickup` → operator said
**"go on #50"** (the confirmable-teardown + force-kill debt split from #46 during Wave 1). Ran the
full ultracode pipeline — parallel research, an adversarial critique panel, implementation in an
isolated worktree, in-container runtime gates, and an 8-round Claude↔Codex adversarial-review loop —
then merged and **deployed #50 to prod**. The #50 deploy gate then caught a real cross-layer
regression, which became **follow-up PR #56** (5 more Codex rounds) — also merged and deployed.

**Prod now runs main `580b1ad`** (image `sha256:86ba92ac…`): #50 (PR #55) + the #56 follow-up.
Deploy gate → smoke → verify all green; rollback anchor recorded. Tree clean, `main == origin/main`,
no open PRs.

## What shipped

- **#50 — confirmable browser teardown + force-kill (PR #55, squash `b9fd004`).** A capacity slot now
  frees ONLY on CONFIRMED whole-process-group death (clean close OR confirmed SIGKILL). Closes the gap
  where a wedged/failed close freed a slot while Chrome was still alive (live processes could exceed the
  caps). New force-kill primitive (`BrowserCore.kill`): capture the Chromium leader PID + ChildProcess
  at launch via patchright's in-process `toImpl` bridge; SIGKILL the process **group** (detached
  group-leader) + leader; confirm the whole **group** is empty (`kill(-pid,0)`→ESRCH), reuse-safe via a
  `/proc` start-time **generation marker** (`pids_limit=512` makes pgid recycling real). Counted-until-
  confirmed accounting + a `#unconfirmed` set drained by a KILL-ONLY reconfirm (single-flight); shutdown
  coordination (drains in-flight acquires, retains unconfirmed); transient hung renders wedge-reaped
  (subsumes #49, now CLOSED). New surfaces: `computeForceKillAvailable`, `SessionManager.unconfirmedCount`,
  `SessionInfo.forceKillAvailable`. **635 unit tests**; new in-container gate `scripts/validate-teardown.mjs`
  (Sections A–E) + `validate-drive` + `validate-stealth` (CF 2/2, DataDome 2/2) all green.
- **#56 — MCP reaper/shutdown must await (bounded) the async teardown #50 introduced (squash `580b1ad`).**
  Caught by the #50 deploy gate: after #50 made the gateway teardown async-confirmed, the MCP handler was
  fire-and-forgetting the gateway teardown (via `transport.onclose → void cleanup`), so `reapIdle`/`closeAll`
  returned before the browser slot was reclaimed → `validate-http` failed (gate aborted safely; prod never
  broke). Fix in `src/mcp/http-server.ts`: `cleanup()` single-flight so callers share ONE dispose and
  actually await the teardown; `closeAll` drains in-flight cleanups CONCURRENTLY under ONE bounded deadline
  (`awaitBounded`, `cleanupAwaitMs`) so a hung drive op can't deadlock shutdown (gateway.shutdown() then
  force-kills), never compounds N×, and is rejection-safe.

## Decisions made

- **Design hardened by an adversarial critique panel BEFORE coding** — it caught 2 invariant violations in
  the first design (a self-heal retry that could false-free a slot; an unreachable-untagged-transient leak),
  both fixed by the `#unconfirmed` kill-only reconfirm. Higher-signal than a generate-and-judge panel here.
- **Group-based confirm, not leader-based** (Codex r3): leader death ≠ group empty (a renderer can linger).
- **Reuse-safe via `/proc` generation marker** (Codex r5); on Linux force-kill requires it (Codex r6) — a
  missing marker degrades loudly rather than running reuse-unsafe.
- **Correct layering** (Codex r2, #56): the gateway (`#unconfirmed` + its reaper + `gateway.shutdown()`)
  owns browser-slot confirmation/retention; the MCP handler owns transport+controller lifecycle and awaits
  teardown-*completion*, bounded. It does NOT duplicate the gateway's accounting.
- **Follow-ups filed, not crammed in** (operator precedent — complete-if-it-finishes-your-change, else track):
  **#53** (wire `forceKillAvailable`/`unconfirmedCount` into an operational health surface / `obscura status`),
  **#54** (acquire-side hung-factory-launch `#reserved` leak — pre-PID, unkillable via #50). Also tracked:
  per-browser cgroup kill; routing a restore-cleanup unconfirmed-kill into manager `#unconfirmed`;
  http-main `closeAll()` vs the drive-controller `#lock` (now mitigated by the bound).

## What didn't work

- **A wedged-close teardown test hung in CI** — the `graceTimer` (Session.teardown escalation trigger) was
  `unref`'d, so the event loop emptied before it fired → teardown hung forever. Passed locally (other timers
  kept the loop alive), failed in CI. Fix: a foreground awaited timer (grace timer, confirm poll) must NOT be
  unref'd. **CI caught it — trust the pipeline.**
- **Driving the MCP fire-and-forget cleanup deterministically in a unit test** — `client.close()` doesn't send
  a DELETE, a TCP drop doesn't fire the server transport `onclose`, and `transport.close()` hangs with a live
  client. The working trigger is the client's explicit `transport.terminateSession()` (sends the DELETE →
  `onsessionclosed` → cleanup).

## What's next

1. **Wave 2** of epic #38: `#40` (WAF + CAPTCHA vendor fingerprinting — add DataDome to `classifyBlock`) →
   `#41` (failure-class taxonomy), then `#42/#43/#44` → `#45` → `#47` → `#48`. The #39 diagnostics envelope
   is LIVE; its pre-declared slots are ready to fill. See `docs/plans/2026-07-17-001-...local.md`.
2. **#53 / #54** (the #50 follow-ups above) when convenient.
3. `feat/teardown-confirmation-wip` (the old #50 starting point) is now obsolete (#50 shipped) — safe to
   delete when the operator wants. `feat/fresh-exit-warm` is unrelated/pre-existing.

## Gotchas & watch-outs

- **Prod runs `580b1ad`** (image `86ba92ac`). Deploy flow unchanged: merge → **ci.yml** builds+pushes GHCR
  `latest` from main → `gh workflow run deploy-http.yml -f image_tag=latest` → on-host gate (`validate-http`)
  → real-config pre-swap smoke → swap → verify → rollback. **Deploy `docker rm -f` = immediate SIGKILL** (the
  SIGTERM/gateway.shutdown() path never runs in a deploy; the container namespace reaps Chrome). The
  authoritative shutdown path matters for manual `docker stop` and the Mac CLI (`vault-host.ts`).
- **The deploy gate (`validate-http`) catches cross-layer regressions the unit tests + the in-container
  teardown gate miss.** #56 existed because of it. When it aborts, prod stays safe — diagnose, don't force.
- **In-container gates**: `colima start`; build ONE `browse-gateway:gate` base image; then the **overlay trick**
  (`docker build FROM browse-gateway:gate` with `COPY dist scripts`) — bind-mounts fail because colima's
  default VM doesn't share `/private/tmp`. Run with `--init` (matches prod `init:true`) for the
  zero-pgid-remaining reaping check. **colima was brought up for the gates then stopped** (restored to prior
  state) — `colima start` for future gates; the `gate50` overlay image was removed.
- **Foreground timers in the teardown/cleanup path must NOT be `unref`'d** (grace timer, confirm poll,
  `awaitBounded`) — an unref'd one lets the loop empty mid-await and hangs the teardown.
- **`git pull --ff-only origin main` before committing** — local main goes stale after a GitHub-side merge.
- Force-kill mechanics reference: `~/Obsidian/browse-gateway/memory/force-kill-teardown-mechanics.md`.
