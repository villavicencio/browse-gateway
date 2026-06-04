# HANDOFF — 2026-06-04

Built and shipped **U7a — the shared HTTP MCP transport**: turned the single-consumer **stdio**
MCP server into one long-lived **Streamable-HTTP** service that many consumers dial into with
per-connection bearer auth. Ran it through a 3-lens `/critique` before coding, an in-container
kill-gate, an 11-persona `/ce-code-review` with **two rounds of fixes**, wired **CI**, and
**squash-merged PR #3 → `main` (`c9640e9`)**. Lands **dormant** — the prod cutover is a separate
deploy step, now drafted as a runbook in `CUTOVER.local.md`.

## What We Built (all on `main` via `c9640e9`)
- **`src/mcp/http-server.ts`** — `createHttpHandler(deps)`, a transport-agnostic, testable core:
  bearer → `PolicyEngine.authenticate` (single policy point, no per-surface re-implementation),
  stateful transports keyed by `mcp-session-id`, a **per-connection per-consumer `McpServer` +
  fresh `GatewayDriveController`**, per-request bearer↔session re-auth, an **MCP-session idle
  reaper** (Streamable-HTTP fires `onsessionclosed` only on explicit DELETE — a crash/SSE-drop
  doesn't), in-flight tracking so a long verb isn't reaped mid-response, DNS-rebind protection,
  and the Authorization header is never logged.
- **`src/mcp/http-main.ts`** — prod entry. Loopback-default bind (fail-closed); a **fatal**
  DNS-rebind boot guard (`dnsRebindBootError` — `BGW_ALLOWED_HOSTS` is mandatory); a **pool-sizing
  boot guard** (`poolSizingError`: `maxSessions ≥ consumers·perConsumerMax + 1`); graceful drain
  before force-close.
- **`src/policy/consumer-config.ts`** — non-secret manifest `{id,allow}[]` + per-consumer
  `BGW_CONSUMER_TOKEN_<ID>` tokens; `SecretStore.addRedactable` folds tokens into R9 redaction.
- **`GatewayDriveController`** — a promise-chain **mutex** serializing public verbs (fixes a latent
  concurrent-navigate double-open, reachable on stdio too).
- `BGW_PER_CONSUMER_MAX` config; compose documents the new (loopback/Tailnet-only) posture.
- **The stdio entry (`src/mcp/main.ts`) is unchanged** — it is the one-release rollback.
- **Tests:** 130 unit (`npm test`), typecheck clean. **In-container `validate-http.mjs` PASS 10/10**
  (two real consumers over real HTTP vs a real browser: cross-consumer 403 isolation, per-consumer
  cap across MCP sessions, off-allowlist block, disconnect-without-DELETE reaping, clean teardown).
- **CI** (`.github/workflows/ci.yml`): typecheck + unit suite on every PR + push to `main` (Node 22,
  `actions/*@v6`). PR #3 had no status checks before; now green.

## Decisions Made
- **Build the HTTP transport** (not SSH-stdio multiplexing); **provision via manifest + secret-store
  tokens**; **migrate everything to HTTP** — guarded by the kill-gate + a one-line stdio rollback.
- **Critique cut scope:** dropped hot registry-swap (restart-to-reload), `sha256(token)` keying, a
  per-consumer MCP-session cap, and a `SecretStore` enum-widening — replaced by `addRedactable`.
- **Accepted trade-offs:** shared process ⇒ shared crash domain (was per-consumer); restart-to-reload
  for consumer changes.
- **DNS-rebind made FATAL** (review): `BGW_ALLOWED_HOSTS` mandatory — MCP clients send no Origin, so
  Host validation is the load-bearing guard; `BGW_ALLOWED_ORIGINS` is additive only, never a substitute.
- **Cutover token model = shared token, one consumer, `BGW_PER_CONSUMER_MAX=2`** (private fleet, not
  public, same owner → no per-instance isolation needed; raises the cap so co-resident instances don't
  contend for one drive slot). Recorded in `CUTOVER.local.md`.

## What Didn't Work / Corrected
- **`hosts === 0 && origins === 0` boot guard** — let an origins-only config boot with Host unvalidated
  (reviewer reproduced `Host: evil.example` → 200). Fixed: `BGW_ALLOWED_HOSTS` is mandatory via a pure,
  unit-tested `dnsRebindBootError`.
- **`??=` defaulting `BGW_MAX_SESSIONS` in the gate** — didn't override an inherited `=2`, so the gate
  false-FAILed (global cap tripped before the per-consumer cap). Fixed: force `≥3` via `Math.max`.
- **`req.destroy()` on body overflow** raced the 413 response write → socket error. Removed; the
  `settled` guard absorbs the late event.
- **Earlier "Xvfb DISPLAY race — switch not parallel" cutover caveat was wrong** for the containerized
  setup: stdio and HTTP run in separate rootless containers with separate Xvfb, so they can coexist.
  Corrected in `CUTOVER.local.md`.

## What's Next
1. **U7a prod cutover** — full runbook drafted in `CUTOVER.local.md` ("U7a — HTTP transport cutover").
   You-run/I-guide. **Verify FIRST:** does the runtime support an HTTP/URL MCP server (URL + bearer)?
   That gates the wiring vs the fallbacks. Then: rebuild the image from `main`, run `validate-http.mjs`
   in the prod runtime (the deploy gate), stand up the long-lived container (host-loopback `-p`, server
   binds `0.0.0.0` inside the netns), set the mandatory `BGW_ALLOWED_HOSTS`, add the manifest entry +
   token, flip the client stdio→HTTP. Rollback = stop the HTTP container + swap the config entry back.
2. **Parked:** bump `@mozilla/readability` ≥ 0.6.0 (low-sev ReDoS GHSA-3p6v-hrg8-8qj7) as its own PR.
3. **U7:** cap tuning vs measured headroom, observability/retention, the NET_ADMIN egress sidecar.

## Gotchas & Watch-outs
- **drive↔retrieve detection parity** is still load-bearing — U7a is transport-layer and did NOT touch
  `navFailed`/`shouldEscalateDrive`. Keep it that way; change both sides together + a parity test.
- **PUBLIC repo** — never commit fleet detail (host / agent / path / vendor / pricing / exit-IP) in
  source, comments, commit messages, or this file. Fleet specifics live in gitignored
  `CUTOVER.local.md` / `CONTEXT.local.md` and agent memory.
- **In-container gate:** colima is arm64 → `--platform linux/amd64`; `--init --shm-size=1g`; don't pipe
  `docker run` through `tail` (redirect to a file); throwaway tag + cleanup. `validate:http` self-sizes
  its pool (≥3) and pins `allowedHosts` to loopback.
- **HTTP server binds `0.0.0.0` INSIDE the container** (so docker's `-p` proxy can reach it) but is only
  published on the **host loopback** (`-p 127.0.0.1:…`) — that is not a public-port regression.
- **Untracked `AGENTS.md`** is still present in the working tree — not created by these sessions; left as-is.
