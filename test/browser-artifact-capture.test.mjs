/**
 * Browser attachment capture — the artifact-capture seam in the browser core (contract §5).
 *
 * The load-bearing property proven here is ORDERING: the transient render page must have its
 * `download` listener installed BEFORE the navigation that can emit the event. A real-browser gate
 * cannot isolate this — a fast attachment still lands after a late registration often enough to pass
 * — so the regression guard is a fake-context unit test that records the core's actual call order
 * (the same reasoning as test/px-frame-poll.test.mjs).
 *
 * The fake page records every `on(event)` registration and the `goto` in one ordered log, so moving
 * the registration after navigation FAILS this test rather than merely changing a stub's return.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PatchrightBrowserCore } from "../dist/browser/patchright-core.js";
import { DEFAULT_CORE_OPTIONS, resolveCoreOptions } from "../dist/browser/launch-options.js";
import { ArtifactRuntime } from "../dist/artifacts/index.js";
// The concrete store is INTERNAL to `src/artifacts/` (Amendment 3 §1) and is not on the public
// barrel; the prototype wrapper below reaches it as the module-local class it is.
import { ArtifactStore } from "../dist/artifacts/store.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The runtime publishes NO concrete store (Amendment 3 §1), so the end-to-end test below observes the
// one a capture actually published through from the TEST side: this module-local wrapper records the
// receiver by identity — no property of it is read — and forwards to the untouched original with the
// original receiver and arguments, returning its result verbatim. Production gains no seam.
const stagedStores = new Set();
const originalCapture = ArtifactStore.prototype.capture;
ArtifactStore.prototype.capture = function (...args) {
  stagedStores.add(this);
  return Reflect.apply(originalCapture, this, args);
};
/** The store the capture under test staged through, since the last `stagedStores.clear()`. */
function observedStore() {
  assert.equal(stagedStores.size, 1, "no single store staged a capture, so none was observed");
  return [...stagedStores][0];
}

/**
 * Construct a core over an already-open (fake) driver context.
 *
 * Deliberately a LOCAL test helper rather than a production factory: the class and its constructor
 * already exist, and TypeScript's `private` is compile-time only, so a JS test can use the real
 * construction path without the shipped API gaining a bypass that only tests need. Nothing here is
 * exported, and production keeps `launch()` as its sole constructor.
 */
function coreWith(context, opts = {}) {
  return new PatchrightBrowserCore(
    context,
    resolveCoreOptions(opts),
    opts.solver,
    opts.windowsUaHosts ?? [],
    undefined,
    opts.captureEnabled,
    opts.captureDrainTurn,
  );
}

/** Body text comfortably over STRONG_CONTENT_LENGTH (800) so render()'s clearance poll exits
 *  immediately — this test is about listener ordering, not about the clearance loop. */
const CLEARED_TEXT = "cleared page body ".repeat(80);

/**
 * A minimal PatchrightContext/Page stand-in. `calls` is the ordered log of the core's observable
 * interactions with the page: one entry per listener registration (`on:<event>`) and one for `goto`.
 * Nothing here fakes the assertion — the log records what the core actually did, in order.
 */
function fakeContext({ duringGoto, duringClick, duringPress, landedResponse, subframeResponse, failSnapshotOnce, gotoGate, duringAction } = {}) {
  const calls = [];
  let handlers = new Map();
  const main = { tag: "main-frame" };
  let currentUrl = "about:blank";
  const contextHandlers = new Map();
  const pages = [];
  /** Announce a popup, returning the fake popup page so a test can drive its download. */
  const openPopup = () => {
    const popupCalls = [];
    const popupHandlers = new Map();
    const popup = {
      on(event, handler) {
        popupCalls.push(`on:${event}`);
        const list = popupHandlers.get(event) ?? [];
        list.push(handler);
        popupHandlers.set(event, list);
      },
      emit(event, payload) { for (const h of popupHandlers.get(event) ?? []) h(payload); },
      get calls() { return popupCalls; },
      url: () => currentUrl,
      async close() { popupCalls.push("close"); },
    };
    for (const handler of contextHandlers.get("page") ?? []) handler(popup);
    return popup;
  };
  /** Deliver an event to the CURRENT page, retained for older tests that intentionally address it. */
  const emit = (event, payload) => {
    for (const handler of handlers.get(event) ?? []) handler(payload);
  };
  const makePage = () => {
    const pageHandlers = new Map();
    let closed = false;
    handlers = pageHandlers;
    const emitFromPage = (event, payload) => {
      for (const handler of pageHandlers.get(event) ?? []) handler(payload);
    };
    const made = {
      on(event, handler) {
        calls.push(`on:${event}`);
        const list = pageHandlers.get(event) ?? [];
        list.push(handler);
        pageHandlers.set(event, list);
      },
      emit: emitFromPage,
      async goto(target) {
        calls.push("goto");
        currentUrl = target; // the landed URL, so page.url() reflects where the page actually is
        // A real main-frame document response, with the frame identity the core checks against
        // page.mainFrame(). Built here rather than in the test so the identity cannot drift.
        // Emitted from INSIDE goto, which is the only point at which the core's listeners are known to
        // be registered — an emit from the test body races the core's own setup and reaches nobody.
        const respond = (frame, shape) =>
          emitFromPage("response", {
            request: () => ({ isNavigationRequest: () => true }),
            frame: () => frame,
            status: () => shape.status,
            headers: () => ({ "content-type": shape.contentType }),
          });
        if (landedResponse) respond(main, landedResponse);
        if (subframeResponse) respond({ tag: "sub-frame" }, subframeResponse);
        // The attachment case: the navigation itself emits the download, so an event that arrives
        // mid-goto must already have a listener AND a bound operation to attach to.
        if (duringGoto) duringGoto(emitFromPage, openPopup);
        // Lets a test hold the navigation open so teardown can arrive before the verb's cutoff.
        if (gotoGate) await gotoGate;
        return { status: () => 200 };
      },
      async title() { return "Document"; },
      async evaluate() { return CLEARED_TEXT; },
      async content() { return `<html><body>${CLEARED_TEXT}</body></html>`; },
      frames() { return [main]; },
      mainFrame() { return main; },
      url() { return currentUrl; },
      async waitForTimeout() {},
      async waitForLoadState() {},
      keyboard: {
        async press() {
          calls.push("press");
          // A key press (Enter on a form) can trigger a download just as a click can.
          const hook = duringPress ?? duringAction;
          if (hook) hook(emitFromPage);
        },
      },
      locator() {
        // Models a verb dying mid-flight: the snapshot step throws AFTER the operation was bound but
        // before anything could seal it. Once only, so the following navigation can still complete.
        if (failSnapshotOnce) { failSnapshotOnce = false; throw new Error("snapshot failed"); }
        return {
          ariaSnapshot: async () => "- document [ref=e1]",
          async click() {
            calls.push("click");
            // The action case: the click itself emits the download (any download-triggering control).
            const hook = duringClick ?? duringAction;
            if (hook) hook(emitFromPage);
          },
          async fill() { calls.push("fill"); if (duringAction) duringAction(emitFromPage); },
          async press() { calls.push("press"); if (duringAction) duringAction(emitFromPage); },
          async selectOption() { calls.push("selectOption"); if (duringAction) duringAction(emitFromPage); },
        };
      },
      async close() { calls.push("close"); closed = true; },
      get closed() { return closed; },
    };
    pages.push(made);
    return made;
  };
  let page = makePage();
  return {
    async newPage() { calls.push("newPage"); page = makePage(); return page; },
    async close() { calls.push("context-close"); },
    /** Context-level events — `page` is how the driver announces a popup. */
    on(event, handler) {
      calls.push(`context-on:${event}`);
      const list = contextHandlers.get(event) ?? [];
      list.push(handler);
      contextHandlers.set(event, list);
    },
    openPopup,
    emit,
    get page() { return page; },
    get calls() { return calls; },
    get handlers() { return handlers; },
    get pages() { return pages; },
  };
}

/**
 * A capture OPERATION fake, shaped exactly like the authoritative Amendment 3 §1 interface. The
 * caller creates these and hands one to each browser operation; the core never makes them.
 *
 * `log` is the shared ordered record across every operation a test creates, so a test can assert
 * which operation received an event and in what order generations were closed out.
 */
function operationFactory({ stage, sealResult, mirror } = {}) {
  const log = [];
  const operations = [];
  const make = () => {
    const index = operations.length;
    const operation = {
      index,
      operationId: `op-${index}`,
      owner: { scope: "consumer", consumerId: "owner" },
      terminal: undefined,
      downloads: [],
      registerDownload(download) {
        log.push(`register:${index}`);
        operation.downloads.push(download);
        // Staging is internal: the core gets back the OWNERSHIP RECEIPT and nothing else. `stage`
        // models the staging finishing later, and seal() is the only thing that waits for it.
        operation.staging = stage ? stage(index) : Promise.resolve();
        // Amendment 7 §8.1: every implementation AND FAKE returns the exact receipt. This fake
        // accepts, so it owns the driver object and the core must not dispose of it.
        return true;
      },
      noteMainResponseContentType({ status, contentType }) { log.push(`note:${index}:${status}:${contentType}`); },
      async seal() {
        log.push(`seal:${index}`);
        if (mirror) mirror.push("seal");
        if (operation.terminal) return operation.terminal;
        if (operation.staging) await operation.staging;
        if (operation.terminal) return operation.terminal;
        return sealResult ?? { outcome: "none" };
      },
      invalidate(reason) {
        log.push(`invalidate:${index}:${reason}`);
        operation.terminal ??= { outcome: "capture-failed", failure: reason };
      },
    };
    operations.push(operation);
    log.push(`begin:${index}`);
    return operation;
  };
  return { make, get log() { return log; }, get operations() { return operations; } };
}

/** The one ordering property, asserted against the recorded call log. */
function assertListenerBeforeNavigation(context, verb) {
  const registered = context.calls.indexOf("on:download");
  const navigated = context.calls.indexOf("goto");
  assert.ok(registered >= 0, `no download listener was installed (calls: ${context.calls.join(",")})`);
  assert.ok(navigated >= 0, `${verb}() did not navigate`);
  assert.ok(
    registered < navigated,
    `download listener installed AFTER navigation — an attachment emitted by the goto is lost ` +
      `(calls: ${context.calls.join(",")})`,
  );
}

test("render(): the transient page's download listener is installed BEFORE navigation", async () => {
  const context = fakeContext();
  const sink = operationFactory();
  const core = coreWith(context, {
    captureEnabled: true,
    captureSettleTimeoutMs: 100,
  });

  await core.render("https://origin.test/doc", { artifactOperation: sink.make() });

  assertListenerBeforeNavigation(context, "render");
});

test("navigate(): the drive active page's download listener is installed BEFORE navigation", async () => {
  const context = fakeContext();
  const sink = operationFactory();
  const core = coreWith(context, {
    captureEnabled: true,
    captureSettleTimeoutMs: 100,
  });

  await core.navigate("https://origin.test/doc", { artifactOperation: sink.make() });

  assertListenerBeforeNavigation(context, "navigate");
});

test("render(): a download emitted during the navigation is registered on the caller's operation", async () => {
  const download = disposableDownload();
  const context = fakeContext({ duringGoto: (emit) => emit("download", download) });
  const sink = operationFactory();
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });

  // The CALLER creates the operation and already bound owner and source host to it; the browser layer
  // neither derives nor sees them. Its whole job is to route the event to this exact operation.
  const operation = sink.make();
  await core.render("https://example.test/some/private/path?token=secret#frag", { artifactOperation: operation });

  assert.equal(sink.operations.length, 1, "the core must not create operations of its own");
  assert.deepEqual(operation.downloads, [download], "the navigation's download reached the caller's operation");
});

test("navigate(): each navigation's operation is closed out before the next one begins", async () => {
  const context = fakeContext();
  const sink = operationFactory();
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });

  await core.navigate("https://first.test/a", { artifactOperation: sink.make() });
  await core.navigate("https://second.test/b", { artifactOperation: sink.make() });

  assert.deepEqual(
    sink.log.filter((entry) => entry.startsWith("begin:") || entry.startsWith("seal:")),
    ["begin:0", "seal:0", "begin:1", "seal:1"],
    "no window in which two generations are live at once",
  );

  // Sealing unbinds, so a stray event after the fact reaches NEITHER generation — it cannot resurrect
  // the committed one, and it cannot be misattributed to the newer one.
  context.emit("download", { path: async () => "/driver/tmp/late.pdf" });
  assert.deepEqual(sink.operations[0].downloads, [], "the committed operation received nothing further");
  assert.deepEqual(sink.operations[1].downloads, [], "a post-seal event attaches to nothing at all");
});

test("navigate(): a verb that dies still closes out its own generation", async () => {
  // Previously the NEXT begin retired an orphaned generation. Under the one-generation invariant that
  // silent retirement is exactly what must not happen, so every verb closes out its own generation on
  // the way out — including when it throws — and the next verb starts from a clean slot.
  const context = fakeContext({ failSnapshotOnce: true });
  const sink = operationFactory();
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });

  await assert.rejects(core.navigate("https://origin.test/one", { artifactOperation: sink.make() }));
  await core.navigate("https://origin.test/two", { artifactOperation: sink.make() });

  assert.deepEqual(
    sink.log.filter((entry) => entry.startsWith("begin:") || entry.startsWith("seal:") || entry.startsWith("invalidate:")),
    ["begin:0", "seal:0", "begin:1", "seal:1"],
    `a failed verb did not close out its own generation (log: ${sink.log.join(",")})`,
  );
});

