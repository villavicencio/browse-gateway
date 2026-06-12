# HANDOFF — 2026-06-12 (afternoon PT)

Picked up from the 2026-06-11 handoff with one mandate: build the Obscura first cut from the local plan.
This session executed all six plan units, ran a Tier-2 multi-agent review (9 reviewers + 10 independent
validators) that caught a validated **P0 before merge**, applied every validated finding, and **merged
PR #20** (`e8fbd29`). Two new solution docs went straight to main. The CLI is on main but **not yet
exercised against the real fleet** — manual E2E on the operator Mac is the next step.

> Fleet detail (host/IP/consumer identities/prod paths) stays in `*.local.md` + agent memory, never
> here — this file is committed to a PUBLIC repo. "Vault" is the public-safe consumer codename;
> "Obscura" is the brand (now shipped on the experiential surfaces).

## What We Built
- **PR #20 (MERGED, squash → `e8fbd29`) — Obscura brand + one-command connect CLI.** New `src/cli/`
  (15 modules) + 10 `test/cli-*.test.mjs` files (270 tests green, repo total):
  - `obscura keys new|list|revoke <consumer>` — CSPRNG token + manifest/env mutation over admin SSH
    (atomic temp+rename, **manifest-before-env** ordering, env forced 0600), macOS Keychain storage
    (service `obscura`, account = consumer id), token printed once, desync detection both ways.
  - `obscura connect [--full]` — discover key (Keychain → config → env) → generate/ADOPT the hardened
    tunnel (keypair, ssh alias, LaunchAgent plist, self-disabling keeper — generated keeper is
    functionally identical to the live hand-built one, verified by diff) → `claude mcp add` with
    literal bearer via execFile args → **two-stage verify** (unauthenticated 401 = liveness, then
    authenticated probe: 401 = key rejected, non-401 = accepted) → `✓ connected as <consumer>`.
  - `obscura status [--stealth]` — tunnel/gateway/consumer doctor distinguishing "gateway down,
    tunnel up" vs "tunnel down" vs "403 = Host mismatch, not an outage"; owl header; exit 1 on unhealthy.
  - Brand kernel (`brand.ts`: reactive owl, redacting output helpers), Obscura README front door,
    one inlined boot-banner line in `http-main.ts`, `bin: obscura` in package.json.
  - Fleet config via gitignored `~/.config/obscura/config.json` + `OBSCURA_*` env; a guard test greps
    every git-tracked file for the operator's real fleet values read from that local config at test time.
- **docs/solutions (committed to main, `2b8505e`):**
  `runtime-errors/docker-restart-cannot-activate-env-file-changes.md` (the P0 learning) and
  `runtime-errors/stealth-gate-attempts-one-needs-required-one.md` (promoted from agent memory).
- **CLAUDE.md** layout updated with `src/cli/`.

## Decisions Made
- **`--apply` requires an operator-configured `applyCmd` (container RE-CREATE command); `docker restart`
  is structurally refused.** The review's P0: container env is frozen at `docker run` while the
  bind-mounted manifest IS re-read on restart — so restart-after-`keys new` boots new-manifest +
  old-env → fail-closed missing-token → crash loop downing every consumer. With `applyCmd` set, the
  CLI re-creates, polls /mcp→401, then confirms the token changed **inside** the container
  (`docker exec printenv`, exit-code only). This supersedes the plan's "lean minimal restart" answer
  to its own Open Question.
- **Verify must authenticate.** Liveness 401 alone printed a false ✓ on a stale Keychain key. A valid
  bearer on GET /mcp returns 400 (missing session id); invalid returns 401 — that distinction is now
  the key-acceptance check in `connect`.
- **Tunnel module adopts, never overwrites** — default `labelPrefix`/alias resolve to the live
  hand-built artifacts; existing files are never rewritten, but `ensure()` now WARNS on drift
  (adopted ssh-block HostName or keeper forward spec vs current config).
- **Policy imported, not mirrored**: CLI uses `tokenEnvKey`/`parseConsumerManifest` from `src/policy`
  directly — the env-key contract cannot drift.
- **`registerMcp` is non-destructive**: remove→add captures the old registration and restores it if
  the add fails; redacted `claude mcp get` output takes the update path, never a false "unchanged".
- **Subprocess watchdogs everywhere**: execCapture 30s default (SIGTERM→SIGKILL), applyCmd 120s,
  stealth gate 180s; admin ssh gets `-o ConnectTimeout=10`.
- **Ruled out:** a gateway enroll/admin API (again — SSH trust reuse stands); shipping `--apply` on
  `docker restart` (P0); mirroring tokenEnvKey; a `com.example` label-prefix default (would abandon
  the live LaunchAgent and double-bind 8080 — prefix is configurable, defaults to the live value
  already public in this file's history).

## What Didn't Work
- **`docker restart` as the `--apply` reload mechanism** — see P0 above. The "restart-to-reload"
  shorthand in earlier notes really means *re-create*; the solution doc pins this down.
- **Liveness-only verify** — passed every test yet proved nothing about the just-registered key.
- (Process note) The original U2 boot banner imported `cli/brand` from the gateway entry — a layer
  inversion the review flagged; banner is now inlined in `http-main.ts`.

## What's Next
1. **Manual E2E of the CLI on this Mac** — create `~/.config/obscura/config.json` (`adminSsh`,
   `tunnelHostName`, `consumer`, `remoteManifest`, `remoteEnvFile`; optional `applyCmd`,
   `labelPrefix`), then: `obscura status` (expect all green against the live tunnel) → staged
   `keys new <test-consumer>` + `keys revoke` → only then trust `--apply`. Real ssh/launchctl/
   Keychain/`claude` effects were test-faked by design; this is the remaining verification.
2. **Before the next deploy**: re-`scp` BOTH `scripts/deploy/deploy-on-host.sh` and
   `scripts/deploy/launch-http.sh` to the prod `~/deploy/` (static copies — PR #19's smoke is a
   no-op on prod until then). Next deploy also picks up the boot banner (cosmetic, log-only).
3. **Tunnel-key hardening follow-up**: the generated AND live authorized_keys use
   `restrict,port-forwarding,permitopen=…` — `port-forwarding` re-enables remote (-R) forwarding;
   verify `permitlisten` pinning against prod sshd and apply to both keys.
4. **Optional Obscura follow-ups** (deferred at plan time): `obscura disconnect` (bootoutTunnel has
   no CLI surface), automated new-keypair install over admin SSH, on-box `--local` mode.

## Gotchas & Watch-outs
- **`obscura` is unconfigured until the local config exists** — every command errors naming the
  missing key + its `OBSCURA_*` env override. That's by design (zero fleet defaults in source).
- **`--apply` refuses without `applyCmd`** and the change stays STAGED — the gateway keeps serving
  the old consumer set until a container re-create. `keys list` shows token=MISSING/desync states.
- **Known residuals are listed in PR #20's body**: -R forwarding on the tunnel key (above); the
  fleet-hygiene guard is vacuous in CI (operator-side by design); the port-owner check trusts any
  `ssh`-named listener; `registerMcp` parses unstructured `claude mcp get` text.
- **The plan doc was NOT updated** with the `applyCmd` decision (plans are decision artifacts;
  the solution doc + this handoff + memory `obscura-cli-first-cut` carry it).
- **Untracked `.claude/` + `AGENTS.md`** left as-is (pre-existing).
