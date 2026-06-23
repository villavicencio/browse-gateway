# HANDOFF — 2026-06-23 (afternoon) — Phase 2 credential vault COMPLETE (U8a + U8b merged)

Continued straight on from the morning handoff (Phase 2 capture path U5→U6d merged, #28–#32).
This session built the **entire U8 operator front door** — the `obscura vault` CLI — and with it
**Phase 2 of the credential vault is feature-complete on `main`**: capture → strip → encrypt →
warm-replay (U5–U6d) plus the full operator surface (status / import / revoke / login). Two PRs
shipped and merged (#33, #34); four external review rounds total, all resolved before merge.
The vault remains **fully dormant in prod** — nothing is live until it's activated (see Gotchas).

## What We Built

Both squash-commits are on `main` (tip `f43431c`). Test suite **446 passing**; two real-browser
gates green (`validate:vault-login`, `validate:vault-host-login`); typecheck clean.

- **#33 — U8a: `obscura vault status | import | revoke`** (squash `c4fc4c8`). The no-browser half
  of the front door, entirely over the admin-SSH spine — **zero new network surface**.
  - `src/cli/vault.ts` (Mac side) — owns no crypto/browser; marshals a request and ships it to the
    on-host entrypoint via `docker exec -i <container> node dist/cli/vault-host.js`, renders the JSON.
  - `src/cli/vault-host.ts` (runs INSIDE the gateway container, inherits its `BGW_VAULT_DIR` + `0600`
    key — the KEK never leaves the box): `status` (keyless listing + boot-blocked warning), `import`
    (strips IP-bound cookies, manifest-first guard, post-write fresh-instance decrypt verify), `revoke`
    (crypto-shred).
  - New keyless `listVaultEntries(dir)` in `src/security/vault-store.ts` (backs `status` without the KEK);
    `VaultStore.list()` delegates to it.
  - `src/cli/args.ts` generalized — single-value flags (`consumer/host/session/recipe/creds/exit`) store
    last-value strings; `--allow` keeps comma-split accumulation via a new `multi` FlagSpec.
  - Tests +20 (cli-args routing, cli-vault marshalling with a fake shell asserting secrets never hit
    argv, vault-host run as a REAL subprocess vs a temp vault + 0600 key + manifest).

- **#34 — U8b: `obscura vault login` (live on-host capture)** (squash `f43431c`). Drives an assisted
  login + TOTP on-host into the vault. **Effort: max.**
  - **Load-bearing refactor:** new `src/mcp/runtime.ts` `buildGatewayRuntime(env, {log, secrets?,
    policyEgress?})` factors the gateway boot (config → secrets → vault → solver → consumers →
    pool-sizing guard → policy → gateway → escalation posture → sticky-suffix guard) out of
    `http-main.ts`; **http-main now calls it (behavior-preserving — all prior tests green).**
  - `src/cli/vault-host.ts login` builds a THROWAWAY Gateway via the runtime, looks up the consumer
    token, runs `makeGatewayLoginRunner` + `captureLoginToVault`, fresh-decrypt-verifies, and tears the
    Gateway down in `finally`. `src/cli/vault.ts vaultLogin` ships `{recipe,creds}` on stdin (180s
    watchdog, second-Chrome note, direct-vs-escalated reporting).
  - Real-browser gate `scripts/validate-vault-host-login.mjs` (`npm run validate:vault-host-login`):
    fixture login + 2FA driven THROUGH `buildGatewayRuntime` → capture → strip `cf_clearance`/`__cf_bm`
    → warm replay lands authenticated.
  - Tests +12 then +6 (runtime construction/guards, login subprocess glue without Chrome, login
    marshalling, force-proxy + sticky-suffix regressions).
  - **Two review rounds resolved on-branch:** P2 force-proxy parity (`047f3b5`), P1 honest R3 binding
    (`a366886`) — see Decisions.

## Decisions Made

- **`vault login` trigger = SSH → on-host process** (operator-chosen via AskUserQuestion). The CLI
  `docker exec`s a `vault-host` entrypoint that builds its OWN throwaway Gateway in the container.
  **Zero new network surface; stays on the admin-SSH operator plane** (like keys/connect/status).
- **Dropped `--apply`/pre-swap-smoke from the vault CLI** (deliberate deviation from the written plan).
  A vault entry write is **immediately live** — the running gateway re-reads the sealed file per
  warm-session open under the same KEK, so there's nothing to "activate" via a re-create, and a bad
  entry fails ONE warm-session open (fail-closed), never the boot. The fresh-process-verify lesson is
  satisfied instead by a **post-write fresh-instance decrypt** inside the entrypoint.
- **U8 split into U8a (no-browser) + U8b (login)** for size/risk, matching the U6 split discipline.
- **`buildGatewayRuntime` extraction** justified by `login` being its second consumer in the same PR
  (no speculative abstraction). Two seams: **`policyEgress`** is a TEST-ONLY in-process hook (both prod
  callers omit it → real `isBlockedEgressHost`; the in-process gate passes `()=>false` to reach a
  loopback fixture); **`secrets`** lets vault-host reuse its one redaction sink so KEK + tokens + creds
  all scrub through it.
- **P2 fix (`047f3b5`):** the login-runner now honors `BGW_FORCE_PROXY_HOSTS` — a forced host SKIPS the
  direct attempt and begins on a pinned exit (mirrors drive's `#firstNavigate`), forced-without-proxy
  fails loud. The pinned-exit retry loop is now reachable from both the forced-from-start and
  escalate-after-block paths.
- **P1 fix (`a366886`):** a proxied capture now REQUIRES a pinnable proxy (proxy creds + onDatacenterIp
  + `BGW_PROXY_STICKY_SUFFIX`). Without a sticky suffix, `mintStickyProxy` ignores the id → the exit
  rotates → a stored `stickyExitId` would be a false R3 claim. So forced-without-suffix AND
  block-without-suffix both fail loud; the pinned-exit loop is reachable only when the suffix is set,
  so **every recorded `stickyExitId` genuinely pins**.

## What Didn't Work / Ruled Out

- **In-process operator endpoint on the running gateway** (the "fold into http-main" idea the prior
  handoff floated for the login trigger) — RULED OUT. It expands the consumer-facing service's surface
  with an operator control plane, cutting against the admin-SSH-only / KTD-5 doctrine. The SSH →
  on-host-process model was chosen instead.
- **A subprocess real-browser gate for `vault login`** — not feasible. The egress filter blocks ALL
  local IPs (loopback + RFC1918) as anti-SSRF, so a real subprocess (prod egress on) can't reach a
  local fixture without an env bypass = a prod footgun. Hence the gate runs IN-PROCESS via the
  test-only `policyEgress` hook; the subprocess arg/stdin/token-lookup glue is unit-tested without Chrome.
- **P1 option-b (store the capture as honestly-unbound when no suffix)** — rejected. `buildWarmOverride`
  only proxies via a bound `stickyExitId`, so an unbound forced entry would replay DIRECT — wrong for a
  force-proxy host. Requiring a pinnable proxy (option-a) is the coherent fix.

## What's Next

1. **Phase 3 / U7 — safety rails** (the only vault work left). Prioritized:
   - **Host-scoped no-exfil:** a stored host-A cookie must only ever be injected into a host-A-guarded
     session (the warm-replay path must enforce the same host-scoping the capture had).
   - **Audit every credentialed session** (which consumer, which host, when).
   - **Hard financial/origination deny-rule** (a policy deny, below the verb layer).
   - **Secret-leak kill-gate probe:** prove no stored value ever appears in logs/observability/egress —
     model it on the WebRTC probe leg in `validate-stealth.mjs`.
   - Plan: `docs/plans/2026-06-22-002-credential-vault-plan.local.md` (U7 section).
2. **Activation** (separate, deploy-side): set `BGW_VAULT_DIR` (on a persistent volume — see Gotchas)
   + a `0600` `BGW_VAULT_KEY_FILE`, re-create the container, confirm `vault: ready` in the boot log.
   Until then the entire vault is dormant.
3. **Parked, unrelated:** the PerimeterX-defeat spike (`docs/plans/2026-06-22-001-*.local.md`) and the
   durability/external-users brainstorm (D1+D4). Neither blocks the vault.

## Gotchas & Watch-outs

- **Vault is fully DORMANT in prod** — nothing the vault does is live until `BGW_VAULT_DIR` + a `0600`
  `BGW_VAULT_KEY_FILE` are set. The CLI reports "vault is not enabled" until then.
- **ACTIVATION GOTCHA: `BGW_VAULT_DIR` MUST be a persistent volume.** Otherwise every imported/captured
  entry vanishes on the next container re-create (deploy). Pin this down before activating.
- **`vault login` launches a SECOND headful Chrome** in the container (transient). Proven safe:
  `userDataDir` defaults to `""` → a fresh ephemeral profile per launch (no singleton-lock clash with
  the live gateway), and `DISPLAY=:99` is an image `ENV` so `docker exec` inherits the running Xvfb.
  Run it at low gateway load (the CLI prints a note); the throwaway Gateway is shut down in `finally`.
- **`buildGatewayRuntime`'s `policyEgress` is TEST-ONLY.** Both prod callers (http-main, vault-host)
  must pass NO override → real egress. If you add a third caller, do NOT pass `policyEgress`.
- **Force-proxy + sticky-suffix coupling:** a proxied vault capture is refused unless
  `BGW_PROXY_STICKY_SUFFIX` is set (so the bound exit can be re-pinned on warm replay, R3). If `vault
  login` for a forced host fails with "BGW_PROXY_STICKY_SUFFIX is unset", that's the guard, not a bug.
- **Branch BEFORE committing when on `main` after a merge** (bit twice in the prior session). This
  session branched cleanly for both PRs.
- **Resolve the reviewer-reply commit hash (`git rev-parse`) BEFORE composing the reply** — no
  `<this commit>` placeholders. Every reviewer-facing reply was pbcopy'd in the same step (operator
  relays rounds manually); I did NOT auto-post `gh pr comment`.
- **Public repo** — codenames only (atlas/vault/argus); no real ids/hosts/paths in source/commits/PRs.
  Both PRs' diffs were scanned clean of fleet identifiers and control/separator bytes.
- **Untracked `.claude/` + `AGENTS.md`** left as-is (pre-existing).
- **This HANDOFF commit is on local `main` but NOT pushed** — per the standing main-push gate, the
  operator pushes `main`. `git push origin main` when ready.