test("click(): the action begins its own capture operation and an action-triggered download attaches to it", async () => {
  const download = { path: async () => "/driver/tmp/attachment.pdf" };
  const context = fakeContext({ duringClick: (emit) => emit("download", download) });
  const sink = operationFactory();
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });

  await core.navigate("https://origin.test/doc", { artifactOperation: sink.make() });
  await core.click({ target: "e5", element: "Download attachment" }, { artifactOperation: sink.make() });

  assert.deepEqual(
    sink.log.filter((entry) => entry.startsWith("begin:") || entry.startsWith("seal:")),
    ["begin:0", "seal:0", "begin:1", "seal:1"],
    "the navigation's operation is committed before the action's operation exists",
  );
  assert.deepEqual(sink.operations[0].downloads, [], "the navigation's operation captured nothing");
  assert.deepEqual(
    sink.operations[1].downloads,
    [download],
    "the download the click triggered attached to the action's operation",
  );
});

test("pressKey(): the key-press action begins its own capture operation and its download attaches to it", async () => {
  const download = { path: async () => "/driver/tmp/attachment.pdf" };
  const context = fakeContext({ duringPress: (emit) => emit("download", download) });
  const sink = operationFactory();
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });

  await core.navigate("https://origin.test/doc", { artifactOperation: sink.make() });
  await core.pressKey("Enter", { artifactOperation: sink.make() });

  assert.equal(sink.operations.length, 2, "pressKey is its own generation, not the navigation's");
  assert.deepEqual(
    sink.log.filter((entry) => entry.startsWith("begin:") || entry.startsWith("seal:")),
    ["begin:0", "seal:0", "begin:1", "seal:1"],
    "the navigation's operation is committed before the key press's operation exists",
  );
  assert.deepEqual(sink.operations[0].downloads, [], "the navigation's operation captured nothing");
  assert.deepEqual(
    sink.operations[1].downloads,
    [download],
    "the download the key press triggered attached to the key press's operation",
  );
});

/** Drain the event loop a bounded number of times. Every fake here resolves immediately, so an
 *  unbarriered render() completes well inside this budget — which is what makes the RED deterministic. */
async function drain(turns = 20) {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve));
}

test("render(): the page is not torn down until pending capture staging has settled", async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const download = { path: async () => "/driver/tmp/attachment.pdf" };
  const context = fakeContext({ duringGoto: (emit) => emit("download", download) });
  const sink = operationFactory({
    stage: () => held.then(() => { context.calls.push("stage-settled"); }),
  });
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });

  const rendering = core.render("https://origin.test/doc", { artifactOperation: sink.make() });
  await drain();

  // The measured lifecycle: the driver's temp file exists only while the session does. Tearing the
  // page down mid-stage destroys the bytes the artifact is being copied from.
  assert.equal(
    context.calls.includes("close"),
    false,
    `page was torn down while staging was still in flight (calls: ${context.calls.join(",")})`,
  );

  release();
  await rendering;

  // Presence first — an unfired marker's indexOf of -1 would satisfy the ordering vacuously.
  assert.ok(
    context.calls.includes("stage-settled"),
    `staging never settled (calls: ${context.calls.join(",")})`,
  );
  assert.ok(
    context.calls.includes("close"),
    `the page was never torn down (calls: ${context.calls.join(",")})`,
  );
  assert.ok(
    context.calls.indexOf("stage-settled") < context.calls.indexOf("close"),
    `staging must settle before teardown (calls: ${context.calls.join(",")})`,
  );
});

test("render(): a download arriving during the cutoff is discarded and races the generation", async () => {
  const first = disposableDownload();
  const late = disposableDownload();
  let emitEvent;
  const context = fakeContext({ duringGoto: (emit) => { emitEvent = emit; emit("download", first); } });
  let stageCalls = 0;
  const sink = operationFactory({
    stage: () => {
      const nth = ++stageCalls;
      return new Promise((resolve) => setImmediate(resolve)).then(() => {
        if (nth === 1) emitEvent("download", late);
      });
    },
  });
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });
  const operation = sink.make();

  const result = await core.render("https://origin.test/doc", { artifactOperation: operation });

  assert.deepEqual(operation.downloads, [first], "the late event must never be registered");
  assert.ok(
    sink.log.includes("invalidate:0:download-lifecycle-race"),
    `the late event did not race the generation (log: ${sink.log.join(",")})`,
  );
  assert.deepEqual(late.calls, ["cancel", "delete"], "the late event's driver copy was not disposed");
  assert.deepEqual(result.artifactOutcome, { outcome: "capture-failed", failure: "download-lifecycle-race" });
});

test("render(): a capture that never settles does not wedge teardown — the barrier is bounded", async () => {
  const download = { path: async () => "/driver/tmp/attachment.pdf" };
  const context = fakeContext({ duringGoto: (emit) => emit("download", download) });
  const sink = operationFactory({ stage: () => new Promise(() => {}) }); // never settles
  const core = coreWith(context, {
    captureEnabled: true,
    captureSettleTimeoutMs: 25,
  });

  // The whole point: this must resolve at all. A test-level timeout keeps an unbounded barrier from
  // hanging the suite instead of failing it.
  const outcome = await Promise.race([
    core.render("https://origin.test/doc", { artifactOperation: sink.make() }).then(() => "returned"),
    new Promise((resolve) => setTimeout(() => resolve("wedged"), 5_000)),
  ]);

  assert.equal(outcome, "returned", "render() never returned — the capture barrier is unbounded");
  assert.ok(
    context.calls.includes("close"),
    `the page was never torn down (calls: ${context.calls.join(",")})`,
  );
});

test("closeActivePage(): invalidates its own page's generation synchronously", async () => {
  const context = fakeContext({ duringGoto: (emit) => emit("download", disposableDownload()) });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const sink = operationFactory({ stage: () => held });
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });

  const navigating = core.navigate("https://origin.test/doc", { artifactOperation: sink.make() });
  await drain();

  const closing = core.closeActivePage();
  assert.ok(
    sink.log.some((e) => e.startsWith("invalidate:0:")),
    `closeActivePage deferred its invalidation past its first await (log: ${sink.log.join(",")})`,
  );

  release();
  const [snapshot] = await Promise.all([navigating, closing]);
  assert.deepEqual(snapshot.artifactOutcome, { outcome: "capture-failed", failure: "artifact-runtime-invalidated" });
});

test("render(): the landed main-frame status and content type are reported to the operation", async () => {
  const context = fakeContext({ landedResponse: { status: 200, contentType: "application/pdf" } });
  const sink = operationFactory();
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });

  await core.render("https://origin.test/doc", { artifactOperation: sink.make() });

  // These are the inputs the inline predicate is decided from. The core reports the observation; it
  // does not decide anything from it — normalization and the predicate live in the operation.
  assert.ok(
    sink.log.includes("note:0:200:application/pdf"),
    `the landed main-frame observables were not reported (log: ${sink.log.join(",")})`,
  );
});

test("render(): the operation is sealed after the capture barrier and its outcome rides on the result", async () => {
  const download = { path: async () => "/driver/tmp/attachment.pdf" };
  const context = fakeContext({ duringGoto: (emit) => emit("download", download) });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const outcome = { outcome: "available", artifact: { id: "opaque", bytes: 1234 } };
  const sink = operationFactory({
    sealResult: outcome,
    mirror: context.calls, // one shared log, so seal can be ordered against teardown
    stage: () => held.then(() => { context.calls.push("stage-settled"); }),
  });
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });

  const rendering = core.render("https://origin.test/doc", { artifactOperation: sink.make() });
  await drain();
  release();
  const result = await rendering;

  assert.deepEqual(
    sink.log.filter((entry) => entry.startsWith("seal:")),
    ["seal:0"],
    `the operation was sealed exactly once (log: ${sink.log.join(",")})`,
  );
  assert.ok(
    sink.log.indexOf("register:0") < sink.log.indexOf("seal:0"),
    `seal must follow the capture it commits (log: ${sink.log.join(",")})`,
  );
  assert.ok(
    context.calls.includes("stage-settled"),
    `staging never settled (calls: ${context.calls.join(",")})`,
  );
  assert.ok(context.calls.includes("seal"), "the seal never reached the page timeline");
  // seal() IS the barrier under the authoritative API: it is entered before staging settles and only
  // resolves once the operation's internal staging has. What must hold is that the page is not torn
  // down until that resolution.
  assert.ok(
    context.calls.indexOf("stage-settled") < context.calls.indexOf("close"),
    `the page was torn down before staging settled (calls: ${context.calls.join(",")})`,
  );
  assert.deepEqual(
    result.artifactOutcome,
    outcome,
    "the sealed outcome is carried on the render result, unreshaped",
  );
});

test("navigate(): the operation is sealed after the barrier and its outcome rides on the snapshot", async () => {
  const download = { path: async () => "/driver/tmp/attachment.pdf" };
  const context = fakeContext({ duringGoto: (emit) => emit("download", download) });
  const outcome = { outcome: "available", artifact: { id: "opaque", bytes: 1234 } };
  const sink = operationFactory({
    sealResult: outcome,
    mirror: context.calls,
    stage: () => new Promise((resolve) => setImmediate(resolve)).then(() => {
      context.calls.push("stage-settled");
    }),
  });
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });

  const snapshot = await core.navigate("https://origin.test/doc", { artifactOperation: sink.make() });

  assert.deepEqual(
    sink.log.filter((entry) => entry.startsWith("seal:")),
    ["seal:0"],
    `the navigation's operation was sealed exactly once (log: ${sink.log.join(",")})`,
  );
  assert.ok(
    context.calls.indexOf("stage-settled") < context.calls.indexOf("seal"),
    `seal must follow the barrier (calls: ${context.calls.join(",")})`,
  );
  assert.deepEqual(snapshot.artifactOutcome, outcome, "the sealed outcome rides on the snapshot");
});

test("navigate(): a sealed operation is not invalidated again by the next navigation", async () => {
  const context = fakeContext();
  const sink = operationFactory();
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });

  await core.navigate("https://origin.test/one", { artifactOperation: sink.make() });
  await core.navigate("https://origin.test/two", { artifactOperation: sink.make() });

  // Sealing unbinds. A retire-on-begin that still found the sealed operation would double-commit it,
  // and for an available artifact that second call is the one that would throw it away.
  assert.deepEqual(
    sink.log.filter((entry) => entry.startsWith("seal:") || entry.startsWith("invalidate:")),
    ["seal:0", "seal:1"],
    `a sealed operation must not be retired afterwards (log: ${sink.log.join(",")})`,
  );
});

test("snapshot(): the last action's sealed outcome rides on the next snapshot, and only that one", async () => {
  const download = { path: async () => "/driver/tmp/attachment.pdf" };
  const context = fakeContext({ duringClick: (emit) => emit("download", download) });
  const outcome = { outcome: "available", artifact: { id: "opaque", bytes: 1234 } };
  const sink = operationFactory({ sealResult: outcome });
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });

  await core.navigate("https://origin.test/doc", { artifactOperation: sink.make() });
  await core.click({ target: "e5", element: "Download attachment" }, { artifactOperation: sink.make() });
  const afterAction = await core.snapshot();
  const later = await core.snapshot();

  assert.deepEqual(afterAction.artifactOutcome, outcome, "the action's verdict reaches its own snapshot");
  assert.equal(
    "artifactOutcome" in later,
    false,
    "consume-once: a later bare snapshot must not re-report a previous action's artifact",
  );
});

test("navigate(): supersedes an un-snapshotted action's outcome instead of leaking it forward", async () => {
  const download = { path: async () => "/driver/tmp/attachment.pdf" };
  const context = fakeContext({ duringClick: (emit) => emit("download", download) });
  const sink = operationFactory({ sealResult: { outcome: "available", artifact: { id: "opaque" } } });
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });

  await core.navigate("https://origin.test/one", { artifactOperation: sink.make() });
  await core.click({ target: "e5" }, { artifactOperation: sink.make() });   // seals, but its snapshot is never taken
  await core.navigate("https://origin.test/two", { artifactOperation: sink.make() });
  const later = await core.snapshot();

  assert.equal(
    "artifactOutcome" in later,
    false,
    "a stale action outcome must not resurface on a snapshot of a different page state",
  );
});

test("render(): no artifact material reaches diagnostics, page text, or stderr", async () => {
  const DRIVER_PATH = "/driver/tmp/dl-9f2c/confidential-report.pdf";
  const SUGGESTED = "Confidential Report.pdf";
  const ARTIFACT_ID = "artifact-id-abcdefghijklmnop";
  const SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const download = {
    path: async () => DRIVER_PATH,
    suggestedFilename: () => SUGGESTED,
    // The DOWNLOAD's own URL, deliberately different from the navigation's: this test is about the
    // capture path not leaking the event's material. The navigation URL is carried raw at this layer
    // by long-standing design (see render()'s diagnostics note) and is redacted by the retrieve
    // surfacing layer — asserting on it here would be testing a different unit's contract.
    url: () => "https://origin.test/dl?token=downloadsecret",
  };
  const context = fakeContext({ duringGoto: (emit) => emit("download", download) });
  const sink = operationFactory({
    sealResult: { outcome: "available", artifact: { id: ARTIFACT_ID, sha256: SHA, bytes: 1234 } },
  });
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });

  const written = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => { written.push(String(chunk)); return realWrite(chunk, ...rest); };
  let result;
  try {
    result = await core.render("https://origin.test/doc", { artifactOperation: sink.make() });
  } finally {
    process.stderr.write = realWrite;
  }

  const forbidden = [DRIVER_PATH, "dl-9f2c", SUGGESTED, ARTIFACT_ID, SHA, "downloadsecret"];
  // artifactOutcome is the ONE sanctioned carrier; everything else must be clean.
  const { artifactOutcome, ...rest } = result;
  const surfaces = {
    "result (minus artifactOutcome)": JSON.stringify(rest),
    stderr: written.join(""),
  };
  for (const [surface, text] of Object.entries(surfaces)) {
    for (const secret of forbidden) {
      assert.equal(text.includes(secret), false, `${surface} leaked ${JSON.stringify(secret)}`);
    }
  }
  assert.equal(artifactOutcome.artifact.id, ARTIFACT_ID, "the sanctioned carrier still has the metadata");
});

