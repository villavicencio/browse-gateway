/**
 * Vault credential/session orchestration (U6 / origin B2/B3) — the operator-only layer that ties the
 * assisted-login primitive to the encrypted store. Capture a login once and persist it with a bound
 * sticky exit; import a session already in hand; and build the warm-session override that replays a
 * stored entry as logged-in, re-pinned to the SAME residential exit it was captured on (R3).
 *
 * This module is deliberately FREE of the MCP `DriveController` interface — the assisted-login flow
 * must never be self-servable by a consumer agent (KTD-5). The browser/gateway work is injected as a
 * {@link LoginRunner} seam, so the orchestration is unit-tested without a real browser; the
 * production runner (open a host-scoped guarded session → drive `assistedLogin` → capture) and its
 * live proof land in the follow-up wiring unit.
 */
import type { BrowserCoreOptions, StorageState } from "../browser/index.js";
import type { LoginCredentials, LoginRecipe } from "../verbs/index.js";
import { proxyOverrideFor, newStickyExitId, isValidTotpSeed } from "../verbs/index.js";
import type { SecretStore } from "../security/index.js";

/**
 * What the vault persists per `(consumer, host)`: the captured session blob, the DURABLE auth to
 * re-mint it (creds + optional TOTP seed), and the sticky exit bound at capture so warm replay
 * re-pins the same IP. The whole record is stored encrypted (U4) and every value is folded into the
 * redaction set on read. IP-bound challenge tokens are deliberately NOT persisted (they live in the
 * `session` only as the site set them; rotating exits kill them — replay re-mints, R3).
 */
export interface VaultEntry {
  session: StorageState;
  creds: LoginCredentials;
  /** Sticky-exit id used at capture; re-pinned on warm replay. Absent = no bound exit (direct/seeded). */
  stickyExitId?: string;
  /** Unix ms of capture/import — freshness for refresh decisions. */
  updatedAt: number;
}

/** The minimal vault surface this layer needs; a {@link import("../security/index.js").VaultStore} satisfies it. */
export interface VaultEntryStore {
  put(consumerId: string, host: string, value: unknown): void;
  get<T = unknown>(consumerId: string, host: string): T | null;
  has(consumerId: string, host: string): boolean;
  remove(consumerId: string, host: string): boolean;
}

/**
 * Runs a host-scoped assisted login pinned to `stickyExitId` and returns the captured session state.
 * The production impl opens a guarded consumer session (so policy stays below the verb layer) and
 * drives `assistedLogin` over the session's core; tests inject a fake. Kept as a seam so this
 * orchestration carries no browser/gateway dependency.
 */
export type LoginRunner = (args: {
  host: string;
  recipe: LoginRecipe;
  creds: LoginCredentials;
  stickyExitId: string;
}) => Promise<StorageState>;

/** Reject an unusable TOTP seed at store time (authoritative U6a check) rather than at first login. */
function assertSeedIfPresent(creds: LoginCredentials): void {
  if (creds.totpSeed !== undefined && !isValidTotpSeed(creds.totpSeed)) {
    throw new Error("vault: TOTP seed is invalid or too short (expected a Base32 secret of ≥128 bits)");
  }
}

/**
 * Drive the login once (pinned to a freshly-minted sticky exit), capture the authenticated session,
 * and persist it. OVERWRITES any existing entry — this is also the refresh-on-expiry path: re-running
 * a capture replaces a stale/blocked entry in place. Returns the stored entry.
 */
export async function captureLoginToVault(
  deps: { vault: VaultEntryStore; runLogin: LoginRunner },
  args: { consumerId: string; host: string; recipe: LoginRecipe; creds: LoginCredentials },
): Promise<VaultEntry> {
  assertSeedIfPresent(args.creds);
  const stickyExitId = newStickyExitId();
  const session = await deps.runLogin({ host: args.host, recipe: args.recipe, creds: args.creds, stickyExitId });
  const entry: VaultEntry = { session, creds: args.creds, stickyExitId, updatedAt: Date.now() };
  deps.vault.put(args.consumerId, args.host, entry);
  return entry;
}

/**
 * Persist an operator-provided `storageState` + creds WITHOUT driving a login (origin B2 seeded
 * import). An optional `stickyExitId` binds the import to a held exit; absent = direct/rotating.
 */
export function importLoginToVault(
  vault: VaultEntryStore,
  args: {
    consumerId: string;
    host: string;
    session: StorageState;
    creds: LoginCredentials;
    stickyExitId?: string;
  },
): VaultEntry {
  assertSeedIfPresent(args.creds);
  const entry: VaultEntry = {
    session: args.session,
    creds: args.creds,
    ...(args.stickyExitId ? { stickyExitId: args.stickyExitId } : {}),
    updatedAt: Date.now(),
  };
  vault.put(args.consumerId, args.host, entry);
  return entry;
}

/** Read the decrypted entry for `(consumer, host)`, or null when absent. */
export function getVaultEntry(vault: VaultEntryStore, consumerId: string, host: string): VaultEntry | null {
  return vault.get<VaultEntry>(consumerId, host);
}

/** Crypto-shred an entry (drop the wrapped DEK). Returns whether one was removed. */
export function revokeVaultEntry(vault: VaultEntryStore, consumerId: string, host: string): boolean {
  return vault.remove(consumerId, host);
}

/**
 * Build the {@link BrowserCoreOptions} to open a WARM session from a stored entry: restore the
 * captured cookies + localStorage (so the first navigation is already logged-in) AND re-pin the
 * proxy to the exact sticky exit bound at capture, so the replay returns to the same residential IP
 * (R3). When no proxy is configured / not on a datacenter IP, the warm session is direct — just the
 * restored state. The entry's exit id is threaded straight to `proxyOverrideFor`.
 */
export function buildWarmOverride(
  entry: VaultEntry,
  secrets: SecretStore,
  opts: { onDatacenterIp: boolean; stickySuffix?: string },
): BrowserCoreOptions {
  const proxyOverride = proxyOverrideFor(secrets, opts.onDatacenterIp, opts.stickySuffix, entry.stickyExitId);
  return { restoreState: entry.session, ...(proxyOverride ?? {}) };
}
