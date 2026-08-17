import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { fstatSync, fsyncSync, mkdirSync, openSync, closeSync, readSync, writeSync, readdirSync, rmdirSync, lstatSync, linkSync, unlinkSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { ARTIFACT_ID, ArtifactStoreError, type ArtifactAccounting, type ArtifactCloseStep, type ArtifactDiscardResult, type ArtifactRecord, type ArtifactScheduler, type ArtifactStoreOptions, type CaptureOptions, type CaptureResult, type FsOps, type ResponseLease, type ArtifactFailureCode } from "./types.js";

const PDF_MAGIC = Buffer.from("%PDF-");
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const DEFAULT_CLEANUP_INTERVAL_MS = 60_000;
const RESPONSE_LEASE_MS = 15_000;
const MAX_STAGE_COPIES = 2;
/**
 * The stat predicate every descriptor proof in this module decides from, and the whole of that
 * decision: a regular file, exactly the expected size, that size within the artifact bound, owned by
 * the current user, and private at exactly 0600 (Amendment 1 §8). The mask covers setuid/setgid/
 * sticky as well as the permission bits — these files are created 0600 and never legitimately carry
 * any of them, so "exactly 0600" is the whole mode, not just its bottom nine bits.
 *
 * Pure, and total in its input: it receives the four READINGS the decision is made of and nothing
 * else — no path, descriptor, artifact ID, record, digest or file content — so it can be exercised
 * directly for branches a non-root test cannot reach on a real inode (a foreign owner, a non-regular
 * type) without giving any caller a way to substitute a reading in a live store. It is exported from
 * this internal module only; `src/artifacts/index.ts` re-exports `./types.js`, never this file.
 *
 * @internal test seam
 */
export function provenFileStat(reading: { isFile: boolean; size: number; uid: number; mode: number }, bytes: number): boolean {
  return reading.isFile && bytes <= MAX_ARTIFACT_BYTES && reading.size === bytes && reading.uid === process.getuid?.() && (reading.mode & 0o7777) === 0o600;
}
/** One capture's claim on count and bytes. It is created before the source is opened, converted from staging to committed by publication, and released exactly once. */
interface Reservation { readonly id: string; readonly consumerId: string; bytes: number; staging: boolean; released: boolean; }
/**
 * The AUTHORITATIVE record. Module-private and mutable, because the store advances `status` from
 * `available` to `consuming` in place; {@link ArtifactRecord} — the public type — is deeply readonly.
 *
 * No caller ever holds one of these. `capture()` and a lease hand back a frozen SNAPSHOT instead: the
 * store authorizes, verifies, expires and bills from the record it owns, and a record the caller can
 * rewrite is a record the caller can re-authorize. Returning this object let `result.artifact
 * .consumerId = "attacker"` acquire the artifact as the attacker, and let `bytes`/`sha256`/`expiresAt`
 * rewrite the integrity and expiry decisions the store makes from them.
 *
 * `dev`/`ino` are the INODE publication proved (Amendment 1 §8), retained here and nowhere else. They
 * are what makes a later descriptor proof a proof of THIS artifact rather than of an artifact-shaped
 * file: size, mode, owner, type and even the SHA-256 are all reproducible by anything sharing this UID
 * that unlinks the name and copies the bytes into a file of its own. They never cross a boundary —
 * {@link publish} does not carry them, so no snapshot, lease, callback, error or serialized form
 * discloses this store's inode numbers.
 */
interface StoredRecord { id: string; consumerId: string; bytes: number; sha256: string; createdAt: number; expiresAt: number; status: "available" | "consuming"; dev: number; ino: number; }
/** The one way a record crosses a public boundary: a distinct, frozen copy of the fields, taken at
 *  the instant of the crossing. Frozen, so a mutation throws in strict mode and is inert otherwise. */
const publish = (record: StoredRecord): ArtifactRecord =>
  Object.freeze({ id: record.id, consumerId: record.consumerId, bytes: record.bytes, sha256: record.sha256, createdAt: record.createdAt, expiresAt: record.expiresAt, status: record.status });
/** Retained-directory identity. Private to this module: it never crosses a seam or a public type. */
interface DirIdentity { dev: number; ino: number; uid: number; mode: number; directory: boolean; }
/** Retained identity of the lock directory and its diagnostic. Module-private, like `DirIdentity`. */
interface LockIdentity { dev: number; ino: number; uid: number; mode: number; }
const LOCK_DIR = ".gateway-lock";
const LOCK_OWNER_FILE = "owner.json";
const LOCK_METADATA_VERSION = 1;
// OS-derived and sampled once, so the whole process reports one stable start instant.
const PROCESS_STARTED_AT = Math.round(Date.now() - process.uptime() * 1000);
/** The default time domain. Exported so the runtime's OPERATION deadlines resolve to the same
 *  scheduler instance the store uses — one clock for expiry, leases, cleanup and settlement. */
export const SYSTEM_SCHEDULER: ArtifactScheduler = Object.freeze({
  now: () => Date.now(),
  processStartedAt: () => PROCESS_STARTED_AT,
  // Artifact timers are background cleanup/deadline work: they must never be the sole reason a process stays alive.
  setTimeout: (callback: () => void, delayMs: number) => { const handle = setTimeout(callback, delayMs); (handle as { unref?: () => void }).unref?.(); return handle; },
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});
/** The default filesystem authority: this module's own frozen object, never a caller's. */
const SYSTEM_FS_OPS: FsOps = Object.freeze({ linkSync, unlinkSync, fsyncSync });

// ---------------------------------------------------------------------------------------------
// The configuration boundary.
//
// `new ArtifactStore(...)` and `new ArtifactRuntime(...)` are PUBLIC JavaScript entry points, so the
// options object is untrusted: it may be null, a number, a proxy whose traps throw, or a plain object
// whose getters throw, count reads or answer differently each time. Dereferencing it before checking
// it let a raw Node `TypeError [ERR_INVALID_ARG_TYPE]` — and any text a hostile getter chose to throw —
// escape a constructor whose whole error vocabulary is supposed to be closed.
//
// Everything below runs BEFORE the first Node path or filesystem call, reads every caller-controlled
// property EXACTLY ONCE, and normalizes every malformed shape to `artifact-config-invalid`.
// ---------------------------------------------------------------------------------------------

const invalidConfig = () => new ArtifactStoreError("artifact-config-invalid");

/**
 * The closed option set, spelled as an exhaustive `Record` so a new {@link ArtifactStoreOptions}
 * member fails the typecheck here rather than silently bypassing canonicalization.
 */
const OPTION_KEYS: Readonly<Record<keyof ArtifactStoreOptions, true>> = Object.freeze({
  enabled: true, root: true, ttlMs: true, cleanupIntervalMs: true, maxBytes: true, maxCount: true,
  perConsumerBytes: true, perConsumerCount: true, idGenerator: true, fsOps: true, scheduler: true,
  onDiscard: true, onCleanupPass: true, afterPartFsync: true, afterLinkBeforeCommit: true, beforeCommit: true,
  onOperationTerminal: true, onOperationReleased: true, onOperationCommitted: true, identityOverride: true,
  onCloseStep: true, closeStepFails: true, afterRootDescriptor: true, onDataPathOpen: true, onDescriptorClose: true,
});
/** Every option EXCEPT `enabled`, which decides whether any of them is read at all and is therefore
 *  snapshotted on its own, first, and exactly once. Derived from the exhaustive table above so a new
 *  member joins this snapshot automatically. */
const NON_ENABLED_OPTION_KEYS: readonly string[] = Object.freeze(Object.keys(OPTION_KEYS).filter((key) => key !== "enabled"));
const NUMERIC_OPTIONS = ["ttlMs", "cleanupIntervalMs", "maxBytes", "maxCount", "perConsumerBytes", "perConsumerCount"] as const;
const FUNCTION_OPTIONS = [
  "idGenerator", "onDiscard", "onCleanupPass", "afterPartFsync", "afterLinkBeforeCommit", "beforeCommit",
  "onOperationTerminal", "onOperationReleased", "onOperationCommitted", "identityOverride", "onCloseStep",
  "closeStepFails", "afterRootDescriptor", "onDataPathOpen", "onDescriptorClose",
] as const;
const REQUIRED_FS_OPS = ["linkSync", "unlinkSync", "fsyncSync"] as const;
const OPTIONAL_FS_OPS = ["rmdirSync", "readdirSync"] as const;
const SCHEDULER_METHODS = ["now", "processStartedAt", "setTimeout", "clearTimeout"] as const;

/** Read a closed key set from an untrusted object ONCE. A throwing getter or proxy trap is a
 *  malformed option, never an escape route for its own exception text. */
function snapshotOnce(source: object, keys: readonly string[]): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  try {
    for (const key of keys) snapshot[key] = (source as Record<string, unknown>)[key];
  } catch {
    throw invalidConfig();
  }
  return snapshot;
}

