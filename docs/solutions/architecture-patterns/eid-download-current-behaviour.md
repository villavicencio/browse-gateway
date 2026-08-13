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
unmodified. The harness navigates, then passively records: whether a `download` event fired, the
suggested filename (only when it passes a basename safety gate), and a stat of the driver's temp
file on **both sides** of the browser context close. It saves nothing and cancels nothing.

Two guards decide whether a run is publishable at all, and they answer *"can this reading be
trusted"*, never *"did the stack behave well"*: a **validity guard** (controls behaved, a core was
actually observed on each surface, fixture served the shapes under test) and a **hygiene guard**
(the serialized report carries no PDF bytes, cookies, query strings, absolute temp paths or consumer
token). Exit code reflects the measurement, not the behaviour — a "no download fired" row is a
result, not a failure.

## Observed result

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
instrument was watched failing to be quiet-by-accident.

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
  unanswered question cannot manufacture a finding.
- **Attribute downloads by served path, not by arrival order.** An attachment navigation returns
  before its transfer finishes, so counting events between two timestamps mis-files them.
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

Other fault arms: `break-fixture` (fixture self-check red), `forge-download` (negative control red),
`leak-temp-path` (hygiene guard red). Harness logic — both guards included — is unit-tested without
a browser:

```bash
npm run build
node --test test/eid-download-measure.test.mjs
```
