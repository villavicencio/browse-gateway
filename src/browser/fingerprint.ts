/**
 * Fingerprint-parity harness — the diagnostic that turns "Mac clears / VPS blocks" from a
 * multi-hour spike into a measured diff.
 *
 * Anti-bot scorers sum the divergences between the running browser and a clean residential
 * desktop. We learned this the hard way with the WebRTC leak: the fix was found by manually
 * diffing ICE candidates between the two hosts. This module generalizes that diff across
 * every cheap-to-read fingerprint axis (WebGL/GPU, timezone, locale, fonts, canvas, WebRTC,
 * navigator, screen) so the divergence is visible, not guessed.
 *
 * Split, like launch-options, into:
 *   - `FINGERPRINT_COLLECTOR_JS` + `collectFingerprint(page)` — needs a live browser; run via
 *     the snapshot script in-container and on the Mac.
 *   - `flattenFingerprint` / `classifyAxis` / `diffFingerprints` — pure, unit-tested, no browser.
 *   - `CDP_TIMING_RAW_JS` — a second, snapshot-EXCLUDED browser script that reports the raw
 *     per-sample timings behind the collector's quantized `cdp.*` buckets. Separate because a
 *     snapshot must diff cleanly and a threshold must be derived from real numbers, and one
 *     string cannot do both.
 *
 * The `cdp.*` axes ask a different question from the rest: not "does this browser look like a
 * desktop" but "can the page tell a debugging protocol is attached to it". Our own core keeps a
 * browser-level CDP session open for the Fetch guard, so that is a claim about our stack worth
 * measuring rather than assuming.
 */

/** A captured fingerprint snapshot: run metadata + the raw signal bag from the browser. */
export interface FingerprintSnapshot {
  meta: {
    label: string;
    capturedAt: string;
    channel: string;
    proxied: boolean;
    egressIp: string | null;
    chromeUA: string | null;
  };
  fingerprint: Record<string, unknown>;
}

/** Divergence severity: `high` = likely datacenter/headless/automation tell; `geo` = must
 *  align with the proxy exit (timezone/locale); `info` = reported but not pre-judged. */
export type AxisSeverity = "high" | "geo" | "info";

export interface FingerprintDiff {
  path: string;
  a: unknown;
  b: unknown;
  severity: AxisSeverity;
}

/**
 * Browser-side collector. A self-contained async IIFE expression (no template interpolation,
 * no external bindings) so it can be handed straight to `page.evaluate(string)`. Runs on a
 * secure origin (https) so `crypto.subtle` is available for the canvas hash.
 */
