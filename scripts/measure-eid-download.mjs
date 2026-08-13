#!/usr/bin/env node
/**
 * EID download behaviour — MEASUREMENT ONLY (measurement task 0). Run IN-CONTAINER (headful Chrome
 * under Xvfb):
 *
 *   docker build --platform linux/amd64 -f docker/Dockerfile -t browse-gateway:eid-measure .
 *   docker run --rm --platform linux/amd64 --shm-size=1g --init browse-gateway:eid-measure \
 *     node scripts/measure-eid-download.mjs
 *
 * WHAT IT ANSWERS. Before anything is built for EID document download, what does the SHIPPING stack
 * do TODAY when a navigation resolves to a file rather than a page? Two shapes are measured, through
 * the three surfaces a consumer can reach:
 *
 *   (a) ATTACHMENT PDF — `Content-Type: application/pdf` + `Content-Disposition: attachment`
 *   (b) INLINE PDF     — `Content-Type: application/pdf` + `Content-Disposition: inline`
 *
 *   surface `browser`  — createBrowserCore() + core.render(), the call retrieve() makes underneath
 *   surface `retrieve` — retrieve() over a policy-guarded gateway (transient session per call)
 *   surface `drive`    — GatewayDriveController.navigate() (persistent consumer-bound session)
 *
 * and it records, per (case × surface): the navigation result / failure class, whether a Playwright
 * `download` event fired, the suggested filename when it is SAFE to report, whether a driver temp
 * file existed before the browser context closed, and whether it survived the close.
 *
 * IT IMPLEMENTS NOTHING. No download capture, no save path, no product behaviour — this script only
 * observes. The observation is attached at the documented injection seams: `Gateway.create`'s
 * `CoreFactory` (gateway/index.ts: "A core factory can be injected for tests") and the core's public
 * `context` getter ("Escape hatch for the policy layer's integration checks"). The shipping verbs,
 * policy guard and session lifecycle run unmodified.
 *
 * THE FIXTURE IS LOCAL AND DETERMINISTIC. A loopback `http.createServer` serves every case with
 * fixed bytes and fixed headers, so a reading never depends on a live site, a WAF, or the network.
 * The policy egress filter denies loopback as anti-SSRF, so the PolicyEngine is constructed with the
 * TEST-ONLY `egress: () => false` override — the same hook, for the same reason, as
 * `validate-vault-host-login.mjs` (`policyEgress: () => false`). It is passed in-process only; no
 * deployed entrypoint can reach it.
 *
 * WHAT IT REFUSES TO PRINT. PDF bytes, cookies, source query strings, absolute temp paths, and the
 * consumer token never enter the report. Error TEXT is never carried either — it interpolates the
 * requested URL — only `err.name` plus a CLOSED-vocabulary marker ({@link errorMarker}). A final
 * hygiene guard greps the serialized report for each of those and fails the run if one appears.
 *
 * EXIT CODE IS ABOUT THE MEASUREMENT, NOT THE BEHAVIOUR. 0 = the reading is VALID (whatever it
 * says); 1 = the reading is INVALID — the apparatus, the fixture or the hygiene guard failed, so
 * nothing printed can be trusted. A "no download event fired" row is a RESULT, not a failure.
 *
 * THE GUARD MUST BE ABLE TO REPORT BAD NEWS. `BGW_EID_MEASURE_FAULT` deliberately breaks one arm at
 * a time so each can be watched going RED (see docs/solutions/.../eid-download-current-behaviour):
 *   break-fixture   — the fixture serves the wrong Content-Disposition   -> fixture self-check RED
 *   mute-observer   — the download listener is never attached            -> positive control RED
 *   forge-download  — a download is synthesized on every page            -> negative control RED
 *   leak-temp-path  — the absolute temp path is copied into the report   -> hygiene guard RED
 *
 * Env:
 *   BGW_EID_MEASURE_FAULT=<mode>       fault injection (default `none`; see above)
 *   BGW_EID_MEASURE_SURFACES=a,b       restrict surfaces (default `browser,retrieve,drive`)
 *   BGW_EID_MEASURE_JSON=0             suppress the machine-readable JSON block
 *   BGW_CHANNEL / BGW_NO_SANDBOX       browser channel + sandbox (the container sets both)
 */
import http from "node:http";
import { existsSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createBrowserCore } from "../dist/browser/index.js";
import { Gateway, loadConfig, loadCallTimeouts } from "../dist/gateway/index.js";
import { PolicyEngine, ConsumerRegistry, InMemoryAuditSink } from "../dist/policy/index.js";
import { SecretStore } from "../dist/security/index.js";
import { retrieve } from "../dist/verbs/index.js";
import { GatewayDriveController } from "../dist/mcp/drive-controller.js";
import { failureOf } from "../dist/observability/index.js";

// ---------------------------------------------------------------------------------------------
// Constants — the fixture's shape and the harness's own bounds.
// ---------------------------------------------------------------------------------------------

/** Loopback host the fixture binds; also the single host on the consumer allowlist. */
export const FIXTURE_HOST = "127.0.0.1";

/**
 * A query string on every fixture URL, present for ONE reason: it makes "the report carries no
 * source query strings" a claim the hygiene guard can actually falsify. A real EID source URL
 * carries a document id and a signature here; a reading that leaked one would be unpublishable.
 */
