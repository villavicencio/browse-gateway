---
title: Redact secrets before serialization, over the actual values, at the credential ingress
date: 2026-07-14
category: docs/solutions/best-practices
module: security/secrets
problem_type: best_practice
component: redaction
severity: medium
applies_when:
  - "A secret value can reach an error message, log line, audit record, or serialized payload"
  - "You are tempted to pass a `redact: (s) => string` function across a module boundary"
  - "A component assembles a credential from parts (base + per-call suffix, username + token)"
related_components:
  - observability
  - browser-core
  - vault
tags: [secrets, redaction, serialization, secret-store, browser-core, captcha, encoding]
---

# Redact secrets before serialization, over the actual values, at the credential ingress

## Context

Three findings from the Fable security audit (all originally rated Low/Info, all upgraded by
adversarial review to real reachable leak paths) converged on a single principle. `redactSecrets`
began life as a literal substring scrubber applied at the log/error sink, and each finding showed a
distinct way a secret walked straight past it. The fixes reframed redaction from *"scrub the sink"*
to *"own the value, and redact it before anything serializes it."* This doc is that discipline; the
companion `docs/solutions/architecture-patterns/vault-observability-redaction-gap.md` is the map of
which *surfaces* redaction is and isn't wired into.

## Guidance

**1. Redact before serialize, not after.** A literal `redactSecrets(text, store)` can only match the
exact byte sequence it was handed. The same secret appears in many serializations — raw,
URL-encoded, JSON-string-escaped, `util.inspect`-escaped — and each is a different byte sequence.
Two moves close this: (a) fold *every known encoding* of each value into the redaction set
(`redactSecrets` now folds the JSON.stringify- and `util.inspect`-escaped variants alongside raw +
URL-encoded), and (b) apply redaction to the *raw value* before a serializer ever transforms it,
rather than trying to catch it downstream.

**2. Union single-pass over actual values — never compose opaque redactors.** Passing an opaque
`redact: (s) => string` down into a sub-component fragments secrets in *both* directions: the child's
redactor doesn't know the parent's secrets, and the parent's doesn't know the child's. A value that
straddles the boundary — proxy credentials assembled from a base plus a per-call sticky suffix — gets
half-scrubbed by each side and reassembled in the clear. The fix is to pass the actual value set, not
a function: a structural `{ redactableValues(): readonly string[] }`, and union caller secrets +
component-local secrets (e.g. validated proxy creds) into **one** `redactSecrets` pass.
`resolveCoreRedactor(opts)` in `src/browser/patchright-core.ts` does exactly this, and
`BrowserCoreOptions.secrets` replaced the old opaque `redact` field.

**3. Enforce redactability at the credential ingress, not at the sink.** A value shorter than a few
characters, or one equal to a redaction marker, cannot be safely substring-redacted — it would
over-redact unrelated text or is meaningless as a needle. Reject those where the credential *enters*
the system (`addRedactableCredential` rejects length `<3` and reserved markers; `reload()` rejects an
unredactable typed secret), so the sink can assume every registered value is safe to scrub. Keep a
permissive sibling (`addRedactable`) for non-credential *fragments* — sticky-suffix pieces, short
usernames — that are folded into the set but not individually guaranteed redactable on their own.

**4. Use `String.replaceAll(value, marker)`, not `new RegExp(escapeRegExp(value))`.** Compiling a
large folded value into a `RegExp` throws V8's "regular expression too large" **at execution time**
(not construction), and every call re-compiles the pattern. Literal `replaceAll` is linear,
allocation-light, and cannot throw on input size.

**5. The browser core takes the store, not a function.** `BrowserCoreOptions.secrets?:
{ redactableValues(): readonly string[] }` is a *structural* type, so any SecretStore-shaped object
satisfies it with no hard dependency on the concrete class. `errCode(err, redact?)` redacts the full
message, strips URLs, then truncates; a CAPTCHA error sink allowlists a fixed
`CAPTCHA_SOLVE_ERROR_CODES` set (declared in the browser layer to avoid a verbs→browser import
cycle) so a solver failure surfaces a stable code instead of a raw provider message that might carry
the API key.

**6. Serialize with a descriptor-based sanitizer, never a getter-invoking one.** The smoke logger's
recursive `redactValue()` walks objects via `Object.getOwnPropertyDescriptor` (so it never *invokes*
a getter), reads the raw underlying value, redacts it *before* `JSON.stringify`, and bounds
depth/breadth with a cycle guard. Serializing an error object then can't trigger a side-effecting
getter or emit an un-redacted nested field.

## Why This Matters

Secrets rarely leak through the path you hardened; they leak through the serialization you forgot.
Each of these was Low/Info on first read and a real reachable leak on the second. The
redact-before-serialize framing is what makes the covered set *enumerable* — raw, URL-encoded,
JSON-escaped, inspect-escaped — instead of an open-ended game of whack-a-mole at every new sink.

## When to Apply

- Any code path where a secret value could be rendered into an error, log, audit record, or
  outbound payload.
- Any time you would hand a `redact` function to a sub-component — pass the *value set* instead and
  union at the point of use.
- Any component that assembles a credential from parts, where no single side sees the whole secret.

## Examples

Opaque-redactor fragmentation (the bug) → union single-pass (the fix):

```ts
// BEFORE — each layer scrubs only what it knows; a base+suffix credential
// is reassembled in the clear because neither side holds the whole value.
core.launch({ redact: (s) => parentStore.redact(s) });   // child adds its own creds later

// AFTER — pass the values; union caller + component-local secrets in ONE pass.
core.launch({ secrets });                                // { redactableValues(): readonly string[] }
const redact = resolveCoreRedactor(opts);                // unions opts.secrets + validated proxy creds
throw new Error(redact(message));
```

Needle compilation (the throw) → literal replacement (the fix):

```ts
// BEFORE — throws V8 "regular expression too large" at execution on big folded values,
// and recompiles on every call.
out = out.replace(new RegExp(escapeRegExp(value), "g"), "[REDACTED]");

// AFTER — linear, allocation-light, cannot throw on input size.
out = out.replaceAll(value, "[REDACTED]");
```

## Related

- `docs/solutions/architecture-patterns/vault-observability-redaction-gap.md` — the coverage map:
  which surfaces redaction is wired into (logs, audit) and which it deliberately is not
  (rendered HTML, screenshots, egress bodies). This doc is the *discipline*; that one is the *scope*.
- `docs/solutions/architecture-patterns/vault-key-rotation-every-file.md` — the same audit's
  at-rest-crypto sibling; its `assertSlotField` ill-formed-Unicode guard is another "validate at the
  ingress so the downstream invariant holds" instance.
- Build-safety lesson banked from the same loop: verify a TypeScript build with `grep 'error TS'`,
  not `tail -1`. A stray `*/` inside a JSDoc comment closed the block early, and `tail -1` on the
  build output masked the compile error until adversarial review caught it.
