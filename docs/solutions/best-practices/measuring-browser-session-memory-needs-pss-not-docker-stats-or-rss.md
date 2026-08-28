---
title: "Three instruments, three answers — only PSS measures a browser session's real memory cost"
date: 2026-08-27
category: docs/solutions/best-practices
module: gateway/config, gateway/session-manager, scripts/deploy/launch-http.sh
problem_type: best_practice
component: session-pool
severity: high
root_cause: incorrect_assumption
resolution_type: workflow_improvement
applies_when:
  - "You are sizing the session-pool cap and need the real memory cost of one headful browser session"
  - "You are about to quote a number from `docker stats` — neither its CPU% nor its MemUsage measures what the name implies"
  - "You are summing RSS across a process tree whose processes fork from a shared zygote"
  - "A capacity, load, or liveness conclusion rests on one instrument with no independent cross-check"
  - "You are about to report live traffic or an observed teardown that only a sampled counter showed you"
related_components:
  - session-lifecycle
  - deployment
  - observability
tags:
  - pss
  - smaps-rollup
  - docker-stats
  - cgroups-v2
  - memory-measurement
  - pool-sizing
  - chrome-zygote
  - measure-not-reason
---

# Three instruments, three answers — only PSS measures a browser session's real memory cost

## Context

The gateway runs headful Chrome under Xvfb inside a resource-capped Docker container. The container
caps are set by the deploy launcher at `scripts/deploy/launch-http.sh:86-95`:

```bash
--cpus="${BGW_CPUS:-1.75}" --memory="${BGW_MEMORY:-4g}" --memory-swap="${BGW_MEMORY:-4g}" \
--pids-limit="${BGW_PIDS_LIMIT:-512}" --shm-size="${BGW_SHM_SIZE:-1g}"
```

On 2026-08-27 the question was how many concurrent browser sessions that box can actually hold —
i.e. whether the configured session-pool cap `BGW_MAX_SESSIONS` is a number the hardware can honour.
The operator host is 2 vCPU / 7747 MB; the deployment sets the cap to 7 (the committed default in
`src/gateway/config.ts:82` is `maxSessions: 2`).

This matters because the only cap validation in the tree is a **floor**, not a ceiling.
`poolSizingError` at `src/gateway/config.ts:107-120` computes
`consumerCount * perConsumerMax + 1` and rejects a cap below it; `src/mcp/runtime.ts:174-176` throws
on that error at boot, so a too-*small* cap fails closed and never reaches production. A grep of
`src/` for `totalmem`, `freemem`, `memory.max`, `memory.current`, or `MemAvailable` returns nothing —
nothing anywhere in the runtime derives an upper bound from host or cgroup memory. A cap that is too
*large* boots fine and only reveals itself as an OOM under concurrency. Sizing the ceiling is
therefore a measurement job, and the measurement has to be right.

Three instruments were used to answer it. They disagreed by up to 2.4x, two of them were wrong, and
two wrong conclusions were stated out loud and retracted before the correct instrument was found.
This document is the guidance that would have prevented that.

## Guidance

### Use PSS from `/proc/<pid>/smaps_rollup` for per-session memory

PSS (Proportional Set Size) divides each shared page among the processes mapping it, so a summed PSS
across a process tree counts every physical page exactly once. Chrome forks renderers from a zygote
and shares most binary and library pages between them, which is precisely the case RSS cannot
represent.

Under rootless Docker the container's Chrome PIDs are **host-visible**, so no `docker exec` is
needed — read the host `/proc` directly:

```bash
pids=$(docker top <container> aux | awk '/opt\/google\/chrome/{print $2}')
for p in $pids; do
  awk '/^Pss:/{s+=$2} END{print s+0}' /proc/$p/smaps_rollup
done | awk '{t+=$1} END{printf "%.0f MiB PSS across %d procs\n", t/1024, NR}'
```

Measure the **idle floor** the same way before any session exists (the long-lived node process and
Xvfb), then the **delta** with exactly one session open. The per-session cost is the delta, not the
total.

Unit hazard: `smaps_rollup` reports KiB. Decide the divisor deliberately (`/1024` for MiB) and keep
the cap in the same unit family — `--memory 4g` is 4096 MiB, not 4096 MB. **This doc mislabelled its
own output `MB` for a day** — the awk divided KiB by 1024, which is MiB, and printed `MB` — and the
slip propagated into two other documents before review caught it. The arithmetic was never wrong;
the labels were. Print the unit you actually computed. On the numbers below the
choice moves the answer from 5.7 to 6.0 sessions; it did not change the conclusion, but on a tighter
budget it would.

