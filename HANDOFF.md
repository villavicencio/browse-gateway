# HANDOFF — 2026-06-23 (night, PST)

Continued from the evening handoff (U7 vault safety rails built, PR #35 review-clean). This session
**merged #35, then built and merged the server-3xx redirect-bypass fix (#36) end-to-end** — the
core-guard change that GATED U9 (consumer warm-open) — and validated it in-container with a
controlled fingerprint A/B. The redirect bypass is now closed; **U9 is unblocked and is the next
build step** (deferred to a fresh session by request).

## What We Built

- **Merged PR #35 — U7 vault safety rails** (squash `7c0c26c`): host-scoped no-exfil + nav clamp +
  origination boundary + secret-leak gate. Now on `main`.
- **PR #36 — server-3xx redirect-bypass fix** (squash `95174ab`). The nav guard rode
  `context.route` + `route.continue()`, which auto-follows a server redirect chain WITHOUT
  re-invoking the handler — so the guard decided only hop 0 and a `302` from a credential owner host
  to a same-parent sibling carried a retained parent cookie off-host. Replaced with **ONE
  browser-level CDP `Fetch` session** (Request stage) + `Target.setAutoAttach({flatten})` in
  `src/browser/patchright-core.ts` (`setNavigationGuard`/`#installFetchGuard`/`#onRequestPaused`):
  - CDP re-pauses every redirect hop → guard re-decides each; `Fetch.continueRequest` (no overrides)
    keeps each hop in Chrome's NATIVE network stack (TLS/HTTP fingerprint preserved).
  - `context.route` REMOVED (it was the sole consumer; Patchright auto-enables Fetch when a route is
    registered, so route + raw session would collide on `InterceptionId`).
  - `isNavigationRequest = resourceType==="Document"`; CDP TitleCase resourceType lowercased for the
    audit log. Pure helpers `cdpRequestToNavigation` + `decideRequest` extracted and exported.
  - Review hardening: single-flight install + partial-cleanup; **detach-first teardown** (`close()`
    detaches the CDP session instead of `Fetch.disable`, which auto-CONTINUES paused requests);
    diagnostics on guard-throw and on non-teardown send-failure; `validate:stealth` made **guard-on**.
- **New tests/gates:** `test/nav-guard-mapping.test.mjs` (mapping + `decideRequest`),
  `test/nav-guard-redirect-hops.test.mjs` (real policy clamp over a CDP-mapped chain), and
  `scripts/validate-redirect-guard.mjs` (real browser, **11/11 in-container** — per-hop block, allowed
  chain lands, off-host subresource/popup/worker guarded, fail-closed). **480 unit tests green.**
- **`561c74a`** — solution-doc provenance: the prod-direct datacenter-IP gotcha + the A/B result.
- **`12c58bf`** — `validate-stealth` gained an optional **`BGW_PROXY_*` path** so a prod run routes the
  CF/DataDome legs through a residential exit (representative fingerprint check); default stays direct.
- **Q2 validation (in-container, local colima, amd64 via Rosetta, headful under Xvfb):** guard-on
  `validate:stealth` PASS, AND a controlled interleaved clean-IP A/B cleared CF **guard-on 12/12 =
  guard-off 12/12** → the CDP-Fetch interception does NOT regress the fingerprint.

## Decisions Made

- **Mechanism = CDP-native, browser-session flatten auto-attach.** Rejected `route.fetch` (replays
  through Playwright's API stack → changes the TLS/HTTP fingerprint) and per-page `newCDPSession`
  attach (RACES a popup's first navigation — spike-proven). Scope = per-hop re-assertion on **all**
  requests (free under CDP; the owner-clamp's nav-only asymmetry lives inside `guardForCredentialHost`).
- **WebSocket-exfil decision RESOLVED → Option B.** Operator confirmed U9 credential owner-hosts are
  **trusted** (not serving hostile JS). So: accept the WS residual; the container-network egress
  sidecar is the boundary. Closing it via CDP `Network.webSocketCreated` host-check is a **hardening
  follow-up, NOT a U9 blocker**.
- **Agent now authorized to push `main` directly when safe** (reverses the old operator-pushes gate).
  Recorded in memory `authorized-to-push-main`. Already exercised: `561c74a`, `12c58bf`.
- **`validate:stealth` is now guard-on** by default (prod parity); `BGW_STEALTH_NO_GUARD=1` for a
  guard-off A/B baseline.

## What Didn't Work

- **`route.fetch`/`route.fulfill`** (the original solution-doc sketch) — SUPERSEDED: it would change
  the anti-bot fingerprint. CDP `continueRequest` is the native-stack-preserving path.
- **Per-page CDP attach** (`context.on('page')` + `newCDPSession`) — the popup's first navigation
  fires before Fetch arms; it leaked the popup (proven in spike). Browser-session flatten auto-attach
  is the fix.
- **Prod-direct `validate:stealth` as a fingerprint test** — FAILS the CF leg on prod's **datacenter
  IP** (reputation), a false negative, NOT a regression. Proven: udemy 403'd direct on prod but
  cleared 6/6 on a clean residential IP in both guard conditions. Use `BGW_PROXY_*` for a real run.
- **`#closing` fail-closed via `failRequest` after `Fetch.disable`** — `Fetch.disable` auto-continues
  paused requests AND the late `failRequest` raced a disabled domain (logged "Fetch domain is not
  enabled"). Switched to detach-first.

## What's Next

1. **U9 — consumer warm-open wiring** (the next build unit). Proceed under WebSocket **Option B**.
   **Run U9 through the new Codex review-loop SOP** (memory `codex-review-loop-sop`): implement +
   self-review → commit → drive `codex-companion.mjs adversarial-review --base origin/main` autonomously
   until Codex returns `approve`, THEN present — operator stays out until the end. (The `codex` plugin
   was installed + authed this session; the loop's first live run is U9.)
   The warm-replay machinery (`buildWarmOverride` → sealed `restoreState` → guarded credentialed
   session) exists; U9 wires a consumer-facing trigger to open one. **Vault is still DORMANT in prod**
   — needs `BGW_VAULT_DIR` on a **persistent volume** + a `0600 BGW_VAULT_KEY_FILE` before anything is
   live.
2. **Pre-U9-activation gate (in-container):** run `validate:stealth` on prod **with `BGW_PROXY_*` set**
   (now supported, `12c58bf`) to confirm the proxy path clears CF (representative fingerprint check —
   not yet run in-prod), plus `validate:redirect-guard` / `validate:proxy-escalation` / `validate:drive`.
3. **Follow-ups (tracked, none blocking U9 under Option B):** WS hardening via
   `Network.webSocketCreated` (only if the credential set ever includes lower-trust hosts);
   narrow-allowlist `retrieve` now hard-fails off-allowlist redirects (validate vs real targets);
   cross-origin OOPIF off-host container fixture for `validate-redirect-guard` (needs a `127.0.0.2`
   loopback alias the Mac run omits).

## Gotchas & Watch-outs

- **A prod-direct `validate:stealth` CF failure is datacenter-IP reputation, NOT a fingerprint
  regression** — documented in `docs/solutions/architecture-patterns/nav-guard-redirect-bypass.md`.
  Run with `BGW_PROXY_*` for a representative result; production serves CF via a residential proxy,
  never the bare datacenter IP.
- **The `validate-stealth` `BGW_PROXY_*` path has not been run in-prod yet** (no proxy creds locally).
  One prod run is the confirmation; it cannot affect the default direct path.
- **WS exfil residual is accepted** under Option B (owner-hosts trusted). If U9's credential set ever
  expands to hosts you don't fully trust to be XSS-free, revisit and do the `Network.webSocketCreated`
  close before activating those.
- **Run container gates as `node` (rootless), NOT root.** Build the branch image locally (colima:
  `colima start`, then `docker build --platform linux/amd64 ...`) or pull the post-merge GHCR image on
  prod. Prod has no source tree — it pulls images.
- **Agent now pushes `main` when safe** — but still HOLD on: unvalidatable prod-runtime changes, red/
  uncertain diffs, history rewrites/force-pushes, or anything touching secrets/fleet identifiers.
- **Public repo** — codenames/generic refs only; no fleet host/path/token in source, commits, or this
  doc. Untracked `.claude/` + `AGENTS.md` left as-is (pre-existing).
- Local `main` is in sync with `origin/main` (tip `12c58bf`); nothing unpushed.
