# HANDOFF — 2026-06-23 (Phase 2 credential vault: U5→U6d all merged)

Picked up after Phase 0 (#26) + Phase 1 (#27) and drove the **entire session-touching half of the
credential vault to completion**: storageState capture/restore, the TOTP wrapper, the assisted-login
primitive, the capture/import/warm orchestration, and the production gateway login-runner. Five PRs
(#28–#32) shipped and merged, each independently reviewed (10 external P1/P2 review rounds total, all
resolved before merge). **Phase 2's capture→store→replay machinery is now feature-complete on `main`
and proven end-to-end through the real gateway with real Chrome.** What remains is U8 (the operator
CLI / trigger wiring) and Phase 3/U7 (safety rails).

## What We Built

All five merged squash-commits are on `main` (tip `c2875fa`). Test suite **408 passing**.

- **#28 — U5: storageState capture/restore in the browser core** (squash `6c6c313`).
  `BrowserCore.captureStorageState()` (wraps `context.storageState()`) + `BrowserCoreOptions.restoreState`
  injected in `launch()` via `addCookies` + an origin-guarded, idempotent seed-if-absent `addInitScript`
  (pure `buildLocalStorageSeedScript`). New `StorageState{,Cookie,Origin}` types. Gate:
  `scripts/validate-vault-roundtrip.mjs`. **Naming: option is `restoreState`, NOT the plan's `vaultState`**
  — the vehicle-agnostic core stays vault-concept-free. P1 fixed: a malformed persisted cookie made
  `addCookies` reject AFTER Chrome launched → orphan-Chrome leak → extracted `restoreOrClose()`
  (close-then-rethrow).

- **#29 — U6a: TOTP wrapper** (squash `3098738`). `src/verbs/totp.ts` over **otplib v13** (see Gotchas —
  it's a native-ESM rewrite, NOT the old `authenticator`/`totp` API). RFC-6238 Appendix-B SHA-1
  conformance gate. P2 fixed: `isValidTotpSeed` used a regex+bit-count heuristic that accepted strings
  the real Base32 decoder rejects (`"A".repeat(27)`) → made it authoritative (delegates to `generateTotp`).

- **#30 — U6b: assisted-login primitive + readField** (squash `a1a618a`). `src/verbs/assisted-login.ts`:
  recipe-driven orchestration over a `LoginDriver` abstraction (tri-state field polling, credential→2FA
  ordering, settled-DOM success judge). New core method `readField(target)→FieldState`. `coreLoginDriver`
  adapter. Gate: `scripts/validate-assisted-login.mjs` (real Chrome, server-verified 2FA, cold-restore
  leg + an SPA leg). 3 review rounds: P1 success-judged-one-shot (async/SPA login threw) → bounded
  `settleAfterSubmit`/`pollSuccess`; P2 `pollIntervalMs<=0` infinite loop → validate; P2 timeout not a
  true upper bound → shared `sleepStep` clamps every loop.

- **#31 — U6c: capture/import/warm orchestration + sticky-exit binding** (squash `ccf4a0d`).
  `src/mcp/vault-login.ts` (operator-only, deliberately OFF the `DriveController` interface):
  `VaultEntry`, `captureLoginToVault`, `importLoginToVault`, `getVaultEntry`/`revokeVaultEntry`,
  `buildWarmOverride`. Sticky binding: `newStickyExitId()` + pinned-id `proxyOverrideFor(...,stickyExitId?)`.
  Unit-tested through a REAL temp-dir `VaultStore`. P1 fixed: the R3 "no IP-bound tokens persisted"
  invariant was documented but unenforced → `stripIpBoundTokens()` (denylist) on both write paths.

- **#32 — U6d: production gateway login-runner + full-path capstone** (squash `c2875fa`).
  `src/mcp/gateway-login-runner.ts` `makeGatewayLoginRunner()`. Gate: `scripts/validate-vault-login.mjs`
  drives a fixture login + 2FA THROUGH the real `Gateway` (capture→strip→encrypt→warm-replay; a real
  `cf_clearance` proves the R3 strip live). **3 P1 rounds, all on the runner's proxy posture** (see below).

## Decisions Made

- **U6 was split into U6a/b/c/d** (it was far too big for one PR). U6d folded the `http-main` wiring
  into U8 deliberately — wiring a runner nothing invokes yet would be dead code (draws a review note).
- **`makeGatewayLoginRunner` mirrors the drive flow exactly** (forced by the 3 U6d P1 rounds):
  - **DIRECT-FIRST, escalate-on-block (R7).** Never proxy a login the direct datacenter IP can clear;
    open direct, probe-navigate, escalate only on `shouldEscalateDrive` (CF managed challenge / hard block).
  - **A direct capture binds NO exit.** The `LoginRunner` contract returns `{state, stickyExitId?}` — the
    runner *reports* the bound exit only when it escalated, instead of the caller pre-minting one.
    `buildWarmOverride` re-pins a proxy ONLY when the entry carries a bound `stickyExitId` (direct capture
    replays direct — R7 applies on replay too).
  - **Retry up to `PROXY_OPEN_ATTEMPTS` fresh exits** (new sticky id each) before failing — residential
    exits are intermittently dead/dirty; the pre-login GET is safe to retry.
  - **Per-attempt try/finally** closes each retry session unless it's promoted to the committed handle.
- **`assistedLogin` gained `skipInitialNavigate`** so the runner owns the single escalation-aware navigate
  (no double-load, correct clearance budget on the proxied path).
- **Assisted-login is NEVER an MCP tool, by construction** (KTD-5): it's off the `DriveController`
  interface the server maps tools from; a regression test greps the compiled `server.js` to keep it so.
- **Kept otplib v13's 128-bit RFC-4226 seed floor** (the common 80-bit/16-char Google-Auth seed is
  rejected) rather than weakening the guardrail — surfaced as `isValidTotpSeed` at import time.

