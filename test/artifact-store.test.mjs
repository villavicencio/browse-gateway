import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, statSync, lstatSync, fstatSync, readFileSync, symlinkSync, chmodSync, writeFileSync, rmSync, readdirSync, linkSync, unlinkSync, fsyncSync, existsSync, rmdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
// The concrete store is INTERNAL to `src/artifacts/` (Amendment 3 §1) and is imported here as the
// module-local class it is, never through the public barrel.
import { ArtifactStore, provenFileStat } from "../dist/artifacts/store.js";

const dirs = [];
function temp() { const dir = mkdtempSync(join(tmpdir(), "bgw-artifact-")); dirs.push(dir); return dir; }
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });
function source() { const path = join(temp(), "source.pdf"); writeFileSync(path, Buffer.from("%PDF-1.7\nhello")); return path; }

const STAGE_BYTES = 8 * 1024 * 1024, SOURCE_BYTES = 14;
const IDLE = { count: 0, bytes: 0, stagingBytes: 0, stagePermits: 0, stagePermitLimit: 2, responsePermitHeld: false, responseWaiters: 0, responseBytes: 0, consumers: 0 };
// `capture` runs synchronously into `afterPartFsync`, so flipping `arm` after the call pauses
// exactly the captures a test wants staging and lets the rest run to completion.
function stagingGate() { let arm = true, release; const held = new Promise((resolve) => { release = resolve; }); return { hook: () => (arm ? held : undefined), arm: () => { arm = true; }, disarm: () => { arm = false; }, release: () => release() }; }
// A staging capture shrinks to its exact size as soon as the source is stat'd, so proving that
// uncommitted bytes block admission needs a source big enough to matter against the cap.
function bigSource(bytes) { const path = join(temp(), "big.pdf"); writeFileSync(path, Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(bytes - 9)])); return path; }
const LOCK = ".gateway-lock", OWNER = "owner.json";
const ownerPath = (root) => join(root, LOCK, OWNER);

test("capture completes the source digest during the read and before staged-file fsync or publication", () => {
  const sourceText = readFileSync(new URL("../src/artifacts/store.ts", import.meta.url), "utf8");
  const start = sourceText.indexOf("async capture(");
  const end = sourceText.indexOf("\n  acquire(", start);
  const capture = sourceText.slice(start, end);
  const hashStart = capture.indexOf('createHash("sha256")');
  const hashUpdate = capture.indexOf(".update(", hashStart);
  const hashDigest = capture.indexOf('.digest("hex")', hashUpdate);
  const stagedFsync = capture.indexOf("this.#fsOps.fsyncSync(out)");
  const publication = capture.indexOf("this.#fsOps.linkSync(part, final)");
  const finalProof = capture.indexOf("this.#proveLinked(final", publication);
  const durableDirectory = capture.indexOf("this.#fsyncDataDir()", publication);
  const metadataInsertion = capture.indexOf("this.#records.set(options.id, record)", finalProof);
  assert.ok(start >= 0 && end > start, "capture source was not located");
  assert.ok(hashStart >= 0 && hashUpdate > hashStart && hashDigest > hashUpdate, "capture does not compute a source digest");
  assert.ok(hashDigest < stagedFsync, "the source digest was not complete before fsync of the staged descriptor");
  assert.ok(hashDigest < publication, "the source digest was not complete before publication");
  assert.ok(publication < finalProof, "the final-name descriptor proof did not follow publication");
  assert.ok(finalProof < durableDirectory, "the data directory was made durable before the final-name descriptor proof");
  assert.ok(durableDirectory < metadataInsertion, "metadata was inserted before final-name durability completed");
});
// The one scheduler owns process-start too, so a test supplies it exactly rather than racing a clock.
const PROCESS_START = 1_732_000_000_123;

// Deterministic scheduler: virtual time only, every registration retained so a test can fire a
// cancelled or post-close callback by hand and prove it is inert.
function fakeScheduler(start = 1_000_000) {
  let time = start, next = 1;
  const registrations = [], cleared = [], live = new Map();
  return {
    now: () => time,
    processStartedAt: () => PROCESS_START,
    setTimeout(callback, delayMs) { const registration = { handle: next++, callback, delayMs, dueAt: time + delayMs }; registrations.push(registration); live.set(registration.handle, registration); return registration.handle; },
    clearTimeout(handle) { cleared.push(handle); live.delete(handle); },
    registrations, cleared,
    pending: () => Array.from(live.values()),
    registration: (delayMs) => registrations.find((r) => r.delayMs === delayMs),
    advance(ms) {
      const target = time + ms;
      for (;;) {
        const due = Array.from(live.values()).filter((r) => r.dueAt <= target).sort((a, b) => a.dueAt - b.dueAt)[0];
        if (!due) break;
        live.delete(due.handle); time = due.dueAt; due.callback();
      }
      time = target;
    },
  };
}

test("disabled store has no filesystem side effects", async () => {
  const root = join(temp(), "not-created");
  const store = new ArtifactStore({ enabled: false, root });
  assert.equal(store.enabled, false);
  assert.equal(await store.close(), undefined);
  assert.equal(readdirSync(join(root, ".."), { withFileTypes: true }).some((entry) => entry.name === "not-created"), false);
});

// A disabled store acquires NOTHING: no root or data descriptor, no lock, no directory identity. Its
// public discard nevertheless entered the owned-cleanup path, where the identity proof answers `true`
// for a disabled store precisely because there is nothing to prove — and unlinked `<id>.pdf` from a
// tree this process never claimed. The data-directory fsync then failed on the absent descriptor, so
// the destructive call ALSO reported false: the bytes were gone and the caller was told they were not.
// The no-op therefore belongs at the side-effect-free boundary. It is `clean`, not `refused`: this
// store could not have committed an artifact, so there is no store-close-owned deletion to await.
test("disabled store treats public discard as a clean no-op without touching the tree", async () => {
  const root = join(temp(), "disabled"), data = join(root, "data"), id = "D".repeat(22);
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const artifact = join(data, `${id}.pdf`), sentinel = join(data, "sentinel");
  writeFileSync(artifact, Buffer.from("%PDF-1.7\nkeep"), { mode: 0o600 });
  chmodSync(artifact, 0o600);
  writeFileSync(sentinel, "keep");
  // Every filesystem call the store is allowed to make goes through the injected authority, so an
  // empty log is proof that the no-op reached no filesystem at all.
  const fsCalls = [], callbacks = [];
  const counting = {
    linkSync: (...a) => { fsCalls.push("link"); return linkSync(...a); },
    unlinkSync: (...a) => { fsCalls.push("unlink"); return unlinkSync(...a); },
    fsyncSync: (...a) => { fsCalls.push("fsync"); return fsyncSync(...a); },
    rmdirSync: (...a) => { fsCalls.push("rmdir"); return rmdirSync(...a); },
    readdirSync: (...a) => { fsCalls.push("readdir"); return readdirSync(...a); },
  };
  const scheduler = fakeScheduler();
  const store = new ArtifactStore({ enabled: false, root, fsOps: counting, scheduler, onDiscard: (d) => callbacks.push(d), onCleanupPass: () => callbacks.push("cleanup") });
  assert.equal(store.enabled, false);
  // Both public methods: the detailed result must not manufacture close-owned work, and the boolean
  // must preserve its public `true iff clean` contract.
  const detailed = store.discardArtifactDetailed(id);
  const boolean = store.discardArtifact(id);
  assert.equal(existsSync(artifact), true, "a disabled store deleted an artifact it never acquired");
  assert.equal(readFileSync(artifact).toString(), "%PDF-1.7\nkeep", "the preseeded bytes were mutated");
  assert.equal(statSync(artifact).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(data).sort(), [`${id}.pdf`, "sentinel"]);
  assert.equal(detailed, "clean", "a disabled no-op manufactured close-owned discard work");
  assert.equal(boolean, true, "the public boolean did not report the clean no-op");
  assert.deepEqual(fsCalls, [], "a disabled discard reached the filesystem authority");
  assert.deepEqual(callbacks, [], "a disabled discard ran a callback");
  assert.deepEqual(scheduler.registrations, [], "a disabled store armed a timer");
  assert.deepEqual(scheduler.cleared, [], "a disabled discard cleared a timer");
  // The clean no-op is not poison: disabled close stays inert and reports no cleanup failure.
  assert.equal(await store.close(), undefined, "the clean no-op poisoned the disabled store's close");
  assert.equal(existsSync(artifact), true);
  assert.equal(existsSync(join(root, LOCK)), false, "a disabled store created a lock");
  assert.deepEqual(fsCalls, [], "the disabled close reached the filesystem authority");
});

// Amendment 2 §7: a DISABLED configuration must not REQUIRE or VALIDATE an artifact root, and must
// take no store, lock, timer or filesystem side effect. Both halves of that used to fail on the same
// line: canonicalization demanded a non-empty string `root` before it looked at `enabled` at all, and
// the constructor then joined the data path and ran the `isAbsolute`/limit validation ABOVE its
// disabled short-circuit. So `new ArtifactStore({ enabled: false })` — a configuration that never
// intended to name a root — was refused with `artifact-config-invalid`.
test("a disabled store is constructible with no root at all and stays inert", async () => {
  const store = new ArtifactStore({ enabled: false });
  assert.equal(store.enabled, false);
  const id = "N".repeat(22);
  // No root was configured, so there is no tree to prove, mutate or disclose — and no own property
  // that could carry one.
  assert.deepEqual(Object.getOwnPropertyNames(store), [], "a disabled store published an own property");
  assert.equal(serialize(store), "{}", "a disabled store serialized internal state");
  // Every public operation keeps its existing disabled semantics: a clean discard no-op, a fail-closed
  // capture, no lease, and an inert close.
  assert.equal(store.discardArtifactDetailed(id), "clean");
  assert.equal(store.discardArtifact(id), true);
  assert.deepEqual(await store.capture(source(), { id, consumerId: "c" }), { status: "capture-failed", failure: "artifact-runtime-invalidated" });
  assert.equal(await store.acquire(id, "c"), null);
  assert.deepEqual(store.accounting(), IDLE, "a disabled store moved accounting");
  const firstClose = store.close();
  const secondClose = store.close();
  assert.equal(secondClose, firstClose, "a disabled store published more than one close promise");
  assert.deepEqual(await Promise.all([firstClose, secondClose, store.close()]), [undefined, undefined, undefined]);
});

// The whole option surface, spelled here so a new member added to `ArtifactStoreOptions` without a
// disabled-path decision shows up as an untouched-option regression rather than silently.
const STORE_OPTION_KEYS = [
  "root", "ttlMs", "cleanupIntervalMs", "maxBytes", "maxCount", "perConsumerBytes", "perConsumerCount",
  "idGenerator", "fsOps", "scheduler", "onDiscard", "onCleanupPass", "afterPartFsync", "afterLinkBeforeCommit",
  "beforeCommit", "onOperationTerminal", "onOperationReleased", "onOperationCommitted", "identityOverride",
  "onCloseStep", "closeStepFails", "afterRootDescriptor", "onDataPathOpen", "onDescriptorClose",
];
/** An options object whose `enabled` is counted and every OTHER member both counts its read and
 *  throws, so an untouched option is proved twice over: by an empty read log, and by a construction
 *  that never saw the exception a touched one would have raised. */
function disabledOptionsProbe(enabledValue, sentinel) {
  const reads = new Map();
  const options = {};
  const count = (key) => reads.set(key, (reads.get(key) ?? 0) + 1);
  Object.defineProperty(options, "enabled", { enumerable: true, configurable: true, get() { count("enabled"); return enabledValue; } });
  for (const key of STORE_OPTION_KEYS) {
    Object.defineProperty(options, key, { enumerable: true, configurable: true, get() { count(key); throw new Error(`${sentinel}:${key}`); } });
  }
  return { options, reads };
}

test("a disabled configuration reads `enabled` exactly once and touches no other option", () => {
  const sentinel = "/private/statements/2026-08/DISABLED_OPTION_SENTINEL";
  const { options, reads } = disabledOptionsProbe(false, sentinel);
  const store = new ArtifactStore(options);
  assert.equal(store.enabled, false);
  assert.equal(reads.get("enabled"), 1, `enabled was read ${reads.get("enabled") ?? 0} times, not once`);
  assert.deepEqual([...reads.keys()], ["enabled"], "a disabled configuration read an option other than `enabled`");
});

// Requirement 6: the disabled short-circuit is reached only by an EXACT `false`. A malformed or
// throwing `enabled` is still a malformed configuration, refused with the closed code — and refused
// on its own, with no root supplied, so the refusal cannot be coming from root validation.
test("a malformed or throwing `enabled` is refused with the closed code even with no root", () => {
  const sentinel = "/private/statements/2026-08/ENABLED_GETTER_SENTINEL";
  const cases = [
    ["a throwing enabled getter", { get enabled() { throw new Error(sentinel); } }],
    ["a string enabled", { enabled: "false" }],
    ["a zero enabled", { enabled: 0 }],
    ["a null enabled", { enabled: null }],
    ["a boxed enabled", { enabled: new Boolean(false) }],
    ["an object enabled", { enabled: { valueOf: () => false } }],
  ];
  for (const [label, options] of cases) {
    assert.throws(() => new ArtifactStore(options), (e) => {
      assert.equal(e?.code, "artifact-config-invalid", `${label} was not refused with the closed configuration code`);
      assert.equal(String(e?.message ?? "").includes("SENTINEL"), false, `${label} leaked raw exception text`);
      assert.equal(String(e?.stack ?? "").includes("SENTINEL"), false, `${label} leaked a sentinel through a stack`);
      return true;
    }, label);
  }
});

// The TYPE boundary, proved by the compiler rather than by prose: a disabled configuration must not
// require `root`, and an enabled or default-enabled one must still require it. The fixture carries
// `@ts-expect-error` on exactly the two shapes that must NOT compile, so a boundary that weakens
// enabled validation fails this test on an unused expect-error, and one that still demands a root
// from a disabled configuration fails it on a genuine error.
test("the options type boundary requires a root only for an enabled configuration", () => {
  const fixture = new URL("./fixtures/artifact-store-options.types.ts", import.meta.url).pathname;
  const tsc = new URL("../node_modules/typescript/bin/tsc", import.meta.url).pathname;
  const result = spawnSync(process.execPath, [tsc, "--noEmit", "--strict", "--target", "ES2022", "--module", "nodenext", "--moduleResolution", "nodenext", fixture], { encoding: "utf8" });
  assert.equal(result.status, 0, `the options type boundary did not typecheck as specified:\n${result.stdout}${result.stderr}`);
});

test("enabled store creates private root/data and exclusive lock", async () => {
  const root = join(temp(), "artifacts");
  const store = new ArtifactStore({ enabled: true, root });
  assert.equal(statSync(root).mode & 0o777, 0o700);
  assert.equal(statSync(join(root, "data")).mode & 0o777, 0o700);
  assert.equal(statSync(join(root, ".gateway-lock")).isDirectory(), true);
  await store.close();
});

test("existing root and data symlinks are rejected without touching targets", () => {
  const base = temp(), victim = join(base, "victim"), root = join(base, "artifacts");
  mkdirSync(join(victim, "data"), { recursive: true, mode: 0o700 }); writeFileSync(join(victim, "data", "sentinel"), "keep"); symlinkSync(victim, root);
  assert.throws(() => new ArtifactStore({ root }), e => e.code === "artifact-root-invalid"); assert.equal(readFileSync(join(victim, "data", "sentinel"), "utf8"), "keep"); assert.equal(existsSync(join(victim, ".gateway-lock")), false);
  rmSync(root); mkdirSync(root, { mode: 0o700 }); symlinkSync(victim, join(root, "data"));
  assert.throws(() => new ArtifactStore({ root }), e => e.code === "artifact-root-invalid"); assert.equal(readFileSync(join(victim, "data", "sentinel"), "utf8"), "keep");
});

test("matching startup symlink and directory are rejected and untouched", () => {
  for (const kind of ["symlink", "directory"]) {
    const base = temp(), root = join(base, "artifacts"), victim = join(base, "victim"), id = "Q".repeat(22);
    mkdirSync(join(root, "data"), { recursive: true, mode: 0o700 }); mkdirSync(victim, { mode: 0o700 }); writeFileSync(join(victim, "sentinel"), "keep");
    if (kind === "symlink") symlinkSync(victim, join(root, "data", `${id}.pdf`)); else mkdirSync(join(root, "data", `${id}.pdf`));
    assert.throws(() => new ArtifactStore({ root }), e => e.code === "artifact-root-invalid"); assert.equal(existsSync(join(root, "data", `${id}.pdf`)), true); assert.equal(readFileSync(join(victim, "sentinel"), "utf8"), "keep");
  }
});

test("recoverable boot validation failure rolls back this boot's lock", async () => {
  const root = join(temp(), "artifacts");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "data"), { mode: 0o700 });
  writeFileSync(join(root, "data", "unexpected"), "x");
  assert.throws(() => new ArtifactStore({ enabled: true, root }), e => e.code === "artifact-root-invalid");
  assert.equal(existsSync(join(root, ".gateway-lock")), false);
  unlinkSync(join(root, "data", "unexpected"));
  const store = new ArtifactStore({ enabled: true, root });
  assert.equal(existsSync(join(root, ".gateway-lock")), true);
  await store.close();
});

test("source is copied once with strict PDF magic, size and sha256", async () => {
  const root = join(temp(), "artifacts");
  const source = join(temp(), "source.pdf");
  writeFileSync(source, Buffer.from("%PDF-1.7\nhello"));
  const store = new ArtifactStore({ enabled: true, root });
  const result = await store.capture(source, { id: "A".repeat(22), consumerId: "owner" });
  assert.equal(result.status, "available");
  assert.equal(result.bytes, 14);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(readdirSync(join(root, "data")), [`${"A".repeat(22)}.pdf`]);
  await store.close();
});