export const FIXTURE_QUERY = "doc=eid-demo-0001&sig=QUERYSTRING-MUST-NOT-BE-REPORTED";

/** Same idea for a cookie: the fixture sets one so "no cookies in the report" is falsifiable. */
export const FIXTURE_COOKIE = "eid_fixture_session=COOKIE-MUST-NOT-BE-REPORTED";

/** Harness credential. Not a real secret — but the report must never carry a consumer token, and a
 *  literal in the forbidden set is how that stays true when the report shape changes. */
const CONSUMER_TOKEN = "tok-eid-measure-CONSUMER-TOKEN-MUST-NOT-BE-REPORTED";
const CONSUMER_ID = "eid-measure";

/**
 * The smallest structurally valid PDF. Its bytes are the thing a report must never contain — the
 * hygiene guard greps for the `%PDF-` header, so a future row that pastes page/file content in
 * fails the run instead of shipping.
 */
export const PDF_BYTES = Buffer.from(
  "%PDF-1.4\n" +
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n" +
    "trailer<</Root 1 0 R>>\n" +
    "%%EOF\n",
  "utf8",
);

/** Positive-control payload: not a PDF, so a PDF-specific browser behaviour can't explain it away. */
export const OCTET_BYTES = Buffer.from("EID-MEASURE-POSITIVE-CONTROL-PAYLOAD\n", "utf8");

/**
 * The four legs. Two MEASURED shapes and two CONTROLS, and the controls are what make the measured
 * rows readable: `octet-attachment-control` is a download every Chrome performs, so if IT reports no
 * download event the apparatus is deaf and a quiet PDF row means nothing; `html-control` is a page
 * no browser downloads, so if IT reports one the apparatus is over-firing. Neither control's outcome
 * prejudges (a) or (b) — they bound the instrument, not the answer.
 */
export const CASES = [
  { id: "attachment-pdf", path: "/attachment.pdf", role: "measured", note: "application/pdf + Content-Disposition: attachment" },
  { id: "inline-pdf", path: "/inline.pdf", role: "measured", note: "application/pdf + Content-Disposition: inline" },
  { id: "html-control", path: "/control.html", role: "negative-control", note: "text/html — must NOT download" },
  { id: "octet-attachment-control", path: "/control.bin", role: "positive-control", note: "application/octet-stream + attachment — MUST download" },
];

export const POSITIVE_CONTROL = "octet-attachment-control";
export const NEGATIVE_CONTROL = "html-control";

export const ALL_SURFACES = ["browser", "retrieve", "drive"];

export const FAULT_MODES = ["none", "break-fixture", "mute-observer", "forge-download", "leak-temp-path"];

/** Navigation timeout for every surface. Short on purpose: a download navigation that never reaches
 *  DOMContentLoaded burns the whole timeout, and 45s × 12 legs is a coffee break, not a measurement. */
const NAV_TIMEOUT_MS = 15_000;
/** Clearance poll budget. There is no anti-bot challenge on a loopback fixture; this is the floor a
 *  cleared-page poll needs, not a tuning knob. */
const CLEARANCE_TIMEOUT_MS = 3_000;
/** Whole-call budget handed to retrieve/drive, so neither can stack attempts past the harness. */
const CALL_BUDGET_MS = 30_000;
/** How long a download's `path()` / `failure()` may take before the file state reads `unknown`. */
const DOWNLOAD_SETTLE_MS = 8_000;
/** Grace after a leg for a `download` event still in flight, so it lands in the right row. */
const LEG_SETTLE_MS = 750;

// ---------------------------------------------------------------------------------------------
// Pure helpers — everything below is unit-tested in test/eid-download-measure.test.mjs.
// ---------------------------------------------------------------------------------------------

/**
 * Origin + path only. The query string and fragment are dropped because a source URL is where a
 * document id / signature lives, and the credentials fields because a URL can carry a password.
 * Returns a marker (never the input) when the URL will not parse — echoing an unparseable string
 * back into the report is precisely how the thing you refused to print gets printed.
 */
export function redactUrl(raw) {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "<unparseable-url>";
  }
}

/** Conservative basename charset: leading alphanumeric, then alphanumerics and `. _ -`, ≤ 128. */
const SAFE_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * A suggested filename is SITE-controlled data (Content-Disposition), so it is reported only when it
 * is a plain basename. Anything else — a path separator, a traversal segment, a NUL, a control
 * character, an over-long or exotic name — is withheld with a typed reason rather than printed, so
 * the report can never become the place a hostile filename gets copied from.
 */
export function safeFilename(raw) {
  if (typeof raw !== "string" || raw.length === 0) return { safe: false, value: null, reason: "absent" };
  if (raw.includes("/") || raw.includes("\\")) return { safe: false, value: null, reason: "path-separator" };
  if (raw.includes("\0")) return { safe: false, value: null, reason: "nul-byte" };
  if (raw === "." || raw === "..") return { safe: false, value: null, reason: "dot-segment" };
  if (raw.length > 128) return { safe: false, value: null, reason: "too-long" };
  if (!SAFE_FILENAME_RE.test(raw)) return { safe: false, value: null, reason: "unsafe-characters" };
  return { safe: true, value: raw, reason: null };
}

/**
 * Three-valued on purpose. `unknown` means the driver never gave us a path to stat (the download
 * failed, or never settled inside {@link DOWNLOAD_SETTLE_MS}) — reporting that as `absent` would
 * manufacture a finding ("the file is already gone") out of an unanswered question.
 */
