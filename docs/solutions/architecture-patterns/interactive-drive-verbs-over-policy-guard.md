---
title: Interactive browser-driving as high-level verbs over a below-verb-layer policy guard
date: 2026-06-02
category: architecture-patterns
module: drive surface (verbs / mcp / browser core)
problem_type: architecture_pattern
component: service_object
severity: medium
applies_when:
  - "Adding an interactive surface (clicks, forms, multi-step) to a policy-guarded browser gateway"
  - "Letting an agent drive a browser through your guarded stack instead of its own non-stealth built-in browser"
  - "Deciding whether to expose high-level verbs vs. raw CDP / page-eval to a consumer"
  - "Building the snapshot + click-by-ref layer for a Playwright/Patchright driving surface"
tags: [agent-native, browser-automation, mcp, patchright, aria-snapshot, policy-below-verb-layer, drive, stealth]
---

# Interactive browser-driving as high-level verbs over a below-verb-layer policy guard

## Context

The gateway exposed one read verb — `retrieve(url) -> markdown` (stateless: open session → render → release). But any task needing **interaction** (click, fill a form, multi-step flow) had no stealth, policy-guarded path, so the agent fell back to its own **non-stealth built-in browser** — which gets `Forbidden` on protected pages and, more importantly, bypasses the gateway's allowlist / auth / egress guarantees.

The goal: add a stateful `drive` surface so the agent can *act* through the **same** stealth core and policy guard it already reads through — without opening a hole in the security model. This pattern captures how to do that safely, and where the boundary is.

## Guidance

**1. Expose only high-level verbs. Never raw CDP. This is the safety basis.**
Give the consumer `navigate / snapshot / click / type / select / press / wait / screenshot / close` — each of which acts on a page inside the core's already-guarded context, so every request it triggers still passes the navigation-layer allowlist + egress filter. Because the consumer never gets raw CDP, it **cannot** call `Fetch.disable` or otherwise remove the guard. Enforcement stays *below the verb layer*, so a new verb surface inherits policy for free.

Corollary: **raw CDP-attach** (pointing the agent's own browser tools at the gateway's Chrome) is the tempting shortcut — zero re-implementation — but raw CDP *can* subvert the in-browser guard, so it must wait for a **network-layer egress floor** (e.g. an allowlist enforced at the container's egress, not just in-browser request interception). High-level verbs ship now; CDP-attach is deferred behind that floor.

**2. Build the snapshot/ref model on the driver's built-in accessibility snapshot — don't reinvent it.**
Playwright/Patchright expose an AI-oriented accessibility snapshot with stable element refs. Use it instead of a hand-rolled DOM-walk or CSS-selector scheme:

```ts
// snapshot -> a ref-annotated accessibility tree (Patchright/Playwright 1.60+)
const tree = await page.locator("html").ariaSnapshot({ mode: "ai" });
//   - button "Click me" [ref=e4]
//   - textbox "Your name" [ref=e5]

// a ref resolves + acts via the aria-ref selector engine
await page.locator("aria-ref=e4").click();
```

Mirror an existing tool's shape (here: Playwright-MCP's `target` = ref-or-selector + `element` = human description) so an agent's prior browser-driving competence transfers. Map a ref to a locator with a tiny pure helper:

```ts
// a snapshot ref ("e4", frame-prefixed "f1e2") -> aria-ref selector; else passthrough as a selector
const REF = /^[a-z]?\d*e\d+$/i;
const targetToSelector = (t) => (REF.test(t.trim()) ? `aria-ref=${t.trim()}` : t);
```

Ref stability is the hard part of any browse-by-AI surface; borrowing the driver's built-in mode makes it a non-problem. (`_snapshotForAI` was the older internal entry point; `ariaSnapshot({ mode: "ai" })` is the current public path.)

**3. Make sessions persistent and consumer-bound, sharing one core + guard with the read verb.**
Interaction is stateful, so a session must survive across calls: `open` (authenticate → acquire → install the consumer's guard → return a handle, *not* released) → `use(handle, fn)` (re-auth + verify the handle belongs to this consumer + refresh idle timer) → `close`. The stateless read verb keeps its acquire→run→release path; only *when release happens* differs. A held interactive session pins a real browser, so cap per consumer and idle-reap.

**4. Split read vs. act, and steer it.** `retrieve` (article→markdown) for reading; `drive` (AX snapshot + verbs) for interacting. Tell the agent so in the tool descriptions — the read verb is "preferred for fetching content," the drive verbs are "only when you must interact."

## Why This Matters

- **Security:** the high-level-verbs-only rule is what lets the interactive surface ship under the *existing* enforcement — the consumer literally cannot reach the primitive (raw CDP) that would let it disable the guard. Off-allowlist navigation is blocked on the drive path exactly as on the read path. Skip this rule and you've widened the attack surface.
- **Cost/risk:** reusing the driver's AX snapshot eliminates the riskiest sub-problem (ref stability) and gives the agent familiar ergonomics, so the tool layer becomes thin parameter-plumbing.
- **Capability without regression:** the read verb is untouched; the agent now does *everything* through one stealth + policy door — read with one verb, act with another.

## When to Apply

- You have a guarded/stealth browser surface and need to add interaction without re-deriving the guard per surface.
- You're weighing "expose verbs" vs. "expose CDP/eval" to an agent — default to verbs; gate CDP behind a network-layer egress floor.
- You're building snapshot + click-by-ref for a Playwright/Patchright driver — reach for `ariaSnapshot({ mode: "ai" })` + `aria-ref=`, not a custom scheme.

## Examples

**Read-vs-act, demonstrated.** Asked to read a proxy vendor's JS-rendered (Framer) pricing page: `retrieve` cleared the page (status 200, not blocked) but Readability returned **marketing boilerplate** — it extracts an "article," and the prices live in an interactive widget. The `drive` path's accessibility snapshot captured the actual pricing component, and a `click` on the toggle's ref ran end-to-end:

```
- paragraph [ref=e198] [cursor=pointer]: Pay As You Go
- heading "$0.49/GB" [level=2] [ref=e203]
- heading "100GB/month" ... "$49.99/month" ...
```

That is the rule of thumb in one screen: **article extraction for content, accessibility snapshot for interactive/widget content.**

**The guard still applies to every drive action.** In the end-to-end proof, an off-allowlist `navigate` is aborted by the same `context.route("**/*")` guard the read verb uses — the drive verb surfaces it as a clean error, never a silent navigation. The consumer never touched CDP, so it never had the means to turn that guard off.

## Related

- `docs/solutions/runtime-errors/residential-proxy-rotating-exit-retry.md` — the proxy-exit retry the proxied *drive* session reuses (land a healthy exit at open, pin it); adjacent surface, distinct concern.
- Project memory `retrieve-403-and-proxy-gaps` — escalate-on-hard-block + provider notes that the drive proxy posture builds on.
- The deferred **raw CDP-attach** path is conceptually adjacent to the secrets/egress posture in `CLAUDE.md`; when a network-layer egress floor is documented, cross-reference it here.
