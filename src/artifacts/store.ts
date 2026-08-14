import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { fstatSync, fsyncSync, mkdirSync, openSync, closeSync, readSync, writeSync, readdirSync, rmdirSync, lstatSync, linkSync, unlinkSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { ARTIFACT_ID, ArtifactStoreError, type ArtifactAccounting, type ArtifactCloseStep, type ArtifactRecord, type ArtifactScheduler, type ArtifactStoreOptions, type CaptureOptions, type CaptureResult, type ResponseLease, type ArtifactFailureCode } from "./types.js";

const PDF_MAGIC = Buffer.from("%PDF-");
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const DEFAULT_CLEANUP_INTERVAL_MS = 60_000;
const RESPONSE_LEASE_MS = 15_000;
const MAX_STAGE_COPIES = 2;
/** One capture's claim on count and bytes. It is created before the source is opened, converted from staging to committed by publication, and released exactly once. */
interface Reservation { readonly id: string; readonly consumerId: string; bytes: number; staging: boolean; released: boolean; }
/** Retained-directory identity. Private to this module: it never crosses a seam or a public type. */
interface DirIdentity { dev: number; ino: number; uid: number; mode: number; directory: boolean; }
/** Retained identity of the lock directory and its diagnostic. Module-private, like `DirIdentity`. */
interface LockIdentity { dev: number; ino: number; uid: number; mode: number; }
const LOCK_DIR = ".gateway-lock";
const LOCK_OWNER_FILE = "owner.json";
const LOCK_METADATA_VERSION = 1;
// OS-derived and sampled once, so the whole process reports one stable start instant.
const PROCESS_STARTED_AT = Math.round(Date.now() - process.uptime() * 1000);
const SYSTEM_SCHEDULER: ArtifactScheduler = {
  now: () => Date.now(),
  processStartedAt: () => PROCESS_STARTED_AT,
  // Artifact timers are background cleanup/deadline work: they must never be the sole reason a process stays alive.
  setTimeout: (callback, delayMs) => { const handle = setTimeout(callback, delayMs); (handle as { unref?: () => void }).unref?.(); return handle; },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class ArtifactStore {
  readonly enabled: boolean;
  private readonly root: string; private readonly data: string; private readonly scheduler: ArtifactScheduler;
  private readonly ttlMs: number; private readonly cleanupIntervalMs: number; private readonly maxBytes: number; private readonly maxCount: number;
  private readonly perConsumerBytes: number; private readonly perConsumerCount: number;
  private readonly fsOps: NonNullable<ArtifactStoreOptions["fsOps"]>; private readonly afterPartFsync?: ArtifactStoreOptions["afterPartFsync"]; private readonly afterLinkBeforeCommit?: ArtifactStoreOptions["afterLinkBeforeCommit"];
  private closed = false; private unhealthy = false; private activeCaptures = 0;
  private closePromise?: Promise<ArtifactFailureCode | undefined>; private resolveClose?: (result: ArtifactFailureCode | undefined) => void;
  private readonly inflight = new Set<string>(); private readonly onDiscard?: (id: string) => void; private readonly onCleanupPass?: () => void;
  private records = new Map<string, ArtifactRecord>(); private timers = new Map<string, unknown>();
  private cleanupTimer?: unknown; private cleanupRunning = false;
  private readonly reservations = new Map<string, Reservation>(); private readonly consumerLedger = new Map<string, { count: number; bytes: number }>();
  private ledgerCount = 0; private ledgerBytes = 0; private stagePermits = 0;
  private responseBusy = false; private responseHolder?: object; private responseId?: string; private responseBytes = 0; private responseSettle?: () => void;
  private readonly responseWaiters: Array<(granted: boolean) => void> = [];
  private rootFd = -1; private dataFd = -1; private rootIdentity?: DirIdentity; private dataIdentity?: DirIdentity; private identityLost = false; private disposed = false;
  private lockNonce = ""; private lockStartedAt = 0; private lockIdentity?: LockIdentity; private ownerIdentity?: LockIdentity;
  private readonly identityOverride?: ArtifactStoreOptions["identityOverride"]; private readonly afterRootDescriptor?: () => void;
  private readonly onDataPathOpen?: () => void; private readonly onDescriptorClose?: () => void; private readonly onCloseStep?: ArtifactStoreOptions["onCloseStep"]; private readonly closeStepFails?: ArtifactStoreOptions["closeStepFails"];

  constructor(options: ArtifactStoreOptions) {
    this.enabled = options.enabled !== false; this.root = options.root; this.data = join(this.root, "data");
    this.scheduler = options.scheduler ?? SYSTEM_SCHEDULER; this.ttlMs = options.ttlMs ?? 600_000; this.cleanupIntervalMs = options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS; this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    this.maxCount = options.maxCount ?? 16; this.perConsumerBytes = options.perConsumerBytes ?? 16 * 1024 * 1024; this.perConsumerCount = options.perConsumerCount ?? 4;
    this.fsOps = options.fsOps ?? { linkSync, unlinkSync, fsyncSync }; this.onDiscard = options.onDiscard; this.onCleanupPass = options.onCleanupPass; this.afterPartFsync = options.afterPartFsync; this.afterLinkBeforeCommit = options.afterLinkBeforeCommit;
    this.identityOverride = options.identityOverride; this.afterRootDescriptor = options.afterRootDescriptor; this.onDataPathOpen = options.onDataPathOpen; this.onDescriptorClose = options.onDescriptorClose; this.onCloseStep = options.onCloseStep; this.closeStepFails = options.closeStepFails;
    if (!isAbsolute(this.root) || !Number.isFinite(this.ttlMs) || this.ttlMs <= 0 || !Number.isInteger(this.cleanupIntervalMs) || this.cleanupIntervalMs <= 0 || !Number.isFinite(this.maxBytes) || this.maxBytes <= 0 || !Number.isFinite(this.maxCount) || this.maxCount <= 0 || !Number.isFinite(this.perConsumerBytes) || this.perConsumerBytes <= 0 || !Number.isFinite(this.perConsumerCount) || this.perConsumerCount <= 0) throw new ArtifactStoreError("artifact-config-invalid");
    if (!this.enabled) return;
    if (process.platform !== "linux" || constants.O_NOFOLLOW === undefined || constants.O_DIRECTORY === undefined) throw new ArtifactStoreError("artifact-filesystem-unsupported");
    try { mkdirSync(this.root, { recursive: true, mode: 0o700 }); } catch { throw new ArtifactStoreError("artifact-root-invalid"); }
    try { const existing = lstatSync(this.root); if (!existing.isDirectory() || existing.uid !== process.getuid?.()) throw new Error(); } catch { throw new ArtifactStoreError("artifact-root-invalid"); }
    // A pre-existing lock always refuses here: it is never read, opened or removed.
    try { mkdirSync(this.lockPath, { mode: 0o700 }); } catch { throw new ArtifactStoreError("artifact-root-locked"); }
    try { this.claimLock(); } catch { this.rollbackLock(); throw new ArtifactStoreError("artifact-root-invalid"); }
    try {
      const rootStat = lstatSync(this.root); if (!rootStat.isDirectory() || rootStat.uid !== process.getuid?.() || (rootStat.mode & 0o777) !== 0o700) throw new Error();
      mkdirSync(this.data, { recursive: true, mode: 0o700 }); const dataStat = lstatSync(this.data); if (!dataStat.isDirectory() || dataStat.uid !== process.getuid?.() || (dataStat.mode & 0o777) !== 0o700) throw new Error();
    } catch { this.rollbackLock(); throw new ArtifactStoreError("artifact-root-invalid"); }
    // Still pre-mutation: retain both directory descriptors and bind them to the configured paths,
    // so every later mutation can prove it is acting on the tree this boot validated.
    try {
      this.rootFd = openSync(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      this.afterRootDescriptor?.();
      this.dataFd = openSync(this.data, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      this.onDataPathOpen?.();
      this.rootIdentity = this.readIdentity("root", "descriptor"); this.dataIdentity = this.readIdentity("data", "descriptor");
      if (!this.identityHolds()) throw new Error();
    } catch { this.closeDescriptors(); this.rollbackLock(); throw new ArtifactStoreError("artifact-root-invalid"); }
    try {
      let changed = false;
      const entries = readdirSync(this.data).sort();
      const paths: string[] = [];
      for (const name of entries) { if (!/^[A-Za-z0-9_-]{22,64}\.(?:part|pdf)$/.test(name)) throw new ArtifactStoreError("artifact-root-invalid"); const path = join(this.data, name); const st = lstatSync(path); if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o600) throw new ArtifactStoreError("artifact-root-invalid"); paths.push(path); }
      for (const path of paths) { this.fsOps.unlinkSync(path); changed = true; }
      if (changed) this.fsyncDataDir();
    } catch (e) { this.closeDescriptors(); if (e instanceof ArtifactStoreError && e.code === "artifact-root-invalid") { this.rollbackLock(); throw e; } throw new ArtifactStoreError("artifact-cleanup-failed"); }
    this.scheduleCleanup();
  }

  async capture(source: string, options: CaptureOptions): Promise<CaptureResult> {
    if (typeof options.id !== "string") throw new ArtifactStoreError("invalid-artifact-id");
    if (options.ttlMs !== undefined && (!Number.isFinite(options.ttlMs) || !Number.isInteger(options.ttlMs) || options.ttlMs <= 0)) return { status: "capture-failed", failure: "artifact-config-invalid" };
    this.reapExpired();
    if (!ARTIFACT_ID.test(options.id)) throw new ArtifactStoreError("invalid-artifact-id");
    if (this.closed || this.unhealthy || !this.enabled) return { status: "capture-failed", failure: "artifact-runtime-invalidated" };
    if (this.records.has(options.id) || this.inflight.has(options.id)) return { status: "capture-failed", failure: "artifact-capacity" };
    // Count, bytes and the stage permit are claimed in one synchronous step before the source is
    // opened or any destination exists, so a rejected reservation touches nothing.
    const reservation = this.reserve(options.id, options.consumerId);
    if (!reservation) return { status: "capture-failed", failure: "artifact-capacity" };
    this.inflight.add(options.id); this.activeCaptures++;
    let fd = -1, out = -1; let part: string | undefined; let final: string | undefined; let linked = false; let committed = false, retain = false;
    try {
      fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW); const initial = fstatSync(fd);
      if (!initial.isFile() || initial.size > MAX_ARTIFACT_BYTES) return { status: "capture-failed", failure: "artifact-size-limit" };
      if (initial.size < PDF_MAGIC.length) return { status: "capture-failed", failure: "artifact-not-pdf" };
      // Exact size known: hand back the unused part of the pessimistic reservation immediately.
      this.shrinkReservation(reservation, initial.size);
      const buf = Buffer.alloc(initial.size); let off = 0; while (off < buf.length) { const n = readSync(fd, buf, off, buf.length - off, off); if (n <= 0) throw new Error(); off += n; }
      const end = fstatSync(fd); if (end.size !== initial.size || !buf.subarray(0, 5).equals(PDF_MAGIC)) return { status: "capture-failed", failure: "artifact-integrity-failed" };
      // The destination is this store's first mutation of the tree, so it needs identity proof too.
      if (!this.identityProven()) return { status: "capture-failed", failure: "artifact-runtime-invalidated" };
      part = join(this.data, `${options.id}.part`); final = join(this.data, `${options.id}.pdf`); out = openSync(part, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      let written = 0; while (written < buf.length) { const n = writeSync(out, buf, written, buf.length - written, written); if (n <= 0) throw new Error(); written += n; } this.fsOps.fsyncSync(out); closeSync(out); out = -1; if (this.afterPartFsync) await this.afterPartFsync();
      if (this.closed || this.unhealthy) return { status: "capture-failed", failure: "artifact-runtime-invalidated" };
      // Immediately before link and commit: a staged file whose tree can no longer be proven stays
      // where it is, and its capacity stays reserved.
      if (!this.identityProven()) { retain = true; return { status: "capture-failed", failure: "artifact-runtime-invalidated" }; }
      this.fsOps.linkSync(part, final); linked = true; this.fsOps.unlinkSync(part); part = undefined; this.fsyncDataDir();
      if (this.afterLinkBeforeCommit) await this.afterLinkBeforeCommit();
      // The commit window is an await: the tree must still be provable at metadata commit, not only
      // before the link. An unprovable tree leaves the linked artifact, its capacity and the lock alone.
      if (!this.identityProven()) { retain = true; return { status: "capture-failed", failure: "artifact-runtime-invalidated" }; }
      if (this.closed || this.unhealthy) { const clean = this.strictDelete([final]); if (!clean) { retain = true; this.markUnhealthy(); return { status: "capture-failed", failure: "artifact-cleanup-failed" }; } return { status: "capture-failed", failure: "artifact-runtime-invalidated" }; }
      const createdAt = this.scheduler.now(); const record: ArtifactRecord = { id: options.id, consumerId: options.consumerId, bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex"), createdAt, expiresAt: createdAt + (options.ttlMs ?? this.ttlMs), status: "available" };
      // Publication converts this reservation from staging to committed; it never releases and reacquires.
      this.records.set(options.id, record); committed = true; return record;
    } catch {
      if (out >= 0) try { closeSync(out); } catch {}
      const clean = this.strictDelete([part, linked ? final : undefined].filter((x): x is string => !!x));
      if (!clean) { retain = true; this.markUnhealthy(); return { status: "capture-failed", failure: "artifact-cleanup-failed" }; }
      return { status: "capture-failed", failure: "artifact-write-failed" };
    // The copy body has exited, so its stage permit is always returned; capacity that a failed
    // cleanup may still occupy on disk stays reserved until deletion is confirmed.
    } finally { if (fd >= 0) try { closeSync(fd); } catch {} this.releaseStage(reservation); if (!committed && !retain) this.releaseReservation(reservation); this.inflight.delete(options.id); this.activeCaptures--; if (this.closed && this.activeCaptures === 0) this.finishClose(); }
  }

  acquire(id: string, consumerId: string): Promise<ResponseLease | null> {
    if (typeof id !== "string") throw new ArtifactStoreError("invalid-artifact-id");
    if (!ARTIFACT_ID.test(id)) throw new ArtifactStoreError("invalid-artifact-id");
    return this.lease(id, consumerId);
  }

  /** One global response permit. A waiter holds nothing: it cannot mark its artifact consuming, open a file or start a deadline until it is admitted. */
  private async lease(id: string, consumerId: string): Promise<ResponseLease | null> {
    if (!this.leasable(id, consumerId)) return null;
    if (this.responseBusy) { if (!await new Promise<boolean>(resolve => { this.responseWaiters.push(resolve); })) return null; if (!this.leasable(id, consumerId)) { this.releaseResponse(); return null; } }
    else this.responseBusy = true;
    const rec = this.records.get(id)!;
    if (!this.identityProven()) { if (this.responseBusy) this.releaseResponse(); return null; }
    const holder = {}; this.responseHolder = holder; this.responseId = id;
    const yieldPermit = () => { if (this.responseHolder !== holder) return; this.responseHolder = undefined; this.responseId = undefined; this.responseSettle = undefined; this.releaseResponse(); };
    const path = join(this.data, `${id}.pdf`); let fd = -1;
    try { const deadline = this.scheduler.now() + RESPONSE_LEASE_MS; fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); const st = fstatSync(fd); if (st.size !== rec.bytes) throw new Error(); const buf = Buffer.alloc(rec.bytes); let off = 0; while (off < buf.length) { const n = readSync(fd, buf, off, buf.length - off, off); if (n <= 0) throw new Error(); off += n; } if (fstatSync(fd).size !== rec.bytes || createHash("sha256").update(buf).digest("hex") !== rec.sha256) throw new Error(); rec.status = "consuming"; this.responseBytes = buf.length; let done = false; this.responseSettle = () => { done = true; yieldPermit(); }; const timer = this.scheduler.setTimeout(() => { this.timers.delete(id); if (done || this.closed || this.unhealthy) return; done = true; yieldPermit(); this.discardOwned(id); }, Math.max(0, deadline - this.scheduler.now())); this.timers.set(id, timer); return { record: rec, bytes: buf.length, base64: buf.toString("base64"), deadline, complete: () => { if (done) return; done = true; this.clearTimer(id); yieldPermit(); if (this.closed || this.unhealthy) return; this.discardOwned(id); } }; }
    catch { yieldPermit(); if (!this.discardOwned(id)) this.markUnhealthy(); return null; } finally { if (fd >= 0) try { closeSync(fd); } catch {} }
  }

  private leasable(id: string, consumerId: string) { this.reapExpired(); if (this.closed || this.unhealthy) return false; const rec = this.records.get(id); return !!rec && rec.consumerId === consumerId && rec.status === "available"; }
  /** Hands the permit to at most one waiter; a store that is closing wakes every waiter with a refusal instead. */
  private releaseResponse() { this.responseBytes = 0; for (;;) { const next = this.responseWaiters.shift(); if (!next) { this.responseBusy = false; return; } if (this.closed || this.unhealthy) { next(false); continue; } next(true); return; } }
  private settleResponses() { const settle = this.responseSettle; this.responseSettle = undefined; if (settle) settle(); this.responseHolder = undefined; this.responseId = undefined; this.responseBytes = 0; while (this.responseWaiters.length) this.responseWaiters.shift()!(false); this.responseBusy = false; }

  discardArtifact(id: string): boolean {
    if (typeof id !== "string") throw new ArtifactStoreError("invalid-artifact-id"); if (!ARTIFACT_ID.test(id)) throw new ArtifactStoreError("invalid-artifact-id");
    // The closed-runtime boundary opens the moment close is invoked, not when descriptors are
    // finally released: a store awaiting an active capture still owns no public mutation. Refuse
    // before any timer, settlement, identity read or filesystem call.
    if (this.closed || this.disposed) return false;
    return this.discardOwned(id);
  }

  /** Identity-bound cleanup of an artifact this store owns. Private: callers are live-store paths and close's own sweep. */
  private discardOwned(id: string): boolean {
    this.clearTimer(id); if (this.responseId === id) { const settle = this.responseSettle; this.responseSettle = undefined; settle?.(); }
    if (!this.identityProven()) return false;
    const existed = this.records.has(id); const clean = this.strictDelete([join(this.data, `${id}.pdf`), join(this.data, `${id}.part`)]);
    if (!clean) { this.markUnhealthy(); return false; }
    if (existed) { this.records.delete(id); try { this.onDiscard?.(id); } catch {} }
    // A staging reservation belongs to the running copy body, which releases it when that body exits.
    const reservation = this.reservations.get(id); if (reservation && !reservation.staging) this.releaseReservation(reservation);
    return true;
  }
  close(): Promise<ArtifactFailureCode | undefined> { if (this.closePromise) return this.closePromise; this.cancelTimers(); this.settleResponses(); if (!this.enabled || this.closed && !this.unhealthy) return Promise.resolve(this.unhealthy ? "artifact-cleanup-failed" : undefined); this.closed = true; this.closePromise = new Promise(resolve => { this.resolveClose = resolve; if (this.activeCaptures === 0) this.finishClose(); }); return this.closePromise; }
  /** @internal test seam: aggregate accounting only — never IDs, consumers, paths, names, hashes or content. */
  accounting(): ArtifactAccounting { let stagingBytes = 0; for (const reservation of this.reservations.values()) if (reservation.staging) stagingBytes += reservation.bytes; return { count: this.ledgerCount, bytes: this.ledgerBytes, stagingBytes, stagePermits: this.stagePermits, stagePermitLimit: MAX_STAGE_COPIES, responsePermitHeld: this.responseHolder !== undefined, responseWaiters: this.responseWaiters.length, responseBytes: this.responseBytes, consumers: this.consumerLedger.size }; }
  /** Atomic: every limit is checked and every counter moved without an intervening await. */
  private reserve(id: string, consumerId: string): Reservation | undefined {
    if (this.reservations.has(id) || this.stagePermits >= MAX_STAGE_COPIES) return undefined;
    const consumer = this.consumerLedger.get(consumerId) ?? { count: 0, bytes: 0 };
    if (this.ledgerCount + 1 > this.maxCount || consumer.count + 1 > this.perConsumerCount) return undefined;
    if (this.ledgerBytes + MAX_ARTIFACT_BYTES > this.maxBytes || consumer.bytes + MAX_ARTIFACT_BYTES > this.perConsumerBytes) return undefined;
    const reservation: Reservation = { id, consumerId, bytes: MAX_ARTIFACT_BYTES, staging: true, released: false };
    this.reservations.set(id, reservation); this.ledgerCount++; this.ledgerBytes += MAX_ARTIFACT_BYTES;
    consumer.count++; consumer.bytes += MAX_ARTIFACT_BYTES; this.consumerLedger.set(consumerId, consumer); this.stagePermits++;
    return reservation;
  }
  private shrinkReservation(reservation: Reservation, bytes: number) { if (reservation.released || bytes >= reservation.bytes) return; const freed = reservation.bytes - bytes; reservation.bytes = bytes; this.ledgerBytes -= freed; const consumer = this.consumerLedger.get(reservation.consumerId); if (consumer) consumer.bytes -= freed; }
  private releaseStage(reservation: Reservation) { if (!reservation.staging) return; reservation.staging = false; this.stagePermits--; }
  /** Identity-bound: a stale token can never decrement a replacement reservation for the same ID. */
  private releaseReservation(reservation: Reservation) {
    if (reservation.released || this.reservations.get(reservation.id) !== reservation) return;
    reservation.released = true; this.reservations.delete(reservation.id); this.ledgerCount--; this.ledgerBytes -= reservation.bytes;
    const consumer = this.consumerLedger.get(reservation.consumerId);
    if (consumer) { consumer.count--; consumer.bytes -= reservation.bytes; if (consumer.count === 0 && consumer.bytes === 0) this.consumerLedger.delete(reservation.consumerId); }
  }
  private finishClose(): void { let result: ArtifactFailureCode | undefined; if (!this.identityProven()) { result = "artifact-cleanup-failed"; this.closeDescriptors(); const stop = this.resolveClose; this.resolveClose = undefined; stop?.(result); return; } try { let recordsClean = true; for (const id of Array.from(this.records.keys())) if (!this.discardOwned(id)) recordsClean = false; const names = (this.fsOps.readdirSync ?? readdirSync)(this.data).filter(n => /^[A-Za-z0-9_-]{22,64}\.(?:part|pdf)$/.test(n)).map(n => join(this.data, n)); const clean = !this.closeStepFails?.("delete-files") && this.strictDelete(names); if (recordsClean && clean) { this.step("delete-files"); if (!this.closeStepFails?.("fsync-data") && this.strictFsyncDataDir()) { this.step("fsync-data"); try { this.teardown(); } catch { this.markUnhealthy(); result = "artifact-cleanup-failed"; } } else { this.markUnhealthy(); result = "artifact-cleanup-failed"; } } else { this.markUnhealthy(); result = "artifact-cleanup-failed"; } } catch { this.markUnhealthy(); result = "artifact-cleanup-failed"; } this.closeDescriptors(); const resolve = this.resolveClose; this.resolveClose = undefined; resolve?.(result); }
  /** The ordered teardown of a clean close, once the data directory is swept and durable. Each step
   * is a precondition of the next: the data descriptor is closed before the directory it refers to is
   * removed, the lock outlives the data it guards, and the root fsync covers every removal above it.
   * Any throw here leaves the lock in place and turns the close into `artifact-cleanup-failed`. */
  private teardown(): void {
    this.run("close-data-fd", () => this.closeDataDescriptor());
    this.run("remove-data", () => this.removeData());
    this.removeLock();
    // The lock is already gone by here, so a failed durability fsync cannot retain it — it restores one.
    try { this.run("fsync-root", () => this.fsyncRoot()); } catch (e) { this.restoreLock(); throw e; }
    this.run("close-root-fd", () => this.closeRootDescriptor());
  }
  /** One teardown step: it either completes and is reported, or fails and aborts the teardown. */
  private run(step: ArtifactCloseStep, action: () => void): void { if (this.closeStepFails?.(step)) throw new ArtifactStoreError("artifact-cleanup-failed"); action(); this.step(step); }
  /** A durability fsync necessarily follows the removal it covers, so this compensation recreates a
   * lock rather than retaining one. Fail-closed and exclusive: if another process already won the
   * freed name, that lock is never read, altered or removed. Failing to restore leaves the close's
   * original `artifact-cleanup-failed` untouched — it never masks it and never upgrades it. */
  private restoreLock(): void {
    try { mkdirSync(this.lockPath, { mode: 0o700 }); } catch { return; }
    try { this.claimLock(); } catch { return; }
    // `claimLock` makes the diagnostic's bytes durable, but its *name* lives in this recreated
    // directory. Both are best effort and independent: a failed directory fsync must not skip the
    // root fsync, and neither can mask or replace the close's original cleanup failure.
    try { this.fsyncLockDir(); } catch {}
    try { this.fsyncRoot(); } catch {}
  }
  /** Fsync the recreated lock through a descriptor proved to be that directory: opened
   * `O_DIRECTORY|O_NOFOLLOW` and matched against the identity `claimLock` has just recorded, so a
   * directory swapped in underneath is fsynced by nobody. The descriptor is closed exactly once. */
  private fsyncLockDir(): void {
    const identity = this.lockIdentity; if (!identity) return;
    let fd = -1;
    try {
      fd = openSync(this.lockPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const st = fstatSync(fd);
      if (!st.isDirectory() || st.dev !== identity.dev || st.ino !== identity.ino || st.uid !== process.getuid?.() || st.uid !== identity.uid || (st.mode & 0o777) !== 0o700 || (st.mode & 0o777) !== identity.mode) return;
      this.fsOps.fsyncSync(fd);
    } finally { if (fd >= 0) try { closeSync(fd); } catch {} }
  }
  private step(step: ArtifactCloseStep) { try { this.onCloseStep?.(step); } catch {} }
  // A poisoned store owns no future work: its timers are cancelled and any lease holding or waiting
  // on the response permit is settled here, or a queued acquire would wait for a lease that can no
  // longer settle it.
  private markUnhealthy() { this.unhealthy = true; this.closed = true; this.cancelTimers(); this.settleResponses(); }
  /** One cleanup pass at a time: a timer callback that arrives mid-pass returns without entering. */
  private runCleanupPass() { if (this.cleanupRunning || this.closed || this.unhealthy || !this.enabled) return; this.cleanupRunning = true; try { this.onCleanupPass?.(); this.reapExpired(); } finally { this.cleanupRunning = false; this.scheduleCleanup(); } }
  private scheduleCleanup() { if (this.closed || this.unhealthy || !this.enabled || this.cleanupTimer !== undefined) return; this.cleanupTimer = this.scheduler.setTimeout(() => { this.cleanupTimer = undefined; this.runCleanupPass(); }, this.cleanupIntervalMs); }
  private cancelCleanup() { if (this.cleanupTimer !== undefined) { this.scheduler.clearTimeout(this.cleanupTimer); this.cleanupTimer = undefined; } }
  private cancelTimers() { this.cancelCleanup(); for (const id of Array.from(this.timers.keys())) this.clearTimer(id); }
  /** No path deletion once identity is unproven: an unlink would run against a tree this store cannot claim. */
  private strictDelete(paths: string[]) { if (this.identityLost) return false; let ok = true, changed = false; for (const path of paths) { try { this.fsOps.unlinkSync(path); changed = true; } catch (e: any) { if (e?.code !== "ENOENT") ok = false; } } if (ok && changed && !this.strictFsyncDataDir()) ok = false; return ok; }
  private fsyncDataDir() { if (this.dataFd < 0) throw new ArtifactStoreError("artifact-runtime-invalidated"); this.fsOps.fsyncSync(this.dataFd); }

  /** One identity reading. The seam chooses only which directory and which reading; it observes nothing. */
  private readIdentity(target: "root" | "data", source: "descriptor" | "path"): DirIdentity {
    const substitute = this.identityOverride?.(target, source);
    if (substitute === "unreadable") throw new Error();
    const st = source === "descriptor" ? fstatSync(target === "root" ? this.rootFd : this.dataFd) : lstatSync(target === "root" ? this.root : this.data);
    return { dev: st.dev, ino: st.ino, uid: st.uid, mode: st.mode & 0o777, directory: st.isDirectory(), ...substitute };
  }
  private privateDirectory(identity: DirIdentity) { return identity.directory && identity.uid === process.getuid?.() && identity.mode === 0o700; }
  private sameDirectory(a: DirIdentity, b: DirIdentity) { return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode && a.directory === b.directory; }
  /** Both retained descriptors and both configured paths still resolve to the private directories this boot bound. */
  private identityHolds() {
    for (const target of ["root", "data"] as const) {
      const recorded = target === "root" ? this.rootIdentity : this.dataIdentity;
      if (!recorded || !this.privateDirectory(recorded)) return false;
      for (const source of ["descriptor", "path"] as const) {
        const current = this.readIdentity(target, source);
        if (!this.privateDirectory(current) || !this.sameDirectory(current, recorded)) return false;
      }
    }
    return true;
  }
  /** Identity proof gates every security-sensitive batch; losing it invalidates the runtime and stops all further work. */
  private identityProven() {
    if (this.identityLost) return false;
    if (!this.enabled) return true;
    let holds = false;
    try { holds = this.rootFd >= 0 && this.dataFd >= 0 && this.identityHolds(); } catch { holds = false; }
    if (holds) return true;
    this.identityLost = true; this.markUnhealthy(); return false;
  }
  private closeDataDescriptor() { if (this.dataFd < 0) return; try { closeSync(this.dataFd); } catch {} this.dataFd = -1; try { this.onDescriptorClose?.(); } catch {} }
  private closeRootDescriptor() { if (this.rootFd < 0) return; try { closeSync(this.rootFd); } catch {} this.rootFd = -1; try { this.onDescriptorClose?.(); } catch {} }
  private closeDescriptors() { this.closeDataDescriptor(); this.closeRootDescriptor(); this.disposed = true; }
  private fsyncRoot(): void { if (this.rootFd < 0) throw new ArtifactStoreError("artifact-runtime-invalidated"); this.fsOps.fsyncSync(this.rootFd); }

  private get lockPath() { return join(this.root, LOCK_DIR); }
  private get ownerPath() { return join(this.lockPath, LOCK_OWNER_FILE); }
  /** Bind the lock this constructor just created to this instance. The diagnostic is operator
   * metadata only — version, PID, process start and an opaque nonce. It carries no configured path,
   * consumer, artifact ID or content, and the nonce is never a bearer credential or licence to steal
   * a lock. Process start comes from the one scheduler, so it is never a second time domain. */
  private claimLock(): void {
    const lock = lstatSync(this.lockPath);
    if (!lock.isDirectory() || lock.uid !== process.getuid?.() || (lock.mode & 0o777) !== 0o700) throw new Error();
    this.lockIdentity = { dev: lock.dev, ino: lock.ino, uid: lock.uid, mode: lock.mode & 0o777 };
    const nonce = randomBytes(24).toString("base64url");
    // Sampled once and kept: ownership is proved against the exact value written, never against a
    // fresh reading of the scheduler.
    const startedAt = this.scheduler.processStartedAt();
    const body = Buffer.from(JSON.stringify({ version: LOCK_METADATA_VERSION, pid: process.pid, startedAt, nonce }), "utf8");
    // O_EXCL|O_NOFOLLOW at mode 0600: the diagnostic is created here or not at all, and an existing
    // name — symlink or otherwise — is never written through.
    const fd = openSync(this.ownerPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { let off = 0; while (off < body.length) off += writeSync(fd, body, off, body.length - off, off); fsyncSync(fd); } finally { closeSync(fd); }
    const owner = lstatSync(this.ownerPath);
    if (!owner.isFile() || owner.nlink !== 1 || owner.uid !== process.getuid?.() || (owner.mode & 0o777) !== 0o600) throw new Error();
    this.ownerIdentity = { dev: owner.dev, ino: owner.ino, uid: owner.uid, mode: owner.mode & 0o777 };
    this.lockStartedAt = startedAt; this.lockNonce = nonce;
  }
  /** Constructor rollback only, and best effort: the diagnostic cannot outlive the directory holding
   * it, so it goes first. A failure here never masks the startup error being thrown. */
  private rollbackLock(): void {
    // Once identity is recorded, only the directory this boot created is removable. Before that —
    // the narrow window where `claimLock` failed early — no diagnostic is unlinked at all and the
    // bare `rmdir` can only succeed on the empty directory `mkdir` just made.
    if (this.lockIdentity) { if (!this.lockHeld()) return; try { unlinkSync(this.ownerPath); } catch {} }
    try { rmdirSync(this.lockPath); } catch {}
  }
  /** The lock removed must be the directory this store created — same device, inode, owner and mode.
   * Identical contents prove nothing: only the retained identity distinguishes it from a replacement. */
  private lockHeld(): boolean {
    if (!this.lockIdentity) return false;
    let st; try { st = lstatSync(this.lockPath); } catch { return false; }
    return st.isDirectory() && st.dev === this.lockIdentity.dev && st.ino === this.lockIdentity.ino && st.uid === this.lockIdentity.uid && (st.mode & 0o777) === this.lockIdentity.mode;
  }
  /** The diagnostic must still be the private regular file this instance wrote, and must still carry
   * the nonce only this instance holds. Opened `O_NOFOLLOW`, so a symlink left at the name fails here
   * rather than being read or removed through to its target. */
  private diagnosticOwned(): boolean {
    if (!this.ownerIdentity || !this.lockNonce) return false;
    let fd = -1;
    try {
      fd = openSync(this.ownerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const st = fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.() || st.dev !== this.ownerIdentity.dev || st.ino !== this.ownerIdentity.ino || st.uid !== this.ownerIdentity.uid || (st.mode & 0o777) !== this.ownerIdentity.mode) return false;
      const buf = Buffer.alloc(st.size); let off = 0;
      while (off < buf.length) { const n = readSync(fd, buf, off, buf.length - off, off); if (n <= 0) return false; off += n; }
      // Owned by what it says, not merely by parsing: a plain object carrying exactly the closed key
      // set, every value equal to what this boot wrote. An extra field, a missing one, a rewritten
      // process start or an array all fail here.
      const meta = JSON.parse(buf.toString("utf8"));
      if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return false;
      const keys = Object.keys(meta).sort();
      if (keys.length !== 4 || keys[0] !== "nonce" || keys[1] !== "pid" || keys[2] !== "startedAt" || keys[3] !== "version") return false;
      return meta.version === LOCK_METADATA_VERSION && meta.pid === process.pid && meta.startedAt === this.lockStartedAt && meta.nonce === this.lockNonce;
    } catch { return false; } finally { if (fd >= 0) try { closeSync(fd); } catch {} }
  }
  /** `data` goes only when it is empty: `rmdir` refuses a directory holding anything this store did
   * not create and sweep, and that refusal is what retains the lock. Nothing is ever removed recursively. */
  private removeData(): void { rmdirSync(this.data); }
  /** Graceful removal, in the only order that can succeed. Any failure propagates: the lock stays. */
  private removeLock(): void { if (!this.lockHeld() || !this.diagnosticOwned()) throw new ArtifactStoreError("artifact-cleanup-failed"); this.run("remove-diagnostic", () => unlinkSync(this.ownerPath)); this.run("remove-lock", () => (this.fsOps.rmdirSync ?? rmdirSync)(this.lockPath)); }
  private strictFsyncDataDir() { try { this.fsyncDataDir(); return true; } catch { return false; } }
  private clearTimer(id: string) { const t = this.timers.get(id); if (t !== undefined) this.scheduler.clearTimeout(t); this.timers.delete(id); }
  private reapExpired() { for (const [id, rec] of Array.from(this.records.entries())) if (this.scheduler.now() >= rec.expiresAt) this.discardArtifact(id); }
}