export function tempFileState(pathKnown, exists) {
  if (!pathKnown) return "unknown";
  return exists ? "present" : "absent";
}

/**
 * CLOSED vocabulary for why a navigation threw. Error MESSAGES are never carried into the report —
 * they interpolate the requested URL, query string and all — so this reduces a message to one of a
 * fixed set of tokens chosen at authoring time. `other` is the honest fallback; `none` is no message.
 */
export const ERROR_MARKERS = [
  "net::ERR_ABORTED",
  "net::ERR_BLOCKED_BY_CLIENT",
  "net::ERR_CONNECTION_REFUSED",
  "net::ERR_EMPTY_RESPONSE",
  "net::ERR_INVALID_RESPONSE",
  "Download is starting",
  "Timeout",
  "budget",
  "no open session",
];

export function errorMarker(message) {
  if (typeof message !== "string" || message.length === 0) return "none";
  for (const marker of ERROR_MARKERS) {
    if (message.includes(marker)) return marker;
  }
  return "other";
}

/**
 * Attribute a download to a case by PATH. Counting events between two timestamps would mis-file any
 * download that lands after its leg returned (they are asynchronous, and an attachment navigation
 * returns before the transfer finishes); the served path is the one identifier both sides agree on.
 */
export function downloadsForCase(downloads, casePath) {
  return downloads.filter((d) => d.redactedUrl.endsWith(casePath));
}

/**
 * The measurement's own guard. It answers "can this reading be trusted", never "did the stack
 * behave well" — a row saying no download fired is a finding; a row saying the INSTRUMENT never
 * fired is a broken instrument. Every arm is reachable: see the fault modes in the file header.
 */
export function measurementValidity(rows, fixture) {
  const problems = [];
  if (!fixture.ok) {
    for (const detail of fixture.problems) problems.push({ code: "fixture-self-check", detail });
  }
  if (rows.length === 0) {
    problems.push({ code: "no-legs-ran", detail: "no surface produced a row" });
    return { valid: false, problems };
  }
  for (const surface of [...new Set(rows.map((r) => r.surface))]) {
    const of = (caseId) => rows.find((r) => r.surface === surface && r.case === caseId);
    const pos = of(POSITIVE_CONTROL);
    const neg = of(NEGATIVE_CONTROL);
    if (!pos) {
      problems.push({ code: "positive-control-missing", surface, detail: `${POSITIVE_CONTROL} did not run` });
    } else if (pos.download.eventCount < 1) {
      problems.push({
        code: "positive-control-silent",
        surface,
        detail: "an octet-stream attachment produced NO download event — the observer is not measuring anything on this surface, so every quiet row is uninterpretable",
      });
    }
    if (!neg) {
      problems.push({ code: "negative-control-missing", surface, detail: `${NEGATIVE_CONTROL} did not run` });
    } else if (neg.download.eventCount > 0) {
      problems.push({
        code: "negative-control-fired",
        surface,
        detail: "an ordinary HTML page reported a download event — the observer is over-firing, so every loud row is uninterpretable",
      });
    }
    if (!rows.some((r) => r.surface === surface && r.coresObserved > 0)) {
      problems.push({ code: "no-core-observed", surface, detail: "no browser core was observed on this surface — the injection seam did not take" });
    }
  }
  return { valid: problems.length === 0, problems };
}

/**
 * Literal values that must never appear in the report. Only the LABEL is ever printed — printing the
 * offending value to explain the violation would be the leak it exists to stop.
 */
export function literalViolations(serialized, forbidden) {
  return forbidden.filter((f) => typeof f.value === "string" && f.value.length > 0 && serialized.includes(f.value)).map((f) => f.label);
}

/** Shape-based leaks — the classes that have no fixed literal to grep for. */
export const STRUCTURAL_FORBIDDEN = [
  { label: "pdf-content", re: /%PDF-/ },
  { label: "absolute-temp-path", re: /(^|[^A-Za-z0-9])(\/tmp\/|\/var\/folders\/|\/var\/tmp\/)/ },
  { label: "playwright-artifact-path", re: /playwright-artifacts|\.playwright/ },
  { label: "query-string", re: /\?[A-Za-z0-9_.-]+=/ },
];

export function structuralViolations(serialized) {
  return STRUCTURAL_FORBIDDEN.filter((f) => f.re.test(serialized)).map((f) => f.label);
}

/**
 * Wrap a core's teardown so the harness can stat the driver's temp file on BOTH sides of the close
 * without owning the close. Assigning own properties shadows the prototype methods while leaving the
 * instance (its private fields, its `context`/`forceKillAvailable` getters) untouched, so the session
 * manager still drives the real core — the wrapper only delays the close by the stat.
 *
 * Both `close` and `kill` are wrapped: a teardown that escalates past the grace period would
 * otherwise skip the hooks and leave every file state reading `unknown` for no stated reason. The
 * latch makes a close-then-kill sequence run them exactly once.
 */
export function wrapCoreTeardown(core, hooks) {
  let settled = false;
  const run = async (real, args) => {
    const first = !settled;
    settled = true;
    if (first) await hooks.beforeClose();
    try {
      return await real(...args);
    } finally {
      if (first) await hooks.afterClose();
    }
  };
  const realClose = core.close.bind(core);
  const realKill = typeof core.kill === "function" ? core.kill.bind(core) : undefined;
  core.close = (...args) => run(realClose, args);
  if (realKill) core.kill = (...args) => run(realKill, args);
  return core;
}

