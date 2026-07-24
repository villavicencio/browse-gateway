# HANDOFF — 2026-07-23, evening

## Mission for the next session (Opus, autonomous)

**Implement epic #78 end-to-end and present the operator with the pieces that need their hand at the
end.** Order: **R1 #79 (keystone) → R2 #80 → R3 #81 → R4 #82** (R3 after R2; R4 independent). Drive each
through the Codex review loop, gate it, merge it. Run autonomously — do **not** stop for check-ins except
the explicit HOLD conditions below.

Planning + ticketing were done by Fable (this session); the operator switched models so **Opus executes the
build**. Everything you need is in the GitHub issues + the local strategy doc — you should **not** need to
re-explore the codebase to start.

## What this epic is (30-second version)

A post-#38 regression validated the legibility/durability layer but exposed a self-inflicted mechanism: a
warm (credentialed) drive session pins **one** browser context clamped to **one owner host**. Navigating a
*different* host trips the gateway's own owner-host clamp (→ `ERR_BLOCKED_BY_CLIENT`), and the controller
**mistakes that self-refusal for a dead exit and destroys a still-valid session**, then mis-diagnoses it as a
credential expiry. Three genuine defects, **none of which defeats a WAF or loosens the clamp**: graceful
owner-host contract (R1), diagnosis honesty (R2+R3), failure-class consistency (R4). **Ratified contract:
one warm drive session = one owner host** — a cross-host nav returns a *typed owner-host-mismatch result*
directing the caller to open a separate session.

## Specs & grounding (read these first)

- **Issues #78 (epic) + #79–#82** — each child carries its problem, the load-bearing `file:line` seams, the
  fix approach, guardrails, and an acceptance gate.
- **Strategy doc (local, gitignored):**
  `docs/plans/2026-07-23-001-post-38-recovery-and-diagnosis-honesty-strategy.local.md` — §2 the verified
  causal chain, §4 the full per-ticket spec, §6 guardrails, §9 risks/invariants. **Grounded at `eeab28b` —
  grep the named symbols if line numbers drifted.**
- **Memory** `[[post-38-regression-recovery-strategy]]` has the compressed version.

## Per-ticket one-liners (full spec in the issue + doc §4)

- **R1 #79 (keystone):** pre-flight owner-host check on the pinned/warm branch (`drive-controller.ts:435-442`);
  if `canonicalizeHost(target) !== #warmHost`, return a **typed `owner-host-mismatch` result with its own
  failure class** (not `nav-failed`) *before* `core.navigate`, and do **not** `#discardSession`. Sub-case:
  in-allowlist-≠-owner → "open a new drive session for `<host>`"; off-scope → "out of scope."
- **R2 #80 (foundation):** capture a main-frame `ERR_BLOCKED_BY_CLIENT` as a `policy-blocked` class at the
  interception layer (`patchright-core.ts:928-945`), threading the guard's block reason out of the audit-only
  path (`policy/index.ts:290`) via a decision-safe side-channel; a `policy-blocked` failure never suggests a
  fresh exit and never escalates. Must be **top-frame-scoped** (`req.frame()===page.mainFrame()`).
- **R3 #81 (depends on R2):** pass the evidence envelope into `#warmError` (`drive-controller.ts:816-844`) and
  branch the message on `failureClass`/`wafVendor`/`networkFailures` via a pure `warmFailureAdvice(evidence)`
  mapper. Keep the stale-vs-fresh split; add the policy-block + live-behavioral branches.
- **R4 #82 (independent):** parity-port retrieve's shape-invariant PX arm to drive — capture a scrubbed
  `pxCopy` boolean in `#snapshotOf` (`patchright-core.ts:1584-1668`, gated on `pxHint`), add
  `(pxHint && pxCopy)` to `navFailed` (`drive.ts:131-140`). Do **not** add PX to `shouldEscalateDrive`.

## Build order & working agreements (mandatory)

1. **`colima start --vm-type vz --vz-rosetta`** — it is **STOPPED**. Required for the in-container gate.
2. Per ticket: branch (`feat/79-owner-host-mismatch`, etc.) → implement → **Codex loop until clean** → **run
   the in-container runtime gate** → PR with `Closes #N` → **merge** (squash, delete branch) → tick the #78
   checklist.