export const FINGERPRINT_COLLECTOR_JS = `(async () => {
  const out = {};
  const nav = navigator;

  out.userAgent = nav.userAgent;
  out.appVersion = nav.appVersion;
  out.platform = nav.platform;
  out.vendor = nav.vendor;
  out.language = nav.language;
  out.languages = nav.languages ? Array.from(nav.languages) : null;
  out.hardwareConcurrency = (typeof nav.hardwareConcurrency === 'number') ? nav.hardwareConcurrency : null;
  out.deviceMemory = (typeof nav.deviceMemory === 'number') ? nav.deviceMemory : null;
  out.maxTouchPoints = (typeof nav.maxTouchPoints === 'number') ? nav.maxTouchPoints : null;
  out.webdriver = (typeof nav.webdriver === 'boolean') ? nav.webdriver : null;
  out.pdfViewerEnabled = (typeof nav.pdfViewerEnabled === 'boolean') ? nav.pdfViewerEnabled : null;

  out.uaData = nav.userAgentData ? {
    mobile: nav.userAgentData.mobile,
    platform: nav.userAgentData.platform,
    brands: (nav.userAgentData.brands || []).map(function (x) { return x.brand + ';' + x.version; }),
  } : null;

  try {
    const dtf = Intl.DateTimeFormat().resolvedOptions();
    out.timezone = dtf.timeZone || null;
    out.locale = dtf.locale || null;
  } catch (e) { out.timezone = null; out.locale = null; }
  out.timezoneOffsetMin = new Date().getTimezoneOffset();

  out.screen = {
    width: screen.width, height: screen.height,
    availWidth: screen.availWidth, availHeight: screen.availHeight,
    colorDepth: screen.colorDepth, pixelDepth: screen.pixelDepth,
    devicePixelRatio: window.devicePixelRatio,
  };

  try {
    out.prefersColorScheme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    out.prefersReducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) { /* matchMedia unavailable */ }

  // WebGL renderer — the strongest datacenter/headless tell under Xvfb (software GL =
  // "SwiftShader"/"llvmpipe" vs a desktop's real "ANGLE (Apple/NVIDIA ...)").
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (gl) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      out.webgl = {
        vendor: gl.getParameter(gl.VENDOR),
        renderer: gl.getParameter(gl.RENDERER),
        unmaskedVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
        unmaskedRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
        version: gl.getParameter(gl.VERSION),
        shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
        maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      };
    } else {
      out.webgl = null;
    }
  } catch (e) { out.webgl = { error: String(e) }; }

  // Canvas 2D hash — platform anti-aliasing + font rendering divergence rolls up here.
  try {
    const c = document.createElement('canvas');
    c.width = 240; c.height = 60;
    const ctx = c.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.font = "14px 'Arial'";
    ctx.fillStyle = '#f60'; ctx.fillRect(125, 1, 62, 20);
    ctx.fillStyle = '#069'; ctx.fillText('browse-gateway \\u2728 fp', 2, 15);
    ctx.fillStyle = 'rgba(102,204,0,0.7)'; ctx.fillText('browse-gateway \\u2728 fp', 4, 17);
    const data = c.toDataURL();
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
    out.canvasHash = Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  } catch (e) { out.canvasHash = 'err:' + String(e); }

  // Font-presence probe — a sparse server font set vs a rich desktop set is a tell.
  try {
    const probe = ['Arial','Helvetica','Times New Roman','Courier New','Georgia','Verdana',
      'Comic Sans MS','Calibri','Cambria','Segoe UI','Tahoma','Trebuchet MS',
      'Roboto','Ubuntu','DejaVu Sans','Liberation Sans','Noto Sans','Cantarell'];
    const base = ['monospace','serif','sans-serif'];
    const text = 'mmmmmmmmmmlli';
    const span = document.createElement('span');
    span.style.position = 'absolute'; span.style.left = '-9999px';
    span.style.fontSize = '72px'; span.textContent = text;
    document.body.appendChild(span);
    const baseDim = {};
    for (let i = 0; i < base.length; i++) {
      span.style.fontFamily = base[i];
      baseDim[base[i]] = { w: span.offsetWidth, h: span.offsetHeight };
    }
    const present = [];
    for (let i = 0; i < probe.length; i++) {
      let detected = false;
      for (let j = 0; j < base.length; j++) {
        span.style.fontFamily = "'" + probe[i] + "'," + base[j];
        if (span.offsetWidth !== baseDim[base[j]].w || span.offsetHeight !== baseDim[base[j]].h) { detected = true; break; }
      }
      if (detected) present.push(probe[i]);
    }
    document.body.removeChild(span);
    out.fonts = present;
    out.fontCount = present.length;
  } catch (e) { out.fonts = null; out.fontCount = null; }

  // WebRTC ICE — a 'typ srflx' candidate is STUN over plain UDP leaking the host IP past
  // the proxy. udpCount > 0 at all means non-proxied UDP escaped (policy missing/ignored).
  try {
    out.webrtc = await new Promise(function (resolve) {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      const cands = [];
      let done = false;
      function finish() {
        if (done) return; done = true;
        try { pc.close(); } catch (e) {}
        const srflx = cands.filter(function (c) { return c.indexOf('typ srflx') >= 0; });
        const udp = cands.filter(function (c) { return / udp /i.test(c); });
        resolve({ total: cands.length, udpCount: udp.length, srflxCount: srflx.length, srflx: srflx });
      }
      pc.createDataChannel('fp');
      pc.onicecandidate = function (e) { if (e.candidate && e.candidate.candidate) cands.push(e.candidate.candidate); };
      pc.onicegatheringstatechange = function () { if (pc.iceGatheringState === 'complete') finish(); };
      pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }).catch(function () { finish(); });
      setTimeout(finish, 8000);
    });
  } catch (e) { out.webrtc = { error: String(e) }; }

  // ══ cdp — protocol-presence probes (issue #100) ══════════════════════════════════════════
  //
  // WHAT THIS ASKS: can the page see that a debugging protocol consumer is attached? Our own
  // core opens a browser-level CDP session for the Fetch guard (patchright-core
  // #installFetchGuard: Fetch.enable urlPattern "*" + Target.setAutoAttach), so "the driver
  // hides the automation surface" is a vendor claim we have never measured with our own
  // instrument. This section is that instrument.
  //
  // MEASUREMENT ONLY. There is deliberately NO AXIS_SEVERITY entry for any cdp.* path — see
  // the note above AXIS_SEVERITY. Grading these numbers before anyone has captured a baseline
  // would bake in the author's expectation, which is the exact failure the ticket split is
  // there to prevent. Do not "fix" the omission.
  //
  // EVERY LEAF IS DISCRETE — boolean, integer, or a quantized bucket label. diffFingerprints
  // compares by JSON equality per flattened dot-path, so a raw millisecond float would report
  // clock jitter as environmental divergence on every single capture and drown the real axes
  // in noise. Raw per-sample numbers, which the threshold work genuinely needs, live in the
  // separate CDP_TIMING_RAW_JS script below and never enter a snapshot.
  //
  // ASSIGN-AT-END: each probe computes into locals and writes its cdp.* leaves only after the
  // last measurement succeeds. A probe that throws halfway therefore leaves ALL of its leaves
  // null rather than a half-written mix, so "null" reads unambiguously as "this probe produced
  // nothing" and never as "this probe measured a clean zero".
  //
  // FAMILIES DELIBERATELY DROPPED, so a later reader does not re-add them as oversights:
  //   - Object.prototype-setter reentry during value-mirror, and the bound-function getter
  //     bypass of the 2025 stack guard: both fixed upstream in V8 during 2026 and dead on any
  //     Chrome this gateway ships. They would add booleans that are guaranteed false for
  //     reasons that have nothing to do with our stack.
  //   - debugger-statement timing: it detects a consumer that enabled the Debugger domain AND
  //     pauses. We enable Fetch and Target and never Debugger, so it would measure a
  //     configuration we do not run.
  //   - Source-map fetch and DevTools window-geometry deltas: both are front-end tells, and a
  //     headless protocol client renders no front end.
  //   - Anything needing MAIN-WORLD execution. page.evaluate runs in an ISOLATED world, which
  //     shares the DOM but not page window globals. A main-world-only probe would have to be
  //     smuggled in via addScriptTag; none of the probes below need it, and one that did would
  //     be a different ticket rather than a hidden injection here.
  out.cdp = await (async function () {
    // Section wall-clock cap, retained as a declared leaf so a reader can see what this section
    // is allowed to cost. Nothing can now exceed it: every remaining probe is fixed-iteration and
    // PASSIVE. The one network-bound probe — cache-busted sub-resource fetches — was moved out to
    // CDP_TIMING_RAW_JS, because leaving it here made scripts/fingerprint-snapshot.mjs generate
    // traffic against whatever origin it was pointed at, and that harness is pointed at real,
    // scored origins during "clears locally / blocks in prod" investigations. A diagnostic that
    // changes the thing it is diagnosing is not a diagnostic.
    const CDP_BUDGET_MS = 2500;
    const CONSOLE_ITERATIONS = 20;

    // Ladders step by ~4x, not by fractions of a millisecond. Two captures of an UNCHANGED
    // environment must land in the same bucket, and ordinary browser timing noise (clock
    // coarsening, a GC pause, Xvfb scheduling, a busy host) moves a small measurement by tens
    // of percent — comfortably inside a 4x band. A tighter ladder would report "the environment
    // changed" every time the machine was busy, which is the churn the acceptance criteria ban.
    const CONSOLE_EDGES = [1, 4, 16, 64, 256];
    const STALL_EDGES = [1, 4, 16, 64, 256];
    // Counts are bucketed for the same reason the timings are: a page's exact sub-resource count
    // moves with an ad slot or a lazy image and would otherwise diff as an environment change.
    const COUNT_EDGES = [1, 3, 9, 33];

    const cdp = {
      probeVersion: 2,
      chromeMajor: null,
      budgetMs: CDP_BUDGET_MS,
      // Retained as a stable leaf (dropping it would be a schema change mid-baseline) and, by
      // construction, always false: the only probe that could overrun the cap now lives in
      // CDP_TIMING_RAW_JS. If this ever reads true the section grew something unbounded.
      budgetExceeded: false,
      sectionOk: true,
      errorStack: { fired: null, invocations: null, consoleBucket: null },
      consoleProxy: { fired: null, invocations: null, consoleBucket: null },
      consoleTiming: {
        iterations: null, getterFired: null, getterInvocations: null,
        richMedianBucket: null, plainMedianBucket: null, ratioBucket: null,
      },
      resourceTiming: {
        entriesBucket: null, timedBucket: null,
        stallMedianBucket: null, stallMaxBucket: null,
      },
      controls: {
        webdriver: null, cdcKeys: null, puppeteerKeys: null, playwrightKeys: null,
        nativeToStringIntact: null,
      },
      selfTest: { getterFires: null, ownKeysFires: null, clockAdvances: null },
    };

    // Non-throwing by construction. A typeof check proves performance.now EXISTS; it does not
    // prove that CALLING it is safe, and a page can install a throwing function or accessor under
    // that name. This call sits outside the section's own try, so a throw here would reject the
    // section IIFE, propagate through the await in the outer collector IIFE, and take the ENTIRE
    // capture down with it — userAgent, webgl, canvasHash, fonts, webrtc, every pre-existing axis.
    // The cdp section is an addition to this collector; it must never be able to cost the
    // collector its original job.
    const now = function () {
      try {
        if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
          const t = performance.now();
          if (typeof t === 'number' && isFinite(t)) return t;
        }
      } catch (e) { /* fall through to the wall clock */ }
      try { return Date.now(); } catch (e) { return 0; }
    };
    const cdpT0 = now();

    function bucketize(ms, edges) {
      if (typeof ms !== 'number' || !isFinite(ms)) return null;
      if (ms < 0) return 'neg';
      for (let i = 0; i < edges.length; i++) {
        if (ms < edges[i]) return (i === 0) ? ('lt' + edges[0]) : (edges[i - 1] + 'to' + edges[i]);
      }
      return 'ge' + edges[edges.length - 1];
    }
    function countBucket(n) {
      if (typeof n !== 'number' || !isFinite(n) || n < 0) return null;
      return bucketize(n, COUNT_EDGES);
    }
    // Ratio of two medians, quantized. Absolute console timings are machine-dependent; the
    // instrumented-vs-plain RATIO is the part that could survive a host change, so it gets its
    // own unitless ladder rather than being derived downstream from two bucket labels.
    //
    // THE FLOOR IS LOAD-BEARING. Chrome coarsens performance.now() to ~100us in a page that is
    // not cross-origin-isolated, and a console call the browser does not have to serialize costs
    // far less than one tick. Both medians therefore land on 0 or on a single tick essentially at
    // random. A naive "denominator <= 0" special case turns that coin flip into two DIFFERENT
    // labels for one unchanged environment — churn that diffFingerprints reports as divergence on
    // every capture, and, worse, a manufactured A-vs-C separation for the baseline that consumes
    // these labels, which would let a suite that measures nothing certify itself.
    //
    // So: below the floor there is no ratio to report, only "the clock cannot resolve this" —
    // one stable label. The genuine large-inflation signal is NOT thrown away with it: a
    // numerator well clear of the floor over an unresolvable denominator is a real ratio of at
    // least RATIO_CLEAR_X, and lands in the top bucket. The ambiguous middle — numerator barely
    // above the floor, denominator below it — reports below-resolution rather than inventing a
    // separation out of one clock tick.
    const RATIO_FLOOR_MS = 0.5;
    const RATIO_CLEAR_X = 32;
    function ratioBucket(a, b) {
      if (typeof a !== 'number' || typeof b !== 'number' || !isFinite(a) || !isFinite(b)) return null;
      if (a < 0 || b < 0) return null;
      if (b < RATIO_FLOOR_MS) {
        return (a >= RATIO_FLOOR_MS * RATIO_CLEAR_X) ? 'ge32x' : 'below-resolution';
      }
      const r = a / b;
      if (r < 1.5) return 'lt1_5x';
      if (r < 3) return '1_5to3x';
      if (r < 8) return '3to8x';
      if (r < 32) return '8to32x';
      return 'ge32x';
    }
    function median(xs) {
      const v = xs.filter(function (x) { return typeof x === 'number' && isFinite(x); })
        .sort(function (p, q) { return p - q; });
      if (!v.length) return null;
      const m = Math.floor(v.length / 2);
      return (v.length % 2) ? v[m] : (v[m - 1] + v[m]) / 2;
    }

    try {
      // Chrome major, parsed without a regex: every backslash in this file would have to be
      // doubled to survive the template literal, and a silently-eaten one turns a regex literal
      // into a syntax error that costs the WHOLE capture. String scanning has no escapes.
      // Recorded because the live probes in this family have finite lifetimes — each one is a
      // V8 bug that gets fixed — so a reading is only interpretable next to a browser version.
      try {
        const ua = (nav && typeof nav.userAgent === 'string') ? nav.userAgent : '';
        const at = ua.indexOf('Chrome/');
        if (at >= 0) {
          const tail = ua.slice(at + 7);
          const dot = tail.indexOf('.');
          const n = parseInt(dot > 0 ? tail.slice(0, dot) : tail, 10);
          cdp.chromeMajor = isFinite(n) ? n : null;
        }
      } catch (e) { /* leaf stays null */ }

      // ── Probe A: Error.stack getter side channel ──────────────────────────────────────────
      // The textbook CDP probe: with Runtime.enable active, logging an Error made V8 eagerly
      // build a preview and read .stack through whatever accessor the page installed. V8
      // closed that in 2025 by skipping getters whose script is not native, so on a current
      // Chrome this is expected to read fired=false EVEN WITH a consumer attached. It is
      // kept as a KNOWN-DEAD NEGATIVE CONTROL, not as a live detector: a suite that reports
      // this one as clean has demonstrated nothing about the protocol, and the reference
      // implementations still shipping it as "the runtime-enable leak" are testing a corpse.
      try {
        let hits = 0;
        const err = new Error('bgw-cdp-probe');
        Object.defineProperty(err, 'stack', {
          configurable: false,
          enumerable: false,
          get: function () { hits++; return ''; },
        });
        const t0 = now();
        console.debug(err);
        const t1 = now();
        const b = bucketize(t1 - t0, CONSOLE_EDGES);
        cdp.errorStack.fired = hits > 0;
        cdp.errorStack.invocations = hits;
        cdp.errorStack.consoleBucket = b;
      } catch (e) { /* leaves stay null */ }

      // ── Probe B: prototype-chain Proxy ownKeys trap ───────────────────────────────────────
      // The one construction in this family reported live on a 2026 Chrome. The logged object
      // is an ordinary object, so V8's surface-level "is this a Proxy?" checks pass; its
      // PROTOTYPE is the Proxy, and the preview walk climbed the chain and enumerated it,
      // firing the page's ownKeys trap. Uses console.groupEnd rather than console.debug on
      // purpose: it is a different console sink, so a divergence between probe A and B tells us
      // whether serialization is sink-specific, and it gives the isolation test two independent
      // failure injection points instead of one shared dependency.
      // EXPIRY: this is a V8 bug with an upstream fix already landed. When it stops firing, that
      // is a Chrome update, NOT a stealth improvement — hence chromeMajor above.
      try {
        let hits = 0;
        const trap = new Proxy({}, { ownKeys: function () { hits++; return []; } });
        const carrier = Object.create(trap);
        const t0 = now();
        console.groupEnd(carrier);
        const t1 = now();
        const b = bucketize(t1 - t0, CONSOLE_EDGES);
        cdp.consoleProxy.fired = hits > 0;
        cdp.consoleProxy.invocations = hits;
        cdp.consoleProxy.consoleBucket = b;
      } catch (e) { /* leaves stay null */ }

      // ── Probe C: console-method timing under an instrumented argument ─────────────────────
      // Cost, not a callback: even when V8 refuses to invoke page getters, an attached consumer
      // still pays to serialize a preview and ship a Runtime.consoleAPICalled event down the
      // pipe, while an unattached renderer drops the call on the floor. Rich and plain calls are
      // INTERLEAVED inside one loop rather than run as two batches, so a host that gets busier
      // partway through inflates both arms equally and cannot masquerade as a serialization
      // cost. The getter-invocation count rides along as the crisp discrete companion to the
      // fuzzy timing.
      try {
        let hits = 0;
        const rich = {};
        Object.defineProperty(rich, 'probed', {
          enumerable: true,
          configurable: true,
          get: function () { hits++; return 'v'; },
        });
        const richMs = [];
        const plainMs = [];
        for (let i = 0; i < CONSOLE_ITERATIONS; i++) {
          const a0 = now(); console.debug(rich); const a1 = now();
          const b0 = now(); console.debug('bgw-cdp-probe'); const b1 = now();
          richMs.push(a1 - a0);
          plainMs.push(b1 - b0);
        }
        const rm = median(richMs);
        const pm = median(plainMs);
        const rb = bucketize(rm, CONSOLE_EDGES);
        const pb = bucketize(pm, CONSOLE_EDGES);
        const ratio = ratioBucket(rm, pm);
        cdp.consoleTiming.iterations = CONSOLE_ITERATIONS;
        cdp.consoleTiming.getterFired = hits > 0;
        cdp.consoleTiming.getterInvocations = hits;
        cdp.consoleTiming.richMedianBucket = rb;
        cdp.consoleTiming.plainMedianBucket = pb;
        cdp.consoleTiming.ratioBucket = ratio;
      } catch (e) { /* leaves stay null */ }

      // ── Probe D: pre-dispatch stall on the page's OWN sub-resources (passive) ─────────────
      // Our guard pauses EVERY request in EVERY frame at requestStage "Request" and continues it
      // from the client, so each request pays one extra client round-trip before it is dispatched.
      // That is not a boolean tell, it is a latency signature — and it is the one family in this
      // section with no published detection method, so it is measured rather than assumed.
      //
      // requestStart - fetchStart is where that pause lands: Resource Timing records it INSIDE
      // the browser, before the network starts, so it is not swamped by RTT the way end-to-end
      // fetch() time is (through a residential exit, RTT jitter is hundreds of milliseconds —
      // orders of magnitude larger than the effect being looked for).
      //
      // PASSIVE BY CONSTRUCTION. This reads entries the page already produced and issues NO
      // requests of its own. An earlier draft fired six cache-busted GETs at the current origin's
      // /favicon.ico; that turned scripts/fingerprint-snapshot.mjs — a read-only diagnostic that
      // gets pointed at real, scored origins during "clears locally / blocks in prod"
      // investigations — into something that generates traffic against the host it is measuring,
      // and left the sample count, the success count and a max-minus-min range in the diffed
      // snapshot, all of which churn on any real network. The ACTIVE, cache-busted version with a
      // proper sample count still exists in CDP_TIMING_RAW_JS, which only the baseline harness
      // runs and which never enters a snapshot.
      //
      // A cross-origin entry without Timing-Allow-Origin reports requestStart as 0; those are
      // skipped rather than read as an impossibly fast dispatch. On a page with no sub-resources
      // every leaf here is null — correctly "nothing to measure", not "measured clean".
      try {
        if (typeof performance !== 'undefined' && performance && typeof performance.getEntriesByType === 'function') {
          const ents = performance.getEntriesByType('resource') || [];
          const stall = [];
          for (let i = 0; i < ents.length; i++) {
            const ent = ents[i];
            if (ent && ent.requestStart > 0 && ent.fetchStart > 0 && ent.requestStart >= ent.fetchStart) {
              stall.push(ent.requestStart - ent.fetchStart);
            }
          }
          cdp.resourceTiming.entriesBucket = countBucket(ents.length);
          cdp.resourceTiming.timedBucket = countBucket(stall.length);
          if (stall.length) {
            cdp.resourceTiming.stallMedianBucket = bucketize(median(stall), STALL_EDGES);
            cdp.resourceTiming.stallMaxBucket = bucketize(Math.max.apply(null, stall), STALL_EDGES);
          }
        }
      } catch (e) { /* leaves stay null */ }

      // ── Probe E: crude automation controls ────────────────────────────────────────────────
      // NONE OF THESE DETECT PROTOCOL ATTACHMENT. navigator.webdriver reflects the automation
      // command-line flag; cdc_ keys are ChromeDriver binary artifacts; the puppeteer/playwright
      // key scans catch library injection. They are here as a control surface: they are supposed
      // to read clean on this stack, and a suite where every single value reads clean is
      // indistinguishable from a suite that is silently throwing.
      // ISOLATED-WORLD CAVEAT, and it is a real limit on the key scans: page.evaluate runs in an
      // isolated world whose global is a DIFFERENT object from the page's window, so a JS-level
      // expando planted in the main world is not visible here and these counts are structurally
      // biased toward zero. navigator.webdriver is a Blink-backed property and does read through.
      try {
        let cdc = 0;
        let pup = 0;
        let pw = 0;
        const keys = Object.getOwnPropertyNames(window);
        for (let i = 0; i < keys.length; i++) {
          const k = keys[i];
          const lower = k.toLowerCase();
          if (k.indexOf('cdc_') >= 0) cdc++;
          if (lower.indexOf('puppeteer') >= 0) pup++;
          if (k.indexOf('__pw') === 0 || lower.indexOf('playwright') >= 0) pw++;
        }
        // toString tampering is an INVERTED signal: it detects the stealth patch, not the
        // automation. Recorded so a future capture can tell "the driver stopped patching" from
        // "the driver started leaking".
        const tos = Function.prototype.toString;
        const intact = tos.call(tos).indexOf('[native code]') >= 0
          && tos.call(document.querySelector).indexOf('[native code]') >= 0;
        cdp.controls.webdriver = (typeof nav.webdriver === 'boolean') ? nav.webdriver : null;
        cdp.controls.cdcKeys = cdc;
        cdp.controls.puppeteerKeys = pup;
        cdp.controls.playwrightKeys = pw;
        cdp.controls.nativeToStringIntact = intact;
      } catch (e) { /* leaves stay null */ }

      // ── Probe F: positive self-tests ──────────────────────────────────────────────────────
      // The probes above all report false on a clean stack, which is exactly what they would
      // also report if their machinery were broken — a getter that is never installed, a Proxy
      // trap that is optimized away, a clock quantized to zero. These three exercise that same
      // machinery LOCALLY, where the answer must be true, so an all-false reading upstream can
      // be read as "nothing detected" instead of "nothing measured". If any of these is false
      // or null, every negative above is uninterpretable.
      // They are not a substitute for a CDP-attached positive control — proving the probes fire
      // when a consumer really is attached needs a second, deliberately-attached session, which
      // is the baseline ticket's job, not this one's.
      try {
        let g = 0;
        const o = {};
        Object.defineProperty(o, 'p', { get: function () { g++; return 1; } });
        void o.p;
        cdp.selfTest.getterFires = g === 1;
      } catch (e) { /* leaf stays null */ }
      try {
        let k = 0;
        const trap = new Proxy({}, { ownKeys: function () { k++; return []; } });
        const carrier = Object.create(trap);
        Reflect.ownKeys(Object.getPrototypeOf(carrier));
        cdp.selfTest.ownKeysFires = k === 1;
      } catch (e) { /* leaf stays null */ }
      try {
        const t0 = now();
        let acc = 0;
        for (let i = 0; i < 2000000; i++) acc += i;
        const t1 = now();
        // Fixed, bounded spin of a couple of milliseconds — enough to clear Chrome's ~100us
        // performance.now() coarsening, so a false here means the clock is frozen and every
        // bucket in this section is meaningless.
        cdp.selfTest.clockAdvances = (t1 > t0) && (acc > 0);
      } catch (e) { /* leaf stays null */ }
    } catch (e) {
      // Structural failure of the section itself. The null-leaf shape above is already in
      // place, so the capture still carries every cdp.* dotted path and diffFingerprints sees
      // a value change rather than a schema change.
      cdp.sectionOk = false;
    }
    return cdp;
  })().catch(function (e) {
    // Belt-and-braces for anything that could throw BEFORE the section's own try opens (the
    // object literal and the function declarations cannot; a hostile clock is handled in now()).
    // Without this the rejection would propagate through the await above and out of the whole
    // collector, losing every other axis. A degraded cdp section is an acceptable outcome; a lost
    // capture is not.
    return { probeVersion: 2, sectionOk: false, sectionError: String(e) };
  });

  return out;
})()`;