/** Resolve the fault mode, rejecting an unknown one loudly — a typo must not read as `none`. */
export function resolveFault(raw) {
  const mode = raw === undefined || raw === "" ? "none" : raw;
  if (!FAULT_MODES.includes(mode)) {
    throw new Error(`unknown BGW_EID_MEASURE_FAULT: expected one of ${FAULT_MODES.join(", ")}`);
  }
  return {
    mode,
    breakFixture: mode === "break-fixture",
    muteObserver: mode === "mute-observer",
    forgeDownload: mode === "forge-download",
    leakTempPath: mode === "leak-temp-path",
  };
}

/** Parse the surface filter, rejecting an unknown surface (a typo would silently narrow the run). */
export function resolveSurfaces(raw) {
  if (raw === undefined || raw.trim() === "") return [...ALL_SURFACES];
  const picked = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = picked.filter((s) => !ALL_SURFACES.includes(s));
  if (unknown.length) throw new Error(`unknown BGW_EID_MEASURE_SURFACES entry: expected from ${ALL_SURFACES.join(", ")}`);
  return picked;
}

// ---------------------------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------------------------

const HTML_CONTROL = `<!doctype html><html><head><title>EID measurement control page</title></head><body>
<h1>EID measurement control page</h1>
<p>This page exists so the harness has a navigation that must NOT produce a download event. It also
carries enough prose to clear the extraction layer's minimum content bar, so the retrieve surface
reports a page rather than a thin-content failure and the control stays a control.</p>
<p>The bytes here are fixed and served from loopback, so this reading never depends on a live site,
an anti-bot vendor, or the network. Nothing on this page is secret, and nothing on it is copied into
the measurement report.</p>
</body></html>`;

/**
 * The deterministic fixture. `breakFixture` flips the attachment routes to `inline` — the fault that
 * proves the self-check below is load-bearing rather than decorative.
 */
