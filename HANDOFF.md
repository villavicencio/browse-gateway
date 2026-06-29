# HANDOFF — 2026-06-28 (Sunday)

> **Operator is traveling (overseas flight), low bandwidth until home Friday 2026-07-03.** Keep asks
> minimal; nothing here is time-pressured. The one remaining step is a single command block (already on
> the clipboard last session and reproduced below) — it can wait until you're home and clear-headed.

This session closed the **localStorage capture gap** that left Total Wine warm-open landing logged-out.
The capture fix is **shipped + validated on the real site**, the credential is **re-imported into the
prod vault with localStorage**, and the only thing left is the final **warm-open drive validation**,
which is **blocked only on the atlas MCP token** (a prod read the operator must run — the auto-mode
classifier correctly gated me from SSHing prod for a live credential).

## What We Did

- **Diagnosed the whole localStorage lifecycle** (capture → import → strip → host-scope → warm replay)
  via a fan-out workflow. Conclusion: **the ONLY code defect was capture.** Everything downstream
  already handles `origins`/localStorage correctly — import carries it intact, `stripIpBoundTokens`
  leaves `origins` untouched, `hostScopeSession` keeps a `https://www.totalwine.com` origin under both
  `www.` and apex owner spellings, and warm replay re-injects per-origin localStorage via an
  origin-guarded `addInitScript` that fires before first navigation. (Workflow stalled on infra mid-run
  but all 4 readers + the host-scope verifier completed; salvaged from the journal.)
- **Root-caused `origins: 0`** precisely: `connectOverCDP` + `storageState()` only serializes
  localStorage for origins in Playwright's `_origins`, populated *solely* by `addVisitedOrigin` ←
  `frameNavigatedToNewDocument`. A page that navigated **before** Playwright attached never fires it →
  empty `_origins` → localStorage dropped. Not an empty store, not a CDP read limit (`frame.evaluate`
  reads it fine).
- **Patched the capture tooling** (`~/totalwine-onboarding/`, OUTSIDE the repo). Two new reusable
  helpers + wired into both capture scripts:
  - `dump-storagestate.mjs` — cookies via `storageState()` + **localStorage enumerated per live frame**
    (`frame.evaluate`, covers subdomain/iframe auth) folded into `state.origins`.
  - `inspect-localstorage.mjs` — **read-only pre-capture gate**: prints per-origin localStorage key
    *names* (never values), flags auth-looking keys, exit 0 (auth found) / 3 (none) / 2 (couldn't
    attach). `capture.sh` + `capture-proxied.sh` run it before dumping so a dead capture is caught
    before it's spent.
  - Fixed the stale RUNBOOK Step 2 (it still said `playwright codegen --save-storage`, the
    automation-launch path that loops PX *and* drops localStorage).
- **Verified the fix** — functional smoke (seed `authToken` on a live page → inspect flags it → dump
  yields `origins:1`, value round-tripped) AND **on the real site**: operator ran `capture.sh`, got
  **`origins: 1` on `https://www.totalwine.com`, 68 keys**, with `twSessionId` / `twSessionExpiration` /
  `REMEMBER_ME` / `LOYALTY_NUMBER` present. (No PX challenge this run — the isolated profile kept
  device-trust from the prior clear.)
- **Stripped 6 PerimeterX localStorage entries** (operator's call, clean-test) before import — backup at
  `totalwine.json.bak-prestrip`; 62 keys remain, auth intact, no PX left.
- **Re-imported UNBOUND** (operator confirmed totalwine.com is a `BGW_WARM_FRESH_EXIT_HOSTS` host → no
  `--exit`): `✓ 123 durable cookies, 3 IP-bound stripped, decrypt-verified`. **Vault entry grew
  `33876B → 66056B`** — that's the localStorage now persisted.
- **Brought the Mac→prod `:8080` tunnel back up** (LaunchAgent was down; `launchctl bootstrap`).
- **Hardened `validate-warm.mjs`** — removed the bare `my account` match that gave a **false ✅** on the
  `/login` page ("Login My Account" title), strengthened logged-out signals, and made it **always dump
  the snapshot** so we verify against evidence, not the regex.
- **Solution doc updated + pushed** (`2b48bcb`): root cause + capture fix + the 3 open risks.

## What's Next (the ONE remaining step)

**Run the warm-open drive validation.** Blocked only on the atlas MCP token (`BGW_CONSUMER_TOKEN_ATLAS`,
a prod env value). The auto-mode classifier gated *me* from SSHing prod to read it — correct. Run this
block yourself (tunnel is up; token only prints as a char count; it reads the SSH host + env path from
your local `obscura` config so no fleet paths are hardcoded):

```sh
cd ~/totalwine-onboarding
export BGW_URL=http://127.0.0.1:8080/mcp
ADMIN=$(node -pe 'require(require("os").homedir()+"/.config/obscura/config.json").adminSsh')
ENVF=$(node -pe 'require(require("os").homedir()+"/.config/obscura/config.json").remoteEnvFile')
export BGW_TOKEN=$(ssh "$ADMIN" "grep -m1 BGW_CONSUMER_TOKEN_ATLAS '$ENVF'" | cut -d= -f2- | tr -d "\"'")
echo "token: ${#BGW_TOKEN} chars"
node validate-warm.mjs
```

Then paste the OUTCOME + snapshot. Interpreting the result:
- **✅ LOGGED-IN** → parked task DONE; localStorage warm-open lands logged-in end-to-end.
- **⚠️ PX CLEARED but LOGGED-OUT** → restored session didn't take. Snapshot tells which: origin/host
  mismatch (fix in import), expired `twSessionExpiration`, or a sessionStorage-only dep `storageState`
  can't reach.
- **PX-CHALLENGE** → press-&-hold returned on replay (risk #3, separate PX track, not a capture bug).

(If the tunnel is down again on resume: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.dvillavicencio.browse-gateway-tunnel.plist`.)

## Open Risks (the inspect gate already de-risked #1 + #2 for this capture)

1. **Origin alignment** — RESOLVED for this capture: auth localStorage is on `www.totalwine.com` = the
   owner/nav-clamp host. (Was the most likely failure; isn't one here.)
2. **Auth-in-localStorage** — RESOLVED: `twSessionId`/`REMEMBER_ME`/etc. confirm a real logged-in
   session in localStorage.
3. **PX re-challenge on a fresh exit** — still possible; the OS-identity Windows-UA fix clears PX in
   prod, so this is unlikely, but it's the one thing the final drive validation actually tests.

## Gotchas & Watch-outs

- **Capture must be a FRESH sign-in** (sign out → in) or you grab a stale session shell.
- **`validate-warm.mjs` now always prints the snapshot** — read the actual page, don't trust ✅ blind
  (it's burned us before on `/login`).
- **PX localStorage entries are NOT stripped by import** (strip is cookie-only). We stripped them by
  hand this session; if you re-capture, decide again (we chose strip for a clean read).
- **Prod credential reads are gated** by the auto-mode classifier — operator runs them, not the agent,
  unless explicitly approved this session.
- **atlas per-consumer session cap = 2**, 5-min idle reaper. `validate-warm` always `browser_close`s now.
- **Fleet hygiene (public repo):** the capture tooling + tokens live OUTSIDE the repo; never commit
  prod host / env-file path / consumer tokens.
- Local `main` == `origin/main` (`2b48bcb`); no open PRs; untracked `AGENTS.md` still parked (decide
  commit-or-leave when home).
