# browse-gateway — project instructions

A Node/TypeScript browser-automation gateway fronting a headful-Chrome-under-Xvfb
browser core. See `README.md` for what it is and why.

> **Implementation plan & requirements live outside this repo.** They are kept private
> and are not committed here. Local context — including absolute paths to the plan,
> the requirements doc, and deployment notes — is in `CONTEXT.local.md` (gitignored).
> Read that first when picking up work.

> **`HANDOFF.md` has a single owner: the primary local session.** It is overwritten wholesale on
> every write — no merge, no per-writer sections — so a second writer silently replaces the first
> and the only surviving copy is in git history. Agents that keep persistent context across
> sessions do not write it; their open threads belong in the issue tracker, which survives the
> overwrite and is where a human will look for them.

## Stack & conventions

- **Language:** TypeScript on Node. ESM modules (`.mjs`/`.ts`).
- **Browser engine:** real/patched Chrome via a Playwright-family driver, run **headful
  under Xvfb** — never `--headless` (strict headless fails the anti-bot challenges this
  gateway exists to clear).
- **Containerized:** the browser core and gateway run in Docker, resource-capped.
- **Policy lives in one place:** the navigation-layer allowlist and per-consumer auth are
  enforced below the verb layer, so every entry path (high-level verbs, low-level
  `drive()`, raw CDP-attach) obeys the same policy. Don't re-implement policy per surface.

## Intended layout

```
browse-gateway/
├── CONCEPTS.md             # shared domain vocabulary (entities, named processes, status concepts)
├── docker/
│   ├── Dockerfile          # Node + Chrome + Xvfb + driver
│   └── compose.yaml        # capped service def, private-network bind
├── src/
│   ├── gateway/            # service skeleton, session lifecycle
│   ├── browser/            # engine adapter: browser core
│   ├── policy/             # navigation-layer allowlist + per-consumer auth
│   ├── security/           # CDP-localhost binding, egress filter, secret loading
│   ├── verbs/              # retrieve(), proxy escalation, CAPTCHA hook
│   ├── mcp/                # MCP server exposing retrieve as a tool
│   ├── cli/                # obscura CLI: keys/connect/status (operator front door)
│   └── observability/      # viewer wiring, session retention/access
├── docs/
│   └── solutions/          # documented solutions to past problems, organized by category with YAML frontmatter (module, tags, problem_type)
├── scripts/
│   └── validate-stealth.mjs  # stealth-validation harness (the kill-gate)
└── test/
```

## Build order

The first unit is a **stealth-validation kill-gate**: stand up the browser core in Docker
and reproduce a known anti-bot bypass through the shipping vehicle before building
anything else on top of it. Everything downstream is blocked on that passing. The detailed
unit breakdown is in the private plan (see `CONTEXT.local.md`).

## Gates and measurement — rules that cost real time when broken

- **Run `validate-*.mjs` / `measure-*.mjs` ONLY in-container** (headful Chrome under Xvfb).
  Build: `docker build --platform linux/amd64 -f docker/Dockerfile -t browse-gateway:<tag> .`
  Run: `docker run --rm --platform linux/amd64 --shm-size=1g --init <tag> node scripts/<x>.mjs`
  In **zsh**, `$REPO:latest` triggers the `:l` modifier — write `"${REPO}:latest"`.
  Gates needing bind-mounts require the overlay-image approach (colima will not share
  `/private/tmp`), plus `--init`.
- **The runtime gate is not a formality.** It is the only stage that runs the real code against a
  real browser, and it has caught defects every unit test passed: a snapshot axis churning one
  capture pair in five while the no-churn test was green. Never accept a green unit run as evidence
  that browser-side behaviour holds.
- **`npm test` cannot be green on macOS — there is a large pre-existing failing set.** Measured
  2026-08-25 on `main`: **1498 tests, 1275 pass, 223 fail**, of which **211 are
  `artifact-filesystem-unsupported`**, confined to `test/artifact-*.test.mjs`,
  `test/browser-artifact-capture.test.mjs` and `test/retrieve.test.mjs`. The artifact store needs a
  Linux filesystem feature the host does not have. Consequences: a raw pass/fail count is **not** a
  signal here, and a real regression will hide in the noise. **Compare against a baseline on `main`
  rather than reading the absolute number** — `git stash -u && git checkout main && npm test` for the
  before-count, then the same on your branch; only a *delta* means anything. The artifact suite is
  verified in-container, like every other gate.