export function createFixtureServer({ breakFixture = false } = {}) {
  const disposition = (kind, filename) => (breakFixture ? "inline" : kind) + `; filename="${filename}"`;
  return http.createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    // A cookie on every response: the report must carry no cookies, and a fixture that never sets
    // one would make that claim vacuous.
    const base = { "Set-Cookie": `${FIXTURE_COOKIE}; Path=/`, "Cache-Control": "no-store" };
    if (path === "/attachment.pdf") {
      res.writeHead(200, { ...base, "Content-Type": "application/pdf", "Content-Disposition": disposition("attachment", "eid-statement.pdf"), "Content-Length": PDF_BYTES.length });
      return res.end(PDF_BYTES);
    }
    if (path === "/inline.pdf") {
      res.writeHead(200, { ...base, "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="eid-inline.pdf"`, "Content-Length": PDF_BYTES.length });
      return res.end(PDF_BYTES);
    }
    if (path === "/control.bin") {
      res.writeHead(200, { ...base, "Content-Type": "application/octet-stream", "Content-Disposition": disposition("attachment", "eid-positive-control.bin"), "Content-Length": OCTET_BYTES.length });
      return res.end(OCTET_BYTES);
    }
    if (path === "/control.html") {
      res.writeHead(200, { ...base, "Content-Type": "text/html; charset=utf-8" });
      return res.end(HTML_CONTROL);
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("not found");
  });
}

/**
 * What each route MUST answer before a browser is launched. A run whose fixture drifted would
 * otherwise produce confident rows about a shape it never served.
 */
export const FIXTURE_EXPECTATIONS = [
  { path: "/attachment.pdf", status: 200, contentType: "application/pdf", dispositionPrefix: "attachment" },
  { path: "/inline.pdf", status: 200, contentType: "application/pdf", dispositionPrefix: "inline" },
  { path: "/control.bin", status: 200, contentType: "application/octet-stream", dispositionPrefix: "attachment" },
  { path: "/control.html", status: 200, contentType: "text/html", dispositionPrefix: null },
];

/** Compare one fixture response against its expectation. Pure, so the self-check is unit-tested. */
export function fixtureRouteProblems(expected, actual) {
  const problems = [];
  if (actual.status !== expected.status) problems.push(`${expected.path}: status ${actual.status} (expected ${expected.status})`);
  if (!String(actual.contentType ?? "").startsWith(expected.contentType)) {
    problems.push(`${expected.path}: content-type "${actual.contentType ?? "<absent>"}" (expected ${expected.contentType})`);
  }
  const disposition = String(actual.disposition ?? "");
  if (expected.dispositionPrefix === null) {
    if (disposition) problems.push(`${expected.path}: unexpected content-disposition "${disposition.split(";")[0]}"`);
  } else if (!disposition.startsWith(expected.dispositionPrefix)) {
    problems.push(`${expected.path}: content-disposition "${disposition.split(";")[0] || "<absent>"}" (expected ${expected.dispositionPrefix})`);
  }
  return problems;
}

/** Fetch each route over plain HTTP — no browser — and check it against its expectation. */
async function selfCheckFixture(base) {
  const problems = [];
  for (const expected of FIXTURE_EXPECTATIONS) {
    const actual = await new Promise((resolve) => {
      const req = http.get(`${base}${expected.path}?${FIXTURE_QUERY}`, (res) => {
        res.resume(); // drain: the bytes are not needed and must not be buffered into this process
        resolve({ status: res.statusCode, contentType: res.headers["content-type"], disposition: res.headers["content-disposition"] });
      });
      req.on("error", () => resolve({ status: null, contentType: null, disposition: null }));
    });
    problems.push(...fixtureRouteProblems(expected, actual));
  }
  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------------------------
// Observation apparatus
// ---------------------------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withTimeout(promise, ms, fallback) {
  let timer;
  try {
    return await Promise.race([
      promise.catch(() => fallback),
      new Promise((r) => {
        timer = setTimeout(() => r(fallback), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Watches every core the run creates. Attaches `page.on("download")` through the core's public
 * `context` getter and stats the driver's temp file on both sides of the teardown — passively: it
 * navigates nothing, cancels nothing, and saves nothing.
 */
function createObserver(fault) {
  const downloads = [];
  const cores = [];
  let coreSeq = 0;

  const capture = (dl, coreId) => {
    const record = {
      coreId,
      redactedUrl: redactUrl(dl.url()),
      suggestedFilenameRaw: typeof dl.suggestedFilename === "function" ? dl.suggestedFilename() : "",
      forged: false,
      pathKnown: false,
      reportedFailure: "unknown",
      existsBeforeClose: null,
      existsAfterClose: null,
      sizeMatchesServed: null,
      // The absolute path stays HERE and never reaches a row (except under the leak-temp-path
      // fault, which exists to prove the hygiene guard notices).
      absolutePath: null,
      settled: (async () => {
        const failure = await withTimeout(Promise.resolve(dl.failure()), DOWNLOAD_SETTLE_MS, "unknown");
        record.reportedFailure = failure === "unknown" ? "unknown" : failure === null ? false : true;
        const p = await withTimeout(Promise.resolve(dl.path()), DOWNLOAD_SETTLE_MS, undefined);
        if (typeof p === "string" && p.length > 0) {
          record.pathKnown = true;
          record.absolutePath = p;
        }
      })(),
    };
    downloads.push(record);
    return record;
  };

  const statSide = (side, coreId) => {
    for (const d of downloads) {
      if (d.coreId !== coreId || !d.pathKnown || d.forged) continue;
      const exists = existsSync(d.absolutePath);
      if (side === "before") {
        if (d.existsBeforeClose === null) {
          d.existsBeforeClose = exists;
          d.sizeMatchesServed = exists ? statSync(d.absolutePath).size > 0 : false;
        }
      } else if (d.existsAfterClose === null) {
        d.existsAfterClose = exists;
      }
    }
  };

  return {
    downloads,
    get coreCount() {
      return cores.length;
    },
    /** Attach to a real core. Returns the core so it can be used as a CoreFactory tail call. */
    observe(core) {
      const coreId = ++coreSeq;
      cores.push(coreId);
      const context = core.context;
      const wirePage = (page) => {
        if (fault.forgeDownload) {
          // FAULT: synthesize a download on every page, including the HTML control — the negative
          // control must catch an over-firing observer.
          downloads.push({
            coreId,
            redactedUrl: redactUrl(page.url() || "http://forged.invalid/"),
            suggestedFilenameRaw: "forged.bin",
            forged: true,
            pathKnown: false,
            reportedFailure: "unknown",
            existsBeforeClose: null,
            existsAfterClose: null,
            sizeMatchesServed: null,
            absolutePath: null,
            settled: Promise.resolve(),
          });
        }
        if (fault.muteObserver) return; // FAULT: deaf apparatus — the positive control must catch it.
        page.on("download", (dl) => {
          try {
            capture(dl, coreId);
          } catch {
            // A download object can throw on access if its page died first; a lost record is
            // preferable to killing the run, and the controls would surface a systematic loss.
          }
        });
      };
      for (const page of context.pages()) wirePage(page);
      context.on("page", wirePage);
      wrapCoreTeardown(core, {
        beforeClose: async () => {
          await withTimeout(
            Promise.all(downloads.filter((d) => d.coreId === coreId).map((d) => d.settled)),
            DOWNLOAD_SETTLE_MS + 1_000,
            undefined,
          );
          statSide("before", coreId);
        },
        afterClose: async () => {
          statSide("after", coreId);
        },
      });
      return core;
    },
    /** Forge-mode records aside, resolve any still-pending path lookups (end-of-run safety net). */
    async settleAll() {
      await withTimeout(Promise.all(downloads.map((d) => d.settled)), DOWNLOAD_SETTLE_MS + 1_000, undefined);
    },
  };
}

/**
 * Fold a leg's downloads into the row's reportable download block.
 *
 * Called at REPORT time, never at leg time. The temp-file readings are written by the teardown hooks
 * when the core closes, and on the browser/drive surfaces that happens AFTER the leg returns (one
 * core serves every case) — folding at leg time captured the pre-close nulls and rendered them as a
 * confident `absent`, i.e. "the driver wrote no file", which is a finding the run had not made.
 */
function downloadBlock(records, fault) {
  if (records.length === 0) {
    return { eventCount: 0, suggestedFilename: null, filenameWithheldReason: null, reportedFailure: null, tempFileBeforeClose: null, tempFileAfterClose: null, tempFileNonEmpty: null };
  }
  const first = records[0];
  const named = safeFilename(first.suggestedFilenameRaw);
  // A reading that was never TAKEN (`null` — the core never closed, or the stat never ran) is
  // `unknown`, exactly like a path that never resolved. Only a stat that actually ran can say `absent`.
  const statTaken = (side) => first.pathKnown && side !== null;
  return {
    eventCount: records.length,
    suggestedFilename: named.value,
    filenameWithheldReason: named.reason,
    reportedFailure: first.reportedFailure,
    tempFileBeforeClose: tempFileState(statTaken(first.existsBeforeClose), first.existsBeforeClose === true),
    tempFileAfterClose: tempFileState(statTaken(first.existsAfterClose), first.existsAfterClose === true),
    tempFileNonEmpty: first.sizeMatchesServed,
    // FAULT: the absolute path in the row is what the hygiene guard must refuse to publish.
    ...(fault.leakTempPath ? { tempFilePath: first.absolutePath } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------------------------

const CHANNEL = process.env.BGW_CHANNEL ?? "chrome";
const NO_SANDBOX = process.env.BGW_NO_SANDBOX === "1";
const HEADLESS = process.env.BGW_HEADLESS === "1"; // the container runs headful under Xvfb

/**
 * One row per (surface × case), in the shape both the table and the JSON block read.
 *
 * `coresObserved` counts the cores seen on this SURFACE up to and including this leg (the validity
 * guard reads it to catch an injection seam that never took); `coresLaunchedDuringLeg` is the delta
 * for THIS leg — non-zero on the drive surface exactly when the controller discarded its session and
 * launched a replacement.
 */
function makeRow(surface, testCase, nav, records, cores, guard, elapsedMs, _fault) {
  return {
    surface,
    case: testCase.id,
    role: testCase.role,
    nav,
    // Held by REFERENCE and folded by finalizeRows() once every core has closed — the temp-file
    // readings do not exist yet at leg time. finalizeRows destructures it away, so the live records
    // (which hold the absolute temp path) can never reach the serialized report.
    get records() {
      return records;
    },
    download: null,
    guard,
    coresObserved: cores.observed,
    coresLaunchedDuringLeg: cores.launchedDuringLeg,
    elapsedMs: Math.round(elapsedMs),
  };
}

/** Fold every row's download block AFTER all cores have closed. Returns plain, serializable rows. */
export function finalizeRows(rows, fault) {
  return rows.map(({ records, ...rest }) => ({ ...rest, download: downloadBlock(records, fault) }));
}

/** Everything a thrown navigation may contribute, with no free text. */
function navFromError(err) {
  return {
    outcome: "threw",
    status: null,
    errorName: err instanceof Error ? err.name : "non-error-throw",
    errorMarker: errorMarker(err instanceof Error ? err.message : ""),
    failureClass: failureOf(err)?.failureClass ?? null,
  };
}

async function runBrowserSurface({ base, observer, fault, rows }) {
  const core = await createBrowserCore({ headless: HEADLESS, channel: CHANNEL, noSandbox: NO_SANDBOX, navigationTimeoutMs: NAV_TIMEOUT_MS });
  observer.observe(core);
  // The shipping stack never renders without a navigation guard installed (the policy layer installs
  // one on every session), and the guard is CDP-Fetch interception — which sits directly in a
  // download's request path. Rendering unguarded here would measure a configuration we do not ship.
  const guardLog = [];
  await core.setNavigationGuard((nav) => {
    guardLog.push({ host: nav.host, isNavigationRequest: nav.isNavigationRequest, resourceType: nav.resourceType, path: redactUrl(nav.url) });
    return nav.host === FIXTURE_HOST ? "allow" : "block";
  });
  const coresAtSurfaceStart = observer.coreCount - 1; // the core opened just above belongs to this surface
  try {
    for (const testCase of CASES) {
      const guardAt = guardLog.length;
      const coresAt = observer.coreCount;
      // Slice from HERE so a download observed on an earlier leg (or an earlier surface) can never be
      // counted again on this one; the path match then files it against the right case within the leg.
      const downloadsAt = observer.downloads.length;
      const t0 = performance.now();
      let nav;
      try {
        const r = await core.render(`${base}${testCase.path}?${FIXTURE_QUERY}`, { clearanceTimeoutMs: CLEARANCE_TIMEOUT_MS });
        nav = { outcome: "returned", status: r.status, responseReceived: r.responseReceived ?? null, textLength: r.text.length, htmlLength: r.html.length, failureClass: null };
      } catch (err) {
        nav = navFromError(err);
      }
      const elapsed = performance.now() - t0;
      await sleep(LEG_SETTLE_MS);
      const hops = guardLog.slice(guardAt);
      rows.push(
        makeRow(
          "browser",
          testCase,
          nav,
          downloadsForCase(observer.downloads.slice(downloadsAt), testCase.path),
          { observed: observer.coreCount - coresAtSurfaceStart, launchedDuringLeg: observer.coreCount - coresAt },
          { sawNavigationRequest: hops.some((h) => h.isNavigationRequest && h.path.endsWith(testCase.path)), requestsSeen: hops.length },
          elapsed,
          fault,
        ),
      );
    }
  } finally {
    await core.close().catch(() => {});
  }
}

async function runRetrieveSurface({ base, gateway, secrets, audit, observer, fault, rows, timeouts }) {
  const coresAtSurfaceStart = observer.coreCount;
  for (const testCase of CASES) {
    const auditAt = audit.records.length;
    const coresAt = observer.coreCount;
    const downloadsAt = observer.downloads.length;
    const t0 = performance.now();
    let nav;
    try {
      const r = await retrieve(gateway, secrets, {
        token: CONSUMER_TOKEN,
        url: `${base}${testCase.path}?${FIXTURE_QUERY}`,
        clearanceTimeoutMs: CLEARANCE_TIMEOUT_MS,
        timeouts,
      });
      nav = {
        outcome: "returned",
        status: r.status,
        blocked: r.blocked,
        // `reason` and `failureClass` are CLOSED vocabularies (the type is the safety property —
        // neither can be page-derived free text), so both are safe to carry verbatim.
        blockReason: r.reason,
        degraded: r.degraded,
        markdownLength: r.markdown.length,
        failureClass: r.diagnostics?.failureClass ?? null,
      };
    } catch (err) {
      nav = navFromError(err);
    }
    const elapsed = performance.now() - t0;
    await sleep(LEG_SETTLE_MS);
    const decisions = audit.records.slice(auditAt).filter((a) => a.action === "navigate");
    rows.push(
      makeRow(
        "retrieve",
        testCase,
        nav,
        downloadsForCase(observer.downloads.slice(downloadsAt), testCase.path),
        { observed: observer.coreCount - coresAtSurfaceStart, launchedDuringLeg: observer.coreCount - coresAt },
        { guardAllows: decisions.filter((d) => d.decision === "allow").length, guardBlocks: decisions.filter((d) => d.decision === "block").length },
        elapsed,
        fault,
      ),
    );
  }
}

async function runDriveSurface({ base, gateway, secrets, audit, observer, fault, rows, timeouts }) {
  const drive = new GatewayDriveController(gateway, secrets, CONSUMER_TOKEN, { timeouts });
  const coresAtSurfaceStart = observer.coreCount;
  try {
    for (const testCase of CASES) {
      const auditAt = audit.records.length;
      const coresAt = observer.coreCount;
      const downloadsAt = observer.downloads.length;
      const t0 = performance.now();
      let nav;
      try {
        const snap = await drive.navigate(`${base}${testCase.path}?${FIXTURE_QUERY}`);
        nav = {
          outcome: "returned",
          status: snap.status ?? null,
          responseReceived: snap.responseReceived ?? null,
          deadlineTruncated: snap.deadlineTruncated === true,
          treeLength: snap.tree.length,
          failureClass: null,
        };
      } catch (err) {
        nav = navFromError(err);
      }
      const elapsed = performance.now() - t0;
      await sleep(LEG_SETTLE_MS);
      const decisions = audit.records.slice(auditAt).filter((a) => a.action === "navigate");
      rows.push(
        makeRow(
          "drive",
          testCase,
          nav,
          downloadsForCase(observer.downloads.slice(downloadsAt), testCase.path),
          // A drive session discarded mid-run (the controller's failure path) launches a replacement
          // core; `launchedDuringLeg` is how that shows up in the reading.
          { observed: observer.coreCount - coresAtSurfaceStart, launchedDuringLeg: observer.coreCount - coresAt },
          { guardAllows: decisions.filter((d) => d.decision === "allow").length, guardBlocks: decisions.filter((d) => d.decision === "block").length },
          elapsed,
          fault,
        ),
      );
    }
  } finally {
    await drive.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

const YES_NO = (v) => (v === null || v === undefined ? "—" : v ? "yes" : "no");

function printTable(rows) {
  const head = ["surface", "case", "nav", "status", "class", "dl", "filename", "tmp<close", "tmp>close", "ms"];
  const body = rows.map((r) => [
    r.surface,
    r.case,
    r.nav.outcome === "returned" ? "returned" : `threw:${r.nav.errorMarker}`,
    String(r.nav.status ?? "null"),
    String(r.nav.failureClass ?? "—"),
    r.download.eventCount === 0 ? "no" : `yes×${r.download.eventCount}`,
    r.download.suggestedFilename ?? (r.download.filenameWithheldReason ? `<${r.download.filenameWithheldReason}>` : "—"),
    String(r.download.tempFileBeforeClose ?? "—"),
    String(r.download.tempFileAfterClose ?? "—"),
    String(r.elapsedMs),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells) => "  " + cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  console.log(line(head));
  console.log(line(widths.map((w) => "-".repeat(w))));
  for (const b of body) console.log(line(b));
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

export async function main() {
  const fault = resolveFault(process.env.BGW_EID_MEASURE_FAULT);
  const surfaces = resolveSurfaces(process.env.BGW_EID_MEASURE_SURFACES);

  console.log("=== browse-gateway :: EID download behaviour MEASUREMENT (task 0) ===");
  console.log(`  surfaces=${surfaces.join(",")} fault=${fault.mode} channel=${CHANNEL} headless=${HEADLESS}`);
  console.log("  measures only — no download capture is implemented by this script\n");
  if (fault.mode !== "none") console.log(`  !! FAULT INJECTION ACTIVE (${fault.mode}) — this run is expected to report INVALID\n`);

  const server = createFixtureServer({ breakFixture: fault.breakFixture });
  await new Promise((r) => server.listen(0, FIXTURE_HOST, r));
  const base = `http://${FIXTURE_HOST}:${server.address().port}`;

  const rows = [];
  const observer = createObserver(fault);
  let fixture = { ok: false, problems: ["fixture self-check did not run"] };
  const audit = new InMemoryAuditSink();
  const timeouts = { ...loadCallTimeouts(), callBudgetMs: CALL_BUDGET_MS, clearanceTimeoutMs: CLEARANCE_TIMEOUT_MS };

  const config = loadConfig();
  config.core.navigationTimeoutMs = NAV_TIMEOUT_MS;
  config.timeouts = timeouts;
  const policy = new PolicyEngine({
    registry: new ConsumerRegistry([{ id: CONSUMER_ID, token: CONSUMER_TOKEN, allow: [FIXTURE_HOST] }]),
    audit,
    // TEST-ONLY, in-process: the real egress filter denies loopback as anti-SSRF, so the fixture is
    // unreachable without it. Same override, same reason, as validate-vault-host-login.mjs.
    egress: () => false,
  });
  const secrets = new SecretStore(() => ({})); // no proxy/solver material: direct sessions only
  const gateway = Gateway.create(config, async (opts) => observer.observe(await createBrowserCore(opts)), policy);

  try {
    fixture = await selfCheckFixture(base);
    console.log(`  fixture self-check: ${fixture.ok ? "OK" : "FAILED"}`);
    for (const p of fixture.problems) console.log(`    - ${p}`);

    // A fixture that does not serve the shapes under test cannot produce a meaningful reading, so
    // the browsers are never launched. (This is the break-fixture fault's fast RED path.)
    if (fixture.ok) {
      if (surfaces.includes("browser")) await runBrowserSurface({ base, observer, fault, rows });
      if (surfaces.includes("retrieve")) await runRetrieveSurface({ base, gateway, secrets, audit, observer, fault, rows, timeouts });
      if (surfaces.includes("drive")) await runDriveSurface({ base, gateway, secrets, audit, observer, fault, rows, timeouts });
    } else {
      console.log("  (browsers not launched — a drifted fixture cannot produce a meaningful reading)");
    }
  } finally {
    await observer.settleAll();
    await gateway.shutdown().catch(() => {});
    await new Promise((r) => server.close(r));
  }

  // Fold the download blocks only now: every core has closed, so the before/after-close stats exist.
  const finalRows = finalizeRows(rows, fault);
  const validity = measurementValidity(finalRows, fixture);
  const report = {
    meta: {
      task: "eid-download-measurement-0",
      surfaces,
      fault: fault.mode,
      channel: CHANNEL,
      headless: HEADLESS,
      navTimeoutMs: NAV_TIMEOUT_MS,
      clearanceTimeoutMs: CLEARANCE_TIMEOUT_MS,
      callBudgetMs: CALL_BUDGET_MS,
      chromeVersionUnavailable: true, // deliberately not probed: not needed for this reading
    },
    fixture,
    rows: finalRows,
    unattributedDownloads: observer.downloads.filter((d) => !CASES.some((c) => d.redactedUrl.endsWith(c.path))).length,
    validity,
  };

  const serialized = JSON.stringify(report, null, 2);
  const hygiene = [
    ...literalViolations(serialized, [
      { label: "fixture-cookie", value: FIXTURE_COOKIE },
      { label: "fixture-cookie-value", value: "COOKIE-MUST-NOT-BE-REPORTED" },
      { label: "query-string-literal", value: FIXTURE_QUERY },
      { label: "query-string-signature", value: "QUERYSTRING-MUST-NOT-BE-REPORTED" },
      { label: "consumer-token", value: CONSUMER_TOKEN },
      { label: "octet-payload", value: OCTET_BYTES.toString("utf8").trim() },
    ]),
    ...structuralViolations(serialized),
  ];

  if (finalRows.length) {
    console.log("");
    printTable(finalRows);
  }

  console.log("");
  console.log("  observations:");
  for (const r of finalRows.filter((x) => x.role === "measured")) {
    console.log(
      `    ${r.surface}/${r.case}: nav=${r.nav.outcome}(${r.nav.status ?? "null"}) download=${YES_NO(r.download.eventCount > 0)} ` +
        `filename=${r.download.suggestedFilename ?? "—"} tempBeforeClose=${r.download.tempFileBeforeClose ?? "—"} tempAfterClose=${r.download.tempFileAfterClose ?? "—"}`,
    );
  }

  console.log("");
  console.log(`  hygiene guard: ${hygiene.length === 0 ? "clean" : `VIOLATED [${hygiene.join(", ")}]`}`);
  console.log(`  validity guard: ${validity.valid ? "valid" : "INVALID"}`);
  for (const p of validity.problems) console.log(`    - ${p.code}${p.surface ? ` (${p.surface})` : ""}: ${p.detail}`);

  const ok = validity.valid && hygiene.length === 0;
  if (process.env.BGW_EID_MEASURE_JSON !== "0" && hygiene.length === 0) {
    console.log("\n--- BEGIN EID-DOWNLOAD-MEASUREMENT JSON ---");
    console.log(serialized);
    console.log("--- END EID-DOWNLOAD-MEASUREMENT JSON ---");
  } else if (hygiene.length > 0) {
    console.log("\n  (JSON withheld — the hygiene guard refuses to print a report that carries forbidden content)");
  }

  console.log(`\n=== EID DOWNLOAD MEASUREMENT: ${ok ? "VALID ✅ (a reading, not a pass/fail gate)" : "INVALID ❌ — do not use these numbers"} ===`);
  return ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