test("runtime publication order proves the final name before directory fsync and inserts metadata afterward", async () => {
  const root = join(temp(), "artifacts"), src = source(), id = "O".repeat(22);
  const final = join(root, "data", `${id}.pdf`), events = [];
  let fsyncs = 0, store;
  const ops = {
    linkSync,
    unlinkSync,
    fsyncSync(fd) {
      fsyncs += 1;
      if (fsyncs === 1) events.push("part-fsync");
      if (fsyncs === 2) {
        events.push("data-fsync");
        // Runtime ordering witness only: same-UID mutation after an accepted proof is outside the
        // threat model. If final proof moved after directory fsync, this size change would make the
        // capture fail there instead of reaching metadata insertion.
        writeFileSync(final, Buffer.from("%"));
      }
      return fsyncSync(fd);
    },
  };
  store = new ArtifactStore({ enabled: true, root, fsOps: ops });
  const result = await store.capture(src, { id, consumerId: "owner" });
  events.push("capture-return");
  assert.equal(result.status, "available", "final proof did not precede directory fsync");
  assert.deepEqual(store.accounting(), { ...IDLE, count: 1, bytes: SOURCE_BYTES, consumers: 1 },
    "capture returned before staging converted to committed accounting");
  assert.deepEqual(events, ["part-fsync", "data-fsync", "capture-return"]);
  assert.equal(await store.acquire(id, "owner"), null, "the ordering witness corruption was not rejected on acquire");
  await store.close();
});

test("post-link directory fsync failure rolls back both artifact names", async () => {
  const root = join(temp(), "artifacts");
  const source = join(temp(), "source.pdf");
  writeFileSync(source, Buffer.from("%PDF-1.7\nhello"));
  const store = new ArtifactStore({ enabled: true, root, fsOps: { linkSync, unlinkSync, fsyncSync: () => { throw new Error("fsync sentinel"); } } });
  const result = await store.capture(source, { id: "Z".repeat(22), consumerId: "owner" });
  assert.deepEqual(result, { status: "capture-failed", failure: "artifact-cleanup-failed" });
  assert.deepEqual(readdirSync(join(root, "data")), []);
  await store.close();
});

test("post-link part unlink failure poisons store and retains lock", async () => {
  const root = join(temp(), "artifacts"), source = join(temp(), "source.pdf");
  writeFileSync(source, Buffer.from("%PDF-1.7\nhello"));
  const sentinel = new Error("/private/sentinel");
  const ops = { linkSync, fsyncSync, unlinkSync(path) { if (path.endsWith(".part")) throw sentinel; return unlinkSync(path); } };
  const store = new ArtifactStore({ enabled: true, root, fsOps: ops });
  assert.deepEqual(await store.capture(source, { id: "Y".repeat(22), consumerId: "owner" }), { status: "capture-failed", failure: "artifact-cleanup-failed" });
  assert.deepEqual(await store.capture(source, { id: "X".repeat(22), consumerId: "owner" }), { status: "capture-failed", failure: "artifact-runtime-invalidated" });
  assert.equal(await store.acquire("Y".repeat(22), "owner"), null);
  assert.equal(existsSync(join(root, ".gateway-lock")), true);
  assert.throws(() => new ArtifactStore({ enabled: true, root }), (e) => e.code === "artifact-root-locked" && !String(e).includes("sentinel"));
  await store.close();
  assert.equal(existsSync(join(root, ".gateway-lock")), true);
});

test("discard failure retains available record and callback", async () => {
  const root = join(temp(), "artifacts"), source = join(temp(), "source.pdf"), id = "D".repeat(22); writeFileSync(source, Buffer.from("%PDF-1.7\nhello")); let callbacks = 0;
  const store = new ArtifactStore({ root, onDiscard: () => { callbacks++; }, fsOps: { linkSync, fsyncSync, unlinkSync(path) { if (path.endsWith(`${id}.pdf`)) throw new Error("unlink"); return unlinkSync(path); } } });
  assert.equal((await store.capture(source, { id, consumerId: "owner" })).status, "available"); assert.equal(store.discardArtifact(id), false); assert.equal(callbacks, 0); assert.equal(await store.acquire(id, "owner"), null); assert.equal(existsSync(join(root, ".gateway-lock")), true); await store.close();
});

test("rollback final unlink failure after dir fsync failure poisons store and retains lock", async () => {
  const root = join(temp(), "artifacts"), source = join(temp(), "source.pdf");
  writeFileSync(source, Buffer.from("%PDF-1.7\nhello"));
  const ops = { linkSync, fsyncSync() { throw new Error("fsync sentinel"); }, unlinkSync(path) { if (path.endsWith(".pdf")) throw new Error("unlink sentinel"); return unlinkSync(path); } };
  const store = new ArtifactStore({ enabled: true, root, fsOps: ops });
  assert.deepEqual(await store.capture(source, { id: "W".repeat(22), consumerId: "owner" }), { status: "capture-failed", failure: "artifact-cleanup-failed" });
  assert.equal(existsSync(join(root, ".gateway-lock")), true);
  await store.close();
  assert.equal(existsSync(join(root, ".gateway-lock")), true);
});


// ---------------------------------------------------------------------------------------------
// S1 — poison, closeRequested and disposed are ORTHOGONAL.
//
// Poison used to imply a requested close, so the finally of whichever capture happened to be in
// flight found `closed` true, ran the full close, and removed the `.gateway-lock` of a root that
// nobody had asked to close — inviting a second process to claim a live root.
// ---------------------------------------------------------------------------------------------

/** Poison a live store from a discard whose unlink fails ONCE. The transience is the point: a
 *  permanently failing unlink would make the later close sweep fail too, which retains the lock for
 *  an unrelated reason and hides the question being asked. */
function transientUnlinkFailure(id) {
  let failed = false;
  return { linkSync, fsyncSync, unlinkSync(path) {
    if (!failed && path.endsWith(`${id}.pdf`)) { failed = true; throw Object.assign(new Error("EIO"), { code: "EIO" }); }
    return unlinkSync(path);
  } };
}

test("poison during an active capture tears nothing down: only an explicit close may", async () => {
  const root = join(temp(), "artifacts"), src = source();
  const poisoned = "P".repeat(22), staging = "Q".repeat(22);
  let release; const held = new Promise((resolve) => { release = resolve; });
  let reached; const seam = new Promise((resolve) => { reached = resolve; });
  let arm = false;
  const steps = [];
  const store = new ArtifactStore({
    enabled: true, root, fsOps: transientUnlinkFailure(poisoned),
    onCloseStep: (step) => steps.push(step),
    afterPartFsync: async () => { if (!arm) return; reached(); await held; },
  });

  assert.equal((await store.capture(src, { id: poisoned, consumerId: "owner" })).status, "available");
  arm = true;
  const capturing = store.capture(src, { id: staging, consumerId: "owner" });
  await seam;                                    // a capture is genuinely in flight

  // Poison, with that capture still active and NO close ever requested.
  assert.equal(store.discardArtifact(poisoned), false, "the discard did not fail, so nothing was poisoned");
  release();
  assert.equal((await capturing).status, "capture-failed");

  // THE PROPERTY: poison rejects future work, but it is not a close. Nothing was torn down.
  assert.deepEqual(steps, [], `poison performed close steps (${steps.join(",")})`);
  assert.equal(existsSync(join(root, LOCK)), true, "poison alone removed the .gateway-lock of a live root");
  assert.equal(existsSync(ownerPath(root)), true, "poison alone removed the lock's owner diagnostic");
  assert.equal(existsSync(join(root, "data")), true, "poison alone removed the data directory");
  // A second process still cannot claim the root this one is holding.
  assert.throws(() => new ArtifactStore({ enabled: true, root }), (e) => e.code === "artifact-root-locked");

  // Explicit close after poison remains possible, and it is the ONLY thing that tears down.
  assert.equal(await store.close(), undefined, "an explicit close after poison did not complete");
  assert.deepEqual(
    steps,
    ["delete-files", "fsync-data", "close-data-fd", "remove-data", "remove-diagnostic", "remove-lock", "fsync-root", "close-root-fd"],
    `the explicit close did not run the ordered teardown exactly once (${steps.join(",")})`,
  );
  assert.equal(existsSync(join(root, LOCK)), false, "an explicit close after poison did not remove the lock");
});

test("a repeated close and a late capture settlement cannot repeat teardown", async () => {
  const root = join(temp(), "artifacts"), src = source();
  const steps = [];
  let release; const held = new Promise((resolve) => { release = resolve; });
  let reached; const seam = new Promise((resolve) => { reached = resolve; });
  const store = new ArtifactStore({ enabled: true, root, onCloseStep: (step) => steps.push(step), afterPartFsync: async () => { reached(); await held; } });

  const capturing = store.capture(src, { id: "R".repeat(22), consumerId: "owner" });
  await seam;
  const closing = store.close();                 // deferred: a capture is still active
  assert.deepEqual(steps, [], "close tore down while a capture was still active");
  release();
  assert.equal((await capturing).status, "capture-failed");
  assert.equal(await closing, undefined);
  const once = steps.slice();
  assert.equal(once.length, 8, `the ordered teardown did not run once (${once.join(",")})`);

  // The capture's own finally already fired once; a repeat close must find the teardown guard.
  assert.equal(await store.close(), undefined, "a repeated close did not report the first close's result");
  assert.deepEqual(steps, once, `a repeated close re-ran teardown steps (${steps.join(",")})`);
});

// ---------------------------------------------------------------------------------------------
// M1 §5.1 — the three discard outcomes are DISTINCT, and the public boolean is exactly `clean`.
// ---------------------------------------------------------------------------------------------

test("discardArtifactDetailed separates clean, refused and failed — and the boolean is exactly clean", async () => {
  const src = source(), id = "A".repeat(22), absent = "B".repeat(22);

  // clean — an identity-proven durable deletion, with the discard callback firing exactly once.
  {
    const root = join(temp(), "artifacts"); const seen = [];
    const store = new ArtifactStore({ enabled: true, root, onDiscard: (discarded) => seen.push(discarded) });
    assert.equal((await store.capture(src, { id, consumerId: "owner" })).status, "available");
    assert.equal(store.discardArtifactDetailed(id), "clean");
    assert.deepEqual(seen, [id], "a clean discard did not run its callback exactly once");
    assert.equal(store.discardArtifact(id), true, "the public boolean disagreed with `clean`");
    // clean — an identity-proven no-op: nothing to delete is not a failure, and runs no callback.
    assert.equal(store.discardArtifactDetailed(absent), "clean");
    assert.deepEqual(seen, [id], "an absent discard ran a callback");
    await store.close();
  }

  // refused — a close was REQUESTED but has not finished (a capture is still inside the store).
  {
    const root = join(temp(), "artifacts"); const seen = [];
    let release; const held = new Promise((resolve) => { release = resolve; });
    let reached; const seam = new Promise((resolve) => { reached = resolve; });
    const store = new ArtifactStore({ enabled: true, root, onDiscard: (d) => seen.push(d), afterPartFsync: async () => { reached(); await held; } });
    const capturing = store.capture(src, { id, consumerId: "owner" });
    await seam;
    const closing = store.close();
    assert.equal(store.discardArtifactDetailed(id), "refused", "a closing store did not refuse");
    assert.equal(store.discardArtifact(id), false, "the public boolean reported a refusal as clean");
    assert.deepEqual(seen, [], "a refusal ran a callback");
    release();
    await capturing; await closing;
    // refused — and still refused once the close has actually completed and disposed.
    assert.equal(store.discardArtifactDetailed(id), "refused", "a disposed store did not refuse");
  }

  // failed — poison WITHOUT a requested close cannot prove durable deletion.
  {
    const root = join(temp(), "artifacts"); const seen = [];
    const store = new ArtifactStore({ enabled: true, root, onDiscard: (d) => seen.push(d), fsOps: transientUnlinkFailure(id) });
    assert.equal((await store.capture(src, { id, consumerId: "owner" })).status, "available");
    assert.equal(store.discardArtifactDetailed(id), "failed", "an unlink failure was not a failure");
    assert.deepEqual(seen, [], "a failed discard ran a callback");
    // Now poisoned, and poison alone keeps failing — it never becomes a refusal.
    assert.equal(store.discardArtifactDetailed(absent), "failed", "a poisoned store refused instead of failing");
    assert.equal(existsSync(join(root, LOCK)), true);
    await store.close();
  }

  // failed — identity loss.
  {
    const root = join(temp(), "artifacts"); let armed = false;
    const store = new ArtifactStore({ enabled: true, root, identityOverride: (_target, sourceKind) => (armed && sourceKind === "descriptor" ? "unreadable" : undefined) });
    assert.equal((await store.capture(src, { id, consumerId: "owner" })).status, "available");
    armed = true;
    assert.equal(store.discardArtifactDetailed(id), "failed", "identity loss was not a failure");
    await store.close();
  }

  // failed — a data-directory fsync that cannot be made durable.
  {
    const root = join(temp(), "artifacts");
    let armed = false;
    const store = new ArtifactStore({ enabled: true, root, fsOps: { linkSync, unlinkSync, fsyncSync(fd) { if (armed) throw new Error("fsync"); return fsyncSync(fd); } } });
    assert.equal((await store.capture(src, { id, consumerId: "owner" })).status, "available");
    armed = true;
    assert.equal(store.discardArtifactDetailed(id), "failed", "an unprovable fsync was not a failure");
    await store.close();
  }
});

// ---------------------------------------------------------------------------------------------
// M1 §5.1 / Amendment 2 §5 — a CONSUMING record belongs to its response lease, not to cleanup.
//
// `acquire()` moves a committed record `available -> consuming` and hands the lease the one global
// response permit, its bytes and an exact 15s deadline. Cleanup walked straight past that into the
// private owned-discard path anyway: it cleared the live lease's timer, settled its response, deleted
// the record and file, notified `onDiscard` and freed the ID — so a replacement capture could take
// the ID out from under a response that had not returned yet. Amendment 2 §5 is exact: cleanup sees
// consuming -> skip; consume timeout owns resolution; expiry after consuming begins races nothing;
// no transition returns to `available` once consume has begun.
// ---------------------------------------------------------------------------------------------

test("a discard during an active response lease is refused and mutates nothing", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), clock = fakeScheduler(), discarded = [], id = "V".repeat(22);
  let unlinks = 0, fsyncs = 0;
  const store = new ArtifactStore({ root, scheduler: clock, onDiscard: (i) => discarded.push(i),
    fsOps: { linkSync, unlinkSync(path) { unlinks++; return unlinkSync(path); }, fsyncSync(fd) { fsyncs++; return fsyncSync(fd); } } });
  assert.equal((await store.capture(pdf, { id, consumerId: "owner" })).status, "available");
  const lease = await store.acquire(id, "owner");
  assert.ok(lease);
  assert.equal(lease.record.status, "consuming", "acquire must move the committed record to consuming");
  const file = join(root, "data", `${id}.pdf`), timeout = clock.registration(15_000);
  const before = { bytes: readFileSync(file).length, mode: statSync(file).mode & 0o777, accounting: store.accounting(), unlinks, fsyncs, cleared: clock.cleared.length };
  assert.deepEqual(before.accounting, { ...IDLE, count: 1, bytes: SOURCE_BYTES, consumers: 1, responsePermitHeld: true, responseBytes: SOURCE_BYTES });

  // THE PROPERTY: neither discard surface may take the record its lease is still reading.
  const detailed = store.discardArtifactDetailed(id);
  const boolean = store.discardArtifact(id);
  assert.deepEqual({ detailed, boolean, file: existsSync(file), notified: discarded.length },
    { detailed: "refused", boolean: false, file: true, notified: 0 },
    "a discard during an active lease must refuse and leave the artifact and its callback untouched");
  assert.equal(readFileSync(file).length, before.bytes, "a refused discard changed the consuming artifact's bytes");
  assert.equal(statSync(file).mode & 0o777, before.mode, "a refused discard changed the consuming artifact's mode");
  assert.deepEqual(store.accounting(), before.accounting, "a refused discard mutated accounting, the response permit or the response bytes");
  assert.deepEqual({ unlinks, fsyncs, cleared: clock.cleared.length }, { unlinks: before.unlinks, fsyncs: before.fsyncs, cleared: before.cleared },
    "a refused discard performed an unlink, an fsync or a timer clear");
  assert.ok(clock.pending().some((r) => r.handle === timeout.handle), "a refused discard cancelled the live lease's timeout");

  // The ID stays reserved: nothing may replace the artifact a response has not returned yet.
  assert.deepEqual(await store.capture(pdf, { id, consumerId: "owner" }), { status: "capture-failed", failure: "artifact-capacity" },
    "a refused discard freed the ID for a replacement capture before the lease resolved");
  assert.equal(await store.acquire(id, "owner"), null, "a consuming record must not become leasable again");

  // The lease resolves it — exactly once — through the private owned path.
  lease.complete();
  assert.deepEqual(discarded, [id], "the lease's complete() did not notify exactly once");
  assert.equal(existsSync(file), false, "the lease's complete() did not delete the artifact");
  assert.deepEqual(store.accounting(), IDLE, "the lease's complete() did not release the permit, the bytes and the count");
  assert.equal(clock.cleared.includes(timeout.handle), true, "the lease's complete() did not cancel its own timeout");
  const settled = { unlinks, notified: discarded.length };
  lease.complete();
  clock.advance(15_000);
  assert.deepEqual({ unlinks, notified: discarded.length }, settled, "a stale complete() or a cancelled timeout resolved a second time");
  assert.equal((await store.capture(pdf, { id, consumerId: "owner" })).status, "available", "the resolved ID did not become ordinarily capturable again");
  assert.equal(await store.close(), undefined);
});