test("render(): with capture disabled there is no listener, no operation and no outcome field", async () => {
  const context = fakeContext();
  const core = coreWith(context, {});

  const result = await core.render("https://origin.test/doc");

  assert.equal(
    context.calls.includes("on:download"),
    false,
    `a capture-disabled session installed a download listener (calls: ${context.calls.join(",")})`,
  );
  assert.equal("artifactOutcome" in result, false, "a capture-disabled result carries no artifact field");
});

test("render(): a subframe response is not reported as the landed main-frame observation", async () => {
  // An unrelated iframe answering 200 application/pdf must not be mistaken for the main document —
  // that would let an embedded viewer masquerade as the landed navigation.
  const context = fakeContext({ subframeResponse: { status: 200, contentType: "application/pdf" } });
  const sink = operationFactory();
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });

  await core.render("https://origin.test/doc", { artifactOperation: sink.make() });

  assert.deepEqual(
    sink.log.filter((entry) => entry.startsWith("note:")),
    [],
    `a subframe response was reported as the landed observation (log: ${sink.log.join(",")})`,
  );
});

test("close(): invalidates first, so an in-flight capture cannot publish even as the context dies", async () => {
  // Amendment 1 §6 rules 6-7: teardown marks the generation invalidated FIRST, synchronously, and is
  // never queued behind the capture. Staging is internal to the operation, so the guarantee is
  // "cannot publish", not "was allowed to finish".
  const context = fakeContext({ duringGoto: (emit) => emit("download", disposableDownload()) });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const sink = operationFactory({ stage: () => held });
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });

  const navigating = core.navigate("https://origin.test/doc", { artifactOperation: sink.make() });
  await drain();

  const closing = core.close();
  assert.ok(
    sink.log.some((e) => e.startsWith("invalidate:0:")),
    `close() deferred its invalidation (log: ${sink.log.join(",")})`,
  );
  await closing;
  assert.ok(context.calls.includes("context-close"), "close() queued behind the in-flight capture");

  release();
  const snapshot = await navigating;
  assert.deepEqual(
    snapshot.artifactOutcome,
    { outcome: "capture-failed", failure: "artifact-runtime-invalidated" },
    "the owner must still receive its operation's result, projected capture-failed",
  );
});

test("kill(): does not queue behind a wedged capture", async () => {
  const download = { path: async () => "/driver/tmp/attachment.pdf" };
  const context = fakeContext({ duringGoto: (emit) => emit("download", download) });
  const sink = operationFactory({ stage: () => new Promise(() => {}) }); // never settles
  const core = coreWith(context, {
    captureEnabled: true,
    captureSettleTimeoutMs: 60_000, // far longer than this test would ever wait
  });

  void core.navigate("https://origin.test/doc", { artifactOperation: sink.make() }).catch(() => {});
  await drain();

  // Force-kill is the escalation for a wedged session; queueing it behind the very capture that may
  // be wedging things would deadlock the one path that exists to break the deadlock. On this fake
  // context force-kill is unavailable, so kill() REJECTS — the point is that it does so promptly
  // rather than blocking on the barrier.
  const outcome = await Promise.race([
    core.kill(50).then(() => "resolved", () => "rejected"),
    new Promise((resolve) => setTimeout(() => resolve("queued"), 3_000)),
  ]);

  assert.notEqual(outcome, "queued", "kill() blocked behind an in-flight capture");
});

test("the artifact settle timeout defaults to the normative 5 seconds", () => {
  // Amendment 1 §6 step 4: BGW_ARTIFACT_SETTLE_TIMEOUT_MS default 5000. This is the single bound the
  // whole cutoff runs under, so drifting it silently changes teardown behavior everywhere.
  assert.equal(DEFAULT_CORE_OPTIONS.captureSettleTimeoutMs, 5_000);
});

test("render(): an expired settle budget terminalizes with the exact download-settle-timeout code", async () => {
  const download = { path: async () => "/driver/tmp/attachment.pdf" };
  const context = fakeContext({ duringGoto: (emit) => emit("download", download) });
  const sink = operationFactory({ stage: () => new Promise(() => {}) }); // never settles
  const core = coreWith(context, {
    captureEnabled: true,
    captureSettleTimeoutMs: 25,
  });

  const result = await core.render("https://origin.test/doc", { artifactOperation: sink.make() });

  assert.ok(
    sink.log.includes("invalidate:0:download-settle-timeout"),
    `the wedged capture was not terminalized with its own code (log: ${sink.log.join(",")})`,
  );
  assert.deepEqual(result.artifactOutcome, {
    outcome: "capture-failed",
    failure: "download-settle-timeout",
  });
  assert.ok(context.calls.includes("close"), "teardown still proceeded");
});

test("an event between generations is an orphan: disposed, core marked dirty, next action fails closed", async () => {
  const context = fakeContext();
  const sink = operationFactory();
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });

  await core.navigate("https://origin.test/doc", { artifactOperation: sink.make() });
  // Nothing is open now: this event belongs to no operation and must not join the next one.
  const orphan = disposableDownload();
  context.emit("download", orphan);
  await drain();

  assert.deepEqual(orphan.calls, ["cancel", "delete"], "the orphan's driver copy was not disposed");
  assert.equal(sink.operations.length, 1, "an orphan must not join or open a generation");
  // A core that saw an unattributable download is dirty regardless of whether disposal succeeded.
  await assert.rejects(core.navigate("https://origin.test/next", { artifactOperation: sink.make() }));
  await assert.rejects(core.click({ target: "e5" }, { artifactOperation: sink.make() }));
});

test("popup pages get a download listener immediately, routed to the one open generation", async () => {
  const popupDownload = { path: async () => "/driver/tmp/popup.pdf" };
  let popup;
  // The popup is announced by the context WHILE the navigation's generation is open — the only
  // moment at which its download has a generation to belong to.
  const context = fakeContext({
    duringGoto: (_emit, openPopup) => {
      popup = openPopup();
      popup.emit("download", popupDownload);
    },
  });
  const sink = operationFactory();
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });

  await core.navigate("https://origin.test/doc", { artifactOperation: sink.make() });

  assert.ok(
    popup.calls.includes("on:download"),
    `no listener was installed on the popup (popup calls: ${popup.calls.join(",")})`,
  );
  assert.deepEqual(
    sink.operations[0].downloads,
    [popupDownload],
    "a popup download must register to the core's one open generation",
  );
  assert.equal(sink.operations.length, 1, "a popup must not open a generation of its own");
});

test("waitFor(): opens a generation like every other download-capable verb", async () => {
  const context = fakeContext();
  const sink = operationFactory();
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });

  await core.navigate("https://origin.test/doc", { artifactOperation: sink.make() });
  await core.waitFor({ timeMs: 1 }, { artifactOperation: sink.make() });

  // Amendment 2 §4 lists waitFor among the generation-opening verbs: a wait can outlast a click that
  // triggers a download, so an event arriving during it must have somewhere to attach.
  assert.equal(sink.operations.length, 2, "waitFor did not open its own generation");
  assert.deepEqual(
    sink.log.filter((e) => e.startsWith("seal:")),
    ["seal:0", "seal:1"],
    `waitFor's generation was not sealed (log: ${sink.log.join(",")})`,
  );
});

test("snapshot() and screenshot() do not open generations", async () => {
  const context = fakeContext();
  const sink = operationFactory();
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });

  await core.navigate("https://origin.test/doc", { artifactOperation: sink.make() });
  await core.snapshot();
  await core.snapshot();

  assert.equal(sink.operations.length, 1, "a read-only verb must not open a generation");
});

test("close(): invalidates the open generation synchronously, before its first await", async () => {
  const download = { path: async () => "/driver/tmp/attachment.pdf" };
  const context = fakeContext({ duringGoto: (emit) => emit("download", download) });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const sink = operationFactory({ stage: () => held.then(() => { context.calls.push("stage-settled"); }) });
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });

  const navigating = core.navigate("https://origin.test/doc", { artifactOperation: sink.make() });
  await drain();

  const closing = core.close();
  // SYNCHRONOUS: the invalidation must already have happened on the same turn close() was called,
  // before any await could let a late completion publish.
  assert.ok(
    sink.log.some((e) => e.startsWith("invalidate:0:")),
    `close() deferred its invalidation (log: ${sink.log.join(",")})`,
  );

  release();
  const snapshot = await navigating;
  // Non-queued by contract: the context may die before staging settles. What must hold is that the
  // in-flight capture cannot publish, and its owner still receives a projected result.
  assert.deepEqual(
    snapshot.artifactOutcome,
    { outcome: "capture-failed", failure: "artifact-runtime-invalidated" },
  );
  await closing;
});

test("close(): its synchronous closing fence rejects a successor capture before browser work", async () => {
  const context = fakeContext();
  const sink = operationFactory();
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });

  // close() sets its fence and reaches the cutoff-turn await. A normal concurrent verb can run in
  // that interval; it must not install a fresh generation in the context being destroyed.
  const closing = core.close();
  await assert.rejects(
    core.waitFor({ timeMs: 1 }, { artifactOperation: sink.make() }),
    /artifact capture: core is closing; session must be replaced/,
  );
  assert.deepEqual(sink.log, ["begin:0"], "teardown touched the successor operation after rejecting admission");
  await closing;
});

test("kill(): raises its closing fence before invalidation can re-enter with a successor", async () => {
  const context = fakeContext({ duringGoto: (emit) => emit("download", disposableDownload()) });
  const sink = operationFactory({ stage: () => new Promise(() => {}) });
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });
  const current = sink.make();
  const successor = sink.make();
  let reentry;
  const invalidate = current.invalidate;
  current.invalidate = function (reason) {
    if (reentry === undefined) {
      reentry = assert.rejects(
        core.waitFor({ timeMs: 1 }, { artifactOperation: successor }),
        /artifact capture: core is closing; session must be replaced/,
      );
    }
    return Reflect.apply(invalidate, current, [reason]);
  };

  void core.navigate("https://origin.test/doc", { artifactOperation: current }).catch(() => {});
  await drain();
  await assert.rejects(core.kill(50), /force-kill unavailable/);
  await reentry;
  await core.close();
});

test("closeActivePage(): raises a page fence before invalidation can re-enter on that page", async () => {
  const context = fakeContext({ duringGoto: (emit) => emit("download", disposableDownload()) });
  const sink = operationFactory({ stage: () => new Promise(() => {}) });
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });
  const current = sink.make();
  const successor = sink.make();
  let reentry;
  const invalidate = current.invalidate;
  current.invalidate = function (reason) {
    if (reentry === undefined) {
      reentry = assert.rejects(
        core.waitFor({ timeMs: 1 }, { artifactOperation: successor }),
        /artifact capture: active page is closing; session must be replaced/,
      );
    }
    return Reflect.apply(invalidate, current, [reason]);
  };

  void core.navigate("https://origin.test/doc", { artifactOperation: current }).catch(() => {});
  await drain();
  await core.closeActivePage();
  await reentry;
  await core.close();
});

test("closeActivePage(): its page fence survives the acquisition-to-generation await", async () => {
  const context = fakeContext();
  const sink = operationFactory();
  let closingPhase = false;
  let releaseClose;
  const closeHeld = new Promise((resolve) => { releaseClose = resolve; });
  const core = coreWith(context, {
    captureEnabled: true,
    captureSettleTimeoutMs: 100,
    captureDrainTurn: async () => {
      if (closingPhase) await closeHeld;
      else await new Promise((resolve) => setImmediate(resolve));
    },
  });

  await core.navigate("https://origin.test/first", { artifactOperation: sink.make() });
  // navigate() has synchronously acquired the existing page, then yields on its async helper before it
  // opens the successor generation. Teardown must fence that same page during the yield.
  const successor = core.navigate("https://origin.test/successor", { artifactOperation: sink.make() });
  closingPhase = true;
  const closing = core.closeActivePage();
  await assert.rejects(successor, /artifact capture: active page is closing; session must be replaced/);
  releaseClose();
  await closing;
  await core.close();
});

test("closeActivePage(): a rejected driver close retains the page and poisons successor capture", async () => {
  const context = fakeContext();
  const sink = operationFactory();
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });
  await core.navigate("https://origin.test/drive", { artifactOperation: sink.make() });
  const retained = context.page;
  retained.close = async () => { throw new Error("private driver close detail"); };

  await assert.rejects(core.closeActivePage(), /artifact capture: page close failed; session must be replaced/);
  assert.equal(context.page, retained, "a failed close discarded the only handle to the still-live page");
  await assert.rejects(
    core.waitFor({ timeMs: 1 }, { artifactOperation: sink.make() }),
    /artifact capture: core is dirty; session must be replaced/,
  );
  await core.close();
});

test("render(): a rejected transient-page close poisons successor capture", async () => {
  const context = fakeContext();
  const sink = operationFactory();
  const originalNewPage = context.newPage;
  context.newPage = async function () {
    const page = await Reflect.apply(originalNewPage, context, []);
    page.close = async () => { throw new Error("private driver close detail"); };
    return page;
  };
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });

  await assert.rejects(
    core.render("https://origin.test/transient", { artifactOperation: sink.make() }),
    /artifact capture: page close failed; session must be replaced/,
  );
  await assert.rejects(
    core.render("https://origin.test/successor", { artifactOperation: sink.make() }),
    /artifact capture: core is dirty; session must be replaced/,
  );
  await core.close();
});

test("kill(): invalidates synchronously and never queues behind a capture", async () => {
  const download = { path: async () => "/driver/tmp/attachment.pdf" };
  const context = fakeContext({ duringGoto: (emit) => emit("download", download) });
  const sink = operationFactory({ stage: () => new Promise(() => {}) }); // never settles
  const core = coreWith(context, {
    captureEnabled: true,
    captureSettleTimeoutMs: 60_000,
  });

  void core.navigate("https://origin.test/doc", { artifactOperation: sink.make() }).catch(() => {});
  await drain();

  const killing = core.kill(50).then(() => "resolved", () => "rejected");
  assert.ok(
    sink.log.some((e) => e.startsWith("invalidate:0:")),
    `kill() deferred its invalidation (log: ${sink.log.join(",")})`,
  );
  const outcome = await Promise.race([
    killing,
    new Promise((resolve) => setTimeout(() => resolve("queued"), 3_000)),
  ]);
  assert.notEqual(outcome, "queued", "kill() blocked behind an in-flight capture");
});

