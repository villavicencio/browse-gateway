# HANDOFF — 2026-07-24, afternoon

Autonomous Opus run: implemented **epic #78** (owner-host contract + diagnosis honesty, the post-#38
regression follow-ups) end-to-end — R1→R2→R3→R4, each through review + in-container gate + merge. All four
shipped and the epic is closed. Then the operator reset Codex usage and I re-ran per-ticket Codex reviews of
the *merged* code (Codex had been rate-limited mid-R2), which surfaced **5 real follow-up defects** that the
in-line verification agents had missed. Those 5 are the live work; nothing is deployed.

## What We Built

- **R1 #79** (PR #83, squash `ed99400`) — warm cross-host nav → typed `owner-host-mismatch` result, refused
  **before the wire** (pre-flight in `#navigate`'s pinned branch, `drive-controller.ts`); the warm context +
  its live PX clearance survive. Clamp (`policy/index.ts`) untouched — changes the *response*, not the
  *decision*. Added the "one warm session = one owner host" note to the `browser_navigate` MCP description.
- **R2 #80** (PR #84, `07f181e`) — new `policy-blocked` `FailureClass` for a self-inflicted main-frame
  `ERR_BLOCKED_BY_CLIENT`, captured top-frame-scoped (`req.frame()===mainFrame()`), top precedence, no
  re-roll; **preserves the healthy session** on every failure surface (pinned/warm-open/cold-first-nav/
  forced-escalation/action). Guard reason rides a decision-safe write-only out-param (`NavigationBlockInfo`);
  scrubbed at every seam (R9). The 3 guards' block paths DRY'd into one `#navBlock` helper.
- **R3 #81** (PR #85, `4e452a2`) — pure `warmFailureAdvice(evidence)` mapper (`observability/warm-advice.ts`);
  `#warmError` delegates to it so a live PerimeterX press-&-hold is told "a fresh exit won't clear it" instead
  of host-config's "draw a clean exit"/"re-capture".
- **R4 #82** (PR #86, `dfa1a74`) — drive `#snapshotOf` derives a scrubbed `pxCopy` from the child-frame walk
  (gated on `pxHint`); `navFailed` gains `(pxHint && pxCopy)` so a fat-top-frame PX classifies like a thin one.
- **Docs (`4ce3eff`)**: 2 compounded learnings (`self-inflicted-refusal-classify-dont-discard`,
  `drive-retrieve-shape-invariant-pxcopy`) + the prior handoff. Epic #78 closed on GitHub.
- **878 unit tests** on main; all in-container gates green (`validate-owner-host`, `validate-policy-block`,
  `validate-drive-pxcopy`, + regressions). New gates: `scripts/validate-policy-block.mjs`,
  `scripts/validate-drive-pxcopy.mjs`. New unit suites: `test/policy-blocked.test.mjs` (16),
  `test/warm-advice.test.mjs` (5), `test/px-copy-drive.test.mjs` (3), `test/owner-host-mismatch.test.mjs` (6).

## Decisions Made

- **Ratified contract enforced: one warm drive session = one owner host** (R1). A cross-host nav is an
  *expected scope rejection*, not a failure — refuse cleanly, never discard.
- **A self-refusal is a scope decision to surface, not an exit-death to recover from** (R1+R2 theme). Classify
  it before the destructive path; preserve the healthy session everywhere.
- **Decision-safe side-channel** for the guard reason: a *write-only* out-param the fail-closed decision never
  reads. Kept the security invariant intact while surfacing the reason.
- **Codex rate-limited mid-R2 → substituted independent adversarial Workflow / verification-agent reviews.**
  They caught a real regression the 4 completed Codex rounds missed (retrieve mixed-exhaustion swap hiding the
  class) — but they are NOT a full Codex substitute (see What Didn't Work).
- **R4 scope = parity with retrieve, not a new poll.** Deliberately did NOT touch `shouldEscalateDrive` (a
  behavioral challenge is IP-independent).

## What Didn't Work

- **Single verification agents are not a Codex substitute.** For R3 and R4 the focused verification agents
  each returned "CLEAN" — Codex's later re-review found **real defects in both**. Lesson: a convergent Codex
  loop still leaves a tail, and one adversarial agent misses what a different reviewer catches; use multiple,
  independent passes.
- **R4 gate fixture, first two attempts.** A same-origin, then a cross-origin *accessible-text* child iframe
  both failed the gate: Playwright's `ariaSnapshot` **stitches even cross-origin OOPIF accessible text** into
  the top tree, so `isVisiblyBlocked` caught the copy and `pxCopy` wasn't load-bearing. Fix that worked: put
  the challenge copy in the child-frame **source only** (HTML comment + a canvas widget) — matches the real
  press-&-hold shape. (Documented in the pxcopy solution doc.)

## What's Next

**→ Follow-up PR for the 5 post-merge Codex findings (nothing deployed — pre-deploy is the time to fix).**
Prioritized:

1. **R3 behavioral-gating [clear mis-advice, do first]** — `warm-advice.ts:52` fires the behavioral branch on
   `wafVendor===perimeterx`, which also comes from a *persistent* pxHint marker on a burned-exit 403. A
   fresh-exit host then gets "a fresh exit won't clear it" when a fresh exit *would* help. Fix: thread a
   `behavioralChallenge` flag (`snap.pxHint && snap.pxCopy`, now available post-R4) into `WarmFailureEvidence`
   and gate the branch on it, not on vendor attribution.
2. **R4 P1 late-loading iframe** — `#snapshotOf`'s one-shot `captureChildFrameHtml` can read a *blank* child
   frame if the PX iframe loads after DCL → `pxCopy` false → the challenge slips through again. Retrieve has
   the **identical** one-shot limitation, so this is parity-inherited; the fix (bounded poll of the marked
   child frame before finalizing) should land on BOTH paths and be gated on `pxHint` so healthy pages don't
   pay it. Higher-touch (hot `#snapshotOf` path) — bound the poll carefully.
3. **R2 concurrency correlation** — `patchright-core.ts:~979` `#lastNavBlock` is one context-wide slot keyed
   only by host; concurrent Document blocks (main-frame redirect + iframe/popup) can overwrite it before the
   `requestfailed` fires, mis-attributing owner-host vs origination. Fix: key by frame/request identity.
4. **R3 transport failures** — a conn-reset/timeout (`nav-failed`) on a non-fresh warm host defaults to
   "re-capture credential". Thread `genuineNetworkFailure(networkFailures)` into the mapper → advise
   retry/transport, not re-capture. (Pre-existing behavior R3 can now improve.)
5. **R4 P2 formatSnapshot** — `formatSnapshot()` renders `pxHint` but not `pxCopy`, so a standalone
   `browser_snapshot` of an async PX challenge hides the live signal. Trivial: render `pxCopy` in the header.

**Then — operator-hand items (unchanged):** (a) **prod deploy + smoke** — `gh workflow run deploy-http.yml -f
image_tag=latest`, then `obscura status` + a warm cross-host attempt; (b) **live re-run** of the original
Atlas sequence (Total Wine → Costco → back) against the real sites (gates used loopback fixtures); (c) confirm
R2 cold-path apex-vs-www spelling; (d) R5 fast-terminal is an unfiled latency-only stretch.

## Gotchas & Watch-outs

- **Prod is UNCHANGED.** `sha256:4becdf0a` = git `978cc89`; rollback anchor `sha256:961e149d`. None of epic
  #78 is in a deployed image. Do NOT deploy without the smoke test (operator-gated).
- **The 5 follow-ups are in MERGED code** — a fix is a normal follow-up PR, not a revert. Fix the R3
  behavioral-gating one before any deploy (it's a real mis-diagnosis that ships today).
- **Chrome crash popups during Codex review = Codex's Computer Use client** (`SkyComputerUseClient`), NOT the
  gateway. It drives host Chrome (hence "normal Chrome" on Reopen; the gateway's Patchright browser is
  in-container only). Self-terminated after the reviews finished; safe to Ignore if it recurs, or kill the
  `SkyComputerUseClient` pid (leave the Chrome processes — may be the operator's own browser).
- **Run `validate-*.mjs` gates ONLY via `docker run`** (in-container, Chrome-under-Xvfb). Running them locally
  launches host Chrome with container-tuned flags and can crash.
- A **concurrent session ("Sol")** was touching this repo's working tree during the run (noticed by a review
  agent). Coordinate if resuming.
- **Codex is available again** (usage reset). If continuing, run the follow-up through the normal Codex loop.
- Strategy doc (gitignored): `docs/plans/2026-07-23-001-post-38-recovery-and-diagnosis-honesty-strategy.local.md`.
  Memory `[[post-38-regression-recovery-strategy]]` (marked SHIPPED). Public-repo hygiene held throughout.
