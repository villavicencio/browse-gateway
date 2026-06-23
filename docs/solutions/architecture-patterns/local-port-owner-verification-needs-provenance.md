---
title: "Verifying a local forwarded port is OURS needs process provenance, not just argv shape"
module: cli/tunnel
date: 2026-06-22
problem_type: security_design
component: tunnel-ownership
severity: high
symptoms:
  - "`obscura connect`/`status` must confirm 127.0.0.1:8080 is held by OUR ssh tunnel before registering a consumer bearer token against it"
  - "a listener that merely 'looks like' our tunnel was classified `ours`, so connect would register the token against a forward it doesn't control"
root_cause: trusting_forgeable_signals
resolution_type: defense_in_depth
related_components:
  - authentication
  - ssh-tunnel
tags: [tunnel, port-owner, provenance, uid, ssh, lsof, ps, fail-closed, spoofing, bearer-token]
---

# Verifying a local forwarded port is OURS needs provenance, not just argv

## The job
`classifyPortOwner` answers one question before `connect` registers a consumer's bearer token against
`http://127.0.0.1:<port>`: **is that port held by OUR ssh tunnel** (which forwards to our gateway), or
by some other process (which could forward the token to an attacker)? A wrong "ours" hands the token to
whatever that listener forwards to.

## Why the obvious checks are all insufficient (each was a real P1)
The keeper runs exactly `ssh -N -T -L <localPort>:<gatewayHost> <alias>`. Successive "tighten the
check" attempts each missed a forgeable signal:

1. **`COMMAND == "ssh"`** (lsof) — any `ssh -L <port>:…` shows `COMMAND=ssh`. A foreign forward passes.
2. **alias appears anywhere in argv** — `ssh -l <alias> -L <port>:evil attacker@host` puts the alias in
   the `-l` *value* while dialing the attacker. Must validate the alias is the **destination operand**.
3. **alias IS the destination operand** — `ssh -o HostName=attacker -L <port>:… <alias>` (also `-F`,
   `-J`) **overrides where the alias resolves**. The operand is our alias; the connection isn't ours.
   Fix: **allowlist** the keeper's exact flags (`-N`/`-T`/`-L` only), don't blocklist redirecting ones.
4. **argv shape allowlisted** — a **foreign local account** runs the byte-for-byte keeper argv using
   **its own `~/.ssh/config`**, where the alias resolves to an attacker host. argv is identical; only
   the *owner* differs. This is the one that proves argv shape can never be sufficient.

## The fix: provenance + shape, all hard, fail closed
argv describes *intent*, which is forgeable. Ownership is the real boundary. `classifyPortOwner` now
requires EVERY listener to clear all of:

- **UID == the current user** — resolved from `ps -o uid=`, not lsof's `USER` name. A different
  account's listener is never ours. (A *same-UID* attacker already controls our `~/.ssh/config`, so no
  client-side check can defend that case — and it's definitionally out of scope.)
- **descends from OUR keeper** — the listener's parent command (`ps -o ppid=` → `ps -o command=`)
  references `spec.keeperPath`. Rejects a same-user process with a clean config and the right argv.
- **the keeper's allowlisted argv shape** — only `-N`/`-T`/`-L`, our local forward port, our alias as
  the destination operand. Defense in depth on top of provenance.

Anything unconfirmable (non-ssh, foreign UID, foreign/absent parent, wrong forward, unresolvable argv)
makes the whole port `foreign` → `connect` refuses. The pure classifier takes the enriched listeners +
the expected UID; the impure `tunnelState` gathers `ps` data and passes `process.getuid()`.

## Transferable lessons
- **A process's self-reported argv is attacker-controlled; its UID and parentage are not.** When a
  decision grants trust (here: where a bearer token is sent), key on provenance, not on what the
  process *says* it is doing.
- **Allowlist the expected shape, don't blocklist bad options** — a blocklist misses the next
  redirecting flag (`-o`/`-F`/`-J`/…).
- **lsof's `USER` is a display name; prefer the numeric UID from `ps`** for an identity comparison.
- **Fail closed:** an unresolvable `ps`/parent lookup is "not ours," never "assume ours."

## Known residual (accepted, out of scope)
This is a check-then-use, so a TOCTOU between classification and `connect`'s registration is
theoretically possible; closing it needs the port handed off atomically — a larger change.

## See also
- `docs/solutions/architecture-patterns/interactive-drive-verbs-over-policy-guard.md` — the broader
  "trust the enforcement boundary, not the caller" posture.
- Landed across PR #26 (three review rounds): argv-operand → flag-allowlist → UID+keeper-ancestry.
