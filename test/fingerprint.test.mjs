import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import {
  FINGERPRINT_COLLECTOR_JS,
  CDP_TIMING_RAW_JS,
  flattenFingerprint,
  classifyAxis,
  diffFingerprints,
  AXIS_SEVERITY,
} from "../dist/browser/index.js";

test("FINGERPRINT_COLLECTOR_JS: a self-contained async IIFE expression", () => {
  assert.equal(typeof FINGERPRINT_COLLECTOR_JS, "string");
  assert.ok(FINGERPRINT_COLLECTOR_JS.trimStart().startsWith("(async () =>"));
  assert.ok(FINGERPRINT_COLLECTOR_JS.trimEnd().endsWith("()"));
  // No template-interpolation that would break page.evaluate(string).
  assert.ok(!FINGERPRINT_COLLECTOR_JS.includes("${"));
  // And no RAW BACKTICK anywhere, including inside a comment. These constants are TypeScript
  // template literals, so a backtick used for prose emphasis in a comment TERMINATES the string
  // and the file stops compiling — twice during this section's development, both times from a
  // comment rather than from code. `${'`'}` is not a character to spend debugging time on again.
  for (const [name, src] of [["FINGERPRINT_COLLECTOR_JS", FINGERPRINT_COLLECTOR_JS], ["CDP_TIMING_RAW_JS", CDP_TIMING_RAW_JS]]) {
    assert.ok(!src.includes("`"), `${name} must not contain a raw backtick (it would close the template literal)`);
  }
  // Touches the axes the diff classifies as high-severity tells.
  for (const probe of ["WEBGL_debug_renderer_info", "srflx", "canvasHash", "fonts", "timeZone"]) {
    assert.ok(FINGERPRINT_COLLECTOR_JS.includes(probe), `collector should reference ${probe}`);
  }
  // The canvas-text escape must reach the browser as the literal source `✨` (which the
  // page's JS engine then decodes), NOT as a raw sparkle char. Guards a tempting "cleanup"
  // of the double backslash that would change what the canvas draws.
  assert.ok(
    FINGERPRINT_COLLECTOR_JS.includes("\\u2728"),
    "collector must carry the literal escape sequence backslash-u2728",
  );
  assert.ok(!FINGERPRINT_COLLECTOR_JS.includes("✨"), "collector must not embed a raw sparkle char");
});

test("flattenFingerprint: nested objects become dot-paths; arrays stay whole leaves", () => {
  const flat = flattenFingerprint({
    platform: "Linux x86_64",
    webgl: { vendor: "Google Inc.", renderer: "SwiftShader" },
    languages: ["en-US", "en"],
    deviceMemory: null,
  });
  assert.equal(flat["platform"], "Linux x86_64");
  assert.equal(flat["webgl.vendor"], "Google Inc.");
  assert.equal(flat["webgl.renderer"], "SwiftShader");
  assert.deepEqual(flat["languages"], ["en-US", "en"]);
  assert.equal(flat["deviceMemory"], null);
  // No partially-flattened array indices.
  assert.ok(!("languages.0" in flat));
});

test("flattenFingerprint: a scalar root flattens under '.'", () => {
  assert.deepEqual(flattenFingerprint("solo"), { ".": "solo" });
  assert.deepEqual(flattenFingerprint(null), { ".": null });
});

test("classifyAxis: high / geo / info, with prefix matching", () => {
  assert.equal(classifyAxis("webgl.unmaskedRenderer"), "high");
  assert.equal(classifyAxis("webgl.renderer"), "high");
  assert.equal(classifyAxis("webrtc.udpCount"), "high");
  assert.equal(classifyAxis("fonts"), "high");
  assert.equal(classifyAxis("fontCount"), "high");
  assert.equal(classifyAxis("hardwareConcurrency"), "high");
  assert.equal(classifyAxis("timezone"), "geo");
  assert.equal(classifyAxis("languages"), "geo");
  assert.equal(classifyAxis("locale"), "geo");
  assert.equal(classifyAxis("userAgent"), "info");
  assert.equal(classifyAxis("screen.width"), "info");
  // prefix-only match: a deeper webgl path is still high.
  assert.equal(classifyAxis("webgl.vendor.extra"), "high");
  // a path that merely *contains* a keyword but isn't that axis stays info.
  assert.equal(classifyAxis("platformVersion"), "info");
});

test("diffFingerprints: identical fingerprints diff to nothing", () => {
  const fp = { platform: "MacIntel", webgl: { renderer: "Apple M2" }, languages: ["en-US"] };
  assert.deepEqual(diffFingerprints(fp, structuredClone(fp)), []);
});

