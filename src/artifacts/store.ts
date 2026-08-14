import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { fstatSync, fsyncSync, mkdirSync, openSync, closeSync, readSync, writeSync, readdirSync, rmdirSync, statSync, linkSync, unlinkSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { ARTIFACT_ID, ArtifactStoreError, type ArtifactRecord, type ArtifactStoreOptions, type CaptureOptions, type CaptureResult, type ResponseLease, type ArtifactFailureCode } from "./types.js";

const PDF_MAGIC = Buffer.from("%PDF-");
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
type Timer = ReturnType<typeof setTimeout>;

export class ArtifactStore {
  readonly enabled: boolean;
  private readonly root: string; private readonly data: string; private readonly now: () => number;
  private readonly ttlMs: number; private readonly maxBytes: number; private readonly maxCount: number;
  private readonly perConsumerBytes: number; private readonly perConsumerCount: number;
  private readonly fsOps: NonNullable<ArtifactStoreOptions["fsOps"]>;
  private closed = false; private unhealthy = false; private activeCaptures = 0;
  private readonly inflight = new Set<string>(); private readonly onDiscard?: (id: string) => void;
  private records = new Map<string, ArtifactRecord>(); private timers = new Map<string, Timer>();

  constructor(options: ArtifactStoreOptions) {
    this.enabled = options.enabled !== false; this.root = options.root; this.data = join(this.root, "data");
    this.now = options.now ?? Date.now; this.ttlMs = options.ttlMs ?? 600_000; this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    this.maxCount = options.maxCount ?? 16; this.perConsumerBytes = options.perConsumerBytes ?? 16 * 1024 * 1024; this.perConsumerCount = options.perConsumerCount ?? 4;
    this.fsOps = options.fsOps ?? { linkSync, unlinkSync, fsyncSync }; this.onDiscard = options.onDiscard;
    if (!isAbsolute(this.root) || !Number.isFinite(this.ttlMs) || this.ttlMs <= 0 || !Number.isFinite(this.maxBytes) || this.maxBytes <= 0 || !Number.isFinite(this.maxCount) || this.maxCount <= 0 || !Number.isFinite(this.perConsumerBytes) || this.perConsumerBytes <= 0 || !Number.isFinite(this.perConsumerCount) || this.perConsumerCount <= 0) throw new ArtifactStoreError("artifact-config-invalid");
    if (!this.enabled) return;
    if (process.platform !== "linux" || constants.O_NOFOLLOW === undefined) throw new ArtifactStoreError("artifact-filesystem-unsupported");
    try { mkdirSync(this.root, { recursive: true, mode: 0o700 }); } catch { throw new ArtifactStoreError("artifact-root-invalid"); }
    try { mkdirSync(join(this.root, ".gateway-lock"), { mode: 0o700 }); } catch { throw new ArtifactStoreError("artifact-root-locked"); }
    try { mkdirSync(this.data, { recursive: true, mode: 0o700 }); if ((statSync(this.root).mode & 0o777) !== 0o700 || (statSync(this.data).mode & 0o777) !== 0o700) throw new Error(); } catch { try { rmdirSync(join(this.root, ".gateway-lock")); } catch {} throw new ArtifactStoreError("artifact-root-invalid"); }
    try {
      let changed = false;
      for (const name of readdirSync(this.data)) { if (!/^[A-Za-z0-9_-]{22,64}\.(?:part|pdf)$/.test(name)) throw new ArtifactStoreError("artifact-root-invalid"); this.fsOps.unlinkSync(join(this.data, name)); changed = true; }
      if (changed) this.fsyncDataDir();
    } catch (e) { if (e instanceof ArtifactStoreError && e.code === "artifact-root-invalid") { try { rmdirSync(join(this.root, ".gateway-lock")); } catch {} throw e; } throw new ArtifactStoreError("artifact-cleanup-failed"); }
  }

  async capture(source: string, options: CaptureOptions): Promise<CaptureResult> {
    this.reapExpired();
    if (!ARTIFACT_ID.test(options.id)) throw new ArtifactStoreError("invalid-artifact-id");
    if (this.closed || this.unhealthy || !this.enabled) return { status: "capture-failed", failure: "artifact-runtime-invalidated" };
    if (this.records.has(options.id) || this.inflight.has(options.id) || this.records.size >= this.maxCount || this.consumerCount(options.consumerId) >= this.perConsumerCount) return { status: "capture-failed", failure: "artifact-capacity" };
    this.inflight.add(options.id); this.activeCaptures++;
    let fd = -1, out = -1; let part: string | undefined; let final: string | undefined; let linked = false;
    try {
      fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW); const initial = fstatSync(fd);
      if (!initial.isFile() || initial.size > MAX_ARTIFACT_BYTES) return { status: "capture-failed", failure: "artifact-size-limit" };
      if (initial.size < PDF_MAGIC.length) return { status: "capture-failed", failure: "artifact-not-pdf" };
      if (this.totalBytes() + initial.size > this.maxBytes || this.consumerBytes(options.consumerId) + initial.size > this.perConsumerBytes) return { status: "capture-failed", failure: "artifact-capacity" };
      const buf = Buffer.alloc(initial.size); let off = 0; while (off < buf.length) { const n = readSync(fd, buf, off, buf.length - off, off); if (n <= 0) throw new Error(); off += n; }
      const end = fstatSync(fd); if (end.size !== initial.size || !buf.subarray(0, 5).equals(PDF_MAGIC)) return { status: "capture-failed", failure: "artifact-integrity-failed" };
      part = join(this.data, `${options.id}.part`); final = join(this.data, `${options.id}.pdf`); out = openSync(part, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      let written = 0; while (written < buf.length) { const n = writeSync(out, buf, written, buf.length - written, written); if (n <= 0) throw new Error(); written += n; } this.fsOps.fsyncSync(out); closeSync(out); out = -1;
      if (this.closed || this.unhealthy) return { status: "capture-failed", failure: "artifact-runtime-invalidated" };
      this.fsOps.linkSync(part, final); linked = true; this.fsOps.unlinkSync(part); part = undefined; this.fsyncDataDir();
      if (this.closed || this.unhealthy) { const clean = this.strictDelete([final]); if (!clean) { this.markUnhealthy(); return { status: "capture-failed", failure: "artifact-cleanup-failed" }; } return { status: "capture-failed", failure: "artifact-runtime-invalidated" }; }
      const createdAt = this.now(); const record: ArtifactRecord = { id: options.id, consumerId: options.consumerId, bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex"), createdAt, expiresAt: createdAt + (options.ttlMs ?? this.ttlMs), status: "available" };
      this.records.set(options.id, record); return record;
    } catch {
      if (out >= 0) try { closeSync(out); } catch {}
      const clean = this.strictDelete([part, linked ? final : undefined].filter((x): x is string => !!x));
      if (!clean) { this.markUnhealthy(); return { status: "capture-failed", failure: "artifact-cleanup-failed" }; }
      return { status: "capture-failed", failure: "artifact-write-failed" };
    } finally { if (fd >= 0) try { closeSync(fd); } catch {} this.inflight.delete(options.id); this.activeCaptures--; if (this.closed && this.activeCaptures === 0) this.finishClose(); }
  }

  acquire(id: string, consumerId: string): ResponseLease | null {
    if (!ARTIFACT_ID.test(id)) throw new ArtifactStoreError("invalid-artifact-id"); this.reapExpired(); if (this.closed || this.unhealthy) return null;
    const rec = this.records.get(id); if (!rec || rec.consumerId !== consumerId || rec.status !== "available") return null;
    const path = join(this.data, `${id}.pdf`); let fd = -1;
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); const st = fstatSync(fd); if (st.size !== rec.bytes) throw new Error(); const buf = Buffer.alloc(rec.bytes); let off = 0; while (off < buf.length) { const n = readSync(fd, buf, off, buf.length - off, off); if (n <= 0) throw new Error(); off += n; } if (fstatSync(fd).size !== rec.bytes || createHash("sha256").update(buf).digest("hex") !== rec.sha256) throw new Error(); rec.status = "consuming"; const deadline = this.now() + 15_000; const timer = setTimeout(() => { if (rec.status === "consuming") this.discardArtifact(id); }, Math.max(0, deadline - Date.now())); this.timers.set(id, timer); let done = false; return { record: rec, bytes: buf.length, base64: buf.toString("base64"), deadline, complete: () => { if (done) return; done = true; this.clearTimer(id); this.discardArtifact(id); } }; }
    catch { const clean = this.strictDelete([path]); this.records.delete(id); if (!clean) this.markUnhealthy(); return null; } finally { if (fd >= 0) try { closeSync(fd); } catch {} }
  }

  discardArtifact(id: string) { if (!ARTIFACT_ID.test(id)) throw new ArtifactStoreError("invalid-artifact-id"); this.clearTimer(id); this.records.delete(id); this.onDiscard?.(id); const clean = this.strictDelete([join(this.data, `${id}.pdf`), join(this.data, `${id}.part`)]); if (!clean) this.markUnhealthy(); }
  close() { if (!this.enabled || this.closed && !this.unhealthy) return; this.closed = true; if (this.activeCaptures === 0) this.finishClose(); }
  private finishClose() { for (const id of Array.from(this.records.keys())) this.discardArtifact(id); const names = readdirSync(this.data).filter(n => /^[A-Za-z0-9_-]{22,64}\.(?:part|pdf)$/.test(n)).map(n => join(this.data, n)); const clean = this.strictDelete(names); if (clean && this.strictFsyncDataDir()) { try { rmdirSync(join(this.root, ".gateway-lock")); } catch { this.markUnhealthy(); } } else this.markUnhealthy(); }
  private markUnhealthy() { this.unhealthy = true; this.closed = true; }
  private strictDelete(paths: string[]) { let ok = true, changed = false; for (const path of paths) { try { this.fsOps.unlinkSync(path); changed = true; } catch (e: any) { if (e?.code !== "ENOENT") ok = false; } } if (ok && changed && !this.strictFsyncDataDir()) ok = false; return ok; }
  private fsyncDataDir() { const fd = openSync(this.data, constants.O_RDONLY); try { this.fsOps.fsyncSync(fd); } finally { closeSync(fd); } }
  private strictFsyncDataDir() { try { this.fsyncDataDir(); return true; } catch { return false; } }
  private clearTimer(id: string) { const t = this.timers.get(id); if (t) clearTimeout(t); this.timers.delete(id); }
  private reapExpired() { for (const [id, rec] of Array.from(this.records.entries())) if (this.now() >= rec.expiresAt) this.discardArtifact(id); }
  private consumerCount(c: string) { return Array.from(this.records.values()).filter(r => r.consumerId === c).length; }
  private consumerBytes(c: string) { return Array.from(this.records.values()).filter(r => r.consumerId === c).reduce((n, r) => n + r.bytes, 0); }
  private totalBytes() { return Array.from(this.records.values()).reduce((n, r) => n + r.bytes, 0); }
}
