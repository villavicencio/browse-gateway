# Obscura

```
  ,___,
  (o,o)     O B S C U R A
  {`"'}     see without being seen
  -"-"-
```

A self-hosted, owned browser-automation gateway. A single Node/TypeScript service
fronts a real-Chrome browser core and exposes a high-level, outcome-oriented API to
its consumers — centralizing stealth, proxy escalation, CAPTCHA handling, access
policy, and observability in one place instead of wiring each consumer to a per-agent
SaaS browser.

**Obscura** is the brand and the front door; **`browse-gateway`** is the technical
handle underneath (the `BGW_*` env, the Docker image, the `mcp__browse-gateway__*`
tool prefix). The plumbing keeps its name; you talk to the owl.

## Connect in one command

Onboarding a consumer used to be a three-act manual chore: mint a bearer token into
the prod env, stand up a hardened SSH tunnel, register the MCP endpoint, verify.
Now:

```
$ obscura connect
✓ connected as <consumer> · gateway healthy
```

`connect` discovers your key, raises the durable tunnel (a self-healing LaunchAgent
with a self-disable valve so a dead host can't reconnect-storm), registers the
gateway with your MCP client, and verifies end-to-end — with distinct diagnostics
for every way it can fail.

The rest of the lifecycle is just as direct:

```
$ obscura keys new <consumer>    mint + install a consumer key (staged; --apply restarts)
$ obscura keys list              configured consumers (ids and scopes, never tokens)
$ obscura status                 at-a-glance health: tunnel / gateway / consumers
  (^,o)  tunnel up · gateway healthy
```

> **Current limitation (2026-10): `obscura keys` does not work against the current prod host from the
> dev machine.** Every `keys` subcommand that touches the consumer manifest or env file (`new`, `list`,
> `revoke`, with or without `--apply`) reaches the host over the `adminSsh` login in your Obscura config,
> and there is no unattended SSH login from the dev machine as the account that owns those files. The host
> itself is not closed to operators; that one route is what is missing.
>
> **Supported path today:** change consumer keys **on the host**, as the gateway's service account. Mint the
> token there, add it to the env file with hidden input (`read -rs`, so the key never appears on screen, in
> shell history, or in chat), update the consumer manifest, then run a normal gated deploy with
> `scripts/deploy/deploy-ref.sh`, because the container only loads env changes when it is re-created.
> Deliver the token to the consumer's machine without passing it through chat; copying a key off a screen
> into a chat is not an acceptable workaround.
>
> Restoring `obscura keys … --apply` would need a dedicated, key-only SSH login for that account,
> restricted to the dev machine's tailnet address. That is an operator decision, not a default; key
> rotation is rare enough that the on-host path is fine.

## Why

Browser automation tends to fragment: every consumer wires up its own SaaS browser
dependency, with no shared place to hold proxy/CAPTCHA credentials, enforce an access
policy, or see what the browsers are actually doing. Obscura is the opposite
bet — own the full stack behind one surface, so policy and observability are consistent
and the browser engine stays swappable.

## What it does

- **Outcome-oriented API.** `retrieve(url)` returns clean, readable markdown;
  `synthesize(url)` returns synthesized content. A low-level `drive()` escape hatch
  remains available for interactive automation the high-level verbs don't cover.
- **Search as a verb, not a URL.** `search(query)` returns ranked results (title, URL,
  snippet) from a sanctioned search API, so a client finds candidate URLs and then
  `retrieve`s one — instead of manufacturing a SERP URL and inheriting an engine's markup,
  its challenges, and the wrong retry semantics. Off unless configured; see
  [`src/search/README.md`](src/search/README.md).
- **Real-Chrome stealth core.** A patched/real Chrome running **headful under Xvfb**
  (a virtual display) — not `--headless` — which clears modern anti-bot challenges that
  strict-headless browsers fail.
- **Scoped proxy escalation.** Runs direct by default; routes a session through a
  residential proxy only when a target actually warrants it, so proxy cost/latency is
  incurred per-need rather than always-on.
- **CAPTCHA handling.** Solves a challenge mid-flow via a configured solver and continues
  the session rather than failing.
- **Navigation-layer allowlist.** A domain allowlist enforced at the navigation layer
  (intercepting requests), so neither the high-level verbs nor the low-level escape hatch
  can drive the browser to unapproved destinations.
- **Per-consumer identity + session observability.** Distinct credentials per consumer,
  per-consumer audit, and live-view/replay of sessions with retention and access controls.

## Architecture

```
   consumers ──► ┌────────────────────────┐
   (MCP / CDP)   │         Obscura         │ ──► browser core
                 │     (browse-gateway)    │     (real Chrome,
                 │  • outcome verbs        │      headful under Xvfb)
                 │  • stealth tier         │
                 │  • scoped proxy         │ ──► residential proxy (opt-in)
                 │  • CAPTCHA              │ ──► CAPTCHA solver
                 │  • allowlist + auth     │
                 │  • observability        │
                 └────────────────────────┘
```

## Stack

Node / TypeScript · Docker · real Chrome + Xvfb · Playwright-family driver · MCP server.

## Status

Live for its first consumers. The gateway core — stealth-validated browser engine,
navigation-layer policy, multi-consumer MCP over HTTP, CI/CD with a pre-swap smoke
gate — runs in production. The `obscura` CLI is the new front door over it.