test("diffFingerprints: surfaces divergence, sorted high → geo → info", () => {
  const mac = {
    userAgent: "Chrome/149 mac",
    platform: "MacIntel",
    timezone: "America/Los_Angeles",
    webgl: { renderer: "ANGLE (Apple, Apple M2)" },
  };
  const vps = {
    userAgent: "Chrome/149 linux",
    platform: "Linux x86_64",
    timezone: "UTC",
    webgl: { renderer: "Google SwiftShader" },
  };
  const diffs = diffFingerprints(mac, vps);
  const paths = diffs.map((d) => d.path);
  assert.deepEqual(paths, ["platform", "webgl.renderer", "timezone", "userAgent"]);
  assert.deepEqual(
    diffs.map((d) => d.severity),
    ["high", "high", "geo", "info"],
  );
  const renderer = diffs.find((d) => d.path === "webgl.renderer");
  assert.equal(renderer.a, "ANGLE (Apple, Apple M2)");
  assert.equal(renderer.b, "Google SwiftShader");
});

test("diffFingerprints: array equality is structural; order matters", () => {
  assert.deepEqual(diffFingerprints({ langs: ["en-US", "en"] }, { langs: ["en-US", "en"] }), []);
  const d = diffFingerprints({ langs: ["en-US", "en"] }, { langs: ["en", "en-US"] });
  assert.equal(d.length, 1);
  assert.equal(d[0].path, "langs");
});

test("diffFingerprints: a path missing on one side reads as null and diffs", () => {
  const d = diffFingerprints({ deviceMemory: 8 }, {});
  assert.equal(d.length, 1);
  assert.equal(d[0].path, "deviceMemory");
  assert.equal(d[0].a, 8);
  assert.equal(d[0].b, null);
});

test("diffFingerprints: null-vs-absent does NOT diff (both normalize to null)", () => {
  assert.deepEqual(diffFingerprints({ deviceMemory: null }, {}), []);
});

test("AXIS_SEVERITY: high and geo lists are non-empty and disjoint", () => {
  assert.ok(AXIS_SEVERITY.high.length > 0);
  assert.ok(AXIS_SEVERITY.geo.length > 0);
  const overlap = AXIS_SEVERITY.high.filter((p) => AXIS_SEVERITY.geo.includes(p));
  assert.deepEqual(overlap, []);
});

// ════ cdp probes (#100) ═════════════════════════════════════════════════════════════════════
//
// The collector is a STRING handed to page.evaluate, so asserting on its source with a regex
// would only prove that some characters are present, not that the guards actually isolate a
// failure. These tests run the real shipped string in a node:vm context with a hand-built stub
// of the browser globals it touches, so an injected throw exercises the same try/catch
// structure the browser would.
//
// WHAT THE VM CANNOT PROVE, stated plainly rather than papered over: the stubs are a JS realm,
// not Blink. A vm run can show that a probe is *guarded*, that its buckets *quantize*, and that
// its self-tests *fire* — it cannot show what any probe reads when a real CDP consumer is
// attached to a real renderer. That is the baseline ticket's job and needs a browser.

