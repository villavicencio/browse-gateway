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
import { proxyOverrideFor, isValidTotpSeed } from "../verbs/index.js";
import { cookieBelongsToHost, hostFromUrl } from "../security/index.js";
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
 * Runs a host-scoped assisted login and returns the captured state plus the bound exit, if any. The
 * runner owns the proxy posture: DIRECT-FIRST, escalating to a pinned residential exit only on a
 * qualifying block (R7) — so it reports `stickyExitId` ONLY when it escalated (a direct capture binds
 * no exit). The production impl opens a guarded consumer session (policy stays below the verb layer)
 * and drives `assistedLogin` over the session's core; tests inject a fake. Kept as a seam so this
 * orchestration carries no browser/gateway dependency.
 */
export type LoginRunner = (args: {
  host: string;
  recipe: LoginRecipe;
  creds: LoginCredentials;
}) => Promise<{ state: StorageState; stickyExitId?: string }>;

/** Reject an unusable TOTP seed at store time (authoritative U6a check) rather than at first login. */
function assertSeedIfPresent(creds: LoginCredentials): void {
  if (creds.totpSeed !== undefined && !isValidTotpSeed(creds.totpSeed)) {
    throw new Error("vault: TOTP seed is invalid or too short (expected a Base32 secret of ≥128 bits)");
  }
}

/**
 * Cookie names for IP-bound anti-bot CHALLENGE tokens — clearance/bot-management cookies a vendor
 * binds to the exit IP (and device/short TTL). They MUST NOT be persisted (R3 / KTD-3): a warm
 * replay from a changed or expired sticky exit would present a stale clearance that no longer matches
 * the IP — a strong "replayed session" tell — instead of letting the site re-mint a fresh one. A
 * DENYLIST (not an allowlist) so the durable auth/session cookies we DO want are never dropped.
 */
const IP_BOUND_COOKIE_PATTERNS: readonly RegExp[] = [
  /^cf_clearance$/i, // Cloudflare IP-bound challenge clearance (the canonical case)
  /^__cf_bm$/i, // Cloudflare bot-management (session/IP-scoped, short-lived)
  /^cf_chl_/i, // Cloudflare in-flight challenge state
  /^_px/i, // PerimeterX/HUMAN: _px, _px2, _px3, _pxhd, _pxvid (IP/device-bound, ~60s)
  /^pxcts$/i, // PerimeterX client token
  /^datadome$/i, // DataDome device/IP token
  /^(_abck|bm_sz|ak_bmsc|bm_sv|bm_mi)$/i, // Akamai Bot Manager (session/IP-bound)
  /^(incap_ses|visid_incap|nlbi)_/i, // Imperva/Incapsula session/visitor ids
];

/** True when `name` is a known IP-bound anti-bot challenge token (case-insensitive). */
export function isIpBoundChallengeCookie(name: string): boolean {
  return IP_BOUND_COOKIE_PATTERNS.some((re) => re.test(name));
}

/**
 * Drop IP-bound anti-bot challenge cookies from a captured/imported {@link StorageState} before it is
 * persisted, enforcing the R3 invariant. localStorage origins are left untouched — these tokens are
 * cookie-based; a vendor that stashed one in `sessionStorage` would not be captured anyway (KTD-4).
 */
export function stripIpBoundTokens(state: StorageState): StorageState {
  return { ...state, cookies: (state.cookies ?? []).filter((c) => !isIpBoundChallengeCookie(c.name)) };
}

/**
 * Drive the login once (direct-first, the runner escalates only on a block), capture the
 * authenticated session, and persist it — recording the bound exit only if the runner escalated.
 * OVERWRITES any existing entry — this is also the refresh-on-expiry path: re-running a capture
 * replaces a stale/blocked entry in place. Returns the stored entry.
 */
