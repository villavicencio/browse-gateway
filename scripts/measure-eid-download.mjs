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
 * ATTRIBUTION IS DEFERRED, NOT SLICED. Downloads are asynchronous: an attachment navigation returns
 * before its transfer finishes, and the `download` event can land after the leg, after the NEXT leg,
 * or after the surface is done. So every event goes into ONE persistent ledger tagged with the core
 * that saw it (and therefore the surface), and rows are filled only at report time — after every
 * download has settled and every observed core's teardown has completed. A record is filed by EXACT
 * parsed URL pathname; anything that cannot be filed is COUNTED as unattributed and invalidates the
 * run rather than quietly turning a real attachment into a `download: no` row.
 *
 * THE FIXTURE IS LOCAL AND DETERMINISTIC. A loopback `http.createServer` serves every case with
 * fixed bytes and fixed headers, so a reading never depends on a live site, a WAF, or the network.
 * Bind and self-check are both bounded — a stalled fixture fails the run instead of hanging it. The
 * policy egress filter denies loopback as anti-SSRF, so the PolicyEngine is constructed with the
 * TEST-ONLY `egress: () => false` override — the same hook, for the same reason, as
 * `validate-vault-host-login.mjs` (`policyEgress: () => false`). It is passed in-process only; no
 * deployed entrypoint can reach it.
 *
 * WHAT IT REFUSES TO PRINT. PDF bytes, cookies, source query strings, absolute paths (of any shape:
 * POSIX, `file://`, Windows drive or UNC), and the consumer token never enter the report. Error TEXT
 * is never carried either — it interpolates the requested URL — only a sanitized `err.name` plus a
 * CLOSED-vocabulary marker ({@link errorMarker}). Two things enforce that: absolute paths are omitted
 * BY CONSTRUCTION (no row field carries one; the observer holds the path privately), and EVERY line
 * this process prints goes through {@link scrubLine}, including the top-level failure path — an
 * uncaught throw is caught, sanitized and reported as INVALID rather than allowed to print a stack.
 *
 * EXIT CODE IS ABOUT THE MEASUREMENT, NOT THE BEHAVIOUR. 0 = the reading is VALID (whatever it
 * says); 1 = the reading is INVALID — the apparatus, the fixture or the hygiene guard failed, so
 * nothing printed can be trusted. A "no download event fired" row is a RESULT, not a failure.
 *
 * THE GUARD MUST BE ABLE TO REPORT BAD NEWS. `BGW_EID_MEASURE_FAULT` deliberately breaks one arm at
 * a time so each can be watched going RED (see docs/solutions/.../eid-download-current-behaviour):
 *   break-fixture   — the fixture serves the wrong Content-Disposition   -> fixture self-check RED
 *   mute-observer   — the download listener is never attached            -> positive control RED
 *   forge-download  — a download is synthesized on every navigation      -> negative control RED
 *   leak-temp-path  — the absolute temp path is copied into the report   -> hygiene guard RED
 *
 * Env:
 *   BGW_EID_MEASURE_FAULT=<mode>       fault injection (default `none`; see above)
 *   BGW_EID_MEASURE_SURFACES=a,b       restrict surfaces (default `browser,retrieve,drive`)
 *   BGW_EID_MEASURE_JSON=0             suppress the machine-readable JSON block
 *   BGW_CHANNEL / BGW_NO_SANDBOX       browser channel + sandbox (the container sets both)
 *   BGW_HEADLESS=1                     debugging only — a headless run is reported INVALID
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
/**
 * Grace after a leg. NOT an attribution boundary — attribution is by pathname at report time — only
 * a courtesy so a transfer that is nearly done gets to finish before the next navigation starts.
 */
const LEG_SETTLE_MS = 750;
/** Bounds on the fixture itself: a measurement that can hang is not reproducible. */
const FIXTURE_LISTEN_TIMEOUT_MS = 5_000;
const FIXTURE_REQUEST_TIMEOUT_MS = 5_000;

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

/**
 * The EXACT parsed pathname, or null. Attribution compares pathnames for equality: `endsWith` would
 * file `/decoy/attachment.pdf` against the `/attachment.pdf` case, which is fine for four fixed
 * fixture routes and wrong as a primitive.
 */
