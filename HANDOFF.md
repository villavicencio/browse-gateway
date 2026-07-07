# HANDOFF — 2026-07-07 (Tuesday, later)

Pre-Fable session. Goal was to vet an AI-code-audit rubric (from a deep-research report, targeting a
"NextToken" web app) before spending scarce Fable 5 budget on an autonomous audit of this repo. Outcome:
the rubric was a poor fit and a low-yield use of Fable, so instead we ran a **targeted, read-only,
3-surface security audit** on this session's model (free), fixed the one finding worth fixing, pushed it,
and handed the actual high-value work — the warmup-nav build — off to a fresh Fable session. `main ==
origin/main` at `feef3de`; no open PRs.

## What We Built

- **Fix #1 — sticky-proxy suffix now redactable (`9a999ea`, pushed to main; 518/518 green).**
  `mintStickyProxy` appends `suffix.replaceAll("{id}", <8hex>)` to the base `BGW_PROXY_PASSWORD`, but only
  the base was in the redaction set — so a driver error echoing the full minted password would leak the
  residential provider's param structure (`_country-us_session-<id>_lifetime-30m`) past `redactSecrets`.
  Added `stickySuffixRedactables()` in `src/verbs/retrieve.ts` (the literal non-`{id}` fragments) and
  folded it into the `SecretStore` at boot in **both** entrypoints (`src/mcp/runtime.ts`, `src/mcp/main.ts`).
  A leaked minted password now redacts to `[REDACTED][REDACTED]<id>[REDACTED]`; only the ephemeral
  per-attempt exit id survives. Tests in `test/security-boundary.test.mjs` (mint→leak→redact +
  degenerate-suffix guard).
- **`chore: gitignore audit/` (`feef3de`, pushed).** Security audit reports map the gateway's security
  surfaces — kept local like the other public-repo exclusions.
- **Read-only security audit → `audit/FABLE-AUDIT-REPORT.md` (LOCAL ONLY, gitignored).** Three independent
  adversarial passes (parallel subagents): (1) secret redaction/leakage, (2) allowlist/nav-guard bypass,
  (3) vault-crypto AAD injectivity. **Verdict: no Critical/High on any surface.** 10 findings, all
  Low/defense-in-depth/coverage-gap. The two genuinely-new signals: #1 (fixed above) and #2 (see What's
  Next). Vault AAD confirmed length-prefixed/injective; allowlist clamp confirmed a true intersection;
  redaction core confirmed verbatim+URL-encoded. Report has the full table + "verified clean" record.
- **Sanitized rubric + Fable paste (scratchpad, not in repo).** Rewrote the web-app rubric into a
  read-only, project-scoped instruction set; prepared the warmup-nav kickoff prompt for a fresh Fable
  session (points at the plan, pins the 3 guardrails, mandates the runtime gate + codex-review loop).

## Decisions Made

- **Don't spend Fable on a generic audit.** A read-only checklist doesn't need Fable's systems-reasoning
  edge, and the security paths already went through the codex-review loop (low marginal yield). Ran the
  audit on this session's model for free; **saved Fable for the warmup-nav build** (new code = where the
  premium reasoning pays). Kicked that off in a **fresh** Fable session (clean context, not this one).
- **Read-only, report-only — no auto-fix — for any audit here.** "Strictly non-breaking fix" is undecidable
  for an autonomous agent in this repo: ~10 deliberate stealth patterns look like bugs (swallowed
  `page.goto` catches, non-frozen nav status, clearance polling, IP-bound token stripping…) and ~12
  crypto/auth/boundary files fail silently on a wrong "fix." The sanitized rubric routes those to human
  review.
- **Fix #1 = bounded boot-time fragment registration, NOT per-request folding of the minted password.**
  Folding every minted password would grow the redaction set for the process lifetime AND break R3:
  `verifiedHeldExit` (`src/verbs/drive.ts:78`) byte-compares the minted password to re-pin a held exit, so
  the mint output must not be touched. Boot-time fragments touch neither the mint output nor the compare.

## What Didn't Work / Ruled Out

