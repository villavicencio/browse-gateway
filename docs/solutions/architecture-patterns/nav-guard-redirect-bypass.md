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
resolution_type: known_limitation
related_components:
  - policy
  - egress
  - vault
tags: [navigation-guard, redirect, route-continue, policy-bypass, no-exfil, egress, known-gap, follow-up, p1]
---

# Navigation guard is bypassed by server 3xx redirects

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

## Fix direction (the follow-up P1 unit)

Re-assert the guard on every redirect hop instead of letting `route.continue()` auto-follow:

```
const res = await route.fetch({ maxRedirects: 0 });
while (res is 3xx with Location) {
  const next = resolve(Location, res.url());
  if (guard(navRequestFor(next)) !== "allow") return route.abort("blockedbyclient");
  res = await fetchFrom(next, { maxRedirects: 0 });   // carry method/headers/cookies correctly
}
return route.fulfill({ response: res });
```

## Gating

**This fix must land before U9 activation.** Once the consumer warm-open path is wired (U9), a
credentialed session is live, and the server-redirect hop becomes a live cookie-exfil vector against a
real stored credential. U9 must not be activated in prod until this redirect bypass is closed (and
validated against the container gates). The U7 credential clamp narrows but does not remove the vector.

## Why it is its own unit (not folded into U7)

- **High blast radius:** it changes how *every* request in the gateway is fulfilled
  (`route.fetch`/`route.fulfill` instead of `route.continue`), affecting render, drive, the CAPTCHA
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
