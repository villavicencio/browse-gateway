---
title: The extraction loss is real, but not where the epic guessed — and link density cannot find it
date: 2026-08-07
category: docs/solutions/architecture-patterns
module: verbs/extract, verbs/retrieve, scripts/probe-extraction-loss
problem_type: architecture_pattern
component: extraction
severity: medium
applies_when:
  - "You are about to build a detector for silent extraction loss"
  - "You are tempted to use link density to tell page data from page chrome"
  - "You are writing a probe that compares extracted markdown against source DOM text"
---

## Problem

Epic #114 rested on a field report: `retrieve` returns HTTP 200, `degraded: false` and clean markdown
with the caller's structured data missing. Nothing in the repo reproduced that against the input
`retrieve` actually uses — `render.html`, the post-render serialized DOM — so a consent wall, a
JS-gated section or geo variance would have produced the same consumer-visible symptom with the loss
upstream of extraction entirely. #117 existed to falsify the premise before #116 built a detector for
a bug we might not have.

## Method

`scripts/probe-extraction-loss.local.mjs` (gitignored — it names the sites it probes) captures the
real input via `core.render(url)` — the production path — then runs the real pure `extractMarkdown`
over it and measures which structured-block cell text survives. Six pages: four of the suspect shape
(a label-value block adjacent to prose) and two deliberate controls.

## The instrument was wrong first, and it took two rounds to make it honest

**Round 1 reported loss on five of six pages, including both controls.** A detector that fires on
everything discriminates nothing. The cause: `markdown.includes(cellText)`. Turndown rewrites
`<a>text</a>` as `[text](url "title")`, so any DOM cell whose text runs *through* an inline link never
appears contiguously in the output. Content sitting plainly in the markdown was reported as lost:

```
DOM cell:  "A prose poem – is a composition in prose that has some of the qualities of a poem."
markdown:  "-   A prose poem – is a composition in prose that has some of the qualities..."
verdict:   LOST     ← wrong
```

**Round 2's self-check was circular and passed while broken.** It lifted its present-by-construction
phrases out of `markdownToProse`'s own output, so a broken normaliser validated itself. Ground truth
has to come from the **source DOM**, never from the normalisation under test.

**Round 3: the break has to compose.** Substring-vs-token and unwrapped-vs-raw are each individually
survivable — token matching tolerates link syntax because anchor text survives as tokens, and
substring matching works fine once links *are* unwrapped. Only both together reproduce the original
defect. A single-axis mutation would have left the check green and useless.

The self-check is now watched failing in both directions before any reading is trusted
(`PROBE_SELFTEST=auto`): present-by-construction prose must read as survived, absent-by-construction
nonsense must read as lost.

## Finding 1 — the premise HOLDS, on one page in six

A bibliographic-record page reproduced the exact failure shape. Its label-value table — 35 cells,
author / title / language / subject / release date / downloads — was **absent from the output**, while
the call returned `status: 200` and `degraded: false`. The caller received 677 characters: a plot
summary and two e-reader navigation fragments.

**Token retention: 0.377.** Under 40% of the browser's own visible-text tokens reached the caller,
and nothing in the result said so. `degraded: false` actively reassures — which is #114's argument
about the flag's name, now with a captured page behind it.

## Finding 2 — and it is the one that changes the design — the epic guessed the wrong page shape

**Both encyclopaedia infoboxes SURVIVED**, at token retention 0.987 and 0.993. So did a
table-dominant reference page at 0.829. The archetypal "attribute table adjacent to a prose body" —
the shape #114's *Why* names and the shape #117 asked for three variants of — is **not** where the
loss happens.

The page that lost its data is the one where the **prose body is short relative to the table**.
Readability found a small article (a summary blurb), scored it as the content, and discarded a data
table several times its size. A detector tuned on infobox pages would have been tuned on pages that
work.

## Finding 3 — link density cannot separate data from chrome

The intuition is that a nav rail is mostly links and a data table mostly is not. Measured, the three
values interleave:

| Block | Link density | Correct action |
|---|---|---|
| Encyclopaedia maintenance notice (translation banner) | **0.148** | drop — chrome |
| **Bibliographic data table** | **0.314** | **KEEP — this is the bug** |
| Encyclopaedia sidebar navbox | **0.455** | drop — chrome |

**The data block sits between two chrome blocks.** No threshold on this axis separates them. Link
density is reported by the probe but must not be used as a discriminator — it was removed from the
probe's own verdict filter for exactly this reason.

Every other absent block across all six pages sat at link density ≈ 1.0 — language menus, footers,
"what links here", documentation nav rails. Those are correct chrome removal, and a naive detector
would have flagged all of them.

## Resolution

- **#114's premise is not refuted; outcome 1 does not apply.** The loss is real, reproduced against
  captured `render.html` with the production extractor.
- **#116 must not be scoped against infobox pages.** The discriminating shape is
  *short-prose-body + large-data-table*, not *table adjacent to prose*.
- **#117's fixture plan needs revising.** Its three named positive variants are all the shape that
  was measured to survive. Positives must be selected on the prose-to-data ratio instead.
- **Token retention is the strongest candidate signal on this sample**: 0.377 on the loss page
  against 0.828–0.993 on the five others. One reproduction is not a threshold — #120 owns that
  decision and needs more captures first.
- **Link density is refuted as a discriminator** and should not appear in #116's criteria.

## Gotchas

- **Never compare extracted markdown to DOM text by substring.** Turndown's link syntax guarantees
  false losses. Compare on tokens, and unwrap `[text](url)` first.
- **A self-check that derives its ground truth from the code under test proves nothing.** Round 2's
  passed while the normaliser was broken.
- **A mutation that a single axis can survive is not a mutation.** Compose the break until the check
  actually goes red, then keep that construction.
- **Raw markdown length is not a retention measure.** Markdown carries link URLs, so it can exceed
  the visible text it came from — round 1 reported ratios above 1.0 and they meant nothing. Measure
  retention on tokens.
- **`degraded` is a no-article flag, and on the reproducing page it was `false`.** Reading it as
  "extraction was faithful" is exactly the mistake #114 exists to stop.
- Sample size is six pages on friendly hosts, chosen for shape. It answers the falsification
  question and it is nowhere near a threshold.
