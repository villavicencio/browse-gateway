# browse-gateway

A self-hosted, owned browser-automation gateway. A single Node/TypeScript service
fronts a real-Chrome browser core and exposes a high-level, outcome-oriented API to
its consumers — centralizing stealth, proxy escalation, CAPTCHA handling, access
policy, and observability in one place instead of wiring each consumer to a per-agent
SaaS browser.

## Why

Browser automation tends to fragment: every consumer wires up its own SaaS browser
dependency, with no shared place to hold proxy/CAPTCHA credentials, enforce an access
policy, or see what the browsers are actually doing. `browse-gateway` is the opposite
bet — own the full stack behind one surface, so policy and observability are consistent
and the browser engine stays swappable.

## What it does

- **Outcome-oriented API.** `retrieve(url)` returns clean, readable markdown;
  `synthesize(url)` returns synthesized content. A low-level `drive()` escape hatch
  remains available for interactive automation the high-level verbs don't cover.
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
   (MCP / CDP)   │      browse-gateway     │ ──► browser core
                 │  • outcome verbs        │     (real Chrome,
                 │  • stealth tier         │      headful under Xvfb)
                 │  • scoped proxy         │ ──► residential proxy (opt-in)
                 │  • CAPTCHA              │ ──► CAPTCHA solver
                 │  • allowlist + auth     │
                 │  • observability        │
                 └────────────────────────┘
```

## Stack

Node / TypeScript · Docker · real Chrome + Xvfb · Playwright-family driver · MCP server.

## Status

Early. v1 is in progress, gated on a stealth-validation kill-gate before the rest of the
service is built.
