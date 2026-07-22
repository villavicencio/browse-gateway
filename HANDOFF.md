# HANDOFF — 2026-07-22, early afternoon

Session arc: `/pickup` → built **#48 (silent home-fallback detector)** end-to-end (understand-workflow →
implement → 4-round Codex loop → merge) → **ran the batched in-container gate → deployed to prod**. #48 is
now **live**. colima stopped at session end. Tree clean, no open PRs, main == prod.

## What We Built

- **#48 — silent home-fallback detector — MERGED (`1ce789c`, PR #68) + GATED + DEPLOYED (prod `sha256:edb1e576`).**
  A deep link (non-root path / query) that silently lands on the site's **bare root** is flagged so a caller
  can tell a real zero-result from lost location/query state. A 6-reader understand-workflow found #48 was
  *pre-wired* (reserved `FailureDiagnostics.homeFallback` slot, reserved `'ok'` FailureClass, `sanitizeUrl`
  preserving root-vs-deep).
  - **One shared pure predicate** `isHomeFallback(requestedUrl, finalUrl)` beside `isDeadExit`. Fires iff:
    same-host (via `canonicalizeHost`), landing is a **bare root** (root path, no fragment, no intent-bearing
    non-tracking query), AND the request carried intent now gone (deep path — index files root-equivalent —
    or a non-tracking query key). Positive-signal-only, on RAW urls pre-redaction.
  - **Orthogonal EVIDENCE, not a FailureClass** (preserves the #40 one-reason invariant). **One derivation,
    three carriers:** top-level `RetrieveResult.homeFallback` (the SUCCESS shape — a fat homepage has no
    envelope) + the pre-declared `FailureDiagnostics.homeFallback` slot on failures + a non-fatal
    `PageSnapshot.homeFallback` drive annotation (shared detector, differentiated disposition — a homepage is
    a returnable snapshot, never a drive failure). MCP success surfaces it via `structuredContent` (markdown
    stays pure). Files: `verbs/retrieve.ts` (predicate+seam+field), `verbs/index.ts`,
    `observability/failure-diagnostics.ts`, `browser/types.ts`, `mcp/drive-controller.ts`, `mcp/server.ts`.
  - **778 tests, 0 TS errors** (`test/home-fallback.test.mjs` 18 + 5 `mcp-surface.test.mjs` client-boundary).
    Learning: `docs/solutions/architecture-patterns/derived-evidence-boolean-carries-both-success-and-failure-shapes.md`.
  - **HELD (operator HOLD #2):** the location-context primitive (postal/store pre-seed + selected-store in
    snapshot) — NOT built. Issue #48 left OPEN with a status comment; only the detector half shipped.

- **Gated + deployed #48.** Full batched in-container gate on the #48 amd64 image PASS (see Gotchas for the
  exact commands): validate-stealth (CF 1/1 udemy, DataDome 1/1 seloger via IPRoyal ATTEMPTS=1/REQUIRED=1;
  webrtc/webgl/secret-leak/negative-control) + validate-drive + failure-envelope + retrieve + call-budget.
  Deploy `deploy-http.yml` run `29952128663`: on-host validate-http gate → pre-swap smoke → swap → verify OK,
  no rollback.

- **Prior this session (all deployed, detail in [[site-compat-hardening-epic]] memory + git):** gated+deployed
  the overnight #42-batch (#47/#58/#44/#43, prod `2258db74`) and reshaped/merged/gated/deployed #45
  (burned-exit + bounded drive loop, prod `0aa02c94`, 11-round Codex loop).

## Decisions Made

- **#48 complete surface over envelope-only (you chose via AskUserQuestion).** A fat-homepage fallback is a
  SUCCESS shape with no failure envelope, so the pre-declared slot alone would miss it → added the top-level
  `RetrieveResult.homeFallback` (+ `PageSnapshot.homeFallback` for drive) as the success-shaped carrier.
- **home-fallback is derived EVIDENCE, never a FailureClass** — preserves #40 one-reason; mirrors burned-exit's
  evidence half, skips its class half. No WAF vendor, never nulls the reason. **Do not relitigate.**
- **Shared detector, differentiated disposition** — retrieve surfaces an outcome flag; drive annotates the
  returned snapshot and returns (a homepage is returnable). Same allowed asymmetry as the content-family classes.
- **No config knob** — ships always-on like #40/#41/#42/#45 (a pure derived diagnostic, nothing to tune).
- **Deploy `latest` verified == the #48 digest** before dispatch (a prior handoff-doc push also ran CI/build-image,
  so I confirmed `imagetools inspect latest` == `sha256:edb1e576` == the `1ce789c` tag, not the earlier commit).

## What Didn't Work

- **My own test data used a bare `?utm=ad`** — `utm` (bare) is NOT a tracking key (real ones are `utm_source`,
  `utm_medium`, …), so under the corrected stricter predicate a non-tracking landed query correctly means
  "not a bare root". Two tests failed; fixed the data to `utm_source=ad`. (The logic was right; the fixture was wrong.)
