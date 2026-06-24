# HANDOFF — 2026-06-24 (morning, PST)

This session **built, review-hardened, and MERGED U9 — consumer warm-open** (vault-restored
logged-in drive sessions), the headline credential-vault feature. It was driven end-to-end through
the **first live run of the Codex review-loop SOP**: a 6-round autonomous Claude↔Codex
adversarial-review loop that caught **four real security bugs** my own self-review missed, converging
to **Codex `approve`, 0 findings**. U9 is on `main`; the credential vault is still **DORMANT in prod**
(no behavior change until activated — steps below).

## What We Shipped (all on `main`)

- **U9 — consumer warm-open** (squash `f8df7cd`, from a 7-commit branch). Implicit auto-warm at
  `GatewayDriveController.#firstNavigate`: when a consumer navigates to a host that's on its allowlist
  AND has a vault entry, it opens a **logged-in** session instead of a cold one; otherwise it falls
  through to the existing cold/escalation path. No new MCP param. Warm takes precedence over
  force-proxy/direct-first (R3 — must replay on the exact captured exit). Single-host nav-clamp (cross-host
  is blocked). Policy stays below the verb layer — the trigger only SELECTS a sealed override; all
  enforcement (seal refusal, owner-host nav clamp, origination boundary, host-scoped jar, credentialed
  audit) is unchanged. Both entrypoints (`http-main` prod, `main.ts` stdio rollback) wire
  vault + consumerId + allowlist; `main.ts` gained a lockstep `openVault` so the rollback launcher
  doesn't diverge (cold while prod is warm).
- **Deploy mount** (`b9628de`): `scripts/deploy/launch-http.sh` gained an optional
  `BGW_VAULT_HOST_PATH` bind-mount → `/run/vault` (rw). Unset → no mount, vault dormant — a no-op for
  non-vault hosts, safe to land ahead of activation.
- **Runtime gate** `scripts/validate-vault-warm-open.mjs` (`npm run validate:vault-warm-open`): drives
  the REAL consumer trigger (`controller.navigate`, never `buildWarmOverride`) through a real gateway +
  headful Chrome. **In-container 14/14, full coverage.** **499 unit tests green.**

## The Codex Loop Earned Its Keep — 4 real bugs, each fixed + re-gated

My self-review (a 3-lens workflow) was clean. Codex found these:

1. **R1 (high) — parent-domain SSO cookie → sibling-subresource exfil.** The nav-clamp clamps only
   NAVIGATION; subresources keep the consumer allowlist. A retained `.example.com` cookie for owner
   `accounts.example.com` could ride an allowed sibling subresource (`static.example.com`) off-host.
   **Fix:** re-scope a retained parent-domain cookie to the owner host at restore
   (`hostScopeSession`/`clampCookieToOwner`) — server-transparent, breaks nothing.
2. **R2 (med) — revoked credential silently downgraded a logged-in session to cold.** On
   reopen-after-reap, a revoked entry silently reopened cold (anonymous) with no consumer-visible error.
   **Fix:** loud terminal error; never a silent cold fallback.
3. **R3 (high, three rounds) — bound credential replayed from the WRONG exit.** A bound (residential-exit)
   credential could replay from (a) the direct/datacenter exit when no proxy, (b) a ROTATING exit when a
   proxy was configured but no sticky suffix, or (c) an exit "verified" only by an incidental substring in
   the base password. **Fix:** `proxyOverrideForPinned` verifies the pin **STRUCTURALLY** (datacenter + a
   `{id}`-bearing sticky suffix + base password; minted password == `base + suffix-with-id`).
   `buildWarmOverride` **fails closed** otherwise.
4. **Round 6 → `approve`, 0 findings.**

## Decisions Made

- **Trigger style: implicit auto-warm** (operator-confirmed). Navigate to a warm host → logged-in
  session, no flag/verb. The credentialed-session audit makes it traceable.
- **Cross-host: single-host warm** (operator-confirmed). The nav-clamp blocks an off-owner navigate;
  use a new drive session for another host.
- **Owner-subtree cookie residual: ACCEPTED** (operator-ratified). A domain-scoped owner cookie can
  still reach the owner's OWN subdomains on a subresource — within the owner subtree, never a
  sibling/parent/third party (those are closed). Accepted under the trusted-owner model (Option B;
  egress sidecar is the boundary), same class as the WS residual. Documented at `hostScopeSession`.
  Mitigation: scope a warm host's consumer allowlist to the owner host (avoid `*.parent`). Full
  exact-host cookie lockdown is tracked as optional hardening (it breaks legitimate cross-subdomain XHR).

## What's Next

1. **Activate the vault in prod** (U9 is inert until then). Short version: provision a persistent
   `~/vault/entries` dir + a `0600` base64 KEK (`openssl rand -base64 32`); add
   `BGW_VAULT_DIR=/run/vault/entries`, `BGW_VAULT_KEY_FILE=/run/vault/kek`,
   `BGW_VAULT_HOST_PATH=~/vault` to the on-host env file; re-scp `launch-http.sh`; deploy
   (`gh workflow run deploy-http.yml`); confirm the boot log shows `vault: ready`; then
   `obscura vault login` to capture a credential; verify a consumer warm-opens.
2. **Pre-activation gates** (in-container, as `node`): `validate:vault-warm-open` (14/14),
   `validate:stealth` with `BGW_PROXY_*`, `validate:redirect-guard`, `validate:drive`.
3. **Hardening follow-ups (none blocking):** WS exfil close via `Network.webSocketCreated` (Option B);
   full exact-host cookie lockdown; narrow-allowlist `retrieve` redirect hard-fail; cross-origin OOPIF
   container fixture; one in-prod `validate-stealth` `BGW_PROXY_*` run.

## Gotchas & Watch-outs

- **BOUND credentials need the sticky suffix.** If a capture escalated to a residential exit, the entry
  is bound; warm-open **fails closed** (loud) unless `BGW_PROXY_STICKY_SUFFIX` (with `{id}`) +
  `BGW_ON_DATACENTER_IP=1` + proxy are set. That's the R3 guard working — don't "fix" it by dropping the
  binding. Direct captures don't need it.
- **Vault dir MUST persist** and the **key file MUST be `0600`.** Entries-on-disk + missing key fails
  boot closed by design; a container re-create without the bind-mount loses entries.
- **Codex loop mechanics:** run `codex-companion.mjs adversarial-review --wait` inside a **detached
  harness bg task** — plain `--background` got killed by the 2-minute shell timeout mid-handshake and
  orphaned the worker in a frozen "running" state. Verify a job is alive by its **pid + log mtime**, not
  just the status field (which can go stale).
- **Pool floor:** a held warm session consumes a session slot — re-verify `BGW_MAX_SESSIONS` /
  `perConsumerMax` cover every consumer after adding warm load.
- **Public repo** — codenames/placeholders only; the deploy script is fleet-clean (host paths via env).
- Local `main` == `origin/main` (tip `b9628de`); nothing unpushed.
