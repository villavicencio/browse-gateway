---
title: Location-context is a composition of the pinned session + homeFallback, not a new gateway primitive
date: 2026-07-23
category: docs/solutions/architecture-patterns
module: mcp/drive-controller
problem_type: architecture_pattern
component: session-lifecycle
severity: low
applies_when:
  - "A caller needs a deep SPA/storefront link that renders off client-side location state (selected store / postal code)"
  - "A deep link without that state falls back to the site's bare root (now detected via #48 homeFallback)"
  - "You are tempted to add a withLocationContext / drive_with_location primitive to 'fix' the fallback"
related_components:
  - mcp
  - verbs/retrieve
  - observability
---

## Problem

Issue #48 asks, after the `homeFallback` *detector* shipped (a deep link that silently lands on the
site's bare root — see [derived-evidence-boolean-carries-both-success-and-failure-shapes](./derived-evidence-boolean-carries-both-success-and-failure-shapes.md)),
for a *fixer*: a primitive that establishes the location state and re-drives the deep link. SPA
storefronts key deep search/results pages off client-side state (selected store, postal code); a deep
link without it renders the app shell or falls back home. The proposed primitive
(`withLocationContext(steps, then)`) claimed three reusable contributions: **sequencing** (establish
state → re-navigate), **persistence** (state survives the re-navigate), and **verification** (re-check
`homeFallback` after).

## The decision: do NOT build the primitive — it already exists as a composition (option C + this doc)

All three "reusable parts" are **already provided** by the shipped drive model, so a new verb-layer /
MCP-tool surface would add only a renamed boolean over what the caller already has — at the cost of the
surface sprawl the issue's own non-goals exclude ("reusable primitives, not per-retailer recipes").

- **Persistence** — one MCP session ↔ one `DriveController` ↔ one **pinned browser session**
  (`drive-controller.ts` `#pinned`, reopened after an idle reap). Client-side state a picker sets via
  `browser_click` / `browser_type` lives in that one browser context and **survives a subsequent
  `browser_navigate`** to the deep link. No new persistence machinery is needed.
- **Sequencing** — the full `browser_*` verb suite is already exposed over MCP (`browser_open`,
  `browser_navigate`, `browser_click`, `browser_type`, `browser_select_option`, `browser_press_key`,
  `browser_wait_for`, `browser_snapshot`, …) and every call **serializes** on the controller's `#lock`.
  The caller issues the steps in order; the gateway already runs them one at a time on the same session.
- **Verification** — `navigate()` already annotates `homeFallback: true` on the returned snapshot
  (`drive-controller.ts:378`), NON-FATAL, with the documented intent *"letting the in-loop agent
  decide."* After the caller sets the store and re-navigates the deep link, **`!homeFallback` IS the
  "location established" signal** — the caller computes it from the field it already receives; a named
  `locationEstablished` boolean would only rename it.

Because the consumers are **LLM agents** (Atlas / Vault) — exactly the caller class that can drive a
bespoke store picker and already sequences verbs — the marginal value of a composite tool does not
justify a new surface. There is also **no site-agnostic "selected store" DOM signal** (every retailer's
picker is bespoke), so any gateway-side per-site step library (the rejected option B) would be a
rot-prone scraper database, not a primitive.

## The reusable choreography (this is the deliverable — knowledge, not surface)

A caller establishes location context using ONLY existing verbs, in one pinned MCP session:

1. `browser_open` (or the first `browser_navigate` to the store-picker page).
2. `browser_click` / `browser_type` / `browser_select_option` → set the store / postal code via the
   **site-specific** picker. (The gateway contributes nothing site-specific here — this is the caller's
   knowledge, by design.)
3. `browser_navigate(<deep link>)` → the client-side state set in step 2 **persists** (same pinned
   browser context), so the deep page can render against it.
4. Read the returned snapshot's `homeFallback`:
   - `homeFallback` absent/false → the deep link rendered against the state → **location established**.
   - `homeFallback: true` → the state did not stick (or the site re-fell-back) → retry the picker /
     adjust, or surface a real "could not establish location" to the human.

The gateway's job is the reusable substrate (persistence + sequencing + the `homeFallback` re-check);
the site-specific picker steps stay with the caller. That split — **session-state choreography, not
store-picker knowledge** — is the whole point, and it needs no new code.

## Why not build the thin helper anyway

`withLocationContext` would be a wrapper that takes caller-supplied verb-steps, runs them, re-navigates,
and returns `!homeFallback`. Every one of those pieces already works standalone; wrapping them buys a
one-call ergonomic for a caller class (LLM agents) that does not need it, and each new MCP tool is
permanent policy/observability/redaction surface. The reuse the wrapper was meant to provide — so each
consumer does not relearn the pattern — is delivered by **this document** at zero surface cost.

## Lesson

When a "new primitive" ticket lands, first check whether the platform's existing compositional
surface already expresses it. A pinned stateful session + a derived post-condition signal (`homeFallback`)
compose into "location context" without a dedicated verb. Prefer documenting the composition over
adding a wrapper tool when (a) the reusable substrate already exists and (b) the callers are agents that
can sequence the parts themselves — a renamed convenience is not worth permanent surface. The site-specific
half (the picker) has no site-agnostic signal, so it MUST stay with the caller regardless; a gateway-side
recipe map would only rot.