- **The URL predicate is a false-positive treadmill** — each of the 4 Codex rounds surfaced a genuine new URL
  edge (tracking params → index files → landed hash-router fragments → path→query moves + trailing-dot host).
  The round-3 **reformulation to "landing is a bare root ∧ request carried intent now gone"** was more principled
  and subsumed several ad-hoc branches — that's what finally converged it. Lesson: for URL heuristics, find the
  invariant, don't accrete special-cases.

## What's Next

1. **Continue the spine: `#53 → #54`.** **#53** conservative authed-MCP status slice (operator HOLD #3 — auth
   posture). **#54** slot-release + orphan-Chromium reap (operator HOLD #4). Both are HOLDs — need your sign-off
   before starting.
2. **#48 location-context primitive** (operator HOLD #2) — the held second half of #48; #48 stays OPEN for it.
3. **#45 follow-ups (filed, deferred):** **#66** — a budget-truncated drive `goto` (headers before DCL) can pin
   a partial-200 as *success* not *timeout*; naive fix breaks CF-clearance, needs a `deadlineTruncated` snapshot
   signal gate-validated against the real CF path. **#67** — a responded-but-slow-DCL exit records status-null →
   burned-exit may over-fire (diagnostic-only); needs response-receipt tracked separately from `status`.
4. **Older tracked:** #44 Turnstile precedence (HOLD #1); 3 gate-hardening follow-ups (#58 drive-action vendor
   assertion, #44 fake-solver+fixture, #47 `/health` into validate-http). #48 minor deferrals (www↔apex,
   requested hash-router links, query value-drop, drive-failure envelope slot) — documented in the solution doc.

## Gotchas & Watch-outs

- **Prod state:** `sha256:edb1e576022f…` (git `1ce789c` = #48). Rollback anchor: `sha256:0aa02c94…`
  (git `7fba0b9` = #45). main == prod (nothing undeployed). Deploy run `29952128663`.
- **colima is STOPPED** (`colima start` — or the standard `colima start --vm-type vz --vz-rosetta` — before the
  next gate). The gate env-file is ephemeral (session scratchpad, gone); regenerate from `.env.spike`.
- **EXACT batched-gate recipe (reconstructed + run this session — reuse it, don't rediscover):**
  1. CI `build-image` (on main push) builds+pushes `ghcr.io/villavicencio/browse-gateway:latest` (amd64).
     Verify `latest` == the intended commit: `docker buildx imagetools inspect …:latest --format '{{.Manifest.Digest}}'`
     vs `…:<shortsha>` (a concurrent handoff-doc push can also move `latest`). `gh auth token | docker login ghcr.io -u <user> --password-stdin` if inspect 403s.
  2. `docker pull --platform linux/amd64 …@sha256:<digest>`.
  3. `set -a; . ./.env.spike; set +a` then run each leg in-container: `docker run --rm --init --platform
     linux/amd64 --shm-size 1gb -e BGW_ATTEMPTS=1 -e BGW_REQUIRED=1 -e BGW_NO_SANDBOX=1 -e BGW_CHANNEL=chrome
     -e BGW_PROXY_URL="$SPIKE_PROXY_URL" -e BGW_PROXY_USERNAME="$SPIKE_PROXY_USERNAME" -e
     BGW_PROXY_PASSWORD="$SPIKE_PROXY_PASSWORD" <img> node scripts/validate-stealth.mjs`. The image ENTRYPOINT
     provisions Xvfb then execs the command (default CMD IS validate-stealth); `--init` reaps Chrome. Free stack:
     swap the final arg for `scripts/validate-{drive,failure-envelope,retrieve,call-budget}.mjs` (default target
     udemy CF, clears from the Mac's residential IP with no proxy spend). **Stream `run_in_background:true`, NO
     `| tail`** (xvfb/pipe buffering — a wedged container shows nothing). `BGW_ATTEMPTS=1` alone false-fails; it
     NEEDS `BGW_REQUIRED=1` too.
  4. Deploy: `gh workflow run deploy-http.yml -f image_tag=latest` (resolves latest→digest, tailnet, on-host
     validate-http gate → pre-swap smoke → swap → verify → rollback-on-failure). Watch the run to `completed`.
- **Codex runner:** `codex exec review --base main`, `run_in_background:true`; strip rmcp/models_manager noise,
  parse the final `codex` text block. Commit and launch codex in SEPARATE calls (chaining `commit && codex` in
  one backgrounded call risks the task being killed).
- **A `homeFallback`/`wafVendor`/`failureClass`/`timing`/`burnedExit` value can be occasionally-imprecise** on
  exotic/slow-DCL/teardown/URL edges — all are **diagnostics, never behavior/security decisions**.
- **`git pull --ff-only origin main`** before the next branch. **Public repo** — never commit fleet codenames.
