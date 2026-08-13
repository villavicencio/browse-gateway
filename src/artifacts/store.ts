import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { fstatSync, fsyncSync, mkdirSync, openSync, closeSync, readSync, writeSync, unlinkSync, linkSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { ARTIFACT_ID, type ArtifactRecord, type ArtifactStoreOptions, type CaptureOptions, type ResponseLease } from "./types.js";

const PDF_MAGIC = Buffer.from("%PDF-");
export class ArtifactStore {
  readonly enabled: boolean;
  private readonly root: string;
  private readonly data: string;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxBytes: number;
  private readonly maxCount: number;
  private closed = false;
  private records = new Map<string, ArtifactRecord>();
  private leases = new Set<string>();
  constructor(options: ArtifactStoreOptions) {
    this.enabled = options.enabled !== false;
    this.root = options.root;
    this.data = join(this.root, "data");
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 600_000;
    this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    this.maxCount = options.maxCount ?? 16;
    if (!this.enabled) return;
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    mkdirSync(join(this.root, ".gateway-lock"), { mode: 0o700 });
    mkdirSync(this.data, { mode: 0o700 });
    if ((statSync(this.root).mode & 0o777) !== 0o700 || (statSync(this.data).mode & 0o777) !== 0o700) throw new Error("artifact store permissions invalid");
    for (const name of readdirSync(this.data)) {
      if (/^[A-Za-z0-9_-]{22,64}\.(?:part|pdf)$/.test(name)) unlinkSync(join(this.data, name));
      else throw new Error("artifact data directory contains unexpected entry");
    }
  }
  async capture(source: string, options: CaptureOptions): Promise<ArtifactRecord | { status: "capture-failed" }> {
    if (!this.enabled || !ARTIFACT_ID.test(options.id)) return { status: "capture-failed" };
    if (this.records.size >= this.maxCount) return { status: "capture-failed" };
    const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = fstatSync(fd); if (!st.isFile() || st.size > 8 * 1024 * 1024 || st.size < 5) return { status: "capture-failed" };
      if (this.totalBytes() + st.size > this.maxBytes) return { status: "capture-failed" };
      const buf = Buffer.alloc(st.size); let off = 0; while (off < st.size) { const n = readSync(fd, buf, off, st.size - off, off); if (!n) break; off += n; }
      if (!buf.subarray(0, 5).equals(PDF_MAGIC)) return { status: "capture-failed" };
      const part = join(this.data, `${options.id}.part`); const final = join(this.data, `${options.id}.pdf`);
      const out = openSync(part, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); try { writeSync(out, buf); fsyncSync(out); } finally { closeSync(out); }
      linkSync(part, final); unlinkSync(part); const dirFd = openSync(this.data, constants.O_RDONLY); try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
      const record: ArtifactRecord = { id: options.id, consumerId: options.consumerId, bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex"), createdAt: this.now(), expiresAt: this.now() + (options.ttlMs ?? this.ttlMs), status: "available" };
      this.records.set(options.id, record); return record;
    } finally { closeSync(fd); }
  }
  acquire(id: string, consumerId: string): ResponseLease | null {
    const rec = this.records.get(id); if (!rec || rec.consumerId !== consumerId || rec.status !== "available" || this.now() >= rec.expiresAt || this.leases.has(id)) return null;
    const fd = openSync(join(this.data, `${id}.pdf`), constants.O_RDONLY | constants.O_NOFOLLOW); const buf = Buffer.alloc(rec.bytes); readSync(fd, buf, 0, buf.length, 0); closeSync(fd); this.leases.add(id); rec.status = "consuming";
    let done = false; return { record: rec, bytes: buf.length, base64: buf.toString("base64"), deadline: this.now() + 15_000, complete: () => { if (done) return; done = true; this.leases.delete(id); this.records.delete(id); try { unlinkSync(join(this.data, `${id}.pdf`)); } catch {} } };
  }
  private totalBytes() { return Array.from(this.records.values()).reduce((n, r) => n + r.bytes, 0); }
  close() { if (this.closed || !this.enabled) return; this.closed = true; for (const id of Array.from(this.records.keys())) { try { unlinkSync(join(this.data, `${id}.pdf`)); } catch {} } this.records.clear(); try { rmSync(join(this.root, ".gateway-lock"), { recursive: true, force: true }); } catch {} }
}