3. **Codex loop:** `codex exec review --base main`, **detached** (`nohup … &` + a `kill -0` watcher — it
   routinely exceeds the 600 s Bash cap). **Verify-don't-blind-accept**; commit each fix round; the gate is
   the **runtime check, not unit tests**. If Codex re-flags an out-of-scope change every round, fix in-scope,
   document the scoped-out item, and present.
4. **Merge authority:** you are authorized to merge green + Codex-clean PRs and to push main when safe. Never
   merge red/unreviewed.
5. When all four merge, **write a fresh HANDOFF** summarizing what shipped + the operator-hand items.

## HOLD conditions & autonomy boundaries

- **Do NOT deploy to prod.** All four enter the image, but deploying prod-runtime changes is operator-gated
  (and full live validation can't be done autonomously). Merge to main; leave deploy as operator-hand item #1.
- **Do NOT loosen the owner-host clamp** (`policy/index.ts:236-298` — a no-exfil security boundary). R1 changes
  the *response* to a block, never the *decision*. If a fix would touch the clamp's decision, **HOLD + present.**
- **Do NOT depend on live retail / adversarial sites for gates.** Validate deterministically: `detect.ts` is
  pure and R3's mapper is fully unit-testable; for R1/R4's runtime gate use **controlled hosts / local fixture
  pages** (mirror the `scripts/validate-*.mjs` harness pattern; the R1 fixture is a warm session pinned to a
  controlled host A + a cross-host nav to host B; the R4 fixture is a page with a child iframe carrying the
  challenge copy). Live end-to-end confirmation against the real sites is an operator/daytime item.
- **R1 is the sensitive one:** its acceptance gate (owner-host clamp still blocks the off-owner nav **AND** the
  host-A context is preserved + still cleared on return) is a **hard merge precondition**. If it can't be
  validated in-container, **HOLD #79 and present** rather than merge.
- **HOLD + present (don't merge)** if any runtime gate can't be validated, or a change turns out to need a
  product/security call.
- **Public repo** — no fleet/agent/consumer/target-retailer names in code, commits, or issue comments (the
  concrete run detail stays in the gitignored strategy doc).

## Pieces likely to need the operator's hand (collect for the end)

1. **Prod deploy + smoke test** of the merged epic. Deploy: `gh workflow run deploy-http.yml -f
   image_tag=latest`. Smoke: `obscura status` healthy, then a warm cross-host attempt returns the typed
   `owner-host-mismatch` result (not a credential/exit error) and the owner-host context survives.
2. **Any in-container gate that couldn't run** (if the browser/container path blocks R1/R4 validation) —
   present exactly what's blocked and why.
3. **R1's consumer-facing "open a new drive session per host" note** — if it implies a change to how the
   calling agents drive, that's a fleet action, not code.
4. **Confirm the credential owner-host spelling (apex vs www)** for R2's cold path (minor; strategy doc §7.3).
5. **Live end-to-end confirmation** against the real sites (the original cross-host regression sequence), if
   the operator wants it re-run.

## Prod state (UNCHANGED)

Prod `sha256:4becdf0a` = git `978cc89`. Rollback anchor `sha256:961e149d`. **Nothing from this epic is built
or deployed.** `#53` health surface is live (`obscura status` → `pool healthy — force-kill armed, 0/7
sessions`). main tip after this handoff = the handoff commit (docs-only, `prodDeployNeeded:false`).

## What just happened (this session — Fable)

`/pickup` (epic #38 confirmed complete) → operator shared an Atlas regression test → I grounded the four
findings in code (5 parallel Opus tracers + hand-verified the keystone chain) and found **findings #1/#2/#4
are one self-inflicted session-loss mechanism, #3 a separate drive↔retrieve PX detection-parity gap** →
wrote the strategy doc → operator **confirmed the three env facts** (Total Wine warm+fresh-exit+in-scope; no
Costco credential, Costco off-scope → cross-host scope violation; no `browser_close` between) and **ratified
the one-warm-session-one-owner-host contract** → **filed epic #78 + R1–R4 (#79–#82)**, host-agnostic for the
public repo, R5 (fast-terminal, latency-only) a stretch note in the epic.