test("the response deadline is armed before final open and synchronous work cannot return an expired lease", async () => {
  const sourceText = readFileSync(new URL("../src/artifacts/store.ts", import.meta.url), "utf8");
  const start = sourceText.indexOf("async #lease(");
  const end = sourceText.indexOf("\n  #leasable(", start);
  const leaseSource = sourceText.slice(start, end);
  const arm = leaseSource.indexOf("this.#scheduler.setTimeout");
  const finalOpen = leaseSource.indexOf("openSync(path");
  assert.ok(start >= 0 && end > start && arm >= 0 && finalOpen >= 0, "response lease source was not located");
  assert.ok(arm < finalOpen, "the response deadline was armed only after final open/read/hash work");

  const root = join(temp(), "artifacts"), pdf = source(), firstId = "J".repeat(22), secondId = "K".repeat(22);
  const base = fakeScheduler();
  // Time moves per OBSERVATION, not per call index. The deadline is `now() + 15s`, so a fixture that
  // freezes the first reading and jumps every later one moves the anchor along with the clock and can
  // never spend the budget — the store simply reads a later `now` and a later deadline. Advancing a
  // full budget on every reading makes the gap between the anchor and the post-encode check exactly
  // one budget by construction, whatever order the lease reads its clock in. `base.advance` is
  // deliberately not used: it DISPATCHES due timers, which is precisely the event a single
  // synchronous JS turn cannot produce and which this test exists to survive without.
  let phase = "normal", elapsed = 0;
  const scheduler = {
    ...base,
    now() {
      if (phase === "expired-lease") elapsed += 15_000;
      return base.now() + elapsed;
    },
  };
  const store = new ArtifactStore({ root, scheduler });
  assert.equal((await store.capture(pdf, { id: firstId, consumerId: "owner" })).status, "available");

  // Model synchronous open/read/hash/base64 consuming the whole budget: the first now() anchors the
  // deadline; every later observation is exactly at it. A timer cannot dispatch inside that JS turn,
  // so acquire itself must detect expiration before returning response bytes or a live permit.
  phase = "expired-lease";
  assert.equal(await store.acquire(firstId, "owner"), null, "an already-expired response lease escaped acquire()");
  phase = "normal";
  assert.equal(existsSync(join(root, "data", `${firstId}.pdf`)), false, "the expired consume left its artifact available");
  assert.deepEqual(store.accounting(), IDLE, "the expired consume retained its permit, bytes, or artifact accounting");

  // Permit release is observable: a different artifact can immediately acquire and complete.
  assert.equal((await store.capture(pdf, { id: secondId, consumerId: "owner" })).status, "available");
  const second = await store.acquire(secondId, "owner");
  assert.ok(second, "the expired consume stranded the global response permit");
  second.complete();
  assert.deepEqual(store.accounting(), IDLE);
  assert.equal(await store.close(), undefined);
});

test("expiry cannot reap a consuming record: its completion or its exact 15s timeout resolves it", async () => {
  // A store whose artifact TTL expires while a response lease is live. Nothing here reads wall time.
  function expiring(id) {
    const root = join(temp(), "artifacts"), pdf = source(), clock = fakeScheduler(), discarded = [];
    const counters = { unlinks: 0 };
    const store = new ArtifactStore({ root, scheduler: clock, ttlMs: 1000, onDiscard: (i) => discarded.push(i),
      fsOps: { linkSync, fsyncSync, unlinkSync(path) { counters.unlinks++; return unlinkSync(path); } } });
    return { root, pdf, clock, discarded, counters, store, id, file: join(root, "data", `${id}.pdf`) };
  }

  // Advance exactly onto the TTL boundary with the lease still live, then fire BOTH reaping triggers:
  // the periodic pass, and the synchronous reap a public entry point runs before anything else.
  async function reapAtExpiry(ctx, lease) {
    const periodic = ctx.clock.registration(60_000);
    ctx.clock.advance(1000);
    assert.equal(ctx.clock.now(), lease.record.expiresAt, "the clock must sit exactly on the artifact's expiry");
    periodic.callback();
    assert.equal(await ctx.store.acquire("Z".repeat(22), "owner"), null);
  }

  // Phase A — the lease completes inside its 15s window; expiry never had standing to preempt it.
  {
    const ctx = expiring("W".repeat(22));
    assert.equal((await ctx.store.capture(ctx.pdf, { id: ctx.id, consumerId: "owner" })).status, "available");
    const lease = await ctx.store.acquire(ctx.id, "owner");
    assert.ok(lease);
    const timeout = ctx.clock.registration(15_000);
    const before = { accounting: ctx.store.accounting(), unlinks: ctx.counters.unlinks, cleared: ctx.clock.cleared.length };
    await reapAtExpiry(ctx, lease);

    assert.deepEqual({ file: existsSync(ctx.file), notified: ctx.discarded.length, unlinks: ctx.counters.unlinks },
      { file: true, notified: 0, unlinks: before.unlinks },
      "expiry reaping deleted an artifact whose response lease was still active");
    assert.deepEqual(ctx.store.accounting(), before.accounting, "expiry reaping mutated the accounting or the response permit of a consuming record");
    assert.equal(ctx.clock.cleared.length, before.cleared, "expiry reaping cleared the live lease's timeout");
    assert.ok(ctx.clock.pending().some((r) => r.handle === timeout.handle), "expiry reaping cancelled the live lease's timeout");
    assert.deepEqual(await ctx.store.capture(ctx.pdf, { id: ctx.id, consumerId: "owner" }), { status: "capture-failed", failure: "artifact-capacity" },
      "expiry reaping freed a consuming ID for reuse");

    lease.complete();
    assert.deepEqual(ctx.discarded, [ctx.id], "the lease's complete() did not resolve the expired consuming record exactly once");
    assert.equal(existsSync(ctx.file), false);
    assert.deepEqual(ctx.store.accounting(), IDLE);
    const settled = { unlinks: ctx.counters.unlinks, notified: ctx.discarded.length };
    ctx.clock.advance(14_000);                       // past what would have been the response deadline
    lease.complete();
    assert.deepEqual({ unlinks: ctx.counters.unlinks, notified: ctx.discarded.length }, settled, "a stale complete() or a cancelled timeout resolved a second time");
    assert.equal(await ctx.store.close(), undefined);
  }

  // Phase B — nobody completes: the exact 15s response timeout is the resolver, and expiry is not.
  {
    const ctx = expiring("X".repeat(22));
    assert.equal((await ctx.store.capture(ctx.pdf, { id: ctx.id, consumerId: "owner" })).status, "available");
    const lease = await ctx.store.acquire(ctx.id, "owner");
    assert.ok(lease);
    const before = { accounting: ctx.store.accounting(), unlinks: ctx.counters.unlinks };
    await reapAtExpiry(ctx, lease);

    assert.deepEqual({ file: existsSync(ctx.file), notified: ctx.discarded.length, unlinks: ctx.counters.unlinks },
      { file: true, notified: 0, unlinks: before.unlinks },
      "expiry reaping deleted an artifact whose response lease was still active");
    assert.deepEqual(ctx.store.accounting(), before.accounting, "expiry reaping mutated the accounting or the response permit of a consuming record");

    ctx.clock.advance(13_999);                       // one tick short of the response deadline
    assert.deepEqual({ file: existsSync(ctx.file), notified: ctx.discarded.length }, { file: true, notified: 0 },
      "the consuming record resolved before its exact 15s deadline");
    assert.deepEqual(ctx.store.accounting(), before.accounting);
    ctx.clock.advance(1);                            // exactly the response deadline
    assert.equal(ctx.clock.now(), lease.deadline);
    assert.deepEqual({ file: existsSync(ctx.file), notified: ctx.discarded.length }, { file: false, notified: 1 },
      "the exact 15s response timeout did not resolve the consuming record");
    assert.deepEqual(ctx.discarded, [ctx.id]);
    assert.deepEqual(ctx.store.accounting(), IDLE, "the timeout did not release the permit, the bytes and the count");
    const settled = { unlinks: ctx.counters.unlinks, notified: ctx.discarded.length };
    lease.complete();
    assert.deepEqual({ unlinks: ctx.counters.unlinks, notified: ctx.discarded.length }, settled, "a complete() after the timeout resolved a second time");
    assert.equal((await ctx.store.capture(ctx.pdf, { id: ctx.id, consumerId: "owner" })).status, "available", "the timed-out ID did not become ordinarily capturable again");
    assert.equal(await ctx.store.close(), undefined);
  }
});

test("close after part fsync waits for capture and invalidates without publishing", async () => {
  const root = join(temp(), "artifacts"), source = join(temp(), "source.pdf"); writeFileSync(source, Buffer.from("%PDF-1.7\nhello"));
  let release; const paused = new Promise(resolve => { release = resolve; }); let reached; const seam = new Promise(resolve => { reached = resolve; });
  const store = new ArtifactStore({ root, afterPartFsync: async () => { reached(); await paused; } }); const id = "C".repeat(22); const pending = store.capture(source, { id, consumerId: "owner" }); await seam;
  const closing = store.close(); assert.equal(existsSync(join(root, ".gateway-lock")), true); release(); assert.deepEqual(await pending, { status: "capture-failed", failure: "artifact-runtime-invalidated" }); assert.equal(await closing, undefined); assert.equal(existsSync(join(root, ".gateway-lock")), false);
});

test("same-id in-flight capture is rejected without touching first part", async () => {
  const root = join(temp(), "artifacts"), source = join(temp(), "source.pdf"), id = "K".repeat(22); writeFileSync(source, Buffer.from("%PDF-1.7\nhello"));
  let release; const paused = new Promise(resolve => { release = resolve; }); let reached; const seam = new Promise(resolve => { reached = resolve; }); const store = new ArtifactStore({ root, afterPartFsync: async () => { reached(); await paused; } });
  const first = store.capture(source, { id, consumerId: "a" }); await seam; assert.deepEqual(await store.capture(source, { id, consumerId: "b" }), { status: "capture-failed", failure: "artifact-capacity" }); assert.equal(existsSync(join(root, "data", `${id}.part`)), true); release(); assert.equal((await first).status, "available"); assert.equal(existsSync(join(root, "data", `${id}.pdf`)), true); await store.close();
});

test("lock removal failure returns typed close failure and retains lock", async () => {
  const root = join(temp(), "artifacts"); const ops = { linkSync, unlinkSync, fsyncSync, rmdirSync() { throw new Error("rmdir sentinel"); } }; const store = new ArtifactStore({ root, fsOps: ops });
  assert.equal(await store.close(), "artifact-cleanup-failed"); assert.equal(existsSync(join(root, ".gateway-lock")), true);
});

test("post-link close cleanup failure is awaitable and retains the lock", async () => {
  const root = join(temp(), "artifacts"), source = join(temp(), "source.pdf"), id = "L".repeat(22);
  writeFileSync(source, Buffer.from("%PDF-1.7\nhello")); let release; const paused = new Promise(r => { release = r; }); let reached; const seam = new Promise(r => { reached = r; });
  const store = new ArtifactStore({ root, afterLinkBeforeCommit: async () => { reached(); await paused; }, fsOps: { linkSync, fsyncSync, unlinkSync(path) { if (path.endsWith(`${id}.pdf`)) throw new Error("/private/sentinel"); return unlinkSync(path); } } });
  const capture = store.capture(source, { id, consumerId: "owner" }); await seam; const closing = store.close(); assert.equal(existsSync(join(root, ".gateway-lock")), true); release();
  assert.equal(await closing, "artifact-cleanup-failed"); assert.equal((await capture).failure, "artifact-cleanup-failed"); assert.equal(existsSync(join(root, ".gateway-lock")), true); assert.throws(() => new ArtifactStore({ root }), e => e.code === "artifact-root-locked" && !String(e).includes("sentinel"));
});

test("clean post-link close invalidates capture and removes lock", async () => {
  const root = join(temp(), "artifacts"), source = join(temp(), "source.pdf"), id = "M".repeat(22);
  writeFileSync(source, Buffer.from("%PDF-1.7\nhello")); let release; const paused = new Promise(r => { release = r; }); let reached; const seam = new Promise(r => { reached = r; });
  const store = new ArtifactStore({ root, afterLinkBeforeCommit: async () => { reached(); await paused; } }); const capture = store.capture(source, { id, consumerId: "owner" }); await seam; const closing = store.close(); release();
  assert.deepEqual(await capture, { status: "capture-failed", failure: "artifact-runtime-invalidated" }); assert.equal(await closing, undefined); assert.equal(existsSync(join(root, "data")), false, "a clean close removes the emptied data directory"); assert.equal(existsSync(join(root, ".gateway-lock")), false);
});

test("close resolves cleanup failure when data readdir fails", async () => {
  const root = join(temp(), "artifacts"), ops = { linkSync, unlinkSync, fsyncSync, readdirSync() { throw new Error("/private/readdir-sentinel"); } };
  const store = new ArtifactStore({ root, fsOps: ops }); const first = store.close(); assert.equal(await first, "artifact-cleanup-failed"); assert.equal(await store.close(), "artifact-cleanup-failed"); assert.equal(existsSync(join(root, ".gateway-lock")), true);
});

test("startup cleanup unlink failure retains lock and hides raw errors", () => {
  const root = join(temp(), "artifacts"), id = "S".repeat(22); mkdirSync(root, { mode: 0o700 }); mkdirSync(join(root, "data"), { mode: 0o700 }); chmodSync(join(root, "data", ".."), 0o700); writeFileSync(join(root, "data", `${id}.part`), "part"); chmodSync(join(root, "data", `${id}.part`), 0o600);
  const sentinel = "/private/startup-sentinel"; assert.throws(() => new ArtifactStore({ root, fsOps: { linkSync, fsyncSync, unlinkSync() { throw new Error(sentinel); } } }), e => e.code === "artifact-cleanup-failed" && !String(e).includes(sentinel)); assert.equal(existsSync(join(root, ".gateway-lock")), true); assert.throws(() => new ArtifactStore({ root }), e => e.code === "artifact-root-locked");
});

test("startup cleanup fsync failure retains lock because deletion is not durable", () => {
  const root = join(temp(), "artifacts"), id = "F".repeat(22); mkdirSync(root, { mode: 0o700 }); mkdirSync(join(root, "data"), { mode: 0o700 }); writeFileSync(join(root, "data", `${id}.part`), "part"); chmodSync(join(root, "data", `${id}.part`), 0o600);
  assert.throws(() => new ArtifactStore({ root, fsOps: { linkSync, unlinkSync, fsyncSync() { throw new Error("/private/fsync-sentinel"); } } }), e => e.code === "artifact-cleanup-failed" && !String(e).includes("fsync-sentinel")); assert.equal(existsSync(join(root, ".gateway-lock")), true); assert.throws(() => new ArtifactStore({ root }), e => e.code === "artifact-root-locked");
});

test("startup validates every entry before deleting any valid entry", () => {
  const root = join(temp(), "artifacts"), valid = "A".repeat(22), invalid = "B".repeat(22);
  mkdirSync(root, { mode: 0o700 }); mkdirSync(join(root, "data"), { mode: 0o700 });
  const validPath = join(root, "data", `${valid}.pdf`); writeFileSync(validPath, "valid"); chmodSync(validPath, 0o600);
  mkdirSync(join(root, "data", `${invalid}.pdf`), { mode: 0o700 });
  assert.throws(() => new ArtifactStore({ root }), e => e.code === "artifact-root-invalid");
  assert.equal(readFileSync(validPath, "utf8"), "valid"); assert.equal(statSync(validPath).isFile(), true);
  assert.equal(existsSync(join(root, ".gateway-lock")), false);
});

test("discard observer failure does not poison store or prevent release", async () => {
  const root = join(temp(), "artifacts"), source = join(temp(), "source.pdf"), id = "O".repeat(22);
  writeFileSync(source, Buffer.from("%PDF-1.7\nhello"));
  const store = new ArtifactStore({ root, onDiscard: () => { throw new Error("observer sentinel"); } });
  assert.equal((await store.capture(source, { id, consumerId: "owner" })).status, "available"); assert.equal(store.discardArtifact(id), true);
  assert.equal(existsSync(join(root, "data", `${id}.pdf`)), false);
  assert.equal((await store.capture(source, { id, consumerId: "owner" })).status, "available");
  assert.equal(await store.close(), undefined); assert.equal(existsSync(join(root, ".gateway-lock")), false);
});

test("close retains failure from a record discard even when residual cleanup later succeeds", async () => {
  const root = join(temp(), "artifacts"), source = join(temp(), "source.pdf"), id = "V".repeat(22);
  writeFileSync(source, Buffer.from("%PDF-1.7\nhello")); let attempts = 0;
  const store = new ArtifactStore({ root, fsOps: { linkSync, fsyncSync, readdirSync, rmdirSync, unlinkSync(path) { if (path.endsWith(`${id}.pdf`) && attempts++ === 0) throw new Error("first discard"); return unlinkSync(path); } } });
  assert.equal((await store.capture(source, { id, consumerId: "owner" })).status, "available"); assert.equal(await store.close(), "artifact-cleanup-failed");
  assert.equal(existsSync(join(root, "data", `${id}.pdf`)), false); assert.equal(await store.close(), "artifact-cleanup-failed");
  assert.equal(existsSync(join(root, ".gateway-lock")), true);
});

test("periodic cleanup interval must be a finite positive integer", () => {
  for (const cleanupIntervalMs of [0, -1, 1.5, NaN, Infinity, "60000"]) {
    const root = join(temp(), "artifacts");
    assert.throws(() => new ArtifactStore({ root, cleanupIntervalMs }), (e) => e.code === "artifact-config-invalid");
    assert.equal(existsSync(root), false);
  }
});

test("expiry is decided by the injected scheduler at the exact TTL boundary", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), clock = fakeScheduler(), discarded = [];
  const early = "E".repeat(22), exact = "X".repeat(22);
  const store = new ArtifactStore({ root, scheduler: clock, ttlMs: 1000, onDiscard: (id) => discarded.push(id) });
  const record = await store.capture(pdf, { id: early, consumerId: "owner" });
  assert.equal(record.createdAt, clock.now());
  assert.equal(record.expiresAt, clock.now() + 1000);
  assert.equal((await store.capture(pdf, { id: exact, consumerId: "owner" })).status, "available");
  clock.advance(999);
  const lease = await store.acquire(early, "owner");
  assert.ok(lease, "now === expiresAt - 1 must remain available");
  lease.complete();
  clock.advance(1);
  assert.equal(await store.acquire(exact, "owner"), null);
  assert.deepEqual(readdirSync(join(root, "data")), []);
  assert.deepEqual(discarded, [early, exact]);
  await store.close();
});

