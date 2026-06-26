# HANDOFF — 2026-06-26 (afternoon, PST)

This session **killed the PerimeterX blocker on Total Wine** — the open item from the morning handoff
("VPS fingerprint parity"). We root-caused it (NOT WebGL/Xvfb as long assumed — it's the **OS
identity**), shipped an opt-in fix through the full pipeline (3-lens design → 4-round Codex review →
PR #37 → deploy), **activated it in prod, and confirmed PX clears end-to-end**. The one piece left —
warm-open landing *logged-in* (vs just clearing PX) — is **parked** on a localStorage capture gap,
fully documented for the next session.

## What We Built

- **`PR #37` (`2663171`) — opt-in per-host Windows OS-presentation.** New env `BGW_WINDOWS_UA_HOSTS`
  (CSV host-suffixes, mirrors `BGW_FORCE_PROXY_HOSTS`; default OFF = native Linux everywhere). A listed
  host presents as **Windows** Chrome via CDP `Emulation.setUserAgentOverride` (UA + `navigator.platform`
  + `userAgentData`/client-hints). Files: `src/browser/os-presentation.ts` (NEW — `buildWindowsUaOverride`/
  `buildNativeUaOverride` from the LIVE UA-CH, preserves real brands/fullVersionList, version-derived,
  `READ_LIVE_UA_JS`), `src/browser/patchright-core.ts` (per-active-page OS-mode machine: eager clean
  about:blank baseline, active **restore-to-native** on listed→non-listed (no opt-in bleed), **fail-closed**
  on any read/CDP failure — recreate fresh page + retry, else fail loud), `src/browser/types.ts`
  (`windowsUaHosts`), `src/gateway/config.ts` (`BGW_WINDOWS_UA_HOSTS` → `config.core`, one wiring point,
  covers warm/cold/retrieve), `src/security/url.ts` (shared `parseHostSuffixList` + `hostMatchesAnySuffix`;
  `escalation.ts` force-proxy/fresh-exit now delegate), `src/browser/launch-options.ts` (comment fix —
  SwiftShader-spoof follow-up retracted, exonerated). Runtime gate `scripts/validate-os-presentation.mjs`
  (flip/restore/clean-baseline/opt-out). `.gitignore` += `.claude/`. **516 unit tests pass.**
- **Activated in prod (2026-06-26).** Appended `export BGW_WINDOWS_UA_HOSTS=totalwine.com` to the prod
  env file (backup saved on-host as `…-env.bak-prewinua`; `launch-http.sh` forwards every `BGW_*` by name,
  so no script change needed), built `latest`, deployed via `gh workflow run deploy-http.yml` (gate→swap→
  verify green). Confirmed `BGW_WINDOWS_UA_HOSTS=totalwine.com` live in the running container.
- **Solution docs (`2cfc771`, on main):** `docs/solutions/runtime-errors/perimeterx-blocks-linux-chrome-os-identity-windows-ua-fix.md`
  (root cause + fix + "Validated in prod" note) and `docs/solutions/integration-issues/perimeterx-login-capture-needs-plain-chrome-not-automation-launch.md`
  (the capture-path learning + the open localStorage gap).
- **Re-imported atlas's Total Wine credential** to the prod vault (fresh sign-in, 122 durable cookies,
  decrypt-verified) via `obscura vault import`. Durable tunnel re-bootstrapped (LaunchAgent).
- **Local PX tooling** (in `~/totalwine-onboarding/`, OUTSIDE the repo): `px-probe.mjs` (the same-exit A/B
  + extended-fingerprint + core-navigate probe harness that root-caused this), `validate-warm.mjs` patched
  (default target → `/my-account`; always `browser_close` so it stops leaking sessions).

## Decisions Made

- **Root cause = OS identity, NOT WebGL/Xvfb.** Proven by same-exit A/B (4/4 fresh exits) + a local Docker
  repro + end-to-end `core.navigate`: on a *fixed* residential exit IP the container 403'd as `Linux x86_64`
  and CLEARED (200) when ONLY the OS string flipped to Windows. This **overturns** the morning handoff's
  WebGL/Xvfb framing.
- **Opt-in per host, default OFF** (operator chose this over global). A Windows UA over the container's Linux
  fonts/canvas is internally incoherent, so only hosts that demonstrably need it are flipped; every other
  target keeps its coherent Linux identity. Windows chosen over macOS (dominant desktop OS = lowest suspicion).
