# browse-gateway — project instructions

A Node/TypeScript browser-automation gateway fronting a headful-Chrome-under-Xvfb
browser core. See `README.md` for what it is and why.

> **Implementation plan & requirements live outside this repo.** They are kept private
> and are not committed here. Local context — including absolute paths to the plan,
> the requirements doc, and deployment notes — is in `CONTEXT.local.md` (gitignored).
> Read that first when picking up work.

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

## Secrets & hygiene

- No credentials in the repo. Proxy/CAPTCHA keys load from a secrets store at runtime,
  readable only by the gateway process — never logged, never in session/observability
  output.
- `.env*` and `*.local.md` are gitignored. Keep deployment-specific and fleet-specific
  detail in those local files, not in committed source.

## Vault lane

Durable cross-session notes for this project live in the shared Obsidian vault:
`~/Obsidian/hermes/projects/browse-gateway/`. Write durable notes there; read anywhere in
the vault when helpful, but write only to this lane unless asked.
