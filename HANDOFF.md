# HANDOFF — 2026-06-02, afternoon

Picked up the interactive **`drive` verb set** as PR #2 (built in the prior session, U1–U5 of
the drive plan). Ran a multi-agent code review, then iterated through **six external review
passes** hardening the drive surface — each pass surfaced one more edge in block-detection /
proxy-escalation / lifecycle — and finally **squash-merged PR #2 to `main`** (`e431101`).
`drive` now ships on `main`; it lands dormant (config/deploy-gated) until enabled in prod.

## What We Built
- **Merged PR #2 → `main` as squash `e431101`** ("feat: interactive `drive` verb set …"), branch
  deleted, local `main` synced. The squash body summarizes the feature; the six-pass fix history
  is collapsed (per-pass detail below + in agent memory).
- **Drive surface on `main`:** 10 `browser_*` MCP tools (open/navigate/snapshot/click/type/
  select_option/press_key/wait_for/take_screenshot/close) over a ref-annotated `ariaSnapshot`
  model; consumer-bound persistent sessions (per-consumer cap + idle reaper + clean teardown);
  Approach A (high-level verbs only, never raw CDP) so the below-verb-layer guard can't be removed.
- **Hardening produced by the review passes (all on `main` now):**
  - `navigate()` polls anti-bot clearance (only while a block phrase shows); `navFailed` flags a
    still-visible challenge, a 4xx+thin **hard block**, AND a `chrome-error://` **dead nav**.
  - Post-action snapshots carry the last main-frame nav **status** (response listener) so a bare
    `403` reached by a click/submit is caught, not returned as success.
  - **Escalate-on-block proxy posture** (`#4`, mirrors `retrieve`): first navigate goes DIRECT;
    escalates to a residential exit only on a CF challenge (visible phrase **or** `cfHint`
    vendor-hint) or a hard block, and only at the first navigate (before interaction; KTD-5). A
    pinned exit that fails mid-flow is discarded so the next navigate re-escalates.
  - **Secret-rotation safety (R9):** proxy override resolved fresh per session-open;
    `SecretStore.redactableValues()` scrubs every value ever loaded (retired-but-in-flight creds
    can't leak).
  - **Per-consumer cap race fixed:** `#reservedByConsumer` counts in-flight launches.
  - `cfHint`: a **scrubbed boolean** on `PageSnapshot` (CF vendor-hint in HTML, computed in the
    core) so drive's CF escalation matches `retrieve`'s `isCloudflareBlock` exactly — no raw HTML
    carried, not exposed via MCP.
- **Tests:** 112 unit (`npm test`), typecheck clean. **In-container `validate-drive.mjs` PASS
  0/0** (real browser: CF cleared *direct*, off-allowlist blocked, type+submit state change, idle
  reap, clean close; step 1b CF-clearance + a bare-403 / chrome-error post-action regression).
- **Memory:** wrote `drive-retrieve-detection-parity.md`; updated `build-progress.md` + `MEMORY.md`.

## Decisions Made
- **Escalate-on-block, not always-on** for drive (`#4`) — direct-first saves residential GB when
  the stealth core clears CF directly on the datacenter IP; proxy spent only on hard reputation
  blocks. Matches `retrieve`'s recorded posture.
- **Dead-nav detection via the `chrome-error://` URL check** (deterministic), NOT nulling status on
  `requestfailed` — the latter false-positives on a download/aborted-nav click that leaves the page
  on a good document. (Added then reverted within the 4th pass.)
- **`cfHint` carried as a scrubbed boolean**, not raw HTML — keeps snapshots lean and avoids
  leaking page content while matching `retrieve`'s vendor-hint CF detection.
- **`#5` middle-path:** a proxied mid-flow failure discards+unpins (next navigate re-escalates);
  a direct session is left intact (no state-losing discard).
- **Squash merge** (user's choice) to collapse the six-pass history into one feature commit.
- **`@mozilla/readability` ReDoS bump deferred** to a separate PR — it's a `retrieve` dependency,
  out of scope for the drive feature.

## What Didn't Work
- **`requestfailed` listener nulling `#lastDocStatus`** — false-positives on download/aborted-nav
  clicks (page stays good, status wrongly nulled). Don't re-add; the `chrome-error://` URL is the
  signal.
- **Narrowing `shouldEscalateDrive` to CF *visible phrases* only** (`isCloudflareVisible`) — missed
  a CF interstitial detected only by the HTML vendor hint (`challenge-platform`) that `retrieve`
  escalates. Needed `cfHint`. Don't narrow to visible-only.

## What's Next
1. **Before enabling drive in prod (the gate):** bump **`BGW_MAX_SESSIONS`** (> 2; held drive
   sessions share the global pool with `retrieve`, code default 2) and confirm
   **`BGW_ON_DATACENTER_IP`** + proxy on the runtime host. The deployment env file + values live in
   `CUTOVER.local.md`. Merging did **not** enable drive — it's config/deploy-gated.
2. **Parked follow-up:** bump **`@mozilla/readability` ≥ 0.6.0** (low-sev ReDoS
   GHSA-3p6v-hrg8-8qj7, pre-existing, used by `retrieve`'s `extractMarkdown`) as a separate small
   PR + verify extraction still produces clean markdown on 0.6.0.
3. **U7:** capped-deploy tuning vs measured headroom, observability/retention, and the NET_ADMIN
   egress sidecar (also unblocks drive **Approach B / CDP-attach**).

## Gotchas & Watch-outs
- **drive↔retrieve detection parity** (the recurring theme of all six passes): `navFailed` and
  `shouldEscalateDrive` re-derive `retrieve`'s detection on a *reduced signal surface* (aria tree +
  status + `cfHint`, no HTML). When touching either side — or `retrieve`'s escalation — change BOTH
  together and add a parity unit test. New HTML-derived signals → carry as a scrubbed boolean like
  `cfHint`, never raw HTML. See memory `drive-retrieve-detection-parity`.
- **PUBLIC repo** — never commit fleet detail (host / agent / path / vendor / pricing / exit-IP) in
  source, comments, commit messages, or this file. Fleet specifics live in gitignored
  `CUTOVER.local.md` / `CONTEXT.local.md` and agent memory.
- **In-container gate run:** colima is arm64 → build/run with `--platform linux/amd64` (Chrome is
  amd64-only); `--init --shm-size=1g`; **don't pipe `docker run` through `tail`** (wedges the
  headful stdout — redirect to a file); use a throwaway tag (not `:latest`). Clean up after with
  `docker rmi <tag>` + `docker builder prune -f`.
- **`navigate()` now does one `page.content()` per nav** (to compute `cfHint`) — cheap, but it's an
  extra HTML serialize per navigation (not per action).
- **Untracked `AGENTS.md`** is present in the working tree — not created or committed by this
  session; left as-is.
