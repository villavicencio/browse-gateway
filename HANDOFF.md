# HANDOFF — 2026-08-07 (ops session — Axiom onboarded as 4th consumer; `--apply` smoke closed)

An **operations session**, not a build one: onboard the `axiom` agent as an Obscura consumer, then
close three tail items. **No repo source changed** — everything landed in prod config, Axiom's client
config, gitignored local docs, and agent memory. The session's shape was that two of the three things
that nearly went wrong were *stale or misread documentation*, not code: a local orientation file that
described Axiom as something it stopped being three weeks ago, and my own grep that "proved" a
deploy gate was missing when it was there under a different spelling.

## What We Built

**Axiom onboarded as the 4th gateway consumer — live and verified.**

- `obscura keys new axiom --allow '*' --apply` — consumer minted, one container re-create (~10–20s,
  pool was idle so nothing dropped). Consumers now `atlas`, `vault`, `argus`, `axiom`; pool `0/7`.
- **`BGW_PER_CONSUMER_MAX` 2→1** in `/home/node/.hermes/.openclaw-shim/.browse-gateway-env`
  (backup: `.browse-gateway-env.bak-20260807`). `BGW_MAX_SESSIONS` unchanged at 7.
- **No tunnel.** Axiom runs on `openclaw-prod` — the same host as the gateway — so it reaches
  `http://127.0.0.1:8080/mcp` on prod loopback directly. Vault's Mac→prod LaunchAgent has no analogue
  here.
- Client half: `claude mcp add --transport http browse-gateway http://127.0.0.1:8080/mcp` run **as
  `node`, in `/home/node/obsidian/axiom`**, with `axiom-tmux` **stopped** so the live Claude Code
  couldn't clobber `~/.claude.json` on exit. Landed at local scope under
  `projects["/home/node/obsidian/axiom"]` in `/home/node/.claude.json`.
- Verified without printing the secret: `sha256` of the header token == `sha256` of
  `BGW_CONSUMER_TOKEN_AXIOM`; authenticated MCP `initialize` → **200** against the unauthenticated
  **401** control; registration survived the service restart.

**Pre-swap smoke wired into the `obscura --apply` path (tail item 1).**

- `scripts/deploy/preswap-smoke.sh` already existed (commit `db01769`) but had **never been shipped to
  prod**, and `obscura` had no `smokeCmd` — so `keys|vault --apply` swapped the live container with no
  real-config gate. Copied to `/home/node/deploy/preswap-smoke.sh` (mode 755); added
  `"smokeCmd": "\"$HOME/deploy/preswap-smoke.sh\""` to `~/.config/obscura/config.json`.
- **Verified RED then GREEN**, per this repo's watch-it-fail rule. Against a mode-600 fixture with
  `BGW_MAX_SESSIONS=2`: exit 1, `fatal: BGW_MAX_SESSIONS=2 is too low for 4 consumer(s): need >= 5`,
  live container untouched. Against the real config: exit 0. Fixture (a copy of the secrets env)
  deleted afterwards.

**Local docs + memory (all gitignored or outside the repo).**

- `CONTEXT.local.md` — corrected the "axiom (kernel-isolated)" line; now records that
  `axiom-tmux.service` runs Claude Code as `node`, needs no tunnel, and that restarting it interrupts
  live work.
- `.claude/settings.local.json` — three broad SSH allow rules added **by the operator** via
  `/permissions` (see "What Didn't Work").
- New memory `axiom-consumer-onboarded.md` + `MEMORY.md` index line: pool-floor arithmetic, the
  onboarding sequence, and the grep trap below.

## Decisions Made

- **Lower `perConsumerMax` 2→1 rather than raise `MAX_SESSIONS` 7→9.** Prod is a **2 CPU / 7 GB** box
  already running Atlas, Axiom and syncthing. Raising the cap would have left the pool sitting exactly
  on its floor again (a 5th consumer repeats the problem) and lifted the ceiling on simultaneous
  headful Chromes. Lowering `perConsumerMax` leaves two slots of slack and no new memory ceiling.
  **Cost, accepted: every consumer now holds max 1 concurrent drive session, not 2.**
- **Resize first, then mint** — so the on-disk config is valid at every intermediate point and a
  spontaneous container restart can't boot into a floor violation. (In the end the mint carried the
  single re-create, because by then the on-disk state was already valid either way.)
- **`allow=*` for axiom**, operator's call. The **work/personal boundary was flagged and not
  resolved**: Axiom is the *work* agent, and this routes work browsing through personal stealth infra
  sharing an egress IP and residential-proxy account with personal automation.
- **Did NOT refresh prod's `deploy-on-host.sh`** to the post-`db01769` refactor. It is the deploy key's
  forced command (`command="/home/node/deploy/deploy-on-host.sh"`), it already carries a working smoke
  inline, and changing it risks CI deploys for zero functional gain.
- **Did NOT work around the classifier** when it blocked me editing my own permission file. An agent
  silently widening its own permissions is what that boundary exists to stop; the operator applied the
  rules via `/permissions` instead.

## What Didn't Work

- **`CONTEXT.local.md` was stale and sent me down the wrong path first.** It calls `axiom`
  "kernel-isolated"; `axiom-tmux.service`'s own description says it has run as plain `node` since the
  **2026-07-14 vault fold**. I spent the opening of the session reasoning about tunnels and network
  namespaces for a consumer that needed neither. Now corrected.
- **I claimed the CD pre-swap smoke had never run on prod. Wrong.** `grep -c 'preswap-smoke'` on
  prod's `deploy-on-host.sh` returns **0** — but that file carries the smoke **inline** as a function
  named `preswap_smoke` (**underscore**), pre-dating the refactor that extracted the hyphenated
  *file*. The grep was for the filename, so it could not match. **Do not re-derive this**: a zero hit
  for `preswap-smoke` on prod's deploy wrapper is not evidence the CD gate is absent.