/** Run the collector against a live page. The page should already be on a secure (https)
 *  origin so the canvas hash (crypto.subtle) works. */
export async function collectFingerprint(
  page: { evaluate: (expr: string) => Promise<unknown> },
): Promise<Record<string, unknown>> {
  return (await page.evaluate(FINGERPRINT_COLLECTOR_JS)) as Record<string, unknown>;
}

/** Summary statistics over one raw sample series in a {@link CdpRawTimingReport}. */
export interface CdpRawSeries {
  n: number;
  min: number | null;
  p50: number | null;
  p90: number | null;
  max: number | null;
  mean: number | null;
  stdev: number | null;
}

/**
 * Shape returned by {@link CDP_TIMING_RAW_JS}. Every probe object carries its own `error`
 * string instead of throwing, so one broken probe still yields the rest of the report.
 */
export interface CdpRawTimingReport {
  probeVersion: number;
  capturedAt: string;
  chromeMajor: number | null;
  userAgent: string | null;
  origin: string | null;
  durationMs: number;
  budgetMs: number;
  budgetExceeded: boolean;
  errorStack: {
    error: string | null;
    iterations: number;
    invocations: number | null;
    fired: boolean | null;
    wallMs: number[];
    summary: CdpRawSeries | null;
  };
  consoleProxy: {
    error: string | null;
    iterations: number;
    invocations: number | null;
    fired: boolean | null;
    wallMs: number[];
    summary: CdpRawSeries | null;
  };
  consoleTiming: {
    error: string | null;
    iterations: number;
    getterInvocations: number | null;
    richMs: number[];
    plainMs: number[];
    richSummary: CdpRawSeries | null;
    plainSummary: CdpRawSeries | null;
  };
  fetchProbe: {
    error: string | null;
    origin: string | null;
    planned: number;
    ok: number;
    /** How many of the `ok` samples were matched back to a Resource Timing entry. A run with
     *  `ok > 0` and `timed === 0` means the harvest missed, not that the requests were instant —
     *  the distinction the per-sample read used to hide. */
    timed: number;
    status: number[];
    wallMs: number[];
    /** `requestStart - fetchStart`: the pre-dispatch window a Fetch pause would land in. */
    stallMs: number[];
    /** `domainLookupStart - fetchStart`: collapses to ~0 on a reused connection. */
    dispatchMs: number[];
    ttfbMs: number[];
    totalMs: number[];
    /** Per sample: did Resource Timing report a reused connection (no DNS/TCP/TLS phase)? */
    reused: boolean[];
    wallSummary: CdpRawSeries | null;
    stallSummary: CdpRawSeries | null;
    ttfbSummary: CdpRawSeries | null;
  };
  controls: {
    error: string | null;
    webdriver: boolean | null;
    cdcKeys: number | null;
    puppeteerKeys: number | null;
    playwrightKeys: number | null;
    nativeToStringIntact: boolean | null;
  };
  selfTest: {
    error: string | null;
    getterFires: boolean | null;
    ownKeysFires: boolean | null;
    clockAdvances: boolean | null;
    clockDeltaMs: number | null;
  };
}

