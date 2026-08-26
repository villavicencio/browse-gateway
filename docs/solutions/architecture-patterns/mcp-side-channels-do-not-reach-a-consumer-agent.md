---
title: An MCP side channel is invisible to a consumer agent — only content text arrives
date: 2026-08-25
category: docs/solutions/architecture-patterns
module: src/mcp/server.ts
problem_type: architecture_pattern
component: mcp
severity: high
root_cause: incorrect_assumption
resolution_type: design_constraint
applies_when:
  - "You are about to carry metadata to a consumer on _meta, structuredContent, or any non-content field"
  - "You are designing a per-result marker (version, deploy id, trace id, capability flag)"
  - "A test proves an SDK client object exposes a field, and you are treating that as proof a consumer can see it"
---

# An MCP side channel is invisible to a consumer agent — only content text arrives

## The claim that was wrong

A release-versioning design carried a per-result contract version on a `browse-gateway/`-namespaced
`_meta` key, mirroring `ERROR_KIND_META_KEY`. It survived two full document-review rounds and three
operator decisions before anyone made the call and looked.

**Measured 2026-08-25 against prod: `_meta` never reaches the consumer agent. Neither does
`structuredContent`. Only `content` text arrives.**

## How it was measured

Two `retrieve` calls from a real registered consumer through the deployed gateway.

**Probe 1 — an RFC-2606 `.invalid` host** (deterministic failure, no third-party egress). The
returned text matched the template at `src/mcp/server.ts:305-307` character for character, which
pins the branch to `:296-307` — and **`:301` on that branch sets `_meta: errorKindMeta("in-band")`**.
The key was attached by the server and did not arrive. That eliminates "this path doesn't carry it."

**Probe 2 — a real PDF** (`200 application/pdf`, confirmed with `curl` first so no gateway call was
spent guessing). It landed on `:267-273`, which is the ideal control: **that single return carries
`_meta` AND `structuredContent` together.** Only the `content` sentence arrived. Both channels died
on one payload, same call, same client — so this is not a per-channel quirk.

Corroboration: everything visible in probe 1 (`diagnostics:`, `failure:` JSON) is interpolated into
the `content` **text** by `${diag}${failure}` at `:307`. Nothing structural ever survived.

## The rule

**Do not design a consumer-facing contract on a side channel without measuring it end to end first.**

- **An SDK-level test proves the wrong thing.** Every existing test asserts the *client object*
  exposes `_meta` (`test/mcp-surface.test.mjs:224`). That is not the claim "an agent can see it."
  The precedent being copied, `ERROR_KIND_META_KEY`, had never had its consumer side demonstrated
  either — it was assumed for the whole life of issue #47.
- **`structuredContent` is not a safe fallback**, despite `src/mcp/server.ts:313` calling it "the
  MCP-native metadata channel." That comment is aspirational, not measured.
- **Survival is a client-side property.** A different consumer's client may surface `_meta`. That
  does not rescue such a design: **a field readable by some consumers and not others is not a
  contract.** Test a second client to size the blast radius, never as a second chance at a better
  answer.
- **The only channel that reaches an agent is `content` text**, and using it for gateway metadata
  means appending chrome to page markdown — which `:313` exists to prevent. That trade-off is real
  and has no free side; make it deliberately.

## Consequences taken

The per-result marker was **deleted, not relocated**. Identity moved to connect-time
`serverInfo.version`, which rides the handshake rather than a result field, with the deploy id as
semver build metadata. The staleness this created — a drive session outliving a deploy swap leaves a
consumer holding a stale value — was accepted and named rather than papered over.

## Suspected consequence elsewhere — unconfirmed

`src/mcp/server.ts:318` surfaces issue #48's silent home-fallback flag via `structuredContent`. Both
probes above were `isError: true`; the success path was not measured. **If success-path
`structuredContent` is dropped the same way, #48's signal is inert for this consumer** — a shipped
feature no consumer can observe. Confirm before filing.

## See also

- `docs/solutions/best-practices/a-test-whose-stub-guarantees-the-assertion-proves-nothing.md` —
  same family: a green test that cannot express the failure it is supposed to catch.
- `CLAUDE.md`, "Measure; do not reason." This is the third defect in this repo traceable to a
  comment asserting a property that a five-minute experiment disproved.
