---
title: MCP client ${ENV_VAR} bearer reference false-negatives the add-time connect test
module: mcp/http-transport
date: 2026-06-05
problem_type: integration_issue
component: authentication
severity: medium
symptoms:
  - "Registering the gateway HTTP MCP server in a client fails the inline add-time connect-test with 401 Unauthorized, even though the bearer token is correct"
  - "A standalone fresh `mcp test` of the same server passes and lists all tools"
  - "The captured request carries `Authorization: Bearer ${MCP_<NAME>_API_KEY}` — the literal, unexpanded placeholder"
  - "Entering the raw token and entering `Bearer <token>` BOTH 401, while `curl -H 'Authorization: Bearer <token>'` clears auth"
root_cause: config_error
resolution_type: workflow_improvement
related_components:
  - authentication
  - tooling
tags: [mcp, http-transport, bearer-auth, env-var-expansion, false-negative, http-401, consumer-integration]
---

# MCP client ${ENV_VAR} bearer reference false-negatives the add-time connect test

## Problem

When wiring the gateway's HTTP MCP transport into an MCP client that stores credentials as
**environment-variable references** (`Authorization: Bearer ${MCP_<NAME>_API_KEY}`) and expands them
at request time, the client's **inline add-time connect-test can fail with `401 Unauthorized` even
though the token is correct** — it sends the literal, unexpanded `${...}` string as the bearer.

## Symptoms

- The client's `add` step runs an inline connect-test → `401 Unauthorized`, despite a correct token.
- A separate, fresh `mcp test` of the same entry (a new client process) → passes, lists all tools.
- A capture of the actual outbound request shows `Authorization: Bearer ${MCP_<NAME>_API_KEY}` — the
  reference, not the value.
- Entering the raw token *and* entering `Bearer <token>` at the prompt both 401.

## What Didn't Work

- **Assuming a bearer-scheme mismatch.** Tried the raw token, then `Bearer <token>`; both 401. A
  direct `curl -H "Authorization: Bearer <token>"` against the server returned a non-401 (a `400`
  for a GET with no MCP session) — proving the server *and* the token are fine with the standard
  `Bearer <token>` shape, while a no-prefix `Authorization: <token>` 401s.
- **Assuming double-`Bearer` or missing-`Bearer`.** Both inputs failing identically, while curl
  works, ruled scheme in/out inconclusively — until the request was captured.
- ~1 hour was lost theorizing about auth *format* before capturing the literal request headers (a
  throwaway listener pointed at the `add` probe), which immediately showed the unexpanded `${...}`.

## Solution

Stop treating the client's **inline add-time connect-test as the auth gate** when the client uses
`${ENV_VAR}` credential references:

1. Ensure the referenced env var holds the exact token the server expects (the gateway resolves the
   per-consumer bearer from its own env/secret store, so the client's value must match it).
2. Save the entry even if the inline test fails ("save anyway"), then run a **fresh** standalone
   `mcp test` — a new process loads the now-complete env file and expands `${...}` correctly.
3. If the client saved the entry **disabled** because the inline test failed, enable it.
4. Confirm end-to-end via the **runtime itself** (a real request through the tool), not the add-time test.

## Why This Works

The inline connect-test runs inside the **same client process that just wrote the credential to its
env file**. That process loaded its environment at startup — *before* the variable existed — so
`${...}` expansion finds nothing and emits the literal string, which the server rejects. A fresh
process (a new `mcp test`, or the runtime at next start) loads the updated env file and expands the
reference correctly. The token, the `Bearer` scheme, and the server were never wrong — only the
**process-environment timing** of the one-shot inline test.

## Prevention

- Treat an MCP client's **add-time inline connect-test as advisory, not authoritative**, whenever the
  client stores credentials as `${ENV_VAR}` references. Gate acceptance on a fresh standalone test or
  the runtime, not the add-time result.
- When debugging a `401` against the HTTP transport, **capture the actual request headers first** (a
  few-line listener pointed at a throwaway probe) before theorizing about scheme/format. One capture
  distinguishes wrong-value vs unexpanded-reference vs wrong-scheme — the three were
  indistinguishable from the client's error text alone.
- Verify the server's contract directly with `curl`: `Authorization: Bearer <token>` should clear
  auth (a non-401), while a bare `Authorization: <token>` 401s — confirming the server wants the
  `Bearer ` prefix and isolating the server from the client wiring.