/** Minimal stubs for exactly the globals FINGERPRINT_COLLECTOR_JS / CDP_TIMING_RAW_JS touch. */
function makeSandbox(opts = {}) {
  const clockStep = opts.clockStep ?? 0.2;
  const stallMs = opts.stallMs ?? 0.3;
  const resourceCount = opts.resourceCount ?? 6;
  // Chrome does not hand a page a raw high-resolution clock: `performance.now()` is coarsened
  // (~100us in a page that is not cross-origin-isolated). `coarsenMs` reproduces that, and it is
  // the ONLY configuration in which the sub-tick-median failure mode is visible — with the
  // default fixed-step clock every paired reading differs by exactly `clockStep`, so a test using
  // it can never see a bucket that flips on clock resolution. Two runs differing only in
  // `clockPhase` are the same environment sampled a fraction of a tick apart.
  const coarsenMs = opts.coarsenMs ?? 0;
  // Cost charged by `console.debug` when the argument is an OBJECT — i.e. the instrumented
  // "rich" argument in probe C, never the plain string. Stands in for the serialize-and-ship
  // work an attached protocol consumer does, so the large-inflation branch of the ratio ladder
  // is exercised rather than assumed.
  const richCostMs = opts.richCostMs ?? 0;

  const fetched = [];
  let raw = 1_000 + (opts.clockPhase ?? 0);
  // A fixed step per read models a probe that does no work between two readings — which is what
  // the console probes do, and it is what makes the sub-tick regime deterministic. It is NOT what
  // the clock self-test does: that spins two million iterations between its two reads, and a
  // stub charging it the same 0.025ms would report "the clock is frozen" purely as an artifact of
  // the stub. So a read that follows REAL work of a millisecond or more is also charged that real
  // time. The threshold keeps the console probes on the deterministic path (a noop call never
  // costs a millisecond) while the spin, which always costs several, is modelled honestly.
  const REAL_WORK_FLOOR_MS = 1;
  let lastReal = Number(process.hrtime.bigint() / 1000n) / 1000;
  const readClock = () => {
    const nowReal = Number(process.hrtime.bigint() / 1000n) / 1000;
    const realDelta = nowReal - lastReal;
    lastReal = nowReal;
    raw += clockStep + (realDelta >= REAL_WORK_FLOOR_MS ? realDelta : 0);
    return coarsenMs ? Math.floor(raw / coarsenMs) * coarsenMs : raw;
  };
  const performance = {
    now: readClock,
    // DELIBERATELY EMPTY, and it is a regression guard. A PerformanceResourceTiming entry is
    // queued at responseEnd; a probe that awaits response HEADERS and then reads
    // getEntriesByName() finds nothing. The earlier stub returned an entry for any name, so the
    // suite was green while the shipped probe recovered rows in 0 of 24 in-container captures.
    // Returning nothing forces the by-type harvest, which is what the browser actually supports.
    getEntriesByName() {
      return [];
    },
    // The collector's passive probe reads the entries the page ALREADY produced. Several, so a
    // median and a max are both meaningful.
    getEntriesByType(type) {
      if (opts.hostileResourceTiming) throw new Error("injected: performance.getEntriesByType");
      if (type !== "resource") return [];
      // The page's own sub-resources, plus every URL the raw script has fetched so far — the
      // by-type sweep is how both probes are supposed to recover their timings.
      return [
        ...Array.from({ length: resourceCount }, (_, i) =>
          entry(`https://fixture.example/asset-${i}.js`),
        ),
        ...fetched.map((u) => entry(u)),
      ];
    },
  };
  // `stallSpread` makes the stubbed resources HETEROGENEOUS, and that is the point: with one
  // uniform stall for every entry, a stability test can only move the whole distribution at once,
  // so it can never express the case where a single tail request jitters across a bucket edge
  // while the rest of the page holds still. That case is what removed stallMaxBucket from the
  // diffed surface, and the test below could not have caught it before this parameter existed.
  const stallSpread = opts.stallSpread ?? 0;
  let entryIndex = 0;
  function entry(name) {
    const s = stallMs + (stallSpread ? stallSpread * (entryIndex++ % 2) : 0);
    return {
      name,
      startTime: 100,
      fetchStart: 100,
      domainLookupStart: 100,
      connectStart: 100,
      requestStart: 100 + s,
      responseStart: 100 + s + 5,
      responseEnd: 100 + s + 9,
    };
  }

  const noop = () => {};
  const console = {
    log: noop,
    warn: noop,
    error: noop,
    debug: opts.consoleDebugThrows
      ? () => {
          throw new Error("injected: console.debug");
        }
      : (arg) => {
          if (richCostMs && arg && typeof arg === "object") raw += richCostMs;
        },
    groupEnd: opts.consoleGroupEndThrows
      ? () => {
          throw new Error("injected: console.groupEnd");
        }
      : noop,
  };

  const canvas2d = {
    textBaseline: "",
    font: "",
    fillStyle: "",
    fillRect: noop,
    fillText: noop,
  };
  const span = { style: {}, textContent: "", offsetWidth: 100, offsetHeight: 20 };
  const document = {
    createElement(tag) {
      if (tag === "canvas") {
        return {
          width: 0,
          height: 0,
          // No WebGL in a vm; the collector already treats a null context as `webgl: null`.
          getContext: (kind) => (kind === "2d" ? canvas2d : null),
          toDataURL: () => "data:image/png;base64,QUJD",
        };
      }
      return span;
    },
    body: { appendChild: noop, removeChild: noop },
    // Bound so Function.prototype.toString reports "[native code]" — the stub stands in for a
    // native DOM method, and the collector's tamper control reads exactly that.
    querySelector: noop.bind(null),
  };

  const windowStub = { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 800, name: "" };
  const window = opts.hostileWindow
    ? new Proxy(windowStub, {
        ownKeys() {
          throw new Error("injected: Object.getOwnPropertyNames(window)");
        },
      })
    : windowStub;

  const locationStub = { origin: "https://fixture.example", href: "https://fixture.example/" };
  const location = opts.hostileLocation
    ? new Proxy(locationStub, {
        get(target, key) {
          if (key === "origin") throw new Error("injected: location.origin");
          return target[key];
        },
      })
    : locationStub;

  return {
    navigator: {
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
      appVersion: "5.0 (Windows NT 10.0; Win64; x64)",
      platform: "Win32",
      vendor: "Google Inc.",
      language: "en-US",
      languages: ["en-US", "en"],
      hardwareConcurrency: 8,
      deviceMemory: 8,
      maxTouchPoints: 0,
      webdriver: false,
      pdfViewerEnabled: true,
      userAgentData: null,
    },
    screen: {
      width: 1920,
      height: 1080,
      availWidth: 1920,
      availHeight: 1040,
      colorDepth: 24,
      pixelDepth: 24,
    },
    window,
    document,
    location,
    console,
    performance,
    matchMedia: () => ({ matches: false }),
    crypto: webcrypto,
    TextEncoder,
    // Throwing constructor: the collector's WebRTC probe is guarded, so this resolves the axis
    // to an error object immediately instead of parking the test on its 8s gather timeout.
    RTCPeerConnection: function RTCPeerConnection() {
      throw new Error("no WebRTC in vm");
    },
    // Records every fetched URL so getEntriesByType can report a matching Resource Timing row,
    // exactly as the browser does once the response completes.
    fetch: async (url) => {
      fetched.push(String(url));
      return { status: 404, body: { cancel: noop } };
    },
    setTimeout,
    clearTimeout,
  };
}

