---
title: A fresh exit cannot clear a 404, a 429, or an interactive CAPTCHA — stop re-rolling, and keep the root class
date: 2026-08-28
category: docs/solutions/architecture-patterns
module: browser/detect, verbs/retrieve, verbs/escalation, verbs/drive, observability/failure-diagnostics
problem_type: architecture_pattern
component: proxy-escalation
severity: high
applies_when:
  - "A retry ladder exists to fix one specific cause and you are about to feed it a failure with a different cause"
  - "You are adding a status or class to the set that triggers exit rotation / a paid retry"
  - "A late, global outcome (a timeout, a budget, a circuit breaker) overwrites an earlier, specific verdict"
  - "You are deciding whether a newly-split failure class should outrank an existing catch-all"
---

# A fresh exit cannot clear a 404, a 429, or an interactive CAPTCHA

## The shape of the bug

The gateway rotates to a clean residential exit when a page looks blocked. That ladder exists for
exactly one cause: an **IP-reputation verdict**. A thin `403` is a statement *about the client's
address*, so asking again from a different address genuinely gets a different answer. That is the
whole premise, and it is sound.

The predicate that fired the ladder, though, was not "is this about our address". It was
`isHardBlock` — *any* `4xx`/`5xx` with a body under 200 characters. That set silently contains three
statuses that have nothing to do with our address:

| Status | What the site is saying | What a fresh exit changes |
|---|---|---|
| `404` / `410` | the resource is absent | nothing — it is absent from every address |
| `429` | *you* are going too fast | nothing, or it evades a limit we were asked to respect |

Measured on production, on a thin `404`, with no forcing and no special configuration:

```
reason=timeout  status=404  proxyUsed=true
attempts=2  attemptMs=[48019, 20391]  totalMs=90193
```

Two residential exits and the entire 90-second call budget, to be told a second and third time that
a URL does not exist. The same shape had already been observed on an interactive CAPTCHA served as
a `200`: the widget is unsolvable without a solver, and a fresh exit simply draws a fresh widget.

## The part that made it invisible

Note `reason=timeout` in that output. The root class was `hard-block` — the escalation diagnostic
still carried it — but a separate, earlier rule said that any call which exhausted its wall-clock
budget is classified `timeout`, overriding whatever the last attempt landed on.

That rule was correct when it was written and for the case it was written for. Across a multi-attempt
re-roll, the block the *final* attempt happened to hit is incidental; the budget overrun is the fact
that describes the whole call. But layered on top of the first bug it produced the worst possible
report: **the one advice that cannot work.** `timeout` reads as "transient, try again". The truth was
"this resource does not exist" — and the retry the label invites costs two more exits and another
ninety seconds.

Two independently-defensible rules composed into a system that spent real money to give wrong advice.
Neither code review nor either rule's own tests could see it, because the defect lived in the seam.

## The fix, and the one judgement call in it

Three changes, all in shared classifiers so retrieve and drive inherit them together:

1. **Name the distinct thing.** A thin `429` became its own class, `rate-limited`, rather than hiding
   inside `hard-block`. The two want *opposite* responses — one wants a new address, the other wants
   patience — so collapsing them into one label guaranteed that at least one of them got wrong advice.

2. **Gate the spend on the narrower predicate.** Escalation now asks `isExitClearableHardBlock`
   instead of `isHardBlock`. Crucially, `isHardBlock` itself was left alone: a thin `404` is *still*
   a block, still a failure, still reported. Only the question "is a paid retry worth it here" changed.
   Widening "not worth retrying" into "not a failure" would have been a much worse bug, and keeping
   the two predicates separate is what prevents it.

3. **Stop the loop, not just the entry.** The gate above only governs *entering* the ladder. A caller
   passing `forceProxy` skips it entirely, and the loop's own break condition only recognised
   *success*. So the loop got a terminal check on the same rule — which is what covers the forced path
   and the automatic path together, since they share the loop.

### Deciding what outranks the budget

The interesting decision was #3's companion: budget exhaustion no longer erases the root class.
The obvious framing — "a verdict from the site should beat a description of our own call" — is
**wrong**, and following it would have silently reversed the earlier rule for the exact case it was
defending.

The right test is narrower and operational: **if the caller acts on this label by asking again, are
they wrong?**

- `rate-limited`, `captcha`, `policy-blocked` → yes, wrong. These survive the budget.
- `hard-block`, `anti-bot-block` → **no.** These are precisely the exit-clearable classes. For them
  "we ran out of time, try again" is correct *and more actionable* than the incidental block label.
  They stay subordinate to the timeout.