test("close(): invalidates a TRANSIENT render page's generation it never saw", async () => {
  // A render page is per-call and never becomes the active drive page. Core teardown is global, so its
  // generation is invalidated too — and the render still receives its own projected result.
  const context = fakeContext({ duringGoto: (emit) => emit("download", disposableDownload()) });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const sink = operationFactory({ stage: () => held });
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });

  const rendering = core.render("https://origin.test/doc", { artifactOperation: sink.make() });
  await drain();

  const closing = core.close();
  assert.ok(
    sink.log.some((e) => e.startsWith("invalidate:0:")),
    `close() did not invalidate the transient generation (log: ${sink.log.join(",")})`,
  );

  release();
  const [result] = await Promise.all([rendering, closing]);
  assert.deepEqual(result.artifactOutcome, { outcome: "capture-failed", failure: "artifact-runtime-invalidated" });
});

// ---------------------------------------------------------------------------------------------
// Controller round-2 blockers
// ---------------------------------------------------------------------------------------------

/** A download that can be disposed, recording how. `failDelete` models a driver refusing removal. */
function disposableDownload({ failDelete = false, failCancel = false } = {}) {
  const calls = [];
  return {
    path: async () => "/driver/tmp/attachment.pdf",
    async cancel() {
      calls.push("cancel");
      if (failCancel) throw new Error("driver refused to cancel");
    },
    async delete() {
      calls.push("delete");
      if (failDelete) throw new Error("driver refused");
    },
    get calls() { return calls; },
  };
}

test("a late event is disposed through the driver and, when disposal succeeds, the core stays usable", async () => {
  const late = disposableDownload();
  let emitEvent;
  const context = fakeContext({ duringGoto: (emit) => { emitEvent = emit; emit("download", disposableDownload()); } });
  let stageCalls = 0;
  const sink = operationFactory({
    stage: () => {
      const nth = ++stageCalls;
      return new Promise((resolve) => setImmediate(resolve)).then(() => {
        if (nth === 1) emitEvent("download", late);
      });
    },
  });
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });

  await core.render("https://origin.test/doc", { artifactOperation: sink.make() });

  // BOTH driver operations are mandatory, in this order: stop the transfer, then remove the copy.
  assert.deepEqual(late.calls, ["cancel", "delete"], "the late event's driver copy was not disposed");
  // Disposal succeeded, so the session's download state is still fully accounted for.
  await core.render("https://origin.test/again", { artifactOperation: sink.make() });
});

test("a late event whose disposal FAILS turns the core dirty and the next action fails closed", async () => {
  for (const mode of ["delete-rejects", "cancel-rejects", "no-disposal"]) {
    const late = mode === "no-disposal"
      ? { path: async () => "/driver/tmp/late.pdf" }
      : disposableDownload(mode === "delete-rejects" ? { failDelete: true } : { failCancel: true });
    let emitEvent;
    const context = fakeContext({ duringGoto: (emit) => { emitEvent = emit; emit("download", disposableDownload()); } });
    let stageCalls = 0;
    const sink = operationFactory({
      stage: () => {
        const nth = ++stageCalls;
        return new Promise((resolve) => setImmediate(resolve)).then(() => {
          if (nth === 1) emitEvent("download", late);
        });
      },
    });
    const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });

    await core.render("https://origin.test/doc", { artifactOperation: sink.make() });
    await drain();

    // EITHER failure counts, and a driver offering no disposal at all cannot prove its bytes are gone.
    await assert.rejects(
      core.render("https://origin.test/again", { artifactOperation: sink.make() }),
      `${mode} did not dirty the core`,
    );
  }
});

test("the cutoff drain turn is a real awaited boundary: an event injected there is already late", async () => {
  const late = disposableDownload();
  const context = fakeContext({ duringGoto: (emit) => { context.lateEmit = emit; emit("download", disposableDownload()); } });
  const sink = operationFactory();
  let drainEntered = false;
  const core = coreWith(context, {
    captureEnabled: true,
    // The injected drain turn: production defaults to one setImmediate. Blocking here puts the test
    // exactly at the boundary between "entered sealing" and "snapshot the registered jobs".
    captureDrainTurn: async () => {
      drainEntered = true;
      context.lateEmit("download", late);
    },
  });

  await core.render("https://origin.test/doc", { artifactOperation: sink.make() });

  assert.equal(drainEntered, true, "the cutoff never awaited a drain turn");
  assert.ok(
    sink.log.includes("invalidate:0:download-lifecycle-race"),
    `an event injected at the drain boundary must already be late (log: ${sink.log.join(",")})`,
  );
  assert.deepEqual(
    sink.operations[0].downloads.length,
    1,
    "the drain-boundary event must not be registered into the generation",
  );
});

test("a configured sink that refuses to open a generation fails the action closed, through the real adapter", async () => {
  const runtime = new ArtifactRuntime({ enabled: true, root: join(mkdtempSync(join(tmpdir(), "bgw-cap-")), "a") });
  const context = fakeContext();
  // Under the authoritative API the CALLER creates the operation, so an unpublishable host fails at
  // creation — before the browser is involved at all. This is the caller's boundary, not the core's.
  assert.throws(
    () => runtime.createOperation({ owner: { scope: "consumer", consumerId: "owner" }, sourceHost: "203.0.113.7" }),
    (e) => e.code === "artifact-config-invalid",
  );
  await runtime.close();
});

test("drive: landed main-frame application/pdf with zero downloads is inline-pdf-unsupported", async () => {
  const runtime = new ArtifactRuntime({ enabled: true, root: join(mkdtempSync(join(tmpdir(), "bgw-cap-")), "a") });
  const context = fakeContext({ landedResponse: { status: 200, contentType: "application/pdf" } });
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });

  // Through the REAL runtime, so the predicate is the authoritative one and not a fake's canned answer.
  const operation = runtime.createOperation({ owner: { scope: "consumer", consumerId: "owner" }, sourceHost: "origin.test" });
  const snapshot = await core.navigate("https://origin.test/doc", { artifactOperation: operation });

  assert.deepEqual(
    snapshot.artifactOutcome,
    { outcome: "inline-pdf-unsupported", failure: "inline-pdf-unsupported" },
    "the drive path produced no inline evidence",
  );
  await runtime.close();
});

test("drive: a subframe application/pdf response does not classify as inline", async () => {
  const runtime = new ArtifactRuntime({ enabled: true, root: join(mkdtempSync(join(tmpdir(), "bgw-cap-")), "a") });
  const context = fakeContext({ subframeResponse: { status: 200, contentType: "application/pdf" } });
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });

  const operation = runtime.createOperation({ owner: { scope: "consumer", consumerId: "owner" }, sourceHost: "origin.test" });
  const snapshot = await core.navigate("https://origin.test/doc", { artifactOperation: operation });

  assert.deepEqual(snapshot.artifactOutcome, { outcome: "none" }, "an embedded viewer was read as the landed document");
  await runtime.close();
});


test("overlapping renders are rejected without touching the first render's generation", async () => {
  const first = disposableDownload();
  let releaseFirst;
  const held = new Promise((resolve) => { releaseFirst = resolve; });
  const context = fakeContext({ duringGoto: (emit) => emit("download", first) });
  const sink = operationFactory({
    sealResult: { outcome: "available", artifact: { id: "opaque", bytes: 1234 } },
    stage: () => held.then(() => {}),
  });
  const core = coreWith(context, {
    captureEnabled: true,
    // Small enough that a settle-timeout path would be unmistakable in the log, and short enough that
    // an accidental wait on it could not be mistaken for a prompt rejection.
    captureSettleTimeoutMs: 50,
  });

  const firstRender = core.render("https://origin.test/one", { artifactOperation: sink.make() });
  await drain();

  // The overlapping attempt must be refused on its own terms. Its failure path owns NO generation, so
  // it must not settle, seal, reclassify or wait on the generation the first render still holds.
  await assert.rejects(core.render("https://origin.test/two", { artifactOperation: sink.make() }));
  // The rejected attempt owns no generation, so it must terminalize nothing — neither the first
  // render's operation nor the one its own caller created for it. (`seal:0` in the log is the FIRST
  // render's own cutoff, already in progress and awaiting its held staging.)
  assert.deepEqual(
    sink.log.filter((e) => e.startsWith("invalidate:") || e === "seal:1"),
    [],
    `the rejected render closed out a generation (log: ${sink.log.join(",")})`,
  );

  releaseFirst();
  const result = await firstRender;

  // The first render keeps its own download and its own successful outcome.
  assert.deepEqual(sink.operations[1].downloads, [], "the rejected attempt's operation was never used");
  assert.deepEqual(sink.operations[0].downloads, [first], "the first render kept its own download");
  assert.deepEqual(
    result.artifactOutcome,
    { outcome: "available", artifact: { id: "opaque", bytes: 1234 } },
    "the first render's own outcome was lost to the rejected overlap",
  );
  assert.deepEqual(
    sink.log.filter((e) => e.startsWith("invalidate:")),
    [],
    `the first render was pushed down a lifecycle-failure path (log: ${sink.log.join(",")})`,
  );
  assert.deepEqual(
    sink.log.filter((e) => e.startsWith("seal:")),
    ["seal:0"],
    `the generation must be sealed exactly once, by its owner (log: ${sink.log.join(",")})`,
  );
});

test("a frame-triggered download is delivered page-level and joins the one open generation", async () => {
  // The driver surfaces a frame-triggered attachment as a PAGE-level download event, so there must be
  // no frame-based branching for it to fall through: it belongs to whatever generation is open.
  const frameDownload = disposableDownload();
  const context = fakeContext({ duringGoto: (emit) => emit("download", frameDownload) });
  const sink = operationFactory();
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });

  const snapshot = await core.navigate("https://origin.test/doc", { artifactOperation: sink.make() });

  assert.equal(sink.operations.length, 1, "a frame source must not open a generation of its own");
  assert.deepEqual(sink.operations[0].downloads, [frameDownload]);
  assert.ok(snapshot.artifactOutcome, "the generation still produced an outcome");
});

test("closeActivePage() cannot invalidate a transient render's generation on another page", async () => {
  const download = disposableDownload();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const context = fakeContext({ duringGoto: (emit) => emit("download", download) });
  const sink = operationFactory({
    sealResult: { outcome: "available", artifact: { id: "opaque", bytes: 7 } },
    stage: () => held.then(() => {}),
  });
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });

  const rendering = core.render("https://origin.test/one", { artifactOperation: sink.make() });
  await drain();

  // Page-scoped teardown of a DIFFERENT page must not reach into this generation — not to invalidate
  // it, and not to wait on its jobs either. (With no active drive page there is nothing of its own to
  // retire at all.) Checked synchronously, so a drain that blocked on the held job would be visible.
  const closing = core.closeActivePage();
  assert.deepEqual(
    sink.log.filter((e) => e.startsWith("invalidate:")),
    [],
    `closeActivePage retired a generation belonging to another page (log: ${sink.log.join(",")})`,
  );

  release();
  const [result] = await Promise.all([rendering, closing]);
  assert.deepEqual(
    result.artifactOutcome,
    { outcome: "available", artifact: { id: "opaque", bytes: 7 } },
    "the transient render lost its outcome to an unrelated page teardown",
  );
});

test("closeActivePage() with a drive page open still cannot invalidate another page's generation", async () => {
  // Both exist at once: an active drive page AND a transient render generation. This is the case where
  // the owner comparison actually decides something — a page-scoped teardown that skipped it would
  // retire the render's generation because it merely happens to be the current one.
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  // Emit only on the SECOND navigation, so the drive generation closes out cleanly and it is the
  // render's generation that is still open — and still holding a job — when teardown arrives.
  let gotos = 0;
  const context = fakeContext({
    duringGoto: (emit) => { if (++gotos === 2) emit("download", disposableDownload()); },
  });
  const sink = operationFactory({
    sealResult: { outcome: "available", artifact: { id: "opaque", bytes: 9 } },
    stage: () => held.then(() => {}),
  });
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });

  await core.navigate("https://origin.test/drive", { artifactOperation: sink.make() });        // opens and seals the drive generation
  const rendering = core.render("https://origin.test/one", { artifactOperation: sink.make() }); // transient page, its own generation
  await drain();

  let closed = false;
  const closing = core.closeActivePage().then(() => { closed = true; });
  assert.deepEqual(
    sink.log.filter((e) => e.startsWith("invalidate:")),
    [],
    `page-scoped teardown retired a generation owned by another page (log: ${sink.log.join(",")})`,
  );
  await drain();
  // Nor may it BLOCK on that page's capture: draining another operation's jobs is the same
  // cross-operation coupling as invalidating them, just quieter.
  assert.equal(closed, true, "page-scoped teardown waited on another page's in-flight capture");

  release();
  const [result] = await Promise.all([rendering, closing]);
  assert.deepEqual(
    result.artifactOutcome,
    { outcome: "available", artifact: { id: "opaque", bytes: 9 } },
    "the transient render's outcome was destroyed by an unrelated page teardown",
  );
});