async function runInSandbox(source, opts = {}) {
  return await vm.runInNewContext(source, makeSandbox(opts));
}

/** Every cdp.* dotted path the collector emits, as flattened by flattenFingerprint. */
const CDP_PATHS = [
  "cdp.probeVersion",
  "cdp.chromeMajor",
  "cdp.budgetMs",
  "cdp.budgetExceeded",
  "cdp.sectionOk",
  "cdp.errorStack.fired",
  "cdp.errorStack.invocations",
  "cdp.consoleProxy.fired",
  "cdp.consoleProxy.invocations",
  "cdp.consoleTiming.iterations",
  "cdp.consoleTiming.getterFired",
  "cdp.consoleTiming.getterInvocations",
  "cdp.consoleTiming.ratioBucket",
  "cdp.resourceTiming.entriesBucket",
  "cdp.resourceTiming.timedBucket",
  "cdp.resourceTiming.stallMedianBucket",
  "cdp.controls.webdriver",
  "cdp.controls.cdcKeys",
  "cdp.controls.puppeteerKeys",
  "cdp.controls.playwrightKeys",
  "cdp.controls.nativeToStringIntact",
  "cdp.selfTest.getterFires",
  "cdp.selfTest.ownKeysFires",
  "cdp.selfTest.clockAdvances",
];

test("FINGERPRINT_COLLECTOR_JS: the cdp section's probe names are in the shipped source", () => {
  for (const name of [
    "errorStack",
    "consoleProxy",
    "consoleTiming",
    "resourceTiming",
    "controls",
    "selfTest",
    "ownKeys",
    "stallMedianBucket",
    "nativeToStringIntact",
    "clockAdvances",
    "probeVersion",
  ]) {
    assert.ok(FINGERPRINT_COLLECTOR_JS.includes(name), `collector should reference ${name}`);
  }
  // The raw-timing script must NOT have been folded into the snapshot collector: its per-sample
  // arrays are exactly what would make diffFingerprints churn.
  for (const rawOnly of ["wallSummary", "stallSummary", "richSummary", "durationMs"]) {
    assert.ok(
      !FINGERPRINT_COLLECTOR_JS.includes(rawOnly),
      `collector must not carry the raw-timing field ${rawOnly}`,
    );
  }
  // The snapshot collector must stay PASSIVE. scripts/fingerprint-snapshot.mjs is a read-only
  // diagnostic pointed at real, scored origins during "clears locally / blocks in prod"
  // investigations; a probe that issues requests changes the thing it is measuring and shows up
  // in the target's own logs. The active, cache-busted fetch sampler lives in CDP_TIMING_RAW_JS,
  // which only the baseline harness runs.
  // Comment lines are stripped first: the passive probe's comment legitimately discusses fetch()
  // timing, and matching prose would make this assertion fire on an explanation rather than on a
  // request.
  const codeOnly = (s) =>
    s.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  // SCOPED TO THE cdp SECTION, DELIBERATELY. An earlier version of this assertion searched the
  // WHOLE collector for `fetch(` and called the result "the snapshot collector issues no requests
  // of its own" — which is false, and falsely reassuring: the pre-existing WebRTC probe opens an
  // RTCPeerConnection against a public STUN server on every capture. Certifying the whole
  // collector as passive off a search for one function name is precisely the silent-pass failure
  // these probes exist to detect, so the claim is narrowed to the section this work added, and
  // the STUN exception is named rather than hidden.
  const cdpSection = codeOnly(FINGERPRINT_COLLECTOR_JS).split("out.cdp = await")[1] ?? "";
  assert.ok(cdpSection.length > 500, "failed to isolate the cdp section — the anchor moved");
  for (const requestPrimitive of ["fetch(", "XMLHttpRequest", "sendBeacon", "new EventSource", "new WebSocket", "RTCPeerConnection", "import("]) {
    assert.ok(
      !cdpSection.includes(requestPrimitive),
      `the cdp section must not issue requests of its own (found ${requestPrimitive})`,
    );
  }
  // And the collector as a whole is NOT passive — this pins the one exception so nobody later
  // reads the narrowed assertion above as a whole-collector guarantee.
  assert.ok(
    codeOnly(FINGERPRINT_COLLECTOR_JS).includes("RTCPeerConnection"),
    "the WebRTC probe is the collector's one deliberate network exception; if it is gone, widen the passivity claim",
  );
  assert.ok(
    codeOnly(CDP_TIMING_RAW_JS).includes("fetch("),
    "the active fetch sampler belongs in the raw script",
  );
});

