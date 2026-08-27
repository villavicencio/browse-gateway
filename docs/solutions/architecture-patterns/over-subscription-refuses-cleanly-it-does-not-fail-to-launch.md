---
title: Over-subscription refuses cleanly — so a reported launch failure is not a capacity story
date: 2026-08-05
revised: 2026-08-27
category: docs/solutions/architecture-patterns
module: gateway/session-manager, gateway/index, gateway/config, scripts/measure-pool-under-load
problem_type: architecture_pattern
component: session-pool
severity: medium
applies_when:
  - "A consumer reports clustered failures and attributes them to pool exhaustion"
  - "You are about to change the launch deadline, the pool size, or the admission logic"
  - "You need to know what the gateway actually says when a fleet over-subscribes it"
  - "You are setting maxSessions and want to know whether the host can honour it"
---

## Problem

A consumer project ran a fleet of concurrent research agents against the gateway and reported
clustered `browser core failed to launch` errors, hitting several agents at once and recovering
without intervention. They attributed it to session-pool exhaustion.

Nobody had ever measured the gateway under that load. Both the report's diagnosis and the first
two attempts to refute it were reasoning from source reading, and **both were wrong**.

## What was measured

`scripts/measure-pool-under-load.mjs` issues a simultaneous burst at configurable over-subscription
through three separately labelled admission paths, in-container, against a local fixture:

- **R** — `retrieve` fan-out over the real MCP path. Per-consumer *uncapped*: `withSession` calls
  `acquire()` with no meta (`src/gateway/index.ts:75`), so only the global ceiling applies.
- **D** — `browser_open` fan-out over the real MCP path. Per-consumer *capped*
  (`src/gateway/index.ts:131`).
- **S** — direct `SessionManager.acquire` in-process. The only path where `err.code` and
  `err.cause` survive; the MCP boundary discards them (`src/mcp/drive-controller.ts:669-670`).

The instrument was proved able to see a refusal before its absences were trusted: a forced-refusal
control (`maxSessions=1`, concurrency 4) produced the literal `session limit reached (1)` on all
three paths, and a deliberate blindness mode that swallows captured errors emptied the histogram,
lost the control, and exited non-zero.

## The result

**72 calls at 8× over-subscription against a 2-slot pool:**

| Outcome | Count | Median latency |
|---|---|---|
| `[R]` global refusal — `session limit reached (2)` | 18 | 96.6 ms |
| `[S]` global refusal — `code=SESSION_LIMIT` | 18 | 0.21 ms |
| `[D]` global refusal | 15 | 56.7 ms |
| `[D]` per-consumer refusal — `per-consumer session limit reached (1)` | 3 | 20.9 ms |
| admitted | 18 | — |
| **`browser core failed to launch`** | **0** | — |
| **`browser core launch exceeded …ms deadline`** | **0** | — |

The ceiling held: live sessions never exceeded `maxSessions` across 3295 operator-health samples.
Launch latency, launch-only, was 4.09–4.48 s (n=6).

**Over-subscription produces fast, clean, actionable refusals. It does not produce launch failures.**

## The two corrections this forced

### 1. `CORE_LAUNCH` conflates TWO causes, not three — and the deadline was never one of them

The claim that all three raise sites emit identical text is **false**. Two do:

- `session-manager.ts:401` — the factory threw synchronously
- `session-manager.ts:420` — the launch promise rejected (Chromium exited)

Both emit `browser core failed to launch`. But the deadline branch has always had its own message:

- `session-manager.ts:459-462` — `` `browser core launch exceeded ${this.#launchDeadlineMs}ms deadline` ``

**This matters because of what the consumer quoted.** They reported `browser core failed to launch`
— which is *not* the deadline string. Whatever hit them, it was not a launch that ran long and got
cut off. It was a launch that genuinely failed: Chromium did not start, or it started and exited.

The "120-second deadline expiring under contention" theory is refuted by the consumer's own paste.

### 2. The capacity story does not explain the report, in either direction

The consumer said pool exhaustion. The pool refuses in 0.2 ms in-process and under 100 ms through
MCP, with a message that names the limit. They never quoted that message, and this measurement
shows it is what over-subscription produces.

So the open question is not "does the pool refuse badly" — it refuses well. It is **what makes
Chromium fail to start under a real concurrent workload**, which is a resource question (memory,
`/dev/shm`, PIDs, FDs) that this measurement deliberately cannot reach.

## Validity limit — stated because a null result is easy to over-read