test("a settle that outlives its own generation cannot clear a successor's slot", async () => {
  // The slot can legitimately change under an in-flight settle: teardown clears it, and the next verb
  // opens a fresh generation. Clearing without comparing identity would free the SUCCESSOR's slot —
  // and a live generation with no slot stops receiving its own downloads, which then become orphans
  // and dirty the core.
  let releaseFirst;
  let releaseSecond;
  const firstHeld = new Promise((resolve) => { releaseFirst = resolve; });
  const secondHeld = new Promise((resolve) => { releaseSecond = resolve; });
  let gotos = 0;
  const context = fakeContext({
    duringGoto: (emit) => { if (++gotos <= 2) emit("download", disposableDownload()); },
  });
  const sink = operationFactory({ stage: (index) => (index === 0 ? firstHeld : secondHeld) });
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });

  const navigating = core.navigate("https://origin.test/one", { artifactOperation: sink.make() });
  await drain();

  // Teardown retires generation 0 and frees the slot while navigate's settle is still parked on it.
  const closing = core.closeActivePage();
  await drain();

  // A fresh operation legitimately takes the slot and parks on its own held job.
  const second = core.navigate("https://origin.test/two", { artifactOperation: sink.make() });
  await drain();

  // Generation 0's settle now resumes. It must not touch the slot generation 1 owns.
  releaseFirst();
  await drain();

  // Proof the successor still owns its slot: generation 1 is live, so the one-generation invariant
  // must still refuse a third operation. A slot freed by generation 0's late bookkeeping would let
  // this one through, running two live generations in a core that permits exactly one.
  await assert.rejects(
    core.navigate("https://origin.test/three", { artifactOperation: sink.make() }),
    `the successor lost its slot to a predecessor's late bookkeeping (log: ${sink.log.join(",")})`,
  );
  // The caller created a third operation for the attempt; what matters is that the CORE never opened a
  // generation on it — it was never registered to, sealed, or invalidated.
  assert.deepEqual(
    sink.log.filter((e) => e.endsWith(":2") || e.startsWith("seal:2") || e.startsWith("invalidate:2") || e.startsWith("register:2")),
    ["begin:2"],
    `a third generation was opened alongside a live one (log: ${sink.log.join(",")})`,
  );

  releaseSecond();
  await Promise.all([navigating.catch(() => {}), closing, second]);
});

test("a verb whose generation was invalidated by teardown still receives its own projected result", async () => {
  // Teardown clears the slot BEFORE this verb reaches its cutoff, so the verb settles a handle that is
  // no longer current. Identity stops it from closing out somebody else's generation — it must not
  // also cost the owner its own result.
  let releaseGoto;
  const gotoGate = new Promise((resolve) => { releaseGoto = resolve; });
  const context = fakeContext({ gotoGate });
  const sink = operationFactory();
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });

  const navigating = core.navigate("https://origin.test/doc", { artifactOperation: sink.make() });
  await drain();

  core.closeActivePage();          // synchronously invalidates and clears the slot
  releaseGoto();
  const snapshot = await navigating;

  assert.deepEqual(
    snapshot.artifactOutcome,
    { outcome: "capture-failed", failure: "artifact-runtime-invalidated" },
    "the owner lost its result to a teardown that merely cleared routing",
  );
});

test("a successor generation cannot begin while unattributed disposal is still pending", async () => {
  let releaseDelete;
  const deleting = new Promise((resolve) => { releaseDelete = resolve; });
  const late = {
    path: async () => "/driver/tmp/late.pdf",
    async cancel() {},
    async delete() { await deleting; },   // disposal in flight, outcome not yet known
  };
  let emitEvent;
  const context = fakeContext({ duringGoto: (emit) => { emitEvent = emit; emit("download", disposableDownload()); } });
  let stageCalls = 0;
  const sink = operationFactory({
    stage: () => {
      const nth = ++stageCalls;
      return new Promise((resolve) => setImmediate(resolve)).then(() => {
        if (nth === 1) emitEvent("download", late);   // late event, disposed but not yet finished
      });
    },
  });
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });

  await core.render("https://origin.test/doc", { artifactOperation: sink.make() });

  // The transient page drain owns this late disposal's bounded wait. It times out here, so the
  // unconfirmed driver state dirties the core rather than allowing a successor to start.
  await assert.rejects(
    core.render("https://origin.test/next", { artifactOperation: sink.make() }),
    "a successor began after an unconfirmed disposal",
  );

  releaseDelete();
  await drain();
});

// --- Each download-capable drive verb routes through its OWN generation (one test per verb) ---

for (const verb of [
  { name: "click", run: (core, capture) => core.click({ target: "e5" }, capture) },
  { name: "type", run: (core, capture) => core.type({ target: "e5" }, "text", {}, capture) },
  { name: "type(submit)", run: (core, capture) => core.type({ target: "e5" }, "text", { submit: true }, capture) },
  { name: "selectOption", run: (core, capture) => core.selectOption({ target: "e5" }, ["a"], capture) },
  { name: "pressKey", run: (core, capture) => core.pressKey("Enter", capture) },
  { name: "waitFor", run: (core, capture) => core.waitFor({ timeMs: 1 }, capture) },
]) {
  test(`${verb.name}(): opens its own generation and routes its download to it`, async () => {
    const download = disposableDownload();
    let emitted = false;
    const context = fakeContext({
      duringAction: (emit) => { if (!emitted) { emitted = true; emit("download", download); } },
    });
    const sink = operationFactory();
    const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });

    await core.navigate("https://origin.test/doc", { artifactOperation: sink.make() });
    const operation = sink.make();
    await verb.run(core, { artifactOperation: operation });

    // Its own generation, sealed by itself — never the navigation's, never a shared one.
    assert.deepEqual(
      sink.log.filter((e) => e.startsWith("seal:")),
      ["seal:0", "seal:1"],
      `${verb.name} did not close out its own generation (log: ${sink.log.join(",")})`,
    );
    if (verb.name !== "waitFor") {
      assert.deepEqual(
        operation.downloads,
        [download],
        `${verb.name}'s download did not reach its own operation`,
      );
      assert.deepEqual(sink.operations[0].downloads, [], "the navigation's operation must not receive it");
    }
  });

  test(`${verb.name}(): with no capture context there is no generation`, async () => {
    const context = fakeContext();
    const sink = operationFactory();
    const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });

    await core.navigate("https://origin.test/doc", { artifactOperation: sink.make() });
    await verb.run(core, undefined);   // existing callers pass nothing and are unaffected

    assert.deepEqual(
      sink.log.filter((e) => e.startsWith("seal:")),
      ["seal:0"],
      `${verb.name} opened a generation without a capture context (log: ${sink.log.join(",")})`,
    );
  });
}

test("disposal attempts delete even when cancel rejects, and the successor fails closed", async () => {
  const attempted = [];
  const late = {
    path: async () => "/driver/tmp/late.pdf",
    async cancel() { attempted.push("cancel"); throw new Error("driver refused to cancel"); },
    async delete() { attempted.push("delete"); },
  };
  let emitEvent;
  const context = fakeContext({ duringGoto: (emit) => { emitEvent = emit; emit("download", disposableDownload()); } });
  let stageCalls = 0;
  const sink = operationFactory({
    stage: () => {
      const nth = ++stageCalls;
      return new Promise((resolve) => setImmediate(resolve)).then(() => {
        if (nth === 1) emitEvent("download", late);
      });
    },
  });
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });

  await core.render("https://origin.test/doc", { artifactOperation: sink.make() });
  await drain();

  // A rejected cancel must NOT skip the delete — that is exactly the case where the driver's copy is
  // most likely to be left behind.
  assert.deepEqual(attempted, ["cancel", "delete"], "delete was skipped after cancel rejected");
  await assert.rejects(core.render("https://origin.test/next", { artifactOperation: sink.make() }));
});

test("an operation that refuses to settle fails the verb closed with a sanitized error", async () => {
  const context = fakeContext();
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });
  const secret = "/private/seal-secret sentinel";
  const refusing = {
    operationId: "op-x",
    owner: { scope: "consumer", consumerId: "owner" },
    registerDownload() {},
    noteMainResponseContentType() {},
    async seal() { throw new Error(secret); },
    invalidate() {},
  };

  // A silent `undefined` here would be indistinguishable from "capture was never configured".
  await assert.rejects(
    core.render("https://origin.test/doc", { artifactOperation: refusing }),
    (err) => err instanceof Error && !err.message.includes(secret) && !err.message.includes("sentinel"),
    "the verb neither failed closed nor sanitized the operation's error",
  );

  // And the core is dirty thereafter rather than continuing on an unknown capture state.
  const sink = operationFactory();
  await assert.rejects(core.render("https://origin.test/next", { artifactOperation: sink.make() }));
});

test("an operation that refuses once still yields its result on the invalidated retry", async () => {
  const context = fakeContext();
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });
  let seals = 0;
  const flaky = {
    operationId: "op-y",
    owner: { scope: "consumer", consumerId: "owner" },
    registerDownload() {},
    noteMainResponseContentType() {},
    invalidated: undefined,
    async seal() {
      seals += 1;
      if (seals === 1) throw new Error("transient");
      return { outcome: "capture-failed", failure: flaky.invalidated ?? "download-capture-failed" };
    },
    invalidate(reason) { flaky.invalidated ??= reason; },
  };

  const result = await core.render("https://origin.test/doc", { artifactOperation: flaky });

  assert.equal(flaky.invalidated, "download-capture-failed", "the refusal was not terminalized with a closed code");
  assert.deepEqual(result.artifactOutcome, { outcome: "capture-failed", failure: "download-capture-failed" });
});

// --- Dual-configuration mismatch fails closed (never silently "none") ---

for (const verb of [
  { name: "render", run: (core, capture) => core.render("https://origin.test/doc", capture) },
  { name: "navigate", run: (core, capture) => core.navigate("https://origin.test/doc", capture) },
  { name: "click", run: (core, capture) => core.click({ target: "e5" }, capture) },
  { name: "waitFor", run: (core, capture) => core.waitFor({ timeMs: 1 }, capture) },
]) {
  test(`${verb.name}(): an operation supplied to a capture-DISABLED session fails closed`, async () => {
    const context = fakeContext();
    const sink = operationFactory();
    const core = coreWith(context, { captureSettleTimeoutMs: 100 }); // captureEnabled omitted
    if (verb.name === "click" || verb.name === "waitFor") {
      await core.navigate("https://origin.test/doc");
    }
    const operation = sink.make();

    // Running the operation without capture, and reporting a bland "none", would tell the caller its
    // artifact simply was not there — indistinguishable from a page that produced no download.
    await assert.rejects(
      verb.run(core, { artifactOperation: operation }),
      (err) => err instanceof Error && !/\bundefined\b/.test(err.message),
      `${verb.name} accepted an operation on a capture-disabled session`,
    );
    assert.ok(
      sink.log.some((e) => e.startsWith(`invalidate:${operation.index}:`)),
      `the mis-supplied operation was left open (log: ${sink.log.join(",")})`,
    );
  });
}

test("a routed download becomes a real stored artifact, with the owner's metadata intact", async () => {
  // The browser boundary against the REAL runtime and store: a fake DownloadLike goes in, an actual
  // published artifact comes out, owned by exactly the identity the caller bound.
  const root = join(mkdtempSync(join(tmpdir(), "bgw-cap-")), "a");
  const runtime = new ArtifactRuntime({ enabled: true, root });
  const source = join(mkdtempSync(join(tmpdir(), "bgw-src-")), "x.pdf");
  writeFileSync(source, Buffer.from("%PDF-1.7\nreal bytes"));

  const download = {
    path: async () => source,
    async cancel() {},
    async delete() {},
  };
  const context = fakeContext({ duringGoto: (emit) => emit("download", download) });
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 2_000 });
  const owner = { scope: "consumer", consumerId: "owner-consumer" };

  const operation = runtime.createOperation({ owner, sourceHost: "origin.test" });
  stagedStores.clear();  // only THIS render's capture may identify the store retrieved from below
  const result = await core.render("https://origin.test/doc", { artifactOperation: operation });

  assert.equal(result.artifactOutcome.outcome, "available", "the routed event did not become an artifact");
  const record = result.artifactOutcome.artifact;
  assert.equal(record.consumerId, "owner-consumer", "the stored artifact lost its owner");
  assert.equal(record.bytes, Buffer.from("%PDF-1.7\nreal bytes").length);

  // And it is genuinely retrievable by that owner, once.
  const lease = await observedStore().acquire(record.id, "owner-consumer");
  assert.ok(lease, "the published artifact was not retrievable by its owner");
  assert.equal(Buffer.from(lease.base64, "base64").toString(), "%PDF-1.7\nreal bytes");
  lease.complete();
  await runtime.close();
});

test("a registerDownload that throws fails closed: disposed, invalidated, dirty, and never silently normal", async () => {
  const SENTINEL = "/private/register-secret sentinel";
  const attempted = [];
  const download = {
    path: async () => "/driver/tmp/attachment.pdf",
    async cancel() { attempted.push("cancel"); },
    async delete() { attempted.push("delete"); },
  };
  const invalidations = [];
  const refusing = {
    operationId: "op-throw",
    owner: { scope: "consumer", consumerId: "owner" },
    registerDownload() { throw new Error(SENTINEL); },
    noteMainResponseContentType() {},
    invalidate(reason) { invalidations.push(reason); },
    async seal() {
      // Models the runtime: an invalidated operation reports its closed reason.
      return invalidations.length > 0
        ? { outcome: "capture-failed", failure: invalidations[0] }
        : { outcome: "none" };
    },
  };
  const context = fakeContext({ duringGoto: (emit) => emit("download", download) });
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });

  const written = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => { written.push(String(chunk)); return realWrite(chunk, ...rest); };
  let result;
  try {
    // The refusal must not escape through the driver's event emitter either.
    result = await core.render("https://origin.test/doc", { artifactOperation: refusing });
  } finally {
    process.stderr.write = realWrite;
  }

  // The attachment is real and was lost; the driver's copy must not be left behind.
  assert.deepEqual(attempted, ["cancel", "delete"], "the refused download's driver copy was not disposed");
  assert.deepEqual(invalidations, ["download-capture-failed"], "the operation was not closed-invalidated");
  assert.equal(
    result.artifactOutcome.outcome,
    "capture-failed",
    "a refused attribution reported a normal outcome — the caller cannot tell its artifact was lost",
  );
  // The session's capture state is no longer trustworthy.
  const sink = operationFactory();
  await assert.rejects(core.render("https://origin.test/next", { artifactOperation: sink.make() }));
  // And nothing raw crossed any surface.
  const { artifactOutcome, ...rest } = result;
  for (const [surface, text] of Object.entries({ result: JSON.stringify(rest), stderr: written.join("") })) {
    assert.equal(text.includes("sentinel"), false, `${surface} leaked the refusal's raw text`);
  }
});