test("cdp: a clean run reads clean-false, not null, and the self-tests fire", async () => {
  const out = await runInSandbox(FINGERPRINT_COLLECTOR_JS);
  const cdp = out.cdp;

  assert.equal(cdp.probeVersion, 2);
  assert.equal(cdp.sectionOk, true);
  assert.equal(cdp.budgetExceeded, false);
  assert.equal(cdp.budgetMs, 2500);
  assert.equal(cdp.chromeMajor, 151);

  // The whole point of the self-tests: they exercise the same getter / Proxy-trap / clock
  // machinery locally, where the answer MUST be true. If these were false, every "false"
  // below would mean "nothing measured" rather than "nothing detected".
  // Field-by-field, not deepEqual: these objects were built inside the vm realm, so their
  // prototype is not node's Object.prototype and assert/strict's deepEqual rejects them.
  assert.equal(cdp.selfTest.getterFires, true);
  assert.equal(cdp.selfTest.ownKeysFires, true);
  assert.equal(cdp.selfTest.clockAdvances, true);

  // Clean readings are `false` / `0`, never null — null is reserved for "this probe broke".
  assert.equal(cdp.errorStack.fired, false);
  assert.equal(cdp.errorStack.invocations, 0);
  assert.equal(cdp.consoleProxy.fired, false);
  assert.equal(cdp.consoleProxy.invocations, 0);
  assert.equal(cdp.consoleTiming.getterFired, false);
  assert.equal(cdp.consoleTiming.getterInvocations, 0);
  assert.equal(cdp.consoleTiming.iterations, 20);

  // Counts are bucketed, not raw: six sub-resources and six timed entries read as the same
  // "3to9" band a page with four or eight would, so an extra lazy image is not an environment
  // change. The stall band is the pre-dispatch window the Fetch guard would inflate.
  assert.equal(cdp.resourceTiming.entriesBucket, "3to9");
  assert.equal(cdp.resourceTiming.timedBucket, "3to9");
  assert.equal(cdp.resourceTiming.stallMedianBucket, "lt1");

  assert.equal(cdp.controls.webdriver, false);
  assert.equal(cdp.controls.cdcKeys, 0);
  assert.equal(cdp.controls.puppeteerKeys, 0);
  assert.equal(cdp.controls.playwrightKeys, 0);
  assert.equal(cdp.controls.nativeToStringIntact, true);

  // Every declared path is present and non-null on a clean run.
  const flat = flattenFingerprint(out);
  for (const path of CDP_PATHS) {
    assert.ok(path in flat, `missing cdp path ${path}`);
    assert.notEqual(flat[path], null, `${path} should not be null on a clean run`);
  }
  // And the flattened cdp surface is exactly the declared set — a new probe must be added to
  // CDP_PATHS deliberately, so it cannot slip in ungraded and untested.
  assert.deepEqual(
    Object.keys(flat).filter((p) => p.startsWith("cdp.")).sort(),
    [...CDP_PATHS].sort(),
  );
});

