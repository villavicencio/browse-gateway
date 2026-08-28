---
title: Two sha256 values are not the same fact until you confirm they are the same kind of identifier
date: 2026-08-25
category: docs/solutions/best-practices
revised: 2026-08-27
module: scripts/deploy/deploy-on-host.sh, scripts/deploy/preswap-smoke.sh, .github/workflows/deploy-http.yml, src/cli/keys.ts
problem_type: best_practice
component: deployment
severity: high
root_cause: incorrect_assumption
resolution_type: workflow_improvement
applies_when:
  - "You are comparing two hash/digest/ID values from different tools or log lines and about to conclude they should match"
  - "You are about to write a finding into memory or a handoff that characterizes the production deploy path as broken, drifted, or unsafe"
  - "A conclusion about running code was reached by reading scripts, not by tracing what a specific captured value actually measures"
  - "You are recording what production is running, and the note will pair a digest with a commit or an anchor"
related_components:
  - deployment
  - observability
tags:
  - deploy-verification
  - image-id
  - manifest-digest
  - rollback-anchor
  - docker-inspect
  - false-positive
  - measure-not-reason
  - memory-hygiene
---

## Context

On 2026-08-25, during a routine production deploy, an agent compared the rollback anchor printed by
the deploy script against the manifest digest resolved by the deploy workflow, found they didn't
match, and concluded prod had silently drifted off the recorded deploy history. It escalated this
into the session's headline finding, wrote it to persistent memory, and began scoping a fix to the
deploy path — the highest-risk surface in this repo.

The conclusion was wrong. The two values were never supposed to match. They are different *kinds* of
identifier for the same image, and the mismatch is guaranteed by construction.

`scripts/deploy/deploy-on-host.sh` captures the rollback anchor like this (line 173 as of
2026-08-27 — VIL-134 inserted the image-extraction block above it, so grep the symbol rather than
trusting the number):

```sh
# 5 — capture the currently-running image (by ID = runnable digest) for rollback.
ROLLBACK_IMAGE="$(docker inspect "$CONTAINER" --format '{{.Image}}' 2>/dev/null || true)"
```

`{{.Image}}` on a **container** inspect returns the image ID — a hash of the image's local config
object. What the deploy records as "what we shipped" is a different value entirely: the **registry
manifest digest**, resolved in `.github/workflows/deploy-http.yml:42`:

```sh
DIGEST="$(docker buildx imagetools inspect "${REPO}:${IMAGE_TAG}" --format '{{.Manifest.Digest}}')"
```

Image ID and manifest digest are computed over different inputs (local config vs. registry manifest)
and are not expected to be equal for one and the same image. Neither definition had been grepped
before the two hex strings were treated as the same fact.

**Where the trap was actually set (session history).** Reviewing prior sessions shows this was not a
recurrence — the image-ID-vs-manifest-digest mixup appears nowhere earlier. What does appear is the
*recording convention* that made it easy: prod state has long been written as a single line pairing
values of three different kinds, unlabeled —

> `prod now sha256:d55aa084… (= main HEAD 47e414e); rollback anchor sha256:4becdf0a`

A manifest digest, a git commit, and an image ID, sitting adjacent and reading as interchangeable
shorthand for "what's deployed." A later reader comparing the first and third fields is doing what
the note's own shape invites.

## Guidance

**Before comparing two opaque identifiers (hashes, digests, IDs, checksums) and drawing a conclusion
from a mismatch, find the exact line that produces each one and confirm they measure the same
thing.** A `sha256:` prefix, a hex string, or a shared naming convention ("digest", "anchor", "ID")
is not evidence of comparability — it is exactly the surface coincidence that makes two unrelated
values look like they should agree.

The check is one command per value, run *before* the comparison:

```sh
grep -rn "ROLLBACK_IMAGE=" scripts/deploy/deploy-on-host.sh
grep -rn "Manifest.Digest" .github/workflows/deploy-http.yml
```

Different inspect targets (`docker inspect <container>` vs. `docker buildx imagetools inspect
<repo:tag>`) or different format verbs (`{{.Image}}` vs. `{{.Manifest.Digest}}`) mean a mismatch
between them tells you nothing about the running system.

