---
title: A gate must travel with the code it gates — an on-host copy is a gate that silently stops existing
date: 2026-08-27
category: docs/solutions/best-practices
module: scripts/deploy/deploy-on-host.sh, scripts/deploy/preswap-smoke.sh
problem_type: best_practice
component: deploy-pipeline
severity: high
applies_when:
  - "A deploy, CI, or provisioning gate is installed on a host rather than shipped with the artifact"
  - "You hardened a check in the repo and are about to assume the next deploy runs it"
  - "The same script exists in more than one place and only one of them is the one that executes"
---

## Problem

A deploy gate was strengthened in the repo, merged, and deployed — and the new assertion **never
ran in production**. Nothing failed. CI was green, the PR was reviewed, the repo read as gated.

The pre-swap smoke existed in **three** places:

| # | Where | Who runs it | State when this was found |
| -- | -- | -- | -- |
| 1 | `scripts/deploy/preswap-smoke.sh` (repo, shipped in the image) | nothing in production | carried the new `version=` assertion |
| 2 | on-host standalone `preswap-smoke.sh` | `obscura … --apply` via `smokeCmd` | ~3 weeks stale, no `version=` assertion |
| 3 | inline `preswap_smoke()` inside the host's `deploy-on-host.sh` | **the CD deploy** | ~2.5 months stale, greps only `dnsRebindProtection=true` |

The deploy SSH key is locked on-host to `command="…/deploy-on-host.sh"`, so CD runs (3) and only
(3). Nothing in the deploy workflow ever shipped (1) to the host. The repo copy was decorative.

**This is worse than having no gate.** A missing gate is visible; a gate that exists in the
repository and does not execute in production is invisible, and it launders every future change to
it into a false sense of coverage. The same trap applies to every on-host copy of a repo script —
the host's `launch-http.sh` was two months stale by the same mechanism.

## Root cause

The gate was installed **next to the thing that invokes it** instead of **inside the thing it
gates**. A host-installed script has no forcing function that ties its version to the artifact
under test, so drift is the default state and staleness produces no error — only silence.

## Solution

**Extract the gate from the artifact being gated, at gate time.**

```bash
# deploy-on-host.sh — the forced command, the ONE piece that cannot travel with the image.
SMOKE_IN_IMAGE="/app/scripts/deploy/preswap-smoke.sh"
SMOKE_CID="$(docker create "$IMAGE" 2>"$SMOKE_ERR")"      # stdout ONLY — see gotcha below
docker cp "${SMOKE_CID}:${SMOKE_IN_IMAGE}" "$SMOKE_TMP" || exit 1   # FAIL CLOSED
[ -s "$SMOKE_TMP" ] || exit 1                                       # empty == absent
```

Four properties make this work, and each one is load-bearing:

1. **Fail closed.** An image that does not carry the gate aborts the deploy. A missing gate must
   never read as a passing one — that is the exact failure being fixed, and it is trivially easy to
   reintroduce with a `|| true`.
2. **`docker create` + `docker cp`, not `docker run … cat`.** `create` starts no process, so pulling
   a script out of an image never executes image code, and it does not depend on the image shipping
   a `cat`. You are about to run this file on the host — extract it without running anything first.
3. **Minimise what stays on the host.** The forced command cannot travel with the image (it *is* the
   trust boundary). That is the argument for delegating everything else to the image, not against it.
4. **Print provenance.** Log the path and a hash of what actually ran, so a wrong or stale gate is
   visible in the deploy log rather than inferred.

### Deliberate asymmetry: the gate ships, the launcher does not

`launch-http.sh` stays host-owned, and the extracted smoke is pointed at the **host's** copy via
`BGW_LAUNCH_SCRIPT`. The smoke is a pre-flight of the swap, and the swap runs the host's launcher —
a smoke that booted the candidate with a *different* launcher than the one that will deploy it is a
false green. The host owns production launch; the image owns the gate. Divergence between the host
launcher and the image's copy is reported as a NOTE and is never fatal.

## Gotcha that will bite you

`SMOKE_CID="$(docker create "$IMAGE" 2>&1)"` looks like good error handling and is a bug. This
daemon prints `WARNING: IPv4 forwarding is disabled. Networking will not work.` to **stderr**, and
`2>&1` folds it into the captured container id — handing an unusable ref to `docker cp` and then to
`docker rm`, leaking a staged container on every single deploy. Capture stdout only; send stderr to
a file you can quote in the failure message.

## How to verify it

Not by reading the diff. Construct the RED at the source and **watch it**:

- an image fixture with **no** smoke → deploy aborts, live container untouched;
- an **empty** smoke → deploy aborts;
- a **failing** smoke → deploy aborts *before* the swap;
- a passing smoke → the **image's** copy is what ran (prove it with a marker the host copy does not
  write), and the host's stale copy did not.

`test/deploy-smoke-sourcing.test.mjs` does this against a fake daemon, so the script under test is
the real one. Every assertion in it was watched failing with the fix reverted. See
[a-test-whose-stub-guarantees-the-assertion-proves-nothing](a-test-whose-stub-guarantees-the-assertion-proves-nothing.md).

## The general rule

> If a check lives anywhere other than the artifact it checks, assume it is stale until you have
> watched it run. Count the copies: if a script exists in N places, exactly one of them executes,
> and it is not automatically the one you edited.