### Get CPU ground truth from cumulative time, not an instantaneous rate

`docker top <container> aux` prints each process's accumulated CPU time. Divide it by process
lifetime for a real average; read the per-process `TIME` column during a load to see where CPU
actually goes. This is a cumulative counter, so it cannot be distorted by sampling artifacts the way
a two-sample rate can.

```bash
docker top <container> aux                 # TIME column = cumulative CPU per process
docker top <container> -eo pid,etime,time,comm   # lifetime alongside CPU time
```

### Never size anything from `docker stats --no-stream`

It is wrong on both axes for this workload:

- **CPU%** is derived from two near-adjacent samples, so it reports whatever transient the sampling
  window happened to catch. It produced triple-digit percentages on a container with zero Chrome
  processes.
- **MemUsage** under cgroups v2 includes page cache attributed to the cgroup. For a browser
  container the cache is large and volatile enough to *dominate* the process working set, which
  means the number can move in the opposite direction from the load.

`docker stats` is fine for "is this container near its cgroup memory limit" — that is the question
cgroup accounting is actually answering. It is not a per-process or per-session instrument.

### Never sum RSS across a Chrome process tree

`ps`/`docker top` RSS counts every shared page once **per process**. With 14 Chrome processes sharing
a zygote's mapped binary and libraries, the sum over-counts by roughly 2.4x. RSS is only meaningful
for a single process with no significant sharing.

### Validate by differencing and repetition — not by a second summary number

PSS is correct **by construction**: it is defined so that each physical page is counted once across
the processes mapping it. That is a property of the metric, not an empirical finding, and it is the
reason to pick PSS rather than evidence that a given PSS reading is right.

The empirical validation is a **difference that reproduces**:

1. Measure the idle floor with no session open.
2. Open exactly one session, measure again. The per-session cost is the **delta**, never the total.
3. Open a second session and confirm the delta repeats within a few percent.

A delta that reproduces across independent sessions is a measurement. A single absolute total is not,
however precise it looks.

**Do not use `docker stats` MemUsage as the cross-check.** It measures a different quantity —
working set plus page cache for the whole cgroup — so agreement with a PSS process total carries no
information, and disagreement carries none either. Comparing them is not two instruments agreeing;
it is one instrument and one number that answers a different question.

This document originally got that wrong, which is worth stating because it is the same error one
level up. The first version of this guidance compared a floor-plus-one-session PSS total against a
cgroup reading captured **at idle, with no session running**, restated that reading inconsistently
(1.068 GiB appearing variously as "1068 MiB" and "1.08 GiB", ~40 MiB apart), and called the result
agreement. Taken at the same moment the cgroup number was *905 MiB* — below the PSS total, which
cache accounting cannot explain. The ritual looked like validation and validated nothing.

### Adjacent trap: two surfaces, one word "session"

While diagnosing capacity, two surfaces both say "session" and mean different things:

- `src/mcp/http-server.ts:283` logs
  `session ${sid} open (consumer=${consumer.id}); ${sessions.size} live`, where `sessions` is the
  MCP **transport** map declared at `src/mcp/http-server.ts:228` — one entry per client transport
  connection, created when a client initializes its transport.
- The operator status surface renders `N/M sessions` at `src/cli/status.ts:192-204`, derived from the
  pool's `activeCount + reservedCount` over `maxSessions` — **browser** sessions.

At one sampled moment the logs read `20 live` while the pool surface read `0/7 sessions`. Both were
correct. Anyone diagnosing browser capacity from the log line is reading the wrong counter, and
nothing in either surface says so. When reasoning about pool capacity, take the number from the pool
health surface, never from the transport log.

### Still open — do not treat as settled

Two successful `retrieve` calls were driven through the gateway while `docker top` was sampled
continuously (48s at 2s intervals, then 82s at 1.5s). Both returned real page content. In neither
window did the container exceed 4 processes or move off ~310 MiB — **no Chrome process ever appeared
in any of the ~79 samples.**

This contradicts what the source describes. `src/verbs/retrieve.ts:892`, `:958` and `:1007` each call
`gateway.withConsumerSession(...)`, and the doc comment at `src/verbs/retrieve.ts:42-50` states that
each retry re-acquires a fresh session and therefore a fresh exit. A browser was expected.

Candidate explanations, **none verified**: a response path that avoids the browser for unprotected
pages; a browser lifetime that falls entirely between polls (unlikely to hide across ~79 samples);
or `docker top` failing to observe part of the process tree. A future reader sampling this container
should be aware that process-table sampling did not see the browsers it expected, and should not
assume `docker top` gives a complete view of the tree until that is settled.