**Then fix it upstream: label the kind at write time.** The cheaper intervention is not the grep at
read time but the annotation at write time, because the note outlives the session that wrote it.
When recording deploy state in memory, a handoff, or a ticket, say which kind each value is:

```
prod: manifest digest sha256:b2e1966f… (= main b6f236e)
      rollback anchor  sha256:36fad1f4… (IMAGE ID of the outgoing image — not comparable to a digest)
```

To learn what a running container actually is, read `RepoDigests` — not `{{.Image}}`.

The same discipline generalizes past this repo's deploy path:

- Git short SHA vs. full SHA vs. tree SHA vs. commit SHA — four different hashes, all hex, all called
  "the SHA" in casual conversation.
- A file's content hash vs. its git blob hash (the latter is `sha1("blob " + len + "\0" + content)`,
  not a hash of the raw bytes).
- Docker image ID (config hash) vs. image digest (manifest hash) vs. RepoDigest (registry digest as
  recorded in local image metadata) — three variants of the same trap, all reachable from a single
  `docker inspect`.

## Why This Matters

**Confident, specific, and wrong is the worst combination a finding can have.** A vague suspicion
gets checked before anyone acts on it. A finding stated as fact — "prod's image has silently
drifted," written into memory as the session's most important discovery — gets acted on directly.

The proof that this comparison was invalid is in the deploy workflow's own logs, which print both
values on every run:

