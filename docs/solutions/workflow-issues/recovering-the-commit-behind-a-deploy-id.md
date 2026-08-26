---
title: Recovering the commit behind a deploy id — and the short-sha trap that silently returns a wrong answer
date: 2026-08-26
category: docs/solutions/workflow-issues
module: .github/workflows/ci.yml, src/mcp/version.ts, docker/Dockerfile
problem_type: operational_procedure
component: deployment
severity: medium
root_cause: identifier_kind_confusion
resolution_type: documented_procedure
applies_when:
  - "A consumer reported a version like 1.0.0+ddca7448f998 and you need to know which commit that is"
  - "You are about to compare, recompute, or reason about a deploy id"
---

# Recovering the commit behind a deploy id

The gateway reports `serverInfo.version` as `1.0.0+<12 hex>`. The semver core comes from
`package.json`; the build-metadata segment is an **opaque deploy id** stamped at image build time.

It is `HMAC-SHA256(BGW_DEPLOY_ID_KEY, <full commit sha>)`, truncated to 12 hex characters
(`.github/workflows/ci.yml`, "Compute deploy stamp"), baked into the image at `/app/.deploy-id`
(`docker/Dockerfile`) and read by `src/mcp/version.ts`.

## Why it is a one-way function

The repo is public. A consumer-visible **commit ref** would tell any reader exactly which commit of
the stealth source is live, and let them diff it against later commits to see what changed in
anti-bot handling. The HMAC keeps the "did the same deployment answer both my calls?" signal while
disclosing nothing to anyone without the key.

`BGW_DEPLOY_ID_KEY` is **not a credential** — it authenticates nothing and grants no access. Losing
it costs traceability, not security. Leaking it costs precision about which commit is live.

## The procedure

The key lives in the macOS login Keychain as `bgw-deploy-id-key`, and write-only in GitHub Actions
secrets. **The Keychain copy is the only readable one** — GitHub never gives a secret back — so a
key that exists only in GitHub yields stamped images nobody can interpret.

```bash
KEY=$(security find-generic-password -s bgw-deploy-id-key -w)
printf '%s' "$(git rev-parse <commit-ish>)" \
  | openssl dgst -sha256 -hmac "$KEY" -hex | awk '{print $NF}' | cut -c1-12
unset KEY
```

Compare against the id the consumer reported. To search, run it over candidates:
`git log --format=%H -20 main`.

## ⚠️ The trap: the sha you have is not the sha that was hashed

**CI keys on `GITHUB_SHA`, the full 40-character sha. But `ci.yml` tags images with the SHORT sha**
(`type=sha,prefix=,format=short`). So the identifier sitting in front of you — an image tag — is not
the input that produced the deploy id.

Feed the short sha in and you get a perfectly well-formed 12 hex characters that **match nothing**,
with no error. Measured on commit `90b76a79384b…`:

| Input | Deploy id |
|---|---|
| full sha `90b76a79384b9cf74a5e55b25e6df7aef564f094` | `89ae5a2baf28` ← what CI stamps |
| short sha `90b76a7` | `291dfd72fd7b` ← same shape, wrong answer |

Hence the `git rev-parse` in the command above. Always expand first.

This is the same family as
`docs/solutions/best-practices/comparing-image-id-to-manifest-digest-is-not-a-drift-check.md`: two
values of identical shape that are not the same kind of thing. There are now **five** identifier
kinds in this system — contract version, deploy id, manifest digest, image ID, commit sha. Label
which one you mean, every time.

## Verifying without the key at all

The id is baked into the image, so you can always read it directly:

```bash
docker run --rm --platform linux/amd64 --entrypoint sh \
  ghcr.io/<owner>/browse-gateway:<short-sha> -c 'cat /app/.deploy-id'
```

That answers "what did this image ship with"; the HMAC answers "which commit is this id".

## Unstamped images are normal

A build with no secret ships unstamped: the resolver reports a bare `1.0.0` and the boot line says
`deploy=none`. CI emits a warning annotation rather than failing. Local `docker build` is always
unstamped. Only ENOENT counts as absent — an unreadable or malformed stamp refuses the boot, because
a corrupt identity is worse than a missing one.