## Why This Matters

**Wrong instruments produce confident wrong conclusions, not obviously-broken ones.** Two were stated
during this investigation and both had to be retracted:

1. From the CPU spikes: *"another consumer is actively using the gateway right now, and I just
   watched a session tear down."* False. The container was idle; the spikes were a sampling artifact
   of `--no-stream`.
2. From the same spikes plus reasoning: *"CPU is the binding constraint; the ceiling is ~2-3
   concurrent sessions."* False. One session including a heavy page load consumed roughly **7 CPU
   seconds total** — 20 processes at `0:00`, two at `0:01`, one at `0:05`. CPU is a brief per-page-load
   burst, not a sustained draw. **Memory binds.**

Note that conclusion 2 was on the *right axis for the wrong reason* only by accident: if it had been
believed, the cap would have been cut from 7 to 3 on the basis of an instrument artifact — degrading
real concurrency to fix a problem that did not exist. And the opposite error is worse: summed RSS
(1556 MiB/session) would have implied only ~2 sessions fit, while `docker stats` at idle (1.068 GiB)
would have implied roughly 3 — from a reading taken with **no session running at all**, so it was never
a per-session number in the first place. Three instruments, three different capacity answers, one of
them correct.

This is the project's standing **"Measure; do not reason"** rule (`CLAUDE.md`, Gates and measurement)
applied one level deeper than usual. Measuring instead of reasoning is necessary but not sufficient —
*this* failure came from measuring with an instrument nobody had validated. The measurement was
performed; it was just performed with a ruler that reads in the wrong units.

It is also the same shape as the project's guard rule: *"a guard, probe or control must be able to
report bad news, and you must have watched it do so"*
(`docs/solutions/best-practices/a-test-whose-stub-guarantees-the-assertion-proves-nothing.md`). An
instrument you have not watched respond correctly to a known change is not an instrument yet. There
was a free version of that check available here and it was skipped: `docker stats` reported **905 MiB
with a session live and 1.068 GiB (~1094 MiB) at idle** — lower under more load. Watching the needle move the
wrong way when the load went up should have disqualified the instrument on the spot, before any
conclusion was built on it.

The correct number and its consequence: with an idle floor of ~361 MiB and ~651 MiB per session against
a 4096 MiB cap, `(4096 - 361) / 651 = 5.7` — about **5 concurrent sessions** against a configured cap
of **7**. The cap is above what the box holds. Because `poolSizingError`
(`src/gateway/config.ts:107-120`) only enforces the lower bound, nothing at boot will ever say so;
the failure mode is an OOM kill under concurrency, not a refusal to start.

## When to Apply

Apply this whenever you are:

- Sizing `BGW_MAX_SESSIONS`, `BGW_PER_CONSUMER_MAX`, or any cap whose upper bound is host memory
  rather than the consumer-count floor the boot check already enforces.
- Deciding whether to onboard another consumer, since every consumer raises the floor
  (`consumerCount * perConsumerMax + 1`) against a ceiling nothing computes.
- Measuring memory or CPU for **any** multi-process tree that shares pages — Chrome, a forking
  server, anything with a zygote. The RSS over-count is a property of sharing, not of Chrome.
- Reading a container's resource use through Docker's own summary tooling for anything more precise
  than "near the cgroup limit."
- About to state a capacity, load, or "someone is using it right now" conclusion drawn from a single
  instrument's reading.

Do **not** reach for this when the question is genuinely "is this container about to hit its cgroup
memory limit" — `docker stats` answers that correctly, because the cgroup limit and cgroup accounting
are the same concept.

## Examples

### Before — three instruments, three answers, same container

**Instrument 1: `docker stats --no-stream`.** Wrong on both axes.

```bash
$ docker stats --no-stream <container>      # container has ZERO Chrome processes
CPU %      MEM USAGE
154.94%    1.068GiB
168.25%    1.068GiB
147.16%    1.068GiB
156.55%    1.068GiB
```

Ground truth for the same moment, from `docker top`: the node process's cumulative CPU was `4:51`
over ~42 hours of uptime — about **0.2% average**, not 155%. Its true process RSS was ~310 MiB, not
1.068 GiB; the rest was page cache attributed to the cgroup. The pool surface read `0/7 sessions`
throughout. A later sample with a session **live** read `905 MiB` — *lower* than the `1.068 GiB` idle
reading, because cache movement dominates the process working set.

**Instrument 2: summed RSS from `docker top <container> aux`.** Over-counts ~2.4x.

