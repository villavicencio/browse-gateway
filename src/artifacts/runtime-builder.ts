/**
 * Task 2 §4.3 — the ONE shared boundary between artifact env config and Task 1's `ArtifactRuntime`,
 * used by every entrypoint so none of them independently interprets limits or root paths.
 *
 * A disabled configuration is an EXACT short-circuit: `loadArtifactConfig` returns `{ enabled: false }`
 * without reading `BGW_ARTIFACT_ROOT` or any other artifact option, so a disabled deployment takes no
 * root-parsing dependency and `buildArtifactRuntime` never touches the filesystem for it. An enabled
 * configuration inherits every Task 1 default (8 MiB/64 MiB/16 MiB/16/4/2/1 quotas, the 10-minute TTL)
 * unchanged — this module adds exactly one knob (the root) on top of `ArtifactRuntime`'s own
 * construction-time validation, which is what actually fails closed on an invalid root/lock/security
 * primitive (Task 1, unchanged here).
 */
import { ArtifactRuntime, ArtifactStoreError } from "./index.js";
import type { ArtifactStoreOptions } from "./types.js";

/** Set to exactly `"1"` to enable artifact capture; any other value (including unset) is disabled. */
const ENABLED_VALUE = "1";

export interface ArtifactRuntimeConfig {
  enabled: boolean;
  /** Absolute filesystem root for the artifact store. Present iff `enabled`. */
  root?: string;
}

/**
 * Parse `BGW_ARTIFACT_CAPTURE_ENABLED`/`BGW_ARTIFACT_ROOT` with the exact disabled short-circuit
 * (Task 2 §4.3, acceptance A2/A3): disabled is decided from ONE env read and nothing else is
 * consulted. Enabled requires a non-empty `BGW_ARTIFACT_ROOT` — fails closed (throws) rather than
 * silently falling back, since a swallowed misconfiguration here would boot with capture silently off
 * or pointed at an unintended path.
 */
export function loadArtifactConfig(env: NodeJS.ProcessEnv = process.env): ArtifactRuntimeConfig {
  if (env.BGW_ARTIFACT_CAPTURE_ENABLED !== ENABLED_VALUE) return { enabled: false };
  const root = env.BGW_ARTIFACT_ROOT;
  if (typeof root !== "string" || root.trim().length === 0) {
    throw new Error("BGW_ARTIFACT_ROOT is required when BGW_ARTIFACT_CAPTURE_ENABLED=1");
  }
  return { enabled: true, root };
}

/**
 * Build the ONE process-owned runtime for an artifact-enabled entrypoint (Task 2 §6 "HTTP process"
 * step 2), or `undefined` for a disabled configuration — never a runtime whose own `enabled` flag is
 * false, so a caller need only check for presence. Every other option (quotas, TTL) is left to
 * `ArtifactRuntime`'s own Task 1 defaults — inherited, not re-specified here. Throws synchronously
 * (fails closed, before the caller can listen/serve) on an invalid root, a live/stale lock, or any
 * other Task 1 construction-time guard: `ArtifactRuntime`'s constructor performs every validation
 * itself; this function adds none of its own.
 */
export function buildArtifactRuntime(config: ArtifactRuntimeConfig): ArtifactRuntime | undefined {
  if (!config.enabled) return undefined;
  const options: ArtifactStoreOptions = { enabled: true, root: config.root! };
  return new ArtifactRuntime(options);
}

/**
 * Task 2 §4.3/§7 stdio rule: an artifact-enabled configuration over stdio is UNSUPPORTED — there is no
 * stdio delivery path (Task 2 non-goals; the SDK stdio close cannot abort a backpressured send, plan
 * §0 spike), so continuing would silently accept a flag that can never take effect. Refuse from ONE
 * env read, before any artifact root/lock/runtime construction is even reachable: this reads nothing
 * but `BGW_ARTIFACT_CAPTURE_ENABLED`, so a malformed `BGW_ARTIFACT_ROOT` alongside it is never
 * consulted on the stdio path either (acceptance A4).
 */
export function assertStdioArtifactUnsupported(env: NodeJS.ProcessEnv = process.env): void {
  if (env.BGW_ARTIFACT_CAPTURE_ENABLED === ENABLED_VALUE) {
    throw new ArtifactStoreError("artifact-transport-unsupported");
  }
}
