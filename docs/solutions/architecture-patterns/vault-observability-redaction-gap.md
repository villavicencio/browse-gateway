---
title: Secret redaction covers logs + audit only — observability output and egress payloads are unscrubbed
module: security/secrets
date: 2026-06-23
problem_type: architecture_gap
component: redaction
severity: medium
symptoms:
  - "U7 secret-leak kill-gate (validate-stealth.mjs runSecretLeakCheck) only asserts the log-scrub and audit surfaces"
  - "A stored vault cookie/token rendered into the page DOM appears verbatim in render().html / frameHtml — no redactor on that path"
  - "A captured screenshot of a credentialed session cannot be substring-scrubbed at all (it is an image)"
  - "isBlockedEgressHost classifies destination hosts only; there is no outbound request-body redaction"
root_cause: incomplete_coverage
resolution_type: known_limitation
related_components:
  - observability
  - egress
  - vault
tags: [vault, redaction, secrets, observability, egress, known-gap, u7, follow-up]
---

# Secret redaction covers logs + audit only; observability + egress are unscrubbed

## Context

U7 (credential-vault safety rails) added a secret-leak kill-gate leg
(`scripts/validate-stealth.mjs` → `runSecretLeakCheck`) that proves a stored value never
survives the redaction mechanism. While mapping the surfaces, we confirmed exactly **which**
surfaces redaction is actually wired into — and which it is not.

## What is covered (and proven by the gate)

`redactSecrets(text, store)` (`src/security/secrets.ts`) scrubs every value the `SecretStore`
has ever been told about (typed `SECRET_KEYS` + everything folded via `addRedactable`, which
includes consumer bearer tokens and **decrypted vault cookies/passwords/TOTP seeds**). It is
applied on exactly two surfaces:

1. **Process logs / errors** — the verb, MCP, and CLI boundaries throw
   `new Error(redactSecrets(message, secrets))` (e.g. `mcp/http-main.ts`, `mcp/main.ts`,
   `mcp/drive-controller.ts`, the SSH-boundary log in `cli/vault-host.ts`).
2. **The audit trail** — `RedactingAuditSink` scrubs the `host`/`url`/`reason` fields of every
   `AuditRecord` before it reaches the inner sink.

The kill-gate leg plants a sentinel (registered via `addRedactable`, exactly as a vault
credential is) and asserts it never survives either surface, with a positive control so an
empty capture cannot vacuously pass.

## The gap (NOT covered — deliberately out of scope for U7)

- **Session-observability output has no redactor.** `render().html`, `render().frameHtml`, and
  the accessibility snapshot are returned to the consumer verbatim. If a credentialed (warm)
  session renders a stored value into the page DOM — a CSRF token in a hidden input, a session
  id reflected into markup — it is **not** scrubbed. `validate-frame-capture.mjs` exercises this
  path; a grep for `redact` across `src/gateway/` and the frame-capture path returns nothing.
- **Screenshots cannot be substring-scrubbed.** A PNG of a credentialed session is image data;
  a value visible on screen cannot be removed by `redactSecrets`. Honest closure would require
  either DOM-level redaction *before* capture, or refusing screenshot/frame-capture on a
  credentialed session entirely.
- **Egress is host-classification only.** `isBlockedEgressHost` (R19) blocks
  metadata/private/internal destination hosts; there is **no** outbound request-**body**
  inspection or redaction. "No stored value appears in egress" is enforceable today only as
  "the destination host is allowed," not "the payload carries no secret."

## Why it was left as a gap

The U7 scope decision (2026-06-23) was **"probe the covered surfaces + document the gap"**
rather than ship a half-built HTML scrubber. Redacting rendered HTML is a real feature with a
hard sub-problem (screenshots), and the egress-payload guard does not exist. The kill-gate leg
therefore states its scope explicitly and does not claim coverage it lacks — the WebRTC-leg
lesson ("prove the control, don't assume it") applies in reverse here: don't let a green gate
imply a surface it never tested.

## Follow-up work (when a warm credentialed session is wired — U9)

1. Add a redaction pass over `render().html` / `frameHtml` for credentialed sessions
   (scrub the `SecretStore` redactable set out of the returned markup).
2. Decide the screenshot posture: DOM-level redaction before capture, or refuse
   screenshot/frame-capture on a credentialed session.
3. Extend the kill-gate leg to exercise the observability path end-to-end once a scrubber
   exists (render the sentinel into a fixture page, assert it is absent from the returned HTML).
4. Consider an egress-payload guard if a target flow ever POSTs stored material off-host.

## See also

- `runtime-errors/webrtc-ip-leak-needs-managed-policy-not-launch-switch.md` — the
  prove-the-control kill-gate discipline this leg is modeled on.
- The U7 plan: `docs/plans/2026-06-22-002-credential-vault-plan.local.md` (Threat Model →
  "Leak-by-regression"; U7 secret-leak kill-gate).
