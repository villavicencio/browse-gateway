# HANDOFF — 2026-06-24 (afternoon, PST)

This session took **U9 — consumer warm-open** from a fresh build all the way to **live + validated in
prod**: built it, hardened it through a 6-round autonomous Claude↔Codex review loop, merged it,
activated the credential vault on the prod host, and proved an end-to-end warm-open with a real
credential (atlas @ www.totalwine.com). The one thing that *didn't* clear is **PerimeterX** on Total
Wine — which is a known separate problem, not a vault gap. **Next session's explicit goal: kill the
PerimeterX press-&-hold once and for all.**

## What We Built / Shipped (all on `main`, synced at `58537ed`)

- **U9 consumer warm-open** — `f8df7cd` (squash of a 7-commit branch). Implicit auto-warm at
  `GatewayDriveController.#firstNavigate`; warm > force-proxy/direct-first; single-host nav-clamp; both
  entrypoints wire vault+consumerId+allowlist. Hardened via 6 Codex rounds (4 real bugs caught: parent-
  cookie sibling-subresource exfil, revoked-entry silent-cold-downgrade, and the R3 bound-exit fail-open
  in 3 layers → `proxyOverrideForPinned` structural check). 499 unit tests; runtime gate
  `scripts/validate-vault-warm-open.mjs` 14/14 in-container. (Full build detail in the prior handoff /
  git log.)
- **Deploy mount** — `b9628de`: `scripts/deploy/launch-http.sh` gained optional `BGW_VAULT_HOST_PATH`
  bind-mount → `/run/vault`.
- **Deploy fix** — `58537ed`: the vault-mount block read `BGW_VAULT_HOST_PATH` **before** sourcing the
  env file → mounted a stale/empty path (entries but no key) → `vault: /run/vault/kek ENOENT` → pre-swap
  smoke aborted **twice** (prod never broke — the gate/smoke/abort safety chain worked). Moved the block
  to **after** `. "$BGW_ENV_FILE"`. This was the only real prod-activation blocker.
- **Vault ACTIVATED in prod** — `vault: ready`, live on image `d91f2b1e`, consumers `[atlas, vault,
  argus]`, `datacenter=true sticky=true` (bound creds re-pin). Host vault at `/home/node/vault/{entries,
  kek}` (kek 0600 base64-of-32B, node-owned); the prod env file
  `<prod-env-file>` got `BGW_VAULT_DIR=/run/vault/entries`,
  `BGW_VAULT_KEY_FILE=/run/vault/kek`, `BGW_VAULT_HOST_PATH=/home/node/vault`.
- **Warm-open VALIDATED LIVE** — imported a real Total Wine credential for atlas
  (`obscura vault import`, 118 cookies, bound exit `3e7662d5`) and drove `atlas → navigate
  www.totalwine.com/account`. The gateway opened a **bound warm session** (re-pinned exit, restored
  cookies, routed residential; navigate returned a page, **not** the R3 fail-closed error → warm fired).
  Vault→warm-open→consumer pipeline confirmed in prod.
- **Onboarding helpers** (local, `~/totalwine-onboarding/`): `capture.sh`, `creds.json`, `RUNBOOK.md`.

## Decisions Made

- **Total Wine warm-open is blocked by PerimeterX at the EDGE, not by the vault.** PX throws the
  Press & Hold *before* the page renders, independent of the login cookie. The replay had a new
  residential IP (exit `3e7662d5` ≠ capture IP) and no PX token (we strip the IP-bound ones), so it got a
  fresh challenge. → It's the deferred press-&-hold spike, not a U9 problem.
- **Capture-through-same-exit is only marginal** for PX (the clearance token is IP-bound + seconds-lived
  → nothing useful to replay; same-IP buys a little trust, no guarantee). The real fix is defeating the
  press-&-hold.
- **Owner-subtree cookie residual: accepted** (operator-ratified, earlier this session) — documented at
  `hostScopeSession`; full exact-host lockdown is optional hardening.

## What Didn't Work