test("response lease deadline and timeout advance only on the injected scheduler", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), clock = fakeScheduler(), discarded = [], id = "T".repeat(22);
  const store = new ArtifactStore({ root, scheduler: clock, onDiscard: (i) => discarded.push(i) });
  assert.equal((await store.capture(pdf, { id, consumerId: "owner" })).status, "available");
  const wallBefore = Date.now();
  const lease = await store.acquire(id, "owner");
  assert.ok(lease);
  assert.equal(lease.deadline, clock.now() + 15_000);
  assert.ok(clock.pending().some((r) => r.delayMs === 15_000), "lease timeout must be registered on the injected scheduler");
  clock.advance(14_999);
  assert.deepEqual(discarded, []);
  assert.equal(existsSync(join(root, "data", `${id}.pdf`)), true);
  clock.advance(1);
  assert.deepEqual(discarded, [id]);
  assert.equal(existsSync(join(root, "data", `${id}.pdf`)), false);
  assert.equal(await store.acquire(id, "owner"), null);
  lease.complete(); lease.complete();
  assert.deepEqual(discarded, [id]);
  assert.ok(Date.now() - wallBefore < 15_000, "ambient wall time must be irrelevant");
  await store.close();
});

test("lease completion cancels the timeout and later time advance is inert", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), clock = fakeScheduler(), discarded = [], id = "C".repeat(22);
  const store = new ArtifactStore({ root, scheduler: clock, onDiscard: (i) => discarded.push(i) });
  assert.equal((await store.capture(pdf, { id, consumerId: "owner" })).status, "available");
  const lease = await store.acquire(id, "owner");
  assert.ok(lease);
  const timeout = clock.registration(15_000);
  lease.complete();
  assert.equal(clock.cleared.includes(timeout.handle), true);
  assert.deepEqual(discarded, [id]);
  assert.equal((await store.capture(pdf, { id, consumerId: "owner" })).status, "available");
  clock.advance(60_000);
  assert.deepEqual(discarded, [id]);
  assert.equal(existsSync(join(root, "data", `${id}.pdf`)), true);
  lease.complete();
  assert.deepEqual(discarded, [id]);
  await store.close();
});

test("periodic cleanup defaults to 60s, is single-flight, and reschedules only after settlement", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), clock = fakeScheduler(), discarded = [];
  const first = "A".repeat(22), second = "B".repeat(22);
  let reentering = false, nested = false, registrationsDuringPass = -1, passes = 0;
  const store = new ArtifactStore({ root, scheduler: clock, ttlMs: 1000, onDiscard: (id) => discarded.push(id), onCleanupPass: () => {
    if (reentering) { nested = true; return; }
    passes++;
    reentering = true; periodic.callback(); reentering = false;
    registrationsDuringPass = clock.registrations.length;
  } });
  const periodic = clock.registration(60_000);
  assert.ok(periodic, "constructor must schedule the default 60s cleanup on the injected scheduler");
  assert.equal(clock.registrations.length, 1);
  assert.equal((await store.capture(pdf, { id: first, consumerId: "owner" })).status, "available");
  assert.equal((await store.capture(pdf, { id: second, consumerId: "owner" })).status, "available");
  clock.advance(60_000);
  assert.equal(nested, false, "a second pass must not enter while one is running");
  assert.equal(passes, 1);
  assert.equal(registrationsDuringPass, 1, "the next schedule must not be established mid-pass");
  assert.equal(clock.registrations.length, 2);
  assert.equal(clock.registration(60_000).delayMs, 60_000);
  assert.deepEqual(discarded.slice().sort(), [first, second].sort());
  assert.deepEqual(readdirSync(join(root, "data")), []);
  await store.close();
});

test("close cancels artifact timers and post-close callbacks cannot mutate state", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), clock = fakeScheduler(), discarded = [], id = "L".repeat(22);
  let unlinks = 0;
  const ops = { linkSync, fsyncSync, unlinkSync(path) { unlinks++; return unlinkSync(path); } };
  const store = new ArtifactStore({ root, scheduler: clock, fsOps: ops, onDiscard: (i) => discarded.push(i) });
  assert.equal((await store.capture(pdf, { id, consumerId: "owner" })).status, "available");
  const lease = await store.acquire(id, "owner");
  assert.ok(lease);
  const periodic = clock.registration(60_000), timeout = clock.registration(15_000);
  assert.equal(await store.close(), undefined);
  assert.equal(clock.pending().length, 0);
  assert.equal(clock.cleared.includes(periodic.handle), true);
  assert.equal(clock.cleared.includes(timeout.handle), true);
  assert.deepEqual(discarded, [id]);
  const settled = unlinks;
  periodic.callback(); timeout.callback(); lease.complete();
  assert.equal(unlinks, settled, "no post-close callback may attempt filesystem mutation");
  assert.deepEqual(discarded, [id]);
  assert.equal(clock.registrations.length, 2, "close must not leave the periodic pass rescheduling");
  assert.equal(existsSync(join(root, ".gateway-lock")), false);
});

test("a staging capture holds its global count slot before it is committed", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), gate = stagingGate();
  const committed = "A".repeat(22), staging = "B".repeat(22), rejected = "C".repeat(22);
  const store = new ArtifactStore({ root, maxCount: 2, afterPartFsync: gate.hook });
  gate.disarm();
  assert.equal((await store.capture(pdf, { id: committed, consumerId: "one" })).status, "available");
  gate.arm();
  const pending = store.capture(pdf, { id: staging, consumerId: "two" });
  gate.disarm();
  assert.deepEqual(await store.capture(pdf, { id: rejected, consumerId: "three" }), { status: "capture-failed", failure: "artifact-capacity" });
  assert.equal(existsSync(join(root, "data", `${rejected}.part`)), false, "a rejected reservation must not create a destination file");
  assert.equal(store.accounting().count, 2);
  gate.release();
  assert.equal((await pending).status, "available");
  await store.close();
});

test("per-consumer count reservation includes that consumer's staging capture", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), gate = stagingGate();
  const first = "D".repeat(22), second = "E".repeat(22);
  const store = new ArtifactStore({ root, perConsumerCount: 1, afterPartFsync: gate.hook });
  const pending = store.capture(pdf, { id: first, consumerId: "owner" });
  gate.disarm();
  assert.deepEqual(await store.capture(pdf, { id: second, consumerId: "owner" }), { status: "capture-failed", failure: "artifact-capacity" });
  assert.equal(existsSync(join(root, "data", `${second}.part`)), false);
  assert.equal((await store.capture(pdf, { id: second, consumerId: "other" })).status, "available");
  gate.release();
  assert.equal((await pending).status, "available");
  await store.close();
});

test("staging bytes block aggregate over-admission while nothing is committed", async () => {
  const root = join(temp(), "artifacts"), big = bigSource(5 * 1024 * 1024), pdf = source(), gate = stagingGate();
  const first = "F".repeat(22), second = "G".repeat(22);
  const store = new ArtifactStore({ root, maxBytes: 12 * 1024 * 1024, afterPartFsync: gate.hook });
  const pending = store.capture(big, { id: first, consumerId: "one" });
  gate.disarm();
  // 5 MiB staging + an 8 MiB admission exceeds the 12 MiB cap, with no record committed anywhere.
  assert.deepEqual(await store.capture(pdf, { id: second, consumerId: "two" }), { status: "capture-failed", failure: "artifact-capacity" });
  assert.equal(existsSync(join(root, "data", `${second}.part`)), false);
  assert.equal(store.accounting().stagingBytes, 5 * 1024 * 1024, "an uncommitted copy still holds its exact bytes");
  gate.release();
  assert.equal((await pending).status, "available");
  // A committed 5 MiB artifact still leaves no room for an 8 MiB admission under a 12 MiB cap.
  assert.deepEqual(await store.capture(pdf, { id: second, consumerId: "two" }), { status: "capture-failed", failure: "artifact-capacity" });
  assert.equal(store.discardArtifact(first), true);
  assert.equal((await store.capture(pdf, { id: second, consumerId: "two" })).status, "available");
  await store.close();
});

test("per-consumer staging bytes are reserved independently of other consumers", async () => {
  const root = join(temp(), "artifacts"), big = bigSource(5 * 1024 * 1024), pdf = source(), gate = stagingGate();
  const first = "H".repeat(22), blocked = "I".repeat(22), other = "J".repeat(22);
  const store = new ArtifactStore({ root, perConsumerBytes: 12 * 1024 * 1024, afterPartFsync: gate.hook });
  const pending = store.capture(big, { id: first, consumerId: "owner" });
  gate.disarm();
  assert.deepEqual(await store.capture(pdf, { id: blocked, consumerId: "owner" }), { status: "capture-failed", failure: "artifact-capacity" });
  assert.equal(existsSync(join(root, "data", `${blocked}.part`)), false);
  assert.equal((await store.capture(pdf, { id: other, consumerId: "stranger" })).status, "available");
  gate.release();
  assert.equal((await pending).status, "available");
  await store.close();
});

test("exact source size releases the unused byte reservation promptly", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), gate = stagingGate(), id = "K".repeat(22);
  const store = new ArtifactStore({ root, afterPartFsync: gate.hook });
  const pending = store.capture(pdf, { id, consumerId: "owner" });
  gate.disarm();
  assert.deepEqual(store.accounting(), { ...IDLE, count: 1, bytes: SOURCE_BYTES, stagingBytes: SOURCE_BYTES, stagePermits: 1, consumers: 1 }, "the pessimistic reservation must shrink to the exact size before the copy completes");
  gate.release();
  assert.equal((await pending).status, "available");
  assert.deepEqual(store.accounting(), { ...IDLE, count: 1, bytes: SOURCE_BYTES, consumers: 1 });
  await store.close();
});

test("every terminal capture and lease path releases its reservation exactly once", async () => {
  const pdf = source(), id = "L".repeat(22);
  const tiny = join(temp(), "tiny.pdf"); writeFileSync(tiny, Buffer.from("%PD"));
  const notPdf = join(temp(), "plain.pdf"); writeFileSync(notPdf, Buffer.from("plain text, not a pdf"));
  const oversize = join(temp(), "big.pdf"); writeFileSync(oversize, Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(STAGE_BYTES)]));
  const failures = [[tiny, "artifact-not-pdf"], [notPdf, "artifact-integrity-failed"], [oversize, "artifact-size-limit"]];
  for (const [path, failure] of failures) {
    const store = new ArtifactStore({ root: join(temp(), "artifacts") });
    assert.deepEqual(await store.capture(path, { id, consumerId: "owner" }), { status: "capture-failed", failure });
    assert.deepEqual(store.accounting(), IDLE);
    await store.close();
  }
  { // write failure with confirmed rollback
    const store = new ArtifactStore({ root: join(temp(), "artifacts"), fsOps: { unlinkSync, fsyncSync, linkSync() { throw new Error("/private/link-sentinel"); } } });
    assert.deepEqual(await store.capture(pdf, { id, consumerId: "owner" }), { status: "capture-failed", failure: "artifact-write-failed" });
    assert.deepEqual(store.accounting(), IDLE);
    await store.close();
  }
  { // completion, repeated completion and repeated discard
    const store = new ArtifactStore({ root: join(temp(), "artifacts") });
    assert.equal((await store.capture(pdf, { id, consumerId: "owner" })).status, "available");
    const lease = await store.acquire(id, "owner"); assert.ok(lease);
    assert.deepEqual(store.accounting(), { ...IDLE, count: 1, bytes: SOURCE_BYTES, consumers: 1, responsePermitHeld: true, responseBytes: SOURCE_BYTES });
    lease.complete(); lease.complete();
    assert.equal(store.discardArtifact(id), true); assert.equal(store.discardArtifact(id), true);
    assert.deepEqual(store.accounting(), IDLE);
    await store.close();
  }
  { // explicit discard of an available artifact
    const store = new ArtifactStore({ root: join(temp(), "artifacts") });
    assert.equal((await store.capture(pdf, { id, consumerId: "owner" })).status, "available");
    assert.equal(store.discardArtifact(id), true);
    assert.deepEqual(store.accounting(), IDLE);
    await store.close();
  }
  { // expiry and lease timeout on the injected clock
    const clock = fakeScheduler(), store = new ArtifactStore({ root: join(temp(), "artifacts"), scheduler: clock, ttlMs: 1000 });
    assert.equal((await store.capture(pdf, { id, consumerId: "owner" })).status, "available");
    clock.advance(60_000); // the periodic pass reaps the expired record and releases its reservation
    assert.deepEqual(store.accounting(), IDLE);
    assert.equal((await store.capture(pdf, { id, consumerId: "owner" })).status, "available");
    const lease = await store.acquire(id, "owner"); assert.ok(lease);
    clock.advance(15_000);
    assert.deepEqual(store.accounting(), IDLE);
    lease.complete();
    assert.deepEqual(store.accounting(), IDLE);
    await store.close();
  }
  { // clean close
    const store = new ArtifactStore({ root: join(temp(), "artifacts") });
    assert.equal((await store.capture(pdf, { id, consumerId: "owner" })).status, "available");
    assert.equal(await store.close(), undefined);
    assert.deepEqual(store.accounting(), IDLE);
  }
});

test("unconfirmed cleanup retains reserved count and bytes instead of freeing capacity", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), id = "M".repeat(22);
  const store = new ArtifactStore({ root, fsOps: { linkSync, fsyncSync, unlinkSync(path) { if (path.endsWith(`${id}.pdf`)) throw new Error("/private/unlink-sentinel"); return unlinkSync(path); } } });
  assert.equal((await store.capture(pdf, { id, consumerId: "owner" })).status, "available");
  assert.equal(store.discardArtifact(id), false);
  const retained = { ...IDLE, count: 1, bytes: SOURCE_BYTES, consumers: 1 };
  assert.deepEqual(store.accounting(), retained, "an undeleted artifact's capacity must not become reusable");
  assert.equal(await store.close(), "artifact-cleanup-failed");
  assert.deepEqual(store.accounting(), retained, "close must not fabricate zero accounting for unconfirmed cleanup");
  assert.equal(existsSync(join(root, ".gateway-lock")), true);
});

// The OTHER way a close fabricates zero accounting, and the one an unlink failure cannot reach: the
// record's own physical deletion SUCCEEDS and a later ordered step fails. The close sweep performed
// the logical release — record removal, reservation release and the `onDiscard` notification —
// inside the very call that deleted the file, so a `delete-files`, `fsync-data` or `close-data-fd`
// failure after it returned `artifact-cleanup-failed` over a ledger that had already fallen to zero.
// A close that cannot prove its own tree is clean has not made that capacity reusable (B2.2 evidence
// 5 and 9), and Amendment 7 §5.2 retains the identity permanently.
test("a close that fails after sweeping its own records retains their committed accounting", async () => {
  for (const failAt of ["delete-files", "fsync-data", "close-data-fd"]) {
    const root = join(temp(), "artifacts"), pdf = source(), id = "M".repeat(22), discards = [];
    const store = new ArtifactStore({
      root, scheduler: fakeScheduler(), closeStepFails: (step) => step === failAt,
      onDiscard: (discardedId, closeOwned) => discards.push([discardedId, closeOwned]),
    });
    assert.equal((await store.capture(pdf, { id, consumerId: "owner" })).status, "available");
    const committed = { ...IDLE, count: 1, bytes: SOURCE_BYTES, consumers: 1 };
    assert.deepEqual(store.accounting(), committed, `${failAt}: the precondition never committed an artifact`);
    assert.equal(await store.close(), "artifact-cleanup-failed", failAt);
    assert.deepEqual(store.accounting(), committed, `${failAt}: a failed close fabricated zero committed accounting`);
    assert.deepEqual(discards, [], `${failAt}: a failed close announced a logical release it never proved`);
    assert.equal(existsSync(join(root, LOCK)), true, `${failAt}: a failed close removed the lock`);
  }
});

test("a stale lease cannot release a replacement reservation or the live response permit", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), clock = fakeScheduler(), discarded = [], id = "N".repeat(22);
  const store = new ArtifactStore({ root, scheduler: clock, onDiscard: (i) => discarded.push(i) });
  assert.equal((await store.capture(pdf, { id, consumerId: "owner" })).status, "available");
  const stale = await store.acquire(id, "owner"); assert.ok(stale);
  const staleTimeout = clock.registration(15_000);
  clock.advance(15_000);
  assert.deepEqual(discarded, [id]);
  assert.deepEqual(store.accounting(), IDLE);
  assert.equal((await store.capture(pdf, { id, consumerId: "owner" })).status, "available");
  const fresh = await store.acquire(id, "owner"); assert.ok(fresh, "the replacement artifact must be leasable");
  const live = store.accounting();
  stale.complete(); staleTimeout.callback();
  assert.deepEqual(store.accounting(), live, "a stale token must not touch the replacement's accounting");
  assert.equal(store.accounting().responsePermitHeld, true);
  assert.equal(existsSync(join(root, "data", `${id}.pdf`)), true);
  fresh.complete();
  assert.deepEqual(store.accounting(), IDLE);
  assert.deepEqual(discarded, [id, id]);
  await store.close();
});

test("at most two stage copies run and a third fails before creating a destination file", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), gate = stagingGate();
  const a = "O".repeat(22), b = "P".repeat(22), c = "Q".repeat(22);
  const store = new ArtifactStore({ root, afterPartFsync: gate.hook });
  const first = store.capture(pdf, { id: a, consumerId: "one" });
  const second = store.capture(pdf, { id: b, consumerId: "two" });
  gate.disarm();
  assert.deepEqual(await store.capture(pdf, { id: c, consumerId: "three" }), { status: "capture-failed", failure: "artifact-capacity" });
  assert.equal(existsSync(join(root, "data", `${c}.part`)), false);
  assert.deepEqual(readdirSync(join(root, "data")).sort(), [`${a}.part`, `${b}.part`].sort());
  assert.equal(store.accounting().stagePermits, 2);
  assert.equal(store.accounting().stagePermitLimit, 2);
  gate.release();
  assert.equal((await first).status, "available");
  assert.equal((await second).status, "available");
  assert.equal(store.accounting().stagePermits, 0, "a rejected stage must leak no permit");
  assert.equal((await store.capture(pdf, { id: c, consumerId: "three" })).status, "available");
  await store.close();
});