export function pathnameOf(redactedUrl) {
  if (typeof redactedUrl !== "string" || redactedUrl.length === 0) return null;
  try {
    return new URL(redactedUrl).pathname;
  } catch {
    return null;
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
 * failed, never settled inside {@link DOWNLOAD_SETTLE_MS}, or the stat itself threw) — reporting that
 * as `absent` would manufacture a finding ("the file is already gone") out of an unanswered question.
 *
 * BOTH ARGUMENTS MUST BE EXACT BOOLEANS (Amendment 7 §6). Truthiness is not enough: `exists ? …` made
 * every non-`true` value — an omitted field, a `null`, a string, a number — read as a confident
 * `absent`, which is precisely the manufactured finding this function exists to prevent. A value
 * outside `{true, false}` is an unanswered question and reads `unknown`.
 */
export function tempFileState(pathKnown, exists) {
  if (pathKnown !== true) return "unknown";
  if (exists !== true && exists !== false) return "unknown";
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

/** An error class name is normally a token, but it is settable — so it is validated, not trusted. */
const SAFE_ERROR_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * Everything a thrown value may contribute to output: a validated name and a closed-vocabulary
 * marker. Nothing else — no message, no stack, no `cause`, no properties. This is the ONLY shape in
 * which a failure reaches the console or the report.
 */
export function sanitizeFailure(err) {
  if (!(err instanceof Error)) return { name: "non-error-throw", marker: "none" };
  const name = typeof err.name === "string" && SAFE_ERROR_NAME_RE.test(err.name) ? err.name : "unsafe-error-name";
  return { name, marker: errorMarker(typeof err.message === "string" ? err.message : "") };
}

/** Downloads whose EXACT pathname is this case's path. */
export function downloadsForCase(records, casePath) {
  return records.filter((d) => !d.accessorError && pathnameOf(d.redactedUrl) === casePath);
}

/**
 * File every ledger record against a (surface, case) key. A record with no surface, no parseable
 * pathname, a failed accessor, or a pathname that is not a case is UNATTRIBUTED — returned, never
 * dropped, because "we saw a download and could not say where it came from" is a reason to distrust
 * the whole reading, not a detail to round away.
 */
export function attributeLedger(records, cases = CASES) {
  const byKey = new Map();
  const unattributed = [];
  for (const record of records) {
    const pathname = record.accessorError ? null : pathnameOf(record.redactedUrl);
    const match = pathname === null ? undefined : cases.find((c) => c.path === pathname);
    if (!match || typeof record.surface !== "string" || record.surface.length === 0) {
      unattributed.push(record);
      continue;
    }
    const key = `${record.surface}\u0000${match.id}`;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(record);
    else byKey.set(key, [record]);
  }
  return { byKey, unattributed };
}

/** The EXACT closed set a reported temp-file state may belong to. `unknown` and `mixed` are honest
 *  reports of an unanswered question, and neither is a member: a run carrying one is not valid. */
const TEMP_STATES = new Set(["present", "absent"]);

/** Collapse per-record values: one value when they agree, `mixed` when they do not. */
function agree(values) {
  const unique = [...new Set(values)];
  if (unique.length === 0) return null;
  return unique.length === 1 ? unique[0] : "mixed";
}

/**
 * One record's temp-file reading for a side.
 *
 * Every way of NOT having observed reads `unknown` (Amendment 7 §6): a stat that threw, an accessor
 * that threw, a settle that never completed, a path that never resolved, and an existence value that
 * is anything other than an exact boolean — omitted, `null`, `undefined`, a number, a string. Only a
 * stat that actually ran, on a path that actually resolved, can say `absent`.
 *
 * Passing the raw observations through (rather than pre-coercing them with `&&` / `=== true`) is the
 * point: the coercion happened here, so the strictness has to happen here too.
 */
function recordTempState(record, side) {
  if (record.statError || record.accessorError || record.settleError) return "unknown";
  const value = side === "before" ? record.existsBeforeClose : record.existsAfterClose;
  return tempFileState(record.pathKnown, value);
}

/**
 * Fold a case's records into the row's reportable download block.
 *
 * Called at REPORT time, never at leg time — the temp-file readings are written by the teardown
 * hooks when the core closes, and on the browser/drive surfaces that happens AFTER the leg returns
 * (one core serves every case). Folding at leg time captured the pre-close nulls and rendered them
 * as a confident `absent`, i.e. "the driver wrote no file", a finding the run had not made.
 *
 * Every field aggregates ALL of the case's records. Reporting only the first would let an event
 * count of 3 sit beside one event's filename and temp state as though they described each other.
 */
export function downloadBlock(records, fault) {
  if (records.length === 0) {
    return {
      eventCount: 0,
      suggestedFilename: null,
      filenameWithheldReason: null,
      reportedFailure: null,
      tempFileBeforeClose: null,
      tempFileAfterClose: null,
      tempFileNonEmpty: null,
      statErrors: 0,
      settleErrors: 0,
    };
  }
  const rawNames = [...new Set(records.map((r) => r.suggestedFilenameRaw))];
  const named = rawNames.length === 1 ? safeFilename(rawNames[0]) : { safe: false, value: null, reason: "multiple-distinct" };
  return {
    eventCount: records.length,
    suggestedFilename: named.value,
    filenameWithheldReason: named.reason,
    reportedFailure: agree(records.map((r) => r.reportedFailure)),
    tempFileBeforeClose: agree(records.map((r) => recordTempState(r, "before"))),
    tempFileAfterClose: agree(records.map((r) => recordTempState(r, "after"))),
    tempFileNonEmpty: agree(records.map((r) => (r.statError ? null : r.sizeMatchesServed))),
    statErrors: records.filter((r) => r.statError).length,
    settleErrors: records.filter((r) => r.settleError).length,
    // FAULT: the absolute path in the row is what the hygiene guard must refuse to publish.
    ...(fault?.leakTempPath ? { tempFilePath: records[0].absolutePath } : {}),
  };
}

/**
 * Fill every row's download block from the persistent ledger, AFTER all downloads have settled and
 * every observed core's teardown has completed. Returns plain, serializable rows plus the number of
 * records that could not be filed — including records filed against a (surface, case) that produced
 * no row, which is exactly the "a measured row went missing" failure the validity guard must catch.
 */
export function finalizeRows(rows, records, fault) {
  const { byKey, unattributed } = attributeLedger(records);
  const claimed = new Set();
  const finalRows = rows.map((row) => {
    const key = `${row.surface}\u0000${row.case}`;
    claimed.add(key);
    return { ...row, download: downloadBlock(byKey.get(key) ?? [], fault) };
  });
  let orphaned = 0;
  for (const [key, bucket] of byKey) if (!claimed.has(key)) orphaned += bucket.length;
  return { rows: finalRows, unattributed: unattributed.length + orphaned };
}

/**
 * The ONE counter predicate: finite, non-negative, integral. `Number.isInteger` decides type,
 * finiteness and integrality together, so a string, a `null`, an omitted field, a boolean, an object,
 * `NaN` and either infinity are all refused by it.
 *
 * `> 0` was never this test. `NaN` is a number and satisfies neither `> 0` nor `< 1`, so a report
 * whose event counts, unattributed count and observation-failure counts were all `NaN` answered every
 * question with "no problem" and came back `{ valid: true, problems: [] }` — a confident reading
 * assembled from evidence that does not exist. A negative, a fraction and a numeric string passed the
 * same way. Every counter the guard reads as EVIDENCE goes through here.
 */
export function exactCounter(value) {
  return Number.isInteger(value) && value >= 0;
}

/**
 * The measurement's own guard. It answers "can this reading be trusted", never "did the stack
 * behave well" — a row saying no download fired is a finding; a row saying the INSTRUMENT never
 * fired is a broken instrument. Every arm is reachable: see the fault modes in the file header.
 *
 * `env` carries what is not in a row: the surfaces that were SELECTED (so a surface that produced no
 * rows at all is caught), the unattributed-download count, the observation-failure counters, the
 * per-core teardown states, and the browser mode. It is read fail-closed — an unstated field reads
 * as bad news, because an apparatus that cannot say what it did has not said it was fine.
 */
export function measurementValidity(rows, fixture, env = {}) {
  const problems = [];
  if (!fixture.ok) {
    for (const detail of fixture.problems) problems.push({ code: "fixture-self-check", detail });
  }
  // Headful is not a preference: the shipping stack runs headful under Xvfb, and a headless Chrome
  // is a different browser with different download behaviour. An unstated mode is not headful.
  if (env.headless !== false) {
    problems.push({ code: "headless-run", detail: "the browser did not run headful — a headless reading does not describe the shipping stack" });
  }
  if (rows.length === 0) {
    problems.push({ code: "no-legs-ran", detail: "no surface produced a row" });
    return { valid: false, problems };
  }

  /**
   * Check ONE counter, in ONE place, so no comparison below can quietly consume a malformed value:
   * every `> 0` / `< 1` test downstream is gated on this having passed first. The counter is NAMED
   * and its value is never printed — interpolating a malformed value is how a hostile string would
   * reach the report the hygiene guard then has to catch.
   */
  const requireCounter = (value, name, surface) => {
    if (exactCounter(value)) return true;
    problems.push({ code: "malformed-counter", ...(surface ? { surface } : {}), detail: `${name} was not reported as an exact non-negative integer count` });
    return false;
  };
  // Every row, not only the selected surfaces: a malformed counter on a row nobody aggregates is
  // still malformed evidence, and a valid sibling must not be able to stand in for it.
  for (const row of rows) {
    requireCounter(row.download?.eventCount, "download.eventCount", row.surface);
    requireCounter(row.coresObserved, "coresObserved", row.surface);
  }

  const selectedSurfaceMetadataPresent = Array.isArray(env.surfaces) && env.surfaces.length > 0;
  const surfaces = selectedSurfaceMetadataPresent ? env.surfaces : [];
  if (!selectedSurfaceMetadataPresent) {
    problems.push({ code: "surface-selection-missing", detail: "the selected-surface inventory was not recorded" });
  }
  if (new Set(surfaces).size !== surfaces.length) {
    problems.push({ code: "surface-selection-duplicate", detail: "the selected-surface inventory contained a duplicate" });
  }

  // The row set is a closed KEY SET — exactly one row for every expected (surface, case) and nothing
  // else — not a lookup table. Every question below is asked through `rows.find(...)`, which answers
  // from the first match and never looks at the rest: a second row contradicting the one it read was
  // invisible, and so was a row for a pair this measurement never ran. Neither the surface nor the
  // case of an unrecognised row is echoed into the report; it is the one value here this file did
  // not author, and the missing-row arms below already name every pair that was expected.
  const expectedKeys = new Set();
  for (const surface of surfaces) for (const testCase of CASES) expectedKeys.add(`${surface}\u0000${testCase.id}`);
  const counted = new Map();
  for (const r of rows) {
    const key = `${r.surface}\u0000${r.case}`;
    const seen = counted.get(key);
    if (seen) seen.count += 1;
    else counted.set(key, { surface: r.surface, case: r.case, count: 1 });
  }
  let unknownRows = 0;
  for (const [key, entry] of counted) {
    if (!expectedKeys.has(key)) { unknownRows += entry.count; continue; }
    if (entry.count > 1) {
      problems.push({ code: "duplicate-row", surface: entry.surface, detail: `${entry.case} produced more than one row on this surface` });
    }
  }
  if (unknownRows > 0) {
    problems.push({ code: "unknown-row", detail: `${unknownRows} row(s) were reported for surface/case pairs this measurement did not run` });
  }

  for (const surface of surfaces) {
    const of = (caseId) => rows.find((r) => r.surface === surface && r.case === caseId);
    for (const testCase of CASES) {
      const row = of(testCase.id);
      if (!row) {
        // Split by role so the codes stay legible: a lost MEASURED row is the race this guards.
        const code =
          testCase.id === POSITIVE_CONTROL ? "positive-control-missing" : testCase.id === NEGATIVE_CONTROL ? "negative-control-missing" : "measured-row-missing";
        problems.push({ code, surface, detail: `${testCase.id} produced no row on this surface` });
        continue;
      }
      if (row.navigationEvidence !== true) {
        problems.push({ code: "no-navigation-evidence", surface, detail: `${testCase.id} produced a row with no evidence the navigation was attempted` });
      }
      // Amendment 7 §6: for an OBSERVED download both readings must be members of the exact closed
      // set {present, absent}. Rejecting only `unknown` let an omitted field, a `mixed` aggregated
      // across records that disagreed, or any other malformed value pass as a valid lifecycle
      // reading — a row asserting a download happened while answering neither question about it.
      if (exactCounter(row.download?.eventCount) && row.download.eventCount > 0 && !(TEMP_STATES.has(row.download.tempFileBeforeClose) && TEMP_STATES.has(row.download.tempFileAfterClose))) {
        problems.push({ code: "lifecycle-incomplete", surface, detail: `${testCase.id} has a download without complete before/after-close observations` });
      }
    }
    const pos = of(POSITIVE_CONTROL);
    const neg = of(NEGATIVE_CONTROL);
    if (pos && exactCounter(pos.download?.eventCount) && pos.download.eventCount < 1) {
      problems.push({
        code: "positive-control-silent",
        surface,
        detail: "an octet-stream attachment produced NO download event — the observer is not measuring anything on this surface, so every quiet row is uninterpretable",
      });
    }
    if (neg && exactCounter(neg.download?.eventCount) && neg.download.eventCount > 0) {
      problems.push({
        code: "negative-control-fired",
        surface,
        detail: "an ordinary HTML page reported a download event — the observer is over-firing, so every loud row is uninterpretable",
      });
    }
    if (!rows.some((r) => r.surface === surface && exactCounter(r.coresObserved) && r.coresObserved > 0)) {
      problems.push({ code: "no-core-observed", surface, detail: "no browser core was observed on this surface — the injection seam did not take" });
    }
  }

  const unattributed = env.unattributedDownloads;
  if (requireCounter(unattributed, "unattributedDownloads") && unattributed > 0) {
    problems.push({
      code: "unattributed-download",
      detail: `${unattributed} download events could not be filed against a case — a quiet row cannot be read as "no download happened"`,
    });
  }

  for (const key of ["statErrors", "accessorErrors", "settleErrors"]) {
    const count = env[key];
    if (requireCounter(count, key) && count > 0) {
      problems.push({ code: "observation-failed", detail: `${key}=${count} — an observation that threw cannot be reported as a reading` });
    }
  }
  if (!Array.isArray(env.cleanupErrors) || env.cleanupErrors.length > 0) {
    problems.push({ code: "cleanup-failed", detail: `cleanup failures=${Array.isArray(env.cleanupErrors) ? env.cleanupErrors.length : "unstated"}` });
  }

  const teardown = Array.isArray(env.teardown) ? env.teardown : null;
  const downloadCoreIds = Array.isArray(env.downloadCoreIds) ? env.downloadCoreIds : null;
  if (!teardown || !downloadCoreIds) {
    problems.push({ code: "teardown-incomplete", detail: "teardown observations or download-core inventory were not reported" });
  } else {
    const teardownIds = new Set(teardown.map((t) => t.coreId));
    // One core, one close, one record. Two records for the same core are two statements about the
    // same teardown, and the checks below read whichever they reach first.
    if (teardownIds.size !== teardown.length) {
      problems.push({ code: "teardown-duplicate", detail: "a core filed more than one teardown record — one close cannot have two readings" });
    }
    for (const coreId of downloadCoreIds) {
      if (!teardownIds.has(coreId)) {
        problems.push({ code: "teardown-record-missing", detail: "a core that observed downloads has no teardown record" });
      }
    }
    // The inventory and the per-core records state the SAME fact — which cores took a download — and
    // are built from the same ledger, so they must agree exactly. Checking only that the inventory
    // was a subset of the teardown records accepted an inventory naming no downloading core at all
    // standing beside a record reporting one.
    const downloadedCores = new Set(teardown.filter((t) => exactCounter(t.downloadCount) && t.downloadCount > 0).map((t) => t.coreId));
    const inventory = new Set(downloadCoreIds);
    if (inventory.size !== downloadCoreIds.length) {
      problems.push({ code: "core-inventory-duplicate", detail: "a browser core appears more than once in the download-core inventory" });
    }
    if (inventory.size !== downloadedCores.size || [...inventory].some((coreId) => !downloadedCores.has(coreId))) {
      problems.push({ code: "core-inventory-mismatch", detail: "the download-core inventory does not name exactly the cores whose teardown reported downloads" });
    }
    // And a row asserting a download was observed cannot stand beside an apparatus naming no core
    // that took one. A run in which nothing downloaded is a RESULT — the controls are what read it —
    // so this arm fires only when a row itself claims the opposite.
    if (inventory.size === 0 && rows.some((r) => exactCounter(r.download?.eventCount) && r.download.eventCount > 0)) {
      problems.push({ code: "core-inventory-missing", detail: "rows report observed downloads while no browser core is named as having taken one" });
    }
    for (const t of teardown) {
      if (t.hookErrors?.length) {
        problems.push({ code: "teardown-hook-failed", surface: t.surface, detail: `a teardown hook threw (${t.hookErrors.map((h) => `${h.phase}:${h.name}`).join(", ")})` });
      }
      // A core that observed no download has nothing to stat; one that did must have both sides.
      if (requireCounter(t.downloadCount, "teardown downloadCount", t.surface) && t.downloadCount > 0 && (t.beforeClose !== "ok" || t.afterClose !== "ok")) {
        problems.push({
          code: "teardown-incomplete",
          surface: t.surface,
          detail: `a core that observed ${t.downloadCount} download(s) never completed its teardown observations (before=${t.beforeClose}, after=${t.afterClose})`,
        });
      }
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

/** The literals this run must never emit — used for the report AND for every console line. */
export const FORBIDDEN_LITERALS = [
  { label: "fixture-cookie", value: FIXTURE_COOKIE },
  { label: "fixture-cookie-value", value: "COOKIE-MUST-NOT-BE-REPORTED" },
  { label: "query-string-literal", value: FIXTURE_QUERY },
  { label: "query-string-signature", value: "QUERYSTRING-MUST-NOT-BE-REPORTED" },
  { label: "consumer-token", value: CONSUMER_TOKEN },
  { label: "octet-payload", value: OCTET_BYTES.toString("utf8").trim() },
];

/**
 * The report's own vocabulary: the fixture routes and media types it is SUPPOSED to name. They are
 * blanked before the path patterns run, so `/attachment.pdf` in a fixture problem does not read as a
 * leaked filesystem path. Nothing here is user- or site-controlled — it is a fixed list of tokens
 * this file itself authored.
 */
export const DOCUMENTED_VOCABULARY = [...CASES.map((c) => c.path), "application/octet-stream", "application/pdf", "text/html"];

export function withoutDocumentedVocabulary(serialized) {
  let out = serialized;
  for (const token of DOCUMENTED_VOCABULARY) out = out.split(token).join("<vocab>");
  return out;
}

/**
 * Shape-based leaks — the classes that have no fixed literal to grep for. `scope: "vocab"` patterns
 * run against the vocabulary-blanked text so the harness can still name its own routes; the rest run
 * against the raw text. Absolute paths of EVERY shape are covered, not just temp prefixes: a driver
 * that writes to `/home/node/.cache/...` leaks exactly as completely as one that writes to `/tmp`.
 */
export const STRUCTURAL_FORBIDDEN = [
  { label: "pdf-content", re: /%PDF-/, scope: "raw" },
  { label: "query-string", re: /\?[A-Za-z0-9_.-]+=/, scope: "raw" },
  { label: "playwright-artifact-path", re: /playwright-artifacts|\.playwright/, scope: "raw" },
  { label: "file-url", re: /file:\/\//i, scope: "raw" },
  { label: "absolute-temp-path", re: /(^|[^A-Za-z0-9])(\/tmp\/|\/var\/folders\/|\/var\/tmp\/|\/dev\/shm\/|\/private\/)/, scope: "vocab" },
  // Any POSIX absolute path of two or more segments. One segment is not matched: the fixture's own
  // routes are one segment, and blanking the vocabulary is what keeps them from being matched here.
  { label: "absolute-posix-path", re: /(^|[^A-Za-z0-9_.\\/-])\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+/, scope: "vocab" },
  // `C:\Users\x` and `D:/x`, in raw and JSON-escaped form (JSON.stringify doubles every backslash).
  { label: "windows-absolute-path", re: /(^|[^A-Za-z0-9])[A-Za-z]:(\\{1,2}|\/)[A-Za-z0-9_.$-]/, scope: "vocab" },
  { label: "windows-unc-path", re: /\\{2,4}[A-Za-z0-9_.$-]+\\{1,2}[A-Za-z0-9_.$-]/, scope: "raw" },
];

export function structuralViolations(serialized) {
  const stripped = withoutDocumentedVocabulary(serialized);
  return STRUCTURAL_FORBIDDEN.filter((f) => f.re.test(f.scope === "vocab" ? stripped : serialized)).map((f) => f.label);
}

/**
 * Every line this process prints goes through here. A line that carries a forbidden literal or a
 * forbidden shape is REPLACED by its labels — the hygiene contract covers the whole of stdout, not
 * only the serialized report, because a library detail interpolated into a log line leaks the same
 * way a report field does.
 */
export function scrubLine(line, forbidden = FORBIDDEN_LITERALS) {
  const text = String(line);
  const violations = [...literalViolations(text, forbidden), ...structuralViolations(text)];
  return violations.length === 0 ? text : `  <line withheld by the hygiene guard: ${violations.join(", ")}>`;
}

const emit = (line = "") => {
  console.log(scrubLine(line));
};

/**
 * Wrap a core's teardown so the harness can stat the driver's temp file on BOTH sides of the close
 * without owning the close. Assigning own properties shadows the prototype methods while leaving the
 * instance (its private fields, its `context`/`forceKillAvailable` getters) untouched, so the session
 * manager still drives the real core.
 *
 * It is a state machine over BOTH entry points (`close`, `kill`), because four things must hold:
 *   - `beforeClose` is a BARRIER: every entry point awaits it before touching the real core, so a
 *     concurrent kill cannot delete the temp file before the before-close stat has read it;
 *   - the hooks run exactly ONCE and in order — `beforeClose` before any real teardown, `afterClose`
 *     only once every real teardown in flight has settled — so a close-then-kill sequence cannot
 *     overwrite a before-close reading with an after-close one;
 *   - a hook that THROWS never skips the real teardown and never propagates into the caller's
 *     lifecycle: it is recorded on the returned state, and the validity guard reads it as invalid.
 *     A wedged teardown must not be able to quietly become an `unknown` file reading;
 *   - the barrier is on the HOOKS, not a queue over the real ops. `Session.teardown` abandons a
 *     wedged `core.close()` at the grace deadline and escalates to `core.kill()` (src/gateway/
 *     session.ts). Queueing that kill behind the abandoned close would deadlock the one escalation
 *     path that exists precisely because the close may never resolve.
 */
export function wrapCoreTeardown(core, hooks) {
  let beforeBarrier = null;
  let afterOnce = null;
  let inFlight = 0;
  const tasks = new Set();
  const drain = async () => {
    while (tasks.size) {
      const pending = [...tasks];
      tasks.clear();
      await Promise.all(pending);
    }
  };
  const state = {
    beforeClose: "pending",
    afterClose: "pending",
    hookErrors: [],
    teardownCalls: 0,
    /** Resolves when every teardown started so far has finished, hooks included. */
    settled: drain,
  };
  const runHook = async (phase) => {
    try {
      await hooks[phase]();
      state[phase] = "ok";
    } catch (err) {
      state[phase] = "failed";
      state.hookErrors.push({ phase, ...sanitizeFailure(err) });
    }
  };
  const run = (real, args) => {
    state.teardownCalls += 1;
    const task = (async () => {
      if (!beforeBarrier) beforeBarrier = runHook("beforeClose");
      await beforeBarrier;
      inFlight += 1;
      try {
        return await real(...args);
      } finally {
        inFlight -= 1;
        if (inFlight === 0 && !afterOnce) afterOnce = runHook("afterClose");
        // The caller's teardown resolves only once the after-close reading has been taken.
        if (afterOnce) await afterOnce;
      }
    })();
    tasks.add(task.then(() => {}, () => {}));
    return task;
  };
  const realClose = core.close.bind(core);
  const realKill = typeof core.kill === "function" ? core.kill.bind(core) : undefined;
  core.close = (...args) => run(realClose, args);
  if (realKill) core.kill = (...args) => run(realKill, args);
  return state;
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
  if (new Set(picked).size !== picked.length) throw new Error("duplicate BGW_EID_MEASURE_SURFACES entry");
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
 * Bind with an error path and a bound. `server.listen(port, host, cb)` alone reports a failed bind
 * as an unhandled `error` event — which, in a harness that must fail closed, is the worst possible
 * shape. The rejection carries the errno CODE only; a bind message can name a path.
 */
export function listenBounded(server, port, host, timeoutMs = FIXTURE_LISTEN_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      server.removeListener("error", onError);
      fn(arg);
    };
    const onError = (err) => finish(reject, new Error(`fixture listen failed: ${err?.code ?? "unknown"}`));
    const timer = setTimeout(() => finish(reject, new Error("fixture listen failed: timeout")), timeoutMs);
    server.once("error", onError);
    server.listen(port, host, () => finish(resolve, undefined));
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
  if (actual.error) problems.push(`${expected.path}: request ${actual.error}`);
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

/**
 * One self-check request, bounded on both axes: a stalled loopback socket resolves as `timeout` and
 * a refused one as `request-error`. A measurement that can hang forever is not reproducible, and a
 * fixture probe is the one place where "wait indefinitely" is never the right answer.
 */
export function probeRoute(base, path, { timeoutMs = FIXTURE_REQUEST_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        req.destroy();
      } catch {
        // destroy() on an already-dead socket is not a measurement problem.
      }
      finish({ status: null, contentType: null, disposition: null, error: "timeout" });
    }, timeoutMs);
    const req = http.get(`${base}${path}?${FIXTURE_QUERY}`, (res) => {
      res.resume(); // drain: the bytes are not needed and must not be buffered into this process
      finish({ status: res.statusCode, contentType: res.headers["content-type"], disposition: res.headers["content-disposition"], error: null });
    });
    req.on("error", () => finish({ status: null, contentType: null, disposition: null, error: "request-error" }));
  });
}

/** Fetch each route over plain HTTP — no browser — and check it against its expectation. */
async function selfCheckFixture(base) {
  const problems = [];
  for (const expected of FIXTURE_EXPECTATIONS) {
    problems.push(...fixtureRouteProblems(expected, await probeRoute(base, expected.path)));
  }
  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------------------------
// Observation apparatus
// ---------------------------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Observe an async operation without conflating success, rejection, and timeout. */
export async function observeWithin(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise).then(
        (value) => ({ status: "fulfilled", value }),
        () => ({ status: "rejected", value: undefined }),
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ status: "timed-out", value: undefined }), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Establish the event-source barrier before snapshotting asynchronous download records.
 * Exported so the exact teardown-window race has a regression test.
 */
export async function settleAfterTeardown(teardownPromises, snapshotDownloadPromises, timeoutMs) {
  const teardownObserved = await observeWithin(Promise.all(teardownPromises), timeoutMs);
  if (teardownObserved.status !== "fulfilled") return { status: "teardown-failed" };
  const downloadObserved = await observeWithin(Promise.all(snapshotDownloadPromises()), timeoutMs);
  return downloadObserved.status === "fulfilled" ? { status: "fulfilled" } : { status: "downloads-failed" };
}

const CLOSED_FAILURE_CLASSES = new Set([
  null,
  "anti-bot-block",
  "captcha",
  "hard-block",
  "empty-shell",
  "hydration-failed",
  "real-zero-results",
  "unsupported-browser",
  "nav-failed",
  "owner-host-mismatch",
  "policy-blocked",
  "burned-exit",
  "timeout",
  "ok",
]);
const CLOSED_BLOCK_REASONS = new Set([null, "anti-bot", "captcha", "hard-block", "nav-failed", "policy-blocked", "timeout"]);

/** Runtime boundary for values TypeScript only proves statically. */
export function closedValue(value, allowed) {
  return allowed.has(value) ? value : "unknown";
}

/**
 * Read the two SITE-controlled accessors defensively. Each is called inside its own boundary and the
 * failure is REPORTED, because the alternative — the old outer try/catch around record construction —
 * dropped the whole event when an accessor threw on a torn-down page, and a dropped event is
 * indistinguishable from "no download happened".
 */
export function readDownloadIdentity(dl) {
  let redactedUrl = null;
  let suggestedFilenameRaw = null;
  let accessorError = false;
  try {
    redactedUrl = redactUrl(dl.url());
  } catch {
    accessorError = true;
  }
  try {
    // Snapshot the site-controlled property exactly once, then invoke that exact accepted callable
    // without consulting caller-controlled `.call`. A stateful getter previously supplied one
    // callable to `typeof` and a different one to the method call below it.
    const suggestedFilename = dl.suggestedFilename;
    suggestedFilenameRaw = typeof suggestedFilename === "function" ? Reflect.apply(suggestedFilename, dl, []) : "";
  } catch {
    accessorError = true;
  }
  return { redactedUrl, suggestedFilenameRaw, accessorError };
}

/**
 * Stat one side of the teardown. A stat that THROWS — the file vanished between the existence check
 * and the stat, the path became unreadable — is an explicit `error`, never a silent `absent`: the
 * whole point of this reading is whether the file survives the close, so a failed look must not be
 * reported as a look that found nothing.
 */
export function probeTempFile(absolutePath, fs = { existsSync, statSync }) {
  try {
    if (!fs.existsSync(absolutePath)) return { exists: false, nonEmpty: false, error: false };
    return { exists: true, nonEmpty: fs.statSync(absolutePath).size > 0, error: false };
  } catch {
    return { exists: null, nonEmpty: null, error: true };
  }
}

/**
 * Watches every core the run creates. Attaches `page.on("download")` through the core's public
 * `context` getter and stats the driver's temp file on both sides of the teardown — passively: it
 * navigates nothing, cancels nothing, and saves nothing.
 *
 * Every event lands in ONE persistent ledger tagged with its core (and therefore its surface); no
 * leg ever slices it. `beginSurface()` names the surface a core created next belongs to, which is
 * how a core the gateway factory builds mid-call is attributed without the gateway knowing anything
 * about this harness.
 */
function createObserver(fault) {
  const records = [];
  const cores = [];
  let coreSeq = 0;
  let currentSurface = null;
  const counters = { statErrors: 0, accessorErrors: 0, settleErrors: 0 };

  const capture = (dl, coreId, surface) => {
    // The record is pushed BEFORE anything site-controlled is read, so an accessor that throws
    // leaves an unattributable record (which invalidates the run) instead of no record at all.
    const record = {
      coreId,
      surface,
      redactedUrl: null,
      suggestedFilenameRaw: null,
      accessorError: false,
      forged: false,
      pathKnown: false,
      reportedFailure: "unknown",
      existsBeforeClose: null,
      existsAfterClose: null,
      sizeMatchesServed: null,
      statError: false,
      settleError: false,
      // The absolute path stays HERE and never reaches a row (except under the leak-temp-path
      // fault, which exists to prove the hygiene guard notices).
      absolutePath: null,
      settled: null,
    };
    records.push(record);
    const identity = readDownloadIdentity(dl);
    record.redactedUrl = identity.redactedUrl;
    record.suggestedFilenameRaw = identity.suggestedFilenameRaw;
    record.accessorError = identity.accessorError;
    if (identity.accessorError) counters.accessorErrors += 1;
    record.settled = (async () => {
      const call = async (fn, fallback) => {
        try {
          const observed = await observeWithin(Promise.resolve(fn()), DOWNLOAD_SETTLE_MS);
          if (observed.status === "fulfilled") return observed.value;
          record.settleError = true;
          counters.settleErrors += 1;
          return fallback;
        } catch {
          record.settleError = true;
          counters.settleErrors += 1;
          return fallback;
        }
      };
      const failure = await call(() => dl.failure(), "unknown");
      record.reportedFailure = failure === "unknown" ? "unknown" : failure === null ? false : true;
      const p = await call(() => dl.path(), undefined);
      if (typeof p === "string" && p.length > 0) {
        record.pathKnown = true;
        record.absolutePath = p;
      }
    })();
    return record;
  };

  const statSide = (side, coreId) => {
    for (const d of records) {
      if (d.coreId !== coreId || !d.pathKnown || d.forged) continue;
      if (side === "before" ? d.existsBeforeClose !== null : d.existsAfterClose !== null) continue;
      const probe = probeTempFile(d.absolutePath);
      if (probe.error) {
        if (!d.statError) counters.statErrors += 1;
        d.statError = true;
        continue;
      }
      if (side === "before") {
        d.existsBeforeClose = probe.exists;
        d.sizeMatchesServed = probe.nonEmpty;
      } else {
        d.existsAfterClose = probe.exists;
      }
    }
  };

  return {
    records,
    get coreCount() {
      return cores.length;
    },
    get statErrors() {
      return counters.statErrors;
    },
    get accessorErrors() {
      return counters.accessorErrors;
    },
    get settleErrors() {
      return counters.settleErrors;
    },
    coresOnSurface(surface) {
      return cores.filter((c) => c.surface === surface).length;
    },
    /** Name the surface that owns every core created from here on. */
    beginSurface(surface) {
      currentSurface = surface;
    },
    /** Attach to a real core. Returns the core so it can be used as a CoreFactory tail call. */
    observe(core) {
      const coreId = ++coreSeq;
      const surface = currentSurface;
      const context = core.context;
      const wirePage = (page) => {
        if (fault.forgeDownload) {
          // FAULT: synthesize a download on every NAVIGATION — including the HTML control's, which
          // is what makes the negative control the arm that catches an over-firing observer. (Per
          // page would forge only on `about:blank`, which files against no case at all.)
          page.on("domcontentloaded", () => {
            records.push({
              coreId,
              surface,
              redactedUrl: redactUrl(page.url() || "http://forged.invalid/"),
              suggestedFilenameRaw: "forged.bin",
              accessorError: false,
              forged: true,
              pathKnown: false,
              reportedFailure: "unknown",
              existsBeforeClose: null,
              existsAfterClose: null,
              sizeMatchesServed: null,
              statError: false,
              settleError: false,
              absolutePath: null,
              settled: Promise.resolve(),
            });
          });
        }
        if (fault.muteObserver) return; // FAULT: deaf apparatus — the positive control must catch it.
        page.on("download", (dl) => capture(dl, coreId, surface));
      };
      for (const page of context.pages()) wirePage(page);
      context.on("page", wirePage);
      const teardown = wrapCoreTeardown(core, {
        beforeClose: async () => {
          const observed = await observeWithin(
            Promise.all(records.filter((d) => d.coreId === coreId && d.settled).map((d) => d.settled)),
            DOWNLOAD_SETTLE_MS + 1_000,
          );
          if (observed.status !== "fulfilled") throw new Error("download settle barrier failed");
          statSide("before", coreId);
        },
        afterClose: async () => {
          statSide("after", coreId);
        },
      });
      cores.push({ coreId, surface, teardown });
      return core;
    },
    /** The per-core teardown observations, as the validity guard reads them. */
    teardownStates() {
      return cores.map((c) => ({
        coreId: c.coreId,
        surface: c.surface,
        beforeClose: c.teardown.beforeClose,
        afterClose: c.teardown.afterClose,
        hookErrors: c.teardown.hookErrors,
        downloadCount: records.filter((r) => r.coreId === c.coreId).length,
      }));
    },
    /**
     * Close every observed core first. Context closure is the event-source barrier: after all teardown
     * promises resolve, no page can emit another download event. Only THEN snapshot and await the
     * ledger. Constructing both Promise.all values before the first await reopens the race this method
     * exists to close.
     */
    async settleAll() {
      const observed = await settleAfterTeardown(
        cores.map((c) => c.teardown.settled()),
        () => records.filter((d) => d.settled).map((d) => d.settled),
        DOWNLOAD_SETTLE_MS + 1_000,
      );
      if (observed.status !== "fulfilled") counters.settleErrors += 1;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------------------------

const CHANNEL = process.env.BGW_CHANNEL ?? "chrome";
const NO_SANDBOX = process.env.BGW_NO_SANDBOX === "1";
const HEADLESS = process.env.BGW_HEADLESS === "1"; // the container runs headful under Xvfb

/**
 * One row per (surface × case), in the shape both the table and the JSON block read. It carries NO
 * download records — the ledger holds those, and {@link finalizeRows} fills `download` once every
 * core has closed. That is also why no absolute path can reach the report: a row has no field for
 * one, by construction.
 *
 * `navigationEvidence` is the row's proof that the leg actually happened: the guard saw a request
 * for this path (browser), or the policy layer audited a navigate decision (retrieve/drive). A row
 * without it is a row about nothing, and the validity guard rejects the whole reading.
 */
function makeRow(surface, testCase, nav, navigationEvidence, cores, guard, elapsedMs) {
  return {
    surface,
    case: testCase.id,
    role: testCase.role,
    nav,
    navigationEvidence,
    download: null,
    guard,
    coresObserved: cores.observed,
    coresLaunchedDuringLeg: cores.launchedDuringLeg,
    elapsedMs: Math.round(elapsedMs),
  };
}

/** Everything a thrown navigation may contribute, with no free text. */
function navFromError(err) {
  const sanitized = sanitizeFailure(err);
  return {
    outcome: "threw",
    status: null,
    errorName: sanitized.name,
    errorMarker: sanitized.marker,
    failureClass: closedValue(failureOf(err)?.failureClass ?? null, CLOSED_FAILURE_CLASSES),
  };
}

async function runBrowserSurface({ base, observer, rows }) {
  observer.beginSurface("browser");
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
  try {
    for (const testCase of CASES) {
      const guardAt = guardLog.length;
      const coresAt = observer.coresOnSurface("browser");
      const t0 = performance.now();
      let nav;
      try {
        const r = await core.render(`${base}${testCase.path}?${FIXTURE_QUERY}`, { clearanceTimeoutMs: CLEARANCE_TIMEOUT_MS });
        nav = { outcome: "returned", status: r.status, responseReceived: r.responseReceived ?? null, textLength: r.text.length, htmlLength: r.html.length, failureClass: null };
      } catch (err) {
        nav = navFromError(err);
      }
      const elapsed = performance.now() - t0;
      await sleep(LEG_SETTLE_MS); // courtesy, not a boundary: attribution happens at report time
      const hops = guardLog.slice(guardAt);
      const sawThisPath = hops.some((h) => pathnameOf(h.path) === testCase.path);
      rows.push(
        makeRow(
          "browser",
          testCase,
          nav,
          sawThisPath,
          { observed: observer.coresOnSurface("browser"), launchedDuringLeg: observer.coresOnSurface("browser") - coresAt },
          { sawNavigationRequest: hops.some((h) => h.isNavigationRequest && pathnameOf(h.path) === testCase.path), requestsSeen: hops.length },
          elapsed,
        ),
      );
    }
  } finally {
    await core.close().catch(() => {});
  }
}

async function runRetrieveSurface({ base, gateway, secrets, audit, observer, rows, timeouts }) {
  observer.beginSurface("retrieve");
  for (const testCase of CASES) {
    const auditAt = audit.records.length;
    const coresAt = observer.coresOnSurface("retrieve");
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
        // Runtime-normalized closed vocabularies: malformed values collapse to `unknown`.
        blockReason: closedValue(r.reason ?? null, CLOSED_BLOCK_REASONS),
        degraded: r.degraded,
        markdownLength: r.markdown.length,
        failureClass: closedValue(r.diagnostics?.failureClass ?? null, CLOSED_FAILURE_CLASSES),
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
        decisions.length > 0,
        { observed: observer.coresOnSurface("retrieve"), launchedDuringLeg: observer.coresOnSurface("retrieve") - coresAt },
        { guardAllows: decisions.filter((d) => d.decision === "allow").length, guardBlocks: decisions.filter((d) => d.decision === "block").length },
        elapsed,
      ),
    );
  }
}

async function runDriveSurface({ base, gateway, secrets, audit, observer, rows, timeouts }) {
  observer.beginSurface("drive");
  const drive = new GatewayDriveController(gateway, secrets, CONSUMER_TOKEN, { timeouts });
  try {
    for (const testCase of CASES) {
      const auditAt = audit.records.length;
      const coresAt = observer.coresOnSurface("drive");
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
          decisions.length > 0,
          // A drive session discarded mid-run (the controller's failure path) launches a replacement
          // core; `launchedDuringLeg` is how that shows up in the reading.
          { observed: observer.coresOnSurface("drive"), launchedDuringLeg: observer.coresOnSurface("drive") - coresAt },
          { guardAllows: decisions.filter((d) => d.decision === "allow").length, guardBlocks: decisions.filter((d) => d.decision === "block").length },
          elapsed,
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
  emit(line(head));
  emit(line(widths.map((w) => "-".repeat(w))));
  for (const b of body) emit(line(b));
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

export async function main() {
  const fault = resolveFault(process.env.BGW_EID_MEASURE_FAULT);
  const surfaces = resolveSurfaces(process.env.BGW_EID_MEASURE_SURFACES);

  emit("=== browse-gateway :: EID download behaviour MEASUREMENT (task 0) ===");
  emit(`  surfaces=${surfaces.join(",")} fault=${fault.mode} channel=${CHANNEL} headless=${HEADLESS}`);
  emit("  measures only — no download capture is implemented by this script\n");
  if (fault.mode !== "none") emit(`  !! FAULT INJECTION ACTIVE (${fault.mode}) — this run is expected to report INVALID\n`);

  const server = createFixtureServer({ breakFixture: fault.breakFixture });
  await listenBounded(server, 0, FIXTURE_HOST);
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
  const cleanupErrors = [];

  try {
    fixture = await selfCheckFixture(base);
    emit(`  fixture self-check: ${fixture.ok ? "OK" : "FAILED"}`);
    for (const p of fixture.problems) emit(`    - ${p}`);

    // A fixture that does not serve the shapes under test cannot produce a meaningful reading, so
    // the browsers are never launched. (This is the break-fixture fault's fast RED path.)
    if (fixture.ok) {
      if (surfaces.includes("browser")) await runBrowserSurface({ base, observer, rows });
      if (surfaces.includes("retrieve")) await runRetrieveSurface({ base, gateway, secrets, audit, observer, rows, timeouts });
      if (surfaces.includes("drive")) await runDriveSurface({ base, gateway, secrets, audit, observer, rows, timeouts });
    } else {
      emit("  (browsers not launched — a drifted fixture cannot produce a meaningful reading)");
    }
  } finally {
    const shutdown = await observeWithin(gateway.shutdown(), DOWNLOAD_SETTLE_MS + 1_000);
    if (shutdown.status !== "fulfilled") cleanupErrors.push("gateway-shutdown");
    // Only now is every session closed, so this is the barrier: teardown hooks finished, downloads
    // settled. Attribution happens strictly after it.
    await observer.settleAll();
    const fixtureClose = await observeWithin(
      new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
      FIXTURE_REQUEST_TIMEOUT_MS,
    );
    if (fixtureClose.status !== "fulfilled") cleanupErrors.push("fixture-close");
  }

  const attribution = finalizeRows(rows, observer.records, fault);
  const finalRows = attribution.rows;
  const teardown = observer.teardownStates();
  const validity = measurementValidity(finalRows, fixture, {
    surfaces,
    unattributedDownloads: attribution.unattributed,
    headless: HEADLESS,
    statErrors: observer.statErrors,
    accessorErrors: observer.accessorErrors,
    settleErrors: observer.settleErrors,
    teardown,
    downloadCoreIds: [...new Set(observer.records.map((record) => record.coreId))],
    cleanupErrors,
  });
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
    ledger: {
      events: observer.records.length,
      unattributed: attribution.unattributed,
      statErrors: observer.statErrors,
      accessorErrors: observer.accessorErrors,
      settleErrors: observer.settleErrors,
    },
    teardown,
    cleanupErrors,
    validity,
  };

  const serialized = JSON.stringify(report, null, 2);
  const hygiene = [...literalViolations(serialized, FORBIDDEN_LITERALS), ...structuralViolations(serialized)];

  if (finalRows.length) {
    emit("");
    printTable(finalRows);
  }

  emit("");
  emit("  observations:");
  for (const r of finalRows.filter((x) => x.role === "measured")) {
    emit(
      `    ${r.surface}/${r.case}: nav=${r.nav.outcome}(${r.nav.status ?? "null"}) download=${YES_NO(r.download.eventCount > 0)} ` +
        `filename=${r.download.suggestedFilename ?? "—"} tempBeforeClose=${r.download.tempFileBeforeClose ?? "—"} tempAfterClose=${r.download.tempFileAfterClose ?? "—"}`,
    );
  }

  emit("");
  emit(`  ledger: ${observer.records.length} download event(s), ${attribution.unattributed} unattributed, ` +
    `${observer.statErrors} stat / ${observer.accessorErrors} accessor / ${observer.settleErrors} settle failure(s)`);
  emit(`  hygiene guard: ${hygiene.length === 0 ? "clean" : `VIOLATED [${hygiene.join(", ")}]`}`);
  emit(`  validity guard: ${validity.valid ? "valid" : "INVALID"}`);
  for (const p of validity.problems) emit(`    - ${p.code}${p.surface ? ` (${p.surface})` : ""}: ${p.detail}`);

  const ok = validity.valid && hygiene.length === 0;
  if (process.env.BGW_EID_MEASURE_JSON !== "0" && hygiene.length === 0) {
    emit("\n--- BEGIN EID-DOWNLOAD-MEASUREMENT JSON ---");
    for (const line of serialized.split("\n")) emit(line);
    emit("--- END EID-DOWNLOAD-MEASUREMENT JSON ---");
  } else if (hygiene.length > 0) {
    emit("\n  (JSON withheld — the hygiene guard refuses to print a report that carries forbidden content)");
  }

  emit(`\n=== EID DOWNLOAD MEASUREMENT: ${ok ? "VALID ✅ (a reading, not a pass/fail gate)" : "INVALID ❌ — do not use these numbers"} ===`);
  return ok ? 0 : 1;
}

/**
 * Fail closed, and say so in the only shape this harness is allowed to speak: a validated error name
 * and a closed-vocabulary marker. An uncaught throw from browser creation, fixture startup, observer
 * setup or teardown would otherwise let Node print a stack — and a driver's message interpolates the
 * requested URL, the query string and its own temp paths.
 */
function reportAbort(stage, err) {
  const s = sanitizeFailure(err);
  emit("");
  emit(`  !! measurement ABORTED during ${stage}: ${s.name} / ${s.marker} (no further detail is printable under the hygiene contract)`);
  emit("=== EID DOWNLOAD MEASUREMENT: INVALID ❌ — do not use these numbers ===");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.on("uncaughtException", (err) => {
    reportAbort("uncaught-exception", err);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    reportAbort("unhandled-rejection", reason);
    process.exit(1);
  });
  let code = 1;
  try {
    code = await main();
  } catch (err) {
    reportAbort("main", err);
    code = 1;
  }
  process.exit(code);
}
