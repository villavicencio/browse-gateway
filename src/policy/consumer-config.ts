/**
 * Multi-consumer provisioning (U7a). A non-secret MANIFEST declares each consumer's id and
 * allowlist scope; the matching bearer TOKEN is resolved separately from the secret source
 * (env, `BGW_CONSUMER_TOKEN_<ID>`), so tokens never live in the committed/manifest surface.
 *
 * This module is pure — manifest text + an env bag in, validated {@link ConsumerSpec}s out — so it
 * is unit-testable without a filesystem. `http-main` reads the manifest file and the env, calls
 * {@link buildConsumerSpecs}, registers the tokens as redactable (R9), and builds the registry once
 * at startup. There is deliberately no hot-reload: a consumer change is a restart (the fleet
 * restarts cheaply; live-swapping a registry under in-flight requests buys nothing here).
 */
import type { ConsumerSpec } from "./consumer.js";

/** A single non-secret manifest entry. The token is NOT here — it comes from the secret source. */
export interface ConsumerManifestEntry {
  id: string;
  /** Allowlist rules (exact host, `*.domain`, or bare `*`). At least one required. */
  allow: string[];
  tags?: string[];
}

/**
 * The env var holding a consumer's bearer token: `BGW_CONSUMER_TOKEN_<ID>`, where `<ID>` is the
 * consumer id upper-cased with every non-alphanumeric run collapsed to a single `_`. So id
 * `agent-1` → `BGW_CONSUMER_TOKEN_AGENT_1`. Two ids that normalize to the same key are rejected in
 * {@link buildConsumerSpecs} so a token can't be silently shared.
 *
 * STABILITY: this normalization is a frozen deployment contract — operators set token env vars by
 * this exact formula. Changing it silently breaks authentication for every existing deployment.
 * Do not alter without a migration path.
 */
export function tokenEnvKey(id: string): string {
  return `BGW_CONSUMER_TOKEN_${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "")}`;
}

/** Parse + shape-validate the manifest JSON. Throws a clear error on malformed input. */
export function parseConsumerManifest(text: string): ConsumerManifestEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`consumer manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(raw)) throw new Error("consumer manifest must be a JSON array of {id, allow}");
  return raw.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) throw new Error(`manifest entry #${i} is not an object`);
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string" || !e.id.trim()) throw new Error(`manifest entry #${i} has no id`);
    if (!Array.isArray(e.allow) || e.allow.some((a) => typeof a !== "string")) {
      throw new Error(`consumer ${e.id} has an invalid allow (must be a string array)`);
    }
    if (e.tags !== undefined && (!Array.isArray(e.tags) || e.tags.some((t) => typeof t !== "string"))) {
      throw new Error(`consumer ${e.id} has invalid tags (must be a string array)`);
    }
    return { id: e.id, allow: e.allow as string[], tags: e.tags as string[] | undefined };
  });
}

export interface BuiltConsumers {
  specs: ConsumerSpec[];
  /** Every resolved token — registered as redactable so it can never surface in logs/audit (R9). */
  tokens: string[];
}

/**
 * Join the manifest to its tokens from `env` and produce {@link ConsumerSpec}s. Throws (fail-closed,
 * never boot a half-provisioned gateway) when: the manifest is empty, an entry has an empty allow,
 * two ids collide on the same token env key, or a token is missing/empty. The token's presence is
 * required here rather than defaulted, so a typo'd env var fails startup loudly instead of leaving a
 * consumer that can never authenticate.
 */
export function buildConsumerSpecs(
  manifest: ConsumerManifestEntry[],
  env: Record<string, string | undefined>,
): BuiltConsumers {
  if (manifest.length === 0) throw new Error("consumer manifest is empty (no consumers to serve)");
  const specs: ConsumerSpec[] = [];
  const tokens: string[] = [];
  const seenKeys = new Set<string>();
  const seenIds = new Set<string>();
  for (const entry of manifest) {
    if (seenIds.has(entry.id)) throw new Error(`duplicate consumer id in manifest: ${entry.id}`);
    seenIds.add(entry.id);
    if (entry.allow.length === 0) throw new Error(`consumer ${entry.id} has an empty allowlist`);
    const key = tokenEnvKey(entry.id);
    if (seenKeys.has(key)) {
      throw new Error(`consumer ids collide on token env key ${key} — give them distinct ids`);
    }
    seenKeys.add(key);
    const token = env[key];
    if (!token) throw new Error(`missing bearer token for consumer ${entry.id} (expected env ${key})`);
    specs.push({ id: entry.id, token, allow: entry.allow, tags: entry.tags });
    tokens.push(token);
  }
  return { specs, tokens };
}