- **Handing the raw rubric to Fable.** Written for a web app (React/SQL/JWT/CORS/IDOR) — all confirmed
  absent here; half the passes would burn Fable budget searching for surfaces that don't exist.
- **Folding the whole minted proxy password into the redaction set** — unbounded growth + not R3-safe (see
  the fix-#1 decision above).

## What's Next

1. **Warmup-nav build — IN PROGRESS on a fresh Fable session.** Move warmup navigation server-side into
   warm-open: on opening a warm session, navigate the host root (clears PX) THEN the requested target.
   Plan: `docs/plans/2026-06-24-001-warmup-navigation-plan.local.md`. Guardrails (from this session's
   audit): stay fail-closed (R3), keep the single-host owner clamp, reuse the existing clearance
   detection/poll (don't add a parallel path). Verify via `npm run validate:vault-warm-open` +
   `test/fresh-exit-warm.test.mjs` + `test/drive-controller.test.mjs`, and drive the codex-review loop to
   `approve`. **On next pickup: check for a new branch/PR from the Fable session.**
2. **Audit follow-up #2 (RECOMMENDED after warmup-nav): wrap drive session-*open* / `fail()` in
   `redactSecrets`.** Session open (`openConsumerSession` → launch + warm-cookie restore) is outside the
   controller's `#run` scrub (`src/mcp/server.ts`, `src/gateway/index.ts:160`); it's neutralized *today*
   only by a static re-wrap in `session-manager.ts:111` — fragile to one refactor. Small, non-breaking.
   Details in `audit/FABLE-AUDIT-REPORT.md` #2.
3. **Audit follow-up #6: one-line guard so a `*.www.<domain>` allowlist rule isn't www-stripped into
   `*.<domain>`** (`src/policy/allowlist.ts:40`) — or lint it. Operator-authored config footgun, Low.
4. **Decide on untracked `AGENTS.md`** — public-safe near-dupe of the CLAUDE.md project instructions,
   untracked across several sessions. Commit or remove. (Unchanged loose end.)
5. **Weigh whether TW warm-open is worth the build** — TW login is a short-lived `twSessionId`
   (localStorage, ~hours), no durable refresh token, so a capture is only good for a few hours.

## Gotchas & Watch-outs

- **The audit report is LOCAL ONLY** (`audit/` is gitignored) — it is NOT on origin and won't survive a
  fresh clone. It lives at `audit/FABLE-AUDIT-REPORT.md` on this Mac.
- **Don't "simplify" fix #1 by folding the whole minted password** — that reintroduces the unbounded-set
  problem and breaks the R3 byte-compare in `verifiedHeldExit` (`src/verbs/drive.ts:78`). The redaction is
  deliberately fragment-only; the residual 8-hex exit id is ephemeral/non-credential.
- **Other audit findings (all Low, in the report):** vault key-rotation split-brain on a mid-crash
  (documented residual, availability-only), OOPIF interception has no test fixture (tracked in MEMORY),
  `errCode` browser-core stderr has no `SecretStore` plumbing, smoke entrypoint prints raw error. None
  attacker-reachable-to-credential-disclosure.
- **"Is the gateway down?" is almost always the local `:8080` tunnel** — verify the container +
  `curl 127.0.0.1:8080/mcp` (401 = healthy) before touching anything. Self-healing keeper should recover
  on its own within ~1–2 min of a network return.
- **Prod reads (SSH, `docker logs`, env-file greps) are gated by the auto-mode classifier** — operator
  runs them, or authorizes the agent per-session.
- **Replay a TW capture FAST** — check `twSessionExpiration` before concluding a logged-out warm-open is a
  bug. **`validate-warm*.mjs` classify login on the landing URL/title** (`/login` "Login My Account" vs
  `/my-account` "Account Home"), not body text.
- **Fleet hygiene (public repo):** never commit prod host/alias/env-path/consumer tokens. The audit report
  and Fable paste use placeholders on purpose.
- Local `main == origin/main` (`feef3de`); no open PRs; only untracked `AGENTS.md`.
- **Memory note:** `operator-traveling-low-bandwidth-2026-06-28` is stale (return date 2026-07-03 passed) —
  safe to delete on the next memory pass.