```bash
$ docker top <container> aux | awk '/opt\/google\/chrome/{s+=$6; n++} END{printf "%.0f MiB across %d procs\n", s/1024, n}'
1556 MiB across 14 procs
# n, not NR: NR counts every row docker top prints — the header, node, Xvfb — while only the
# chrome rows are summed. NR would pair a correct MiB total with an inflated process count.
```

Every page shared from the zygote is counted once per process.

**Instrument 3: PSS from `/proc/<pid>/smaps_rollup`.** Correct.

```bash
$ pids=$(docker top <container> aux | awk '/opt\/google\/chrome/{print $2}')
$ for p in $pids; do awk '/^Pss:/{s+=$2} END{print s+0}' /proc/$p/smaps_rollup; done \
    | awk '{t+=$1} END{printf "%.0f MiB PSS across %d procs\n", t/1024, NR}'
651 MiB PSS across 14 procs
```

Same single session. 14 processes at rest, 23 during a page load.

| Instrument | One session | Implied concurrency at 4 GiB | Correct? |
|---|---|---|---|
| `docker stats --no-stream` | 1.068 GiB *(idle, no session at all)* | ~3, and unstable | No — cgroup cache, two-sample CPU |
| Summed RSS, 14 procs | 1556 MiB | ~2 | No — shared pages counted 14x |
| Summed PSS, 14 procs | 651 MiB | ~5 | **Yes** |

### After — measure, then cross-validate before believing

```bash
# 1. Idle floor, PSS, before any session exists
#    node 297 MiB + Xvfb 70 MiB = ~361 MiB

# 2. One session open, PSS across the Chrome tree
#    651 MiB (14 procs at rest, 23 during a page load)

# 3. CPU ground truth for that same session, cumulative not instantaneous
#    ~7 CPU-seconds TOTAL including a heavy page load
#    (20 procs at 0:00, two at 0:01, one at 0:05)

# 4. VALIDATE the delta by repetition — not against a summary number
#    floor:                    ~361 MiB
#    floor + one session:      ~1012 MiB  -> delta 651 MiB
#    open a second session, confirm the delta repeats within a few percent
#    (do NOT "confirm" against docker stats MemUsage: different quantity,
#     and at this moment it read 905 MiB -- BELOW the PSS total)

# 5. Only now, derive the cap
#    (4096 - 361) / 651 = 5.7   [all MiB]  ->  ~5 concurrent sessions
#    configured BGW_MAX_SESSIONS = 7     ->  cap exceeds what the box holds
```

Step 4 is the one that is easy to skip, and easy to fake. Steps 1-3 produced a believable number three
separate times in this investigation. What separates the right one from the two wrong ones is not that
some second number happened to look close — it is that PSS answers the question asked (how much
physical memory does one more session cost) while the other two answer different questions. Repetition
of the delta is what confirms you measured the thing; picking the metric whose definition matches the
question is what makes it the right thing to measure.

## Related

- `docs/solutions/architecture-patterns/over-subscription-refuses-cleanly-it-does-not-fail-to-launch.md`
  — direct predecessor. It closes on the open question this measurement answers: what a real
  concurrent workload costs in memory. Read together, and prefer these numbers over its
  unquantified "far more memory".
- `docs/solutions/architecture-patterns/cdp-detectability-baseline-three-way.md` — closest
  methodological sibling and the prior art for the cross-validation rule. It is the same method in
  the stealth domain: no single arm is trusted, and a probe that could not be evaluated never counts
  as evidence.
- `docs/solutions/best-practices/comparing-image-id-to-manifest-digest-is-not-a-drift-check.md` —
  same failure family: a number one tool printed was read as a fact it does not carry, escalated
  into a confident finding, then retracted. That doc's trap is identifier *kind*; this one's is
  metric *semantics*.
- `docs/solutions/best-practices/a-test-whose-stub-guarantees-the-assertion-proves-nothing.md` — its
  rule generalizes from tests to instruments. The new wrinkle: a third-party instrument you did not
  write has the same defect, and you cannot verify it RED by breaking your own fixture — you verify
  it by watching it disagree with an independent instrument.
- `docs/solutions/runtime-errors/keys-apply-sizing-guard-crash-loop.md` — the pool floor is the
  decision these numbers feed. Its recovery advice ("mind the box's RAM") is the gap that sends an
  operator to `docker stats` in the first place.
- `docs/solutions/architecture-patterns/reap-detached-process-by-owned-userdatadir.md` and
  `confirmable-browser-teardown-force-kill.md` — the other consumers of the host-visible-`/proc`
  fact this technique depends on.
