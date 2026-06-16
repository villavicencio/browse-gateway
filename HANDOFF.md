# HANDOFF — 2026-06-16

Continued straight from the 2026-06-12 Obscura merge to run the deferred manual E2E of the CLI
against the real fleet. Used the CLI's `keys` lifecycle to rename the remote consumer to its
public codename **Vault** — which exposed a real outage path, recovered it, documented the
learning, and scrubbed a fleet-hygiene leak introduced mid-session.

> Fleet detail (real consumer id, prod host, the Vault agent's project volume path, the resume
> command) stays in agent memory + gitignored `*.local.md` — never this file (PUBLIC repo).
> "Vault" is the public-safe consumer codename; "Obscura" is the CLI brand.

## What We Built / Did
- **Created `~/.config/obscura/config.json`** (local, gitignored) — the CLI's required fleet
  config. Key choice: `adminSsh` uses the **non-root `node@` destination**, not root (a root-owned
  `0600` env file would be unreadable by the rootless `node` Docker stack, and `node` makes the
  `DOCKER_HOST` rootless-socket default resolve). `applyCmd` sources the on-host deploy env and
  re-runs `launch-http.sh` pinned to the **currently-running image** via `docker inspect {{.Image}}`.
- **Verified the `keys` staged round-trip** (no prod mutation): `keys new vault` → `keys list`
  (showed all consumers incl. the staged Vault) → `keys revoke vault`.
- **Renamed the remote consumer → Vault, fleet-side (DONE, healthy):** minted the Vault key, and
  after the outage below, `keys revoke <old-id> --apply` landed the gateway clean. Live state:
  manifest + env carry **Vault + the on-box consumer only**; the Vault token is consistent across
  the prod env file and the macOS Keychain (service `obscura`). Gateway `running`, restarts=0,
  `/mcp`=401.
- **Re-synced both deploy scripts** (`deploy-on-host.sh`, `launch-http.sh`) to the prod host's
  `~/deploy/` — closes the prior handoff's item #2 (PR #19's pre-swap smoke was a no-op on prod
  until this).
- **New solution doc** `docs/solutions/runtime-errors/keys-apply-sizing-guard-crash-loop.md`
  (committed `3fdad4e`) — the crash-loop learning, scrubbed of real names.
- **Updated agent memory** (`obscura-cli-first-cut`, index) with the E2E results + deferred step.

## Decisions Made
- **`adminSsh` = non-root `node@`**, for the file-ownership + rootless-socket reasons above. Root
  would have left the env file unreadable by the gateway stack.
- **Recovery strategy = revoke back under the floor, not bump MAX_SESSIONS.** The rename only needed
  2 consumers; dropping the old id put the count back under the configured `BGW_MAX_SESSIONS=5`
  floor, so no env edit + a single re-create both recovered service *and* completed the rename —
  never passing back through the broken 3-consumer state.
- **The leaked-name fix = genericize + amend + force-push**, matching the 2026-06-10 nickname-scrub
  precedent. The committed doc and its commit message now use placeholders only.

## What Didn't Work
- **`keys new vault --apply` crash-looped the entire gateway.** Adding a 3rd consumer pushed the
  pool-sizing floor (`consumers·perConsumerMax + 1`) to 7, above the configured `BGW_MAX_SESSIONS=5`
  → boot guard fails closed → `--restart unless-stopped` crash loop → **all** consumers down (not
  just the new one). Root cause is documented; the key gap is that **`keys --apply` re-creates with
  NO pre-swap smoke**, unlike the `deploy-on-host.sh` CD path that would have caught it.
- **First solution-doc commit leaked the real consumer id** into the public repo (body, token-env
  example, commit message). Caught and rewritten; see blocker below.

## What's Next
1. **⚠️ Scrub the remote: `git push --force-with-lease origin main`.** Local main is clean
   (`3fdad4e`); the remote still carries the leaked commit `d80964b` until this force-push replaces
   it. Classifier-blocked for the agent — operator must run it.
2. **Re-register the Vault MCP — DEFERRED, needs the Vault agent's project volume mounted.** The
   live `browse-gateway` registration is `local`-scoped to that project only, and `registerMcp`
   passes no `--scope` (defaults to cwd's project) — so `obscura connect` MUST run from that project
   dir or it makes a duplicate and leaves Vault broken. The exact resume command (with the volume
   path) is in agent memory `obscura-cli-first-cut`. Until then, that agent's MCP still holds the
   retired token and will 401.
3. **Close the `keys --apply` product gap.** Either pre-flight the sizing floor in `keysNew`
   (refuse/warn before staging a config the boot guard will reject) or give the apply path the same
   real-config pre-swap smoke `deploy-on-host.sh` has.
4. **Tunnel-key `permitlisten` follow-up** (carried over): the authorized_keys options still allow
   `-R` remote forwarding on both generated and live keys; pin `permitlisten` against prod sshd.

## Gotchas & Watch-outs
- **`obscura connect` is scope-sensitive:** run it from the Vault agent's project dir, by absolute
  path (`obscura` is not on PATH). Expect a Keychain access prompt — run it interactively.
- **`keys --apply` is a deploy, not a config tweak.** It re-creates the live container with no
  smoke. When adding the consumer that crosses a `perConsumerMax` boundary, bump `BGW_MAX_SESSIONS`
  in the same change, or it crash-loops every consumer.
- **Remote main carries a name leak until item #1 runs.** Don't branch off / open PRs against the
  current remote tip before the force-push, or the leak propagates.
- **Coded language is now in force for the real consumer id** — use "Vault" in anything committed or
  outward-facing; the real id + volume path live only in memory and `*.local.md`.
- **Untracked `.claude/` + `AGENTS.md`** left as-is (pre-existing, not part of this work).
