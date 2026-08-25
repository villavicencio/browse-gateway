# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with
project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and
ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Deploying the gateway

### Deploy swap
The staged replacement of the running gateway container with one built from a newer image. The
sequence is fixed and each stage is non-bypassable: resolve the requested tag to an immutable
registry digest, run the Gate against that digest, run the Pre-swap smoke against the real on-host
configuration, record the Rollback anchor, replace the container, then verify the replacement
answers healthy. A failure before the replacement leaves the live container untouched; a failure
after it returns the gateway to the Rollback anchor automatically.

### Gate
A check that must pass before the thing it guards proceeds, and that is trusted only once it has
been observed reporting failure by construction. A gate that cannot express the failure it exists to
catch is documentation rather than verification. Gates here run against the real runtime rather than
a simulated one, because the failures they guard against appear only there.

### Pre-swap smoke
A boot of the exact configuration the live container is about to read — real environment and real
consumer manifest — on a throwaway container and port, asserting it comes up clean before anything
touches the live container. It catches the failure class the Gate cannot: a malformed setting or a
manifest that violates a startup assertion, which would otherwise pass an image-level check, go
live, fail verification, and take the automatic rollback down with it. It is shared by the Deploy
swap and the Apply path, which differ only in which image they hand it.

### Rollback anchor
The identity of the image the gateway was running immediately before a Deploy swap, captured so an
automatic rollback has a fixed target rather than a moving tag. It is recorded as the container's
image ID, which is a different identifier from the registry manifest digest the swap pins — see
Flagged ambiguities.

### Apply path
Re-creating the gateway container so it picks up a changed environment or consumer manifest, without
changing the image. A restart cannot serve this purpose: a container's environment is frozen when the
container is created, so a restart replays the stale environment while re-reading mounted files,
producing a mismatch that can trip the startup assertions and crash-loop every consumer at once.
Because the image is deliberately held constant on this path, it hands the Pre-swap smoke the
currently-running image rather than a new one.

## Consumers and the session pool

### Consumer
A named client authorized to use the gateway, holding its own credential and its own allowlist of
hosts it may reach. Consumers are enumerated in a manifest the gateway reads at startup; a manifest
entry without a matching credential is refused loudly at boot rather than served unauthenticated.

### Session pool
The bounded set of concurrent browser sessions the gateway will run at once. It is bounded because
each session is a full headful browser, so capacity is limited by the host's memory rather than by
policy. Sessions are admitted against both a global ceiling and a per-consumer allowance, so one
consumer cannot starve the others.

### Pool floor
The minimum global capacity a configuration must declare to be servable: one slot for every
consumer's per-consumer allowance, plus one held back so single-shot retrieval can still proceed
while drive sessions are held.

The floor is enforced fail-closed at startup — a configuration below it aborts the boot rather than
starting degraded. This is correct but blunt: because the check runs at startup and the container is
configured to restart, an undersized configuration crash-loops, which takes down every consumer
rather than only the one whose addition breached the floor. Adding a consumer therefore changes the
floor, and is a capacity decision rather than a routine provisioning step.

## Flagged ambiguities

- A container's **image ID** and a registry **manifest digest** are both rendered as `sha256:` hex
  and had been read as interchangeable. They are distinct identifiers computed over different inputs
  and are never equal for the same image, so a mismatch between them is structural and carries no
  information about what is deployed.