- **Hardened via a 4-round Codex adversarial-review loop** (each round caught a real bug): R1 opt-in bleed +
  fabricated UA-CH → R2 fail-open restore + `.claude` push-grant in tree → R3 silent read-fallback + poisoned
  (loaded-page) baseline → **R4 approve**. The fail-closed + clean-baseline design is the result.
- **Capture path: plain Chrome, not automation.** `playwright codegen`/any automation-launched browser fails
  the PX press-&-hold; capture in a plain Chrome (`capture.sh`) + read-only `connectOverCDP`.

## What Didn't Work

- **WebGL/SwiftShader, mediaDevices, screen size, window geometry, WebRTC, timezone — all EXONERATED.** Each
  was fixed in isolation on a proven-good same-exit and the container still 403'd; only the OS flip cleared it.
  Don't relitigate these.
- **`playwright codegen --save-storage` for capture** — automation fingerprint loops the press-&-hold forever.
- **Cookie-only capture for warm-open-login** — `connectOverCDP storageState` dumped 125 cookies but
  `origins:0` (no localStorage), and Total Wine has no httpOnly session cookie → warm-open clears PX but lands
  **logged-out**. This is the parked item (see Next).
- **Probing login state on `/account`** — it 404s (not a route); the real authed slug is `/my-account`. The
  `validate-warm.mjs` ✅ was a false positive (heuristic matched "My Account" in the title "Login My Account").

## What's Next

1. **Warm-open *logged-in* for Total Wine (the parked item).** Root cause: capture missed localStorage. Fix:
   extend the capture to evaluate `localStorage` on the live logged-in page and fold it into the imported
   `storageState.origins` (don't rely on `connectOverCDP storageState` to enumerate it). **Verify first** that
   a logged-in TW page actually has an auth-looking `localStorage` key (re-launch plain Chrome, log in, inspect
   before dumping). Then re-import + re-run `~/totalwine-onboarding/validate-warm.mjs` (now targets `/my-account`).
   Full writeup: the integration-issues capture doc ("Still open: localStorage auth not captured").
2. **Confirm store 1111 = Folsom.** The capture's `twm-userStoreInformation` cookie pins store **1111 / US-CA /
   in-store-pickup** (90-day, vault-restored, overrides IP-geo) — so pricing/location is cookie-tied, not
   IP-geolocated. Just confirm 1111 is the right store.
3. **Untracked `AGENTS.md`** is sitting in the tree (pre-existing, public-safe copy of the project instructions).
   Decide whether to commit it or leave it untracked — left alone this session.

## Gotchas & Watch-outs

- **`validate-warm.mjs` login-state heuristic is fragile** — it false-matched "My Account" in "Login My Account"
  and reported ✅ LOGGED-IN when the page was actually `/login`. Read the actual `url`/`title`, don't trust the ✅.
- **Same-exit A/B is mandatory** for any PX fingerprint test (PX is exit-reputation gated). Pin one IPRoyal
  sticky id across the configs you compare + add a positive control (Mac clears → exit is good), or noise swamps
  the signal. `px-probe.mjs` does this.
- **Local container = amd64-via-Rosetta**, prod = native x86 — faithful for OS/flags/fonts but not 100% for
  arch-derived axes (SwiftShader backend string differs LLVM vs Subzero). Final confirmation was on real prod.
- **Capture must be a FRESH sign-in.** A reused `chrome-profile` auto-logs-in from a stale session → captures a
  dead session shell → warm-open logged-out. Sign out, then sign in, before capturing.
- **Per-consumer session cap = 2**, 5-min idle reaper (60s tick). Leaked test sessions exhaust atlas's slots
  ("per-consumer session limit reached (2)"); wait for the reaper. (validate-warm now always `browser_close`s.)
- **Fleet hygiene (public repo):** never commit the prod host / env-file path / deploy-config path / consumer
  tokens. The prod env file got `BGW_WINDOWS_UA_HOSTS=totalwine.com` appended this session (path NOT recorded
  here on purpose). atlas + totalwine.com + BGW_* names are public-safe.
- **Prod access this session** worked via the `openclaw-prod` ssh alias (operator's explicit approval cleared
  the auto-mode classifier). The durable Mac→prod `:8080` tunnel LaunchAgent was DOWN at session start — I
  re-bootstrapped it; it may need re-bootstrapping next session (`launchctl bootstrap gui/$(id -u) <plist>`).
- Local `main` == `origin/main` (`2cfc771`); no open PRs; 516 tests pass.