test("cdp: one probe throwing nulls only that probe; the rest of the capture is complete", async () => {
  const cases = [
    {
      label: "console.debug throws",
      opts: { consoleDebugThrows: true },
      // Both probes that log through console.debug lose their readings; the console.groupEnd
      // probe does not, which is why the two use different sinks.
      nulled: [
        "cdp.errorStack.fired",
        "cdp.errorStack.invocations",
        "cdp.consoleTiming.iterations",
        "cdp.consoleTiming.getterFired",
        "cdp.consoleTiming.getterInvocations",
        "cdp.consoleTiming.ratioBucket",
      ],
    },
    {
      label: "console.groupEnd throws",
      opts: { consoleGroupEndThrows: true },
      nulled: [
        "cdp.consoleProxy.fired",
        "cdp.consoleProxy.invocations",
      ],
    },
    {
      label: "performance.getEntriesByType throws",
      opts: { hostileResourceTiming: true },
      nulled: [
        "cdp.resourceTiming.entriesBucket",
        "cdp.resourceTiming.timedBucket",
        "cdp.resourceTiming.stallMedianBucket",
      ],
    },
    {
      label: "Object.getOwnPropertyNames(window) throws",
      opts: { hostileWindow: true },
      nulled: [
        "cdp.controls.webdriver",
        "cdp.controls.cdcKeys",
        "cdp.controls.puppeteerKeys",
        "cdp.controls.playwrightKeys",
        "cdp.controls.nativeToStringIntact",
      ],
    },
  ];

  for (const c of cases) {
    const out = await runInSandbox(FINGERPRINT_COLLECTOR_JS, c.opts);
    const flat = flattenFingerprint(out);
    const nulled = new Set(c.nulled);

    for (const path of c.nulled) {
      assert.equal(flat[path], null, `${c.label}: ${path} should be null`);
    }
    for (const path of CDP_PATHS) {
      if (nulled.has(path)) continue;
      assert.notEqual(flat[path], null, `${c.label}: ${path} should have survived`);
    }
    // A probe failure is a probe failure, not a section failure.
    assert.equal(out.cdp.sectionOk, true, `${c.label}: section should still be ok`);

    // ...and the pre-existing axes are untouched — the cdp section must never be able to cost
    // the capture the axes the harness was originally built for.
    assert.equal(typeof out.userAgent, "string", `${c.label}: userAgent lost`);
    assert.equal(out.platform, "Win32", `${c.label}: platform lost`);
    assert.equal(out.screen.width, 1920, `${c.label}: screen lost`);
    assert.equal(out.timezoneOffsetMin, new Date().getTimezoneOffset(), `${c.label}: tz lost`);
    assert.match(out.canvasHash, /^[0-9a-f]{64}$/, `${c.label}: canvasHash lost`);
    assert.ok(Array.isArray(out.fonts), `${c.label}: fonts lost`);
    assert.equal(typeof out.webrtc, "object", `${c.label}: webrtc lost`);
  }
});

test("cdp: differing raw timings that quantize the same produce ZERO diffs", async () => {
  // Same environment, different noise: run B's raw measurements are half again run A's and its
  // resource-timing stall is more than double. Both sit inside the same bucket band.
  //
  // Both runs are deliberately on the SAME side of the ratio ladder's resolution floor. Straddling
  // it is not "noise" — it is the difference between a measurement the clock can resolve and one
  // it cannot, and the ladder is supposed to report that as a different reading. The sub-tick
  // regime has its own test below.
  const a = await runInSandbox(FINGERPRINT_COLLECTOR_JS, { clockStep: 0.6, stallMs: 0.3 });
  const b = await runInSandbox(FINGERPRINT_COLLECTOR_JS, { clockStep: 0.9, stallMs: 0.7 });
  const churn = diffFingerprints(a, b).filter((d) => d.path.startsWith("cdp."));
  assert.deepEqual(
    churn,
    [],
    "bucketed cdp axes must not churn between two captures of an unchanged environment",
  );

  // Control, and it is load-bearing: without it, "zero diffs" would also pass if the buckets
  // were constants that ignore their input entirely.
  const c = await runInSandbox(FINGERPRINT_COLLECTOR_JS, { clockStep: 10, stallMs: 20 });
  const moved = diffFingerprints(a, c)
    .filter((d) => d.path.startsWith("cdp."))
    .map((d) => d.path)
    .sort();
  assert.deepEqual(moved, [
    "cdp.resourceTiming.stallMedianBucket",
  ]);
});

test("cdp: a COARSENED clock does not churn — the ratio reports below-resolution, stably", async () => {
  // The regression this pins. Chrome coarsens performance.now() to ~100us, and a console call the
  // browser does not have to serialize costs far less than one tick, so both medians in probe C
  // land on 0 or on a single tick depending on nothing but sampling phase. The earlier ladder
  // special-cased a zero denominator into two DIFFERENT labels ('flat' when the numerator was
  // also zero, 'unbounded' when it was not), which meant one unchanged environment reported a
  // different value on consecutive captures — and, worse, handed the three-way baseline a fake
  // A-vs-C separation built entirely out of that discontinuity, letting a probe suite that
  // measures nothing certify itself as validated.
  //
  // Same environment, sampled at four sub-tick phases. Every cdp axis must be identical.
  //
  // These numbers are not arbitrary and must not be "tidied": a 0.025ms step against a 0.1ms tick
  // means probe C's four clock reads advance exactly one tick per iteration, so which of the rich
  // and plain pairs straddles a tick boundary is decided purely by the starting phase. Under the
  // OLD ladder these four phases produced THREE different labels — flat (both medians 0),
  // lt1_5x (rich 0, plain 0.1) and unbounded (rich 0.1, plain 0) — from one unchanged
  // environment. Verified by direct computation before this test was written; a step of 0.02
  // yields 'flat' at every phase and would have made this test decorative.
  const runs = [];
  for (const clockPhase of [0, 0.025, 0.05, 0.075]) {
    runs.push(await runInSandbox(FINGERPRINT_COLLECTOR_JS, { clockStep: 0.025, coarsenMs: 0.1, clockPhase }));
  }
  for (let i = 1; i < runs.length; i++) {
    const churn = diffFingerprints(runs[0], runs[i]).filter((d) => d.path.startsWith("cdp."));
    assert.deepEqual(churn, [], `phase ${i}: a sub-tick sampling difference must not diff`);
  }
  // And it must be reporting the honest reading rather than accidentally agreeing on a number:
  // below the floor there is no ratio to report, only "the clock cannot resolve this".
  for (const r of runs) assert.equal(r.cdp.consoleTiming.ratioBucket, "below-resolution");
});

