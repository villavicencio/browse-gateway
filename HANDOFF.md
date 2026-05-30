# HANDOFF — 2026-05-30, midday PT

Picked up the open v1-foundation PR, ran a max-effort code review of the U1–U6 stealth-core →
MCP surface, fixed the findings, verified everything in-container, merged the PR to `main`,
then did the U6 production-cutover recon and produced an execution-ready cutover runbook. The
local foundation is now reviewed, verified, and on `main`; remaining work is the production
cutover (kept in a gitignored local runbook) and U7.

## What We Built

- **Merged [PR #1](https://github.com/villavicencio/browse-gateway/pull/1)** — `browse-gateway v1
  foundation (U1–U6) + review fixes + MCP e2e proof` → `main` as merge commit `972e2a0`
  (history preserved). **65 unit tests + 4 in-container proofs** (stealth / policy / retrieve /
  mcp) all green on amd64 (colima + Rosetta).
- **Code-review fix commit `e69644d`** — addressed 12 of 15 findings from a max-effort review:
  - **Egress SSRF** — rewrote `src/security/egress.ts` on `node:net.BlockList` + a new shared
    `src/security/url.ts` `canonicalizeHost`. Closed the IPv4-mapped-IPv6 bypass
    (`[::ffff:169.254.169.254]` → hex form evaded the old dotted-decimal regex), the trailing-dot
    FQDN bypass, and the over-block of real hosts starting `fc/fd/fe`.
  - **Scheme allowlist** — reject non-http(s) URLs (`file:`/`data:`/`blob:`…) in `retrieve()` and
    the policy guard via `isHttpUrl` (prevents `file://` local-file/secret reads).
  - **Secret redaction wired into the live path** — `src/mcp/main.ts` now uses `RedactingAuditSink`
    over a bounded `InMemoryAuditSink` and redacts thrown error messages; `redactSecrets` also
    scrubs the URL-encoded form.
  - **Content-length/poll** — `isCleared(minTextLength)` so a short page doesn't poll to the full
    clearance timeout (the kill-gate keeps its strong-content bar); `retrieve().blocked` keys on a
    visible block phrase, not thin content; `render()` serializes full HTML once per render, not
    per poll iteration.
  - misc — strict-int parse for the max-sessions env; CF signatures single-sourced in
    `detect.ts`; `setNavigationGuard` swaps routes with no unguarded window; honest CAPTCHA /
    `BrowserCore` contract docs.
- **MCP e2e proof commit `4188e93`** — `scripts/validate-mcp.mjs` drives the real stdio launcher
  over the MCP protocol (tool exposed, allowlisted CF target → markdown, off-allowlist refused,
  `file://` rejected). Also fixed an off-allowlist/failed navigation returning the browser error
  page as "content": `src/mcp/server.ts` now treats a null-status + thin-content result as a
  failed retrieve (`isError`), while a short-but-valid page (real status) is still returned.
- **U6 cutover recon + runbook** — `CUTOVER.local.md` (gitignored): full read-only recon of the
  production host + agent runtime, the run-model decision, and an execution-ready cutover
  checklist with copy-paste launcher + env template.

## Decisions Made

- **Kept the kill-gate clearance behavior byte-for-byte** — `isCleared` gained an optional
  `minTextLength` (default = the strong-content bar) so ONLY `retrieve` opts into fast-clear, and
  it passes `MIN_CONTENT_LENGTH` (not `0`, to avoid a CF-mid-reload false-clear). Confirmed
  in-container the GO/NO-GO verdict didn't move.
- **Deferred 3 of 15 findings** (in the commit body + runbook): DNS-rebind egress → the
  network-layer filter (U7); CAPTCHA solve+inject → v1.1 (needs the page handle in the core);
  core-fails-closed-by-default → follow-up. The deep core-default-deny would force request
  interception into the stealth path, which can't be verified without re-running the IP-sensitive
  gate — so only the safe part (guard-swap gap + honest docs) shipped.
- **Merged with a merge commit, not squash** — preserves the foundation → review → proof trail.
- **Production run model: rootless docker** for the agent user (chosen over docker-group or a
  bare-node process) — keeps the container caps + hardening that contain a heavy local-Chrome MCP
  on a resource-constrained shared host, without a root-equivalent grant. Full reasoning + the
  rootless prereqs (uidmap, cgroup-cpu delegation, lingering) are in `CUTOVER.local.md`.

## What Didn't Work

- The cutover's original path assumptions (from private notes) were wrong — the assumed launcher
  directory and registry file don't exist; the agent runtime uses a different home, a YAML
  registry, and npx-spawned MCP subprocesses. Read-only recon corrected all of it (captured in
  `CUTOVER.local.md`).
- The agent user has no docker access, so the container launcher can't drop into the existing
  MCP-launcher pattern as-is — this drove the rootless-docker decision.
- **Mobile remote control does not execute the inline `!` bash prefix** (it sends the text as a
  plain message), and `/permissions` is unavailable there. Switched to **default permission mode**
  to approve commands per-prompt — that also cleared the auto-mode classifier block on reading the
  agent runtime's config during recon.

## What's Next

1. **Execute the U6 production cutover** — open `CUTOVER.local.md` and run Phase 1 onward **at a
   keyboard** (root-level mutations on a live-agent host; verify agent health between steps). The
   one open input is **`[DECISION B]` — the consumer's allowlist** (which domains the consumer
   agent may retrieve); decide it before the register/cutover phase.
2. **U7** — capped-deploy tuning vs measured headroom, observability/retention, and the
   network-layer egress filter (covers the deferred DNS-rebind finding).
3. **v1.1** — CAPTCHA solve+inject; core-fails-closed-by-default.
- **Soft deadline:** the external managed-browser dependency downgrades **2026-06-07** — the
  cutover should land before then.

## Gotchas & Watch-outs

- **PUBLIC repo. Never commit fleet detail** (production host / agent / path / prior-vendor names)
  in source, comments, commit messages, filenames, or test fixtures — including this file. All
  deployment specifics live in `CUTOVER.local.md` / `CONTEXT.local.md` (gitignored). Pre-push
  scrub-grep, gated on its exit status.
- **`CUTOVER.local.md` is the live cutover artifact** (gitignored). It holds the recon results,
  the rootless decision, and the copy-paste launcher/env — read it first when resuming the cutover.
- **The production cutover mutates a live-agent host** (root-level systemd/cgroup changes + a
  registry swap + an agent reload). Keyboard-only, with health checks between steps; do not drive
  it blind from mobile.
- **In-container proofs need Docker** — colima + Rosetta on this Mac; build/run `--platform
  linux/amd64`, `--init`, `--shm-size=1g`. The kill-gate is IP-reputation-sensitive — run with
  reduced attempts (`BGW_ATTEMPTS=1`) when just confirming a change.
- **`noUncheckedIndexedAccess` is on**; ESM + `verbatimModuleSyntax` — use `import type` for
  type-only imports. Validate scripts are `.mjs` importing from `dist/` (need a build first).
- **`docs/solutions/` holds the xvfb-run-PID1 learning**; the review/cutover learnings live in the
  merged commit bodies and `CUTOVER.local.md`.