The fixture path excludes proxy-connect and remote-target render cost, both of which sit inside the
production launch and first-navigation window. A null result here bounds the claim to **"not
reproducible without proxy and remote cost"**, not "does not occur". Real sessions doing real work
hold far more memory and far more file descriptors than a loopback fixture fetch, and that is
precisely the regime a resource-exhaustion hypothesis lives in.

One further gap, named rather than glossed: the forced-refusal control proves the harness can see a
**capacity refusal**. It does not prove it can see a **launch failure** — manufacturing one on
demand requires replacing the real launch path, which would stop it being the real path. That
branch was exercised out-of-band with an injected failing factory and behaved correctly, but that
evidence sits beside the run, not inside it.

## What to do with this

- **Do not resize the pool or shorten the launch deadline on the strength of the field report.**
  Neither is implicated. The deadline never fired, and its message is already distinct.
- **Do not tell a consumer to reduce concurrency in order to avoid launch failures.** Reducing
  concurrency reduces *refusals*, which are cheap and correct. It is unrelated to the failure they
  actually hit.
- **`retrieve` is genuinely not per-consumer capped** — measured, not inferred. One consumer can
  occupy the entire global pool with concurrent retrieves. That is a real property worth deciding
  about deliberately; the pool-sizing comment already says the spare slot is deadlock prevention
  and explicitly *not* headroom for concurrent retrieves (`src/gateway/config.ts:104-105`).
- **The next question is resource pressure under real workloads**, not admission control.

## UPDATE 2026-08-27 — the open question now has a measured answer

This doc closed on: *"the next question is **what makes Chromium fail to start under a real
concurrent workload** — a resource question (memory, `/dev/shm`, PIDs, FDs) that this measurement
deliberately cannot reach."* A per-session memory measurement has now reached it. See
[measuring-browser-session-memory-needs-pss-not-docker-stats-or-rss](../best-practices/measuring-browser-session-memory-needs-pss-not-docker-stats-or-rss.md).

**Measured on prod, 2026-08-27:** an idle floor of ~361 MB and **~651 MB PSS per browser session**
against the container's 4096 MiB cap → `(4096 − 361) / 651 = 5.7`, i.e. **about 5 concurrent
sessions**. Production's configured `maxSessions` is **7**.

### The consequence, stated plainly

**The admission ceiling is set above the resource ceiling.** Everything this doc established about
admission control still holds — it refuses cleanly, quickly, and with a message that names the
limit. But it refuses at *7*, and the box holds about *5*. Sessions 6 and 7 are therefore **admitted
by a correctly-functioning admission layer and then run into a memory wall**, which surfaces as a
launch failure rather than as the clean `session limit reached (7)` refusal this doc documents.

That is exactly the regime the original measurement excluded by construction: a 2-slot pool on a
loopback fixture path with no proxy-connect and no remote render cost. The "validity limit" section
above bounded the null result to *"not reproducible without proxy and remote cost"* — and the reason
is now concrete rather than hypothetical. It is not that admission control is wrong. It is that
**nothing in the tree derives a ceiling from host memory**: the only cap validation is the pool
*floor* (`consumerCount × perConsumerMax + 1`), so `maxSessions` can be set to any number and the
boot check will happily accept it.

### What this does and does not establish

- **Does:** a real, measured mechanism by which a correct admission layer over-admits into launch
  failure, and the reason the earlier fixture run could not see it.
- **Does not:** that this caused the specific field report. That incident's `browser core failed to
  launch` remains unattributed; this is a mechanism with the right shape, not a confirmed diagnosis.
  Peak observed concurrency in 44 h of prod logs was **1 session**, so on *this* deployment the wall
  is not currently being reached.

### Revised guidance

- The bullet below — *"do not resize the pool on the strength of the field report"* — **still
  stands**, and now for a second, stronger reason: 7 is already above what the host can hold, so
  resizing *up* is the wrong direction and resizing *down* toward ~5 is a correctness argument, not
  a capacity one. Tracked as **VIL-131** (Medium: single-operator box, peak concurrency 1).
- **Treat `maxSessions` as a claim about the host, not a preference.** Before changing it, measure
  PSS per session on the target box; do not infer it from `docker stats` or summed RSS, both of
  which are wrong here and in opposite directions.
- **A clean refusal is the good outcome.** If a fleet is hitting launch failures rather than
  `session limit reached (N)`, suspect that `N` is set above the resource ceiling before suspecting
  the admission logic.

---

## The general lesson

Three successive diagnoses of this incident — the consumer's, and two of mine — were each
confidently derived from reading code, and each was wrong in a different way. The measurement took
one afternoon and refuted all three. When an incident report and a source reading disagree, the
cheapest correct move is to reproduce the load, not to arbitrate between two arguments.