test("cdp: the floor does NOT swallow a genuine large inflation", async () => {
  // The counterweight to the test above, and the reason the floor is a floor rather than a mute
  // switch: if an attached consumer really does pay tens of milliseconds to serialize the
  // instrumented argument, that is the signal this probe exists to catch. A 40ms cost against a
  // sub-tick plain call must still reach the top of the ladder on the SAME coarsened clock.
  const hot = await runInSandbox(FINGERPRINT_COLLECTOR_JS, {
    clockStep: 0.02, coarsenMs: 0.1, richCostMs: 40,
  });
  // The ratio is the only console-timing leaf left in the diffed surface — the raw rich/plain
  // buckets were removed for the edge-crossing churn documented on the shape above, so the floor
  // behaviour is asserted where it now lives.
  assert.equal(hot.cdp.consoleTiming.ratioBucket, "ge32x");
});

test("cdp: one tail request jittering across a bucket edge does NOT diff the snapshot", async () => {
  // The regression the second review round produced, reproduced as a test rather than trusted.
  // A MAXIMUM is decided by one request, so an outlier moving 3.9ms -> 4.1ms crossed the STALL
  // ladder's 4ms edge and flipped stallMaxBucket while the median, the counts and every other
  // cdp.* leaf held still — an unchanged page reporting an environment change on the strength of
  // one jittery request. stallMaxBucket is gone from the diffed surface; this pins that it stays
  // gone, and that what remains is robust to the same perturbation.
  const a = await runInSandbox(FINGERPRINT_COLLECTOR_JS, { stallMs: 0.3, stallSpread: 3.6 });
  const b = await runInSandbox(FINGERPRINT_COLLECTOR_JS, { stallMs: 0.3, stallSpread: 3.8 });
  const churn = diffFingerprints(a, b).filter((d) => d.path.startsWith("cdp."));
  assert.deepEqual(churn, [], "a single tail request crossing an edge must not diff the snapshot");

  // ...and the control: the leaf that used to carry this is genuinely absent, not merely equal.
  const flat = flattenFingerprint(a);
  assert.ok(!("cdp.resourceTiming.stallMaxBucket" in flat), "stallMaxBucket must not be back");
  assert.ok(!("cdp.consoleTiming.richMedianBucket" in flat), "richMedianBucket must not be back");
  assert.ok(!("cdp.consoleTiming.plainMedianBucket" in flat), "plainMedianBucket must not be back");
  assert.ok(!("cdp.errorStack.consoleBucket" in flat), "errorStack.consoleBucket must not be back");
  assert.ok(!("cdp.consoleProxy.consoleBucket" in flat), "consoleProxy.consoleBucket must not be back");
});

test("cdp: a throwing performance.now costs the section, never the capture", async () => {
  // The section's own try opens AFTER its setup. A page can install a throwing function under
  // performance.now — the typeof guard proves it exists, not that calling it is safe — and the
  // resulting rejection would propagate out of the awaited section IIFE, through the outer
  // collector IIFE, and lose EVERY axis: userAgent, webgl, canvasHash, fonts, webrtc. The cdp
  // section is an addition to this collector and must never be able to cost it its original job.
  const sandbox = makeSandbox();
  sandbox.performance = {
    now() {
      throw new Error("injected: performance.now");
    },
    getEntriesByName: () => [],
    getEntriesByType: () => [],
  };
  const out = await vm.runInNewContext(FINGERPRINT_COLLECTOR_JS, sandbox);

  // Every pre-existing axis survives, which is the whole point.
  assert.equal(typeof out.userAgent, "string");
  assert.equal(out.platform, "Win32");
  assert.equal(out.screen.width, 1920);
  assert.match(out.canvasHash, /^[0-9a-f]{64}$/);
  assert.ok(Array.isArray(out.fonts));
  assert.equal(typeof out.webrtc, "object");

  // The section degrades rather than disappearing, and the wall-clock fallback is live: the clock
  // self-test still reads true because now() fell through to Date.now() instead of propagating.
  // If this ever reads false the fallback was removed and every bucket below is meaningless.
  assert.equal(out.cdp.selfTest.clockAdvances, true);
  assert.equal(out.cdp.sectionOk, true);
  assert.equal(out.cdp.probeVersion, 2);
});

