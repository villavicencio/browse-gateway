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

## Follow-up: the thin-content test was incomplete (a 200-chase caught a residual miss)

After deploying the first fix, a loop chasing a live 200 caught a challenge that *still* came back as
content. The thin-content discriminator (`pxHint && render.text.trim().length < 200`) is necessary but
not sufficient: PX serves a **boundary-length 200** whose top-doc `innerText` (`render.text`) sits over
the 200-char bar (ordinary page chrome around the iframe), so `isPerimeterXChallenge` reads it as "not
thin" and `isVisiblyBlocked` misses it because the challenge phrase is in the iframe/source, not the
innerText. (`render.text` is `document.body.innerText` of the **top document only** — `patchright-core.ts`
— so iframe text never reaches it.)

The complete signal is the challenge **copy in the page source**: `hasPerimeterXChallengeCopy(html)`
matches `PX_BLOCK_PHRASES` against `render.html` (decoding `&amp;` first — "Press & Hold" serializes as
"Press &amp; Hold" in outerHTML, which defeats a literal `/press\s*&\s*hold/` match). A PX challenge is
now `pxHint && (thin render.text **OR** challenge copy in source)`. The copy is **absent on a cleared
page** (its HTML keeps only the persistent `px-captcha` modal id), so it can't false-positive a success;
`pxHint` gates it so an incidental "press and hold" on a non-PX page can't either. `pxCopy` is added to
`BlockSignal`; retrieve computes it from the render HTML and feeds it to `classifyBlock`. (Drive's
snapshot carries no HTML, so it leaves `pxCopy` unset and still relies on `pxHint`+thin + escalation — a
known narrower gap for a fat-iframe 200 on the drive path.)

**Lesson reinforced:** the detector reads `render.text` (top-doc innerText) while the extractor reads
`render.html` — any challenge that renders in an iframe lands in the second surface but not the first, so
detection that keys only on innerText (length or phrase) will miss iframe-served challenges. Key on the
source/returned-content for iframe vendors.

### Second follow-up: `render.html` is *also* top-frame only — capture child frames (PR #25 P1 review)

A reviewer caught that `render.html` comes from `page.content()`, which serializes only the **top
document** — a child frame's document (the actual `px-captcha-modal`) is never included. So
`hasPerimeterXChallengeCopy(render.html)` only catches PX served as a **top-document interstitial**
(the form the live probe happened to hit — `extractMarkdown` got the copy *because* it was in the top
doc). A challenge whose copy stays **inside the iframe** over a fat top page would still be a false
negative.

Fix: the core now captures child-frame HTML. `snapshot()` walks `page.frames()` and concatenates each
child's `content()` into a new `frameHtml` field — but **only when the top doc carries a PX marker**
(`hasPerimeterXHint`), so an ordinary page with ad iframes never pays the walk. Detection
(`hasPxChallengeCopy`) reads `render.html` **and** `render.frameHtml`. Verified empirically that
Playwright reads a **cross-origin** frame's `content()` (it operates per-frame over CDP, not via
same-origin-restricted in-page JS) — proven by `scripts/validate-frame-capture.mjs` (real browser, a
cross-origin data: child frame). **Lesson:** `page.content()` is top-frame only; for any vendor that
renders in an iframe, you must walk `page.frames()` explicitly — both `render.text` (innerText) and
`render.html` (page.content) stop at the top document.