/**
 * Retain the caller's receiver while holding our own reference to the function.
 *
 * Binding must not READ the callable. This used to evaluate `fn.bind`, which is a caller-controlled
 * property access on a caller-controlled object: a hostile `bind` getter threw its own text straight
 * out of `new ArtifactStore(...)`, past the normalization above whose whole purpose is to keep this
 * constructor's error vocabulary closed. The intrinsic `Function.prototype.bind` is not enough on its
 * own either — it reads `length` and `name` off its target, so the same getter simply moves. The call
 * is therefore deferred through `Reflect.apply`, which performs no property access on `fn` at all,
 * at binding time or afterwards, while still calling it with the receiver it was snapshotted from.
 * A malicious function BODY is out of scope here: it is untrusted code the store chose to install.
 */
const bindTo = <T>(fn: unknown, receiver: object): T =>
  (((...args: unknown[]) => Reflect.apply(fn as (...args: unknown[]) => unknown, receiver, args)) as unknown) as T;

/**
 * Snapshot the injected filesystem authority. The store used to keep the CALLER's object and re-read
 * `unlinkSync`/`linkSync`/`fsyncSync` off it at every call, so replacing one of those properties after
 * construction replaced the authority the store deletes and commits with.
 */
function canonicalizeFsOps(raw: unknown): FsOps {
  if (!raw || typeof raw !== "object") throw invalidConfig();
  const source = raw as object;
  const snapshot = snapshotOnce(source, [...REQUIRED_FS_OPS, ...OPTIONAL_FS_OPS]);
  for (const key of REQUIRED_FS_OPS) if (typeof snapshot[key] !== "function") throw invalidConfig();
  for (const key of OPTIONAL_FS_OPS) if (snapshot[key] !== undefined && typeof snapshot[key] !== "function") throw invalidConfig();
  const canonical: FsOps = {
    linkSync: bindTo<FsOps["linkSync"]>(snapshot.linkSync, source),
    unlinkSync: bindTo<FsOps["unlinkSync"]>(snapshot.unlinkSync, source),
    fsyncSync: bindTo<FsOps["fsyncSync"]>(snapshot.fsyncSync, source),
  };
  if (snapshot.rmdirSync !== undefined) canonical.rmdirSync = bindTo<NonNullable<FsOps["rmdirSync"]>>(snapshot.rmdirSync, source);
  if (snapshot.readdirSync !== undefined) canonical.readdirSync = bindTo<NonNullable<FsOps["readdirSync"]>>(snapshot.readdirSync, source);
  return Object.freeze(canonical);
}

/** The same treatment for the ONE injected clock: a snapshot of its four methods, frozen, so a later
 *  `scheduler.setTimeout = …` cannot take over the store's timers, deadlines or expiry. */
function canonicalizeScheduler(raw: unknown): ArtifactScheduler {
  if (!raw || typeof raw !== "object") throw invalidConfig();
  const source = raw as object;
  const snapshot = snapshotOnce(source, SCHEDULER_METHODS);
  for (const key of SCHEDULER_METHODS) if (typeof snapshot[key] !== "function") throw invalidConfig();
  return Object.freeze({
    now: bindTo<ArtifactScheduler["now"]>(snapshot.now, source),
    processStartedAt: bindTo<ArtifactScheduler["processStartedAt"]>(snapshot.processStartedAt, source),
    setTimeout: bindTo<ArtifactScheduler["setTimeout"]>(snapshot.setTimeout, source),
    clearTimeout: bindTo<ArtifactScheduler["clearTimeout"]>(snapshot.clearTimeout, source),
  });
}

/**
 * The ONE canonicalization both public constructors use, so they share an error vocabulary and a
 * read-once discipline. The result is a frozen plain object of validated values: reading it twice is
 * safe, which is what lets the runtime hand its store a config without re-entering caller code.
 *
 * @internal
 */
export function canonicalizeStoreOptions(untrusted: ArtifactStoreOptions): ArtifactStoreOptions {
  if (!untrusted || typeof untrusted !== "object") throw invalidConfig();
  // `enabled` decides whether ANY other option is read, so it is snapshotted on its own and first —
  // exactly once, through the same guard as every other read, so a throwing getter or proxy trap is a
  // malformed configuration rather than an escape route for its own exception text.
  const gate = snapshotOnce(untrusted, ["enabled"]);
  if (gate.enabled !== undefined && typeof gate.enabled !== "boolean") throw invalidConfig();
  // Amendment 2 §7: a DISABLED configuration owns no tree, so it must not REQUIRE or VALIDATE a root
  // — nor a numeric limit, an injected authority, a callback or a test seam. EXACT `false` and
  // nothing else returns here, before a single further property of the caller's object is touched.
  if (gate.enabled === false) return Object.freeze({ enabled: false }) as unknown as ArtifactStoreOptions;
  const raw = snapshotOnce(untrusted, NON_ENABLED_OPTION_KEYS);
  const canonical: Record<string, unknown> = {};
  // Preserved exactly: `enabled` is recorded only when the caller stated it, and it was read once.
  if (gate.enabled !== undefined) canonical.enabled = gate.enabled;
  // The root is the only required option, and the only one Node would otherwise dereference as a path.
  if (typeof raw.root !== "string" || raw.root.length === 0) throw invalidConfig();
  canonical.root = raw.root;
  for (const key of NUMERIC_OPTIONS) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) throw invalidConfig();
    canonical[key] = value;
  }
  for (const key of FUNCTION_OPTIONS) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "function") throw invalidConfig();
    canonical[key] = value;
  }
  if (raw.fsOps !== undefined) canonical.fsOps = canonicalizeFsOps(raw.fsOps);
  if (raw.scheduler !== undefined) canonical.scheduler = canonicalizeScheduler(raw.scheduler);
  return Object.freeze(canonical) as unknown as ArtifactStoreOptions;
}

/**
 * The artifact store.
 *
 * EVERY field below is a native `#private`. TypeScript `private` is erased: it compiled to an
 * ordinary writable, enumerable own property, so `Object.keys(runtime.store)` disclosed the
 * configured root, the data path, the record map, the retained descriptors, the injected callbacks
 * and the reservation ledger — and each of them could be REPLACED at runtime, which is enough to
 * redirect the store's filesystem routing. A `#private` field is not a property: it does not
 * enumerate, does not serialize, and a same-named assignment lands on a decoy the class never reads.
 * The instance is frozen at the end of construction, so there is nowhere for a decoy to land at all.
 */