/**
 * Raw-timing companion to the `cdp` section of {@link FINGERPRINT_COLLECTOR_JS}.
 *
 * WHY THIS IS A SEPARATE SCRIPT AND NOT PART OF THE COLLECTOR. The collector's cdp leaves are
 * quantized on purpose: `diffFingerprints` compares by JSON equality per path, so a raw float
 * would flag every re-capture of an unchanged environment as divergent. But bucket boundaries
 * cannot be chosen from buckets — deriving a threshold ladder, or a variance estimate for one,
 * needs the underlying numbers. This script produces exactly those numbers, at higher iteration
 * counts than the collector can afford, and its output NEVER enters a snapshot and therefore
 * never reaches `diffFingerprints`.
 *
 * A self-contained async IIFE expression with no template interpolation, same contract as the
 * collector, so it can be handed straight to `page.evaluate(string)`.
 *
 * The helper functions are duplicated from the collector rather than shared through
 * concatenation: each string has to survive `page.evaluate` on its own, and building either one
 * out of fragments would reintroduce a build-time binding that the "no interpolation" contract
 * exists to forbid. Two small copies are cheaper than one silently-broken evaluate.
 *
 * Returns a {@link CdpRawTimingReport}.
 */
export const CDP_TIMING_RAW_JS = `(async () => {
  const CONSOLE_ITERATIONS = 50;
  const FETCH_SAMPLES = 20;
  const BUDGET_MS = 15000;
  const FETCH_TIMEOUT_MS = 2000;

  const now = (typeof performance !== 'undefined' && performance && typeof performance.now === 'function')
    ? function () { return performance.now(); }
    : function () { return Date.now(); };
  const t0all = now();

  function summarize(xs) {
    const v = xs.filter(function (x) { return typeof x === 'number' && isFinite(x); })
      .sort(function (p, q) { return p - q; });
    if (!v.length) return { n: 0, min: null, p50: null, p90: null, max: null, mean: null, stdev: null };
    function at(p) {
      const idx = Math.min(v.length - 1, Math.max(0, Math.round((v.length - 1) * p)));
      return v[idx];
    }
    let sum = 0;
    for (let i = 0; i < v.length; i++) sum += v[i];
    const mean = sum / v.length;
    let ss = 0;
    for (let i = 0; i < v.length; i++) ss += (v[i] - mean) * (v[i] - mean);
    return {
      n: v.length, min: v[0], p50: at(0.5), p90: at(0.9), max: v[v.length - 1],
      mean: mean, stdev: Math.sqrt(ss / v.length),
    };
  }

  const nav = navigator;
  let chromeMajor = null;
  try {
    const ua = (nav && typeof nav.userAgent === 'string') ? nav.userAgent : '';
    const at = ua.indexOf('Chrome/');
    if (at >= 0) {
      const tail = ua.slice(at + 7);
      const dot = tail.indexOf('.');
      const n = parseInt(dot > 0 ? tail.slice(0, dot) : tail, 10);
      chromeMajor = isFinite(n) ? n : null;
    }
  } catch (e) { /* stays null */ }

  const origin = (typeof location !== 'undefined' && location && location.origin && location.origin !== 'null')
    ? location.origin : null;

  const report = {
    probeVersion: 1,
    capturedAt: new Date().toISOString(),
    chromeMajor: chromeMajor,
    userAgent: (nav && typeof nav.userAgent === 'string') ? nav.userAgent : null,
    origin: origin,
    durationMs: 0,
    budgetMs: BUDGET_MS,
    budgetExceeded: false,
    errorStack: { error: null, iterations: CONSOLE_ITERATIONS, invocations: null, fired: null, wallMs: [], summary: null },
    consoleProxy: { error: null, iterations: CONSOLE_ITERATIONS, invocations: null, fired: null, wallMs: [], summary: null },
    consoleTiming: { error: null, iterations: CONSOLE_ITERATIONS, getterInvocations: null, richMs: [], plainMs: [], richSummary: null, plainSummary: null },
    fetchProbe: {
      error: null, origin: origin, planned: FETCH_SAMPLES, ok: 0, timed: 0, status: [],
      wallMs: [], stallMs: [], dispatchMs: [], ttfbMs: [], totalMs: [], reused: [],
      wallSummary: null, stallSummary: null, ttfbSummary: null,
    },
    controls: { error: null, webdriver: null, cdcKeys: null, puppeteerKeys: null, playwrightKeys: null, nativeToStringIntact: null },
    selfTest: { error: null, getterFires: null, ownKeysFires: null, clockAdvances: null, clockDeltaMs: null },
  };

  // A fresh Error per iteration: reusing one would let V8 cache the formatted stack and the
  // getter would stop being consulted for reasons that have nothing to do with the protocol.
  try {
    let hits = 0;
    for (let i = 0; i < CONSOLE_ITERATIONS; i++) {
      const err = new Error('bgw-cdp-raw');
      Object.defineProperty(err, 'stack', {
        configurable: false, enumerable: false,
        get: function () { hits++; return ''; },
      });
      const a = now(); console.debug(err); const b = now();
      report.errorStack.wallMs.push(b - a);
    }
    report.errorStack.invocations = hits;
    report.errorStack.fired = hits > 0;
    report.errorStack.summary = summarize(report.errorStack.wallMs);
  } catch (e) { report.errorStack.error = String(e); }

  try {
    let hits = 0;
    for (let i = 0; i < CONSOLE_ITERATIONS; i++) {
      const trap = new Proxy({}, { ownKeys: function () { hits++; return []; } });
      const carrier = Object.create(trap);
      const a = now(); console.groupEnd(carrier); const b = now();
      report.consoleProxy.wallMs.push(b - a);
    }
    report.consoleProxy.invocations = hits;
    report.consoleProxy.fired = hits > 0;
    report.consoleProxy.summary = summarize(report.consoleProxy.wallMs);
  } catch (e) { report.consoleProxy.error = String(e); }

  try {
    let hits = 0;
    const rich = {};
    Object.defineProperty(rich, 'probed', {
      enumerable: true, configurable: true,
      get: function () { hits++; return 'v'; },
    });
    for (let i = 0; i < CONSOLE_ITERATIONS; i++) {
      const a0 = now(); console.debug(rich); const a1 = now();
      const b0 = now(); console.debug('bgw-cdp-raw'); const b1 = now();
      report.consoleTiming.richMs.push(a1 - a0);
      report.consoleTiming.plainMs.push(b1 - b0);
    }
    report.consoleTiming.getterInvocations = hits;
    report.consoleTiming.richSummary = summarize(report.consoleTiming.richMs);
    report.consoleTiming.plainSummary = summarize(report.consoleTiming.plainMs);
  } catch (e) { report.consoleTiming.error = String(e); }

  try {
    if (!origin) throw new Error('no same-origin base (opaque or missing location.origin)');
    const urls = [];
    for (let i = 0; i < FETCH_SAMPLES; i++) {
      if (now() - t0all > BUDGET_MS) { report.budgetExceeded = true; break; }
      const url = origin + '/favicon.ico?bgwfp=' + i + '-' + Math.random().toString(36).slice(2);
      try {
        const opts = { cache: 'no-store', credentials: 'omit', mode: 'same-origin' };
        if (typeof AbortSignal !== 'undefined' && AbortSignal && typeof AbortSignal.timeout === 'function') {
          opts.signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
        }
        const a = now();
        const res = await fetch(url, opts);
        const b = now();
        report.fetchProbe.wallMs.push(b - a);
        report.fetchProbe.status.push(res && typeof res.status === 'number' ? res.status : -1);
        report.fetchProbe.ok++;
        try { if (res && res.body && typeof res.body.cancel === 'function') res.body.cancel(); } catch (e2) { /* already consumed */ }
        urls.push(url);
      } catch (e2) { /* one sample lost */ }
    }

    // TIMING IS HARVESTED AFTER THE LOOP, NOT PER SAMPLE. A PerformanceResourceTiming entry is
    // queued at responseEnd; this probe awaits response HEADERS and then cancels the body, so at
    // the moment the old per-sample read ran the entry did not exist yet. Measured, not reasoned:
    // the three-way baseline's own instrument-validity check reported this probe recovering rows
    // in 0 of 24 in-container captures while the harness's post-run read of the SAME requests
    // recovered them every time. The unit test could not see it because a stub getEntriesByName
    // always returns an entry — so the stub now returns nothing and the by-type path is the only
    // one that works, which is what the browser actually does.
    if (typeof performance !== 'undefined' && performance && typeof performance.getEntriesByType === 'function') {
      // One settle turn so the last sample's entry is queued before the sweep.
      await new Promise(function (r) { setTimeout(r, 50); });
      const byName = {};
      const all = performance.getEntriesByType('resource') || [];
      for (let i = 0; i < all.length; i++) {
        if (all[i] && typeof all[i].name === 'string') byName[all[i].name] = all[i];
      }
      for (let i = 0; i < urls.length; i++) {
        const ent = byName[urls[i]];
        if (!ent || !(ent.fetchStart > 0)) continue;
        report.fetchProbe.timed++;
        if (ent.requestStart > 0) report.fetchProbe.stallMs.push(ent.requestStart - ent.fetchStart);
        if (ent.domainLookupStart > 0) report.fetchProbe.dispatchMs.push(ent.domainLookupStart - ent.fetchStart);
        if (ent.responseStart > 0 && ent.requestStart > 0) report.fetchProbe.ttfbMs.push(ent.responseStart - ent.requestStart);
        if (ent.responseEnd > 0) report.fetchProbe.totalMs.push(ent.responseEnd - ent.startTime);
        // Resource Timing collapses the connection phases onto fetchStart when the socket is
        // reused; that is the regime where stallMs is closest to pure protocol overhead.
        report.fetchProbe.reused.push(ent.connectStart === ent.fetchStart);
      }
    }
    report.fetchProbe.wallSummary = summarize(report.fetchProbe.wallMs);
    report.fetchProbe.stallSummary = summarize(report.fetchProbe.stallMs);
    report.fetchProbe.ttfbSummary = summarize(report.fetchProbe.ttfbMs);
  } catch (e) { report.fetchProbe.error = String(e); }

  try {
    let cdc = 0; let pup = 0; let pw = 0;
    const keys = Object.getOwnPropertyNames(window);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const lower = k.toLowerCase();
      if (k.indexOf('cdc_') >= 0) cdc++;
      if (lower.indexOf('puppeteer') >= 0) pup++;
      if (k.indexOf('__pw') === 0 || lower.indexOf('playwright') >= 0) pw++;
    }
    const tos = Function.prototype.toString;
    report.controls.webdriver = (typeof nav.webdriver === 'boolean') ? nav.webdriver : null;
    report.controls.cdcKeys = cdc;
    report.controls.puppeteerKeys = pup;
    report.controls.playwrightKeys = pw;
    report.controls.nativeToStringIntact = tos.call(tos).indexOf('[native code]') >= 0
      && tos.call(document.querySelector).indexOf('[native code]') >= 0;
  } catch (e) { report.controls.error = String(e); }

  try {
    let g = 0;
    const o = {};
    Object.defineProperty(o, 'p', { get: function () { g++; return 1; } });
    void o.p;
    report.selfTest.getterFires = g === 1;
    let k = 0;
    const trap = new Proxy({}, { ownKeys: function () { k++; return []; } });
    const carrier = Object.create(trap);
    Reflect.ownKeys(Object.getPrototypeOf(carrier));
    report.selfTest.ownKeysFires = k === 1;
    const c0 = now();
    let acc = 0;
    for (let i = 0; i < 2000000; i++) acc += i;
    const c1 = now();
    report.selfTest.clockDeltaMs = c1 - c0;
    report.selfTest.clockAdvances = (c1 > c0) && (acc > 0);
  } catch (e) { report.selfTest.error = String(e); }

  report.durationMs = now() - t0all;
  return report;
})()`;

