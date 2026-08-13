---
title: What the shipping stack does with a PDF today — attachment downloads and vanishes, inline returns an empty shell
date: 2026-08-13
category: docs/solutions/architecture-patterns
module: scripts/measure-eid-download, verbs/retrieve, mcp/drive-controller, browser
problem_type: architecture_pattern
component: download-lifecycle
severity: medium
applies_when:
  - "You are about to design EID document download and need the current behaviour, not an assumption"
  - "A consumer reports that a PDF URL returns nothing useful through retrieve"
  - "You are choosing which surface a download capture should hook into"
---

## Problem

Nothing in the repo recorded what the shipping stack does when a navigation resolves to a **file**
rather than a page. Any download design would have started from an assumption about where the bytes
go, whether the driver writes them at all, and how long they survive — exactly the class of claim
this project has repeatedly found to be wrong when someone finally measured it. Measurement task 0
exists to replace that assumption with a reading, and it implements no product behaviour.

## Method

`scripts/measure-eid-download.mjs` serves a **local, deterministic loopback fixture** — fixed bytes,
fixed headers — and drives four legs through each of the three surfaces a consumer can reach:

| Leg | Shape | Role |
|---|---|---|
| `attachment-pdf` | `application/pdf` + `Content-Disposition: attachment` | measured |
| `inline-pdf` | `application/pdf` + `Content-Disposition: inline` | measured |
| `octet-attachment-control` | `application/octet-stream` + attachment | positive control — MUST download |
| `html-control` | `text/html` | negative control — must NOT download |

Surfaces: `browser` (`createBrowserCore()` + `core.render()`, the call `retrieve()` makes
underneath), `retrieve` (over a policy-guarded gateway, transient session per call), and `drive`
(`GatewayDriveController.navigate()`, persistent consumer-bound session).

Observation attaches only at the documented injection seams — `Gateway.create`'s `CoreFactory` and
the core's public `context` getter — so the shipping verbs, policy guard and session lifecycle run
unmodified. The harness navigates, then records: whether a `download` event fired, the suggested
filename (only when it passes a basename safety gate), whether the download reported a failure, and
a stat of the driver's temp file on **both sides** of the browser context close. It saves nothing
and cancels nothing. It is not purely passive: to learn the temp path and the failure state it calls
`download.path()` and `download.failure()` and waits on them (bounded, 8 s) before the close.

**Attribution is deferred, not sliced.** Every `download` event goes into one persistent ledger
tagged with the core that saw it — and therefore the surface. Rows are filled only at report time,
after a barrier that waits for every queued teardown and every download settle. A record is filed by
**exact parsed URL pathname**; anything that cannot be filed is counted as *unattributed* and
invalidates the run. Nothing is per-leg: an event that arrives after its navigation returned, after
the next leg started, or after the surface finished still lands in its own row.

Teardown is a **state machine over both entry points**, not a latch. `beforeClose` is a barrier:
`close()` and `kill()` both await it before touching the real core, so a concurrent kill cannot
delete the temp file before the before-close stat reads it. `afterClose` runs once, only when every
real teardown in flight has settled. A hook that throws never skips the real teardown, never
propagates into the session's lifecycle, and is recorded — a failed hook invalidates the reading
instead of degrading into an `unknown` file state. The barrier is deliberately on the hooks and
**not** a queue over the real calls: `Session.teardown` abandons a wedged `core.close()` at its grace
deadline and escalates to `core.kill()`, and queueing that kill behind the abandoned close would
deadlock the one path that exists because the close may never resolve.

