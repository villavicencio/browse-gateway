# HANDOFF — 2026-06-21, late evening

Long session spanning fleet ops → product strategy → a full feature build → merge. Started from a
`/pickup`, cleared the carried-over name-leak scrub, re-registered the **Vault** consumer's MCP,
onboarded a third consumer (**Argus**, the agents project), reframed the product strategy, then
designed, built, reviewed (3 rounds), and **merged issue #21** (proxy-escalation diagnostics +
force-proxy). Everything is merged and pushed — `main` is in sync with origin, no open PRs.

> Fleet detail (real consumer ids, prod host, paths, exact resume commands) stays in agent memory +
> gitignored `*.local.md` — never this file (PUBLIC repo). "Vault" / "Argus" are public-safe consumer
> codenames; "Obscura" is the CLI brand.

## What We Built

- **Issue #21 — proxy-escalation diagnostics + force-proxy: MERGED** (#22 `2b546fe` then #23 `4b7ce50`,
  squash-merged; 5 units, 302 tests).
  - **U2** — IPRoyal sticky `_session-` id 16→8 hex (`randomBytes(4)`), correcting a spec violation.
  - **U1** — shared `classifyBlock` vendor classifier (`src/browser/detect.ts`) + **PerimeterX**
    recognition (`pxHint` mirrors `cfHint`; new `perimeterx-challenge` `BlockReason`).
  - **U3** — structured `EscalationDiagnostics` surfaced to the MCP caller (drive throws
    `EscalationError`, retrieve returns `proxyDiagnostic`); secrets-free by construction + redaction test.
  - **U5** — force-proxy: env **`BGW_FORCE_PROXY_HOSTS`** + per-call `{forceProxy}` MCP option; drive
    fails loud when forced without a proxy.
  - **U4** — opt-in egress probe: env **`BGW_DIAG_VERIFY_EGRESS=1`**, classifies the exit
    residential-vs-datacenter via an ip-info ASN/org lookup.
  - **#22 companion** — fleet-hygiene guard fix (excluded the public "vault" codename from the guard).
  - Plan: `docs/plans/2026-06-21-001-fix-drive-proxy-diagnostics-force-proxy-plan.local.md`.
- **Onboarded Argus (3rd consumer = the agents project).** Bumped prod `BGW_MAX_SESSIONS` 5→7,
  `obscura keys new argus --apply` (✓ healthy), `obscura connect` from the agents project. Roster:
  **atlas, vault, argus**.
- **Re-registered Vault's MCP** — `obscura connect` updated it to the post-rename token (✓ healthy).
- **Scrubbed the remote name leak** — force-pushed clean `main` over the leaked tip.
- **Strategy reframed** (agent memory): the gateway is **internal back-office infra for the operator's
  own future ventures**, not a product sold to outsiders.

## Decisions Made

- **PerimeterX is CLASSIFIED, not CLEARED.** Total Wine's root cause is PerimeterX press-and-hold
  (behavioral) — the token CAPTCHA tier can't solve it. #21 makes the failure legible + steerable;
  defeating PX is a **separate spike**.
- **Egress probe = a policy-approved diagnostics guard** (evolved across 3 review rounds): the
  approved host set is **policy-owned** (`DIAGNOSTICS_EGRESS_HOSTS`, `src/policy/index.ts`), the
  Gateway API exposes only a `{ diagnostics: true }` boolean (no caller-supplied host), matching is
  **exact via `canonicalizeHost`** (no wildcard, no subdomain, no `www`-collapse), and probe
  navigations are audited under the **initiating consumer**.
- **Guard fix shipped as its own PR (#22)**, kept out of the feature PR per the operator's earlier call.
- **IPRoyal sticky id = 8 hex chars** — the documented "precisely 8 alphanumeric" spec; placement on
  the password was already correct.

## What Didn't Work

- **`keys new argus --apply` would have crash-looped the gateway** (3rd consumer trips the
  `consumers·perConsumerMax+1` boot floor above `BGW_MAX_SESSIONS=5`). Avoided by bumping
  `BGW_MAX_SESSIONS` 5→7 *first*, then minting.
- **Caller-supplied diagnostics host (P2)** — `guardForDiagnostics("*")` would have blanket-bypassed
  the allowlist. Replaced with a policy-owned exact set + boolean flag.
- **`normalizeHost` for the diagnostics match (P3)** — it strips a leading `www.`, so `www.ipinfo.io`
  satisfied a literal `ipinfo.io`. Switched to `canonicalizeHost`.

## What's Next

1. **Deferred #21 follow-ups:** the PerimeterX-defeat spike (gesture automation / fingerprint
   coherence); the audit-log `diagnostics` field; a per-call `{verifyEgress}` MCP option + a
   retrieve-path egress probe.
2. **Operator-only — IPRoyal monthly → PAYG** (dashboard). Non-breaking for the gateway: fund the PAYG
   balance before cancelling to avoid a traffic gap, then re-verify the 3 `BGW_PROXY_*` creds.
3. **Pool-sizing for many-consumer onboarding:** if wiring up several more CC projects, switch
   `perConsumerMax` 2→1 + `maxSessions` 8 once (supports ~7 consumers under the ~4 GB OOM-safe ceiling)
   rather than bumping `maxSessions` per consumer. At `perConsumerMax=2`, a 4th consumer needs floor 9.
4. **Strategy threads:** sketch **venture #1** (the general-contractor idea) to pull real gateway
   requirements; the Obscura **TUI** design session (operator-gated — do not start unprompted).

## Gotchas & Watch-outs

- **`BGW_MAX_SESSIONS=7`** (floor exactly met at 3 consumers). A 4th consumer crosses the floor — bump
  it (or drop `perConsumerMax`) in the same change, or the boot guard crash-loops every consumer.
- **New env vars** (safe defaults / off): `BGW_FORCE_PROXY_HOSTS` (comma host-suffix list),
  `BGW_DIAG_VERIFY_EGRESS=1` (opt-in egress probe — one extra proxied request per failure).
- **Agent can't push `main`** (auto-mode classifier) — the operator pushes / merges.
- **Drive live-gate validator is flaky** on its idle-reaper check (baseline, pre-existing — noted by
  the reviewer; not caused by the #21 work).
- **Coded language in force:** "vault" / "argus" are public codenames; real ids + paths live only in
  agent memory + `*.local.md`.
- **Untracked `.claude/` + `AGENTS.md`** left as-is (pre-existing).