test("one global response permit serializes leases and starts the deadline after admission", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), clock = fakeScheduler();
  const a = "R".repeat(22), b = "S".repeat(22);
  const store = new ArtifactStore({ root, scheduler: clock });
  assert.equal((await store.capture(pdf, { id: a, consumerId: "owner" })).status, "available");
  assert.equal((await store.capture(pdf, { id: b, consumerId: "owner" })).status, "available");
  const first = await store.acquire(a, "owner"); assert.ok(first);
  assert.equal(first.deadline, clock.now() + 15_000);
  const waiting = store.acquire(b, "owner");
  await Promise.resolve(); await Promise.resolve();
  assert.equal(await Promise.race([waiting, Promise.resolve("waiting")]), "waiting", "a second lease must not be granted while the permit is held");
  assert.equal(store.accounting().responseWaiters, 1);
  assert.equal(clock.pending().filter((r) => r.delayMs === 15_000).length, 1, "a waiting acquire must not start a lease deadline");
  assert.equal(existsSync(join(root, "data", `${b}.pdf`)), true, "a waiting acquire must not touch its artifact");
  clock.advance(5_000);
  first.complete();
  const second = await waiting;
  assert.ok(second);
  assert.equal(second.deadline, clock.now() + 15_000, "the 15s lease must start at admission, not at request");
  assert.deepEqual(store.accounting(), { ...IDLE, count: 1, bytes: SOURCE_BYTES, consumers: 1, responsePermitHeld: true, responseBytes: SOURCE_BYTES });
  second.complete();
  assert.deepEqual(store.accounting(), IDLE);
  await store.close();
});

test("a lease timeout admits exactly one waiter and close cancels the rest", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), clock = fakeScheduler();
  const a = "T".repeat(22), b = "U".repeat(22), c = "V".repeat(22);
  const store = new ArtifactStore({ root, scheduler: clock });
  for (const id of [a, b, c]) assert.equal((await store.capture(pdf, { id, consumerId: "owner" })).status, "available");
  const first = await store.acquire(a, "owner"); assert.ok(first);
  const secondPending = store.acquire(b, "owner"), thirdPending = store.acquire(c, "owner");
  await Promise.resolve(); await Promise.resolve();
  assert.equal(await Promise.race([secondPending, Promise.resolve("waiting")]), "waiting", "a held permit must block every waiter");
  assert.equal(store.accounting().responseWaiters, 2);
  clock.advance(15_000);
  const second = await secondPending;
  assert.ok(second, "a lease timeout must admit the first waiter");
  assert.equal(await Promise.race([thirdPending, Promise.resolve("waiting")]), "waiting", "a timeout must admit exactly one waiter");
  assert.equal(store.accounting().responseWaiters, 1);
  const closing = store.close();
  assert.equal(await thirdPending, null, "close must cancel a waiting acquire");
  assert.equal(await closing, undefined);
  assert.deepEqual(store.accounting(), IDLE, "close must release clean reservations and permits");
  assert.equal(existsSync(join(root, ".gateway-lock")), false);
});

test("poisoning the store settles held and queued response ownership", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), clock = fakeScheduler();
  const held = "W".repeat(22), queued = "X".repeat(22), poison = "Y".repeat(22);
  let unlinks = 0;
  const store = new ArtifactStore({ root, scheduler: clock, fsOps: { linkSync, fsyncSync, unlinkSync(path) { unlinks++; if (path.endsWith(`${poison}.pdf`)) throw new Error("/private/unlink-sentinel"); return unlinkSync(path); } } });
  for (const id of [held, queued, poison]) assert.equal((await store.capture(pdf, { id, consumerId: "owner" })).status, "available");
  const lease = await store.acquire(held, "owner"); assert.ok(lease);
  const waiting = store.acquire(queued, "owner");
  await Promise.resolve(); await Promise.resolve();
  assert.equal(store.accounting().responseWaiters, 1);
  // An unrelated artifact's unconfirmed cleanup poisons the store while one lease holds the
  // response permit and another waits behind it.
  assert.equal(store.discardArtifact(poison), false);
  const stranded = new Promise((resolve) => { setImmediate(() => resolve("still waiting")); });
  assert.equal(await Promise.race([waiting, stranded]), null, "a poisoned store must refuse a queued acquire, not strand it");
  const settled = { ...IDLE, count: 3, bytes: 3 * SOURCE_BYTES, consumers: 1 };
  assert.deepEqual(store.accounting(), settled, "response ownership settles while unconfirmed-cleanup capacity stays retained");
  assert.equal(clock.pending().length, 0, "poisoning must cancel artifact timers");
  const mutations = unlinks;
  clock.advance(60_000); lease.complete(); lease.complete();
  assert.equal(unlinks, mutations, "no post-poison callback may attempt filesystem mutation");
  assert.deepEqual(store.accounting(), settled);
  assert.equal(await store.close(), "artifact-cleanup-failed");
  assert.equal(existsSync(join(root, ".gateway-lock")), true);
});

test("a replaced root refuses publication and acquire without touching the replacement", async () => {
  const base = temp(), root = join(base, "artifacts"), pdf = source(), original = join(base, "original"), kept = "A".repeat(22);
  const store = new ArtifactStore({ root });
  assert.equal((await store.capture(pdf, { id: kept, consumerId: "owner" })).status, "available");
  renameSync(root, original);
  mkdirSync(join(root, "data"), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, "data", "sentinel"), "keep");
  assert.deepEqual(await store.capture(pdf, { id: "B".repeat(22), consumerId: "owner" }), { status: "capture-failed", failure: "artifact-runtime-invalidated" });
  assert.equal(await store.acquire(kept, "owner"), null);
  assert.deepEqual(readdirSync(join(root, "data")), ["sentinel"], "no work may create anything in the replacement tree");
  assert.equal(readFileSync(join(root, "data", "sentinel"), "utf8"), "keep");
  assert.equal(await store.close(), "artifact-cleanup-failed");
  assert.equal(existsSync(join(root, ".gateway-lock")), false, "close must not create or remove a lock in the replacement");
  assert.equal(existsSync(join(original, ".gateway-lock")), true, "unproven ownership retains the original lock");
  assert.equal(existsSync(join(original, "data", `${kept}.pdf`)), true, "cleanup is skipped where ownership is unproven");
});

test("a replaced data directory is never published into, discarded through or deleted", async () => {
  const base = temp(), root = join(base, "artifacts"), pdf = source(), data = join(root, "data"), moved = join(base, "moved"), kept = "C".repeat(22);
  const store = new ArtifactStore({ root });
  assert.equal((await store.capture(pdf, { id: kept, consumerId: "owner" })).status, "available");
  renameSync(data, moved);
  mkdirSync(data, { mode: 0o700 });
  const decoy = join(data, `${kept}.pdf`); writeFileSync(decoy, "decoy"); chmodSync(decoy, 0o600);
  assert.deepEqual(await store.capture(pdf, { id: "D".repeat(22), consumerId: "owner" }), { status: "capture-failed", failure: "artifact-runtime-invalidated" });
  assert.deepEqual(readdirSync(data), [`${kept}.pdf`], "publication must create nothing in the replacement");
  assert.equal(store.discardArtifact(kept), false, "discard must refuse while data identity is unproven");
  assert.equal(readFileSync(decoy, "utf8"), "decoy", "discard must not delete through the replacement");
  assert.equal(await store.close(), "artifact-cleanup-failed");
  assert.equal(readFileSync(decoy, "utf8"), "decoy", "close must not delete through the replacement");
  assert.equal(existsSync(join(root, ".gateway-lock")), true, "uncertainty retains the lock");
});

test("an injected owner, mode or type change fails closed with no raw detail", async () => {
  for (const change of [{ uid: 4_294_967_290 }, { mode: 0o777 }, { directory: false }]) {
    const root = join(temp(), "artifacts"), pdf = source(), kept = "E".repeat(22);
    let armed = false; const observed = [];
    const store = new ArtifactStore({ root, identityOverride: function (...args) { observed.push(args); return armed ? change : undefined; } });
    assert.equal((await store.capture(pdf, { id: kept, consumerId: "owner" })).status, "available");
    armed = true;
    const refused = await store.capture(pdf, { id: "F".repeat(22), consumerId: "owner" });
    assert.deepEqual(refused, { status: "capture-failed", failure: "artifact-runtime-invalidated" });
    assert.equal(JSON.stringify(refused).includes(root), false, "a closed failure carries no path");
    assert.equal(await store.acquire(kept, "owner"), null);
    assert.equal(await store.close(), "artifact-cleanup-failed");
    assert.equal(existsSync(join(root, ".gateway-lock")), true);
    assert.equal(existsSync(join(root, "data", `${kept}.pdf`)), true);
    // The selector is told which directory and which reading, and nothing else: no path, no
    // descriptor number, no observed stat, no private value it could report back.
    assert.ok(observed.length > 0);
    for (const args of observed) {
      assert.equal(args.length, 2, "the identity seam takes exactly two closed-enum arguments");
      assert.ok(["root", "data"].includes(args[0]));
      assert.ok(["descriptor", "path"].includes(args[1]));
    }
  }
});

test("an unreadable retained descriptor refuses later work and still closes", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), kept = "G".repeat(22);
  let armed = false;
  const store = new ArtifactStore({ root, identityOverride: (_target, source) => (armed && source === "descriptor" ? "unreadable" : undefined) });
  assert.equal((await store.capture(pdf, { id: kept, consumerId: "owner" })).status, "available");
  armed = true;
  assert.equal(await store.acquire(kept, "owner"), null);
  assert.deepEqual(await store.capture(pdf, { id: "H".repeat(22), consumerId: "owner" }), { status: "capture-failed", failure: "artifact-runtime-invalidated" });
  assert.equal(store.discardArtifact(kept), false);
  assert.equal(await store.close(), "artifact-cleanup-failed");
  assert.equal(await store.close(), "artifact-cleanup-failed", "close stays total and idempotent");
  assert.equal(existsSync(join(root, "data", `${kept}.pdf`)), true, "cleanup is skipped where ownership is unproven");
  assert.equal(existsSync(join(root, ".gateway-lock")), true);
});

test("directory fsync uses the retained data descriptor after startup", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), id = "I".repeat(22);
  let pathOpens = 0;
  const store = new ArtifactStore({ root, onDataPathOpen: () => { pathOpens++; } });
  assert.equal(pathOpens, 1, "startup opens the data directory by path exactly once, to retain its descriptor");
  assert.equal((await store.capture(pdf, { id, consumerId: "owner" })).status, "available");
  assert.equal(store.discardArtifact(id), true);
  assert.equal(existsSync(join(root, "data", `${id}.pdf`)), false, "the durable deletion really happened");
  assert.equal(pathOpens, 1, "no data directory reopen by path after startup");
  assert.equal(await store.close(), undefined);
  assert.equal(pathOpens, 1);
});

test("a constructor failure after the first descriptor closes it and rolls back the boot lock", async () => {
  const root = join(temp(), "artifacts");
  let closes = 0;
  assert.throws(() => new ArtifactStore({ root, onDescriptorClose: () => { closes++; }, afterRootDescriptor: () => { rmdirSync(join(root, "data")); } }), (e) => e.code === "artifact-root-invalid" && !String(e).includes(root));
  assert.equal(closes, 1, "the one descriptor this boot owned is closed exactly once");
  assert.equal(existsSync(join(root, ".gateway-lock")), false, "a pre-mutation failure rolls back this boot's lock");
  const store = new ArtifactStore({ root });
  assert.equal(existsSync(join(root, ".gateway-lock")), true, "the released lock lets a later boot start");
  assert.equal(await store.close(), undefined);
});

test("a root replaced during the commit window refuses to publish and retains everything", async () => {
  const base = temp(), root = join(base, "artifacts"), pdf = source(), original = join(base, "original"), id = "K".repeat(22);
  let release; const held = new Promise((r) => { release = r; }); let reached; const seam = new Promise((r) => { reached = r; });
  const store = new ArtifactStore({ root, afterLinkBeforeCommit: async () => { reached(); await held; } });
  const pending = store.capture(pdf, { id, consumerId: "owner" });
  await seam;
  // The link has landed but the record has not. Swap the root inside that commit window.
  renameSync(root, original);
  mkdirSync(join(root, "data"), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, "data", "sentinel"), "keep");
  release();
  assert.deepEqual(await pending, { status: "capture-failed", failure: "artifact-runtime-invalidated" }, "identity must be reproven immediately before the record is committed");
  assert.equal(await store.acquire(id, "owner"), null, "nothing may be published out of an unprovable tree");
  assert.deepEqual(readdirSync(join(root, "data")), ["sentinel"], "the replacement tree stays untouched");
  assert.equal(readFileSync(join(root, "data", "sentinel"), "utf8"), "keep");
  assert.equal(existsSync(join(original, "data", `${id}.pdf`)), true, "the uncertain artifact is retained, not deleted");
  assert.deepEqual(store.accounting(), { ...IDLE, count: 1, bytes: SOURCE_BYTES, consumers: 1 }, "its capacity stays reserved");
  assert.equal(await store.close(), "artifact-cleanup-failed");
  assert.equal(existsSync(join(original, ".gateway-lock")), true, "uncertainty retains the lock");
});

test("a public discard after a clean close performs no mutation at all", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), id = "L".repeat(22), stray = "M".repeat(22);
  let unlinks = 0, fsyncs = 0, discards = 0;
  const store = new ArtifactStore({ root, onDiscard: () => { discards++; }, fsOps: { linkSync, unlinkSync(path) { unlinks++; return unlinkSync(path); }, fsyncSync(fd) { fsyncs++; return fsyncSync(fd); } } });
  assert.equal((await store.capture(pdf, { id, consumerId: "owner" })).status, "available");
  assert.equal(await store.close(), undefined);
  // The clean close removed `data`, so this is a directory the store never owned at all — an even
  // clearer thing for a disposed store to keep its hands off.
  mkdirSync(join(root, "data"), { mode: 0o700 });
  const sentinel = join(root, "data", `${stray}.pdf`);
  writeFileSync(sentinel, "sentinel bytes"); chmodSync(sentinel, 0o600);
  const before = { unlinks, fsyncs, discards };
  assert.equal(store.discardArtifact(stray), false, "a disposed store refuses a public discard rather than acting on a tree it no longer owns");
  assert.equal(readFileSync(sentinel, "utf8"), "sentinel bytes", "a closed store must not delete through its former data directory");
  assert.deepEqual({ unlinks, fsyncs, discards }, before, "a closed store's discard performs no unlink, fsync or callback");
});

test("a public discard is refused from the moment close begins", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), clock = fakeScheduler(), gate = stagingGate();
  const id = "N".repeat(22), stray = "O".repeat(22);
  let unlinks = 0, fsyncs = 0, discards = 0;
  const store = new ArtifactStore({ root, scheduler: clock, afterPartFsync: gate.hook, onDiscard: () => { discards++; },
    fsOps: { linkSync, unlinkSync(path) { unlinks++; return unlinkSync(path); }, fsyncSync(fd) { fsyncs++; return fsyncSync(fd); } } });
  const pending = store.capture(pdf, { id, consumerId: "owner" });
  gate.disarm();
  // Close has begun but cannot finish: it is still waiting on the active capture, so the descriptors
  // are open and the store is not yet disposed.
  const closing = store.close();
  const sentinel = join(root, "data", `${stray}.pdf`);
  writeFileSync(sentinel, "sentinel bytes"); chmodSync(sentinel, 0o600);
  const before = { unlinks, fsyncs, discards, cleared: clock.cleared.length, waiters: store.accounting().responseWaiters };
  assert.equal(store.discardArtifact(stray), false, "a closing store refuses a public discard");
  assert.equal(readFileSync(sentinel, "utf8"), "sentinel bytes", "a closing store must not delete through its data directory");
  assert.deepEqual({ unlinks, fsyncs, discards, cleared: clock.cleared.length, waiters: store.accounting().responseWaiters }, before, "a refused discard performs no unlink, fsync, callback, timer or settlement mutation");
  gate.release();
  assert.deepEqual(await pending, { status: "capture-failed", failure: "artifact-runtime-invalidated" });
  assert.equal(await closing, undefined);
  // Close's own identity-bound cleanup still sweeps strict artifact files it owns — that path is
  // private and is exactly what the public refusal above does not do.
  assert.equal(existsSync(sentinel), false);
  assert.equal(existsSync(join(root, "data")), false, "and the emptied data directory goes with it");
  assert.equal(existsSync(join(root, ".gateway-lock")), false);
});

test("close closes both retained descriptors exactly once", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), id = "J".repeat(22);
  let closes = 0;
  const store = new ArtifactStore({ root, onDescriptorClose: () => { closes++; } });
  assert.equal((await store.capture(pdf, { id, consumerId: "owner" })).status, "available");
  assert.equal(closes, 0, "descriptors stay open while the store is live");
  assert.equal(await store.close(), undefined);
  assert.equal(closes, 2, "root and data descriptors each close exactly once");
  assert.equal(await store.close(), undefined);
  assert.equal(closes, 2, "a repeated close performs no second descriptor close");
  assert.equal(existsSync(join(root, ".gateway-lock")), false);
});

test("lock diagnostic metadata is private and carries only closed operator fields", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), id = "A".repeat(22), clock = fakeScheduler();
  const store = new ArtifactStore({ root, scheduler: clock });
  const meta = ownerPath(root), entry = lstatSync(meta);
  assert.equal(entry.isSymbolicLink(), false, "the diagnostic entry is not a symlink");
  assert.equal(entry.isFile(), true, "the diagnostic entry is one regular file");
  assert.equal(entry.nlink, 1, "and is not a hard link to anything else");
  assert.equal(entry.mode & 0o777, 0o600, "diagnostic metadata must be strictly private");
  assert.equal(entry.uid, process.getuid(), "and owned by this process");
  const raw = readFileSync(meta, "utf8"), parsed = JSON.parse(raw);
  assert.deepEqual(Object.keys(parsed).sort(), ["nonce", "pid", "startedAt", "version"], "exactly the closed field set");
  assert.equal(parsed.version, 1);
  assert.equal(parsed.pid, process.pid);
  assert.equal(typeof parsed.nonce, "string");
  assert.ok(parsed.nonce.length >= 22, "the ownership nonce is opaque and long");
  // startedAt comes from the one scheduler's process-start accessor, so it is exact: a constructor
  // clock read would produce the scheduler's current time instead, which is a different value.
  assert.equal(parsed.startedAt, PROCESS_START, "startedAt must be the scheduler's process-start value");
  assert.notEqual(parsed.startedAt, clock.now(), "and must not be the moment this store took the lock");
  assert.equal((await store.capture(pdf, { id, consumerId: "secret-consumer" })).status, "available");
  assert.equal(readFileSync(meta, "utf8"), raw, "artifact work never writes into the diagnostic");
  for (const secret of [root, "secret-consumer", id, pdf, "%PDF"]) assert.equal(raw.includes(secret), false, "no root path, consumer, artifact ID, token or browser data appears in the diagnostic");
  assert.deepEqual(readdirSync(join(root, LOCK)), [OWNER], "the lock holds exactly one diagnostic file");
  await store.close();
});

