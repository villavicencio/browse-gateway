# HANDOFF — 2026-07-14

Fable security-audit session. Under a `/goal` stop-hook — "resolve each fable finding one by one with
adversarial review and commit after approvals until the list is exhausted" — closed the entire Fable
read-only audit: **all 10 findings fixed + committed to `main`**, each landed only after an autonomous
Codex adversarial-review loop returned `approve`. Then resolved the long-standing untracked `AGENTS.md`
loose end (symlink → CLAUDE.md), made an operator call to **track (not fix) a newly-derived #11**, and
compounded **two durable learnings** into `docs/solutions/`. `main == origin/main` at `1381451`; tree
clean; no open PRs.

## What We Built

- **Fable audit — ALL 10 FINDINGS RESOLVED** (`audit/FABLE-AUDIT-REPORT.md`, LOCAL-ONLY/gitignored).
  #1 was fixed pre-loop (2026-07-07); this session closed #2–#10, each via the Claude↔Codex loop to
  `approve`. The "Low/Info"-rated items were the deepest — adversarial review upgraded several to real
  reachable bugs self-review had missed:
  - **#2 — `4006c97`** redact secrets on the drive session-*open* path (the prior handoff's open item #2).
  - **#6 — `69c1ab1`** keep `*.www.<domain>` allowlist rules scoped to the www subtree (canonicalize
    wildcard suffixes www-sensitively; `src/policy/allowlist.ts`). Also a prior open item.
  - **#9 — `5d59330`** reject ill-formed-Unicode slot fields (`assertSlotField`, `src/security/vault-crypto.ts`)
    — the wording pass exposed a real **AAD-injectivity bug**: a lone-surrogate slot field collapses under
    `Buffer.from(v,"utf8").toString("utf8")`, so two distinct slots could share one AAD → cross-slot open.
  - **#4 — `2655ece`** keep oversized credential leaves redactable + harden `redactSecrets`. Found a real
    **"regular expression too large" V8 throw** on big folded values → switched to `String.replaceAll`;
    the reject-at-`put` also introduced (and then fixed) a rotation split-brain regression.
  - **#5 — `bce0774`** redact all smoke-entry output + a full descriptor-based secure serializer
    (`src/gateway/smoke-log.ts` `redactValue()`); `redactSecrets` now folds JSON- and `util.inspect`-escaped
    variants. (10 rounds — the longest loop.)
  - **#3 — `b2b9fb8`** redact the browser core's own stderr + enforce redactability at every ingress.
    Contract change: `BrowserCoreOptions.redact` (opaque fn) → `secrets` (structural
    `{ redactableValues(): readonly string[] }`); `resolveCoreRedactor` unions caller + option-proxy creds
    in ONE longest-first pass; `addRedactableCredential` guards each credential ingress (rejects <3/marker);
    captcha-code allowlist (`CAPTCHA_SOLVE_ERROR_CODES`). (11 rounds.)
  - **#8/#10 — `b0f5025`** vault key-rotation made resumable (decrypt-under-either-key) + guarantees no
    old-key ciphertext survives — 4 survival paths closed (copied non-canonical name, non-canonical stored
    host, symlink/hardlink alias, orphaned `*.vault.json.<hex>.tmp`); #10 = documented offline/exclusive-access
    contract (`src/security/vault-store.ts`).
  - **#7 — `884ab0c`** frame-agnostic-decision unit test + an in-container committed-cross-site-OOPIF
    interception leg (`scripts/validate-redirect-guard.mjs`) + de-vacuumed the worker leg.
  - Two NUL-byte cleanups mid-loop (`ab5fb98`, `f6ec706`) — a stray NUL in a comment/test made git treat
    the files as binary.
- **`AGENTS.md` resolved — `c43945e`** symlinked to `CLAUDE.md` (single source of truth). Closes the prior
  handoff's open item #1; tree is now clean (no untracked files).
- **Two learnings compounded — `1381451`** via `/ce-compound` Lightweight:
  - `docs/solutions/best-practices/redact-before-serialize.md` — redact-BEFORE-serialize discipline: union
    single-pass over actual values (`resolveCoreRedactor`), redactability enforced at the credential ingress,
    `String.replaceAll` not `new RegExp`, escaped-variant folding, structural `BrowserCoreOptions.secrets`.
  - `docs/solutions/architecture-patterns/vault-key-rotation-every-file.md` — rotate enumerated files not
    logical slots; the 4 old-key-survival paths; decrypt-under-either resumability; AAD injectivity; offline
    boundary.
  - Both pass the ce-compound frontmatter + claims validators (0 flags); public-repo-safe.

## Decisions Made

