---
title: retrieve() burns the full clearance timeout on legitimately short pages
date: 2026-06-05
category: runtime-errors
module: browser core (render clearance loop) / detect
problem_type: runtime_error
component: service_object
root_cause: logic_error
resolution_type: code_fix
severity: medium
symptoms:
  - "retrieve() takes ~20s on a tiny static page (example.com, ~120 chars body) that loads instantly with no anti-bot challenge, then returns correct content"
  - "retrieve() is fast (~1s) on content-rich pages (news.ycombinator.com ≈1.2s) but pathologically slow only on pages with <200 chars of body text"
  - "navigate() (drive) returns the same page in a few seconds while retrieve() times out — a drive↔retrieve parity asymmetry"
  - "Latency clusters at a fixed ~clearanceTimeout (≈20s), not proportional to page size"
tags: [retrieve, clearance-loop, patchright, detect, isCleared, drive-retrieve-parity, latency, cloudflare]
---

# retrieve() burns the full clearance timeout on legitimately short pages

## Status

Diagnosed 2026-06-05 while verifying `retrieve` end-to-end during the U7a HTTP-transport
cutover. **Fix is planned, not yet applied** (see *Plan: 2026-06-05 retrieve short-page
clearance fix*). This entry captures the diagnosis and the non-obvious design constraint so the
fix lands correctly.

## Symptom

`retrieve(url)` is slow — ~20s — on small pages, even when the page is a plain `200` with no
anti-bot challenge. Content comes back *correct*, just after a long dead wait. Rich pages are
fast. Measured: `example.com` (~120 chars body) ≈ 21s; `news.ycombinator.com` ≈ 1.2s.
`navigate()` (the drive verb) fetched the same pages in a few seconds — so this is also a
drive↔retrieve parity gap.

## Root cause

`render()` in `src/browser/patchright-core.ts` polls until the page "clears" or the clearance
timeout elapses:

```js
while (!isCleared(signal, opts.clearedTextLength) && waited < clearanceTimeoutMs) { … poll 1s … }
```

`isCleared()` (`src/browser/detect.ts`) only short-circuits when there is **enough text**:

```js
return matchedBlockPhrases(signal).length === 0 && signal.text.trim().length > minTextLength;
```

`retrieve` passes `minTextLength = MIN_CONTENT_LENGTH = 200` (`src/verbs/retrieve.ts`). A
legitimately short real page never exceeds 200 chars, so `isCleared` stays false and the loop
runs the **full `clearanceTimeoutMs` (~20s)** before giving up and snapshotting. The wait is
pure dead time; nothing is wrong with the page.

The loop conflates two different questions:

- "Is the challenge gone and real content present?" — the high text bar; correct for the kill-gate.
- "Are we done waiting?" — should fire as soon as a no-challenge page has settled, regardless of length.

## The non-obvious constraint (why the naive fix is wrong)

The obvious fix — stop polling as soon as no visible block phrase is present (which is exactly
what `navigate()` does, and why navigate is fast) — **reintroduces a real flake**. The text bar
is deliberate: it guards the Cloudflare window where the challenge *phrase* has disappeared but
the real content has **not yet painted**. In that window text is thin and no phrase shows, so
"no phrase" alone would mistake a mid-reload challenge for "cleared" and snapshot a
blank/interstitial page.

The fix must distinguish:

- **tiny real page** (no challenge ever present) → clear immediately
- **challenge mid-reload** (phrase gone, content not painted yet) → keep waiting

Candidate approaches (see the plan): content-stability across consecutive polls (preferred —
naturally captures "content has painted" without HTML hints), or load-state + absence of a CF
HTML hint (`hasCloudflareHint`). The latter risks the false-positive `detect.ts` deliberately
avoids: CF vendor scripts persist in the HTML even *after* a challenge clears, so keying "keep
waiting" off them could stall a page that has actually cleared.

## Parity (load-bearing)

`render()` (retrieve) and `navigate()` (drive) run **separate** clearance loops. They must make
the same clear/wait decision on the same signal sequence — drive↔retrieve parity is load-bearing
in this codebase. The fix should unify or mirror the two loops and ship with a parity test.

## Scope / impact

Pre-existing; `render()`/`isCleared` are transport-agnostic, so stdio and HTTP are equally
affected — this is **not** a transport regression. Real-world impact is limited to genuinely tiny
pages; rich content is already fast. Still worth fixing — `retrieve` is the headline verb.

## Related

- `residential-proxy-rotating-exit-retry` — the other retrieve-path escalation learning.
- `interactive-drive-verbs-over-policy-guard` — the drive surface whose clearance loop is the parity reference.