test("classifyAxis: every cdp.* path is info — #100 measures, it does not grade", async () => {
  const out = await runInSandbox(FINGERPRINT_COLLECTOR_JS);
  const paths = Object.keys(flattenFingerprint(out)).filter((p) => p.startsWith("cdp."));
  assert.ok(paths.length >= 20, `expected the full cdp surface, saw ${paths.length}`);
  for (const p of paths) assert.equal(classifyAxis(p), "info", `${p} should be ungraded`);
  assert.equal(classifyAxis("cdp"), "info");
  for (const p of [...AXIS_SEVERITY.high, ...AXIS_SEVERITY.geo]) {
    assert.ok(!p.startsWith("cdp"), `AXIS_SEVERITY must not grade ${p} until a baseline exists`);
  }
});

test("CDP_TIMING_RAW_JS: a separate, snapshot-excluded IIFE returning raw samples", async () => {
  assert.equal(typeof CDP_TIMING_RAW_JS, "string");
  assert.ok(CDP_TIMING_RAW_JS.trimStart().startsWith("(async () =>"));
  assert.ok(CDP_TIMING_RAW_JS.trimEnd().endsWith("()"));
  assert.ok(!CDP_TIMING_RAW_JS.includes("${"));

  const r = await runInSandbox(CDP_TIMING_RAW_JS, { clockStep: 0.2, stallMs: 0.3 });
  assert.equal(r.probeVersion, 1);
  assert.equal(r.chromeMajor, 151);
  assert.equal(r.origin, "https://fixture.example");
  assert.equal(r.budgetExceeded, false);
  assert.equal(typeof r.durationMs, "number");

  // Raw per-sample arrays at the fixed iteration counts — the numbers the bucket ladders were
  // supposed to be derived from, which is why they live here and not in the snapshot.
  assert.equal(r.errorStack.wallMs.length, 50);
  assert.equal(r.consoleProxy.wallMs.length, 50);
  assert.equal(r.consoleTiming.richMs.length, 50);
  assert.equal(r.consoleTiming.plainMs.length, 50);
  assert.equal(r.fetchProbe.planned, 20);
  assert.equal(r.fetchProbe.ok, 20);
  assert.equal(r.fetchProbe.wallMs.length, 20);
  assert.equal(r.fetchProbe.stallMs.length, 20);
  // `timed` is the count of samples matched back to a Resource Timing entry, and it is the leaf
  // that makes a missed harvest legible: `ok > 0` with `timed === 0` is "we fetched but recovered
  // no timings", which is exactly what the shipped probe did in-container before the harvest moved
  // after the loop. The stub's getEntriesByName returns nothing, so this can only pass via the
  // by-type sweep.
  assert.equal(r.fetchProbe.timed, 20);
  assert.equal(r.fetchProbe.reused.every((x) => x === true), true);

  for (const s of [r.errorStack.summary, r.consoleTiming.richSummary, r.fetchProbe.stallSummary]) {
    for (const k of ["n", "min", "p50", "p90", "max", "mean", "stdev"]) {
      assert.ok(k in s, `summary missing ${k}`);
      assert.equal(typeof s[k], "number");
    }
  }
  // The stub's stall is a float subtraction, so compare with a tolerance rather than baking a
  // binary-floating-point artifact into the expectation.
  assert.ok(Math.abs(r.fetchProbe.stallSummary.p50 - 0.3) < 1e-9);
  assert.ok(r.fetchProbe.stallSummary.stdev < 1e-9);

  // Every probe reports its own error slot rather than throwing, and none of them errored here.
  for (const k of ["errorStack", "consoleProxy", "consoleTiming", "fetchProbe", "controls", "selfTest"]) {
    assert.equal(r[k].error, null, `${k} should not have errored`);
  }
  assert.equal(r.selfTest.getterFires, true);
  assert.equal(r.selfTest.ownKeysFires, true);
  assert.equal(r.selfTest.clockAdvances, true);
});

test("CDP_TIMING_RAW_JS: a broken probe leaves an error string and the rest of the report", async () => {
  const r = await runInSandbox(CDP_TIMING_RAW_JS, { consoleDebugThrows: true });
  assert.match(r.errorStack.error, /injected: console\.debug/);
  assert.match(r.consoleTiming.error, /injected: console\.debug/);
  assert.equal(r.consoleProxy.error, null);
  assert.equal(r.consoleProxy.wallMs.length, 50);
  assert.equal(r.fetchProbe.error, null);
  assert.equal(r.fetchProbe.ok, 20);
  assert.equal(r.controls.error, null);
  assert.equal(r.selfTest.error, null);
});
