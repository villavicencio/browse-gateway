# HANDOFF — 2026-06-23 (evening) — U7 vault safety rails BUILT, PR #35 review-clean (4 P1 rounds), ready to merge

Continued straight on from the afternoon handoff (Phase 2 vault complete, U5→U8b on `main`). This
session built **Phase 3 / U7 — the credential-vault safety rails** end to end on branch
`feat/vault-u7-safety-rails` (**PR #35, OPEN**), then drove it through **four external review rounds**
(all P1s) plus an internal 6-dimension adversarial review. Re-review **PASSED**; the PR is clean and
**ready for your merge**. U7 is **rails-only** — the consumer warm-open path stays unwired (that's U9),
which is now **gated on a redirect-bypass fix** the review surfaced. **467 tests pass, typecheck clean.**

## What We Built

Six commits on `feat/vault-u7-safety-rails` (tip `c9d97fe`); PR #35.

- **`df9b984` — U7 four rails.**
  - **Rail 1 (host-scoped no-exfil):** `cookieBelongsToHost(domain, ownerHost)` in `src/security/url.ts`
    (dependency-free; exact / subdomain / dotted-parent SSO-apex; single-label + bare-TLD owner rejected;
    ASCII/punycode-folded). `hostScopeSession` filters a warm jar to its owner. A credentialed session's
    NAVIGATION is clamped to the owner host via new `PolicyEngine.guardForCredentialHost` (`src/policy/index.ts`)
    installed by `Gateway.openConsumerSession` (`src/gateway/index.ts`).
  - **Rail 2 (audit):** new `session-open`/`open` `AuditRecord` (`src/policy/audit.ts`) carrying only
    consumerId + host (both redaction-safe), emitted at `openConsumerSession`.
  - **Rail 3 (origination boundary):** `src/policy/origination.ts` — always-on policy deny of
    account-creation / money-movement navigations by host+path, in `guardFor` after egress / before allowlist,
    gated on `isNavigationRequest`. Public defaults + `BGW_ORIGINATION_DENY_HOSTS` / `_PATHS` env extension.
  - **Rail 4 (secret-leak kill-gate):** browserless `runSecretLeakCheck` leg in `scripts/validate-stealth.mjs`
    (positive control, no real secret) proving stored values never survive the redaction surfaces.
  - Tests: new `test/vault-safety.test.mjs`; gap doc `docs/solutions/architecture-patterns/vault-observability-redaction-gap.md`.
- **`a76dc8f` — review round 1 P1s.** Origination matched the RAW `URL.pathname` (so `/sign%75p` evaded
  `/signup`) → now matches the **decoded + server-normalized** path (`decodedPathVariants` + `serverNormalizedPath`:
  iterated percent-decode, strip matrix-params `;`, truncate NUL `%00`). Added the credentialed nav clamp.
- **`b9c1f0c` / `75daced` — docs.** Tracked the server-redirect bypass (below) as a P1 follow-up that **gates U9**.
- **`df8bc90` — review round 3 P1.** Made `restoreState` an atomic `{ state, ownerHost }` (`RestoreState`);
  clamp + audit derive from `restoreState.ownerHost` — removed the separate `credentialHost` param.
- **`c9d97fe` — review round 4 P1 (the load-bearing one).** `buildWarmOverride(vault, secrets, {consumerId, host, …})`
  now does the vault `get` ITSELF, so the owner **is** the looked-up host (no caller `ownerHost` to mismatch).
  `RestoreState` is **sealed** (`sealRestoreState`/`isSealedRestore`, non-enumerable brand in `src/browser/types.ts`);
  `openConsumerSession` REFUSES a restoreState that isn't sealed. Updated `src/browser/index.ts` (exports),
  the two warm validators, and the unit tests.

## Decisions Made

- **U7 is RAILS-ONLY (operator-approved via AskUserQuestion).** The consumer warm-open path is NOT wired here
  — that's U9. Rails are correct-by-construction; tests/validators exercise the seams directly.
- **Origination boundary = honest guardrail, not airtight.** The policy guard can't see POST bodies or
  form-field types (`NavigationRequest` is url/host only), so money-movement is host-only and account-creation
  is path-only. Deny by **host+path, never "has a password field"** — so it never blocks the sanctioned logins
  the vault exists for. Documented as such in `origination.ts`.
- **Rail 4 covers log + audit surfaces only;** the observability-output (rendered HTML/screenshots) + egress-payload
  redaction gap is documented (`vault-observability-redaction-gap.md`), not closed.
- **Warm-restore owner binding (the 4-round arc):** owner must come from the vault LOOKUP and be SEALED into the
  restore value, so it can be neither omitted, set as a separate param, nor passed to a builder as a free input.
  `buildWarmOverride` does the lookup; the gateway rejects unsealed restores.
- **Accepted residual (reviewer signed off):** `sealRestoreState` is exported across the browser→mcp layer, so it's
  technically callable with a forged owner. `buildWarmOverride` is the sole sanctioned producer that binds owner to
  the lookup; the browser layer can't depend on the vault to enforce more. Reviewer: "an in-process API trust
  boundary, not a remotely reachable bypass… not a blocker."

## What Didn't Work

- **Re-filtering a warm jar by a caller-supplied clamp host (the round-3 "validate it matches" idea) — RULED OUT.**
  A `.example.com` parent cookie legitimately *belongs to* `evil.example.com` (a subdomain), so re-filtering an
  `accounts` jar against `ownerHost: evil` KEEPS the parent cookie → still leaks. The owner had to be lookup-bound,
  not validated.
- **Colocating owner with state but keeping a `buildWarmOverride` `ownerHost` param (round-3 fix) — INSUFFICIENT.**
  It just moved the mismatch into `buildWarmOverride`'s input (reviewer reproduced it). Fixed in round 4 by doing
  the lookup inside `buildWarmOverride`.
- **Folding the server-redirect fix into U7 — declined (operator-approved).** It's high-blast-radius core-surgery
  (`route.fetch({maxRedirects:0})` + per-hop guard) that must clear the container stealth/proxy/drive gates, so it's
  its own unit, not a blind drive-by in this PR.

## What's Next

1. **Merge PR #35** (your call — review is clean, 467 green, typecheck clean). Then it's on `main` as the last
   piece of the vault before U9.
2. **Paste the round-4 reviewer reply** (it was pbcopy'd to your clipboard; also at
   `…/scratchpad/u7-reply-round4.md`) into the PR thread, if not already done.
3. **U9 — wire the consumer warm-open path**, BUT it is **GATED on the server-redirect fix** below. When wiring,
   `openConsumerSession` derives clamp+audit from the sealed `restoreState.ownerHost` automatically — use
   `buildWarmOverride(vault, secrets, {consumerId, host, …})` (it does the lookup; returns null if absent).
4. **CRITICAL FOLLOW-UP — close the nav-guard server-3xx-redirect bypass**
   (`docs/solutions/architecture-patterns/nav-guard-redirect-bypass.md`). `route.continue()` follows a server
   redirect chain inside Chrome WITHOUT re-invoking the route handler, so a redirected hop bypasses the credential
   clamp AND the base allowlist/egress guards (pre-existing, gateway-wide). Fix = `route.fetch({maxRedirects:0})` +
   per-hop guard check in `setNavigationGuard` (`src/browser/patchright-core.ts`). Needs the container kill-gate +
   stealth + proxy + drive validation (can't run on the Mac).
5. **Close the observability-output / egress-payload redaction gap** (`vault-observability-redaction-gap.md`).
6. **Activate the vault** (separate, deploy-side): `BGW_VAULT_DIR` (PERSISTENT VOLUME) + `0600` `BGW_VAULT_KEY_FILE`,
   re-create container, confirm `vault: ready` in the boot log.

## Gotchas & Watch-outs

- **U9 MUST NOT activate before the redirect-bypass fix lands** — a live warm session makes the redirect hop a live
  cookie-exfil vector against a real stored credential.
- **`openConsumerSession` now THROWS on an unsealed `restoreState`** ("must be produced by the vault layer"). Any
  warm session must build its override via `buildWarmOverride` / `sealRestoreState`. Direct `createBrowserCore`
  callers (the roundtrip/assisted validators) pass `restoreState` to the CORE, which is seal-agnostic — that's fine.
- **`buildWarmOverride` signature changed** to `(vault, secrets, {consumerId, host, onDatacenterIp, stickySuffix})`
  and returns `BrowserCoreOptions | null`. The old `(entry, secrets, {ownerHost})` form is gone.
- **The sealed `RestoreState` brand is non-enumerable** — survives object-spread but is invisible to
  `deepEqual`/`JSON.stringify` (so existing deepEqual tests still pass). Don't deep-clone a restoreState or the brand
  is lost; the gateway checks the seal at entry, before any merge.
- **Vault still FULLY DORMANT in prod.** Activation gotcha stands: `BGW_VAULT_DIR` must be a persistent volume or
  entries vanish on the next container re-create.
- **Public repo** — codenames only (atlas/vault/argus); the whole U7 diff was scanned clean of fleet identifiers
  (origination's payment-processor hosts are generic/public, intentional).
- **Untracked `.claude/` + `AGENTS.md`** left as-is (pre-existing, every U7 commit explicitly excluded them).
- **PR #35 is on a feature branch, already pushed.** `main` is unchanged this session (no main-push needed).