- **Know which deploy gate proves what — they are not interchangeable.** `scripts/validate-http.mjs`
  is **self-contained**: it builds its own handler and its own config (`:63-68`), and
  `scripts/deploy/deploy-on-host.sh:57-60` says so explicitly. It proves *code imported from `dist/`
  works inside the image*; it proves **nothing** about the launcher prod actually runs, so an
  assertion added there gates a server the gate itself constructed. The launcher gate is
  `scripts/deploy/preswap-smoke.sh`, which boots the real `launch-http.sh` against the real env and
  greps the boot line (`:78`). Both it and the post-swap verify probe **unauthenticated** `/mcp`
  expecting 401, so neither ever reaches per-connection code. Corollary: **anything that must fail a
  deploy has to be observable at boot** — resolve it beside the existing boot assertions in
  `src/mcp/http-main.ts:152-162` and emit it on the boot line at `:286-293`, never inside the
  per-connection `buildServer:` callback, where a throw is a per-session 500 that no deploy check
  sees. A plan asserted the opposite twice before anyone read the two scripts.
- **`main` is NOT branch-protected, so nothing mechanically blocks a merge.** There are no required
  status checks (`gh api repos/<owner>/<repo>/branches/main/protection` → 404 "Branch not
  protected"). A PR with **no CI run at all** still reads mergeable, which is a strictly weaker
  signal than the global "`mergeStateStatus: CLEAN` does not mean reviewed" rule assumes. Confirm a
  run EXISTS for the PR head sha before merging — `gh run list --limit 20 --json headSha,event,status`
  and look for your own sha — rather than inferring it from the absence of a red X. Observed
  2026-08-26 during a GitHub incident ("Actions and Pull Requests", ~4% of runs failed to initiate):
  a PR sat with a CodeRabbit check and no `ci` check whatsoever, and nothing about the PR view said
  so.
- **A guard, probe or control must be able to report bad news, and you must have watched it do so.**
  Verify every non-trivial gate RED by construction before keeping it. See
  `docs/solutions/best-practices/a-test-whose-stub-guarantees-the-assertion-proves-nothing.md` —
  three defects in one change were in the tests and controls themselves, all green, all proving
  nothing, because the stub could not express the failure.
- **Browser-side scripts are TypeScript template literals** (`FINGERPRINT_COLLECTOR_JS`,
  `CDP_TIMING_RAW_JS`, `DETECT_LIVE_CAPTCHA_JS`, …). They may contain **no raw backtick and no
  `${`** — including inside comments, where a backtick used for prose emphasis silently closes the
  string and breaks the build. A test asserts both; do not remove it.
- **Anything quantized into buckets and then diffed will churn if its typical value sits near a
  ladder edge.** Booleans, integer counts, and floored labels are safe; a raw millisecond bucket is
  not, and a MAX is worse than a median because one request decides it. Raw distributions belong in
  a snapshot-excluded constant, never in a diffed axis.
- **Measure; do not reason.** Several defects this project has shipped came from a comment
  asserting a property ("always false by construction", "the collector issues no requests") that a
  five-minute experiment disproved. If a claim is checkable, check it.

## Secrets & hygiene

- No credentials in the repo. Proxy/CAPTCHA keys load from a secrets store at runtime,
  readable only by the gateway process — never logged, never in session/observability
  output.
- `.env*` and `*.local.md` are gitignored. Keep deployment-specific and fleet-specific
  detail in those local files, not in committed source.
- **Fingerprint snapshots carry the egress IP** (`meta.egressIp`) and `INPUT_REALISM_OUT` has no
  redaction at all. Check any measurement JSON before pasting it into a ticket, a doc, or a commit.

## Vault

This project owns the Obsidian vault `~/Obsidian/browse-gateway/` (per-agent-vault standard,
2026-07-15). It holds durable cross-session notes plus the live agent memory
(`memory/` — the harness memory dir symlinks there). Manage it as this project sees
fit; read other vaults when helpful, write to them only when asked.