- **#11 (newly derived, NOT one of the original 10): TRACK, do not fix** (operator call). Codex surfaced it
  during the #4 loop — `SecretStore.redactableValues()` is never-forgetting by design, so vault-leaf folding
  + repeated re-captures grow the redaction set unbounded (Low; realistic vaults are small). Its fix is a
  *design tradeoff* (a per-slot redaction lifecycle would WEAKEN never-forget for vault values), not a bug
  fix — revisit only when a deliberate `SecretStore` change is scoped.
- **Landed every fix direct to `main`** (per `authorized-to-push-main`) only after Codex returned `approve`,
  per `codex-review-loop-sop`. Verify-don't-blind-accept: several rounds' findings were checked before fixing.
- **Compounded at Lightweight depth** (operator choice) — single-pass, no research subagents; still
  cross-referenced the existing `vault-observability-redaction-gap.md` and cross-linked the two new docs.
- **`component:`/`root_cause:` off-enum values are fine for knowledge-track docs here** — the repo's own
  `vault-observability-redaction-gap.md` established this, and the ce-compound frontmatter validator enforces
  parser-safety only, not the schema enum.

## What Didn't Work

- **`new RegExp(escapeRegExp(value))` for redaction** — throws V8 "regular expression too large" AT
  EXECUTION on big folded values + recompiles every call. Replaced with `String.replaceAll` (linear, can't
  throw on size). Don't reintroduce a regex-per-secret redactor.
- **`tail -1` to verify a TS build** — masked a compile break (a `*/` inside a JSDoc comment closed the block
  early) that Codex caught in the #3 loop. **Verify builds with `grep 'error TS'`, not `tail -1`.**
- **Plain `--background` for the Codex review harness** — killed by the 2-min shell timeout mid-handshake,
  leaving an orphaned 'running' job with stale status. Run `codex-companion.mjs adversarial-review --wait`
  inside a DETACHED bg task and verify pid + log mtime, not just the status field.

## What's Next

1. **Deploy `main` to prod so the audit hardening goes live.** The 10 fixes are on `main` but prod runs a
   built image — verify the running container's image vs HEAD and, if stale, `gh workflow run deploy-http.yml`
   (gate/smoke/abort will protect the swap). This is defensive hardening; nothing forces urgency, but until a
   deploy the prod process is unhardened. **Confirm before assuming prod is patched.**
2. **#11 stays TRACKED — do not fix** unless a deliberate `SecretStore` redesign is being scoped (see
   Decisions). It's logged in `audit/FABLE-AUDIT-REPORT.md` (LOCAL) and the `fable-audit-resolved` memory.
3. **Carry-over optionals from the prior (warm-up) session, still open:** a TW liveness-probe tool; naming
   `REMEMBER_ME` as the durability mechanism in the solution doc; a `warmup=[...]` line on the http-main boot
   banner. None are blocking.

## Gotchas & Watch-outs

- **`audit/FABLE-AUDIT-REPORT.md` is LOCAL ONLY (gitignored)** — not on origin, won't survive a fresh clone.
  All 10 items are marked FIXED with commits inside it; #11 is the only open item there (tracked, not a bug).
- **The audit hardening is on `main`, not necessarily in prod** — see What's Next #1. Env vars still read at
  container LAUNCH (`launch-http.sh`), so any config also needs a redeploy/restart.
- **Redaction is a redact-BEFORE-serialize discipline now** — if you touch `src/security/secrets.ts`,
  `src/browser/patchright-core.ts`, or any secret-adjacent sink, read
  `docs/solutions/best-practices/redact-before-serialize.md` first. Pass the SecretStore
  (`BrowserCoreOptions.secrets`), never an opaque `redact` fn; register credentials via
  `addRedactableCredential` (guarded) vs `addRedactable` (permissive fragments).
- **Vault key rotation must enumerate real files, not logical slots** — see
  `docs/solutions/architecture-patterns/vault-key-rotation-every-file.md` before touching
  `rotateVaultKey`/`slotFileName`. Rotation assumes offline/exclusive access (no lock).
- **`codex-review-loop-sop`:** for the next substantive change, drive the Claude↔Codex `adversarial-review`
  loop to `approve` before presenting; the gate is the runtime check, not unit tests; commit each fix round.
- **Fleet hygiene (public repo):** never commit prod host/alias/env-path/consumer tokens — the two new
  solution docs were written public-safe on purpose.
- **Prod reads/interactions (SSH, `docker logs`, env greps, deploys) are gated by the auto-mode classifier** —
  operator runs them or authorizes per-session. (One classifier hiccup this session temporarily blocked a
  Bash call; read-only file ops were unaffected.)