export async function captureLoginToVault(
  deps: { vault: VaultEntryStore; runLogin: LoginRunner },
  args: { consumerId: string; host: string; recipe: LoginRecipe; creds: LoginCredentials },
): Promise<VaultEntry> {
  assertSeedIfPresent(args.creds);
  // The runner is direct-first and reports a bound exit ONLY if it escalated (R7) — store stickyExitId
  // only then, so a direct capture replays direct rather than re-pinning an exit it never used.
  const { state, stickyExitId } = await deps.runLogin({ host: args.host, recipe: args.recipe, creds: args.creds });
  // Strip IP-bound challenge tokens BEFORE persisting — captureStorageState() returns every cookie
  // verbatim, including cf_clearance et al., which must not survive into a warm replay (R3).
  const entry: VaultEntry = {
    session: stripIpBoundTokens(state),
    creds: args.creds,
    ...(stickyExitId ? { stickyExitId } : {}),
    updatedAt: Date.now(),
  };
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
  // An operator-provided storageState can also carry a stale IP-bound clearance — strip it too.
  const entry: VaultEntry = {
    session: stripIpBoundTokens(args.session),
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

/**
 * Restrict a captured {@link StorageState} to the entry's owning host (R4 host-scoped no-exfil): keep
 * only the cookies and localStorage origins that {@link cookieBelongsToHost} `ownerHost`, dropping the
 * rest. `storageState()` captures the WHOLE jar — third-party analytics/CDN cookies, and any host-B
 * cookie a mis-filed/seeded blob carried — so a warm replay that injected the blob verbatim could send
 * host-B's cookie wherever host-B is reachable. This is the choke point that makes "a stored host-A
 * cookie is only ever injected into a host-A session" true: it is a FILTER, not an assertion, because
 * a real login jar legitimately contains third-party cookies that must simply be left out, not treated
 * as fatal. The owner-host cookies that remain are exactly the durable identity for this entry.
 */
export function hostScopeSession(state: StorageState, ownerHost: string): StorageState {
  return {
    ...state,
    cookies: (state.cookies ?? []).filter((c) => cookieBelongsToHost(c.domain, ownerHost)),
    origins: (state.origins ?? []).filter((o) => cookieBelongsToHost(hostFromUrl(o.origin), ownerHost)),
  };
}

/** Crypto-shred an entry (drop the wrapped DEK). Returns whether one was removed. */
export function revokeVaultEntry(vault: VaultEntryStore, consumerId: string, host: string): boolean {
  return vault.remove(consumerId, host);
}

/**
 * Build the {@link BrowserCoreOptions} to open a WARM session from a stored entry: restore the
 * captured cookies + localStorage (so the first navigation is already logged-in) AND re-pin the
 * proxy to the exact sticky exit bound at capture, so the replay returns to the same residential IP
 * (R3). A DIRECT capture (no bound exit) replays DIRECT — its durable cookies are not IP-bound, and
 * proxying a session captured on the direct IP would needlessly burn residential egress (R7) and
 * change the exit from the one it was minted on. So a proxy is re-pinned ONLY when the entry carries
 * a bound `stickyExitId` (and a proxy is configured + on a datacenter IP). The stored `session` was
 * already token-filtered at write time ({@link stripIpBoundTokens}), so no IP-bound clearance is
 * replayed here.
 *
 * `ownerHost` is the host the entry is keyed on (the lookup key the caller resolved it by). The restored
 * state is {@link hostScopeSession}-filtered to it (R4 no-exfil): only owner-host cookies/origins are
 * ever injected, so a third-party or smuggled off-host cookie in the blob can never ride into the
 * session. It is REQUIRED, not optional — every warm-open must be host-scoped, enforced by the type.
 */
export function buildWarmOverride(
  entry: VaultEntry,
  secrets: SecretStore,
  opts: { onDatacenterIp: boolean; stickySuffix?: string; ownerHost: string },
): BrowserCoreOptions {
  const proxyOverride = entry.stickyExitId
    ? proxyOverrideFor(secrets, opts.onDatacenterIp, opts.stickySuffix, entry.stickyExitId)
    : undefined;
  return { restoreState: hostScopeSession(entry.session, opts.ownerHost), ...(proxyOverride ?? {}) };
}
