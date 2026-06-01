---
title: Residential proxy escalation flakily fails on dead rotating exits
date: 2026-06-01
category: runtime-errors
module: verbs (retrieve / proxy escalation)
problem_type: runtime_error
component: service_object
symptoms:
  - "Proxied escalation render intermittently returns empty content (net::ERR_EMPTY_RESPONSE) or times out, with no code change between runs"
  - "retrieve() reports the fetch as failed/blocked even though the proxy credentials and endpoint are valid"
  - "Single-shot proxy probes (wget, raw Chrome) succeed on one run and fail on the next, so the wiring looks both fine and broken"
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags: [residential-proxy, rotating-exit, proxy-escalation, patchright, retry, retrieve, chromium-proxy-auth]
---

# Residential proxy escalation flakily fails on dead rotating exits

## Problem

When `retrieve()` escalated a hard-blocked fetch through a rotating residential proxy, the proxied render *intermittently* came back empty or timed out — surfacing as a failed retrieve — even though the proxy credentials and endpoint were correct. The failure was non-deterministic: the same target and code would clear cleanly one run and fail the next.

## Symptoms

- A proxied render returns empty text (`net::ERR_EMPTY_RESPONSE`) or hits the navigation timeout, intermittently.
- `retrieve()` reports `blocked`/failed with valid proxy creds.
- Single-shot connectivity probes (one `wget` through the proxy, one raw Chrome launch) succeed sometimes and fail other times — the wiring appears simultaneously fine and broken.

## What Didn't Work

- **Wrong hypothesis (disproven): "the nav-guard's `context.route("**/*")` CDP Fetch interception breaks Chromium proxy authentication."** The reasoning was plausible — request interception is a known foot-gun around proxy auth — and a `Proxy-Authorization` header-injection fix was nearly implemented. A three-config probe (no-route control / route + plain `continue()` / route + `Proxy-Authorization`) **disproved it**: both the with-route and no-route configs showed *mixed* pass/fail across runs, and each run reported a *different* exit IP. Route interception and proxy auth coexist fine.
- **Trusting single-shot probes.** A lone `wget`-through-proxy and a lone raw-Chrome launch both "worked," which falsely implicated the gateway's own proxy wiring. They had simply drawn a healthy exit that run.

The unifying tell, missed at first: the exit IP changed on every fresh attempt. The failures tracked the *exit*, not the code path.

## Solution

A rotating residential proxy assigns a **new exit IP per session/connection**, and a fraction of exits are dead or slow. The fix is resilience at the right layer — retry the whole proxied **session**, because each fresh session draws a fresh exit. Retrying a new *page* on the same browser context reuses the same (possibly dead) exit and accomplishes nothing.

In `src/verbs/retrieve.ts`, the escalation step retries across fresh proxied sessions:

```ts
const PROXY_MAX_ATTEMPTS = 3;
const PROXY_NAV_TIMEOUT_MS = 25_000; // margin over the slowest good exit observed (~17s)

if (proxy && shouldEscalateToProxy(render, render.status, escalation)) {
  proxyUsed = true;
  for (let attempt = 1; attempt <= PROXY_MAX_ATTEMPTS; attempt++) {
    // Each withConsumerSession({proxy}) launches a fresh context => a fresh rotating exit.
    render = await gateway.withConsumerSession(
      token,
      (s) => s.core.render(url, renderOpts),
      { proxy, navigationTimeoutMs: PROXY_NAV_TIMEOUT_MS },
    );
    // Real page landed -> done. Retry on a failed nav (null status) or a still-blocked result.
    if (render.status !== null && !isVisiblyBlocked(render) && !isHardBlock(render, render.status)) {
      break;
    }
  }
}
```

Plus: a fully failed navigation (`status === null`) is now treated as `blocked`, so an exhausted retry returns a block signal instead of empty content masquerading as a successful fetch:

```ts
blocked: render.status === null || isVisiblyBlocked(render) || isHardBlock(render, render.status),
```

Verified end-to-end against the live stack: a real reputation-403 target that the datacenter IP could not clear came back as ~3 KB of readable markdown via a fresh residential exit (`proxyUsed: true`, `blocked: false`).

## Why This Works

Measured behavior of the rotating residential proxy (in-container, 2026-06-01):

- **Within one browser context the exit IP is stable** — 5/5 sequential fetches reused the same IP, fast (~2 s cold, then ~400 ms).
- **Each fresh context draws a new exit** — every fresh session reported a distinct IP.
- **~83% of fresh sessions get a healthy exit; ~17% are dead.** Dead exits fail *fast* (`net::ERR_EMPTY_RESPONSE` in ~300 ms), and the occasional good-but-slow exit answered in ~17 s.

So the failure was never the gateway's proxy wiring or auth — it was the luck of the per-session exit draw. Retrying at the session level cycles past dead exits: at ~83%/attempt, 3 fresh sessions ≈ 99.5% success. The shorter per-attempt nav timeout (25 s, margin over the ~17 s slowest good exit) bounds a hung exit so the retries stay fast, and dead exits already fail fast on their own.

## Prevention

- **Treat a rotating residential proxy's per-session exit as unreliable by design.** Build session-level retry-on-fresh-exit into any proxied path from the start; never assume a single proxied attempt suffices.
- **Never conclude determinism from single-shot tests against a rotating proxy.** Measure cross-session reliability — launch *N fresh* sessions and report success rate + per-exit IP + latency — before blaming code. (A single warm-context loop will look 5/5 and mislead, because the exit is stable *within* a context.)
- **Triage order when a proxied fetch is empty but creds look valid:** (1) Chrome-free `wget`/curl through the proxy to confirm creds/endpoint and see the real error; (2) an N-fresh-session reliability probe to measure the dead-exit rate; *then* (3) suspect code. This ordering would have skipped the route-interception detour entirely.
- The `scripts/validate-proxy-escalation.mjs` harness encodes this: its exit-IP check retries past dead exits, and a deterministic-403 target degrades to a note when unreachable rather than a false failure.

## Related Issues

- Builds directly on the U6 cutover findings this escalation path was created for: `isHardBlock` (4xx/5xx + thin body) detection and the broadened `shouldEscalateToProxy` (escalate on a Cloudflare managed challenge **or** a hard IP/WAF block). Those live in project memory (`retrieve-403-and-proxy-gaps`).
- `docs/solutions/runtime-errors/xvfb-run-wedges-container-as-pid1.md` — same subsystem (containerized headful Chrome / browser core) and the same methodological lesson: disprove the seductive, expensive hypothesis cheaply before implementing against it.
