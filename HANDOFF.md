# HANDOFF — 2026-06-05

**U7a prod cutover COMPLETE.** Both consumer instances of the prod runtime are migrated from the
single-consumer **stdio** MCP launcher to the shared **Streamable-HTTP** transport. stdio is
retired but left on disk (launcher + image + config backup) as the one-release rollback. U7a
itself was built and merged 2026-06-04 (PR #3, `c9640e9`); this session executed the deploy.

## Cutover, as executed (you-run/I-guide)
- **Verified the runtime speaks native HTTP MCP** — it supports a url + bearer-header MCP server,
  so the native path was used (no stdio↔HTTP bridge fallback needed).
- Built the amd64 image from `main` (`--provenance=false --sbom=false` for a clean single-arch
  image), loaded it into the prod rootless daemon, and **passed the in-container `validate-http`
  gate (10/10)** against the real runtime — the deploy kill-gate.
- Stood up the **long-lived HTTP container**, host-loopback-published, conservative caps
  (`--cpus=1.5 --memory=3g --shm-size=1g` — dialed down from the runbook's 4g/1.75 given the
  box's headroom; revisit under real load). Boot log confirmed manifest parse, pool sizing at the
  floor (`maxSessions ≥ consumers·perConsumerMax + 1`), datacenter escalation armed, and
  DNS-rebind protection on.
- Registered the HTTP MCP entry (url + bearer), enabled it, cut **both** consumer instances over,
  and verified `retrieve` + `drive` end-to-end over HTTP, authed per-consumer.

## Cutover gotchas discovered (read before the next runtime-MCP cutover)
- **The runtime stores the bearer as an env-var reference (`${...}`) expanded at request time.**
  The MCP-client CLI's *inline* connect-test (run during `add`) executes in a process whose env
  was loaded **before** the key was written, so `${...}` stays literal and the test
  **false-negatives with a 401**. Trust a **fresh** standalone `test` (a new process loads the
  updated env and expands correctly) and the runtime itself — not the add-time inline test. ~An
  hour was lost chasing this as an auth/scheme bug; it was always a stale-env false negative.
- **A failed inline test saves the entry DISABLED** — after the fresh-process test passed, the
  entry still had to be flipped `enabled: true`.
- **The bearer value to enter is the RAW token** (no `Bearer ` prefix) — the client adds the
  scheme; the server requires `Authorization: Bearer <token>`.
- Full named/fleet-specific runbook + these gotchas live in `CUTOVER.local.md` (gitignored).

## Found during verification (NOT fixed — queued)
- **`retrieve` burns the full ~20s clearance timeout on legitimately short pages** (<200 chars
  body). Root-caused to the `isCleared` text-length gate in `render()`'s clearance loop;
  pre-existing and transport-agnostic (stdio had it too), so not a cutover regression. Diagnosis +
  the non-obvious CF-mid-reload constraint:
  `docs/solutions/runtime-errors/retrieve-short-page-clearance-timeout.md`. Fix planned (Proof:
  *Plan: 2026-06-05 retrieve short-page clearance fix*).
- **`retrieve` on a rich page (Wikipedia) once timed out + reported blocked while `navigate` got
  it in 3.1s** — a *separate* transient in `render()`'s `goto`/navigation handling (a silent catch
  leaves `status` null → reported blocked), not the length gate. Re-test; investigate if reproducible.

## What's Next
1. **retrieve short-page clearance fix** — own PR (`/critique` → `/ce-code-review` → CI), with a
   drive↔retrieve **parity test**. See the Proof plan + the solution doc above. Rebuild image →
   redeploy the HTTP container → re-run `validate-http` + `validate-stealth` in-container → confirm
   a short-page retrieve is now fast.
2. **Investigate the Wikipedia `render().goto` transient** (above) — re-test first.
3. **Parked:** bump `@mozilla/readability` ≥ 0.6.0 (low-sev ReDoS GHSA-3p6v-hrg8-8qj7) as its own PR.
4. **U7:** cap tuning vs measured `docker stats` headroom (now that it's live — watch a real
   2-concurrent-session load before raising), observability/retention, the NET_ADMIN egress sidecar.
5. **Cleanup when stable:** remove the rollback backups (config + `.env` `.bak-*`) once U7a is
   confirmed for a release.

## Gotchas & Watch-outs
- **drive↔retrieve parity** is load-bearing — and item #1 (the retrieve clearance fix) touches
  exactly this seam. Change `render()` (retrieve) and `navigate()` (drive) together + a parity test.
- **PUBLIC repo** — never commit fleet detail (host / agent / path / vendor / pricing / exit-IP) in
  source, comments, commit messages, or this file. Fleet specifics live in gitignored
  `CUTOVER.local.md` / `CONTEXT.local.md` and agent memory. (Proof plan/doc share-links carry
  tokens — reference them by title here, never paste the token URL.)
- **HTTP container caps are conservative** (1.5 cpu / 3g) — watch `docker stats` under a real
  2-concurrent-session load before trusting or raising them.
- **In-container gate:** colima is arm64 → `--platform linux/amd64`; build with
  `--provenance=false --sbom=false` for a clean single-arch image that `docker load`s cleanly on
  the prod daemon; `--init --shm-size=1g`; redirect `docker run`/logs to a file (don't pipe through
  `tail`); throwaway tag + cleanup.
- **Untracked `AGENTS.md`** is still present in the working tree — not created by these sessions; left as-is.
