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
      pc.createOffer().then(function (o) { return pc.setLocalDescription(o); });
      setTimeout(finish, 8000);
    });
  } catch (e) { out.webrtc = { error: String(e) }; }

  return out;
})()`;

/** Run the collector against a live page. The page should already be on a secure (https)
 *  origin so the canvas hash (crypto.subtle) works. */
export async function collectFingerprint(
  page: { evaluate: (expr: string) => Promise<unknown> },
): Promise<Record<string, unknown>> {
  return (await page.evaluate(FINGERPRINT_COLLECTOR_JS)) as Record<string, unknown>;
}

/** Paths (exact or as a prefix) whose divergence carries a known significance. */
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