## What Didn't Work

- **Documented-but-unenforced invariants bit twice.** U6c shipped with "IP-bound tokens not persisted"
  in the doc comments but no actual filter (`captureStorageState` returns ALL cookies verbatim) — caught
  in review (#31 P1). Lesson: enforce invariants in code + a regression test, never just prose.
- **The original U6d proxy posture was wrong on three counts** (always-on → no retry → leak-on-throw),
  each a separate P1 round. Root cause: I built the runner fresh instead of mirroring the already-hardened
  `GatewayDriveController` escalation from the start. When adding a proxied-session path, copy the drive
  controller's open/retry/cleanup discipline.
- **`isValidTotpSeed` as a char-count heuristic** silently diverged from the real Base32 decoder — always
  validate by delegating to the authoritative path.

## What's Next

1. **U8 — `obscura vault` CLI** (`import | login | status | revoke`) + the `http-main`/trigger wiring.
   This is the operator front door; **nothing invokes the runner until this lands** (the whole capture
   path is merged but dormant). Mirror the `keys` CLI structure (`src/cli/keys.ts`): atomic prod writes,
   `--apply` reuses the generalized pre-swap smoke (U1), read-only `status`, fresh-process verify.
   `vault login` triggers `makeGatewayLoginRunner` + `captureLoginToVault` on-host; `vault import` →
   `importLoginToVault`; `vault revoke` → `revokeVaultEntry` (crypto-shred). Plan: U8 in
   `docs/plans/2026-06-22-002-credential-vault-plan.local.md`.
2. **Phase 3 / U7 — safety rails.** Host-scoped no-exfil (a stored host-A cookie only ever injected into
   a host-A-guarded session), audit every credentialed session, the hard financial/origination boundary
   (deny-rule), and the secret-leak kill-gate probe (prove no stored value appears in logs/observability/
   egress — modeled on the WebRTC probe leg).
3. **Activation (still fully dormant in prod).** The vault is off unless `BGW_VAULT_DIR` + a `0600`
   `BGW_VAULT_KEY_FILE` are set (expect `vault: ready` in the boot log). Nothing the vault does is live.

## Gotchas & Watch-outs

- **otplib v13 is a native-ESM rewrite — NOT the old API.** Use the functional `generateSync`/`verifySync`
  (epoch in SECONDS), not `authenticator`/`totp` classes. Default `NobleCryptoPlugin` is sync-capable.
  It enforces a 128-bit/16-byte secret floor (rejects 80-bit seeds). See `src/verbs/totp.ts`.
- **Git hygiene footguns hit twice this session** (both: "on `main` after a merge-sync, forgot branch
  discipline"): (1) `git rebase --onto main` used STALE LOCAL main (a `fetch` updates `origin/main`, NOT
  local `main`) → phantom conflict; fix `git branch -f main origin/main` first. (2) committed U6d to
  `main` directly (forgot to branch); push failed → recovered via `git branch <name>` then
  `git reset --hard origin/main`. **Branch BEFORE committing when on `main` after a merge.**
- **Reviewer-reply hash:** resolve the commit hash (`git rev-parse`) BEFORE composing the reply — posted
  one with a `<this commit>` placeholder this session and had to patch the GH comment + clipboard.
- **Clipboard SOP:** every reviewer-facing reply (`gh pr comment`) gets pbcopy'd in the SAME step — the
  operator relays review rounds manually. Memory: `clipboard-copy-paste-content`.
- **Source hygiene:** never embed literal control/separator bytes (NUL/U+2028/U+2029) — they break
  grep/diff. A degraded grep tuple also silently false-positives. Use `String.fromCharCode`/`\u`/codepoint
  sets in tests. (Hit a false-alarm sweep this session from exactly this.)
- **Public repo** — codenames only (atlas/vault/argus); no real ids/hosts/paths in source, commits, or PRs.
- **The capstone validator injects `egress: () => false`** into the PolicyEngine so the gateway can reach
  the 127.0.0.1 fixture (the egress filter blocks loopback as anti-SSRF). TEST-ONLY deviation; prod
  policy is unchanged.
- **Untracked `.claude/` + `AGENTS.md`** left as-is (pre-existing).