test("a second store refuses a pre-existing lock and leaves its metadata and data untouched", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), id = "B".repeat(22);
  const store = new ArtifactStore({ root, scheduler: fakeScheduler() });
  assert.equal((await store.capture(pdf, { id, consumerId: "first" })).status, "available");
  const meta = ownerPath(root), artifact = join(root, "data", `${id}.pdf`);
  const metaBefore = readFileSync(meta), metaStat = lstatSync(meta);
  const artifactBefore = readFileSync(artifact), artifactStat = lstatSync(artifact);
  // The lock is refused on the name alone: the loser never reads it to decide liveness, never
  // rewrites it as its own, and never touches the winner's artifacts.
  assert.throws(() => new ArtifactStore({ root, scheduler: fakeScheduler() }), e => e.code === "artifact-root-locked");
  assert.deepEqual(readFileSync(meta), metaBefore, "the holder's diagnostic is byte-for-byte unchanged");
  const metaAfter = lstatSync(meta);
  assert.equal(metaAfter.ino, metaStat.ino, "and is the same file, not a replacement");
  assert.equal(metaAfter.mtimeMs, metaStat.mtimeMs, "and was never rewritten");
  assert.equal(metaAfter.mode & 0o777, 0o600);
  assert.deepEqual(readFileSync(artifact), artifactBefore, "committed artifact bytes are untouched");
  assert.equal(lstatSync(artifact).ino, artifactStat.ino);
  assert.equal(lstatSync(artifact).mtimeMs, artifactStat.mtimeMs);
  assert.deepEqual(readdirSync(root).sort(), [LOCK, "data"], "the refusal adds nothing to the root");
  assert.deepEqual(readdirSync(join(root, LOCK)), [OWNER], "and nothing to the lock");
  assert.deepEqual(readdirSync(join(root, "data")), [`${id}.pdf`]);
  // The holder is undisturbed: it still owns the lock and still completes its own lifecycle.
  assert.equal(await store.close(), undefined);
  assert.equal(existsSync(join(root, LOCK)), false);
});

test("a replaced lock directory prevents removal and is never touched", async () => {
  const root = join(temp(), "artifacts"), impostor = join(root, LOCK);
  const store = new ArtifactStore({ root, scheduler: fakeScheduler() });
  const mine = readFileSync(ownerPath(root));
  // Same name, same mode, same diagnostic bytes — a different directory. Only the retained
  // device/inode can tell them apart, and content equality must not be mistaken for ownership.
  renameSync(impostor, join(root, "stashed"));
  mkdirSync(impostor, { mode: 0o700 });
  writeFileSync(ownerPath(root), mine, { mode: 0o600 });
  const swapped = lstatSync(impostor), swappedOwner = lstatSync(ownerPath(root));
  assert.equal(await store.close(), "artifact-cleanup-failed", "a lock this store cannot claim is never removed");
  assert.equal(existsSync(impostor), true, "the impostor lock survives");
  assert.equal(lstatSync(impostor).ino, swapped.ino, "and is the same directory, not a recreated one");
  assert.deepEqual(readdirSync(impostor), [OWNER], "its contents are untouched");
  assert.deepEqual(readFileSync(ownerPath(root)), mine);
  assert.equal(lstatSync(ownerPath(root)).ino, swappedOwner.ino, "its diagnostic was never unlinked");
  assert.deepEqual(readdirSync(join(root, "stashed")), [OWNER], "and the store's own stashed lock is not hunted down");
  assert.equal((await store.capture(source(), { id: "C".repeat(22), consumerId: "after" })).failure, "artifact-runtime-invalidated");
});

// Each variant leaves a plausible diagnostic in place. The first three replace the entry, so the
// retained identity must catch them; the rest keep the original inode, mode and owner, so only
// reading the content against this boot's own expected values can. The last three are valid JSON of
// the right shape — a diagnostic is owned by what it says, not merely by parsing.
const TAMPERS = [
  ["a symlink", (root, victim) => { unlinkSync(ownerPath(root)); symlinkSync(victim, ownerPath(root)); }],
  ["a hard link", (root, victim) => { unlinkSync(ownerPath(root)); linkSync(victim, ownerPath(root)); }],
  ["a directory", (root) => { unlinkSync(ownerPath(root)); mkdirSync(ownerPath(root), { mode: 0o600 }); }],
  ["a world-readable mode", (root) => chmodSync(ownerPath(root), 0o644)],
  ["malformed content", (root) => writeFileSync(ownerPath(root), "not json at all")],
  ["a foreign nonce", (root) => { const meta = JSON.parse(readFileSync(ownerPath(root), "utf8")); writeFileSync(ownerPath(root), JSON.stringify({ ...meta, nonce: "Z".repeat(meta.nonce.length) })); }],
  ["a rewritten process start", (root) => { const meta = JSON.parse(readFileSync(ownerPath(root), "utf8")); writeFileSync(ownerPath(root), JSON.stringify({ ...meta, startedAt: meta.startedAt + 1 })); }],
  ["an unexpected extra field", (root) => { const meta = JSON.parse(readFileSync(ownerPath(root), "utf8")); writeFileSync(ownerPath(root), JSON.stringify({ ...meta, operator: "note" })); }],
];

test("a tampered diagnostic prevents lock removal and never touches its target", async () => {
  // One accumulated report rather than per-variant assertions: a variant that stops failing is as
  // interesting as one that starts, and both must be visible in the same run.
  const observed = [];
  for (const [what, tamper] of TAMPERS) {
    const root = join(temp(), "artifacts"), victim = join(temp(), "victim");
    writeFileSync(victim, "keep");
    const store = new ArtifactStore({ root, scheduler: fakeScheduler() });
    tamper(root, victim);
    const entry = lstatSync(ownerPath(root));
    const result = await store.close();
    const survives = existsSync(join(root, LOCK)) && lstatSync(ownerPath(root)).ino === entry.ino;
    observed.push(`${what}: ${result} lock-intact=${survives} victim=${readFileSync(victim, "utf8")}`);
  }
  assert.deepEqual(observed, TAMPERS.map(([what]) => `${what}: artifact-cleanup-failed lock-intact=true victim=keep`));
});

test("a non-empty data directory blocks removal, retains the lock and reports cleanup failure", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), id = "D".repeat(22);
  const store = new ArtifactStore({ root, scheduler: fakeScheduler() });
  assert.equal((await store.capture(pdf, { id, consumerId: "owner" })).status, "available");
  // An entry this store did not create. It is never deleted, and it is the reason data cannot go.
  const stray = join(root, "data", "not-an-artifact");
  writeFileSync(stray, "keep");
  assert.equal(await store.close(), "artifact-cleanup-failed");
  assert.equal(readFileSync(stray, "utf8"), "keep", "close deletes only the strict artifact files it owns");
  assert.deepEqual(readdirSync(join(root, "data")), ["not-an-artifact"], "its own artifact is still swept, and nothing else is");
  assert.equal(existsSync(join(root, LOCK)), true, "a data directory that cannot go retains the lock");
  assert.deepEqual(readdirSync(join(root, LOCK)), [OWNER], "with its diagnostic intact");
  // Retention is not cosmetic: the root stays locked against a fresh store.
  assert.throws(() => new ArtifactStore({ root }), e => e.code === "artifact-root-locked");
});

test("a clean close tears down in order and leaves a private empty root", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), id = "E".repeat(22), steps = [];
  const store = new ArtifactStore({ root, scheduler: fakeScheduler(), onCloseStep: (step) => steps.push(step) });
  assert.equal((await store.capture(pdf, { id, consumerId: "owner" })).status, "available");
  assert.equal(await store.close(), undefined);
  // The order is the contract, not an implementation detail: data cannot go before its descriptor is
  // closed, the lock cannot go before the data it guards, and the root fsync must cover every removal.
  assert.deepEqual(steps, ["delete-files", "fsync-data", "close-data-fd", "remove-data", "remove-diagnostic", "remove-lock", "fsync-root", "close-root-fd"]);
  assert.deepEqual(readdirSync(root), [], "a clean close leaves the root empty");
  const left = lstatSync(root);
  assert.equal(left.isDirectory(), true, "the root itself survives");
  assert.equal(left.mode & 0o777, 0o700, "and is still private");
  assert.equal(left.uid, process.getuid());
});

// Every removal and fsync step of a clean close. `close-root-fd` is deliberately absent: it is a
// descriptor close after the last durability point, not a removal or an fsync, and failing it cannot
// leave the tree in a different state.
const CLOSE_FAULTS = ["delete-files", "fsync-data", "close-data-fd", "remove-data", "remove-diagnostic", "remove-lock", "fsync-root"];

test("a failure at any removal or fsync step fails the close and never leaves the root unlocked", async () => {
  const observed = [];
  for (const failAt of CLOSE_FAULTS) {
    const root = join(temp(), "artifacts"), pdf = source(), id = "F".repeat(22);
    const store = new ArtifactStore({ root, scheduler: fakeScheduler(), closeStepFails: (step) => step === failAt });
    assert.equal((await store.capture(pdf, { id, consumerId: "owner" })).status, "available");
    const result = await store.close();
    // Sampled before the probe below, which would create a lock of its own if the root were free.
    const locked = existsSync(join(root, LOCK));
    // A later success must not mask this failure, and the root must not be left claimable.
    let refused = false;
    try { new ArtifactStore({ root, scheduler: fakeScheduler() }); } catch (e) { refused = e.code === "artifact-root-locked"; }
    observed.push(`${failAt}: ${result} locked=${locked} refused=${refused}`);
  }
  assert.deepEqual(observed, CLOSE_FAULTS.map((step) => `${step}: artifact-cleanup-failed locked=true refused=true`));
});

test("a failed final root fsync restores a lock it can prove, and never adopts one it cannot", async () => {
  // The final fsync covers removals that already completed, so it cannot retain an already-removed
  // lock. It recreates one instead, bound to this boot.
  const root = join(temp(), "artifacts");
  const store = new ArtifactStore({ root, scheduler: fakeScheduler(), closeStepFails: (step) => step === "fsync-root" });
  assert.equal(await store.close(), "artifact-cleanup-failed");
  const restored = lstatSync(ownerPath(root));
  assert.equal(restored.isFile(), true); assert.equal(restored.nlink, 1); assert.equal(restored.mode & 0o777, 0o600);
  const meta = JSON.parse(readFileSync(ownerPath(root), "utf8"));
  assert.deepEqual(Object.keys(meta).sort(), ["nonce", "pid", "startedAt", "version"], "the restored diagnostic is the same closed field set");
  assert.equal(meta.pid, process.pid); assert.equal(meta.startedAt, PROCESS_START);
  assert.equal(existsSync(join(root, "data")), false, "restoring a lock does not resurrect removed data");

  // If another process won the freed name first, the compensation must not read, alter or remove it.
  const other = join(temp(), "artifacts"), foreign = ownerPath(other);
  let taken;
  const loser = new ArtifactStore({
    root: other, scheduler: fakeScheduler(), closeStepFails: (step) => step === "fsync-root",
    onCloseStep: (step) => { if (step === "remove-lock") { mkdirSync(join(other, LOCK), { mode: 0o700 }); writeFileSync(foreign, "foreign", { mode: 0o600 }); taken = { lock: lstatSync(join(other, LOCK)).ino, owner: lstatSync(foreign).ino }; } },
  });
  assert.equal(await loser.close(), "artifact-cleanup-failed");
  assert.equal(readFileSync(foreign, "utf8"), "foreign", "a lock this store does not own is left exactly as found");
  // Inodes, not just bytes: a compensation that recreated the directory or the diagnostic would
  // leave identical-looking content behind a different file.
  assert.equal(lstatSync(join(other, LOCK)).ino, taken.lock, "the winner's lock directory is the one still standing");
  assert.equal(lstatSync(foreign).ino, taken.owner, "and its diagnostic was never replaced");
  assert.deepEqual(readdirSync(join(other, LOCK)), [OWNER]);
});

test("constructor rollback removes only the lock it created, and never once cleanup mutation has begun", async () => {
  // The lock is swapped underneath a failing constructor. Rollback must remove the lock this boot
  // created, not whatever happens to be standing at that name.
  const root = join(temp(), "artifacts"), lock = join(root, LOCK), stash = join(root, "stashed");
  let swapped;
  assert.throws(() => new ArtifactStore({ root, afterRootDescriptor: () => {
    renameSync(lock, stash); mkdirSync(lock, { mode: 0o700 }); writeFileSync(ownerPath(root), "foreign", { mode: 0o600 });
    swapped = { lock: lstatSync(lock).ino, owner: lstatSync(ownerPath(root)).ino };
    rmdirSync(join(root, "data"));
  } }), e => e.code === "artifact-root-invalid");
  assert.equal(existsSync(lock), true, "a lock this constructor did not create survives its rollback");
  assert.equal(lstatSync(lock).ino, swapped.lock, "and is the same directory, untouched");
  assert.equal(readFileSync(ownerPath(root), "utf8"), "foreign", "its diagnostic is neither read nor removed");
  assert.equal(lstatSync(ownerPath(root)).ino, swapped.owner);
  assert.deepEqual(readdirSync(stash), [OWNER], "and this boot's own displaced lock is not hunted down either");

  // Rollback belongs strictly to the pre-mutation window: once startup cleanup has begun deleting
  // artifact files, a failure is a cleanup failure that retains the lock and its diagnostic.
  const second = join(temp(), "artifacts"), id = "G".repeat(22);
  mkdirSync(join(second, "data"), { recursive: true, mode: 0o700 });
  writeFileSync(join(second, "data", `${id}.pdf`), Buffer.from("%PDF-1.7\nx"), { mode: 0o600 });
  chmodSync(join(second, "data", `${id}.pdf`), 0o600);
  assert.throws(() => new ArtifactStore({ root: second, fsOps: { linkSync, fsyncSync, unlinkSync() { throw new Error("/private/sentinel"); } } }), e => e.code === "artifact-cleanup-failed" && !String(e).includes("sentinel"));
  assert.equal(existsSync(join(second, LOCK)), true, "a mutating constructor keeps its lock rather than rolling back");
  const kept = JSON.parse(readFileSync(ownerPath(second), "utf8"));
  assert.deepEqual(Object.keys(kept).sort(), ["nonce", "pid", "startedAt", "version"], "with its diagnostic intact");
  assert.equal(lstatSync(ownerPath(second)).mode & 0o777, 0o600);
});

test("no public error or result exposes the configured path, PID, process start, nonce or lock contents", async () => {
  const root = join(temp(), "artifacts"), pdf = source(), notPdf = join(temp(), "x.pdf"), fileRoot = join(temp(), "file-root");
  writeFileSync(notPdf, "not a pdf at all"); writeFileSync(fileRoot, "occupied");
  const store = new ArtifactStore({ root, scheduler: fakeScheduler() });
  const raw = readFileSync(ownerPath(root), "utf8"), secret = JSON.parse(raw);
  // Two haystacks: everything a caller can read, and the same minus stack traces. Stacks carry code
  // locations and are checked only against needles that cannot collide with a path or a line number.
  const shallow = [], deep = [];
  const record = (value) => {
    shallow.push(String(value)); deep.push(String(value));
    if (value && typeof value === "object") { shallow.push(JSON.stringify(value)); deep.push(JSON.stringify(value)); if (value.stack) deep.push(String(value.stack)); }
  };
  const attempt = (fn) => { try { record(fn()); } catch (e) { record(e); } };
  attempt(() => new ArtifactStore({ root, scheduler: fakeScheduler() }));
  attempt(() => new ArtifactStore({ root: fileRoot }));
  attempt(() => new ArtifactStore({ root: "not/absolute" }));
  attempt(() => store.discardArtifact("!!!"));
  record(await store.capture(notPdf, { id: "H".repeat(22), consumerId: "owner" }));
  try { await store.capture(pdf, { id: "short", consumerId: "owner" }); } catch (e) { record(e); }
  record(await store.acquire("I".repeat(22), "owner"));
  record(store.accounting());
  // A close that fails its ownership proof must not describe in public what it found.
  writeFileSync(ownerPath(root), "tampered");
  record(await store.close());
  for (const [what, needle] of [["the configured root path", root], ["the ownership nonce", secret.nonce], ["the diagnostic contents", raw]])
    assert.equal(deep.join("\n").includes(needle), false, `no public error or result exposes ${what}`);
  for (const [what, needle] of [["the process id", String(process.pid)], ["the process start", String(PROCESS_START)], ["the lock directory name", LOCK]])
    assert.equal(shallow.join("\n").includes(needle), false, `no public error or result exposes ${what}`);
});

