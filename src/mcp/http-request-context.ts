/**
 * Task 2 §4.2/§5.1 — the internal seam a server-registered tool (not built in this slice; see
 * `browser_get_artifact`, Task 7) uses to reach the ACTIVE `ArtifactLeaseTracker` for the exact
 * dispatch it is running inside. Repo-owned, never part of `GatewayMcpDeps`: tracker plumbing is not
 * caller-supplied (Task 2 §5.1).
 *
 * `http-server.ts` opens this context once, immediately before it hands the request to
 * `transport.handleRequest()`, and records the JSON-RPC request id of the ONE call this POST may
 * carry. A tool handler receives its own request id via the MCP SDK's `extra.requestId` — matching it
 * against the id this context recorded is what proves the tracker a tool retrieves is the tracker for
 * ITS OWN dispatch, not a different concurrent request that happens to share the async context chain
 * (Task 2 §5.1, acceptance H6). A mismatch, or no active context at all, answers `undefined` — never a
 * stale or foreign tracker.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { HttpArtifactLeaseTracker } from "./http-response-lease.js";

interface ArtifactRequestContext {
  readonly tracker: HttpArtifactLeaseTracker;
  readonly requestId: string | number | undefined;
}

const storage = new AsyncLocalStorage<ArtifactRequestContext>();

/** Run `fn` (and everything it awaits) with `tracker`/`requestId` bound as the active artifact
 *  request context. `http-server.ts` wraps exactly one `transport.handleRequest()` call in this, for
 *  a POST it has already recognized as a `browser_get_artifact` dispatch. */
export function runWithArtifactRequestContext<T>(context: ArtifactRequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/**
 * The active tracker for the dispatch identified by `requestId`, or `undefined` when there is no
 * active context, no active dispatch, or `requestId` names a DIFFERENT call than the one the
 * currently active context was opened for.
 *
 * `requestId` is deliberately required (not defaulted): a caller with no request id of its own — or
 * one that never crossed the SDK's real dispatch — must never silently receive a foreign tracker.
 */
export function getArtifactLeaseTracker(requestId: string | number | undefined): HttpArtifactLeaseTracker | undefined {
  const ctx = storage.getStore();
  if (!ctx) return undefined;
  if (requestId === undefined || ctx.requestId === undefined) return undefined;
  return ctx.requestId === requestId ? ctx.tracker : undefined;
}