/**
 * Paths (exact or as a prefix) whose divergence carries a known significance.
 *
 * NOTHING UNDER `cdp.` IS LISTED HERE, ON PURPOSE. The CDP-presence probes produce
 * measurements only; grading them needs a baseline captured against a deliberately
 * protocol-attached control session, and a severity assigned before that baseline exists would
 * just encode the probe author's expectation. Adding a `cdp.*` entry here is a separate
 * decision, not a missing line.
 */
export const AXIS_SEVERITY: Record<"high" | "geo", string[]> = {
  high: [
    "webgl.unmaskedRenderer",
    "webgl.unmaskedVendor",
    "webgl.renderer",
    "webgl.vendor",
    "webdriver",
    "webrtc.udpCount",
    "webrtc.srflxCount",
    "hardwareConcurrency",
    "deviceMemory",
    "platform",
    "canvasHash",
    "fonts",
    "fontCount",
  ],
  geo: ["timezone", "timezoneOffsetMin", "locale", "language", "languages"],
};

export function classifyAxis(path: string): AxisSeverity {
  const matches = (p: string) => path === p || path.startsWith(p + ".");
  if (AXIS_SEVERITY.high.some(matches)) return "high";
  if (AXIS_SEVERITY.geo.some(matches)) return "geo";
  return "info";
}