export class ArtifactStore {
  readonly #enabled: boolean;
  readonly #root: string; readonly #data: string; readonly #scheduler: ArtifactScheduler;
  readonly #ttlMs: number; readonly #cleanupIntervalMs: number; readonly #maxBytes: number; readonly #maxCount: number;
  readonly #perConsumerBytes: number; readonly #perConsumerCount: number;
  readonly #fsOps: NonNullable<ArtifactStoreOptions["fsOps"]>; readonly #afterPartFsync?: ArtifactStoreOptions["afterPartFsync"]; readonly #afterLinkBeforeCommit?: ArtifactStoreOptions["afterLinkBeforeCommit"];
  /**
   * Three ORTHOGONAL facts, never one flag (Amendment 7 §4):
   *
   *  - `unhealthy` — POISON. The store can no longer prove what it owns, so it rejects future work
   *    and cancels its timers/responders. It performs NO teardown: poison is not a close request,
   *    and treating it as one removed the `.gateway-lock` of a root nobody had asked to close.
   *  - `closeRequested` — an explicit {@link close} was called. Only this admits {@link finishClose}.
   *  - `disposed` — descriptors released; the teardown has already happened.
   *
   * Poison may coexist with a requested close; an explicit close after poison remains possible.
   */
  #closeRequested = false; #unhealthy = false; #activeCaptures = 0;
  /** The idempotent teardown guard, installed BEFORE the first close step so a repeated close and a
   *  late capture-finally callback both find it already taken. */
  #teardownStarted = false;
  #closePromise?: Promise<ArtifactFailureCode | undefined>; #resolveClose?: (result: ArtifactFailureCode | undefined) => void;
  readonly #inflight = new Set<string>();
  /** IDs durably discarded while their capture continuation was paused. Bound to that one in-flight
   *  reservation and cleared only by its finally block, so a late continuation cannot publish bytes
   *  already deleted and a replacement generation never inherits the tombstone. */
  readonly #discardedInflight = new Set<string>();
  readonly #onDiscard?: (id: string, closeOwned: boolean) => void; readonly #onCleanupPass?: () => void;
  #records = new Map<string, StoredRecord>(); #timers = new Map<string, unknown>();
  #cleanupTimer?: unknown; #cleanupRunning = false;
  readonly #reservations = new Map<string, Reservation>(); readonly #consumerLedger = new Map<string, { count: number; bytes: number }>();
  #ledgerCount = 0; #ledgerBytes = 0; #stagePermits = 0;
  #responseBusy = false; #responseHolder?: object; #responseId?: string; #responseBytes = 0; #responseSettle?: () => void;
  readonly #responseWaiters: Array<(granted: boolean) => void> = [];
  #rootFd = -1; #dataFd = -1; #rootIdentity?: DirIdentity; #dataIdentity?: DirIdentity; #identityLost = false; #disposed = false;
  #lockNonce = ""; #lockStartedAt = 0; #lockIdentity?: LockIdentity; #ownerIdentity?: LockIdentity;
  readonly #identityOverride?: ArtifactStoreOptions["identityOverride"]; readonly #afterRootDescriptor?: () => void;
  readonly #onDataPathOpen?: () => void; readonly #onDescriptorClose?: () => void; readonly #onCloseStep?: ArtifactStoreOptions["onCloseStep"]; readonly #closeStepFails?: ArtifactStoreOptions["closeStepFails"];

