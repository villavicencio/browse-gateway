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

Only the lower bound of that ceiling is enforced. A declared capacity below the Pool floor aborts the
boot, but nothing derives an upper bound from the host's actual memory, so a ceiling larger than the
hardware can hold starts cleanly and surfaces only as memory exhaustion once enough sessions are
genuinely concurrent. Sizing it is a measurement task rather than a configuration one, and the
measurement is only as trustworthy as the instrument used — summary container tooling reports a
number that includes more than the sessions themselves.

### Pool floor
The minimum global capacity a configuration must declare to be servable: one slot for every
consumer's per-consumer allowance, plus one held back so single-shot retrieval can still proceed
while drive sessions are held.

The floor is enforced fail-closed at startup — a configuration below it aborts the boot rather than
starting degraded. This is correct but blunt: because the check runs at startup and the container is
configured to restart, an undersized configuration crash-loops, which takes down every consumer
rather than only the one whose addition breached the floor. Adding a consumer therefore changes the
floor, and is a capacity decision rather than a routine provisioning step.

## Classifying a failed page

### Exit-clearable block
A block a **fresh residential exit could actually change** — the sole justification for spending one.
The gateway's escalation ladder exists because an IP/WAF *reputation* verdict (a thin `401`/`403`/`5xx`)
is a statement about the client's address: ask from a clean address and the site answers differently.

Not every thin error page is that. A `404` or `410` says the resource is absent, which is true from
every address; a `429` says this client is going too fast, which a new address either does not change
or changes only by evading a limit the site asked us to respect. These are still *blocks* — the page
failed, and the caller is told so — but they are outside the ladder, and re-rolling exits for one buys
nothing at the cost of a full residential session per attempt.

The distinction is a property of the **status**, not of the page body: a branded, vendor-marked error
page still `404`s from a clean exit. The one exception runs the other way — a managed challenge
(Cloudflare) arriving on any status is exit-clearable, because a clean address genuinely clears it.

### Decisive failure class
A failure class **a retry cannot change** — the failure-class mirror of Exit-clearable block. The test
is not "did the site tell us something", since almost every class carries some site signal; it is
whether a caller who acts on the label by asking again is *wrong to*. A rate limit, an interactive
CAPTCHA with no solver, and the gateway's own policy refusal all pass that test.

A reputation block and a WAF challenge deliberately do **not**, even though both are unambiguous site
verdicts: they are exactly what a clean exit clears, so for them "we ran out of time, try again" is the
more useful report, not a lost one. Across a multi-attempt re-roll the block the *last* attempt landed
on is incidental, while the budget overrun describes the whole call.

The distinction exists because these two kinds of verdict compete when a call also exhausts its
wall-clock budget. Letting exhaustion win unconditionally destroys the actionable half of the report —
a call that spent ninety seconds discovering an unsolvable CAPTCHA reported only a timeout, advising
the one thing that cannot work. So exhaustion overrides a non-decisive class and yields to a decisive
one, while remaining separately visible either way (see Budget exhaustion). Membership is explicit and
lives in one place; the property is not derivable from a class's name.

### Budget exhaustion
That a call consumed its whole wall-clock budget — carried as **evidence alongside** the failure
class, never as the class itself. Recording it separately is what lets a decisive site verdict be
reported without hiding that the call also ran long; the two facts are orthogonal and a caller
routinely needs both.

## Searching the web

### Search verb
A **discovery** operation: a caller submits a query and gets back ranked results (title, URL,
snippet). It is deliberately not `retrieve` pointed at a search-engine URL. Those are different
problems wearing the same shape — `retrieve` reads a page the caller already chose, so its retry
ladder, clearance poll, and markdown extraction are all tuned for a destination. Give a SERP the
same treatment and an engine's challenge reads as a blocked destination, sending the caller to
rotate exits when the right move is to ask a different provider. It also makes every client own the
engine's markup and the choice of engine, which is provider mechanics leaking into consumers.

### Search provider
An adapter behind one internal seam, mapping a vendor's wire format into the normalized result shape
and its errors into the search failure vocabulary. Which provider answers is Obscura's decision, made
from deployment configuration; a caller never names one and never sees vendor fields. Credentials
and endpoints are deployment config, never client input.

### Search failure class
A **second closed vocabulary**, deliberately separate from the destination-retrieval failure classes.
A search-host failure must never be attributed to a destination result URL: "the search API
rate-limited us" and "the page you asked for rate-limited us" are different facts implying different
next moves, and collapsing them into one enum is how a caller ends up retrying the wrong thing.
Every member carries caller-facing advice, and a test asserts it — a class the caller cannot act on
is a dead end, and a vocabulary whose members imply the same move bought nothing by splitting.

### Empty result
A provider that answered correctly and found nothing. This is a **successful search**, not a failure:
"nothing matched" is a real answer to a discovery question, and reporting it as an error pushes an
agent into retrying a query that already worked. It is still recorded distinctly on the attempt — as
its own `empty` outcome rather than as a failure class — so a working provider is never read as a
broken one while "found nothing" stays machine-readable.

## Flagged ambiguities

- A container's **image ID** and a registry **manifest digest** are both rendered as `sha256:` hex
  and had been read as interchangeable. They are distinct identifiers computed over different inputs
  and are never equal for the same image, so a mismatch between them is structural and carries no
  information about what is deployed.

- **Session** names two different things on two surfaces. The request log counts *transport*
  sessions — one per client connection, created when a client initializes its transport — while the
  operator status surface counts *browser* sessions against the Session pool ceiling. Neither count
  tracks the other, and they diverge widely: a client can hold many transport sessions while no
  browser session exists. Pool capacity is only ever the second; a capacity conclusion drawn from
  the log line is reading the wrong number.
