import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { fstatSync, fsyncSync, mkdirSync, openSync, closeSync, readSync, writeSync, readdirSync, rmdirSync, lstatSync, linkSync, unlinkSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { ARTIFACT_ID, ArtifactStoreError, type ArtifactAccounting, type ArtifactRecord, type ArtifactScheduler, type ArtifactStoreOptions, type CaptureOptions, type CaptureResult, type ResponseLease, type ArtifactFailureCode } from "./types.js";

const PDF_MAGIC = Buffer.from("%PDF-");
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const DEFAULT_CLEANUP_INTERVAL_MS = 60_000;
const RESPONSE_LEASE_MS = 15_000;
const MAX_STAGE_COPIES = 2;
/** One capture's claim on count and bytes. It is created before the source is opened, converted from staging to committed by publication, and released exactly once. */
interface Reservation { readonly id: string; readonly consumerId: string; bytes: number; staging: boolean; released: boolean; }
/** Retained-directory identity. Private to this module: it never crosses a seam or a public type. */
interface DirIdentity { dev: number; ino: number; uid: number; mode: number; directory: boolean; }
const SYSTEM_SCHEDULER: ArtifactScheduler = {
  now: () => Date.now(),
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
  private readonly identityOverride?: ArtifactStoreOptions["identityOverride"]; private readonly afterRootDescriptor?: () => void;
  private readonly onDataPathOpen?: () => void; private readonly onDescriptorClose?: () => void;

  constructor(options: ArtifactStoreOptions) {
    this.enabled = options.enabled !== false; this.root = options.root; this.data = join(this.root, "data");
    this.scheduler = options.scheduler ?? SYSTEM_SCHEDULER; this.ttlMs = options.ttlMs ?? 600_000; this.cleanupIntervalMs = options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS; this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    this.maxCount = options.maxCount ?? 16; this.perConsumerBytes = options.perConsumerBytes ?? 16 * 1024 * 1024; this.perConsumerCount = options.perConsumerCount ?? 4;
    this.fsOps = options.fsOps ?? { linkSync, unlinkSync, fsyncSync }; this.onDiscard = options.onDiscard; this.onCleanupPass = options.onCleanupPass; this.afterPartFsync = options.afterPartFsync; this.afterLinkBeforeCommit = options.afterLinkBeforeCommit;
    this.identityOverride = options.identityOverride; this.afterRootDescriptor = options.afterRootDescriptor; this.onDataPathOpen = options.onDataPathOpen; this.onDescriptorClose = options.onDescriptorClose;
    if (!isAbsolute(this.root) || !Number.isFinite(this.ttlMs) || this.ttlMs <= 0 || !Number.isInteger(this.cleanupIntervalMs) || this.cleanupIntervalMs <= 0 || !Number.isFinite(this.maxBytes) || this.maxBytes <= 0 || !Number.isFinite(this.maxCount) || this.maxCount <= 0 || !Number.isFinite(this.perConsumerBytes) || this.perConsumerBytes <= 0 || !Number.isFinite(this.perConsumerCount) || this.perConsumerCount <= 0) throw new ArtifactStoreError("artifact-config-invalid");
    if (!this.enabled) return;
    if (process.platform !== "linux" || constants.O_NOFOLLOW === undefined || constants.O_DIRECTORY === undefined) throw new ArtifactStoreError("artifact-filesystem-unsupported");
    try { mkdirSync(this.root, { recursive: true, mode: 0o700 }); } catch { throw new ArtifactStoreError("artifact-root-invalid"); }
    try { const existing = lstatSync(this.root); if (!existing.isDirectory() || existing.uid !== process.getuid?.()) throw new Error(); } catch { throw new ArtifactStoreError("artifact-root-invalid"); }
    try { mkdirSync(join(this.root, ".gateway-lock"), { mode: 0o700 }); } catch { throw new ArtifactStoreError("artifact-root-locked"); }
    try {
      const rootStat = lstatSync(this.root); if (!rootStat.isDirectory() || rootStat.uid !== process.getuid?.() || (rootStat.mode & 0o777) !== 0o700) throw new Error();
      mkdirSync(this.data, { recursive: true, mode: 0o700 }); const dataStat = lstatSync(this.data); if (!dataStat.isDirectory() || dataStat.uid !== process.getuid?.() || (dataStat.mode & 0o777) !== 0o700) throw new Error();
    } catch { try { rmdirSync(join(this.root, ".gateway-lock")); } catch {} throw new ArtifactStoreError("artifact-root-invalid"); }
    // Still pre-mutation: retain both directory descriptors and bind them to the configured paths,
    // so every later mutation can prove it is acting on the tree this boot validated.
    try {
      this.rootFd = openSync(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      this.afterRootDescriptor?.();
      this.dataFd = openSync(this.data, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      this.onDataPathOpen?.();
      this.rootIdentity = this.readIdentity("root", "descriptor"); this.dataIdentity = this.readIdentity("data", "descriptor");
      if (!this.identityHolds()) throw new Error();
    } catch { this.closeDescriptors(); try { rmdirSync(join(this.root, ".gateway-lock")); } catch {} throw new ArtifactStoreError("artifact-root-invalid"); }
    try {
      let changed = false;
      const entries = readdirSync(this.data).sort();
      const paths: string[] = [];
      for (const name of entries) { if (!/^[A-Za-z0-9_-]{22,64}\.(?:part|pdf)$/.test(name)) throw new ArtifactStoreError("artifact-root-invalid"); const path = join(this.data, name); const st = lstatSync(path); if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o600) throw new ArtifactStoreError("artifact-root-invalid"); paths.push(path); }
      for (const path of paths) { this.fsOps.unlinkSync(path); changed = true; }
      if (changed) this.fsyncDataDir();
    } catch (e) { this.closeDescriptors(); if (e instanceof ArtifactStoreError && e.code === "artifact-root-invalid") { try { rmdirSync(join(this.root, ".gateway-lock")); } catch {} throw e; } throw new ArtifactStoreError("artifact-cleanup-failed"); }
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
  private finishClose(): void { let result: ArtifactFailureCode | undefined; if (!this.identityProven()) { result = "artifact-cleanup-failed"; this.closeDescriptors(); const stop = this.resolveClose; this.resolveClose = undefined; stop?.(result); return; } try { let recordsClean = true; for (const id of Array.from(this.records.keys())) if (!this.discardOwned(id)) recordsClean = false; const names = (this.fsOps.readdirSync ?? readdirSync)(this.data).filter(n => /^[A-Za-z0-9_-]{22,64}\.(?:part|pdf)$/.test(n)).map(n => join(this.data, n)); const clean = this.strictDelete(names); if (recordsClean && clean && this.strictFsyncDataDir()) { try { (this.fsOps.rmdirSync ?? rmdirSync)(join(this.root, ".gateway-lock")); } catch { this.markUnhealthy(); result = "artifact-cleanup-failed"; } } else { this.markUnhealthy(); result = "artifact-cleanup-failed"; } } catch { this.markUnhealthy(); result = "artifact-cleanup-failed"; } this.closeDescriptors(); const resolve = this.resolveClose; this.resolveClose = undefined; resolve?.(result); }
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
  private closeDescriptors() { for (const fd of [this.rootFd, this.dataFd]) if (fd >= 0) { try { closeSync(fd); } catch {} try { this.onDescriptorClose?.(); } catch {} } this.rootFd = -1; this.dataFd = -1; this.disposed = true; }
  private strictFsyncDataDir() { try { this.fsyncDataDir(); return true; } catch { return false; } }
  private clearTimer(id: string) { const t = this.timers.get(id); if (t !== undefined) this.scheduler.clearTimeout(t); this.timers.delete(id); }
  private reapExpired() { for (const [id, rec] of Array.from(this.records.entries())) if (this.scheduler.now() >= rec.expiresAt) this.discardArtifact(id); }
}
