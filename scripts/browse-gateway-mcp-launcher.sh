#!/usr/bin/env bash
# browse-gateway MCP launcher (stdio) — deployment artifact.
#
# Deployed to the fleet's MCP launcher directory on the production host and referenced from
# the agent runtime's MCP registry, replacing the prior third-party browser MCP for a single
# consumer agent. The agent runtime spawns this as a stdio subprocess; the gateway MCP server
# runs INSIDE the capped container (it needs Xvfb + Chrome) with stdin/stdout wired to the MCP
# protocol channel. Secrets/config come from the environment, which is readable only by the
# gateway process user — never logged, never committed.
#
# NOTE: not used during local development — this is the deployment cutover artifact. The exact
# install path and registry wiring (host, paths, prior-MCP entry) are deployment-specific and
# live in the private deployment notes, not here.
set -euo pipefail

IMAGE="${BGW_IMAGE:-browse-gateway:latest}"

# -i (not -t) attaches stdin/stdout for the stdio protocol; the image ENTRYPOINT brings up
# Xvfb, then exec's the MCP server. Secrets are passed by name so their values never appear
# in this file or in process listings beyond the gateway's own environment.
#
# The -e list is an explicit ALLOWLIST, not a pass-through: a BGW_* variable absent from it is
# invisible inside the container no matter what the operator exported. So every new knob the
# entrypoint reads must be added here too, or the feature is silently unreachable on this path —
# which is exactly what happened when the search verb was first wired into `main.ts`.
exec docker run --rm -i --init --shm-size=1g \
  -e BGW_CHANNEL=chrome \
  -e BGW_NO_SANDBOX=1 \
  -e BGW_MCP_CONSUMER_ID \
  -e BGW_MCP_CONSUMER_TOKEN \
  -e BGW_MCP_ALLOWLIST \
  -e BGW_ON_DATACENTER_IP \
  -e BGW_PROXY_URL -e BGW_PROXY_USERNAME -e BGW_PROXY_PASSWORD -e BGW_PROXY_STICKY_SUFFIX \
  -e BGW_CAPTCHA_API_URL -e BGW_CAPTCHA_API_KEY \
  -e BGW_CALL_BUDGET_MS -e BGW_CLEARANCE_TIMEOUT_MS -e BGW_PROXY_CLEARANCE_TIMEOUT_MS \
  -e BGW_PROXY_NAV_TIMEOUT_MS -e BGW_PROXY_MAX_ATTEMPTS -e BGW_CAPTCHA_SOLVE_TIMEOUT_MS \
  -e BGW_SEARCH_ENABLED -e BGW_SEARCH_PROVIDERS -e BGW_SEARCH_PROVIDER_TIMEOUT_MS \
  -e BGW_SEARCH_TOTAL_TIMEOUT_MS -e BGW_BRAVE_SEARCH_API_URL -e BGW_BRAVE_SEARCH_API_KEY \
  "$IMAGE" \
  node dist/mcp/main.js