test("a compensating lock restoration makes its diagnostic's directory entry durable", async () => {
  // The fsync seam already receives descriptors, so the test classifies targets itself by fstat
  // identity. No new hook, and nothing about paths, fds, identities or the nonce leaves the store.
  const fsynced = [];
  const recorder = { linkSync, unlinkSync, fsyncSync(fd) { const st = fstatSync(fd); fsynced.push({ dev: st.dev, ino: st.ino, directory: st.isDirectory() }); return fsyncSync(fd); } };
  const at = (target) => fsynced.findIndex((f) => f.directory && f.dev === target.dev && f.ino === target.ino);

  const root = join(temp(), "artifacts");
  const store = new ArtifactStore({ root, scheduler: fakeScheduler(), closeStepFails: (step) => step === "fsync-root", fsOps: recorder });
  assert.equal(await store.close(), "artifact-cleanup-failed", "restoration never masks or replaces the original cleanup failure");
  const lock = lstatSync(join(root, LOCK)), rootDir = lstatSync(root);
  // The diagnostic's bytes are fsynced when it is written, but its *name* lives in this recreated
  // directory: without a directory fsync the entry is not durable across a crash.
  assert.ok(at(lock) >= 0, "the recreated lock directory is made durable");
  assert.ok(at(rootDir) > at(lock), "and the root that names it is fsynced afterwards, not instead");

  // A lock another process won is never opened, inspected or fsynced.
  const other = join(temp(), "artifacts"), foreign = ownerPath(other);
  let taken;
  const loser = new ArtifactStore({
    root: other, scheduler: fakeScheduler(), closeStepFails: (step) => step === "fsync-root", fsOps: recorder,
    onCloseStep: (step) => { if (step === "remove-lock") { mkdirSync(join(other, LOCK), { mode: 0o700 }); writeFileSync(foreign, "foreign", { mode: 0o600 }); taken = lstatSync(join(other, LOCK)); } },
  });
  const mark = fsynced.length;
  assert.equal(await loser.close(), "artifact-cleanup-failed");
  assert.equal(fsynced.slice(mark).some((f) => f.dev === taken.dev && f.ino === taken.ino), false, "a lock this store does not own is never fsynced");
  assert.equal(readFileSync(foreign, "utf8"), "foreign");
  assert.equal(lstatSync(join(other, LOCK)).ino, taken.ino);

  // The two restoration fsyncs are independent: a failing lock-directory fsync must not cost the
  // root its own, and neither may upgrade or mask the original cleanup failure.
  const third = join(temp(), "artifacts"), after = [];
  const failing = { linkSync, unlinkSync, fsyncSync(fd) {
    const st = fstatSync(fd);
    if (st.isDirectory() && existsSync(join(third, LOCK)) && st.ino === lstatSync(join(third, LOCK)).ino) throw new Error("/private/lock-fsync-sentinel");
    after.push({ dev: st.dev, ino: st.ino, directory: st.isDirectory() }); return fsyncSync(fd);
  } };
  const partial = new ArtifactStore({ root: third, scheduler: fakeScheduler(), closeStepFails: (step) => step === "fsync-root", fsOps: failing });
  const outcome = await partial.close();
  assert.equal(outcome, "artifact-cleanup-failed", "a failed restoration fsync leaves the original failure exactly as it was");
  const thirdRoot = lstatSync(third);
  assert.ok(after.some((f) => f.directory && f.dev === thirdRoot.dev && f.ino === thirdRoot.ino), "the retained root is still fsynced after the lock directory's fsync fails");
  assert.equal(existsSync(ownerPath(third)), true, "and the restored lock and diagnostic still stand");
});

// ---------------------------------------------------------------------------------------------
// PR #139 adversarial-security correction — the public store boundary.
//
// Three separate defects, three separate boundaries:
//
//  1. `capture()` stored and RETURNED the same mutable record, and `acquire()` authorized from it.
//     A caller could rewrite `consumerId` on the object it was handed and acquire as anybody — and
//     rewrite `bytes`/`sha256`/`expiresAt` to corrupt the integrity, expiry and accounting decisions
//     the store makes from that record.
//  2. TypeScript `private` is erased: every field compiled to a writable, enumerable own property,
//     so the configured root, the data path, the record map, the descriptors, the callbacks and the
//     reservation ledger were all readable by reflection, serializable, and replaceable at runtime.
//  3. The constructor dereferenced untrusted options before validating them, so a null, a proxy or a
//     throwing getter escaped as a raw Node exception carrying whatever text it was built with.
// ---------------------------------------------------------------------------------------------

/** Serialization must be observable even when it throws — a circular internal object is exactly the
 *  shape that turns an "internals are not serializable" assertion into an unreadable test error. */
const serialize = (value) => { try { return JSON.stringify(value); } catch { return "<serialization threw>"; } };

test("a mutated capture record cannot re-authorize a different consumer", async () => {
  // The reported reproduction, exactly: seal/capture, rewrite the owner on the returned object,
  // acquire as the attacker.
  const root = join(temp(), "artifacts"), id = "R".repeat(22);
  const store = new ArtifactStore({ root, scheduler: fakeScheduler() });
  const captured = await store.capture(source(), { id, consumerId: "rightful" });
  assert.equal(captured.status, "available");
  try { captured.consumerId = "attacker"; } catch {}
  try { Object.defineProperty(captured, "consumerId", { value: "attacker" }); } catch {}
  assert.equal(captured.consumerId, "rightful", "the caller's mutation reached the record it was handed");
  assert.equal(await store.acquire(id, "attacker"), null, "a mutated record authorized the wrong consumer");
  const lease = await store.acquire(id, "rightful");
  assert.ok(lease, "the rightful consumer could no longer acquire its own artifact");
  lease.complete();
  await store.close();
});

test("every record crossing the store boundary is a distinct frozen snapshot", async () => {
  const root = join(temp(), "artifacts"), id = "S".repeat(22);
  const store = new ArtifactStore({ root, scheduler: fakeScheduler() });
  const captured = await store.capture(source(), { id, consumerId: "rightful" });
  assert.equal(captured.status, "available");
  assert.equal(Object.isFrozen(captured), true, "the captured record crossed the boundary mutable");
  const original = { ...captured };
  // Every field the store authorizes, bills, verifies or expires on. Assignment throws in strict
  // mode (this file is an ES module) or is inert; an ACCEPTED mutation is the defect.
  for (const [field, value] of [["consumerId", "attacker"], ["status", "consuming"], ["bytes", 1], ["sha256", "0".repeat(64)], ["expiresAt", 0], ["createdAt", 0], ["id", "T".repeat(22)]]) {
    try { captured[field] = value; } catch {}
    try { Object.defineProperty(captured, field, { value, writable: true, configurable: true }); } catch {}
  }
  assert.deepEqual({ ...captured }, original, "a caller's mutation reached the record it was handed");
  // Accounting still bills the artifact the store actually made, and expiry still describes it.
  assert.deepEqual(store.accounting(), { ...IDLE, count: 1, bytes: SOURCE_BYTES, consumers: 1 });
  const lease = await store.acquire(id, "rightful");
  assert.ok(lease, "integrity or expiry followed the caller's mutation");
  assert.notEqual(lease.record, captured, "the lease handed back the very object the capture returned");
  assert.equal(Object.isFrozen(lease.record), true, "the lease record crossed the boundary mutable");
  assert.equal(lease.record.consumerId, "rightful");
  assert.equal(lease.record.status, "consuming");
  assert.equal(lease.record.bytes, SOURCE_BYTES);
  assert.equal(lease.record.sha256, original.sha256);
  try { lease.record.consumerId = "attacker"; } catch {}
  assert.equal(lease.record.consumerId, "rightful", "the lease record was mutable");
  lease.complete();
  await store.close();
});

test("the store publishes no enumerable, serializable or writable internal authority", async () => {
  const root = join(temp(), "artifacts");
  const store = new ArtifactStore({ root, scheduler: fakeScheduler() });
  assert.deepEqual(Object.keys(store), [], "store internals are enumerable");
  assert.deepEqual(Object.getOwnPropertyNames(store), [], "store internals are own properties");
  assert.equal(serialize(store), "{}", "serializing the store disclosed its internals");
  assert.equal(store.enabled, true, "the public enabled flag was lost");
  // `enabled` is the ONE public read-only flag: a prototype accessor, not a writable own property.
  // Assigning it used to switch off every identity proof the store makes.
  try { store.enabled = false; } catch {}
  assert.equal(store.enabled, true, "the public enabled flag was writable");
  // And the public method surface is intact — privacy is not a facade that dropped operations.
  for (const method of ["capture", "acquire", "discardArtifact", "discardArtifactDetailed", "accounting", "close"]) {
    assert.equal(typeof store[method], "function", `${method} is missing from the public store`);
  }
  assert.equal(await store.close(), undefined);
  assert.equal(serialize(store), "{}", "a closed store serialized its internals");
  assert.equal(serialize(store).includes(root), false, "the configured root serialized");
});

test("hostile shadow properties cannot redirect the store's filesystem routing or authority", async () => {
  const root = join(temp(), "artifacts"), decoy = join(temp(), "decoy"), id = "U".repeat(22);
  mkdirSync(decoy, { recursive: true, mode: 0o700 });
  const store = new ArtifactStore({ root, scheduler: fakeScheduler() });
  const shadows = [
    "root", "data", "records", "timers", "fsOps", "scheduler", "reservations", "consumerLedger", "inflight",
    "rootFd", "dataFd", "rootIdentity", "dataIdentity", "identityLost", "unhealthy", "closeRequested", "disposed",
    "teardownStarted", "onDiscard", "lockNonce", "lockIdentity", "ownerIdentity", "ledgerBytes", "ledgerCount", "stagePermits",
  ];
  for (const name of shadows) {
    try { store[name] = decoy; } catch {}
    try { Object.defineProperty(store, name, { value: decoy, writable: true, enumerable: true, configurable: true }); } catch {}
  }
  const captured = await store.capture(source(), { id, consumerId: "owner" });
  assert.equal(captured.status, "available", "a shadow property broke a capture");
  assert.deepEqual(readdirSync(join(root, "data")), [`${id}.pdf`], "the store stopped writing into the root it was configured with");
  assert.deepEqual(readdirSync(decoy), [], "the store followed a caller-supplied shadow path");
  const lease = await store.acquire(id, "owner");
  assert.ok(lease, "a shadow property broke the lease path");
  assert.equal(lease.record.consumerId, "owner");
  lease.complete();
  assert.equal(await store.acquire(id, "owner"), null);
  assert.equal(await store.close(), undefined, "a shadow property broke the close");
  assert.equal(existsSync(join(root, LOCK)), false, "the close could not release its own lock");
});

test("malformed store configuration is refused with a closed code before any filesystem call", () => {
  const sentinel = "/private/statements/2026-08/STORE_CONFIG_SENTINEL";
  const boom = () => { throw new Error(sentinel); };
  const abs = join(temp(), "artifacts");
  const cases = [
    ["undefined", undefined],
    ["null", null],
    ["a number", 7],
    ["a string", sentinel],
    ["an array", [sentinel]],
    ["a throwing proxy", new Proxy({}, { get: boom, has: boom, ownKeys: boom })],
    ["a throwing root getter", { get root() { return boom(); } }],
    ["a coercible root object", { root: { toString: () => sentinel } }],
    ["a symbol root", { root: Symbol(sentinel) }],
    ["a relative root", { root: "relative/artifacts" }],
    ["an empty root", { root: "" }],
    ["a throwing fsOps getter", { root: abs, get fsOps() { return boom(); } }],
    ["a throwing fsOps member getter", { root: abs, fsOps: { linkSync, unlinkSync, get fsyncSync() { return boom(); } } }],
    ["a non-object fsOps", { root: abs, fsOps: sentinel }],
    ["a missing fsOps member", { root: abs, fsOps: { linkSync, unlinkSync } }],
    ["a non-function fsOps member", { root: abs, fsOps: { linkSync, unlinkSync, fsyncSync: sentinel } }],
    ["a non-function optional fsOps member", { root: abs, fsOps: { linkSync, unlinkSync, fsyncSync, rmdirSync: sentinel } }],
    ["a non-object scheduler", { root: abs, scheduler: sentinel }],
    ["a non-function scheduler member", { root: abs, scheduler: { ...fakeScheduler(), now: sentinel } }],
    ["a throwing scheduler member getter", { root: abs, scheduler: { ...fakeScheduler(), get setTimeout() { return boom(); } } }],
    ["a non-function callback", { root: abs, onDiscard: sentinel }],
    ["a non-function test seam", { root: abs, closeStepFails: sentinel }],
    ["a non-number ttl", { root: abs, ttlMs: sentinel }],
    ["a non-boolean enabled", { root: abs, enabled: sentinel }],
  ];
  for (const [label, options] of cases) {
    assert.throws(() => new ArtifactStore(options), (e) => {
      assert.equal(e?.code, "artifact-config-invalid", `${label} was not refused with the closed configuration code`);
      assert.equal(String(e?.message ?? "").includes("SENTINEL"), false, `${label} leaked raw exception text`);
      assert.equal(String(e?.stack ?? "").includes("SENTINEL"), false, `${label} leaked a sentinel through a stack`);
      return true;
    }, label);
  }
  // Shape validation happens BEFORE any Node path or filesystem call, so a refused configuration
  // never creates, locks or opens the root it named.
  assert.equal(existsSync(abs), false, "a refused configuration reached the filesystem");
});

test("each store option is read exactly once and its nested authority is snapshotted", async () => {
  const root = join(temp(), "artifacts"), id = "V".repeat(22);
  const reads = new Map();
  const clock = fakeScheduler();
  const fsOps = { linkSync, unlinkSync, fsyncSync };
  const stated = {
    enabled: true, root, ttlMs: 600_000, cleanupIntervalMs: 60_000, maxBytes: 64 * 1024 * 1024, maxCount: 16,
    perConsumerBytes: 16 * 1024 * 1024, perConsumerCount: 4, fsOps, scheduler: clock, onDiscard: () => {}, onCleanupPass: () => {},
  };
  const options = {};
  for (const [key, value] of Object.entries(stated)) {
    Object.defineProperty(options, key, { enumerable: true, configurable: true, get() { reads.set(key, (reads.get(key) ?? 0) + 1); return value; } });
  }
  const store = new ArtifactStore(options);
  for (const key of Object.keys(stated)) assert.equal(reads.get(key), 1, `${key} was read ${reads.get(key) ?? 0} times, not once`);

  // Replacing the filesystem or scheduler authority AFTER construction must change nothing: the
  // store holds its own snapshot, not a live reference into a caller-owned object.
  const swapped = [];
  fsOps.unlinkSync = (path) => { swapped.push("unlinkSync"); return path; };
  Object.defineProperty(fsOps, "linkSync", { configurable: true, get() { swapped.push("linkSync"); return () => {}; } });
  fsOps.fsyncSync = () => { swapped.push("fsyncSync"); };
  clock.setTimeout = () => { swapped.push("setTimeout"); return 0; };
  clock.now = () => { swapped.push("now"); return 0; };

  const captured = await store.capture(source(), { id, consumerId: "owner" });
  assert.equal(captured.status, "available", "the store used replaced filesystem authority");
  assert.deepEqual(swapped, [], "the store called authority the caller replaced after construction");
  assert.deepEqual(readdirSync(join(root, "data")), [`${id}.pdf`]);
  assert.equal(store.discardArtifact(id), true);
  assert.deepEqual(readdirSync(join(root, "data")), []);
  assert.deepEqual(swapped, [], "the discard path called replaced authority");
  assert.equal(await store.close(), undefined);
  assert.deepEqual(swapped, [], "the close path called replaced authority");
});

// Snapshotting the injected authority is only half of it: the snapshot has to be BOUND to its
// receiver, and the binding used to read `fn.bind` off the caller's callable. That read is a
// caller-controlled getter running outside the normalization that keeps this constructor's error
// vocabulary closed, so a hostile one threw its own text straight out of `new ArtifactStore(...)`.
const BIND_SENTINEL = "/private/statements/2026-08/BIND_GETTER_SENTINEL";

test("a hostile property getter on an injected callable is never queried and never leaks", async () => {
  const root = join(temp(), "artifacts"), id = "W".repeat(22);
  const probed = [];
  // Callable, valid, and hostile only about being READ: every property access is recorded, and
  // `bind` — the one the old binding performed — throws sentinel-bearing text.
  const hostile = (fn, label) => new Proxy(fn, {
    get(target, key, receiver) {
      probed.push(`${label}.${String(key)}`);
      if (key === "bind") throw new Error(BIND_SENTINEL);
      return Reflect.get(target, key, receiver);
    },
  });
  const fsOps = { linkSync: hostile(linkSync, "linkSync"), unlinkSync: hostile(unlinkSync, "unlinkSync"), fsyncSync: hostile(fsyncSync, "fsyncSync") };

  let store;
  try {
    store = new ArtifactStore({ root, scheduler: fakeScheduler(), fsOps });
  } catch (e) {
    assert.fail(`construction read a caller-supplied callable: probed ${JSON.stringify(probed)}, threw ${String(e?.message ?? e).includes("BIND_GETTER_SENTINEL") ? "the raw sentinel" : String(e?.code ?? e)}`);
  }
  assert.deepEqual(probed, [], "the store read a property off a caller-supplied callable");

  // The underlying implementations are valid, so a store that never reads them still works.
  const captured = await store.capture(source(), { id, consumerId: "owner" });
  assert.equal(captured.status, "available", "the store could not use an injected callable it refused to read");
  assert.deepEqual(readdirSync(join(root, "data")), [`${id}.pdf`]);
  assert.equal(store.discardArtifact(id), true, "the discard path could not use the injected callable");
  assert.equal(await store.close(), undefined, "the close path could not use the injected callable");
  assert.equal(existsSync(join(root, LOCK)), false, "the close could not release its own lock");
  assert.deepEqual(probed, [], "a store operation read a property off a caller-supplied callable");
});

test("an injected fsOps and scheduler keep their receiver when the store calls them", async () => {
  const root = join(temp(), "artifacts"), id = "X".repeat(22);
  const clock = fakeScheduler();
  // `this`-using implementations are legitimate: a method that reaches its own object must still
  // find it, or binding to the receiver has been traded away for the hostile-getter fix.
  const fsOps = {
    tag: "FSOPS", seen: [],
    linkSync(...args) { this.seen.push(`${this.tag}:linkSync`); return linkSync(...args); },
    unlinkSync(...args) { this.seen.push(`${this.tag}:unlinkSync`); return unlinkSync(...args); },
    fsyncSync(...args) { this.seen.push(`${this.tag}:fsyncSync`); return fsyncSync(...args); },
  };
  const scheduler = {
    tag: "CLOCK", seen: [],
    now() { this.seen.push(`${this.tag}:now`); return clock.now(); },
    processStartedAt() { this.seen.push(`${this.tag}:processStartedAt`); return clock.processStartedAt(); },
    setTimeout(callback, delayMs) { this.seen.push(`${this.tag}:setTimeout`); return clock.setTimeout(callback, delayMs); },
    clearTimeout(handle) { this.seen.push(`${this.tag}:clearTimeout`); return clock.clearTimeout(handle); },
  };

  const store = new ArtifactStore({ root, fsOps, scheduler });
  assert.equal(scheduler.seen.includes("CLOCK:processStartedAt"), true, "the lock claim lost the scheduler's receiver");
  assert.equal(scheduler.seen.includes("CLOCK:setTimeout"), true, "the cleanup schedule lost the scheduler's receiver");
  const captured = await store.capture(source(), { id, consumerId: "owner" });
  assert.equal(captured.status, "available", "a this-using fsOps or scheduler broke the capture");
  assert.equal(scheduler.seen.includes("CLOCK:now"), true, "the capture lost the scheduler's receiver");
  for (const call of ["FSOPS:linkSync", "FSOPS:unlinkSync", "FSOPS:fsyncSync"]) {
    assert.equal(fsOps.seen.includes(call), true, `the capture never reached the injected ${call} through its own receiver`);
  }
  assert.equal(store.discardArtifact(id), true, "a this-using fsOps broke the discard");
  assert.equal(await store.close(), undefined, "a this-using fsOps or scheduler broke the close");
  assert.equal(scheduler.seen.includes("CLOCK:clearTimeout"), true, "the close lost the scheduler's receiver");
  assert.equal(existsSync(join(root, LOCK)), false, "the close could not release its own lock");
});