Two guards decide whether a run is publishable at all, and they answer *"can this reading be
trusted"*, never *"did the stack behave well"*. The **validity guard** requires: the fixture served
the shapes under test; a headful browser; every case row (both measured, both controls) present on
every *selected* surface; navigation evidence per row (the guard saw a request for that path, or the
policy layer audited a navigate decision); both controls behaving; a core observed per surface; zero
unattributed downloads; zero stat/accessor/settle observation failures; and completed teardown
observations for every core that saw a download. Each of those fields is read **fail-closed** — an
unstated one reads as bad news. The **hygiene guard** covers the serialized report *and every line
this process prints*, including the top-level failure path: an uncaught throw is caught and reported
as a validated `err.name` plus a closed-vocabulary marker, never a stack. Absolute paths are omitted
**by construction** (no row field carries one) and then greped for in every shape — POSIX,
`file://`, Windows drive and UNC — not just temp prefixes. Exit code reflects the measurement, not
the behaviour: a "no download fired" row is a result, not a failure.

## Observed result

> **Taken with the pre-review harness (commit `a8b9394`).** The revised harness tightens validity
> (measured rows, navigation evidence, unattributed downloads, teardown completion, headful) and
> re-derives attribution from the ledger. The findings below are the readings that run produced;
> treat them as **pending re-confirmation** until the in-container run is repeated on the current
> harness.

The in-container headful-Chrome run reported **validity `valid`, hygiene `clean`**.

**Attachment PDF — a real download happens, and the file does not survive the session.**
A `download` event fired on **all three surfaces**. The suggested filename passed the safety gate
and was reported. The driver's temp file was **present and non-empty before the context closed, and
absent after it closed**. On the `retrieve` surface the call returned **`status: null`** with
**`failureClass: nav-failed`** — a download navigation never becomes a page, so the verb has no
response to report.

**Inline PDF — no download at all, and the page is a shell.**
**No `download` event fired on any surface.** `browser` and `drive` both returned **`status: 200`**
with a **thin embed tree** — Chrome's internal PDF viewer, carrying no document text. `retrieve`
returned **`status: 200`** with **`failureClass: empty-shell`**.

**Both controls behaved correctly** on every surface: the octet-stream attachment downloaded, the
HTML page did not. Without that, neither measured row above would be interpretable.

## The guard was watched going red

A fault run — `BGW_EID_MEASURE_FAULT=mute-observer` on the `browser` surface, which never attaches
the download listener — reported **validity `INVALID`** with **`positive-control-silent`** and
**exited 1**. That is the arm that matters most here: the headline inline-PDF finding is a *quiet*
row, and a deaf apparatus produces quiet rows for free. The finding is only readable because the
instrument was watched failing to be quiet-by-accident. (That run was on the pre-review harness; the
fault arms are re-run in-container against the current one.)

The arms that cannot be reached by a fault mode are held RED by unit regressions in
`test/eid-download-measure.test.mjs`, each verified to fail against the rejected implementation
before the fix landed: a download arriving after its leg *and* after later legs, a concurrent
`close()`/`kill()` racing the before-close stat, a throwing teardown hook, a throwing stat or
site-controlled accessor, a missing measured row, an unattributed download, an absolute path outside
`/tmp`, and a headless run.

## Implications for the download design

- **The two dispositions are two different problems.** Attachment is a download-lifecycle problem
  (bytes exist, briefly). Inline is an extraction problem (no bytes ever leave the browser; there is
  a viewer, not a file). One capture mechanism will not serve both.
- **Capture must happen before the browser context closes.** The temp file is present before close
  and gone after — any design that closes the session and then goes looking for the artifact will
  find nothing. This is a lifecycle ordering constraint, not a tuning parameter.
- **`status: null` + `nav-failed` is the current attachment signature on `retrieve`**, and it is
  indistinguishable from a genuine navigation failure to a consumer. A download-aware result shape
  has to say "this was a file", or callers will keep reading successful downloads as errors.
- **`status: 200` + `empty-shell` is the current inline signature**, and it is worse than an error
  because it reassures. A 200 with no text reads as a page that happened to be empty.
- **All three surfaces see the download event**, so the hook point is a genuine choice rather than
  forced. The seam is available below the verb layer, which is where policy already lives.

## Gotchas

- **Fold temp-file readings at report time, not at leg time.** The teardown hooks write them when
  the core closes, which on `browser` and `drive` happens *after* the leg returns (one core serves
  every case). Folding early captured pre-close nulls and rendered them as a confident `absent` —
  i.e. "the driver wrote no file", a finding the run had not made.
