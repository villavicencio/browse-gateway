---
title: BGW_ATTEMPTS=1 alone false-FAILs validate-stealth — BGW_REQUIRED=1 must ride along
module: scripts/validate-stealth
date: 2026-06-12
problem_type: runtime_error
component: testing
severity: medium
symptoms:
  - "A quick 1-attempt stealth confirmation run prints PASS per run but FAIL per category"
  - "validate-stealth exits non-zero even though every executed attempt cleared its target"
root_cause: config_error
resolution_type: workflow_improvement
related_components:
  - testing
  - deployment
tags: [validate-stealth, kill-gate, BGW_ATTEMPTS, BGW_REQUIRED, false-negative, quick-gate]
---

# BGW_ATTEMPTS=1 alone false-FAILs the stealth gate

## Problem

`scripts/validate-stealth.mjs` defaults to requiring 3 passing attempts per category. Setting
only `BGW_ATTEMPTS=1` (to get a fast 1-attempt confirmation) runs one attempt but still
requires 3 — so a fully passing run reports 1/3 and FAILs. The contradiction ("PASS per run,
FAIL per category") looks like a real stealth regression and once burned a prod cutover check.

## Resolution

For the quick 1/1 gate, set BOTH knobs:

```sh
docker exec -e BGW_ATTEMPTS=1 -e BGW_REQUIRED=1 <container> node scripts/validate-stealth.mjs
```

The obscura CLI's opt-in stealth gate (`connect --full`, `status --stealth`) bakes this in —
see `sshStealthGate` in `src/cli/connect.ts`.

## Prevention

When a harness has paired "how many to run" / "how many must pass" knobs, changing one without
the other produces structurally impossible requirements. Wrap the pairing in a function or
documented one-liner rather than re-deriving it each time.

(Promoted from agent memory `stealth-gate-attempts-required`, which dates the original
incident to the 2026-06-01 prod cutover.)
