import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { fstatSync, fsyncSync, mkdirSync, openSync, closeSync, readSync, writeSync, unlinkSync, linkSync, readdirSync, rmdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { ARTIFACT_ID, ArtifactStoreError, type ArtifactRecord, type ArtifactStoreOptions, type CaptureOptions, type ResponseLease } from "./types.js";

const PDF_MAGIC = Buffer.from("%PDF-");
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
type Timer = ReturnType<typeof setTimeout>;

export class ArtifactStore {
  readonly enabled: boolean;
  private readonly root: string;
  private readonly data: string;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxBytes: number;
  private readonly maxCount: number;
  private readonly perConsumerBytes: number;
  private readonly perConsumerCount: number;
  private readonly fsOps: NonNullable<ArtifactStoreOptions["fsOps"]>;
  private closed = false;
  private unhealthy = false;
  private records = new Map<string, ArtifactRecord>();
  private timers = new Map<string, Timer>();
  constructor(options: ArtifactStoreOptions) {
    this.enabled = options.enabled !== false;
    this.root = options.root;
    this.data = join(this.root, "data");
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 600_000;
    this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    this.maxCount = options.maxCount ?? 16;
    this.perConsumerBytes = options.perConsumerBytes ?? 16 * 1024 * 1024;
    this.perConsumerCount = options.perConsumerCount ?? 4;
    this.fsOps = options.fsOps ?? { linkSync, unlinkSync, fsyncSync };
    if (!isAbsolute(this.root) || !Number.isFinite(this.ttlMs) || this.ttlMs <= 0 || !Number.isFinite(this.maxBytes) || this.maxBytes <= 0 || !Number.isFinite(this.maxCount) || this.maxCount <= 0 || !Number.isFinite(this.perConsumerBytes) || this.perConsumerBytes <= 0 || !Number.isFinite(this.perConsumerCount) || this.perConsumerCount <= 0) throw new Error("invalid artifact store options");
    if (!this.enabled) return;
    if (process.platform !== "linux" || constants.O_NOFOLLOW === undefined) throw new Error("artifact store requires Linux O_NOFOLLOW");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    try { mkdirSync(join(this.root, ".gateway-lock"), { mode: 0o700 }); } catch { throw new Error("artifact store lock unavailable"); }
    mkdirSync(this.data, { mode: 0o700 });
    if ((statSync(this.root).mode & 0o777) !== 0o700 || (statSync(this.data).mode & 0o777) !== 0o700) throw new Error("artifact store permissions invalid");
    for (const name of readdirSync(this.data)) { if (/^[A-Za-z0-9_-]{22,64}\.(?:part|pdf)$/.test(name)) unlinkSync(join(this.data, name)); else throw new Error("artifact data directory contains unexpected entry"); }
  }
  async capture(source: string, options: CaptureOptions): Promise<ArtifactRecord | { status: "capture-failed" }> {
    this.reapExpired();
    if (!ARTIFACT_ID.test(options.id)) throw new ArtifactStoreError("invalid-artifact-id");
    if (this.closed || this.unhealthy || !this.enabled) return { status: "capture-failed" };
    if (this.records.has(options.id) || this.records.size >= this.maxCount || this.consumerCount(options.consumerId) >= this.perConsumerCount) return { status: "capture-failed" };
    let fd = -1; let part: string | undefined;
    try {
      fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
      const initial = fstatSync(fd); if (!initial.isFile() || initial.size > MAX_ARTIFACT_BYTES || initial.size < PDF_MAGIC.length) return { status: "capture-failed" };
      if (this.totalBytes() + initial.size > this.maxBytes || this.consumerBytes(options.consumerId) + initial.size > this.perConsumerBytes) return { status: "capture-failed" };
      const buf = Buffer.alloc(initial.size); let off = 0;
      while (off < buf.length) { const n = readSync(fd, buf, off, buf.length - off, off); if (n <= 0) return { status: "capture-failed" }; off += n; }
      const finalStat = fstatSync(fd); if (finalStat.size !== initial.size || off !== initial.size || !buf.subarray(0, 5).equals(PDF_MAGIC)) return { status: "capture-failed" };
      part = join(this.data, `${options.id}.part`); const final = join(this.data, `${options.id}.pdf`);
      const out = openSync(part, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { let written = 0; while (written < buf.length) { const n = writeSync(out, buf, written, buf.length - written, written); if (n <= 0) throw new Error("short artifact write"); written += n; } this.fsOps.fsyncSync(out); } finally { closeSync(out); }
      if (this.closed) return { status: "capture-failed" };
      this.fsOps.linkSync(part, final); this.fsOps.unlinkSync(part); part = undefined;
      const dirFd = openSync(this.data, constants.O_RDONLY); try { this.fsOps.fsyncSync(dirFd); } finally { closeSync(dirFd); }
      if (this.closed) { try { this.fsOps.unlinkSync(final); } catch { this.closed = true; } return { status: "capture-failed" }; }
      const createdAt = this.now(); const record: ArtifactRecord = { id: options.id, consumerId: options.consumerId, bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex"), createdAt, expiresAt: createdAt + (options.ttlMs ?? this.ttlMs), status: "available" };
      this.records.set(options.id, record); return record;
    } catch { let clean = true; for (const path of [part, join(this.data, `${options.id}.pdf`)]) if (path) try { this.fsOps.unlinkSync(path); } catch { clean = false; } if (!clean) { this.unhealthy = true; this.closed = true; } return { status: "capture-failed" }; }
    finally { if (fd >= 0) try { closeSync(fd); } catch {} }
  }
  acquire(id: string, consumerId: string): ResponseLease | null {
    if (!ARTIFACT_ID.test(id)) throw new ArtifactStoreError("invalid-artifact-id");
    this.reapExpired(); if (this.closed) return null;
    const rec = this.records.get(id); if (!rec || rec.consumerId !== consumerId || rec.status !== "available") return null;
    const path = join(this.data, `${id}.pdf`); let fd = -1;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); const st = fstatSync(fd); if (st.size !== rec.bytes) throw new Error("integrity");
      const buf = Buffer.alloc(rec.bytes); let off = 0; while (off < buf.length) { const n = readSync(fd, buf, off, buf.length - off, off); if (n <= 0) throw new Error("short read"); off += n; }
      if (fstatSync(fd).size !== rec.bytes || createHash("sha256").update(buf).digest("hex") !== rec.sha256) throw new Error("integrity");
      rec.status = "consuming"; const deadline = this.now() + 15_000; const timer = setTimeout(() => { if (rec.status === "consuming") this.discardArtifact(id); }, Math.max(0, deadline - Date.now())); this.timers.set(id, timer);
      let done = false; return { record: rec, bytes: buf.length, base64: buf.toString("base64"), deadline, complete: () => { if (done) return; done = true; this.clearTimer(id); this.discardArtifact(id); } };
    } catch { this.discardArtifact(id); return null; } finally { if (fd >= 0) try { closeSync(fd); } catch {} }
  }
  discardArtifact(id: string) { if (!ARTIFACT_ID.test(id)) throw new ArtifactStoreError("invalid-artifact-id"); this.clearTimer(id); this.records.delete(id); try { unlinkSync(join(this.data, `${id}.pdf`)); } catch {} try { unlinkSync(join(this.data, `${id}.part`)); } catch {} }
  close() { if (this.closed || !this.enabled) return; this.closed = true; for (const id of Array.from(this.records.keys())) this.discardArtifact(id); for (const name of readdirSync(this.data)) if (/^[A-Za-z0-9_-]{22,64}\.(?:part|pdf)$/.test(name)) try { unlinkSync(join(this.data, name)); } catch {} try { rmdirSync(join(this.root, ".gateway-lock")); } catch {} }
  private clearTimer(id: string) { const t = this.timers.get(id); if (t) clearTimeout(t); this.timers.delete(id); }
  private reapExpired() { for (const [id, rec] of Array.from(this.records.entries())) if (this.now() >= rec.expiresAt) this.discardArtifact(id); }
  private consumerCount(c: string) { return Array.from(this.records.values()).filter(r => r.consumerId === c).length; }
  private consumerBytes(c: string) { return Array.from(this.records.values()).filter(r => r.consumerId === c).reduce((n, r) => n + r.bytes, 0); }
  private totalBytes() { return Array.from(this.records.values()).reduce((n, r) => n + r.bytes, 0); }
}
