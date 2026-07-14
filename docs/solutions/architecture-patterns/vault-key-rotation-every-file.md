---
title: Vault key rotation must rewrite every enumerated file, leaving no old-key ciphertext
date: 2026-07-14
category: docs/solutions/architecture-patterns
module: security/vault-store
problem_type: architecture_pattern
component: vault
severity: high
applies_when:
  - "Rotating the key of an at-rest encrypted store where the goal is that NO ciphertext remains decryptable under the retired key"
  - "The store is file-per-slot and the writer computes a canonical on-disk path from the slot identity"
  - "Rotation can be interrupted (crash, kill) and must be safe to resume"
related_components:
  - encryption
  - key-management
  - secrets
tags: [vault, key-rotation, encryption-at-rest, envelope-encryption, aad, resumable, canonical-path]
---

# Vault key rotation must rewrite every enumerated file, leaving no old-key ciphertext

## Context

The credential vault seals each entry with envelope encryption (a KEK wraps a per-entry DEK) and
supports key rotation. The security guarantee rotation is supposed to deliver is total: *after
rotation, no ciphertext on disk decrypts under the retired key.* A Fable-audit finding showed the
first-cut `rotateVaultKey` delivered only *"most"* — it re-encrypted the store's **logical slots**
(recomputing each canonical path and re-sealing it), which silently skips any file that isn't sitting
at its canonical path. Those skipped files are exactly the anomalous ones a bug or an attacker would
produce, and each one survives under the old key.

## Guidance

**Rotate over the enumerated files on disk, not the logical slots.** `put()` writes a canonical path
derived from `(consumerId, host)` via `slotFileName(dir, consumerId, canonicalHost)`. If rotation
walks logical slots and recomputes canonical paths, a file that is *present but non-canonical* is
never visited. Instead, enumerate the directory's real dirents and re-encrypt each file you actually
find — then validate that each file *is* what a canonical write would have produced.

**Close every old-key-survival path.** Four distinct ways a ciphertext survived the naive
logical-slot rotation, each closed with a per-file guard during the enumeration:

1. **Copied non-canonical filename** — a slot file duplicated under a different name. Reject any file
   whose name is not `slotFileName(dir, consumerId, host)` for its own decrypted identity.
2. **Non-canonical stored host** — the host field *inside* the record not equal to its canonical
   form. Reject `canonicalizeHost(host) !== host` (defined in `src/security/url.ts`).
3. **Symlink / hard-link alias** — a link pointing at an out-of-tree or shared inode. `lstatSync`
   each entry and reject symlinks, `nlink > 1`, and non-regular files. (Following a symlink would
   rotate another owner's bytes out from under them; a hard-link alias would leave a second name
   unrotated.)
4. **Orphaned temp file** — a `*.vault.json.<hex>.tmp` leftover from an interrupted prior write. It
   holds old-key ciphertext that no canonical enumeration covers. Reject its presence before
   rotating.

**Make rotation resumable: decrypt-under-either-key.** An interruption mid-rotation leaves the
directory mixed — some files under the new key, some still under the old. On resume, try the **new**
key first, then fall back to the **old** key, and re-seal under the new. A crashed rotation is then
re-runnable to completion instead of half-bricking the store. Also reject `oldKek.equals(newKek)` so
a no-op "rotation" cannot falsely report success.

**Keep the AAD injective (a slot-binding aside).** Each entry's AAD encodes `(consumerId, host)` with
a length-prefixed encoding so it binds ciphertext to its slot. If a slot field can round-trip
*lossily* — a lone surrogate collapses under `Buffer.from(v, "utf8").toString("utf8")` — two distinct
slots can produce the *same* AAD, which lets one slot's ciphertext open in another's context.
`assertSlotField` rejects ill-formed Unicode at ingress so the AAD encoding stays injective. This is
the same "validate at the ingress so the downstream invariant holds" move as the redaction ingress
guard.

**State the boundary: offline / exclusive access.** Rotation enumerates and then rewrites; it takes
no lock and assumes no concurrent writer. That contract is deliberate — run rotation with exclusive
access to the vault directory, not against a live store. Documenting it is part of the fix, not a gap.

## Why This Matters

"No ciphertext remains decryptable under the retired key" is the *entire* point of rotation. A
logical-slot rotation quietly downgrades that to "most ciphertext," and the survivors — copies,
aliases, non-canonical hosts, temp orphans — are precisely the files that anomalous conditions
create. Enumerate-and-rewrite over real dirents, gated by per-file canonical-path / `lstat` / host
guards and made resumable by decrypt-under-either-key, is what upgrades *most* back to *every*.

## When to Apply

- Any envelope-encryption store with a file-per-entry layout and a key-rotation operation.
- Any at-rest store where retiring a key must be total, not best-effort.
- Any rotation that can be interrupted and therefore must be safe to re-run.

## Examples

The survival-path checklist, run per enumerated file before it is trusted:

```
for each dirent in vaultDir:
  reject if lstat says symlink / nlink > 1 / not a regular file      # alias
  reject if name matches /\.vault\.json\.[0-9a-f]+\.tmp$/            # orphaned temp
  record = decrypt(file, newKek)  ?? decrypt(file, oldKek)           # resumable
  reject if canonicalizeHost(record.host) !== record.host           # non-canonical host
  reject if basename(file) !== slotFileName(dir, consumerId, host)  # copied/renamed
  reseal(record, newKek) -> write canonical path
```

Guard the whole operation up front:

```ts
if (oldKek.equals(newKek)) throw new Error("rotate: old and new key are identical (no-op)");
```

## Related

- `docs/solutions/architecture-patterns/vault-observability-redaction-gap.md` — the vault's
  redaction-coverage map (a different vault invariant from the same threat model).
- `docs/solutions/best-practices/redact-before-serialize.md` — the same audit's secret-redaction
  sibling; both share the "enforce the invariant at the ingress, not the sink" shape
  (`assertSlotField` here, `addRedactableCredential` there).
