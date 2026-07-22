# HANDOFF — 2026-07-22, pre-dawn (overnight autonomous run)

Operator asked **"how much can we work through autonomously through the night?"** → I ran an 8-ticket
feasibility workflow, presented an ordered spine, got **"go ahead and start once the plan is ready,"** and
worked the spine autonomously. **Four tickets shipped to main** (the plan's conservative target), each driven
through the full implement → unit-test → Claude↔Codex adversarial-review loop → merge. **~20 Codex rounds
total; every finding verified, not blind-accepted.**

## What shipped tonight — 4 tickets MERGED to main, **NONE deployed**

| # | PR | squash | Codex rounds | Summary |
|---|----|--------|--------------|---------|
| **#47** | #61 | `523b350` | 3 | Client-breaker affordances: authed session-independent `GET /health` (mirrors the SDK Host/DNS-rebind check) + `_meta` error-kind (`in-band` vs `internal`, from the real failure verdict) + `browser_close` idempotentHint. |
| **#58** | #62 | `1389976` | 1 | Drive **action**-failure envelopes attribute the WAF vendor — moved cf/px/dd hint + captchaKind into `#snapshotOf` (was navigate-only). |
| **#44** | #63 | `71066947` | **8** | CAPTCHA solver eligibility + typed `captchaSolveReason` on retrieve+drive envelopes. |
| **#43** | #64 | `c9d8aba9` | **7** | Bounded per-call wall-clock: global `BGW_CALL_BUDGET_MS` + 6 env-overridable timeouts. |

**742 unit tests on main** (was 703). 0 TS errors. All CI green.

## ⚠️ CRITICAL: not deployed — batched gate + deploy is the morning job

Per the approved plan, I banked everything on main and **deployed nothing** (each prod deploy burns the
hard-capped ~$10 IPRoyal PAYG stealth gate — per-ticket deploys are the anti-pattern). All 4 have
**gate-territory** aspects proven only on a real browser:
- #47 the `/health` route's real behavior; #58 the real `page.content()` hint population; #44 `#trySolveCaptcha`
  threading + the identity re-check; #43 the real-browser clearance-poll **wall-clock** bound.

**Do one consolidated in-container gate run, then one deploy:**
```
colima start --vm-type vz --vz-rosetta --cpu 4 --memory 8 --disk 30
# build --platform linux/amd64 (Dockerfile hardcodes the amd64 Chrome .deb), then:
#   validate-failure-envelope + validate-stealth (+ validate-retrieve / validate-drive)
gh workflow run deploy-http.yml -f image_tag=latest    # ci.yml already built+pushed GHCR latest from main
```
**Prod still runs #42 `sha256:6e9ca1e76a18`** (rollback anchor #41 `sha256:3c9c6e84`). `.env.spike` is
SPIKE-format (strip `export `, map `SPIKE_PROXY_*`→`BGW_PROXY_*` for a docker `--env-file`). Keep stealth
smokes to ATTEMPTS=1/REQUIRED=1 to spare the $10 burn.

## 4 operator HOLDs (each ticket's autonomous slice already shipped; these are your calls)

1. **#44 Turnstile precedence** — when Cloudflare + Turnstile markers co-fire, should `captchaKind=turnstile`
   win over `cf-challenge`? Needs a captured **real CF managed-challenge fixture** + your precedence call.
2. **#48 location primitive** — is there a generic cross-site "a store/location is selected" signal worth a
   snapshot primitive, or keep per-site/deferred? (#48's detector half ships without it.)
3. **#53 auth posture** — should `obscura status`'s health read move to an authed path to consume the new
   internals surface? (#47 pre-settled the HTTP-vs-MCP fork; a conservative authed default is the plan.)
4. **#54 orphan-reap** — `/proc` process-group sweep vs launch-side child capture vs accept-as-residual (like
   #50's restore-cleanup)?

## #43 follow-ups (documented in code, not bugs)

- **Whole-operation hard ceiling** — the budget bounds the dominant sinks (nav + the wall-clock clearance
  poll) on every attempt, but a `pollSignal`/snapshot/`extractMarkdown`/session-lifecycle step can each run
  its own duration past the deadline (and a hung launch — #54). An exact ceiling needs cooperative
  cancellation (top-level `Promise.race` / AbortSignal gateway→core→browser). **Coordinate with #54.**
- **Drive-path env-timeout consumption** — the drive path still reads the module-constant defaults. It has no
  3× re-roll loop (a stateful session can't swap its exit mid-flow, KTD-5), so it doesn't stack toward 200s.
  **Coordinate with #45**, which restructures the drive escalation loop.

## What's next — remaining spine

`#45 → #48 → #53 → #54`.
- **#45** (burned-exit vs site-block + safe re-roll) is **MED-risk** and rewrites the escalation loop on both
  verbs — **run the pre-code critique first** (`dv:critique` / a 5-lens panel), per the plan.
- **#48** ships the silent-home-fallback **detector** cleanly (HOLD #2 is only the location primitive).
- **#53** conservative authed-MCP slice (HOLD #3 is the posture confirm).
- **#54** slot-release + shutdown-tolerance slice (HOLD #4 is the orphan reap).

## Gotchas / watch-outs

- **Codex runner:** `codex exec review --base main`, and **use `run_in_background: true`** — a raw `&` gives
  no completion notification (I did this 3× out of habit). Background codex runs got **killed mid-flight
  twice** with no verdict — just relaunch cleanly (the commit is already safe).
- **Deploy/CI status:** single read-only `gh` checks or one `gh run watch <id>` (backgrounded). **No poll
  loops** — the auto-mode classifier blocks them.
- **`git pull --ff-only origin main`** before the next branch (local main goes stale after each GitHub merge).
- **Public repo** — never commit fleet codenames (Codex caught one leak in #47 r2; scrub source AND squash
  history before pushing).
- A `wafVendor` / `failureClass` / `timing` / `captchaSolveReason` value can be occasionally-imprecise on
  exotic/teardown/rotation edges — all are **diagnostics, never behavior/security decisions**.