// ---------------------------------------------------------------------------------------------
// B2 — `registerDownload()` is an explicit SYNCHRONOUS ownership receipt (Amendment 7 §8).
//
// It returned void, so the core could not learn whether the operation had actually taken the driver
// object. It pre-set `claimed` and assumed acceptance: an operation that refused left its driver copy
// owned by nobody — never staged, never cancelled, never deleted — with the core still believing the
// generation was spoken for.
// ---------------------------------------------------------------------------------------------

/** An operation whose `registerDownload` receipt is exactly what a test dictates. */
function receiptOperation(receipt, { label = "op-receipt" } = {}) {
  const invalidations = [];
  const seen = [];
  return {
    operationId: label,
    owner: { scope: "consumer", consumerId: "owner" },
    registerDownload(download) { seen.push(download); return typeof receipt === "function" ? receipt(download) : receipt; },
    noteMainResponseContentType() {},
    invalidate(reason) { invalidations.push(reason); },
    async seal() {
      return invalidations.length > 0 ? { outcome: "capture-failed", failure: invalidations[0] } : { outcome: "none" };
    },
    get invalidations() { return invalidations; },
    get seen() { return seen; },
  };
}

test("an operation that REFUSES ownership leaves the core owning the driver copy, disposed exactly once", async () => {
  const download = disposableDownload();
  const refusing = receiptOperation(false);
  const context = fakeContext({ duringGoto: (emit) => emit("download", download) });
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });

  const result = await core.render("https://origin.test/doc", { artifactOperation: refusing });

  // The core kept ownership of what the operation would not take.
  assert.deepEqual(download.calls, ["cancel", "delete"], "an exactly-false refusal left the driver copy owned by nobody");
  assert.deepEqual(refusing.invalidations, ["download-capture-failed"], "a refused first download was misreported as a duplicate");
  assert.equal(result.artifactOutcome.outcome, "capture-failed", "a refused attribution reported a normal outcome");
  // A refusal is not a contract violation, so a CONFIRMED disposal need not dirty the core.
  await core.render("https://origin.test/next", { artifactOperation: receiptOperation(true) });
});

test("an operation that ACCEPTS ownership never has its download core-disposed", async () => {
  const download = disposableDownload();
  const accepting = receiptOperation(true);
  const context = fakeContext({ duringGoto: (emit) => emit("download", download) });
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });

  await core.render("https://origin.test/doc", { artifactOperation: accepting });

  assert.deepEqual(accepting.seen, [download], "the accepted event never reached the operation");
  assert.deepEqual(download.calls, [], "the core disposed of a download the operation had taken ownership of");
  assert.deepEqual(accepting.invalidations, [], "an accepted first event invalidated its generation");
});

for (const [label, receipt] of [
  ["undefined", undefined],
  ["null", null],
  ["a truthy non-boolean", 1],
  ["a falsy non-boolean", 0],
  ["a string", "true"],
]) {
  test(`a registerDownload returning ${label} is a contract violation: disposed AND the core turns dirty`, async () => {
    // Only EXACT booleans are receipts. A truthy non-boolean is the dangerous half: coercion would
    // read it as "owned", and the driver's copy would be left behind exactly as before.
    const download = disposableDownload();
    const malformed = receiptOperation(receipt);
    const context = fakeContext({ duringGoto: (emit) => emit("download", download) });
    const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });

    const result = await core.render("https://origin.test/doc", { artifactOperation: malformed });

    assert.deepEqual(download.calls, ["cancel", "delete"], "a malformed receipt left the driver copy owned by nobody");
    assert.equal(result.artifactOutcome.outcome, "capture-failed");
    await assert.rejects(
      core.render("https://origin.test/next", { artifactOperation: receiptOperation(true) }),
      "an operation that violated its ownership contract left the session usable",
    );
  });
}

test("a hostile re-entrant event during `claiming` is a second event: disposed, never a second claim", async () => {
  // The re-entrant emit happens INSIDE registerDownload, before the first event's receipt has been
  // returned — the window in which the generation is neither unclaimed nor claimed. It must be
  // treated as a second event, and it must not steal or void the first event's accepted ownership.
  const first = disposableDownload();
  const reentrant = disposableDownload();
  let emitAgain;
  const hostile = receiptOperation((download) => {
    if (download === first) emitAgain("download", reentrant);
    return true;
  });
  const context = fakeContext({ duringGoto: (emit) => { emitAgain = emit; emit("download", first); } });
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });

  const result = await core.render("https://origin.test/doc", { artifactOperation: hostile });

  assert.deepEqual(hostile.seen, [first], "the re-entrant event was registered as a second claim");
  assert.deepEqual(first.calls, [], "the accepted first event lost its ownership to a re-entrant one");
  assert.deepEqual(reentrant.calls, ["cancel", "delete"], "the re-entrant event was dropped rather than disposed");
  assert.deepEqual(hostile.invalidations, ["multiple-artifacts"], "a second event did not terminalize with multiple-artifacts");
  assert.equal(result.artifactOutcome.outcome, "capture-failed");
});

for (const mode of ["cancel", "delete"]) {
  test(`disposal: a SYNCHRONOUSLY throwing ${mode}() still attempts both operations and dirties the core`, async () => {
    // A synchronous throw is not a rejected promise: it escapes before any promise wrapping, so a
    // `Promise.resolve(fn()).catch(...)` never sees it and the following operation is skipped.
    const attempted = [];
    const orphan = {
      path: async () => "/driver/tmp/orphan.pdf",
      cancel() {
        attempted.push("cancel");
        if (mode === "cancel") throw new Error("driver threw synchronously");
      },
      delete() {
        attempted.push("delete");
        if (mode === "delete") throw new Error("driver threw synchronously");
      },
    };
    const context = fakeContext();
    const sink = operationFactory();
    const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });

    await core.navigate("https://origin.test/doc", { artifactOperation: sink.make() });
    context.emit("download", orphan);   // between generations: an orphan, disposed by the core
    await drain();

    assert.deepEqual(
      attempted,
      ["cancel", "delete"],
      `a synchronous ${mode}() throw skipped the other operation`,
    );
    await assert.rejects(
      core.navigate("https://origin.test/next", { artifactOperation: sink.make() }),
      `a failed disposal did not dirty the core`,
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Slice 2 — dirty / pending-disposal ordering (final security matrix B)
//
// #beginGeneration returned on `!operation` BEFORE consulting the dirty and pending-disposal state,
// so a capture-capable verb invoked without an operation kept driving a session whose download
// attribution was already known to be untrustworthy. The policy is deterministic rejection and
// session replacement — never waiting — and the rejection must land before ANY driver call.
// ---------------------------------------------------------------------------------------------

const DIRTY_MESSAGE = "artifact capture: core is dirty; session must be replaced";
const PENDING_MESSAGE = "artifact capture: unattributed download disposal pending; session must be replaced";

/** Every capture-capable verb, in both shapes the matrix distinguishes: with and without an
 *  operation. `needsPage` verbs are exercised only after a navigation has established one. */
const CAPTURE_VERBS = [
  { name: "render", needsPage: false, run: (core, capture) => core.render("https://origin.test/next", capture ?? {}) },
  { name: "navigate", needsPage: false, run: (core, capture) => core.navigate("https://origin.test/next", capture ?? {}) },
  { name: "click", needsPage: true, run: (core, capture) => core.click({ target: "e5" }, capture) },
  { name: "type", needsPage: true, run: (core, capture) => core.type({ target: "e5" }, "text", {}, capture) },
  { name: "selectOption", needsPage: true, run: (core, capture) => core.selectOption({ target: "e5" }, ["a"], capture) },
  { name: "pressKey", needsPage: true, run: (core, capture) => core.pressKey("Enter", capture) },
  { name: "waitFor", needsPage: true, run: (core, capture) => core.waitFor({ timeMs: 1 }, capture) },
];

/** Assert one verb rejects with the EXACT sanitized message and performed no browser work at all. */
async function assertRejectsWithoutBrowserWork(core, context, verb, capture, message) {
  const before = context.calls.length;
  await assert.rejects(
    verb.run(core, capture),
    (err) => {
      assert.equal(err.message, message, `${verb.name}: wrong rejection (${err.message})`);
      return true;
    },
    `${verb.name} did not fail closed`,
  );
  assert.deepEqual(
    context.calls.slice(before),
    [],
    `${verb.name} executed browser work after an unusable capture state (calls: ${context.calls.slice(before).join(",")})`,
  );
}

/** Drive an orphan download between generations: the core is dirty, and its disposal has settled. */
async function makeDirtyCore() {
  const context = fakeContext();
  const sink = operationFactory();
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });
  await core.navigate("https://origin.test/doc", { artifactOperation: sink.make() });
  context.emit("download", disposableDownload());   // belongs to no generation: unattributable
  await drain();
  return { context, sink, core };
}

/** A LATE event (after the cutoff, not an orphan) whose delete never settles: disposal is pending and
 *  the core is NOT dirty, so the two states are proven separately rather than as one lump. */
async function makePendingDisposalCore() {
  let releaseDelete;
  const deleting = new Promise((resolve) => { releaseDelete = resolve; });
  const late = { path: async () => "/driver/tmp/late.pdf", async cancel() {}, async delete() { await deleting; } };
  let emitEvent;
  const context = fakeContext({ duringGoto: (emit) => { emitEvent = emit; emit("download", disposableDownload()); } });
  let stageCalls = 0;
  const sink = operationFactory({
    stage: () => {
      const nth = ++stageCalls;
      return new Promise((resolve) => setImmediate(resolve)).then(() => { if (nth === 1) emitEvent("download", late); });
    },
  });
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });
  await core.navigate("https://origin.test/doc", { artifactOperation: sink.make() });
  await drain();
  return { context, sink, core, releaseDelete };
}

for (const supplied of [true, false]) {
  const shape = supplied ? "with an operation" : "with NO operation";

  test(`a dirty core rejects every capture-capable verb ${shape}, before any driver call`, async () => {
    const { context, sink, core } = await makeDirtyCore();
    for (const verb of CAPTURE_VERBS) {
      await assertRejectsWithoutBrowserWork(core, context, verb, supplied ? { artifactOperation: sink.make() } : undefined, DIRTY_MESSAGE);
    }
    // Dirty is irreversible: the session must be replaced, so a later attempt is refused identically.
    await assertRejectsWithoutBrowserWork(core, context, CAPTURE_VERBS[0], undefined, DIRTY_MESSAGE);
  });

  test(`a pending unattributed disposal rejects every capture-capable verb ${shape}, before any driver call`, async () => {
    const { context, sink, core, releaseDelete } = await makePendingDisposalCore();
    for (const verb of CAPTURE_VERBS) {
      await assertRejectsWithoutBrowserWork(core, context, verb, supplied ? { artifactOperation: sink.make() } : undefined, PENDING_MESSAGE);
    }
    releaseDelete();
    await drain();
    // Disposal proved successful, so the session is usable again — the policy rejects, never waits.
    await core.navigate("https://origin.test/after", { artifactOperation: sink.make() });
  });
}

test("a clean capture-enabled core still treats a verb with no operation as a genuine no-op", async () => {
  const context = fakeContext();
  const sink = operationFactory();
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });

  const rendered = await core.render("https://origin.test/doc");
  const snapshot = await core.navigate("https://origin.test/two");
  await core.click({ target: "e5" });

  assert.equal("artifactOutcome" in rendered, false, "a no-operation render reported an artifact outcome");
  assert.equal("artifactOutcome" in snapshot, false, "a no-operation navigate reported an artifact outcome");
  assert.equal(sink.operations.length, 0, "the core invented an operation of its own");
  assert.ok(context.calls.includes("goto"), "a clean no-operation verb must still run");
});

test("a capture-disabled core is a no-op without an operation and fails closed with one", async () => {
  const context = fakeContext();
  const sink = operationFactory();
  const core = coreWith(context, {});   // capture disabled

  const result = await core.render("https://origin.test/doc");
  assert.equal(context.calls.includes("on:download"), false, "a capture-disabled session installed a listener");
  assert.equal("artifactOutcome" in result, false, "a capture-disabled result carries an artifact field");

  const operation = sink.make();
  const before = context.calls.length;
  await assert.rejects(
    core.render("https://origin.test/next", { artifactOperation: operation }),
    (err) => err.message === "artifact capture: an operation was supplied to a session with capture disabled",
  );
  assert.deepEqual(context.calls.slice(before), [], "a dual-configuration mismatch ran browser work first");
  assert.ok(
    sink.log.includes("invalidate:0:artifact-config-invalid"),
    `the supplied operation was not invalidated (log: ${sink.log.join(",")})`,
  );
});

// ---------------------------------------------------------------------------------------------
// Slice 3 (core half) — a second event while the first attributed download is still hung
//
// The generation records whether its first event was CLAIMED. A second one is never handed to the
// void registerDownload() seam (where the core can learn nothing about what happened to it): the
// generation enters sealing synchronously, the operation is invalidated `multiple-artifacts` and
// disposes the download it owns, and the second is routed exclusively to core disposal. Neither
// driver object is abandoned.
// ---------------------------------------------------------------------------------------------

/** A download whose failure() never settles, so the operation cannot finish staging it. */
function hungAttributedDownload() {
  const calls = [];
  return {
    failure: () => new Promise(() => {}),
    path: async () => { calls.push("path"); return "/driver/tmp/attachment.pdf"; },
    async cancel() { calls.push("cancel"); },
    async delete() { calls.push("delete"); },
    get calls() { return calls; },
  };
}

test("a second download is routed to core disposal, never to the operation's void seam", async () => {
  const first = hungAttributedDownload();
  const second = disposableDownload();
  const context = fakeContext({ duringGoto: (emit) => { emit("download", first); emit("download", second); } });
  const sink = operationFactory();
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });
  const operation = sink.make();

  const snapshot = await core.navigate("https://origin.test/doc", { artifactOperation: operation });

  assert.deepEqual(operation.downloads, [first], "the second event was handed to the operation");
  assert.ok(
    sink.log.includes("invalidate:0:multiple-artifacts"),
    `the second event did not terminalize the generation (log: ${sink.log.join(",")})`,
  );
  assert.deepEqual(second.calls, ["cancel", "delete"], "the second driver copy was abandoned");
  assert.deepEqual(snapshot.artifactOutcome, { outcome: "capture-failed", failure: "multiple-artifacts" });
});

