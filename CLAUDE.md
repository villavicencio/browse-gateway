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