| Deploy | Commit | Resolved manifest digest | Rollback anchor (image ID) |
|---|---|---|---|
| 2026-07-24 | `47e414e` (#88) | `sha256:d55aa084…` | `sha256:4becdf0a…` |
| 2026-08-25 | `b6f236e` | `sha256:b2e1966f…` | `sha256:36fad1f4…` |

The anchor never equals the digest in either row — not because something drifted between those two
deploys, but because they are structurally never the same value for any deploy. `36fad1f4` is simply
the local image ID of the image whose manifest digest is `d55aa084`; prod was running exactly what
the deploy history recorded.

The trap is structural rather than personal: the automated claims-validator run over *this very
document* flagged all four values above as unresolvable git commit SHAs. It saw hex strings and
assumed they were the same kind of identifier — the exact substitution described here, made by a
tool built to catch bad claims.

Three further claims from the same finding were asserted from reading code rather than tracing an
observed value, and each is refuted by the tree as it stands:

- **"`--apply` is an unrecorded code deployment."** The apply path re-creates the container to pick
  up new env/manifest, not a new image — the documented contract at `src/cli/keys.ts:32-35` and
  `src/cli/keys.ts:140-141`. `scripts/deploy/preswap-smoke.sh:19-23` states the same fact from the
  other side: the `--apply` path passes the **currently-running image** into the smoke because "only
  the env file / manifest changed."
- **"The CD path lacks independent hardening."** `scripts/deploy/deploy-on-host.sh:44` regex-validates
  the incoming image reference against `^ghcr\.io/[a-z0-9._-]+/browse-gateway@sha256:[0-9a-f]{64}$`
  before anything else runs, and `deploy-on-host.sh:49` checks the repo/owner matches on-host config.
  Both gates run before the pull and are unconditional.
- **"`preswap-smoke.sh`'s contract is violated by the apply path."** It is coherent by design: when
  `BGW_DEPLOY_IMAGE` is unset the script defaults to the currently-running container's image
  (`preswap-smoke.sh:44`) specifically for the `--apply` case.

None of these needed anything beyond reading the cited lines. All three were instead asserted and
stacked on the invalid comparison, which is how one bad comparison became a four-part case for
touching the deploy path.

> **Addendum 2026-08-27 — the refutations above were right, and were reached the wrong way.** Each
> cites a line number in `scripts/deploy/*.sh` as evidence about **production** behaviour. VIL-134
> later established that production did not run those files: the CD deploy executed an *inline* copy
> of the smoke inside the host's own `deploy-on-host.sh`, and `--apply` executes a separate on-host
> copy of `preswap-smoke.sh`. The repo copies were not the executing code, so citing their line
> numbers proved nothing about prod by itself.
>
> The conclusions survive on re-checking the host's actual file — the digest regex and the repo/owner
> check really are there, at the *same* lines 44 and 49, because those particular lines had not
> drifted. That is luck, not method. The doc's own lesson applies to the doc: **trace the value
> where it executes.** For deploy scripts that means reading the copy on the host, or confirming the
> path sources it from the image. Since VIL-134 the CD smoke *is* sourced from the image, so a repo
> line number is finally evidence about prod for that one file — and still is not for the others.

This is the same failure family as
[a test whose stub guarantees the assertion proves nothing](a-test-whose-stub-guarantees-the-assertion-proves-nothing.md)
and the project rule "Measure; do not reason" (`CLAUDE.md`): a claim about system behavior was
treated as established because it was internally consistent and plausible, not because it was checked
against the artifact that would prove or disprove it.

## When to Apply

- Any time a "mismatch" between two hash/digest/ID-shaped values is about to become a finding, a
  memory write, a handoff note, or a remediation plan — especially when the target is a high-risk
  surface (a deploy path, an auth boundary, a data migration).
- Any time a claim about "what production is running" rests on values captured by two different
  tools, two different `docker inspect` targets, or two different pipeline stages.
- Before writing "X is broken" or "X silently drifted" into agent memory. Memory writes compound: a
  wrong conclusion recorded with the same confidence as a verified one is indistinguishable to a
  future session.
- When *writing* the record, not only when reading it — label each identifier's kind so the next
  reader is not invited into the same comparison (session history).

## Examples

**Before (the wrong comparison):**

> Rollback anchor from the last deploy log: `sha256:4becdf0a…`
> Manifest digest the deploy workflow resolved: `sha256:d55aa084…`
> These don't match → prod has drifted off the recorded deploy. `--apply` must be shipping unrecorded
> code changes. Escalating to a fix on the deploy path.

**After (confirm the identifier kind first):**

> `grep -n "ROLLBACK_IMAGE=" scripts/deploy/deploy-on-host.sh` → line 173: captured via
> `docker inspect "$CONTAINER" --format '{{.Image}}'` — a **container** inspect, image ID.
>
> `grep -n "Manifest.Digest" .github/workflows/deploy-http.yml` → line 42: captured via
> `docker buildx imagetools inspect … --format '{{.Manifest.Digest}}'` — a **registry manifest**
> inspect, manifest digest.
>
> Different inspect targets, different format verbs → two different identifiers for the same image,
> never expected to be equal. No drift.

**The one honest residual finding that survives this correction:** an image ID does not map back to a
source commit without a registry lookup, and the `gh` token here lacks `read:packages` (GHCR version
queries return 403). That is a traceability gap, not a deploy-path defect — release-versioning work,
tracked as `VIL-112`. Note that the tracked issue independently reaches the same conclusion this doc
does from the other direction: it specifies that the fix must *not* surface an image digest to
consumers, and should expose an opaque build identifier via `serverInfo.version` instead. Image
digests are not, and should not become, the traceability mechanism.

## Related

- [A test whose stub guarantees the assertion proves nothing](a-test-whose-stub-guarantees-the-assertion-proves-nothing.md) —
  sibling "looked right but wasn't" failure: a check that structurally could not validate the claim.
- [Over-subscription refuses cleanly, it does not fail to launch](../architecture-patterns/over-subscription-refuses-cleanly-it-does-not-fail-to-launch.md) —
  three confident diagnoses reasoned from source-reading, all refuted by one measurement.
- [An approving review proves nothing until base and effort are verified](../workflow-issues/an-approving-review-proves-nothing-until-base-and-effort-are-verified.md) —
  same genre: a superficially-passing signal trusted without confirming what it measures.
- [Local port owner verification needs provenance](../architecture-patterns/local-port-owner-verification-needs-provenance.md) —
  a value matching the expected shape does not establish it is the same kind of fact.
- [keys --apply sizing guard crash loop](../runtime-errors/keys-apply-sizing-guard-crash-loop.md) —
  documents what `--apply` actually does; the misreading corrected above ran against it.