test("first-hung plus second event: both driver objects are disposed, through the real runtime", async () => {
  const runtime = new ArtifactRuntime({ enabled: true, root: join(mkdtempSync(join(tmpdir(), "bgw-cap-")), "a") });
  const first = hungAttributedDownload();
  const second = disposableDownload();
  const context = fakeContext({ duringGoto: (emit) => { emit("download", first); emit("download", second); } });
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });
  const operation = runtime.createOperation({ owner: { scope: "consumer", consumerId: "owner" }, sourceHost: "origin.test" });

  const snapshot = await core.navigate("https://origin.test/doc", { artifactOperation: operation });
  await drain();

  assert.deepEqual(snapshot.artifactOutcome, { outcome: "capture-failed", failure: "multiple-artifacts" });
  // Ownership is split and neither half is skipped: the operation owns the download it attributed,
  // the core owns the one that never belonged to any operation.
  assert.deepEqual(first.calls.filter((c) => c !== "path"), ["cancel", "delete"], "the attributed download was not disposed by its operation");
  assert.deepEqual(second.calls, ["cancel", "delete"], "the second download was not disposed by the core");
  assert.equal(first.calls.includes("path"), false, "the hung accessor pipeline resumed after terminalization");
  await runtime.close();
});

for (const teardown of ["close", "kill"]) {
  test(`${teardown}() during a hung accessor: the operation disposes its own download, exactly once`, async () => {
    const runtime = new ArtifactRuntime({ enabled: true, root: join(mkdtempSync(join(tmpdir(), "bgw-cap-")), "a") });
    const download = hungAttributedDownload();
    let releaseGoto;
    const gotoGate = new Promise((resolve) => { releaseGoto = resolve; });
    const context = fakeContext({ duringGoto: (emit) => emit("download", download), gotoGate });
    const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });
    const operation = runtime.createOperation({ owner: { scope: "consumer", consumerId: "owner" }, sourceHost: "origin.test" });

    const navigating = core.navigate("https://origin.test/doc", { artifactOperation: operation });
    await drain();

    // Teardown invalidates synchronously, BEFORE its first await, so it is never queued behind an
    // accessor that will never settle — and that invalidation is what starts disposal.
    const tearing = teardown === "close" ? core.close() : core.kill(50).then(() => "resolved", () => "rejected");
    await drain();
    assert.deepEqual(download.calls.filter((c) => c !== "path"), ["cancel", "delete"], "teardown left the driver's copy behind");

    releaseGoto();
    const snapshot = await navigating;
    await tearing;
    await drain();

    assert.deepEqual(snapshot.artifactOutcome, { outcome: "capture-failed", failure: "artifact-runtime-invalidated" });
    assert.deepEqual(download.calls.filter((c) => c !== "path"), ["cancel", "delete"], "disposal ran more than once");
    assert.equal(download.calls.includes("path"), false, "the abandoned accessor pipeline resumed");
    await runtime.close();
  });
}

test("an unattributed download whose disposal getter throws fails the core closed, not the emitter", async () => {
  // The same hostile boundary as the operation's cleanup, on the seam the CORE owns. This runs inside
  // the driver's event emitter, so an escaping throw would surface as an unrelated page error carrying
  // raw driver text — and the core's ledger would silently keep believing the bytes were disposed of.
  const context = fakeContext();
  const sink = operationFactory();
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });
  await core.navigate("https://origin.test/doc", { artifactOperation: sink.make() });

  const reads = [];
  const orphan = {
    path: async () => "/driver/tmp/orphan.pdf",
    get cancel() { reads.push("cancel-get"); throw new Error("/private/driver-internals SENTINEL"); },
    async delete() { reads.push("delete"); },
  };
  assert.doesNotThrow(() => context.emit("download", orphan), "a throwing disposal getter escaped the driver event handler");
  await drain();

  assert.ok(reads.includes("cancel-get"), "the disposal was never attempted");
  await assert.rejects(
    core.navigate("https://origin.test/next", { artifactOperation: sink.make() }),
    (err) => err.message === "artifact capture: core is dirty; session must be replaced" && !err.message.includes("SENTINEL"),
    "an unprovable disposal left the core usable",
  );
});

// ---------------------------------------------------------------------------------------------
// Unattributed-disposal boundary (quality gate) — the CORE-owned half of the disposal contract.
//
// Two defects, both structural rather than incidental:
//  1. the core awaited `cancel()` before invoking `delete()`, so a hung cancel meant the driver's
//     copy was never deleted and the pending record never settled — the exact shape the attributed
//     path was corrected for;
//  2. the disposal body — untrusted property reads and calls — ran synchronously BEFORE
//     `#disposalsPending` was incremented, so a hostile getter or method could re-enter a
//     capture-capable verb during a window in which the core still looked clean.
// ---------------------------------------------------------------------------------------------

/** Sleep on the real clock. The core's disposal bound is core-owned and ambient by design (like its
 *  settle guard), so a bounded terminal state can only be observed by letting that bound elapse. */
const sleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });

/** Deliver `download` as a LATE event (after the cutoff, not an orphan), so the core reaches
 *  `#discardUnattributed` WITHOUT `#captureDirty` having been set first. */
function coreWithLateEvent(download, opts = {}) {
  let emitEvent;
  const context = fakeContext({ duringGoto: (emit) => { emitEvent = emit; emit("download", disposableDownload()); } });
  let stageCalls = 0;
  const sink = operationFactory({
    stage: () => {
      const nth = ++stageCalls;
      return new Promise((resolve) => setImmediate(resolve)).then(() => { if (nth === 1) emitEvent("download", download); });
    },
  });
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: opts.captureSettleTimeoutMs ?? 100 });
  return { context, sink, core };
}

test("a hung cancel() does not prevent delete(), and the disposal reaches a BOUNDED dirty terminal state", async () => {
  const attempted = [];
  const late = {
    path: async () => "/driver/tmp/late.pdf",
    cancel() { attempted.push("cancel"); return new Promise(() => {}); },   // never settles
    async delete() { attempted.push("delete"); },
  };
  const { context, sink, core } = coreWithLateEvent(late, { captureSettleTimeoutMs: 25 });

  await core.navigate("https://origin.test/doc", { artifactOperation: sink.make() });
  await drain();

  // The whole point: `delete()` is invoked without waiting for `cancel()` to settle, because a
  // misbehaving transfer is precisely when the driver's copy must still be removed.
  assert.deepEqual(attempted, ["cancel", "delete"], "delete was not invoked while cancel was still hung");

  // While the confirmation is outstanding the session is pending, not dirty: rejected, never waited on.
  await assert.rejects(
    core.navigate("https://origin.test/next", { artifactOperation: sink.make() }),
    (err) => err.message === "artifact capture: unattributed download disposal pending; session must be replaced",
    "a successor ran while disposal was still unconfirmed",
  );

  // And that pending state is BOUNDED. Once the core's own settle bound elapses the disposal is
  // unconfirmed — so the core turns dirty and stops retaining the promise and the driver object,
  // rather than staying pending forever behind a call that will never answer.
  await sleep(120);
  const before = context.calls.length;
  await assert.rejects(
    core.navigate("https://origin.test/after", { artifactOperation: sink.make() }),
    (err) => err.message === "artifact capture: core is dirty; session must be replaced",
    "an unconfirmable disposal stayed pending forever instead of reaching a terminal dirty state",
  );
  assert.deepEqual(context.calls.slice(before), [], "the rejection ran browser work first");
  // Teardown still owns the drain and still completes promptly.
  await core.close();
});

for (const shape of ["cancel-getter", "delete-method"]) {
  for (const verb of ["render", "click"]) {
    test(`a hostile ${shape} that re-enters ${verb}() observes pending accounting and fails closed`, async () => {
      const attempted = [];
      let core, context;
      // The untrusted access can re-enter MORE THAN ONCE (a getter is read once per access), so every
      // re-entry is captured and every one of them must fail closed — not merely the last.
      const reentries = [];
      let firstReentryAt = -1;
      const reenter = () => {
        // The snapshot is taken HERE, at the exact instant of re-entry — not after the outer verb
        // returns, which is far too late to see a page the re-entrant verb opened and closed again.
        if (firstReentryAt < 0) firstReentryAt = context.calls.length;
        reentries.push((verb === "render"
          ? core.render("https://origin.test/reentrant")
          : core.click({ target: "e5" })
        ).then(() => "OPENED A SUCCESSOR", (err) => err.message));
      };
      const reads = [];
      const late = {
        path: async () => "/driver/tmp/late.pdf",
        get cancel() {
          reads.push("cancel");
          if (shape === "cancel-getter") reenter();
          return async () => { attempted.push("cancel"); };
        },
        get delete() {
          reads.push("delete");
          return () => {
            attempted.push("delete");
            if (shape === "delete-method") reenter();   // synchronous method body, before it returns
            return Promise.resolve();
          };
        },
      };
      const built = coreWithLateEvent(late);
      core = built.core;
      context = built.context;
      const { sink } = built;

      await core.navigate("https://origin.test/doc", { artifactOperation: sink.make() });
      await drain();

      assert.ok(reentries.length > 0, "the hostile access never ran");
      for (const [index, reentry] of reentries.entries()) {
        assert.equal(
          await reentry,
          "artifact capture: unattributed download disposal pending; session must be replaced",
          `re-entry ${index} did not observe the pending accounting`,
        );
      }
      // Driver work attributable to the re-entrant verb: only render opens pages, only the action
      // verbs click. Neither may appear at or after the instant of the first re-entry.
      const forbidden = verb === "render" ? "newPage" : "click";
      assert.deepEqual(
        context.calls.slice(firstReentryAt).filter((c) => c === forbidden),
        [],
        `the re-entrant ${verb} did driver work before failing closed (calls: ${context.calls.slice(firstReentryAt).join(",")})`,
      );
      // Each closed operation is READ EXACTLY ONCE and then invoked through that captured reference:
      // re-reading it hands a hostile getter a second re-entry, and lets it return a different
      // function from the one that was validated.
      assert.deepEqual(reads, ["cancel", "delete"], "a disposal property was read more than once");
      assert.deepEqual(attempted, ["cancel", "delete"], "the disposal itself was disturbed by the re-entry");
    });
  }
}

function hungDisposableDownload() {
  const calls = [];
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  return {
    path: async () => "/driver/tmp/attachment.pdf",
    cancel() { calls.push("cancel"); return held; },
    delete() { calls.push("delete"); return held; },
    get calls() { return calls; },
    release,
  };
}

test("closeActivePage(): does not wait for a transient render-owned disposal", async () => {
  const context = fakeContext();
  const sink = operationFactory();
  const late = hungDisposableDownload();
  let turns = 0;
  const core = coreWith(context, {
    captureEnabled: true,
    captureSettleTimeoutMs: 100,
    captureDrainTurn: async () => {
      turns += 1;
      if (turns === 2) context.page.emit("download", late);
      await new Promise((resolve) => setImmediate(resolve));
    },
  });
  await core.navigate("https://origin.test/drive", { artifactOperation: sink.make() });
  const render = core.render("https://origin.test/transient", { artifactOperation: sink.make() });
  await drain(3);
  const closing = core.closeActivePage();
  const result = await Promise.race([
    closing.then(() => "closed"),
    new Promise((resolve) => setTimeout(() => resolve("blocked"), 30)),
  ]);
  assert.equal(result, "closed", "active-page close waited for an unrelated transient disposal");
  late.release();
  await Promise.all([render, closing]);
});

test("closeActivePage(): drains disposal owned by the active page before closing it", async () => {
  const late = hungDisposableDownload();
  const context = fakeContext();
  const sink = operationFactory();
  let turns = 0;
  const core = coreWith(context, {
    captureEnabled: true,
    captureSettleTimeoutMs: 100,
    captureDrainTurn: async () => {
      turns += 1;
      if (turns === 2) context.page.emit("download", late);
      await new Promise((resolve) => setImmediate(resolve));
    },
  });
  const navigating = core.navigate("https://origin.test/drive", { artifactOperation: sink.make() });
  await drain(2);
  const closing = core.closeActivePage();
  await drain(2);
  assert.deepEqual(late.calls, ["cancel", "delete"], "active-page disposal was not started");
  assert.equal(context.calls.includes("close"), false, "page closed before its disposal settled");
  late.release();
  await Promise.all([navigating, closing]);
  assert.ok(context.calls.includes("close"), "active page was not closed");
});

test("render(): drains transient-page disposal after sealing and before page close", async () => {
  const late = hungDisposableDownload();
  const context = fakeContext();
  const sink = operationFactory();
  let turns = 0;
  const core = coreWith(context, {
    captureEnabled: true,
    captureSettleTimeoutMs: 100,
    captureDrainTurn: async () => {
      turns += 1;
      if (turns === 1) context.page.emit("download", late);
      await new Promise((resolve) => setImmediate(resolve));
    },
  });
  const rendering = core.render("https://origin.test/transient", { artifactOperation: sink.make() });
  await drain(3);
  assert.deepEqual(late.calls, ["cancel", "delete"], "render-owned late disposal was not started");
  assert.equal(
    context.calls.includes("close"),
    false,
    `transient page closed before its disposal settled (turns=${turns}, disposal=${late.calls.join(",")}, calls=${context.calls.join(",")})`,
  );
  late.release();
  await rendering;
  assert.ok(context.calls.includes("close"), "transient page was not closed");
});

// ---------------------------------------------------------------------------------------------
// T1 — the disposal snapshot is built AFTER the cutoff turn, on EVERY teardown path.
//
// The sibling guards below emit their late download BEFORE the teardown they are testing, so the
// record is in `#disposals` whichever side of the cutoff turn the snapshot is built on: they pass
// under both orderings and say nothing about the ordering itself. Only an event emitted DURING the
// cutoff turn distinguishes them — and that is precisely the event teardown is racing.
// ---------------------------------------------------------------------------------------------

