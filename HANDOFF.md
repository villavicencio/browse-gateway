# HANDOFF — 2026-07-22 (morning: batched gate + deploy DONE)

The morning job is **complete**. The overnight #47/#58/#44/#43 batch was gated in-container and
**deployed to prod**. A serious coverage gap on #43 (the wall-clock bound was never observed on a real
browser) was closed with a new gate before the deploy, per the operator's call.

## ✅ Shipped this session

**Prod now runs `sha256:2258db74…f54e79b` (git `487e338`).** Rollback anchor: **#42 `sha256:6e9ca1e76a18`**.
Deploy run `29925612591` — gate→swap→verify green, no rollback, 29s.

The deployed image = the 4 overnight tickets (#47 breaker affordances, #58 drive-action WAF vendor, #44
CAPTCHA solver eligibility/reason, #43 bounded per-call wall-clock) + one **test-only** gate script
(`487e338`, no `src/` change — byte-identical runtime to what was gated).

### The gate that ran (consolidated, in-container, colima vz+rosetta amd64 `browse-gateway:gate`)
- **FREE legs (residential IP, no proxy spend):** `validate-failure-envelope`, `validate-retrieve`,
  `validate-drive` — all PASS (only benign notes: httpbin.org down; udemy CF cleared without proxy).
- **PAID leg (IPRoyal proxy, ATTEMPTS=1/REQUIRED=1 to spare the ~$10 PAYG):** `validate-stealth` PASS —
  CF 1/1 + DataDome 1/1 + webrtc/webgl/secret-leak/negative-control. Stealth kill-gate holds on the new image.
- Env-file: `.env.spike` with `SPIKE_PROXY_*`→`BGW_PROXY_*`, staged in the session scratchpad (never the repo).

### The #43 gap that was closed first
A 4-agent **coverage-audit workflow** found the pre-chosen gate **asserts none of the 4 tickets' new fields** —
it runs the new code without crashing but never checks the new behavior. Three gaps are moderate + unit-test-
covered; **#43 was serious**: the wall-clock bound was never *observed* firing on a real browser (the existing
validators run `retrieve()` with the 90s default vs fast-clearing targets, so the bound never bites). A
regression would ship 200s+ calls holding scarce sessions → starvation on the 2-session gateway. Operator chose
**"close #43 first, then deploy."**

**New gate `scripts/validate-call-budget.mjs`** (committed `487e338`, both legs PASS in-container):
- **Leg A** — `core.render()` with `clearedTextLength` set unreachable so `isCleared` is always false; the
  clearance poll can then exit ONLY at the clearance timeout or the shared `budgetDeadlineMs` break. A render
  returning at ~budget (`wall=12.3s`) instead of ~clearance (~35s) proves the codex-r5 deadline cut a real,
  running poll. No proxy. (Gotcha found + fixed live: a 5s budget was too tight — udemy's goto under Rosetta
  ate it before the poll slept; needs budget=12s/clearance=30s so the poll has headroom past the goto.)
- **Leg B** — a forced-proxy retrieve with `callBudgetMs=500` bails before opening any proxied session
  (`retrieve.ts:778-784`), asserting `blocked=true / failureClass='timeout' / reason=null / proxyUsed=false`,
  **no proxy request billed**.

## What's next

### Gate-hardening follow-ups (3, accepted as tracked — operator declined the +#58 option this morning)
All moderate + already unit-test-covered; add when convenient so the real-browser gate asserts the new fields:
1. **#58** — add a drive-ACTION vendor assertion to `validate-failure-envelope` (mirror the existing navigate
   CF check on a real click/type that lands on a challenge; degrade-to-note on clear/IP-block).
2. **#44** — add a fake-solver + served-CAPTCHA-fixture leg asserting `captchaSolveReason` / `solverEligible`.
3. **#47** — add `GET /health` (200/401/403-Host) + `_meta` error-kind assertions to `validate-http`, and fold
   `validate-http` into the batched gate (it's HTTP-wrapper, deterministic — not real-browser territory).

### Remaining ticket spine: `#45 → #48 → #53 → #54`
- **#45** (burned-exit vs site-block + safe re-roll) is **MED-risk** and rewrites the escalation loop on both
  verbs — **run the pre-code critique first** (`dv:critique` / a 5-lens panel), per the plan. Coordinates with
  #43's documented drive-path env-timeout follow-up.
- **#48** ships the silent-home-fallback **detector** cleanly (HOLD #2 is only the location primitive).
- **#53** conservative authed-MCP slice (HOLD #3 is the posture confirm; #47 pre-settled the HTTP-vs-MCP fork).
- **#54** slot-release + shutdown-tolerance slice (HOLD #4 is the orphan reap; coordinates with #43's
  whole-operation-ceiling / hung-launch follow-up).

### 4 operator HOLDs still open (your calls; none block the spine's autonomous slices)
1. **#44 Turnstile precedence** — when CF + Turnstile markers co-fire, should `captchaKind=turnstile` win over
   `cf-challenge`? Needs a captured real CF managed-challenge fixture.
2. **#48 location primitive** — is a generic cross-site "a store/location is selected" snapshot primitive worth
   it, or keep per-site/deferred?
3. **#53 auth posture** — should `obscura status`'s health read move to an authed path consuming #47's internals?
4. **#54 orphan-reap** — `/proc` process-group sweep vs launch-side child capture vs accept-as-residual?

## Gotchas / watch-outs
- **colima is still running** (started this session for the gate). `colima stop` to free the VM when done.
- **Deploy = GH Actions dispatch, not a local push:** `gh workflow run deploy-http.yml -f image_tag=latest`
  pulls GHCR `latest` (CI builds it from main) and deploys over Tailscale with an on-host
  validate-http gate + auto-rollback. That on-host gate is a *basic HTTP liveness check* — it will NOT catch a
  subtle behavior regression (e.g. the #43 bound), which is why the in-container gate matters.
- **The gate deploys what CI built, not your local image.** Commit-to-main → CI rebuilds `latest` → deploy. A
  test-only script (like the #43 gate) changes the image digest but not the runtime; provenance stays clean
  (deployed digest maps to a known git SHA).
- **Codex runner:** `codex exec review --base main` with `run_in_background:true` (a raw `&` gives no
  completion notification; background codex got killed mid-flight twice overnight — just relaunch).
- **`git pull --ff-only origin main`** before the next branch (local main goes stale after each GitHub merge).
- **Public repo** — never commit fleet codenames (scrub source AND squash history before pushing).
- A `wafVendor`/`failureClass`/`timing`/`captchaSolveReason` value can be occasionally-imprecise on exotic/
  teardown/rotation edges — all are **diagnostics, never behavior/security decisions**.
