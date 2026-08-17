---
title: A driver's cancel() and delete() are mutually exclusive — requiring both to confirm poisons the runtime
date: 2026-08-17
category: docs/solutions/integration-issues
module: artifacts/index (ArtifactOperation#startCleanup), mcp/runtime, mcp/http-main, scripts/validate-artifact
problem_type: integration_defect
component: artifact-disposal
severity: critical
status: one defect FIXED (capture enablement); one defect OPEN and evidenced (disposal confirmation)
applies_when:
  - "You require two third-party driver operations to BOTH confirm before you call a resource released"
  - "A capture/cleanup protocol was specified against a documented API surface but never run against the real driver"
  - "An artifact/capture runtime latches a permanent 'poisoned' state on one unconfirmed cleanup"
---

## Problem

Two defects, both latent behind `BGW_ARTIFACT_CAPTURE_ENABLED=1`, both invisible to 1489 green
host-side unit tests, and both found within minutes of the first in-container run of
`scripts/validate-artifact.mjs`.

**1. Artifact capture was never enabled on any browser core. (FIXED)** `BrowserCoreOptions.captureEnabled`
existed, `PatchrightBrowserCore` honoured it, and *nothing in `src/gateway/`, `src/verbs/` or
`src/mcp/` ever set it*. This did not merely fail to capture. `#requireCaptureReady` refuses an
operation handed to a capture-disabled session, so the moment artifacts were enabled, **every
`retrieve` and every `browser_navigate` failed**:

```
browse-gateway error: artifact capture: an operation was supplied to a session with capture disabled
```

**2. One refused download permanently poisons the artifact runtime. (OPEN — evidenced, not fixed.)**
After a single non-PDF, sub-magic-length or oversize download, every later `createOperation` throws
`artifact-cleanup-failed` for the life of the process — and because both verbs' `beginCapture()`
swallow that throw, capture just silently stops happening. For the EID use case that means one HTML
error page or login redirect served as an attachment kills bill capture until the container restarts.

## Root cause of the open defect

`ArtifactOperation#startCleanup` disposes of the driver's copy by invoking `cancel()` **and**
`delete()`, and requires `results.every(Boolean)` — both must confirm, or the cleanup is unconfirmed
and the runtime is poisoned. It invokes them *concurrently and synchronously*, deliberately, so that a
hung `cancel()` cannot starve the `delete()`.

Against a real Patchright/Playwright `Download` the two operations are **mutually exclusive**.
Measured in-container:

| invocation | cancel | delete | bytes gone |
|---|---|---|---|
| concurrent (both invoked, neither awaited) | resolved | **rejected** `download.delete: canceled` | true |
| concurrent (other race outcome) | **rejected** `Target page, context or browser has been closed` | resolved | true |
| sequential `cancel()` → `delete()` | resolved | resolved | **true** |
| sequential `delete()` → `cancel()` | rejected | resolved | true |
| `delete()` alone | — | resolved | true |
| `cancel()` alone | resolved | — | **false** |

Whichever call lands first makes the other reject. So `every(Boolean)` is false on an ordinary refused
capture, and the race makes *which* download poisons the runtime non-deterministic — it moved between
`/notpdf.bin` and `/tiny.bin` across runs, which is why it never looked like a reproducible bug.

## Why this was NOT fixed in the same change

Two candidate fixes were considered and both were rejected on evidence:

- **Relax to `some(Boolean)`.** Refuted by the last row of the table: `cancel()` alone leaves the bytes
  on disk. This would report a confirmed disposal that deleted nothing — the exact outcome the
  confirmation exists to prevent.
- **Sequence the calls (`cancel()`, then `delete()` once cancel settles or a short bound elapses).**
  Implemented, and it turned the gate fully GREEN — then reverted, because it broke **10 deliberate
  tests** in `test/artifact-runtime.test.mjs`, and those tests are defending something real. The
  clearest is `a hung cancel() still gets delete() invoked...` (line 2367), which asserts
  **synchronously, with no await**, immediately after `invalidate()` returns:

  ```js
  op.invalidate("download-settle-timeout");
  // Cancel hung; delete must have been invoked anyway, immediately after it.
  assert.deepEqual(download.calls.filter(...), ["cancel", "delete"]);
  ```

  `invalidate()` runs during teardown. Deferring `delete()` by even one turn opens a window in which
  the process exits or the runtime closes with a private PDF still on disk. Sequencing therefore
  trades a silent capture outage for a possible undeleted private document — the wrong trade, and not
  one to make without an explicit decision.

The real fix needs a design call, not a sequencing tweak: **confirm disposal from filesystem evidence
(the staged path no longer exists) rather than from two mutually-exclusive API calls both resolving.**
That keeps `delete()` synchronous and mandatory, and makes the confirmation a fact about the bytes
instead of a fact about the driver's promise plumbing. It is a change to Amendment 7's confirmation
predicate and belongs in its own reviewed slice.

## What WAS fixed

`BuildRuntimeOptions.captureEnabled` is derived by `http-main.ts` from the same
`loadArtifactConfig(env).enabled` that decides whether the `ArtifactRuntime` is built, and applied to
`config.core` before `Gateway.create` pools any session. It is an option rather than an env read
because the listener must exist at core construction; it is an option rather than a fact of the
builder because `cli/vault-host.ts` shares that builder, owns no runtime, and must keep its
pre-artifact behaviour.

## How it was found, and why nothing else could have found it

`scripts/validate-artifact.mjs` is the first thing that ever ran the artifact stack against a real
browser. The unit suites inject **fake** browser cores, and a fake core has no listener to install and
no driver `Download` whose `cancel()`/`delete()` can race — so a fake could not express either defect.

Four further traps the gate had to route around, worth knowing before writing another one:

- **`createOperation` refuses an IP-literal `sourceHost`** (`isIP(...) !== 0` →
  `artifact-config-invalid`), so a fixture served at `127.0.0.1` can never capture, and the throw is
  swallowed by `beginCapture()` — it presents as "capture silently does nothing", not as an error.
  Reach the loopback fixture through a **hostname** (`--add-host bill-fixture.test:127.0.0.1`). That
  also lets the gate run against the unmodified shipped egress filter instead of a narrowed one.
- **`ArtifactRuntime` does not re-export the store's `accounting()` seam.** A leg written as
  `runtime.accounting?.()` silently skips — a vacuous guard. Assert the property the way a consumer
  can observe it instead: after the refusals, a fresh capture must still seal *and* still be retrievable.
- **A denial leg that two independent mechanisms can satisfy proves neither.** The first version tested
  the foreign consumer against a *drive-scoped* artifact, so the lineage check refused it and consumer
  identity was never exercised — the `foreign-owner` RED control came back GREEN and exposed it. Test
  consumer identity against a **consumer-scoped** artifact and lineage against a **drive-scoped** one.
- **A cleanup leg needs something left to clean up.** Every artifact the gate captured was consumed
  one-shot, and `complete()` discards a consumed artifact immediately — so the orphan scan read an
  EMPTY directory whether or not `runtime.close()` ran, and `skip-cleanup` could not have failed. The
  leg now takes one artifact it deliberately never consumes, *before* the refusal legs, and asserts it
  is on disk before cleanup. Take the premise early: a cleanup test whose setup depends on capture
  still working after four refusals is testing two things and reporting one.

## Prevention

- A protocol that requires two third-party operations to both confirm is a claim about that third
  party. Run it against the real one before shipping the claim.
- When a cleanup failure latches a permanent, process-wide refusal, the confirmation predicate needs
  the same scrutiny as the thing it guards: here, one false negative disables a whole feature silently.
- Build the RED controls before trusting any GREEN leg, and read the gate adversarially as well. Two
  of this gate's own legs were vacuous: one was caught by a control coming back GREEN, the other only
  by an independent review reading it.
