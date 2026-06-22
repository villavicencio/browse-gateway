---
title: PerimeterX press-&-hold served as a 200 iframe challenge false-negatives block detection
module: browser/detect + verbs/retrieve
date: 2026-06-22
problem_type: integration_issue
component: block-detection
severity: high
symptoms:
  - "retrieve() against a PerimeterX-protected page (Total Wine) returns isError:false and hands back the 'Before we continue… Press & Hold to confirm you are a human' challenge shell AS readable content"
  - "No perimeterx-challenge classification and no #21 proxyDiagnostic emitted, even though PX recognition shipped in #21"
  - "The same URL on the drive path correctly fails (escalation exhausted, last status=403) — only retrieve mis-reports"
  - "classifyBlock returns null for the challenge despite BLOCK_PHRASES already containing 'confirm you are a human'"
root_cause: incorrect_assumption
resolution_type: bug_fix
related_components:
  - block-detection
  - proxy-escalation
  - perimeterx
tags: [perimeterx, press-and-hold, block-detection, false-negative, iframe, retrieve, classifyBlock, issue-21, total-wine]
---

# PerimeterX press-&-hold served as a 200 iframe challenge false-negatives block detection

## Problem

Issue #21 added PerimeterX recognition (`isPerimeterXVisible`, `hasPerimeterXHint`/`pxHint`, the
`perimeterx-challenge` `BlockReason`). A live gateway probe of Total Wine
(`https://www.totalwine.com/p/91181175`) through the residential proxy showed `retrieve()` returning
`isError: false` with the **press-&-hold challenge shell as the "readable content"** — no
`perimeterx-challenge` classification, no escalation diagnostics. A caller asking to read the page
would receive the bot-wall copy as if it were the product.

## Symptoms

- `retrieve` → `isError: false`; markdown body is `"Before we continue… Press & Hold to confirm you
  are a human (and not a bot)… Reference ID <uuid>"`.
- No `reason=perimeterx-challenge`, no `proxyDiagnostic` (the verb believed it succeeded, so it never
  built one).
- The **drive** path (`browser_navigate`, force-proxy) on the same target correctly threw escalation
  exhaustion with `last status=403`.
- `classifyBlock` returned `null` for the challenge — even though `BLOCK_PHRASES` already contains
  `/confirm you are (?:a )?human/i`, which the challenge text matches.

## Root Cause

The #21 detection assumed *"PerimeterX serves a 403 + thin-body hard block"*, so PX attribution sat
**behind** the `blocked` gate (`status===null || isVisiblyBlocked || isHardBlock`). Total Wine's PX
violates both halves of that assumption:

1. **Served with a 200** (per-exit/per-request; drive exits got 403, the retrieve exit got 200) →
   `isHardBlock` (needs 4xx/5xx **and** thin body) is false.
2. **Widget renders in a cross-origin iframe** → the visible "Press & Hold" / "confirm you are a
   human" phrase never reaches the top document's `innerText` (`render.text`). It lives only in
   `render.html`, which `extractMarkdown` scrapes (hence the challenge appears as "content") but which
   the phrase-based `isVisiblyBlocked` / `isPerimeterXVisible` never inspect.

So the `blocked` gate was false → `classifyBlock` returned `null` → `isPerimeterXVisible`/`pxHint`
attribution (which is gated behind `blocked`) was never reached. The PX recognition #21 added was
effectively dead for a 200 iframe challenge — the exact way Total Wine deploys it.

## What Didn't Work

- **"Add `isPerimeterXVisible` to the blocked gate."** It reads the same thin `render.text`, so it
  also misses an iframe challenge. The visible-phrase path can't see iframe-rendered copy.
- **"Gate on `pxHint` alone."** The `px-captcha` / `_px3` HTML markers **persist on a cleared page**
  (verified: a successfully-loaded Total Wine product page still contains `px-captcha`). Gating on
  `pxHint` alone would false-positive every successful fetch from any PX-protected site.

## Resolution

A PX challenge is `pxHint` **AND** no real content rendered. The HTML marker says "PX is here"; thin
content says "the product did not load" — together they mean the press-&-hold shell. A cleared page
carries the same marker but renders fat product content, so it's untouched.

New primitive `isPerimeterXChallenge(signal, pxHint)` in `src/browser/detect.ts`:

```ts
export function isPerimeterXChallenge(signal: Pick<PageSignal, "text">, pxHint: boolean): boolean {
  return pxHint && signal.text.trim().length < MIN_CONTENT_LENGTH;
}
```

Folded into the `blocked` decision in three places that must stay in lock-step
(`src/verbs/retrieve.ts`): `classifyBlock`'s gate (drive↔retrieve parity), the proxy retry-break (so
a 200 challenge isn't treated as "landed a working exit"), and retrieve's final `blocked` decision.
Once `blocked` is true, the existing `isPerimeterXVisible || pxHint` arm attributes it
`perimeterx-challenge`.

## Prevention / Notes

- **Detection assumptions about a vendor's *transport* (status code, same-doc vs iframe) are
  fragile.** PX varies status per exit and renders behaviorally in an iframe; key on the durable
  signal (vendor marker present + did real content render?) rather than on a status/thin-body shape.
- **A persistent vendor marker is necessary but never sufficient** to call a page blocked — always
  pair it with a content/clear signal (this is the same lesson as the original "don't decide blocked
  on HTML scripts that survive a clear" rule, applied to PX).
- **PerimeterX press-&-hold is still CLASSIFIED, not CLEARED.** This fix makes the failure *legible*
  (correct `perimeterx-challenge` + diagnostics); defeating it remains the deferred gesture-automation
  spike. Fires even on a residential exit — it is behavioral, not IP-reputation, gated.