// The commit window is an `await`. By the time it opens, `<id>.pdf` is a NAME: the link succeeded a
// moment ago, but anything sharing this UID can chmod it, rewrite it, or unlink it and leave a
// different inode at the same name before the record is written. Each mutation below leaves something
// a pathname check still happily calls "the artifact" — §4.2 step 8 publishes only what a stat of the
// file that is actually there proves, and only when that file is the exact inode already validated.
async function captureAcrossCommitWindow(mutate) {
  const root = join(temp(), "artifacts"), pdf = source(), id = "W".repeat(22);
  const finalPath = join(root, "data", `${id}.pdf`);
  let observed;
  const store = new ArtifactStore({ root, afterLinkBeforeCommit: () => { observed = mutate(finalPath); } });
  const result = await store.capture(pdf, { id, consumerId: "owner" });
  return { root, id, finalPath, store, result, observed };
}
/** What a pathname-only check can see. Every mutation below keeps this indistinguishable from a good
 *  publication in at least two of its four fields, and the inode swap keeps all four. */
const visible = (path) => { const st = lstatSync(path); return { isFile: st.isFile(), size: st.size, uid: st.uid, mode: st.mode & 0o7777 }; };

test("a final file chmodded in the commit window is never published", async () => {
  const { id, finalPath, store, result, observed } = await captureAcrossCommitWindow((path) => { chmodSync(path, 0o644); return visible(path); });
  assert.deepEqual(observed, { isFile: true, size: SOURCE_BYTES, uid: process.getuid(), mode: 0o644 }, "the premise is a world-readable file of the right type, size and owner");
  assert.deepEqual(result, { status: "capture-failed", failure: "artifact-write-failed" }, "a world-readable final file was published as an artifact");
  assert.equal(await store.acquire(id, "owner"), null, "an unpublished capture left an acquirable record");
  assert.equal(existsSync(finalPath), false, "the refused artifact was left on disk");
  assert.deepEqual(store.accounting(), IDLE, "a cleanly refused capture retained capacity");
  assert.equal(await store.close(), undefined, "a cleanly refused capture blocked the close");
});

test("a final file rewritten to a different size in the commit window is never published", async () => {
  // `writeFileSync` over an existing name truncates in place: same inode, same private mode, new length.
  const rewritten = Buffer.from("%PDF-1.7\nhello, and rather more");
  const { id, finalPath, store, result, observed } = await captureAcrossCommitWindow((path) => { writeFileSync(path, rewritten); return visible(path); });
  assert.notEqual(rewritten.length, SOURCE_BYTES);
  assert.deepEqual(observed, { isFile: true, size: rewritten.length, uid: process.getuid(), mode: 0o600 }, "the premise is a private regular file whose only wrong field is its size");
  assert.deepEqual(result, { status: "capture-failed", failure: "artifact-write-failed" }, "bytes the store never hashed were published under the record's size and digest");
  assert.equal(await store.acquire(id, "owner"), null, "an unpublished capture left an acquirable record");
  assert.equal(existsSync(finalPath), false, "the refused artifact was left on disk");
  assert.deepEqual(store.accounting(), IDLE, "a cleanly refused capture retained capacity");
  assert.equal(await store.close(), undefined, "a cleanly refused capture blocked the close");
});

test("a final file swapped for an identically-shaped inode in the commit window is never published", async () => {
  const { id, finalPath, store, result, observed } = await captureAcrossCommitWindow((path) => {
    // The replacement is allocated while the staged inode is still linked. Writing it only after the
    // unlink is not enough: the filesystem hands the just-freed inode number straight back, and the
    // swap this test exists to prove becomes invisible to a dev/ino comparison.
    const before = lstatSync(path), decoy = join(path, "..", `${"D".repeat(22)}.pdf`);
    writeFileSync(decoy, Buffer.from("%PDF-1.7\nWRONG"), { mode: 0o600 });
    unlinkSync(path); renameSync(decoy, path);
    const after = lstatSync(path);
    return { ...visible(path), sameInode: after.dev === before.dev && after.ino === before.ino };
  });
  // Type, size, owner and mode all still match. Only the inode says these are not the staged bytes,
  // which is why publication has to be decided from dev/ino continuity and not from a stat alone.
  assert.deepEqual(observed, { isFile: true, size: SOURCE_BYTES, uid: process.getuid(), mode: 0o600, sameInode: false }, "the premise is a stat-indistinguishable replacement of the staged inode");
  assert.deepEqual(result, { status: "capture-failed", failure: "artifact-write-failed" }, "a foreign inode was published under the staged capture's digest");
  assert.equal(await store.acquire(id, "owner"), null, "an unpublished capture left an acquirable record");
  assert.equal(existsSync(finalPath), false, "the refused artifact was left on disk");
  assert.deepEqual(store.accounting(), IDLE, "a cleanly refused capture retained capacity");
  assert.equal(await store.close(), undefined, "a cleanly refused capture blocked the close");
});

test("an unmutated commit window still publishes, acquires and closes", async () => {
  // The same seam, the same reopen of the same name — only nothing tampers with it. A final-file proof
  // that cannot pass this is a proof that refuses every capture.
  const { root, id, finalPath, store, result, observed } = await captureAcrossCommitWindow(visible);
  assert.deepEqual(observed, { isFile: true, size: SOURCE_BYTES, uid: process.getuid(), mode: 0o600 }, "publication must leave one private regular file of the captured size");
  assert.equal(result.status, "available", "an untouched commit window failed to publish");
  assert.equal(result.bytes, SOURCE_BYTES);
  const lease = await store.acquire(id, "owner");
  assert.ok(lease, "a published artifact could not be acquired");
  assert.equal(Buffer.from(lease.base64, "base64").toString("utf8"), "%PDF-1.7\nhello", "the leased bytes are not the captured bytes");
  lease.complete();
  assert.equal(existsSync(finalPath), false, "a completed lease left the artifact on disk");
  assert.deepEqual(store.accounting(), IDLE);
  assert.equal(await store.close(), undefined);
  assert.equal(existsSync(join(root, LOCK)), false, "the close could not release its own lock");
});

// Amendment 1 §8, consume side: the final file is opened `O_RDONLY|O_NOFOLLOW` and the OPENED INODE
// is fstat'd as a regular file, owned by `process.getuid()`, mode exactly 0600 and of the exact
// bounded metadata size, before its SHA-256 is verified and before any bytes, record snapshot or
// response permit escape. Publication proved every one of those facts once — and none of them
// survives the artifact's lifetime. Between the commit and the consume the artifact simply sits at a
// name, and anything sharing this UID can widen its mode or unlink it and leave another inode there.
// A size-and-hash check alone reads content it has not established it is allowed to read.
async function published(id, options = {}, pdf = source()) {
  const root = join(temp(), "artifacts");
  const store = new ArtifactStore({ root, ...options });
  const record = await store.capture(pdf, { id, consumerId: "owner" });
  assert.equal(record.status, "available", "the fixture could not publish an artifact to consume");
  return { root, store, record, finalPath: join(root, "data", `${id}.pdf`) };
}

test("a final inode chmodded world-readable after publication is never consumed", async () => {
  const id = "M".repeat(22);
  const { root, store, finalPath } = await published(id);
  chmodSync(finalPath, 0o644);
  assert.deepEqual(visible(finalPath), { isFile: true, size: SOURCE_BYTES, uid: process.getuid(), mode: 0o644 }, "the premise is the published inode itself, wrong in nothing but the width of its mode");
  assert.equal(await store.acquire(id, "owner"), null, "a world-readable final inode was consumed and its bytes returned to the caller");
  assert.equal(existsSync(finalPath), false, "the refused consume left the widened artifact readable on disk");
  assert.deepEqual(store.accounting(), IDLE, "the refused consume retained its permit, bytes or artifact accounting");
  assert.equal(await store.close(), undefined, "a provably deleted refusal blocked the close");
  assert.equal(existsSync(join(root, LOCK)), false, "the close could not release its own lock");
});

test("a final name replaced by a real non-regular inode is refused and fails closed", async () => {
  // End-to-end with no seam at all: a genuine directory at `<id>.pdf`. It is NOT an independently red
  // guard — today's read would refuse it anyway — but it is the only fixture that exercises the whole
  // fail-closed path against a real hostile inode, including the half that cannot be faked: `unlink`
  // returns EISDIR, so durable deletion is unprovable, and the store must keep the record on its
  // books, poison itself and retain its lock rather than declare capacity reusable.
  const root = join(temp(), "artifacts"), id = "N".repeat(22);
  const store = new ArtifactStore({ root });
  const dataDir = join(root, "data"), probe = join(dataDir, "P".repeat(22));
  // Measure, do not assume. The fixture has to match the record's byte count EXACTLY, or the size
  // check refuses it and the file-type clause this test names is never the reason for anything.
  mkdirSync(probe, 0o700); const dirBytes = lstatSync(probe).size; rmdirSync(probe);
  assert.ok(dirBytes >= 5 && dirBytes <= STAGE_BYTES, `an empty directory reports ${dirBytes} bytes, which no PDF fixture on this filesystem can match`);
  const record = await store.capture(bigSource(dirBytes), { id, consumerId: "owner" });
  assert.equal(record.status, "available");
  assert.equal(record.bytes, dirBytes, "the fixture must be exactly as large as an empty directory reports");

  const finalPath = join(dataDir, `${id}.pdf`);
  unlinkSync(finalPath); mkdirSync(finalPath, 0o700); chmodSync(finalPath, 0o600);
  assert.deepEqual(visible(finalPath), { isFile: false, size: dirBytes, uid: process.getuid(), mode: 0o600 }, "the premise is a private, exactly-sized, correctly-owned inode whose only wrong field is its type");
  assert.equal(await store.acquire(id, "owner"), null, "a non-regular final inode was consumed as an artifact");
  // Nothing is released on a refusal whose cleanup cannot be proven: the count, the bytes and the
  // consumer stay billed, and the lock outlives the close that could not sweep the root.
  assert.deepEqual(store.accounting(), { ...IDLE, count: 1, bytes: dirBytes, consumers: 1 }, "capacity was declared reusable over an artifact the store could not prove it deleted");
  assert.equal(await store.close(), "artifact-cleanup-failed", "a close that could not sweep its own root reported success");
  assert.equal(existsSync(join(root, LOCK)), true, "the lock of a root that could not be swept was released anyway");
});

// The consume side's LAST unproved assumption. Publication proves `<id>.pdf` is the exact inode this
// capture staged (`#proveLinked`), and then throws that identity away: the record kept size and digest
// only, so every later proof could ask "is this A private, regular, exactly-sized file whose bytes
// hash to the record" and never "is this THE file publication proved". A replacement built by copying
// the published bytes answers yes to all five readings — type, owner, mode, size, SHA-256 — because
// it is a byte-for-byte copy. Only dev/ino distinguishes it, which is why the identity proven at
// publication has to be retained on the record and re-proved on the descriptor the consume reads.
test("a final name replaced by an identically-hashed foreign inode is refused after publication", async () => {
  const id = "K".repeat(22), decoyId = "L".repeat(22);
  const { root, store, record, finalPath } = await published(id);
  const before = lstatSync(finalPath), bytes = readFileSync(finalPath);
  // The identity is retained INTERNALLY. A snapshot that carried it would disclose this store's inode
  // numbers to every consumer, so the published record must still be exactly the public field set.
  const PUBLIC_FIELDS = ["bytes", "consumerId", "createdAt", "expiresAt", "id", "sha256", "status"];
  assert.deepEqual(Object.keys(record).sort(), PUBLIC_FIELDS, "the published record snapshot grew a field beyond the public contract");
  // Allocated while the published inode is STILL linked: writing the replacement after the unlink
  // gets the just-freed inode number handed straight back, and the swap this test exists to prove
  // becomes invisible to a dev/ino comparison.
  const decoy = join(root, "data", `${decoyId}.pdf`);
  writeFileSync(decoy, bytes, { mode: 0o600 }); chmodSync(decoy, 0o600);
  unlinkSync(finalPath); renameSync(decoy, finalPath);
  const after = lstatSync(finalPath);
  assert.deepEqual(visible(finalPath), { isFile: true, size: SOURCE_BYTES, uid: process.getuid(), mode: 0o600 }, "the premise is a private, regular, correctly-owned, exactly-sized inode of this user");
  assert.equal(after.dev === before.dev && after.ino === before.ino, false, "the fixture did not actually replace the published inode");
  assert.equal(record.bytes, SOURCE_BYTES, "the record's size must be the one the replacement carries");
  assert.equal(createHash("sha256").update(readFileSync(finalPath)).digest("hex"), record.sha256, "the premise is a replacement matching the record's size AND digest exactly, so only identity can refuse it");
  assert.equal(await store.acquire(id, "owner"), null, "a foreign inode was consumed under the published record and its bytes returned to the caller");
  assert.equal(existsSync(finalPath), false, "the refused consume left the substituted inode on disk");
  assert.deepEqual(store.accounting(), IDLE, "the refused consume retained its permit, bytes or artifact accounting");
  // Cleanup was proven, so the capacity and the ID are genuinely reusable — a refusal that poisoned
  // the store or kept the name reserved would fail here rather than in the accounting above.
  const again = await store.capture(source(), { id, consumerId: "owner" });
  assert.equal(again.status, "available", "a provably cleaned refusal left its artifact ID or capacity unusable");
  const lease = await store.acquire(id, "owner");
  assert.ok(lease, "the replacement capture could not be acquired");
  assert.deepEqual(Object.keys(lease.record).sort(), PUBLIC_FIELDS, "the leased record snapshot grew a field beyond the public contract");
  assert.equal(Buffer.from(lease.base64, "base64").toString("utf8"), "%PDF-1.7\nhello", "the leased bytes are not the recaptured bytes");
  lease.complete();
  assert.deepEqual(store.accounting(), IDLE, "the completed lease retained accounting");
  assert.equal(await store.close(), undefined, "a provably deleted refusal blocked the close");
  assert.equal(existsSync(join(root, LOCK)), false, "the close could not release its own lock");
});

// `close()` used to assign `#closePromise` from the RESULT of `new Promise(...)`, whose executor runs
// the whole synchronous teardown before that assignment lands. Teardown reaches `onDiscard`, and an
// observer that closes the store — the ordinary shape for a runtime shutting down from a discard —
// re-enters a `close()` that still sees `#closePromise` undefined. The re-entrant call therefore
// published a SECOND promise, took over `#resolveClose`, and the outer teardown resolved the nested
// promise while the promise the first caller was awaiting never settled at all.
test("a close re-entered from its own discard callback returns the one close promise", async () => {
  const root = join(temp(), "artifacts"), id = "Q".repeat(22);
  let nested, reentries = 0;
  const store = new ArtifactStore({ root, onDiscard: () => { reentries++; nested = store.close(); } });
  assert.equal((await store.capture(source(), { id, consumerId: "owner" })).status, "available");
  const outer = store.close();
  // The premise: the callback really did re-enter close, synchronously, from inside the outer call.
  assert.equal(reentries, 1, "the close swept no record, so nothing re-entered close and this test proves nothing");
  assert.equal(nested, outer, "a close re-entered from its own teardown published a second promise");
  assert.deepEqual(await Promise.all([outer, nested]), [undefined, undefined], "the close promise did not settle once with one result for every caller");
  assert.equal(existsSync(join(root, LOCK)), false, "the close could not release its own lock");
});

test("the descriptor stat predicate accepts only a private, regular, exactly-sized inode of this user", () => {
  // Two of §8's clauses cannot be driven through a live store by a non-root test: `chown` to another
  // user needs privilege this suite must never require, and a real non-regular inode at the final
  // name is refused by `read(2)` anyway (EISDIR), which cannot tell a store that checks the file type
  // from one that never did. The decision itself is therefore exercised directly. It is the exact
  // function `#provenFile` calls on its real `fstat`, so this table is production logic and not a
  // restatement of it — and it takes only the four readings, so no live store gained a way to have
  // one substituted. Mode and size keep their real end-to-end fixtures (chmod, commit-window rewrite)
  // and appear here only because they fall out of the same predicate.
  const ok = { isFile: true, size: SOURCE_BYTES, uid: process.getuid(), mode: 0o600 };
  const table = [
    [ok, SOURCE_BYTES, true, "a private regular inode of the exact expected size"],
    [{ ...ok, isFile: false }, SOURCE_BYTES, false, "a non-regular inode"],
    [{ ...ok, uid: process.getuid() + 1 }, SOURCE_BYTES, false, "an inode owned by another user"],
    [{ ...ok, mode: 0o644 }, SOURCE_BYTES, false, "a world-readable inode"],
    [{ ...ok, mode: 0o4600 }, SOURCE_BYTES, false, "a setuid inode whose bottom nine bits still read 0600"],
    [{ ...ok, size: SOURCE_BYTES + 1 }, SOURCE_BYTES, false, "an inode larger than its metadata claims"],
    [{ ...ok, size: STAGE_BYTES + 1 }, STAGE_BYTES + 1, false, "an exactly-sized inode beyond the artifact bound"],
  ];
  for (const [reading, bytes, expected, description] of table) {
    assert.equal(provenFileStat(reading, bytes), expected, `the descriptor stat predicate ${expected ? "refused" : "accepted"} ${description}`);
  }
});
