# HANDOFF — 2026-06-01

The **U6 production cutover landed**. The self-hosted browse-gateway MCP now serves the consumer
agent in production (both of its runtimes); the prior cloud browser MCP is decommissioned. The
cutover ran ahead of the 2026-06-07 external-dependency downgrade. Everything below the agent was
proven end-to-end, and the agent itself fetched a Cloudflare-protected page through the gateway (F1).

## What Shipped

- **Allow-all consumer allowlist** — committed `0ebe2d0`, pushed to `main`. Bare `*` is now an
  allow-all sentinel in `src/policy/allowlist.ts`, distinct from the `*.domain` wildcard. The scheme
  gate and egress SSRF filter still run **before** the allowlist in `PolicyEngine.guardFor`, so
  allow-all widens only the host gate — private/internal/metadata IP literals stay blocked even for a
  `*` consumer. +3 unit tests (68 total, all green), image rebuilt, re-proofed.
- **Production cutover** — executed you-run / I-guide (the auto-mode classifier blocks the agent
  writing/exec'ing on the prod host). Run model: **rootless Docker** for the agent user, with cgroup
  cpu/memory/pids delegation so `--cpus`/`--memory` actually bind. Per-container caps
  **`--cpus=1.25 --memory=1536m --shm-size=512m --pids-limit=512`**, validated under load. All
  fleet-specific detail (paths, service names, launcher/env, registry steps, rollback) is in the
  gitignored **`CUTOVER.local.md`**, now marked landed.
- **Verified** — stealth kill-gate **3/3 Cloudflare + 3/3 DataDome** from the prod IP through the
  rootless network stack; the capped MCP retrieve path (CF round-trip, no OOM); a clean standalone
  launcher boot; and **F1**: the consumer agent called `retrieve` and got real content from a
  CF-protected site.

## Decisions Made

- **Allowlist = allow-all** ("browse anything I send it"). Not expressible in the old config, so it
  needed the one-line sentinel + image rebuild. Egress SSRF stays independent and on.
- **Shipped without a residential proxy** (escalation off). The stealth core clears CF/DataDome
  stealth-alone from the prod IP, so this works for most targets; see the findings for the limit.
- **Caps lowered from 1.5 CPU / 1.5 GB → 1.25 / 1.5 GB / 512 MB shm** after discovering **two**
  agent runtimes each spawn their own container (size for 2 concurrent on a 2-core box), plus a
  `--shm-size`-vs-`--memory` OOM interaction the original uncapped proofs never exercised.

## Findings (v1.1 candidates — none cutover-blocking)

Captured in memory `retrieve-403-and-proxy-gaps`:
1. A bare **403 is an IP/WAF block, not a CF challenge** — the stealth core can't clear it. Hammering
   one CF target from the prod **datacenter IP** got it 403'd (reproduced by the in-container proof);
   a non-hammered target cleared fine, and it recovers on cooldown. This is the concrete argument for
   the deferred **residential proxy** (clean per-request IP reputation, which the prior cloud vendor
   provided).
2. **`retrieve` returns a 403 page as content** (`isError=false`, `markdown="Forbidden"`) instead of
   flagging `blocked` — block detection keys on a CF challenge phrase, not a 4xx/thin body.
3. **Scoped-proxy escalation misses reputation 403s** — it fires only on a CF managed-challenge phrase,
   so even with proxy creds wired it wouldn't route around an IP block. Needs always-on proxy or
   escalate-on-hard-block.

## What's Next

1. **U7** — capped-deploy tuning vs measured headroom, observability/retention, and the network-layer
   (NET_ADMIN) egress sidecar that closes the DNS-rebind / IP-resolved-egress gap.
2. **v1.1** — CAPTCHA solve+inject; `retrieve` 403/thin-as-blocked; proxy escalate-on-hard-block (or
   always-on residential proxy); decide whether to point the agent at `retrieve` over its built-in
   browser for fetch tasks (see gotcha below).

_Repo state: `main` is pushed and tree-clean; no open PRs. Both this session's commits
(`0ebe2d0` allow-all, plus this handoff) are on `origin/main`._

## Gotchas & Watch-outs

- **PUBLIC repo. Never commit fleet detail** (host / agent / path / prior-vendor names) in source,
  comments, commit messages, filenames, or fixtures — including this file. Fleet specifics live in the
  gitignored `CUTOVER.local.md` / `CONTEXT.local.md`. Pre-push scrub-grep, gated on its exit status.
- **The agent has its own built-in browser** (`browser_navigate`/`snapshot`/`console`) separate from
  this gateway, and it is NOT stealth — it defaulted to that first in F1 and got `Forbidden`. The
  gateway's `retrieve` is fetch-to-markdown only (no interactive driving). Making the agent prefer
  `retrieve` for protected fetches (vs its built-in browser) is an open behavioral item.
- **Stealth gate envs:** `BGW_ATTEMPTS=1` alone false-FAILs the gate — `BGW_REQUIRED` defaults to 3,
  so a 1-attempt run reports FAIL despite clearing. Set **both** `-e BGW_ATTEMPTS=1 -e BGW_REQUIRED=1`
  for a quick confirm; `3/3` is the real bar. (Memory: `stealth-gate-attempts-required`.)
- **IP reputation is real** — don't hammer one CF target from the prod IP; it 403s and the stealth
  core can't recover it. Cooldown or a fresh target.
- In-container proofs need the rootless daemon on prod (or colima+Rosetta locally, `--platform
  linux/amd64 --init --shm-size`). The registry's `mcp add` is interactive — needs a TTY.
