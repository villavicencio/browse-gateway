---
title: "A ticket's \"merged but NOT DEPLOYED\" banner is a snapshot, and it goes stale silently"
module: workflow, deployment
date: 2026-08-26
problem_type: workflow_issue
component: deployment
severity: medium
symptoms:
  - "Two Urgent tickets sat In Review carrying `FIXES ARE MERGED TO main BUT NOT DEPLOYED`"
  - "The banner named a last-deploy commit that was two deploys old"
  - "Both fixes had in fact been running in production for a day"
root_cause: stale_documentation
resolution_type: workflow_improvement
related_components:
  - deployment
  - issue-tracking
tags: [linear, deploy-verification, stale-ticket, urgency, triage, gh-run-list]
---

## Problem

Tickets that carry a deployment-status banner — `MERGED BUT NOT DEPLOYED`, `the last production
deploy was <sha>` — encode a fact that expires the moment someone deploys. Nothing updates them.
The ticket keeps asserting it, at Urgent, and the assertion reads as current because everything
around it is precise and well-evidenced.

Observed 2026-08-26: VIL-117 and VIL-118 both stated *"the last production deploy was 2026-07-24 at
`47e414e`. Neither fix is running in production."* True when they were migrated from GitHub on
2026-08-25. By then a deploy had already been queued, and it landed at 22:09Z the same day. Both
sat for a day claiming a production exposure that no longer existed, while the actual remaining
work — an observability gap — was buried under a banner shouting about an outage.

The failure mode is not "the ticket was wrong." It is that **a stale banner inverts triage**: it
inflates finished work to Urgent and hides the unfinished part.

## The check

Three commands, ~20 seconds, before acting on any ticket's deployment claim.

```bash
# 1. What actually deployed, and when?
gh run list --workflow=deploy-http.yml --limit 5 \
  --json headSha,status,conclusion,createdAt \
  -q '.[] | "\(.createdAt)  \(.headSha[0:7])  \(.status)/\(.conclusion)"'

# 2. Is the fix contained in what deployed? (NOT "is it on main" — that is a different question)
git merge-base --is-ancestor <fix-sha> <deployed-sha> && echo "IN PROD" || echo "NOT in prod"

# 3. Confirm the running gateway agrees.
obscura status
```

Step 2 is the one that matters and the one that gets skipped. "The fix is merged to `main`" and
"the fix is in the deployed image" are independent facts, and a ticket typically asserts the first
while the reader infers the second.

## The deeper rule

**A ticket is evidence, not authority — the same standing given to `HANDOFF.md`.** Where a ticket
and the deploy history disagree, the deploy history wins, and the disagreement is itself the most
useful thing to report. Both surfaces are written by someone reasoning about a moment that has
since passed.

Corollary for writing them: when a ticket must record deployment state, **anchor it to a commit and
a timestamp** (`deployed at b6f236e, 2026-08-25T22:09:49Z`) rather than a status word
(`NOT DEPLOYED`). A reader can check an anchor in one command. A status word can only be believed
or disbelieved, and it will be believed.

## Related

- `recovering-the-commit-behind-a-deploy-id.md` — going the other way, from a running deployment
  back to the commit that produced it.
- `comparing-image-id-to-manifest-digest-is-not-a-drift-check.md` — an earlier case of the same
  shape: a confident deployment-state claim that measurement disproved.
