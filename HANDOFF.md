# HANDOFF — 2026-06-21

Long working session spanning fleet ops → strategy → a full feature build. Cleared the carried-over
name-leak scrub, re-registered the **Vault** consumer's MCP, onboarded a new third consumer
(**Argus**, the agents project), reframed the product strategy, and implemented **issue #21**
(proxy-escalation diagnostics + force-proxy) end-to-end — now MERGED to `main` (PRs #22 + #23).

> Fleet detail (real consumer ids, prod host, paths, exact resume commands) stays in agent memory +
> gitignored `*.local.md` — never this file (PUBLIC repo). "Vault" and "Argus" are public-safe
> consumer codenames; "Obscura" is the CLI brand.

## What We Did

- **Scrubbed the remote (carried-over item #1): DONE.** Force-pushed the clean local `main` over the
  leaked tip — `origin/main` no longer carries the leaked commit (verified: not reachable from any
  remote branch). GitHub may retain the dangling object by SHA for a while (low risk — it was a
  consumer codename, not a credential).
- **Re-registered Vault's MCP: DONE.** `obscura connect` from Vault's project dir → registration
  `updated` to the post-rename token, `✓ connected as vault · gateway healthy`.
- **Onboarded Argus (3rd consumer = the agents project): DONE.** Bumped prod `BGW_MAX_SESSIONS` 5→7
  (3 consumers × perConsumerMax 2 + 1 = floor 7), `obscura keys new argus --apply` (✓ healthy), then
  `obscura connect` from the agents project (`added`, ✓ healthy). Roster now **atlas, vault, argus**.
- **Implemented + MERGED issue #21 — proxy-escalation diagnostics + force-proxy.** Both PRs squash-
  merged to `main` (#22 = `2b546fe`, #23 = `4b7ce50`); 5 units, 302 tests.
  - **#23** (feature): U2 IPRoyal sticky-id 16→8 chars · U1 shared `classifyBlock` + PerimeterX
    recognition · U3 structured `EscalationDiagnostics` to the MCP caller (secrets-free + redaction
    test) · U5 force-proxy (`BGW_FORCE_PROXY_HOSTS` + `{forceProxy}`) · U4 opt-in egress probe
    (`BGW_DIAG_VERIFY_EGRESS`).
  - **#22** (companion): fleet-hygiene guard fix (excluded the public "vault" codename from the guard).
  - **3 review rounds, all resolved (final re-review: no findings):** P1 (egress probe rode the
    consumer allowlist → policy-approved diagnostics guard), P2 (caller-supplied host / flat audit →
    policy-owned exact host set + `{ diagnostics: true }` boolean + consumer-attributed audits),
    P3 (`www.ipinfo.io` satisfied a literal `ipinfo.io` → `canonicalizeHost`, no www-strip).
  - Plan: `docs/plans/2026-06-21-001-fix-drive-proxy-diagnostics-force-proxy-plan.local.md`.
- **Strategy reframed** (captured in agent memory): the gateway is **internal back-office infra for
  the operator's own future ventures**, not a product sold to outsiders.

## Decisions

- **PerimeterX is CLASSIFIED, not CLEARED.** The Total Wine failure root cause is PerimeterX
  press-and-hold (behavioral) — the token CAPTCHA tier can't solve it. #21 makes the failure legible
  (structured `perimeterx-challenge` diagnostic) and steerable (force-proxy, egress check) but does
  not defeat PX. Defeating it is a **separate spike** (gesture automation / fingerprint coherence).
- **Two PRs, not a default-branch push.** The guard fix is kept out of the #21 PR (operator's earlier
  call) and the agent is classifier-blocked from pushing `main`, so it became its own PR (#22) rather
  than a direct commit to main.
- **IPRoyal sticky id = 8 hex chars** (`randomBytes(4)`), correcting a 16-char code bug that violated
  IPRoyal's "precisely 8 alphanumeric" spec. Password placement was already correct.

## What's Next

1. **Push this handoff commit to `main`** — the only remaining git action (agent main-push is gated):
   `git push origin main`. #21 + #22 are already merged; `main` is otherwise in sync with origin.
2. **Operator-only:** switch IPRoyal monthly → PAYG (dashboard action). Non-breaking for the gateway —
   fund the PAYG balance before cancelling to avoid a traffic gap, then re-verify the proxy creds.
3. **Open: pool-sizing for many-consumer onboarding.** If wiring up several more CC projects, switch
   `perConsumerMax` 2→1 + `maxSessions` 8 once (supports ~7 consumers under the ~4 GB OOM-safe ceiling)
   instead of bumping `maxSessions` per consumer. At perConsumerMax=2, a 4th consumer needs floor 9.
4. **Deferred #21 follow-ups:** the PerimeterX-defeat spike; audit-log `diagnostics` field; per-call
   `{verifyEgress}` MCP option + a retrieve-path egress probe.
5. **Strategy threads:** sketch venture #1 (the general-contractor idea) to pull real requirements;
   the Obscura **TUI** design session (operator-gated — do not start unprompted).

## Gotchas & Watch-outs

- **Agent can't push `main`** (auto-mode classifier) — operator pushes main / merges PRs.
- **`BGW_MAX_SESSIONS=7` now** (floor exactly met at 3 consumers). Adding a 4th crosses the floor —
  bump it (or drop `perConsumerMax`) in the same change, or the boot guard crash-loops every consumer.
- **New env vars** (both safe defaults / off): `BGW_FORCE_PROXY_HOSTS` (comma host-suffix list),
  `BGW_DIAG_VERIFY_EGRESS=1` (opt-in egress probe — costs one extra proxied request per failure).
- **Coded language in force:** "vault" / "argus" are public codenames; real ids + paths live only in
  agent memory + `*.local.md`.
- **This handoff is committed locally on `main` but not pushed** (agent main-push is gated) — push it
  yourself, ideally after merging #22/#23 to avoid a divergence.
- **Untracked `.claude/` + `AGENTS.md`** left as-is (pre-existing).
