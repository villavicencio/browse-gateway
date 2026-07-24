# HANDOFF — 2026-07-24

## Epic #78 (post-#38 regression follow-ups) — **COMPLETE + CLOSED**

All four children shipped to `main` and merged; epic #78 closed; no open issues remain. Prod is
**UNCHANGED** — nothing from this epic is deployed (deploy is operator-hand item #1).

| Ticket | What shipped | PR | squash on main |
|---|---|---|---|
| **R1 #79** (keystone) | warm cross-host nav → typed `owner-host-mismatch` result, refused **before the wire**, session preserved | #83 | `ed99400` |
| **R2 #80** (foundation) | `policy-blocked` FailureClass for a self-inflicted main-frame `ERR_BLOCKED_BY_CLIENT`; no re-roll; decision-safe guard-reason side-channel | #84 | `07f181e` |
| **R3 #81** | evidence-driven `warmFailureAdvice` mapper (`#warmError` matches the evidence, not host config) | #85 | `4e452a2` |
| **R4 #82** | shape-invariant PerimeterX on the drive path (`pxCopy` + `navFailed (pxHint && pxCopy)` arm) | #86 | `dfa1a74` |

**main tip after this handoff = the handoff commit** (docs-only; `prodDeployNeeded:false`). Full suite **878**
green on main. All in-container gates PASS: `validate-owner-host` (R1), `validate-policy-block` (R2),
`validate-drive-pxcopy` (R4), plus regression: `validate-policy` (guard refactor), `validate-drive`,
`validate-vault-warm-open`, `validate-frame-capture`.

## What each change actually does (30-sec)

- **R1** — the clamp already *forbids* a warm cross-host nav; the bug was only in the *handling* (discard +
  mis-diagnose). Pre-flight refusal returns a typed `owner-host-mismatch` before `core.navigate`, so the
  clamp is never tripped and the warm context (with its live PX clearance) survives. Changes the *response*,
  never the clamp's *decision* (`policy/index.ts` untouched). Added the "one warm session = one owner host"
  note to the `browser_navigate` MCP tool description.
- **R2** — a main-frame `ERR_BLOCKED_BY_CLIENT` is always the gateway's own guard. Captured top-frame-scoped
  (`req.frame()===mainFrame()`) as `policy-blocked` (top precedence); never escalates/re-rolls; **preserves
  the healthy session** on every failure surface (pinned / warm-open / cold-first-nav / forced-escalation /
  action). The guard's reason rides a **decision-safe write-only out-param** (`NavigationBlockInfo`) that can
  never influence the fail-closed decision; scrubbed at every seam (R9). The 3 guards' block paths were DRY'd
  into one `#navBlock` helper (behavior-preserving — the nav-guard/policy gates pass unchanged).
- **R3** — `warmFailureAdvice(evidence)` (pure, in `observability/warm-advice.ts`) branches on the envelope's
  `failureClass`/`wafVendor` + the fresh-exit flag: a **live PerimeterX** press-&-hold now says "a fresh exit
  won't clear it, a retry re-triggers it" instead of the old host-config-only "draw a clean exit" / "re-capture".
- **R4** — drive `#snapshotOf` derives a scrubbed `pxCopy` from the child-frame walk (gated on `pxHint`), and
  `navFailed` gains `(pxHint && pxCopy)` — so a FAT-top-frame PX (challenge in a cross-origin child frame)
  classifies identically to a thin one. NOT added to `shouldEscalateDrive` (behavioral ≠ IP-reputation).

## ⚠️ Pieces that need the operator's hand

1. **Prod deploy + smoke test (item #1).** Nothing here is deployed. Deploy: `gh workflow run deploy-http.yml
   -f image_tag=latest`. Smoke: `obscura status` healthy, then a warm cross-host attempt returns the typed
   `owner-host-mismatch` result (not a credential/exit error) and the owner-host context survives.
2. **Live end-to-end re-run of the original Atlas regression sequence** (Total Wine warm → Costco cross-host →
   return to Total Wine), against the real sites — the autonomous gates used controlled loopback fixtures, so
   the real-world confirmation is a daytime/operator item.
3. **R1's consumer-facing "open a new drive session per host" note** — added in-repo to the `browser_navigate`
   description; if the fleet agents need their driving pattern updated, that's a fleet action, not code.
4. **Confirm the credential owner-host spelling (apex vs www)** for R2's cold path (minor; strategy §7.3).
5. **R5 (fast-terminal a detected behavioral challenge)** remains an **unfiled stretch** (latency-only; not one
   of the three genuine defects). File + build only if the ~45 s clearance-poll waste on a detected
   press-&-hold is worth reclaiming.

## Review journey (worth knowing)

- **Codex hit its usage limit mid-epic** (during R2's round 5, rate-limited until ~Jul 29). R2 had already
  been through **4 completed Codex rounds** (each finding real policy-block-honoring gaps, all fixed at
  source). For the round-5 confirmation and for R3/R4, review was done by **independent adversarial Workflow /
  verification-agent passes** — which caught a real regression the 4 Codex rounds missed (the retrieve
  mixed-exhaustion swap discarding a `policy-blocked` final render). Lesson: the multi-lens adversarial
  workflow is a viable Codex substitute; even a convergent Codex loop leaves a tail.
- The R4 gate needed a **source-only** challenge-copy fixture (comment/canvas, not accessible text) because
  Playwright's `ariaSnapshot` stitches cross-origin OOPIF accessible text into the top tree — see the
  solution doc.

## Prod state (UNCHANGED)

Prod `sha256:4becdf0a` = git `978cc89`. Rollback anchor `sha256:961e149d`. `#53` health surface live
(`obscura status` → pool healthy). Nothing from epic #78 built into a deployed image.

## Learnings compounded (this session)

- `docs/solutions/architecture-patterns/self-inflicted-refusal-classify-dont-discard.md` (R1+R2).
- `docs/solutions/architecture-patterns/drive-retrieve-shape-invariant-pxcopy.md` (R4 + the aria-OOPIF gate trap).

## Local context

Strategy doc (gitignored): `docs/plans/2026-07-23-001-post-38-recovery-and-diagnosis-honesty-strategy.local.md`.
Memory `[[post-38-regression-recovery-strategy]]`. Public-repo hygiene held (no fleet/consumer/retailer names
in code, commits, or issue comments).