So the decisive set is the mirror of the unclearable set — one idea expressed at two layers — and it
is a hand-maintained membership list, because the property is not derivable from a class's name.

The earlier rule's actual guarantee ("the caller can always see the budget was spent") was never in
conflict; it only *looked* that way because the guarantee had been implemented by overwriting the
class. Moving it to an orthogonal `budgetExhausted` boolean let both facts be true at once. **When two
rules appear to conflict, check whether one is a guarantee wearing a mechanism's clothes.**

## What the process got right, and what it nearly got wrong

**The spec was wrong and running the existing tests caught it.** The written plan listed `hard-block`
and `anti-bot-block` as decisive *and*, a few paragraphs later, asserted the existing budget tests
would stay green. Both could not hold: one of those tests drives a Cloudflare challenge, whose root is
`anti-bot-block`. Reading that test before writing new ones surfaced the contradiction; the alternative
was noticing later and being tempted to "fix" the failing test, which would have deleted the older
rule's only regression guard.

**Three fixture tests failed for a reason that was not the code.** The protection-vendor hint scanners
match against **raw HTML, comments included** — they do not run the inert-context strip the CAPTCHA
widget detector uses. Two fixtures carried a comment explaining that they deliberately had *no*
vendor marker; naming the vendors in that sentence gave them one, and both fixtures classified as that
vendor's challenge. A fixture's comments are inputs. (Recorded in `test/fixtures/README.md`.)

**The plan's suggested verification URL could not have verified anything.** It proposed
`example.com/does-not-exist-vil121` as the thin-404 probe. That page's body is ~288 characters — over
the 200-character threshold — so it is not a hard block, never escalates, and would have produced a
clean fast result *both before and after the fix*: a green that proved nothing. Checking the probe
against the threshold before trusting it is the cheap step that avoids a fabricated pass.

## The generalisable rule

**A retry ladder is an answer to a specific question. Before feeding a failure into one, ask whether
that failure is even a case of the question the ladder answers** — and gate the *spend* on that
narrower predicate, never on the broad "did it fail" predicate, which is doing a different job and
must keep doing it.

And when a global outcome overwrites a specific one, the precedence is not "specific wins" or "global
wins". It is: **which label leads the caller to the right next action?**

## Three more the review loop found, all in the same seam

The fix above was green on every gate before adversarial review. Review then found four real defects,
and three of them share a single shape: **a rule applied at one point in a system that has more than one
such point.**

1. **The entry gate is not the loop.** Narrowing the escalation predicate only governs *entering* the
   ladder. A caller that forces the proxy skips the gate entirely, and the loop's own break condition
   recognised only success — so the fix worked on the automatic path and did nothing on the forced one.
2. **There was a second loop.** The drive controller has its own open-and-navigate retry loop with the
   same burn. The change's own comment claimed drive/retrieve parity while only one of the two had the
   loop half. A comment asserting a property is not the property.
3. **There was a third loop.** The vault login runner has a third copy, still unfixed and now ticketed.

The instruction that would have caught all three is the one this repo already wrote down for deploy
gates: **count the copies before trusting one.** It generalises past gates to any rule that must hold at
several points. Before shipping a predicate change, grep for every caller of the predicate you narrowed
*and* every loop that re-tries the thing it governs — those are different sets, and the second is the one
that gets missed.

The fourth finding was different and worth its own note: the terminal break read a status off a **dead
exit**, which can carry a status inherited from a prior document. The classifier layer already defended
against exactly that (it gives a `chrome-error://` landing precedence over the status), so the defence
existed — it just was not applied at the new site. **When you add a consumer of a signal, look for who
already distrusts that signal and why.**

## A note on reviewing the reviewer

Two suggestions from review were rejected, and both rejections were load-bearing:

- Keying the terminal break on the block **reason** instead of the status reads cleaner and is wrong.
  Vendor markers persist after a challenge clears, so an ordinary thin 404 from any Cloudflare-fronted
  origin classifies as a vendor challenge; reason-gating would have re-rolled every exit on the most
  common shape the change exists to stop. There is now a test pinning it.
- Extending the live-challenge exemption to the behavioral vendors would have bought more retries at the
  two vendors this codebase had already concluded do not benefit from a fresh exit.

Both suggestions were locally reasonable and globally wrong, which is the normal case for review on a
system with accumulated context. The defence is to check a suggestion against the *invariant it would
change*, not against the line it points at.