test("close(): a download emitted DURING the cutoff turn is drained before the context closes", async () => {
  const context = fakeContext();
  const sink = operationFactory();
  const late = hungDisposableDownload();
  let turns = 0;
  const core = coreWith(context, {
    captureEnabled: true,
    captureSettleTimeoutMs: 100,
    captureDrainTurn: async () => {
      turns += 1;
      if (turns === 2) context.page.emit("download", late); // inside close()'s own cutoff turn
      await new Promise((resolve) => setImmediate(resolve));
    },
  });
  await core.navigate("https://origin.test/drive", { artifactOperation: sink.make() }); // turn 1: the nav's seal cutoff
  const closing = core.close();
  await drain(3);

  assert.deepEqual(late.calls, ["cancel", "delete"], "the cutoff-turn event was never disposed");
  assert.equal(
    context.calls.includes("context-close"),
    false,
    `the context closed while a cutoff-turn disposal was still held (calls: ${context.calls.join(",")})`,
  );
  late.release();
  await closing;
  assert.ok(context.calls.includes("context-close"), "the context never closed after its disposal settled");
});

test("render(): a download emitted DURING the transient page's cutoff turn is drained before it closes", async () => {
  const context = fakeContext();
  const sink = operationFactory();
  const late = hungDisposableDownload();
  let turns = 0;
  const core = coreWith(context, {
    captureEnabled: true,
    captureSettleTimeoutMs: 100,
    captureDrainTurn: async () => {
      turns += 1;
      if (turns === 2) context.page.emit("download", late); // inside the render's disposal cutoff turn
      await new Promise((resolve) => setImmediate(resolve));
    },
  });
  const rendering = core.render("https://origin.test/transient", { artifactOperation: sink.make() }); // turn 1: seal cutoff
  await drain(4);

  assert.deepEqual(late.calls, ["cancel", "delete"], "the cutoff-turn event was never disposed");
  assert.equal(
    context.calls.includes("close"),
    false,
    `the transient page closed while a cutoff-turn disposal was still held (turns=${turns}, calls: ${context.calls.join(",")})`,
  );
  late.release();
  await rendering;
  assert.ok(context.calls.includes("close"), "the transient page never closed after its disposal settled");
});

test("closeActivePage(): a delayed close cannot close or clear a replacement page", async () => {
  const context = fakeContext();
  const sink = operationFactory();
  let closingPhase = false;
  let closeTurns = 0;
  let releaseFirstTurn;
  const firstTurnHeld = new Promise((resolve) => { releaseFirstTurn = resolve; });
  const core = coreWith(context, {
    captureEnabled: true,
    captureSettleTimeoutMs: 100,
    captureDrainTurn: async () => {
      if (!closingPhase) { await new Promise((resolve) => setImmediate(resolve)); return; }
      closeTurns += 1;
      if (closeTurns === 1) await firstTurnHeld;
      else await new Promise((resolve) => setImmediate(resolve));
    },
  });

  await core.navigate("https://origin.test/drive", { artifactOperation: sink.make() });
  const original = context.page;
  closingPhase = true;

  const delayedClose = core.closeActivePage();
  await drain(2); // the first close is parked inside its injected cutoff turn
  await core.closeActivePage(); // a second close retires and clears the original page first
  assert.equal(original.closed, true, "the original page was not retired by the second close");

  await core.navigate("https://origin.test/replacement", { artifactOperation: sink.make() });
  const replacement = context.page;
  assert.notEqual(replacement, original, "the successor page was not created");
  assert.equal(replacement.closed, false, "the successor began closed");

  releaseFirstTurn();
  await delayedClose;
  assert.equal(replacement.closed, false, "a delayed close closed the replacement page");
  await core.snapshot(); // the delayed close must not have cleared the replacement slot either
});

test("close(): drains all owner pages after one cutoff turn", async () => {
  const context = fakeContext();
  const sink = operationFactory();
  let turns = 0;
  const core = coreWith(context, {
    captureEnabled: true,
    captureSettleTimeoutMs: 100,
    captureDrainTurn: async () => { turns += 1; await new Promise((resolve) => setImmediate(resolve)); },
  });
  await core.navigate("https://origin.test/drive", { artifactOperation: sink.make() });
  const activePage = context.page;
  const popup = context.openPopup();
  const activeLate = hungDisposableDownload();
  const popupLate = hungDisposableDownload();
  activePage.emit("download", activeLate);
  popup.emit("download", popupLate);
  turns = 0; // navigate used the same injected sealing turn; measure close independently.
  const closing = core.close();
  await drain(2);
  assert.equal(turns, 1, "graceful close did not await exactly one injected drain turn");
  assert.deepEqual(activeLate.calls, ["cancel", "delete"]);
  assert.deepEqual(popupLate.calls, ["cancel", "delete"]);
  assert.equal(context.calls.includes("context-close"), false, "context closed before all owner records settled");
  activeLate.release();
  popupLate.release();
  await closing;
  assert.ok(context.calls.includes("context-close"), "context did not close after all-owner drain");
});

// ---------------------------------------------------------------------------------------------
// The CALLABLE BOUNDARY and the CLAIM ANCHOR, on the core's own mandatory disposal path.
//
// These are the browser-core halves of the artifact runtime's cleanup invariants, and the two must
// not drift: a driver-supplied `cancel`/`delete` is a function whose every property — `call` included
// — the driver controls; classifying its return value must read `then` exactly once; and the bound
// that decides an unconfirmed disposal opens when the core CLAIMS the copy, not after the untrusted
// property reads and calls that bound exists to survive.
// ---------------------------------------------------------------------------------------------

/** The successor verb, and the exact sanitized refusal it must produce. Run while the owning verb is
 *  still parked in its own disposal drain, which is the state under test. */
async function assertSuccessorRefused(core, message, label) {
  await assert.rejects(
    core.render("https://origin.test/successor", { artifactOperation: receiptOperation(true) }),
    (err) => {
      assert.equal(err.message, message, `${label}: wrong refusal (${err.message})`);
      return true;
    },
    label,
  );
}

test("core disposal invokes a callable with a hostile `call` getter without reading it", async () => {
  const sentinel = "/driver/tmp/hostile-call sentinel";
  let callReads = 0, cancelCalls = 0, deleteCalls = 0;
  let cancelReceiver, deleteReceiver;
  const order = [];
  // A cancel that answers immediately, behind a `call` property that traps. Reading `call` to invoke
  // it hands the driver a getter it can throw from — and loses the mandatory invocation entirely.
  const cancel = function () { cancelCalls += 1; cancelReceiver = this; order.push("cancel"); };
  Object.defineProperty(cancel, "call", {
    configurable: true,
    get() { callReads += 1; throw new Error(sentinel); },
  });
  const download = {
    path: async () => "/driver/tmp/never-read.pdf",
    cancel,
    delete: function () { deleteCalls += 1; deleteReceiver = this; order.push("delete"); },
  };
  const refusing = receiptOperation(false);
  const context = fakeContext({ duringGoto: (emit) => emit("download", download) });
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: 100 });

  const result = await core.render("https://origin.test/doc", { artifactOperation: refusing });
  await drain();

  assert.equal(callReads, 0, "the core read a caller-controlled `call` property off a disposal callable");
  assert.equal(cancelCalls, 1, "the hostile property read displaced the mandatory cancel() invocation");
  assert.equal(deleteCalls, 1, "delete() was not invoked exactly once");
  assert.equal(cancelReceiver, download, "cancel() did not run against the download it came from");
  assert.equal(deleteReceiver, download, "delete() did not run against the download it came from");
  assert.deepEqual(order, ["cancel", "delete"], "the synchronous cancel-then-delete order was not preserved");
  assert.equal(result.artifactOutcome.outcome, "capture-failed", "the refused attribution reported a normal outcome");
  assert.equal(JSON.stringify(result).includes(sentinel), false, "the hostile getter's raw text escaped into the result");

  // Both mandatory operations answered, so this disposal is CONFIRMED and the session stays usable.
  await core.render("https://origin.test/next", { artifactOperation: receiptOperation(true) });
});

/** A disposal return value whose `then` is CALLABLE on its first read and non-callable afterwards.
 *  The first read's callable keeps the adopter's callbacks without ever invoking them, so a correct
 *  adoption stays pending and only the core's own claim-anchored bound can decide it. */
function statefulDisposalThenable(sink) {
  let reads = 0;
  const value = {
    get then() {
      reads += 1;
      if (reads === 1) return function (onFulfilled) { sink.settlers.push(onFulfilled); };
      // What the old adoption saw on its second read: not callable, so `Promise.resolve()` treated
      // this exact object as an ordinary value and fulfilled with it — a disposal confirmed by nobody.
      return 0;
    },
    get reads() { return reads; },
  };
  sink.values.push(value);
  return value;
}

test("a core disposal thenable whose `then` changes between reads is read once and never falsely confirmed", async (t) => {
  // Captured BEFORE the mock replaces the global: a wedged await must FAIL, not hang the runner.
  const realSetTimeout = setTimeout;
  const guarded = async (promise, label) => {
    const guard = new Promise((resolve) => { const h = realSetTimeout(() => resolve(`WEDGED:${label}`), 5_000); h.unref?.(); });
    assert.notEqual(await Promise.race([promise, guard]), `WEDGED:${label}`, `${label} never completed`);
  };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const SETTLE = 1_000;                     // virtual milliseconds: no real time passes here

  const sink = { values: [], settlers: [] };
  const calls = [];
  const download = {
    path: async () => "/driver/tmp/never-read.pdf",
    cancel() { calls.push("cancel"); return statefulDisposalThenable(sink); },
    delete() { calls.push("delete"); return statefulDisposalThenable(sink); },
  };
  const context = fakeContext({ duringGoto: (emit) => emit("download", download) });
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: SETTLE });

  const rendering = core.render("https://origin.test/doc", { artifactOperation: receiptOperation(false) });
  await drain();

  assert.deepEqual(calls, ["cancel", "delete"], "both mandatory disposal operations were not attempted");
  assert.equal(sink.values.length, 2, "each disposal call did not return its own thenable");
  assert.deepEqual(sink.values.map((v) => v.reads), [1, 1], "a disposal return value's `then` was read more than once");

  // One virtual millisecond before the claim-anchored bound: still genuinely OUTSTANDING, and the
  // core is PENDING rather than dirty — the two states proven apart, not as one lump.
  t.mock.timers.tick(SETTLE - 1);
  await drain();
  await assertSuccessorRefused(core, PENDING_MESSAGE, "an adoption nothing had confirmed was resolved before its budget expired");

  // Exactly at the bound: unconfirmed turns the session dirty.
  t.mock.timers.tick(1);
  await drain();
  await assertSuccessorRefused(core, DIRTY_MESSAGE, "a disposal nothing ever confirmed left the session usable");

  // The retained callbacks finally answer, long past the bound. Late settlement heals nothing.
  assert.equal(sink.settlers.length, 2, "the adoption never handed its callbacks to the thenable");
  for (const settle of sink.settlers) settle();
  t.mock.timers.tick(SETTLE * 4);
  await drain();
  await assertSuccessorRefused(core, DIRTY_MESSAGE, "a late settlement healed a dirty core");

  await guarded(rendering, "render-stateful-thenable");
});

test("the core's unattributed disposal bound opens at the ownership claim, not after the driver work", async (t) => {
  const realSetTimeout = setTimeout;
  const guarded = async (promise, label) => {
    const guard = new Promise((resolve) => { const h = realSetTimeout(() => resolve(`WEDGED:${label}`), 5_000); h.unref?.(); });
    assert.notEqual(await Promise.race([promise, guard]), `WEDGED:${label}`, `${label} never completed`);
  };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const SETTLE = 1_000;                     // virtual milliseconds: no real time passes here

  const calls = [];
  let cancelReceiver, deleteReceiver;
  const download = {
    path: async () => "/driver/tmp/never-read.pdf",
    // UNTRUSTED CODE INSIDE THE CLAIM. A property read is a driver call, and it can burn the whole
    // bound before it returns anything at all. A bound armed only afterwards was never armed for
    // this window — and then expires a full budget past an instant that is already gone.
    get cancel() {
      t.mock.timers.tick(SETTLE - 1);
      return function () { calls.push("cancel"); cancelReceiver = this; return new Promise(() => {}); };
    },
    delete: function () { calls.push("delete"); deleteReceiver = this; return new Promise(() => {}); },
  };
  const context = fakeContext({ duringGoto: (emit) => emit("download", download) });
  const core = coreWith(context, { captureEnabled: true, captureSettleTimeoutMs: SETTLE });

  const rendering = core.render("https://origin.test/doc", { artifactOperation: receiptOperation(false) });
  await drain();

  // Both mandatory operations were still attempted, in order, against their own receiver.
  assert.deepEqual(calls, ["cancel", "delete"], "the clock-burning getter displaced a mandatory disposal call");
  assert.equal(cancelReceiver, download, "cancel() did not run against the download it came from");
  assert.equal(deleteReceiver, download, "delete() did not run against the download it came from");

  // The driver consumed all but one millisecond of the bound. It has NOT expired yet.
  await assertSuccessorRefused(core, PENDING_MESSAGE, "the disposal bound expired before the claim-anchored instant");

  // One more millisecond — exactly one budget after the CLAIM. A bound armed after the driver work
  // is not due for another whole budget, so this is the assertion that separates the two.
  t.mock.timers.tick(1);
  await drain();
  await assertSuccessorRefused(core, DIRTY_MESSAGE, "the disposal bound was armed after the untrusted driver work, not at the claim");

  // The bound settles exactly once: a further budget changes nothing.
  t.mock.timers.tick(SETTLE * 4);
  await drain();
  await assertSuccessorRefused(core, DIRTY_MESSAGE, "a second expiry rewrote a settled disposal");

  await guarded(rendering, "render-claim-anchor");
});