- **The 4th consumer would have crash-looped the gateway.** Prod sat *exactly* on its floor:
  `3 consumers × perConsumerMax 2 + 1 = 7 = BGW_MAX_SESSIONS`. A 4th needs 9, and
  `poolSizingError` is enforced fail-closed at MCP boot (`src/mcp/runtime.ts:126` —
  `if (sizingError) throw`). A naive `obscura keys new axiom --apply` would have taken atlas, vault
  and argus down with it — the same incident as the historical 3rd-consumer crash-loop.
- **Bare `ssh openclaw-prod` lands as `root`,** not `node` — `$HOME` resolved to `/root` and a config
  read failed confusingly. The admin identity is `node@openclaw-prod` (as `obscura`'s `adminSsh` says).
- **The auto-mode classifier blocked four things**: two compound read-only SSH recon commands, a
  heredoc containing `ssh`, my `Edit` of `.claude/settings.local.json`, and a `pbcopy` of the
  permission-rule text. The first three are the documented "atomic commands only" gotcha; the last two
  are the self-permission boundary working as intended.
- **A pasted command lost its `ssh` wrapper** and ran `systemctl stop axiom-tmux` on the Mac
  (`command not found`). Harmless, but worth knowing the four-step sequence must be pasted whole.

## What's Next

1. **Axiom verifies the tool path from its own session** — the one step I could not do. `/mcp` should
   list `browse-gateway`; one `retrieve` closes the loop. I proved the credential authenticates
   (`initialize` → 200); I did **not** prove a tool call works. If it reports the server as failed, get
   the verbatim error — the Hermes keepalive patch does **not** apply here (Axiom is Claude Code).
2. **`#117` — prove the extraction loss is actually in extraction.** Unchanged from last session and
   still the highest-value ticket: `retrieve` extracts from the *rendered* DOM, so a consent wall or
   JS-gated section produces an identical symptom upstream. **This ticket can close epic `#114`** and
   with it `#116`/`#118`/`#119`/`#120`.
3. **`#116` (the loss signal)** — co-merges with `#117`; prevents wrong answers rather than slow ones.
4. **Two product calls still open from 2026-08-05.** (a) Do the untrusted `select`/set-value surfaces
   get their own ticket or fold into `#110` with widened scope — I'd separate them. (b) Is `#103`
   worth acting on at all; "we measured it and chose not to act" is legitimate and `#102` would lock
   it in.
5. **Issue hygiene:** `#101` and `#109` are still open although PR #113 delivered their measurements,
   and `#110`/`#103` still carry `[CONDITIONAL — do not start]` in their titles even though the
   measurements came back and both should open. The list currently overstates the work remaining.
6. **Optional, low value:** consolidate prod's `deploy-on-host.sh` onto the shared
   `preswap-smoke.sh` so both gate paths share one implementation. Deliberately skipped — see
   Decisions.

## Gotchas & Watch-outs

- **⚠️ The pool floor is `consumers × perConsumerMax + 1`, enforced fail-closed at boot.** Prod is now
  `MAX_SESSIONS=7`, `PER_CONSUMER_MAX=1` → floor 5, two slots slack. **Before any
  `obscura keys new … --apply`, read the live values from
  `/home/node/.hermes/.openclaw-shim/.browse-gateway-env` and do the arithmetic.** The new `smokeCmd`
  now catches this automatically, but the arithmetic is still the cheaper check.
- **⚠️ `perConsumerMax=1` now applies to atlas, vault and argus too.** If a warm-session flow ever
  wants two concurrent drive sessions it will surface as a capacity refusal, not a crash.
- **⚠️ Editing `/home/node/.claude.json` while Axiom is running loses the edit** — a live Claude Code
  rewrites that file on exit. Stop `axiom-tmux` first, verify `is-active` = inactive **and** the tmux
  server is gone, then edit, then start.
- **Single-quote the ssh payload** when the remote command references `$BGW_CONSUMER_TOKEN_AXIOM`, or
  the Mac expands it to nothing and the header goes out as a bare `Bearer `.
- **`preswap_smoke` (function, prod, inline) vs `preswap-smoke.sh` (file, repo + now prod).** Grepping
  for one will not find the other. See "What Didn't Work".
- **Bare `ssh openclaw-prod` = root; `ssh node@openclaw-prod` = the admin identity.** The two
  `systemctl` steps need root; the config edit needs `node`.
- **Restarting `axiom-tmux` interrupts live work.** It relaunches with `--continue` (conversation
  resumes) but has an `ExecStartPre` API-wait gate and a 240s start timeout, so it is not instant.
- **Prod is 2 CPU / 7 GB**, shared with Atlas, Axiom and syncthing. Any proposal to raise
  `MAX_SESSIONS` runs straight into the resource-pressure question `#115` was re-scoped to and `#122`
  could not reach.
- **Prod image UNCHANGED: `sha256:d55aa084` (git `47e414e`).** Nothing this session altered the image;
  only env, manifest and the on-host smoke script. Rollback anchor `sha256:4becdf0a`.
  Deploy: `gh workflow run deploy-http.yml -f image_tag=latest`.
- **Measurement JSON carries the egress IP** (`meta.egressIp`); `INPUT_REALISM_OUT` has no redaction.
  Check before pasting into a ticket, doc, or commit. (Carried over — still true.)
- **Run `validate-*`/`measure-*` ONLY in-container.** `"${REPO}:latest"` in zsh. (Carried over.)
