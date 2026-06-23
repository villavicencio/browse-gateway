# HANDOFF — 2026-06-22 (session 2: credential vault planned + B1/B5 shipped)

Session opened with `/dv:pickup` (post-#24/#25). Operator chose to build the **credential / session-state
vault** (Track B from the 2026-06-19 stealth+vault brainstorm) — the unbuilt north-star feature. We
planned it (full Tier-2 credential vault, plan-first), then shipped the first two phases: **Phase 0
(host hardening, B5) merged as #26** and **Phase 1 (encrypted store, B1) merged as #27**. Phase 2
(session-touching: capture/restore + assisted-login) is **paused — operator picks it up fresh**.

## What We Built

- **Plan: `docs/plans/2026-06-22-002-credential-vault-plan.local.md`** (gitignored). Deep, 8 units / 4
  phases, via `/ce:plan`. Research-grounded KTDs (3 parallel research agents + adversarial reviews):
  - **node:crypto AES-256-GCM envelope**, no new dep (KEK → HKDF wrap key → per-entry random DEK).
  - **Host-held key FILE custody** (`BGW_VAULT_KEY_FILE`, chmod 600) — origin Q#3 resolved. Blast
    radius is irreducible on a single box; optimize exposure + rotation.
  - Persist an **encrypted `storageState` blob, not a whole `userDataDir` profile** (KTD-3).
  - **Assisted-login = operator-only CLI primitive, NEVER an MCP tool** (KTD-5).
  - **TOTP via `otplib`** (speakeasy is dead).
  - **B3 reshaped**: persist DURABLE auth (creds / TOTP seed / long-lived cookies) + bind a STABLE
    STICKY EXIT per entry; do NOT persist IP-bound `cf_clearance`/PX tokens (rotating exits kill them).
  - Threat model folded into the plan (origin Q#4).

- **PR #26 — Phase 0 host hardening (B5). MERGED (squash `db01769`).** The prerequisite gate.
  - **U1 — generalized the pre-swap smoke to all `--apply` mutations.** Extracted
    `scripts/deploy/preswap-smoke.sh` (single source of truth shared by `deploy-on-host.sh` and the
    `obscura keys|vault --apply` path); `keys --apply` now boots the staged config on a throwaway port
    *before* recreating the live container — closes the `BGW_MAX_SESSIONS` crash-loop. New optional
    config `smokeCmd` (`OBSCURA_SMOKE_CMD`); the script self-defaults the image to the running container.
  - **U2 — port-owner trust check, hardened through THREE operator-found P1 rounds.**
    `classifyPortOwner` now requires **provenance** (listener UID == current user, descends from our
    keeper via parent-command `spec.keeperPath`) **plus** the keeper's allowlisted `-N/-T/-L` argv shape
    with the alias as the destination operand. argv shape alone is forgeable. Learning compounded:
    `docs/solutions/architecture-patterns/local-port-owner-verification-needs-provenance.md`.

- **PR #27 — Phase 1 encrypted store (B1). MERGED (squash `839da62`).** Repo's first encryption-at-rest.
  - `src/security/vault-crypto.ts` — AES-256-GCM envelope; AAD = **injective** length-prefixed
    `version∥consumer∥host`; mandatory auth, fail-closed; slot-field control-char rejection.
  - `src/security/vault-store.ts` — per-`(consumer,host)` entries (sha256-of-injective-encoding
    filename), `put/get/list/remove/rotateVaultKey`, `loadVaultKey`/`openVault`, **fail-closed boot
    guard**, field-aware redaction folding. NEW env **`BGW_VAULT_DIR`** + `BGW_VAULT_KEY_FILE` /
    `BGW_VAULT_KEY` (raw key in `SECRET_KEYS`). Wired into `http-main` — **dormant unless
    `BGW_VAULT_DIR` is set**.
  - Survived a 6-finding adversarial review + **3 operator findings**: KEK file perms now ENFORCED
    (reject group/world-readable or non-regular before reading); strict rotation (fails on any
    unparseable/undecryptable `*.vault.json`, no split-brain); short `{name,value}` cookie values fold
    into redaction without folding short names.

- **Solution doc:** `docs/solutions/architecture-patterns/local-port-owner-verification-needs-provenance.md`
  (the tunnel-ownership provenance lesson — argv is forgeable, key on UID + parentage).

## Decisions Made

- **Phase order:** B5 host-hardening (#26) is the prerequisite gate — merged FIRST, then B1 store (#27).
- **Branch-per-phase off `main`:** Phase 0 and Phase 1 touch disjoint files, so each was an independent,
  cleanly-reviewable PR. Phase 2 branches off `main` (the store is now there).
- **Pace Phase 2 fresh** (operator's call) — two merged PRs through 9 review findings is a clean stop.

## What Didn't Work (caught in review)

- Tunnel ownership: `COMMAND==ssh` → alias-anywhere → alias-as-operand → flag-allowlist → **provenance**.
  Each prior step was bypassable; only UID + keeper-ancestry closes the foreign-account spoof.
- Vault AAD was space-separated (non-injective) — a host with a space could open another slot's record.
  → injective length-prefixed AAD.
- KEK file perms were unenforced (a `0644` key file exposed the master key) → enforced `chmod 600`.
- `rotateVaultKey` used `list()` (which silently skips malformed files) → strict enumeration.
- **Source hygiene:** literal control bytes (NUL) in test strings break grep/diff — use
  `String.fromCharCode` / `\u` escapes, never literal control chars.

## What's Next

1. **Phase 2 — U5 (browser-core capture/restore).** Design locked (read the code):
   - Add `captureStorageState(): Promise<StorageState>` to `BrowserCore` + `PatchrightBrowserCore`
     (wraps `context.storageState()`).
   - Add `restoreState?: StorageState` to `BrowserCoreOptions`; inject in `launch()` after
     `launchPersistentContext` via `context.addCookies` + an **origin-guarded, idempotent
     `addInitScript`** for localStorage. Vault sessions use the clean ephemeral `userDataDir` (`""`).
   - `scripts/validate-vault-roundtrip.mjs` (real-browser: capture → restore into a cold context →
     logged-in), mirroring `validate-frame-capture.mjs`.
2. **Phase 2 — U6 (assisted-login primitive).** Operator-only (via `obscura vault login` over admin
   SSH), NOT an MCP tool. Poll async login/TOTP fields (tri-state), `otplib` TOTP, judge success on the
   settled DOM, bind a sticky exit per entry, seeded import + refresh-on-expiry.
3. **Phase 3 — U7 safety rails** (host-scoped no-exfil, audit, hard financial/origination boundary,
   secret-leak kill-gate probe) + **U8 `obscura vault` CLI** (`import|login|status|revoke`).

## Gotchas & Watch-outs

- **Vault is DORMANT in prod** — nothing changes until `BGW_VAULT_DIR` + a `0600` `BGW_VAULT_KEY_FILE`
  are set. To enable: set both (key injected at deploy time, out of the image + git), expect
  `vault: ready` in the boot log. Boot guard fails closed if entries exist but no key loads.
- **Phase 0 isn't active until configured either** — `keys --apply` still warns-and-proceeds until
  `OBSCURA_SMOKE_CMD=~/deploy/preswap-smoke.sh` is set in the operator config + `preswap-smoke.sh` is
  `scp`'d to the on-host deploy dir.
- **Local `main` has an unpushed handoff/docs commit** (agent main-push is gated — operator pushes).
- **Known residual (accepted):** the port-owner check is check-then-use; a TOCTOU before `connect`
  registers is theoretically possible (needs atomic port handoff — out of scope).
- **Coded language:** atlas / vault / argus are public codenames; real ids/host/paths/tokens live only
  in agent memory + `*.local.md`. The repo is PUBLIC.
- **Untracked `.claude/` + `AGENTS.md`** left as-is (pre-existing).