/**
 * Flatten a nested fingerprint into dot-path → leaf-value. Arrays are leaves (compared
 * whole), so `languages` / `fonts` diff as a unit rather than per index.
 */
export function flattenFingerprint(
  value: unknown,
  prefix = "",
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { [prefix || "."]: value };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      Object.assign(out, flattenFingerprint(v, path));
    } else {
      out[path] = v;
    }
  }
  return out;
}

const SEVERITY_RANK: Record<AxisSeverity, number> = { high: 0, geo: 1, info: 2 };

/**
 * Diff two raw fingerprint bags. Returns only the divergent axes, sorted high → geo → info
 * then by path. Equality is by JSON value, so arrays/objects compare structurally.
 */
export function diffFingerprints(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): FingerprintDiff[] {
  const fa = flattenFingerprint(a);
  const fb = flattenFingerprint(b);
  const paths = new Set([...Object.keys(fa), ...Object.keys(fb)]);
  const diffs: FingerprintDiff[] = [];
  for (const path of paths) {
    const va = path in fa ? fa[path] : null;
    const vb = path in fb ? fb[path] : null;
    if (JSON.stringify(va ?? null) === JSON.stringify(vb ?? null)) continue;
    diffs.push({ path, a: va ?? null, b: vb ?? null, severity: classifyAxis(path) });
  }
  diffs.sort(
    (x, y) =>
      SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity] ||
      x.path.localeCompare(y.path),
  );
  return diffs;
}