  /** The ONE public flag, and a prototype accessor rather than an own property: source-compatible to
   *  read, impossible to enumerate, serialize, or assign — an assignment used to switch off every
   *  identity proof in this class. */
  get enabled(): boolean { return this.#enabled; }

  constructor(untrustedOptions: ArtifactStoreOptions) {
    // ONE sanitizing boundary, before any Node path or filesystem call: every caller-controlled
    // option is read exactly once, shape-checked, and the injected filesystem/scheduler authority is
    // snapshotted into an object of ours. What follows reads a frozen, validated configuration.
    const options = canonicalizeStoreOptions(untrustedOptions);
    // Amendment 2 §7: a DISABLED store is INERT. It reaches this branch before the data path is
    // joined, before the root is validated, before the numeric limits are checked and before any
    // injected scheduler, filesystem authority, callback or test seam is adopted — so it acquires no
    // root, no descriptor, no lock, no timer and no caller-supplied authority, and makes no
    // filesystem call. The fields below exist ONLY because TypeScript requires every `readonly`
    // member to be assigned: they are this module's own inert defaults, never a configured value, and
    // none of them is reachable from outside — the instance is frozen with no own property at all, so
    // there is no externally visible root or authority to disclose. Every method that could act on
    // them checks `#enabled` first.
    if (options.enabled === false) {
      this.#enabled = false;
      this.#root = ""; this.#data = "";
      this.#scheduler = SYSTEM_SCHEDULER; this.#fsOps = SYSTEM_FS_OPS;
      this.#ttlMs = 0; this.#cleanupIntervalMs = 0; this.#maxBytes = 0; this.#maxCount = 0; this.#perConsumerBytes = 0; this.#perConsumerCount = 0;
      Object.freeze(this);
      return;
    }
    this.#enabled = true; this.#root = options.root; this.#data = join(this.#root, "data");
    this.#scheduler = options.scheduler ?? SYSTEM_SCHEDULER; this.#ttlMs = options.ttlMs ?? 600_000; this.#cleanupIntervalMs = options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS; this.#maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    this.#maxCount = options.maxCount ?? 16; this.#perConsumerBytes = options.perConsumerBytes ?? 16 * 1024 * 1024; this.#perConsumerCount = options.perConsumerCount ?? 4;
    this.#fsOps = options.fsOps ?? SYSTEM_FS_OPS; this.#onDiscard = options.onDiscard; this.#onCleanupPass = options.onCleanupPass; this.#afterPartFsync = options.afterPartFsync; this.#afterLinkBeforeCommit = options.afterLinkBeforeCommit;
    this.#identityOverride = options.identityOverride; this.#afterRootDescriptor = options.afterRootDescriptor; this.#onDataPathOpen = options.onDataPathOpen; this.#onDescriptorClose = options.onDescriptorClose; this.#onCloseStep = options.onCloseStep; this.#closeStepFails = options.closeStepFails;
    if (!isAbsolute(this.#root) || !Number.isFinite(this.#ttlMs) || this.#ttlMs <= 0 || !Number.isInteger(this.#cleanupIntervalMs) || this.#cleanupIntervalMs <= 0 || !Number.isFinite(this.#maxBytes) || this.#maxBytes <= 0 || !Number.isFinite(this.#maxCount) || this.#maxCount <= 0 || !Number.isFinite(this.#perConsumerBytes) || this.#perConsumerBytes <= 0 || !Number.isFinite(this.#perConsumerCount) || this.#perConsumerCount <= 0) throw new ArtifactStoreError("artifact-config-invalid");
    // Frozen at the end of construction: a constructed store has no own properties, so a hostile
    // `store.root = …` has nowhere to land. Private fields live in internal slots and are unaffected,
    // so every assignment this class makes after construction still works.
    if (process.platform !== "linux" || constants.O_NOFOLLOW === undefined || constants.O_DIRECTORY === undefined) throw new ArtifactStoreError("artifact-filesystem-unsupported");
    try { mkdirSync(this.#root, { recursive: true, mode: 0o700 }); } catch { throw new ArtifactStoreError("artifact-root-invalid"); }
    try { const existing = lstatSync(this.#root); if (!existing.isDirectory() || existing.uid !== process.getuid?.()) throw new Error(); } catch { throw new ArtifactStoreError("artifact-root-invalid"); }
    // A pre-existing lock always refuses here: it is never read, opened or removed.
    try { mkdirSync(this.#lockPath, { mode: 0o700 }); } catch { throw new ArtifactStoreError("artifact-root-locked"); }
    try { this.#claimLock(); } catch { this.#rollbackLock(); throw new ArtifactStoreError("artifact-root-invalid"); }
    try {
      const rootStat = lstatSync(this.#root); if (!rootStat.isDirectory() || rootStat.uid !== process.getuid?.() || (rootStat.mode & 0o777) !== 0o700) throw new Error();
      mkdirSync(this.#data, { recursive: true, mode: 0o700 }); const dataStat = lstatSync(this.#data); if (!dataStat.isDirectory() || dataStat.uid !== process.getuid?.() || (dataStat.mode & 0o777) !== 0o700) throw new Error();
    } catch { this.#rollbackLock(); throw new ArtifactStoreError("artifact-root-invalid"); }
    // Still pre-mutation: retain both directory descriptors and bind them to the configured paths,
    // so every later mutation can prove it is acting on the tree this boot validated.
    try {
      this.#rootFd = openSync(this.#root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      this.#afterRootDescriptor?.();
      this.#dataFd = openSync(this.#data, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      this.#onDataPathOpen?.();
      this.#rootIdentity = this.#readIdentity("root", "descriptor"); this.#dataIdentity = this.#readIdentity("data", "descriptor");
      if (!this.#identityHolds()) throw new Error();
    } catch { this.#closeDescriptors(); this.#rollbackLock(); throw new ArtifactStoreError("artifact-root-invalid"); }
    try {
      let changed = false;
      const entries = readdirSync(this.#data).sort();
      const paths: string[] = [];
      for (const name of entries) { if (!/^[A-Za-z0-9_-]{22,64}\.(?:part|pdf)$/.test(name)) throw new ArtifactStoreError("artifact-root-invalid"); const path = join(this.#data, name); const st = lstatSync(path); if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o600) throw new ArtifactStoreError("artifact-root-invalid"); paths.push(path); }
      for (const path of paths) { this.#fsOps.unlinkSync(path); changed = true; }
      if (changed) this.#fsyncDataDir();
    } catch (e) { this.#closeDescriptors(); if (e instanceof ArtifactStoreError && e.code === "artifact-root-invalid") { this.#rollbackLock(); throw e; } throw new ArtifactStoreError("artifact-cleanup-failed"); }
    this.#scheduleCleanup();
    Object.freeze(this);
  }

  async capture(source: string, untrustedOptions: CaptureOptions): Promise<CaptureResult> {
    if (!untrustedOptions || typeof untrustedOptions !== "object") throw new ArtifactStoreError("artifact-config-invalid");
    let id: unknown, consumerId: unknown, ttlMs: unknown;
    try {
      // Snapshot once before any accounting or filesystem work. Public callers may supply throwing or
      // stateful getters/proxies; their exceptions and inconsistent second reads stay outside the store.
      id = untrustedOptions.id;
      consumerId = untrustedOptions.consumerId;
      ttlMs = untrustedOptions.ttlMs;
    } catch {
      throw new ArtifactStoreError("artifact-config-invalid");
    }
    if (typeof id !== "string") throw new ArtifactStoreError("invalid-artifact-id");
    if (typeof consumerId !== "string" || consumerId.length === 0) throw new ArtifactStoreError("artifact-config-invalid");
    let normalizedTtlMs: number | undefined;
    if (ttlMs !== undefined) {
      if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || !Number.isInteger(ttlMs) || ttlMs <= 0) return { status: "capture-failed", failure: "artifact-config-invalid" };
      normalizedTtlMs = ttlMs;
    }
    const options: CaptureOptions = { id, consumerId, ...(normalizedTtlMs === undefined ? {} : { ttlMs: normalizedTtlMs }) };
    this.#reapExpired();
    if (!ARTIFACT_ID.test(options.id)) throw new ArtifactStoreError("invalid-artifact-id");
    if (this.#closeRequested || this.#unhealthy || !this.#enabled) return { status: "capture-failed", failure: "artifact-runtime-invalidated" };
    if (this.#records.has(options.id) || this.#inflight.has(options.id)) return { status: "capture-failed", failure: "artifact-capacity" };
    // Count, bytes and the stage permit are claimed in one synchronous step before the source is
    // opened or any destination exists, so a rejected reservation touches nothing.
    const reservation = this.#reserve(options.id, options.consumerId);
    if (!reservation) return { status: "capture-failed", failure: "artifact-capacity" };
    this.#inflight.add(options.id); this.#activeCaptures++;
    let fd = -1, out = -1; let part: string | undefined; let final: string | undefined; let linked = false; let committed = false, retain = false;
    try {
      fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW); const initial = fstatSync(fd);
      if (!initial.isFile() || initial.size > MAX_ARTIFACT_BYTES) return { status: "capture-failed", failure: "artifact-size-limit" };
      if (initial.size < PDF_MAGIC.length) return { status: "capture-failed", failure: "artifact-not-pdf" };
      // Exact size known: hand back the unused part of the pessimistic reservation immediately.
      this.#shrinkReservation(reservation, initial.size);
      // Hash the exact bytes as they cross the source descriptor boundary. The digest is complete
      // before the staged descriptor is fsynced or either destination name is published; computing it
      // from the retained buffer after link publication satisfies value equality but not Amendment 2
      // §6's chain of custody (verify magic, size and hash while streaming, then fsync/publish/prove).
      const sourceHash = createHash("sha256");
      const buf = Buffer.alloc(initial.size); let off = 0; while (off < buf.length) { const n = readSync(fd, buf, off, buf.length - off, off); if (n <= 0) throw new Error(); sourceHash.update(buf.subarray(off, off + n)); off += n; }
      const sha256 = sourceHash.digest("hex");
      const end = fstatSync(fd); if (end.size !== initial.size || !buf.subarray(0, 5).equals(PDF_MAGIC)) return { status: "capture-failed", failure: "artifact-integrity-failed" };
      // The destination is this store's first mutation of the tree, so it needs identity proof too.
      if (!this.#identityProven()) return { status: "capture-failed", failure: "artifact-runtime-invalidated" };
      part = join(this.#data, `${options.id}.part`); final = join(this.#data, `${options.id}.pdf`); out = openSync(part, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      let written = 0; while (written < buf.length) { const n = writeSync(out, buf, written, buf.length - written, written); if (n <= 0) throw new Error(); written += n; } this.#fsOps.fsyncSync(out);
      // The staged file is proved through the descriptor that wrote it, BEFORE that descriptor is
      // closed and before the name is linked: afterwards there is nothing left to prove it against,
      // and `part` is only a name. Its identity is what the final name is checked against below.
      const staged = this.#provenFile(out, buf.length);
      closeSync(out); out = -1; if (this.#afterPartFsync) await this.#afterPartFsync();
      if (this.#discardedInflight.has(options.id)) return { status: "capture-failed", failure: "download-lifecycle-race" };
      if (this.#closeRequested || this.#unhealthy) return { status: "capture-failed", failure: "artifact-runtime-invalidated" };
      // Immediately before link and commit: a staged file whose tree can no longer be proven stays
      // where it is, and its capacity stays reserved.
      if (!this.#identityProven()) { retain = true; return { status: "capture-failed", failure: "artifact-runtime-invalidated" }; }
      this.#fsOps.linkSync(part, final); linked = true; this.#fsOps.unlinkSync(part); part = undefined;
      if (this.#afterLinkBeforeCommit) await this.#afterLinkBeforeCommit();
      if (this.#discardedInflight.has(options.id)) return { status: "capture-failed", failure: "download-lifecycle-race" };
      // The commit window is an await: the tree must still be provable at metadata commit, not only
      // before the link. An unprovable tree leaves the linked artifact, its capacity and the lock alone.
      if (!this.#identityProven()) { retain = true; return { status: "capture-failed", failure: "artifact-runtime-invalidated" }; }
      if (this.#closeRequested || this.#unhealthy) { const clean = this.#strictDelete([final]); if (!clean) { retain = true; this.#markUnhealthy(); return { status: "capture-failed", failure: "artifact-cleanup-failed" }; } return { status: "capture-failed", failure: "artifact-runtime-invalidated" }; }
      // §4.2 step 8, the LAST thing before publication: metadata commits only once a stat of the final
      // file confirms it. Everything above proves the staged bytes and the tree; none of it proves
      // that `<id>.pdf` still names them. The link succeeded, then this capture awaited — and `chmod`,
      // truncation and unlink-plus-replace are all available at that name to anything sharing this UID
      // in the meantime. A failure here is an ordinary staged-write failure: it takes the cleanup path
      // below, inserts no record and returns no snapshot.
      const published = this.#proveLinked(final, buf.length, staged);
      this.#fsyncDataDir();
      // The record is bound to the identity that proof just established, not merely to the size and
      // digest of the bytes at that name: those are exactly the facts a replacement can reproduce.
      const createdAt = this.#scheduler.now(); const record: StoredRecord = { id: options.id, consumerId: options.consumerId, bytes: buf.length, sha256, createdAt, expiresAt: createdAt + (options.ttlMs ?? this.#ttlMs), status: "available", dev: published.dev, ino: published.ino };
      // Publication converts this reservation from staging to committed; it never releases and reacquires.
      // The caller gets a FROZEN SNAPSHOT: the authoritative record stays here, because it is what
      // authorization, integrity, expiry and accounting are decided from.
      this.#records.set(options.id, record); committed = true; return publish(record);
    } catch {
      if (out >= 0) try { closeSync(out); } catch {}
      const clean = this.#strictDelete([part, linked ? final : undefined].filter((x): x is string => !!x));
      if (!clean) { retain = true; this.#markUnhealthy(); return { status: "capture-failed", failure: "artifact-cleanup-failed" }; }
      return { status: "capture-failed", failure: "artifact-write-failed" };
    // The copy body has exited, so its stage permit is always returned; capacity that a failed
    // cleanup may still occupy on disk stays reserved until deletion is confirmed.
    } finally { if (fd >= 0) try { closeSync(fd); } catch {} this.#releaseStage(reservation); if (!committed && !retain) this.#releaseReservation(reservation); this.#discardedInflight.delete(options.id); this.#inflight.delete(options.id); this.#activeCaptures--; if (this.#closeRequested && this.#activeCaptures === 0) this.#finishClose(); }
  }

  acquire(id: string, consumerId: string): Promise<ResponseLease | null> {
    if (typeof id !== "string") throw new ArtifactStoreError("invalid-artifact-id");
    if (!ARTIFACT_ID.test(id)) throw new ArtifactStoreError("invalid-artifact-id");
    return this.#lease(id, consumerId);
  }

  /** One global response permit. A waiter holds nothing: it cannot mark its artifact consuming, open a file or start a deadline until it is admitted. */
  async #lease(id: string, consumerId: string): Promise<ResponseLease | null> {
    if (!this.#leasable(id, consumerId)) return null;
    if (this.#responseBusy) {
      if (!await new Promise<boolean>(resolve => { this.#responseWaiters.push(resolve); })) return null;
      if (!this.#leasable(id, consumerId)) { this.#releaseResponse(); return null; }
    } else this.#responseBusy = true;
    const rec = this.#records.get(id)!;
    if (!this.#identityProven()) { if (this.#responseBusy) this.#releaseResponse(); return null; }
    const holder = {}; this.#responseHolder = holder; this.#responseId = id;
    const yieldPermit = () => {
      if (this.#responseHolder !== holder) return;
      this.#responseHolder = undefined; this.#responseId = undefined; this.#responseSettle = undefined; this.#releaseResponse();
    };
    const path = join(this.#data, `${id}.pdf`); let fd = -1;
    // The exact response budget opens immediately before final open. It is armed before any
    // synchronous open/read/hash/base64 work, and a post-encode clock check below closes the one gap
    // an event-loop timer cannot cover by dispatch: a single JS turn that itself spends the budget.
    const deadline = this.#scheduler.now() + RESPONSE_LEASE_MS;
    let done = false;
    this.#responseSettle = () => { done = true; yieldPermit(); };
    rec.status = "consuming";
    const timer = this.#scheduler.setTimeout(() => {
      this.#timers.delete(id);
      if (done || this.#closeRequested || this.#unhealthy) return;
      done = true; yieldPermit(); this.#discardOwned(id);
    }, Math.max(0, deadline - this.#scheduler.now()));
    this.#timers.set(id, timer);
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      // Amendment 1 §8, consume side. The OPENED DESCRIPTOR is proved before a single byte is read:
      // a regular file, owned by this process, private at exactly 0600, and exactly the bounded size
      // the metadata claims. Publication proved all of that once — and none of it survives the
      // artifact's lifetime, during which the artifact is only a name and anything sharing this UID
      // can widen its mode or unlink it and leave another inode there. Size and hash alone verify
      // content this store never established it was allowed to read — and cannot tell the published
      // inode from a copy of its bytes, which is why the identity proved at publication is re-proved.
      this.#provenRecordFile(fd, rec);
      const buf = Buffer.alloc(rec.bytes); let off = 0;
      while (off < buf.length) { const n = readSync(fd, buf, off, buf.length - off, off); if (n <= 0) throw new Error(); off += n; }
      // Revalidated on the SAME open file after the read and before anything escapes: `chmod` lands on
      // the inode, so a descriptor that was private when it was opened need not still be when its
      // bytes, its record snapshot and its response permit are about to cross the boundary.
      this.#provenRecordFile(fd, rec);
      if (createHash("sha256").update(buf).digest("hex") !== rec.sha256) throw new Error();
      const base64 = buf.toString("base64");
      // setTimeout cannot interrupt the synchronous region above. Refuse an already-expired resource
      // synchronously rather than briefly returning bytes/permit authority before the callback runs.
      if (this.#scheduler.now() >= deadline) {
        done = true; this.#clearTimer(id); yieldPermit(); this.#discardOwned(id); return null;
      }
      this.#responseBytes = buf.length;
      return {
        record: publish(rec), bytes: buf.length, base64, deadline,
        complete: () => {
          if (done) return;
          done = true; this.#clearTimer(id); yieldPermit();
          if (this.#closeRequested || this.#unhealthy) return;
          this.#discardOwned(id);
        },
      };
    } catch {
      if (!done) {
        done = true; this.#clearTimer(id); yieldPermit();
        if (!this.#discardOwned(id)) this.#markUnhealthy();
      }
      return null;
    } finally { if (fd >= 0) try { closeSync(fd); } catch {} }
  }

  #leasable(id: string, consumerId: string) { this.#reapExpired(); if (this.#closeRequested || this.#unhealthy) return false; const rec = this.#records.get(id); return !!rec && rec.consumerId === consumerId && rec.status === "available"; }
  /** Hands the permit to at most one waiter; a store that is closing wakes every waiter with a refusal instead. */
  #releaseResponse() { this.#responseBytes = 0; for (;;) { const next = this.#responseWaiters.shift(); if (!next) { this.#responseBusy = false; return; } if (this.#closeRequested || this.#unhealthy) { next(false); continue; } next(true); return; } }
  #settleResponses() { const settle = this.#responseSettle; this.#responseSettle = undefined; if (settle) settle(); this.#responseHolder = undefined; this.#responseId = undefined; this.#responseBytes = 0; while (this.#responseWaiters.length) this.#responseWaiters.shift()!(false); this.#responseBusy = false; }

  /**
   * The public, source-compatible discard. `true` means exactly `clean`. `false` collapses `refused`
   * and `failed` — precisely the distinction runtime code must not lose — so runtime code calls
   * {@link discardArtifactDetailed} instead.
   */
  discardArtifact(id: string): boolean { return this.discardArtifactDetailed(id) === "clean"; }

  /** @internal The detailed discard (Amendment 7 §5.1). */
  discardArtifactDetailed(id: string): ArtifactDiscardResult {
    if (typeof id !== "string") throw new ArtifactStoreError("invalid-artifact-id"); if (!ARTIFACT_ID.test(id)) throw new ArtifactStoreError("invalid-artifact-id");
    // REFUSAL COMES FIRST AND IS SIDE-EFFECT-FREE. The closed-runtime boundary opens the moment close
    // is invoked, not when descriptors are finally released: a store awaiting an active capture owns
    // no public mutation. Observed before any timer is cleared, any response settled, any identity
    // read, any callback or any filesystem call — and store close, not this caller, owns the deletion.
    // A DISABLED store acquired no descriptor, lock or directory identity, so it owns no public
    // mutation of the configured tree. It is nevertheless a CLEAN no-op, not a refusal: no artifact
    // could have been committed by this store, and treating the absence as close-owned work retains
    // the operation ID until runtime close. Return before every timer, identity read, callback and
    // filesystem call. The live-store path below remains responsible for proving physical deletion.
    if (!this.#enabled) return "clean";
    if (this.#closeRequested || this.#disposed) return "refused";
    // Poison WITHOUT a requested close is not a refusal: nothing here can prove durable deletion, and
    // no callback may run. It is a failure, and the caller retains its identity for good.
    if (this.#unhealthy) return "failed";
    // A committed record handed to a response lease is that lease's, not this caller's (Amendment 2 §5:
    // "cleanup sees consuming -> skip; consume timeout owns resolution"). Refused ABOVE the owned path,
    // so the live timer stays armed, the response stays unsettled, and no identity read, callback or
    // filesystem call happens — and the ID stays reserved, because a replacement capture must not take
    // the name out from under a response that has not returned. Expiry does not preempt it either: an
    // expired consuming record is skipped by every reaping pass, which is bounded by the lease's exact
    // 15s timeout. Resolution is the lease's `complete()` or that timeout, both of which reach
    // {@link #discardOwned} directly. Nothing here returns the record to `available`.
    if (this.#records.get(id)?.status === "consuming") return "refused";
    return this.#discardOwned(id) ? "clean" : "failed";
  }

  /** Identity-bound cleanup of an artifact this store owns, physical then logical in one step.
   *  Private, and now the LIVE-store path only: close sweeps the two halves separately. */
  #discardOwned(id: string): boolean {
    const deleted = this.#deletePhysical(id);
    if (!deleted) return false;
    this.#releaseDiscarded(id, deleted, false);
    return true;
  }
  /**
   * The PHYSICAL half: the record's timer, the response that may be holding it, identity proof, and
   * the durable unlink. It returns the pre-deletion facts the logical half needs, or `undefined`
   * when durable deletion could not be proven — in which case the store is poisoned and NOTHING
   * logical may move.
   *
   * Split from the logical half because CLOSE owns physical deletion but cannot release logical
   * accounting until its whole ordered teardown is authoritatively clean. `#finishClose()` used to
   * do both in one call, so a `delete-files`, `fsync-data` or teardown failure AFTER it returned
   * `artifact-cleanup-failed` over a count, byte and consumer ledger that had already fallen to zero
   * and an `onDiscard` that had already announced the capacity reusable.
   */
  #deletePhysical(id: string): { existed: boolean; newlyDiscardedInflight: boolean } | undefined {
    this.#clearTimer(id); if (this.#responseId === id) { const settle = this.#responseSettle; this.#responseSettle = undefined; settle?.(); }
    if (!this.#identityProven()) return undefined;
    const existed = this.#records.has(id);
    const newlyDiscardedInflight = this.#inflight.has(id) && !this.#discardedInflight.has(id);
    const clean = this.#strictDelete([join(this.#data, `${id}.pdf`), join(this.#data, `${id}.part`)]);
    if (!clean) { this.#markUnhealthy(); return undefined; }
    return { existed, newlyDiscardedInflight };
  }
  /** The LOGICAL half: the record, the in-flight tombstone, the ONE notification and the committed
   *  reservation. Reached only once durable deletion has actually been proven — and, for a close,
   *  only once the entire ordered close has been proven too. */
  #releaseDiscarded(id: string, deleted: { existed: boolean; newlyDiscardedInflight: boolean }, closeOwned: boolean): void {
    if (deleted.existed) this.#records.delete(id);
    // Install the in-flight tombstone BEFORE notifying. The operation may synchronously invalidate
    // and re-enter discard through its own cleanup path; that nested no-op must not notify recursively.
    if (deleted.newlyDiscardedInflight) this.#discardedInflight.add(id);
    if (deleted.existed || deleted.newlyDiscardedInflight) try { this.#onDiscard?.(id, closeOwned); } catch {}
    // A staging reservation belongs to the running copy body, which releases it when that body exits.
    const reservation = this.#reservations.get(id); if (reservation && !reservation.staging) this.#releaseReservation(reservation);
  }
  /** The ONE close request. Possible after poison (Amendment 7 §4): poison rejects work but tears
   *  nothing down, so an explicit close is still the only thing that can release this root.
   *
   *  The promise and its resolver are PUBLISHED FIRST, before a timer is cancelled, a responder
   *  settled, a step hook run or a byte deleted. This used to assign `#closePromise` from the RESULT
   *  of `new Promise(...)`, whose executor ran the entire synchronous teardown before that assignment
   *  landed — and teardown calls `onDiscard`, whose observer closing the store is the ordinary runtime
   *  shape. The re-entrant call found `#closePromise` still undefined, published a second promise and
   *  took over `#resolveClose`, so the outer teardown resolved the NESTED promise and the promise the
   *  first caller was awaiting never settled at all. Latching first makes every caller — re-entrant or
   *  not — an awaiter of the one promise that the one teardown resolves exactly once. */
  close(): Promise<ArtifactFailureCode | undefined> {
    if (this.#closePromise) return this.#closePromise;
    // A disabled store acquired no descriptor, lock, timer or responder: there is nothing to tear
    // down and nothing that can re-enter. It still publishes ONE already-settled promise so repeated,
    // concurrent and later close callers observe the same close request and the same close result.
    if (!this.#enabled) {
      const promise = Promise.resolve(this.#unhealthy ? "artifact-cleanup-failed" as const : undefined);
      this.#closePromise = promise;
      this.#cancelTimers(); this.#settleResponses();
      return promise;
    }
    let resolve!: (result: ArtifactFailureCode | undefined) => void;
    const promise = new Promise<ArtifactFailureCode | undefined>(r => { resolve = r; });
    this.#closePromise = promise; this.#resolveClose = resolve;
    this.#cancelTimers(); this.#settleResponses();
    this.#closeRequested = true;
    if (this.#activeCaptures === 0) this.#finishClose();
    return promise;
  }
  /** @internal test seam: aggregate accounting only — never IDs, consumers, paths, names, hashes or content. */
  accounting(): ArtifactAccounting { let stagingBytes = 0; for (const reservation of this.#reservations.values()) if (reservation.staging) stagingBytes += reservation.bytes; return { count: this.#ledgerCount, bytes: this.#ledgerBytes, stagingBytes, stagePermits: this.#stagePermits, stagePermitLimit: MAX_STAGE_COPIES, responsePermitHeld: this.#responseHolder !== undefined, responseWaiters: this.#responseWaiters.length, responseBytes: this.#responseBytes, consumers: this.#consumerLedger.size }; }
  /** Atomic: every limit is checked and every counter moved without an intervening await. */
  #reserve(id: string, consumerId: string): Reservation | undefined {
    if (this.#reservations.has(id) || this.#stagePermits >= MAX_STAGE_COPIES) return undefined;
    const consumer = this.#consumerLedger.get(consumerId) ?? { count: 0, bytes: 0 };
    if (this.#ledgerCount + 1 > this.#maxCount || consumer.count + 1 > this.#perConsumerCount) return undefined;
    if (this.#ledgerBytes + MAX_ARTIFACT_BYTES > this.#maxBytes || consumer.bytes + MAX_ARTIFACT_BYTES > this.#perConsumerBytes) return undefined;
    const reservation: Reservation = { id, consumerId, bytes: MAX_ARTIFACT_BYTES, staging: true, released: false };
    this.#reservations.set(id, reservation); this.#ledgerCount++; this.#ledgerBytes += MAX_ARTIFACT_BYTES;
    consumer.count++; consumer.bytes += MAX_ARTIFACT_BYTES; this.#consumerLedger.set(consumerId, consumer); this.#stagePermits++;
    return reservation;
  }
  #shrinkReservation(reservation: Reservation, bytes: number) { if (reservation.released || bytes >= reservation.bytes) return; const freed = reservation.bytes - bytes; reservation.bytes = bytes; this.#ledgerBytes -= freed; const consumer = this.#consumerLedger.get(reservation.consumerId); if (consumer) consumer.bytes -= freed; }
  #releaseStage(reservation: Reservation) { if (!reservation.staging) return; reservation.staging = false; this.#stagePermits--; }
  /** Identity-bound: a stale token can never decrement a replacement reservation for the same ID. */
  #releaseReservation(reservation: Reservation) {
    if (reservation.released || this.#reservations.get(reservation.id) !== reservation) return;
    reservation.released = true; this.#reservations.delete(reservation.id); this.#ledgerCount--; this.#ledgerBytes -= reservation.bytes;
    const consumer = this.#consumerLedger.get(reservation.consumerId);
    if (consumer) { consumer.count--; consumer.bytes -= reservation.bytes; if (consumer.count === 0 && consumer.bytes === 0) this.#consumerLedger.delete(reservation.consumerId); }
  }
  /** The ordered close. Admitted ONLY by an explicit close request with no capture still inside the
   *  store and nothing disposed yet, and guarded so a repeated close and a late capture-finally
   *  callback cannot re-enter a teardown that has already begun.
   *
   *  Close owns PHYSICAL deletion, and only that, until it can prove itself. Every record it sweeps
   *  is deleted here but stays on the books — counted, billed to its consumer, its reservation held
   *  and its `onDiscard` unsent — until the whole ordered teardown below has succeeded. A close that
   *  reports `artifact-cleanup-failed` therefore reports it over the accounting it started with:
   *  releasing at deletion time meant a `delete-files`, `fsync-data` or teardown failure returned a
   *  failure while count, bytes and the consumer ledger had already been zeroed and the callback had
   *  already declared the capacity reusable (B2.2 evidence 5 and 9, Amendment 7 §5.2). */
  #finishClose(): void { if (!this.#closeRequested || this.#activeCaptures !== 0 || this.#disposed || this.#teardownStarted) return; this.#teardownStarted = true; let result: ArtifactFailureCode | undefined; if (!this.#identityProven()) { result = "artifact-cleanup-failed"; this.#closeDescriptors(); const stop = this.#resolveClose; this.#resolveClose = undefined; stop?.(result); return; } try { let recordsClean = true; const swept: Array<[string, { existed: boolean; newlyDiscardedInflight: boolean }]> = []; for (const id of Array.from(this.#records.keys())) { const deleted = this.#deletePhysical(id); if (deleted) swept.push([id, deleted]); else recordsClean = false; } const names = (this.#fsOps.readdirSync ?? readdirSync)(this.#data).filter(n => /^[A-Za-z0-9_-]{22,64}\.(?:part|pdf)$/.test(n)).map(n => join(this.#data, n)); const clean = !this.#closeStepFails?.("delete-files") && this.#strictDelete(names); if (recordsClean && clean) { this.#step("delete-files"); if (!this.#closeStepFails?.("fsync-data") && this.#strictFsyncDataDir()) { this.#step("fsync-data"); try { this.#teardown(); } catch { this.#markUnhealthy(); result = "artifact-cleanup-failed"; } if (result === undefined) for (const [id, deleted] of swept) this.#releaseDiscarded(id, deleted, true); } else { this.#markUnhealthy(); result = "artifact-cleanup-failed"; } } else { this.#markUnhealthy(); result = "artifact-cleanup-failed"; } } catch { this.#markUnhealthy(); result = "artifact-cleanup-failed"; } this.#closeDescriptors(); const resolve = this.#resolveClose; this.#resolveClose = undefined; resolve?.(result); }
  /** The ordered teardown of a clean close, once the data directory is swept and durable. Each step
   * is a precondition of the next: the data descriptor is closed before the directory it refers to is
   * removed, the lock outlives the data it guards, and the root fsync covers every removal above it.
   * Any throw here leaves the lock in place and turns the close into `artifact-cleanup-failed`. */
  #teardown(): void {
    this.#run("close-data-fd", () => this.#closeDataDescriptor());
    this.#run("remove-data", () => this.#removeData());
    this.#removeLock();
    // The lock is already gone by here, so a failed durability fsync cannot retain it — it restores one.
    try { this.#run("fsync-root", () => this.#fsyncRoot()); } catch (e) { this.#restoreLock(); throw e; }
    this.#run("close-root-fd", () => this.#closeRootDescriptor());
  }
  /** One teardown step: it either completes and is reported, or fails and aborts the teardown. */
  #run(step: ArtifactCloseStep, action: () => void): void { if (this.#closeStepFails?.(step)) throw new ArtifactStoreError("artifact-cleanup-failed"); action(); this.#step(step); }
  /** A durability fsync necessarily follows the removal it covers, so this compensation recreates a
   * lock rather than retaining one. Fail-closed and exclusive: if another process already won the
   * freed name, that lock is never read, altered or removed. Failing to restore leaves the close's
   * original `artifact-cleanup-failed` untouched — it never masks it and never upgrades it. */
  #restoreLock(): void {
    try { mkdirSync(this.#lockPath, { mode: 0o700 }); } catch { return; }
    try { this.#claimLock(); } catch { return; }
    // `claimLock` makes the diagnostic's bytes durable, but its *name* lives in this recreated
    // directory. Both are best effort and independent: a failed directory fsync must not skip the
    // root fsync, and neither can mask or replace the close's original cleanup failure.
    try { this.#fsyncLockDir(); } catch {}
    try { this.#fsyncRoot(); } catch {}
  }
  /** Fsync the recreated lock through a descriptor proved to be that directory: opened
   * `O_DIRECTORY|O_NOFOLLOW` and matched against the identity `claimLock` has just recorded, so a
   * directory swapped in underneath is fsynced by nobody. The descriptor is closed exactly once. */
  #fsyncLockDir(): void {
    const identity = this.#lockIdentity; if (!identity) return;
    let fd = -1;
    try {
      fd = openSync(this.#lockPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const st = fstatSync(fd);
      if (!st.isDirectory() || st.dev !== identity.dev || st.ino !== identity.ino || st.uid !== process.getuid?.() || st.uid !== identity.uid || (st.mode & 0o777) !== 0o700 || (st.mode & 0o777) !== identity.mode) return;
      this.#fsOps.fsyncSync(fd);
    } finally { if (fd >= 0) try { closeSync(fd); } catch {} }
  }
  #step(step: ArtifactCloseStep) { try { this.#onCloseStep?.(step); } catch {} }
  // A poisoned store owns no future work: its timers are cancelled and any lease holding or waiting
  // on the response permit is settled here, or a queued acquire would wait for a lease that can no
  // longer settle it.
  // Poison, and ONLY poison: future work is rejected and every timer/responder is settled, but no
  // descriptor, directory, diagnostic or lock teardown happens here. Implying a requested close was
  // what let the next capture's finally remove the `.gateway-lock` of a live root.
  #markUnhealthy() { this.#unhealthy = true; this.#cancelTimers(); this.#settleResponses(); }
  /** One cleanup pass at a time: a timer callback that arrives mid-pass returns without entering. */
  #runCleanupPass() { if (this.#cleanupRunning || this.#closeRequested || this.#unhealthy || !this.#enabled) return; this.#cleanupRunning = true; try { this.#onCleanupPass?.(); this.#reapExpired(); } finally { this.#cleanupRunning = false; this.#scheduleCleanup(); } }
  #scheduleCleanup() { if (this.#closeRequested || this.#unhealthy || !this.#enabled || this.#cleanupTimer !== undefined) return; this.#cleanupTimer = this.#scheduler.setTimeout(() => { this.#cleanupTimer = undefined; this.#runCleanupPass(); }, this.#cleanupIntervalMs); }
  #cancelCleanup() { if (this.#cleanupTimer !== undefined) { this.#scheduler.clearTimeout(this.#cleanupTimer); this.#cleanupTimer = undefined; } }
  #cancelTimers() { this.#cancelCleanup(); for (const id of Array.from(this.#timers.keys())) this.#clearTimer(id); }
  /** No path deletion once identity is unproven: an unlink would run against a tree this store cannot claim. */
  #strictDelete(paths: string[]) { if (this.#identityLost) return false; let ok = true, changed = false; for (const path of paths) { try { this.#fsOps.unlinkSync(path); changed = true; } catch (e: any) { if (e?.code !== "ENOENT") ok = false; } } if (ok && changed && !this.#strictFsyncDataDir()) ok = false; return ok; }
  #fsyncDataDir() { if (this.#dataFd < 0) throw new ArtifactStoreError("artifact-runtime-invalidated"); this.#fsOps.fsyncSync(this.#dataFd); }

  /**
   * One capture file, proved from a DESCRIPTOR and never from a name: a regular file, owned by this
   * process, exactly the size staged, and private to it. `fstat` is what makes it a proof — a name can
   * be replaced between the check and the use, an open file cannot. The returned identity is the inode
   * the validated bytes were written to, which is what a published name is then bound back to.
   *
   * The mask covers setuid/setgid/sticky as well as the permission bits. This file is created `0600`
   * and never legitimately carries any of them, so "exactly 0600" is the whole mode, not just its
   * bottom nine bits.
   */
  #provenFile(fd: number, bytes: number): { dev: number; ino: number } {
    const st = fstatSync(fd);
    if (!provenFileStat({ isFile: st.isFile(), size: st.size, uid: st.uid, mode: st.mode }, bytes)) throw new Error();
    return { dev: st.dev, ino: st.ino };
  }
  /** The publication proof. The name about to be published is opened WITHOUT following a symlink,
   * proved by {@link ArtifactStore.provenFile} to be the private, correctly sized regular file this
   * capture staged, and proved by dev/ino to be that exact inode — so the bytes already read,
   * magic-checked and hashed are the bytes now reachable at `<id>.pdf`. Rereading and rehashing the
   * file instead would prove strictly less: it reopens the same replaceable name and leaves the same
   * window open behind it, at the cost of a second full-size read. It RETURNS the identity it proved,
   * which is what the published record is then bound to and what every consume must find again. */
  #proveLinked(path: string, bytes: number, staged: { dev: number; ino: number }): { dev: number; ino: number } {
    let fd = -1;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const linked = this.#provenFile(fd, bytes);
      if (linked.dev !== staged.dev || linked.ino !== staged.ino) throw new Error();
      return linked;
    } finally { if (fd >= 0) try { closeSync(fd); } catch {} }
  }
  /** The consume-side descriptor proof: everything {@link ArtifactStore.provenFile} decides, AND that
   * the descriptor is the exact inode publication proved. Without the identity clause the proof asks
   * only whether this is A file shaped like the artifact — a question a byte-for-byte copy left at the
   * name by anything sharing this UID answers correctly, size, mode, owner and SHA-256 included.
   * Throws like every other proof in this module, so a mismatch takes the lease's fail-closed path. */
  #provenRecordFile(fd: number, record: StoredRecord): void {
    const proven = this.#provenFile(fd, record.bytes);
    if (proven.dev !== record.dev || proven.ino !== record.ino) throw new Error();
  }

  /** One identity reading. The seam chooses only which directory and which reading; it observes nothing. */
  #readIdentity(target: "root" | "data", source: "descriptor" | "path"): DirIdentity {
    const substitute = this.#identityOverride?.(target, source);
    if (substitute === "unreadable") throw new Error();
    const st = source === "descriptor" ? fstatSync(target === "root" ? this.#rootFd : this.#dataFd) : lstatSync(target === "root" ? this.#root : this.#data);
    return { dev: st.dev, ino: st.ino, uid: st.uid, mode: st.mode & 0o777, directory: st.isDirectory(), ...substitute };
  }
  #privateDirectory(identity: DirIdentity) { return identity.directory && identity.uid === process.getuid?.() && identity.mode === 0o700; }
  #sameDirectory(a: DirIdentity, b: DirIdentity) { return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode && a.directory === b.directory; }
  /** Both retained descriptors and both configured paths still resolve to the private directories this boot bound. */
  #identityHolds() {
    for (const target of ["root", "data"] as const) {
      const recorded = target === "root" ? this.#rootIdentity : this.#dataIdentity;
      if (!recorded || !this.#privateDirectory(recorded)) return false;
      for (const source of ["descriptor", "path"] as const) {
        const current = this.#readIdentity(target, source);
        if (!this.#privateDirectory(current) || !this.#sameDirectory(current, recorded)) return false;
      }
    }
    return true;
  }
  /** Identity proof gates every security-sensitive batch; losing it invalidates the runtime and stops all further work. */
  #identityProven() {
    if (this.#identityLost) return false;
    if (!this.#enabled) return true;
    let holds = false;
    try { holds = this.#rootFd >= 0 && this.#dataFd >= 0 && this.#identityHolds(); } catch { holds = false; }
    if (holds) return true;
    this.#identityLost = true; this.#markUnhealthy(); return false;
  }
  #closeDataDescriptor() { if (this.#dataFd < 0) return; try { closeSync(this.#dataFd); } catch {} this.#dataFd = -1; try { this.#onDescriptorClose?.(); } catch {} }
  #closeRootDescriptor() { if (this.#rootFd < 0) return; try { closeSync(this.#rootFd); } catch {} this.#rootFd = -1; try { this.#onDescriptorClose?.(); } catch {} }
  #closeDescriptors() { this.#closeDataDescriptor(); this.#closeRootDescriptor(); this.#disposed = true; }
  #fsyncRoot(): void { if (this.#rootFd < 0) throw new ArtifactStoreError("artifact-runtime-invalidated"); this.#fsOps.fsyncSync(this.#rootFd); }

  get #lockPath() { return join(this.#root, LOCK_DIR); }
  get #ownerPath() { return join(this.#lockPath, LOCK_OWNER_FILE); }
  /** Bind the lock this constructor just created to this instance. The diagnostic is operator
   * metadata only — version, PID, process start and an opaque nonce. It carries no configured path,
   * consumer, artifact ID or content, and the nonce is never a bearer credential or licence to steal
   * a lock. Process start comes from the one scheduler, so it is never a second time domain. */
  #claimLock(): void {
    const lock = lstatSync(this.#lockPath);
    if (!lock.isDirectory() || lock.uid !== process.getuid?.() || (lock.mode & 0o777) !== 0o700) throw new Error();
    this.#lockIdentity = { dev: lock.dev, ino: lock.ino, uid: lock.uid, mode: lock.mode & 0o777 };
    const nonce = randomBytes(24).toString("base64url");
    // Sampled once and kept: ownership is proved against the exact value written, never against a
    // fresh reading of the scheduler.
    const startedAt = this.#scheduler.processStartedAt();
    const body = Buffer.from(JSON.stringify({ version: LOCK_METADATA_VERSION, pid: process.pid, startedAt, nonce }), "utf8");
    // O_EXCL|O_NOFOLLOW at mode 0600: the diagnostic is created here or not at all, and an existing
    // name — symlink or otherwise — is never written through.
    const fd = openSync(this.#ownerPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { let off = 0; while (off < body.length) off += writeSync(fd, body, off, body.length - off, off); fsyncSync(fd); } finally { closeSync(fd); }
    const owner = lstatSync(this.#ownerPath);
    if (!owner.isFile() || owner.nlink !== 1 || owner.uid !== process.getuid?.() || (owner.mode & 0o777) !== 0o600) throw new Error();
    this.#ownerIdentity = { dev: owner.dev, ino: owner.ino, uid: owner.uid, mode: owner.mode & 0o777 };
    this.#lockStartedAt = startedAt; this.#lockNonce = nonce;
  }
  /** Constructor rollback only, and best effort: the diagnostic cannot outlive the directory holding
   * it, so it goes first. A failure here never masks the startup error being thrown. */
  #rollbackLock(): void {
    // Once identity is recorded, only the directory this boot created is removable. Before that —
    // the narrow window where `claimLock` failed early — no diagnostic is unlinked at all and the
    // bare `rmdir` can only succeed on the empty directory `mkdir` just made.
    if (this.#lockIdentity) { if (!this.#lockHeld()) return; try { unlinkSync(this.#ownerPath); } catch {} }
    try { rmdirSync(this.#lockPath); } catch {}
  }
  /** The lock removed must be the directory this store created — same device, inode, owner and mode.
   * Identical contents prove nothing: only the retained identity distinguishes it from a replacement. */
  #lockHeld(): boolean {
    if (!this.#lockIdentity) return false;
    let st; try { st = lstatSync(this.#lockPath); } catch { return false; }
    return st.isDirectory() && st.dev === this.#lockIdentity.dev && st.ino === this.#lockIdentity.ino && st.uid === this.#lockIdentity.uid && (st.mode & 0o777) === this.#lockIdentity.mode;
  }
  /** The diagnostic must still be the private regular file this instance wrote, and must still carry
   * the nonce only this instance holds. Opened `O_NOFOLLOW`, so a symlink left at the name fails here
   * rather than being read or removed through to its target. */
  #diagnosticOwned(): boolean {
    if (!this.#ownerIdentity || !this.#lockNonce) return false;
    let fd = -1;
    try {
      fd = openSync(this.#ownerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const st = fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.() || st.dev !== this.#ownerIdentity.dev || st.ino !== this.#ownerIdentity.ino || st.uid !== this.#ownerIdentity.uid || (st.mode & 0o777) !== this.#ownerIdentity.mode) return false;
      const buf = Buffer.alloc(st.size); let off = 0;
      while (off < buf.length) { const n = readSync(fd, buf, off, buf.length - off, off); if (n <= 0) return false; off += n; }
      // Owned by what it says, not merely by parsing: a plain object carrying exactly the closed key
      // set, every value equal to what this boot wrote. An extra field, a missing one, a rewritten
      // process start or an array all fail here.
      const meta = JSON.parse(buf.toString("utf8"));
      if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return false;
      const keys = Object.keys(meta).sort();
      if (keys.length !== 4 || keys[0] !== "nonce" || keys[1] !== "pid" || keys[2] !== "startedAt" || keys[3] !== "version") return false;
      return meta.version === LOCK_METADATA_VERSION && meta.pid === process.pid && meta.startedAt === this.#lockStartedAt && meta.nonce === this.#lockNonce;
    } catch { return false; } finally { if (fd >= 0) try { closeSync(fd); } catch {} }
  }
  /** `data` goes only when it is empty: `rmdir` refuses a directory holding anything this store did
   * not create and sweep, and that refusal is what retains the lock. Nothing is ever removed recursively. */
  #removeData(): void { rmdirSync(this.#data); }
  /** Graceful removal, in the only order that can succeed. Any failure propagates: the lock stays. */
  #removeLock(): void { if (!this.#lockHeld() || !this.#diagnosticOwned()) throw new ArtifactStoreError("artifact-cleanup-failed"); this.#run("remove-diagnostic", () => unlinkSync(this.#ownerPath)); this.#run("remove-lock", () => (this.#fsOps.rmdirSync ?? rmdirSync)(this.#lockPath)); }
  #strictFsyncDataDir() { try { this.#fsyncDataDir(); return true; } catch { return false; } }
  #clearTimer(id: string) { const t = this.#timers.get(id); if (t !== undefined) this.#scheduler.clearTimeout(t); this.#timers.delete(id); }
  #reapExpired() { for (const [id, rec] of Array.from(this.#records.entries())) if (this.#scheduler.now() >= rec.expiresAt) this.discardArtifact(id); }
}