- **Playwright-launched browsers can't clear PX** — `playwright open/codegen` (even `--channel=chrome`)
  sets automation flags (`navigator.webdriver`, `--enable-automation`) → PX fails the Press & Hold
  *forever* ("Please try again"), even for a human. Fix: capture with a **plain** Chrome (no automation
  flags) via `~/totalwine-onboarding/capture.sh` (manual login + `playwright-core connectOverCDP`
  read-only storageState dump), then `obscura vault import`.
- **Running the capture on the prod host** — headless, no `$DISPLAY` → the capture must run on the Mac.
- **`BGW_VAULT_HOST_PATH` read before env-file sourcing** — see `58537ed` above.

## What's Next  → KILL PERIMETERX (the explicit next-session goal)

Plan: `docs/plans/2026-06-22-001-spike-defeat-perimeterx-press-hold.local.md`. First, cheapest experiments:

1. **Stop over-stripping `_pxvid`.** `stripIpBoundTokens` (`src/mcp/vault-login.ts`,
   `IP_BOUND_COOKIE_PATTERNS` → `/^_px/i`) strips **all** `_px*`, including `_pxvid` — PX's *long-lived
   visitor/device id*, not the short IP-bound clearance. That makes every replay look like a brand-new
   visitor. **Keep `_pxvid`; strip only the clearance (`_px3`/`_pxhd`/`pxcts`/`_px`/`_px2`).** Cheapest
   thing to try; may meaningfully cut re-challenges. (Re-verify the exact PX cookie taxonomy first.)
2. **Capture-through-the-same-residential-exit** so capture-IP == replay-IP (route the `capture.sh`
   Chrome through the IPRoyal sticky exit you'll bind, import with that same `--exit`). Test whether PX
   then waves the residential session through.
3. **Programmatic press-&-hold defeat** (the hard core of the spike): solve/replay the PX human-challenge
   on the drive path. Note: CapSolver tier today does reCAPTCHA/hCaptcha/Turnstile, **not** PX
   press-&-hold. PX iframe markers + the 200-OK false-negative are already documented
   (`docs/solutions/.../perimeterx-200-iframe-challenge-false-negative.md`).
4. **(Optional clean proof of U9, deferred this session):** import + warm-open on a **non-PX** login site
   to *see* warm-open hand back a logged-in page with nothing masking it.

## Gotchas & Watch-outs

- **Rootless Docker on prod:** gateway runs as host **`node`** (container-root → node via userns). Vault
  files MUST be node-owned (run host steps as node, **no sudo**, or the container can't read the key).
  `docker`/paths are per-user → use absolute `/home/node/...` and `sudo -iu node`.
- **`obscura` CLI** drops off PATH after an nvm node-version switch (global bin lost). Re-`npm link` in
  the repo. Capture/import run on the **Mac**; `obscura` docker-execs into the prod container.
- **Manifest reload:** `consumers.json` is read at boot — an allowlist change needs a container
  **re-create** (redeploy), not a restart (bind-mount inode + frozen env). atlas is already `allow=["*"]`
  (allow-all), so adding a host there is a no-op.
- **Pool floor is exact:** `maxSessions=7 = 3 consumers × perConsumerMax=2 + 1`; no headroom. Warm
  sessions are held longer → bump `BGW_MAX_SESSIONS` before a 4th consumer or on `SESSION_LIMIT`.
- **Deploy safety chain is real and load-bearing:** gate → pre-swap smoke → swap → verify → auto-rollback
  aborted both bad deploys without touching prod. Trust it; read the `--log-failed` `fatal:`/`smoke:` line.
- **IPRoyal sticky suffix** (verified vs live docs): `_country-us_session-{id}_lifetime-30m` (params in
  the PASSWORD; session = 8 alphanumeric; lifetime 1s–7d). Bound warm creds need
  `BGW_PROXY_STICKY_SUFFIX`(with `{id}`)+`BGW_ON_DATACENTER_IP=1`+proxy or warm-open **fails closed** (R3).
- **Public repo** — codenames/placeholders only; the prod host paths above stay out of committed source.
- Local `main` == `origin/main` (`58537ed`); nothing unpushed. Untracked `.claude/` + `AGENTS.md`
  pre-existing, left as-is.
