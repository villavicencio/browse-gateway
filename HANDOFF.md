# HANDOFF — 2026-06-02

Picked up from the U6 cutover and ran two arcs. **Arc 1:** finished the residential-proxy
escalation work (escalate-on-hard-block + rotating-exit retry) and got it **verified live in
prod**. **Arc 2:** built the entire interactive **`drive` verb set** (Approach A, U1–U5) on a
feature branch — now **PR #2**, 98 tests green + an end-to-end browser proof passing.

> Provider names and per-host/agent specifics are deliberately kept out of this public file —
> they live in agent memory `retrieve-403-and-proxy-gaps` and gitignored `CUTOVER.local.md`.

## What We Built

**Arc 1 — proxy escalation (on `main`, pushed):**
- `f2a566e` feat(verbs): escalate-on-hard-block — `isHardBlock` (4xx/5xx + thin) in `detect.ts`, broadened `shouldEscalateToProxy` (CF challenge **or** hard block), `retrieve.blocked` also true on `status===null`. (cutover findings #2/#3)
- `bbe17da` fix(verbs): rotating-exit retry — session-level retry (3 attempts, 25s/attempt) in `retrieve.ts`. Root cause = rotating residential exit variance (~83% healthy/fail-fast), **not** route-interception-breaks-proxy-auth (disproven).
- `0b8d742` `scripts/validate-proxy-escalation.mjs` proof; `4822c82` docs: `docs/solutions/runtime-errors/residential-proxy-rotating-exit-retry.md`.
- **Verified end-to-end on prod** through the residential proxy (`browse-gateway:proxyretry` image): a hard reputation-403 target cleared via a fresh residential exit (~3KB markdown). Promoted `:proxyretry` → `:latest`, gateway-runtime restarted (one container confirmed on the new image; see #6 below).

**Arc 2 — drive feature (branch `feat/drive-interactive-verbs`, [PR #2](https://github.com/villavicencio/browse-gateway/pull/2)):**
- `e4d85f4` **U1** — core interactive primitives (`navigate/snapshot/click/type/selectOption/pressKey/waitFor/screenshot/closeActivePage`) + aria-ref snapshot model (Patchright `ariaSnapshot({mode:"ai"})` + `aria-ref=`, verified on 1.60; `targetToSelector` in `patchright-core.ts`).
- `940b552` **U2** — persistent consumer-bound sessions + idle reaping (`session.ts` consumerId/lastActivityAt/touch; `session-manager.ts` per-consumer cap + `reapIdle`/`startReaper`; gateway `openConsumerSession`/`useConsumerSession`/`closeConsumerSession`).
- `aa61f00` **U3** — 10 `browser_*` MCP tools + `GatewayDriveController` (`src/mcp/{server,drive-controller,main}.ts`); `retrieve` description strengthened (read-vs-act).
- `ebd4139` **U4** — proxied drive with healthy-exit retry (`src/verbs/drive.ts`: `proxyOverrideFor`/`navFailed`; first navigate retries fresh exits then pins; mid-flow failure → restart error).
- `faada8b` **U5** — `scripts/validate-drive.mjs` in-container end-to-end proof.
- **98 unit tests green; `validate-drive.mjs` → PASS (0/0)** against a real browser (navigate+snapshot, off-allowlist-blocked-on-drive, type+submit state change, idle reap, clean close).
- ce-compound architecture doc `docs/solutions/architecture-patterns/interactive-drive-verbs-over-policy-guard.md`.

Also: dogfooded `retrieve`+`drive` on a proxy vendor's JS pricing page to answer a PAYG question (and proved retrieve-vs-drive in the process — see What Didn't Work).

## Decisions Made
- **Drive = Approach A** (high-level verbs only, never raw CDP) — the consumer can't disable the below-verb-layer `context.route` guard, so the interactive surface is safe under existing enforcement. **Approach B (CDP-attach) deferred** behind the U7 NET_ADMIN egress sidecar (raw CDP *can* bypass the in-browser guard).
- Snapshot/ref via Patchright's built-in `ariaSnapshot({mode:"ai"})` — no DOM-walk needed (KTD-2 verified empirically). KTD-3: one implicit active drive session per consumer.
- Residential proxy provider chosen (never-expiring PAYG); escalate-on-hard-block (not always-on).
- A **cheaper alternative provider is parked as a fallback** — non-expiring PAYG at ~$4/GB vs the current ~$5–7/GB. Do NOT switch on price alone: A/B exit reliability first (exit health, not $/GB, decides). Provider names + the comparison are in memory `retrieve-403-and-proxy-gaps`.

## What Didn't Work
- **"Request interception (`context.route`) breaks Chromium proxy auth"** — plausible, nearly implemented a `Proxy-Authorization` fix; a 3-config probe **disproved** it. Real cause was rotating-exit flakiness. Don't re-chase.
- **`retrieve`/Readability on a JS pricing widget** → returns marketing boilerplate (extracts an "article"); use `drive`'s accessibility snapshot for interactive/widget content.
- httpbin.org is flaky as a deterministic test target (degrade to a note, not a failure).

## What's Next
1. **Review + merge [PR #2](https://github.com/villavicencio/browse-gateway/pull/2)** (drive feature) — the headline deliverable.
2. **Before enabling drive in prod: bump `BGW_MAX_SESSIONS` > 1** — held drive sessions share the global session pool with `retrieve`; at 1, a held drive session starves `retrieve`.
3. **U7** — capped-deploy tuning vs measured headroom, observability/retention, and the NET_ADMIN egress sidecar (also unblocks Approach B / CDP-attach).
4. **(Optional) alternative-provider A/B** — buy a few GB PAYG, run `validate-proxy-escalation.mjs` against it, compare exit reliability/latency to the current provider; switch is a `BGW_PROXY_*` creds-only change if it holds up.
5. **Confirm the second prod runtime** is on the new `:latest` (proxyretry) image — only one container was confirmed running on it; the second runtime may still hold an old container until restarted.

## Gotchas & Watch-outs
- **PUBLIC repo** — never commit fleet detail (host / agent / path / vendor / exit-IP names) in source, comments, commit messages, or fixtures (incl. this file). Pre-commit scrub-grep gated on exit status; fleet specifics live in gitignored `CUTOVER.local.md` / `CONTEXT.local.md` and agent memory.
- **`BGW_MAX_SESSIONS=1` in prod** will starve `retrieve` once a drive session is held — bump before enabling drive (#2).
- **Drive sessions are DIRECT** (no proxy) unless `BGW_ON_DATACENTER_IP=1` + proxy configured. Proxied drive retries a healthy exit at the **first navigate only**; a mid-flow block → clean restart error (no live exit swap, which would lose page state).
- **Proxy reliability, not price, decides** provider choice (~83% healthy/fail-fast → 3-retry ≈ 99.5%). A cheaper, dirtier pool can cost more per *successful* fetch.
- **IP reputation is real** — don't hammer one CF target from the prod DC IP; it 403s and the stealth core can't recover it (only a clean residential exit does).
- **Patchright API:** `ariaSnapshot({mode:"ai"})` is the ref-snapshot path (`_snapshotForAI` is gone in 1.60); `aria-ref=<ref>` resolves a ref to a locator.
- **Stealth gate envs:** set both `BGW_ATTEMPTS=1` + `BGW_REQUIRED=1` for a quick confirm; `3/3` is the real bar.
- The drive plan lives in gitignored `docs/plans/2026-06-01-001-feat-drive-interactive-verbs-plan.local.md` (`status: completed`).