- **A missing reading is `unknown`, never `absent`.** The three-valued temp-file state exists so an
  unanswered question cannot manufacture a finding. A stat that *throws* is `unknown` **and** an
  explicit observation failure — a failed look must never be reported as a look that found nothing.
- **A per-leg slice is not attribution, even with a path filter.** An attachment navigation returns
  before its transfer finishes, so the event can land after the leg's grace window, after the next
  leg, or after the surface. A slice strands it: the originating row reads `download: no` and the
  next row's path filter throws it away. Only a persistent ledger, filed by exact pathname after all
  downloads settle and teardown completes, puts a late event in the right row.
- **`endsWith(path)` is not identity.** It files `/decoy/attachment.pdf` against the
  `/attachment.pdf` case. Compare the parsed `URL.pathname`.
- **A teardown latch must be a barrier — but only on the hooks.** Setting the latch before running
  the hooks lets a concurrent `kill()` reach the real kill first, deleting the temp file *before*
  the before-close stat the whole reading depends on. Making both entry points await the
  before-close hook fixes that. Making them queue behind each other's *real* calls does not: the
  shipping escalation abandons a wedged close and calls kill, so the queue would deadlock exactly
  the case it was meant to protect. Never let a throwing hook skip the real teardown, and never let
  a wedged teardown silently become an `unknown` file reading.
- **Aggregate multiple records honestly.** When a case sees more than one download, reporting the
  first record's filename and temp state beside an event count of *n* implies they describe each
  other. Fields that disagree read `mixed`; disagreeing filenames are withheld as
  `multiple-distinct`.
- **A quiet row is only readable if nothing went missing.** Both controls green is not enough: a
  measured row lost to a race, a row with no navigation evidence, or a single unattributed download
  all invalidate the reading, because each of them can manufacture a false "no download happened".
- **Temp paths are not only under `/tmp`.** A driver that writes to `/home/node/.cache/...`,
  `/dev/shm/...` or a Windows path leaks exactly as completely. The hygiene guard blanks the
  report's own documented vocabulary (its four fixture routes and media types) and then rejects any
  absolute path shape in what remains.
- **Headless is a different browser.** `BGW_HEADLESS=1` still runs, for debugging, but the reading
  is reported INVALID: it does not describe the shipping stack, which is headful under Xvfb.
- **The suggested filename is site-controlled data.** It is reported only when it is a plain
  basename; anything else is withheld with a typed reason, so the report can never become the place
  a hostile filename gets copied from.
- **This reading is a loopback fixture, not the field.** It answers what the stack does with those
  two header shapes. It says nothing about auth walls, redirect chains to a CDN, or a real EID
  host's challenge behaviour.

## Commands

Run in-container only — headful Chrome under Xvfb:

```bash
docker build --platform linux/amd64 -f docker/Dockerfile -t browse-gateway:eid-measure .

# the reading
docker run --rm --platform linux/amd64 --shm-size=1g --init browse-gateway:eid-measure \
  node scripts/measure-eid-download.mjs

# watch the positive control go RED (expects validity INVALID, exit 1)
docker run --rm --platform linux/amd64 --shm-size=1g --init \
  -e BGW_EID_MEASURE_FAULT=mute-observer -e BGW_EID_MEASURE_SURFACES=browser \
  browse-gateway:eid-measure node scripts/measure-eid-download.mjs
```

Other fault arms: `break-fixture` (fixture self-check red), `forge-download` — synthesizes a download
on every *navigation*, so the HTML control fires and the negative control goes red — and
`leak-temp-path` (hygiene guard red, on a path outside `/tmp` as well as inside it). A headless run
(`BGW_HEADLESS=1`) is reported INVALID by design. Harness logic — both guards, the ledger and the
teardown state machine included — is unit-tested without a browser:

```bash
npm run build
node --test test/eid-download-measure.test.mjs
```
