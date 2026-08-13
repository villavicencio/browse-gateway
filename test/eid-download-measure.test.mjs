/**
 * Unit tests for the EID download MEASUREMENT harness (scripts/measure-eid-download.mjs).
 *
 * These cover the harness's own logic — redaction, the filename safety gate, the three-valued
 * temp-file reading, the closed-vocabulary error marker, the persistent download ledger and its
 * attribution, the fixture self-check, the serialized teardown state machine, and BOTH guards
 * (validity + hygiene). They do NOT launch a browser: what Chrome does with a PDF is measured by the
 * in-container run, and a unit test asserting it would be a stub guaranteeing its own answer
 * (docs/solutions/best-practices/a-test-whose-stub-guarantees-the-assertion-proves-nothing.md).
 *
 * Every guard arm is tested in BOTH directions — a green-only test of a guard proves the guard can
 * say yes, which is not the property that matters.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import {
  redactUrl,
  pathnameOf,
  safeFilename,
  tempFileState,
  errorMarker,
  sanitizeFailure,
  observeWithin,
  closedValue,
  downloadsForCase,
  attributeLedger,
  finalizeRows,
  downloadBlock,
  probeTempFile,
  readDownloadIdentity,
  measurementValidity,
  literalViolations,
  structuralViolations,
  withoutDocumentedVocabulary,
  scrubLine,
  wrapCoreTeardown,
  resolveFault,
  resolveSurfaces,
  fixtureRouteProblems,
  createFixtureServer,
  listenBounded,
  probeRoute,
  FIXTURE_EXPECTATIONS,
  POSITIVE_CONTROL,
  NEGATIVE_CONTROL,
  CASES,
  FAULT_MODES,
} from "../scripts/measure-eid-download.mjs";

const NO_FAULT = resolveFault("none");

// --- redaction ---------------------------------------------------------------------------------

test("redactUrl drops the query string, fragment and credentials", () => {
  assert.equal(redactUrl("http://127.0.0.1:8080/a.pdf?doc=1&sig=SECRET"), "http://127.0.0.1:8080/a.pdf");
  assert.equal(redactUrl("https://x.test/a.pdf#frag"), "https://x.test/a.pdf");
  assert.equal(redactUrl("https://user:pw@x.test/a.pdf"), "https://x.test/a.pdf");
});

test("redactUrl returns a marker — never the input — for an unparseable URL", () => {
  // Echoing the raw string back is how the value you refused to print gets printed.
  assert.equal(redactUrl("not a url?sig=SECRET"), "<unparseable-url>");
  assert.equal(redactUrl(undefined), "<unparseable-url>");
});

test("pathnameOf returns the EXACT parsed pathname, and null when there is none", () => {
  assert.equal(pathnameOf("http://127.0.0.1:8080/attachment.pdf"), "/attachment.pdf");
  // A suffix match would file this against `/attachment.pdf`; an exact pathname will not.
  assert.equal(pathnameOf("http://127.0.0.1:8080/decoy/attachment.pdf"), "/decoy/attachment.pdf");
  assert.equal(pathnameOf("<unparseable-url>"), null);
  assert.equal(pathnameOf(null), null);
});

// --- filename safety gate ----------------------------------------------------------------------

test("safeFilename accepts a plain basename", () => {
  assert.deepEqual(safeFilename("eid-statement.pdf"), { safe: true, value: "eid-statement.pdf", reason: null });
});

test("safeFilename withholds every hostile shape with a typed reason", () => {
  const cases = [
    ["", "absent"],
    [undefined, "absent"],
    ["../../etc/passwd", "path-separator"],
    ["a\\b.pdf", "path-separator"],
    ["ok\0.pdf", "nul-byte"],
    ["..", "dot-segment"],
    ["a".repeat(129), "too-long"],
    ["résumé.pdf", "unsafe-characters"],
    ["file name.pdf", "unsafe-characters"],
    [".hidden", "unsafe-characters"], // must start alphanumeric
    ["a\nb.pdf", "unsafe-characters"],
  ];
  for (const [raw, reason] of cases) {
    const got = safeFilename(raw);
    assert.equal(got.safe, false, `expected ${JSON.stringify(raw)} to be withheld`);
    assert.equal(got.value, null, "a withheld filename must carry no value");
    assert.equal(got.reason, reason);
  }
});

// --- three-valued temp-file reading -------------------------------------------------------------

test("tempFileState reports unknown when no path was ever resolved", () => {
  // The distinction is the point: "we could not look" must not read as "the file is gone".
  assert.equal(tempFileState(false, false), "unknown");
  assert.equal(tempFileState(false, true), "unknown");
  assert.equal(tempFileState(true, true), "present");
  assert.equal(tempFileState(true, false), "absent");
});

// --- closed-vocabulary error marker --------------------------------------------------------------

test("errorMarker reduces a message to a closed vocabulary and never echoes it", () => {
  assert.equal(errorMarker("page.goto: net::ERR_ABORTED at http://x/a.pdf?sig=SECRET"), "net::ERR_ABORTED");
  assert.equal(errorMarker("Timeout 15000ms exceeded"), "Timeout");
  assert.equal(errorMarker(""), "none");
  assert.equal(errorMarker(undefined), "none");
  const other = errorMarker("something novel happened at http://x/a.pdf?sig=SECRET");
  assert.equal(other, "other", "an unrecognized message must collapse to `other`, not pass through");
  assert.ok(!other.includes("SECRET"));
});

test("sanitizeFailure carries a name and a marker — never a message, path or URL", () => {
  const err = new TypeError("Cannot read /tmp/pw-out/xyz/eid.pdf from http://h/a.pdf?sig=SECRET");
  const s = sanitizeFailure(err);
  assert.equal(s.name, "TypeError");
  assert.equal(s.marker, "other");
  const text = JSON.stringify(s);
  assert.ok(!text.includes("SECRET"), text);
  assert.ok(!text.includes("/tmp/"), text);
  assert.deepEqual(structuralViolations(text), []);

  // A non-Error throw, and a hostile `name`, must both collapse to a token.
  assert.equal(sanitizeFailure("/tmp/leak?sig=SECRET").name, "non-error-throw");
  const hostile = new Error("boom");
  hostile.name = "Err /tmp/leak?sig=SECRET";
  assert.equal(sanitizeFailure(hostile).name, "unsafe-error-name");
});

// --- per-case attribution: the persistent ledger ----------------------------------------------------

const rec = (surface, url, extra = {}) => ({
  coreId: 1,
  surface,
  redactedUrl: url,
  suggestedFilenameRaw: "eid-statement.pdf",
  accessorError: false,
  forged: false,
  pathKnown: false,
  reportedFailure: "unknown",
  existsBeforeClose: null,
  existsAfterClose: null,
  sizeMatchesServed: null,
  statError: false,
  settleError: false,
  absolutePath: null,
  ...extra,
});

const legRow = (surface, caseId) => ({
  surface,
  case: caseId,
  role: CASES.find((c) => c.id === caseId)?.role ?? "measured",
  nav: { outcome: "returned", status: 200, failureClass: null },
  navigationEvidence: true,
  guard: {},
  coresObserved: 1,
  coresLaunchedDuringLeg: 0,
  elapsedMs: 1,
});

const allRows = (surface) => CASES.map((c) => legRow(surface, c.id));

test("downloadsForCase attributes by EXACT parsed pathname, not by suffix", () => {
  const downloads = [
    rec("browser", "http://127.0.0.1:1/control.bin"),
    rec("browser", "http://127.0.0.1:1/attachment.pdf"),
    rec("browser", "http://127.0.0.1:1/attachment.pdf"),
    rec("browser", "http://127.0.0.1:1/decoy/attachment.pdf"),
  ];
  assert.equal(downloadsForCase(downloads, "/attachment.pdf").length, 2);
  assert.equal(downloadsForCase(downloads, "/control.bin").length, 1);
  assert.equal(downloadsForCase(downloads, "/inline.pdf").length, 0);
});

test("a download arriving AFTER its own leg — and after later legs — still lands in its own row", () => {
  // The race the leg-slice design lost: the attachment transfer finishes after its navigation
  // returned, after the html leg ran, and after the octet leg ran. Arrival order must not decide.
  const rows = allRows("browser");
  const ledger = [
    rec("browser", "http://127.0.0.1:1/control.bin"),
    rec("browser", "http://127.0.0.1:1/attachment.pdf"), // LATE
  ];
  const { rows: final, unattributed } = finalizeRows(rows, ledger, NO_FAULT);
  assert.equal(final.find((r) => r.case === "attachment-pdf").download.eventCount, 1, "the late event must be in its own row");
  assert.equal(final.find((r) => r.case === "octet-attachment-control").download.eventCount, 1);
  assert.equal(final.find((r) => r.case === "html-control").download.eventCount, 0, "a late event must not be filed against a later leg");
  assert.equal(unattributed, 0);
});

test("attribution is per (surface, case) — a late event cannot cross into another surface's row", () => {
  const rows = [...allRows("browser"), ...allRows("drive")];
  const ledger = [rec("drive", "http://127.0.0.1:1/attachment.pdf")];
  const { rows: final } = finalizeRows(rows, ledger, NO_FAULT);
  assert.equal(final.find((r) => r.surface === "drive" && r.case === "attachment-pdf").download.eventCount, 1);
  assert.equal(final.find((r) => r.surface === "browser" && r.case === "attachment-pdf").download.eventCount, 0);
});

test("a record that cannot be attributed is COUNTED, never dropped", () => {
  const rows = allRows("browser");
  const ledger = [
    rec("browser", "<unparseable-url>"), // an accessor that threw leaves no URL to file on
    rec("browser", "http://127.0.0.1:1/somewhere-else"),
    rec("retrieve", "http://127.0.0.1:1/attachment.pdf"), // no row for that surface in this run
    rec("browser", "http://127.0.0.1:1/attachment.pdf", { accessorError: true }),
  ];
  const { unattributed } = finalizeRows(rows, ledger, NO_FAULT);
  assert.equal(unattributed, 4);
  const { unattributed: clean } = finalizeRows(rows, [rec("browser", "http://127.0.0.1:1/attachment.pdf")], NO_FAULT);
  assert.equal(clean, 0, "the counter must be able to say zero, or it proves nothing");
});

test("attributeLedger keys by surface and case id", () => {
  const { byKey, unattributed } = attributeLedger([
    rec("browser", "http://127.0.0.1:1/inline.pdf"),
    rec("browser", "http://127.0.0.1:1/nope.pdf"),
  ]);
  assert.equal(byKey.get("browser\u0000inline-pdf").length, 1);
  assert.equal(unattributed.length, 1);
});

// --- honest aggregation of multiple records ---------------------------------------------------------

test("downloadBlock aggregates multiple records honestly instead of reporting the first", () => {
  const a = rec("browser", "http://127.0.0.1:1/attachment.pdf", {
    suggestedFilenameRaw: "one.pdf",
    pathKnown: true,
    existsBeforeClose: true,
    existsAfterClose: false,
    sizeMatchesServed: true,
    reportedFailure: false,
  });
  const b = rec("browser", "http://127.0.0.1:1/attachment.pdf", {
    suggestedFilenameRaw: "two.pdf",
    pathKnown: true,
    existsBeforeClose: false,
    existsAfterClose: false,
    sizeMatchesServed: false,
    reportedFailure: true,
  });
  const block = downloadBlock([a, b], NO_FAULT);
  assert.equal(block.eventCount, 2);
  assert.equal(block.suggestedFilename, null, "two different filenames must not be reported as one");
  assert.equal(block.filenameWithheldReason, "multiple-distinct");
  assert.equal(block.tempFileBeforeClose, "mixed", "disagreeing records must read `mixed`, not the first record's value");
  assert.equal(block.tempFileAfterClose, "absent", "records that agree still read as one value");
  assert.equal(block.tempFileNonEmpty, "mixed");
  assert.equal(block.reportedFailure, "mixed");

  const single = downloadBlock([a], NO_FAULT);
  assert.equal(single.suggestedFilename, "one.pdf");
  assert.equal(single.tempFileBeforeClose, "present");
  assert.equal(single.tempFileAfterClose, "absent");
});

test("downloadBlock reports an observation failure rather than a confident reading", () => {
  const broken = rec("browser", "http://127.0.0.1:1/attachment.pdf", { pathKnown: true, statError: true, existsBeforeClose: null });
  const block = downloadBlock([broken], NO_FAULT);
  assert.equal(block.tempFileBeforeClose, "unknown");
  assert.equal(block.statErrors, 1);
  assert.equal(downloadBlock([rec("browser", "http://127.0.0.1:1/attachment.pdf", { settleError: true })], NO_FAULT).settleErrors, 1);
});

// --- stat / accessor failures are explicit, never swallowed --------------------------------------------

test("probeTempFile turns a throwing stat into an explicit error, not an `absent` reading", () => {
  const gone = probeTempFile("/x", { existsSync: () => true, statSync: () => { throw new Error("ENOENT /tmp/pw/x"); } });
  assert.deepEqual(gone, { exists: null, nonEmpty: null, error: true });
  const missing = probeTempFile("/x", { existsSync: () => false, statSync: () => { throw new Error("unreachable"); } });
  assert.deepEqual(missing, { exists: false, nonEmpty: false, error: false });
  const present = probeTempFile("/x", { existsSync: () => true, statSync: () => ({ size: 12 }) });
  assert.deepEqual(present, { exists: true, nonEmpty: true, error: false });
  const throwsExists = probeTempFile("/x", { existsSync: () => { throw new Error("EACCES"); }, statSync: () => ({ size: 1 }) });
  assert.equal(throwsExists.error, true);
});

test("readDownloadIdentity preserves the record when a site-controlled accessor throws", () => {
  const ok = readDownloadIdentity({ url: () => "http://h/a.pdf?sig=SECRET", suggestedFilename: () => "a.pdf" });
  assert.deepEqual(ok, { redactedUrl: "http://h/a.pdf", suggestedFilenameRaw: "a.pdf", accessorError: false });

  const dead = readDownloadIdentity({
    url: () => { throw new Error("Target page, context or browser has been closed"); },
    suggestedFilename: () => { throw new Error("closed"); },
  });
  assert.equal(dead.accessorError, true, "a throwing accessor must be recorded, not silently drop the event");
  assert.equal(dead.redactedUrl, null);
  assert.equal(dead.suggestedFilenameRaw, null);
});

// --- the validity guard, in both directions --------------------------------------------------------

const row = (surface, caseId, eventCount, over = {}) => ({
  ...legRow(surface, caseId),
  download: { eventCount },
  ...over,
});

/** A reading in which every arm is satisfied: the control fired, the page did not, a core was seen. */
const healthyRows = () => [
  row("browser", POSITIVE_CONTROL, 1),
  row("browser", NEGATIVE_CONTROL, 0),
  row("browser", "attachment-pdf", 1),
  row("browser", "inline-pdf", 0),
];

const okFixture = { ok: true, problems: [] };

/** Everything the guard needs that is NOT a row. Fail-closed: each field must be stated. */
const env = (over = {}) => ({
  surfaces: ["browser"],
  unattributedDownloads: 0,
  headless: false,
  statErrors: 0,
  accessorErrors: 0,
  settleErrors: 0,
  cleanupErrors: [],
  downloadCoreIds: [1],
  teardown: [{ coreId: 1, surface: "browser", beforeClose: "ok", afterClose: "ok", hookErrors: [], downloadCount: 1 }],
  ...over,
});

test("measurementValidity is GREEN on a healthy reading — including a quiet measured row", () => {
  const v = measurementValidity(healthyRows(), okFixture, env());
  assert.equal(v.valid, true, JSON.stringify(v.problems));
  // The point of the guard: "the inline PDF produced no download" is a RESULT, not a failure.
  assert.deepEqual(v.problems, []);
});

test("measurementValidity goes RED when the positive control is silent (deaf apparatus)", () => {
  const rows = healthyRows();
  rows[0].download.eventCount = 0;
  const v = measurementValidity(rows, okFixture, env());
  assert.equal(v.valid, false);
  assert.ok(v.problems.some((p) => p.code === "positive-control-silent" && p.surface === "browser"));
});

test("measurementValidity goes RED when the negative control fires (over-firing apparatus)", () => {
  const rows = healthyRows();
  rows[1].download.eventCount = 1;
  const v = measurementValidity(rows, okFixture, env());
  assert.equal(v.valid, false);
  assert.ok(v.problems.some((p) => p.code === "negative-control-fired"));
});

test("measurementValidity goes RED when a MEASURED row is missing from a selected surface", () => {
  // The race this guards: a measured row lost or never produced, with both controls still green.
  const rows = healthyRows().filter((r) => r.case !== "attachment-pdf");
  const v = measurementValidity(rows, okFixture, env());
  assert.equal(v.valid, false);
  assert.ok(v.problems.some((p) => p.code === "measured-row-missing" && p.surface === "browser"));
});

test("measurementValidity requires every selected surface to have run, not just the ones with rows", () => {
  const v = measurementValidity(healthyRows(), okFixture, env({ surfaces: ["browser", "drive"] }));
  assert.equal(v.valid, false);
  assert.ok(v.problems.some((p) => p.surface === "drive" && p.code === "measured-row-missing"));
  assert.ok(v.problems.some((p) => p.surface === "drive" && p.code === "positive-control-missing"));
});

test("measurementValidity goes RED when a row has no navigation evidence", () => {
  const rows = healthyRows();
  rows[2].navigationEvidence = false;
  const v = measurementValidity(rows, okFixture, env());
  assert.equal(v.valid, false);
  assert.ok(v.problems.some((p) => p.code === "no-navigation-evidence"));
});

test("measurementValidity goes RED on ANY unattributed download", () => {
  const v = measurementValidity(healthyRows(), okFixture, env({ unattributedDownloads: 1 }));
  assert.equal(v.valid, false);
  assert.ok(v.problems.some((p) => p.code === "unattributed-download"));
});

test("measurementValidity goes RED when teardown never completed or is missing for a core that saw downloads", () => {
  const missingRecord = measurementValidity(healthyRows(), okFixture, env({
    downloadCoreIds: [1, 2],
    teardown: [{ coreId: 1, surface: "browser", beforeClose: "ok", afterClose: "ok", hookErrors: [], downloadCount: 1 }],
  }));
  assert.equal(missingRecord.valid, false);
  assert.ok(missingRecord.problems.some((p) => p.code === "teardown-record-missing"));

  const incomplete = measurementValidity(healthyRows(), okFixture, env({
    teardown: [{ coreId: 1, surface: "browser", beforeClose: "ok", afterClose: "pending", hookErrors: [], downloadCount: 1 }],
  }));
  assert.equal(incomplete.valid, false);
  assert.ok(incomplete.problems.some((p) => p.code === "teardown-incomplete"));

  const failedHook = measurementValidity(healthyRows(), okFixture, env({
    teardown: [{ coreId: 1, surface: "browser", beforeClose: "failed", afterClose: "ok", hookErrors: [{ phase: "beforeClose", name: "Error", marker: "other" }], downloadCount: 1 }],
  }));
  assert.equal(failedHook.valid, false);
  assert.ok(failedHook.problems.some((p) => p.code === "teardown-hook-failed"));

  // A core that observed NO download does not need a completed stat — there was nothing to stat.
  const quiet = measurementValidity(healthyRows(), okFixture, env({
    teardown: [
      { coreId: 1, surface: "browser", beforeClose: "ok", afterClose: "ok", hookErrors: [], downloadCount: 1 },
      { coreId: 2, surface: "browser", beforeClose: "pending", afterClose: "pending", hookErrors: [], downloadCount: 0 },
    ],
  }));
  assert.equal(quiet.valid, true, JSON.stringify(quiet.problems));
});

test("measurementValidity goes RED when a stat, accessor or settle observation failed", () => {
  for (const key of ["statErrors", "accessorErrors", "settleErrors"]) {
    const v = measurementValidity(healthyRows(), okFixture, env({ [key]: 1 }));
    assert.equal(v.valid, false, key);
    assert.ok(v.problems.some((p) => p.code === "observation-failed" && p.detail.includes(key)), key);
  }
});

test("observeWithin distinguishes success, rejection and timeout", async () => {
  assert.deepEqual(await observeWithin(Promise.resolve(7), 50), { status: "fulfilled", value: 7 });
  assert.deepEqual(await observeWithin(Promise.reject(new Error("secret /tmp/x")), 50), { status: "rejected", value: undefined });
  assert.deepEqual(await observeWithin(new Promise(() => {}), 10), { status: "timed-out", value: undefined });
});

test("runtime closed vocabularies reject malformed strings", () => {
  const allowed = new Set([null, "nav-failed"]);
  assert.equal(closedValue("nav-failed", allowed), "nav-failed");
  assert.equal(closedValue("http://host/a?secret=1", allowed), "unknown");
});

test("measurementValidity rejects incomplete lifecycle and cleanup failures", () => {
  const incompleteRows = healthyRows();
  incompleteRows[2].download = { eventCount: 1, tempFileBeforeClose: "unknown", tempFileAfterClose: "absent" };
  const incomplete = measurementValidity(incompleteRows, okFixture, env());
  assert.ok(incomplete.problems.some((p) => p.code === "lifecycle-incomplete"));

  const cleanup = measurementValidity(healthyRows(), okFixture, env({ cleanupErrors: ["gateway-shutdown"] }));
  assert.ok(cleanup.problems.some((p) => p.code === "cleanup-failed"));
});

test("measurementValidity REJECTS a headless run — the stack is only itself headful under Xvfb", () => {
  const v = measurementValidity(healthyRows(), okFixture, env({ headless: true }));
  assert.equal(v.valid, false);
  assert.ok(v.problems.some((p) => p.code === "headless-run"));
  // Fail closed: an unstated mode is not a headful one.
  const unstated = measurementValidity(healthyRows(), okFixture, env({ headless: undefined }));
  assert.ok(unstated.problems.some((p) => p.code === "headless-run"));
});

test("measurementValidity goes RED when a control never ran, or no core was observed, or nothing ran", () => {
  const missing = measurementValidity([row("browser", "attachment-pdf", 1)], okFixture, env());
  assert.equal(missing.valid, false);
  assert.ok(missing.problems.some((p) => p.code === "positive-control-missing"));
  assert.ok(missing.problems.some((p) => p.code === "negative-control-missing"));

  const noCore = measurementValidity(healthyRows().map((r) => ({ ...r, coresObserved: 0 })), okFixture, env());
  assert.ok(noCore.problems.some((p) => p.code === "no-core-observed"));

  const empty = measurementValidity([], okFixture, env());
  assert.equal(empty.valid, false);
  assert.ok(empty.problems.some((p) => p.code === "no-legs-ran"));
});

test("measurementValidity goes RED on a drifted fixture even when every leg looks healthy", () => {
  const v = measurementValidity(healthyRows(), { ok: false, problems: ["/attachment.pdf: content-disposition \"inline\" (expected attachment)"] }, env());
  assert.equal(v.valid, false);
  assert.ok(v.problems.some((p) => p.code === "fixture-self-check"));
});

test("measurementValidity checks EVERY surface, not just the first", () => {
  const rows = [...healthyRows(), ...allRows("drive").map((r) => ({ ...r, download: { eventCount: 0 } }))];
  const v = measurementValidity(rows, okFixture, env({
    surfaces: ["browser", "drive"],
    teardown: [
      { coreId: 1, surface: "browser", beforeClose: "ok", afterClose: "ok", hookErrors: [], downloadCount: 1 },
      { coreId: 2, surface: "drive", beforeClose: "ok", afterClose: "ok", hookErrors: [], downloadCount: 0 },
    ],
  }));
  assert.equal(v.valid, false);
  assert.ok(v.problems.some((p) => p.code === "positive-control-silent" && p.surface === "drive"));
});

// --- the hygiene guard, in both directions ----------------------------------------------------------

test("literalViolations names the label and never the offending value", () => {
  const forbidden = [{ label: "consumer-token", value: "tok-secret-123" }];
  assert.deepEqual(literalViolations('{"a":"clean"}', forbidden), []);
  const hit = literalViolations('{"token":"tok-secret-123"}', forbidden);
  assert.deepEqual(hit, ["consumer-token"]);
  assert.ok(!hit.join(" ").includes("tok-secret-123"));
});

test("literalViolations ignores empty/absent forbidden values (never matches everything)", () => {
  assert.deepEqual(literalViolations('{"a":"b"}', [{ label: "empty", value: "" }, { label: "absent", value: undefined }]), []);
});

test("structuralViolations catches PDF bytes, temp paths and query strings", () => {
  assert.deepEqual(structuralViolations('{"rows":[{"case":"attachment-pdf"}]}'), []);
  assert.deepEqual(structuralViolations('{"content":"%PDF-1.4"}'), ["pdf-content"]);
  assert.ok(structuralViolations('{"tempFilePath":"/tmp/pw-artifacts/x"}').includes("absolute-temp-path"));
  assert.ok(structuralViolations('{"p":"/var/folders/z/x"}').includes("absolute-temp-path"));
  assert.deepEqual(structuralViolations('{"u":"http://h/a.pdf?doc=1"}'), ["query-string"]);
  assert.ok(structuralViolations('{"p":"playwright-artifacts-abc"}').includes("playwright-artifact-path"));
});

test("structuralViolations catches ARBITRARY absolute paths, not just temp prefixes", () => {
  // The review's case: a driver temp dir that is not under /tmp leaks just as completely.
  for (const leak of [
    '{"p":"/home/node/.cache/ms-playwright/dl-1234/eid.pdf"}',
    '{"p":"/run/user/1000/scoped/x"}',
    '{"p":"/dev/shm/pw-out/eid.pdf"}',
    '{"p":"/opt/browse-gateway/session/eid.pdf"}',
    '{"p":"/data/downloads/eid.pdf"}',
  ]) {
    assert.ok(structuralViolations(leak).includes("absolute-posix-path"), leak);
  }
  assert.ok(structuralViolations('{"u":"file:///home/node/eid.pdf"}').includes("file-url"));
  assert.ok(structuralViolations('{"p":"C:\\Users\\node\\eid.pdf"}').includes("windows-absolute-path"));
  assert.ok(structuralViolations('{"p":"D:/downloads/eid.pdf"}').includes("windows-absolute-path"));
  assert.ok(structuralViolations('{"p":"\\\\fileserver\\share\\eid.pdf"}').includes("windows-unc-path"));
  // …and through JSON.stringify, where every backslash is doubled.
  const serialized = JSON.stringify({ p: "C:\\Users\\node\\eid.pdf", q: "\\\\fileserver\\share\\eid.pdf" });
  assert.ok(structuralViolations(serialized).includes("windows-absolute-path"), serialized);
  assert.ok(structuralViolations(serialized).includes("windows-unc-path"), serialized);
});

test("structuralViolations does not fire on the report's own vocabulary", () => {
  // A false positive here would make the harness unable to publish an honest reading.
  const clean = JSON.stringify({
    meta: { task: "eid-download-measurement-0", surfaces: ["browser", "retrieve", "drive"], channel: "chrome", headless: false },
    fixture: { ok: false, problems: ['/attachment.pdf: content-type "text/html; charset=utf-8" (expected application/pdf)', "/control.bin: request timeout"] },
    rows: [{ surface: "retrieve", case: "inline-pdf", role: "measured", download: { suggestedFilename: "eid-inline.pdf", tempFileBeforeClose: "unknown" }, nav: { errorMarker: "net::ERR_ABORTED", failureClass: "nav-failed" } }],
    validity: { valid: true, problems: [] },
  });
  assert.deepEqual(structuralViolations(clean), []);
  assert.deepEqual(structuralViolations(withoutDocumentedVocabulary(clean)), []);
});

test("scrubLine withholds a whole console line that carries a forbidden value, naming only the label", () => {
  assert.equal(scrubLine("  fixture self-check: OK"), "  fixture self-check: OK");
  const dirty = scrubLine("  wrote /home/node/.cache/dl/eid.pdf");
  assert.ok(!dirty.includes("/home/node"), dirty);
  assert.ok(dirty.includes("absolute-posix-path"), dirty);
});

// --- teardown state machine ---------------------------------------------------------------------------

test("wrapCoreTeardown runs the hooks around the REAL close and preserves prototype getters", async () => {
  const order = [];
  class FakeCore {
    get context() {
      return "the-real-context";
    }
    async close() {
      order.push("real-close");
      return "closed";
    }
    async kill() {
      order.push("real-kill");
    }
  }
  const core = new FakeCore();
  const state = wrapCoreTeardown(core, {
    beforeClose: async () => void order.push("before"),
    afterClose: async () => void order.push("after"),
  });
  assert.equal(core.context, "the-real-context", "wrapping must not shadow the core's getters");
  assert.equal(await core.close(), "closed", "the real close's return value must survive");
  assert.deepEqual(order, ["before", "real-close", "after"]);
  assert.equal(state.beforeClose, "ok");
  assert.equal(state.afterClose, "ok");
  assert.deepEqual(state.hookErrors, []);
});

test("wrapCoreTeardown runs afterClose even when the real close throws, and latches once", async () => {
  const order = [];
  const core = {
    close: async () => {
      order.push("real-close");
      throw new Error("wedged");
    },
    kill: async (ms) => void order.push(`real-kill:${ms}`),
  };
  wrapCoreTeardown(core, {
    beforeClose: async () => void order.push("before"),
    afterClose: async () => void order.push("after"),
  });
  await assert.rejects(() => core.close(), /wedged/);
  // A close that wedged then escalated to kill must NOT re-run the stat hooks (they would overwrite
  // the before-close reading with an after-close one and quietly invert the finding).
  await core.kill(500);
  assert.deepEqual(order, ["before", "real-close", "after", "real-kill:500"]);
});

test("wrapCoreTeardown holds a CONCURRENT close and kill behind the hooks, exactly once each", async () => {
  // The race: kill() reaching the real kill before beforeClose() has stat'd the temp file deletes
  // the evidence the measurement exists to collect. The invariants — not one fixed interleaving —
  // are what matter: before precedes EVERY real teardown, after follows ALL of them, each runs once.
  const order = [];
  const core = {
    close: async () => {
      await new Promise((r) => setTimeout(r, 15));
      order.push("real-close");
    },
    kill: async () => void order.push("real-kill"),
  };
  const state = wrapCoreTeardown(core, {
    beforeClose: async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push("before");
    },
    afterClose: async () => void order.push("after"),
  });
  await Promise.all([core.close(), core.kill()]); // fired together, not awaited in sequence
  assert.equal(order.filter((o) => o === "before").length, 1);
  assert.equal(order.filter((o) => o === "after").length, 1);
  assert.equal(order.indexOf("before"), 0, "no real teardown may outrun the before-close stat");
  assert.equal(order.indexOf("after"), order.length - 1, "the after-close stat must follow every real teardown");
  assert.deepEqual(order.slice(1, -1).sort(), ["real-close", "real-kill"]);
  assert.equal(state.teardownCalls, 2);
  assert.equal(state.beforeClose, "ok");
  assert.equal(state.afterClose, "ok");
});

test("wrapCoreTeardown does NOT queue a kill behind a wedged close — that escalation must not deadlock", async () => {
  // Session.teardown abandons a close that misses its grace deadline and escalates to kill(). A
  // strict queue would make that kill wait on the close that is precisely why it was called.
  let releaseClose;
  const order = [];
  const core = {
    close: () => new Promise((r) => { releaseClose = r; }).then(() => void order.push("real-close")),
    kill: async () => void order.push("real-kill"),
  };
  const state = wrapCoreTeardown(core, {
    beforeClose: async () => void order.push("before"),
    afterClose: async () => void order.push("after"),
  });
  const wedged = core.close();
  await new Promise((r) => setTimeout(r, 10));
  await Promise.race([
    core.kill(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("kill deadlocked behind the wedged close")), 300)),
  ]);
  assert.deepEqual(order, ["before", "real-kill"], "the escalation kill must run while the close is still wedged");
  assert.equal(state.beforeClose, "ok");
  assert.equal(state.afterClose, "pending", "the after-close reading is not taken while a teardown is still in flight");
  releaseClose();
  await wedged;
  assert.deepEqual(order, ["before", "real-kill", "real-close", "after"]);
});

test("wrapCoreTeardown still tears the core down when a hook throws, and reports the failure", async () => {
  const order = [];
  const core = {
    close: async () => void order.push("real-close"),
    kill: async () => void order.push("real-kill"),
  };
  const state = wrapCoreTeardown(core, {
    beforeClose: async () => {
      order.push("before");
      throw new Error("stat exploded at /tmp/pw-out/x?sig=SECRET");
    },
    afterClose: async () => {
      order.push("after");
      throw new TypeError("also exploded");
    },
  });
  await core.close(); // must NOT reject: the hooks are the harness's problem, not the core's
  assert.deepEqual(order, ["before", "real-close", "after"], "a throwing hook must not skip the real close");
  assert.equal(state.beforeClose, "failed");
  assert.equal(state.afterClose, "failed");
  assert.equal(state.hookErrors.length, 2);
  const text = JSON.stringify(state.hookErrors);
  assert.ok(!text.includes("SECRET"), text);
  assert.deepEqual(structuralViolations(text), [], text);
});

test("wrapCoreTeardown exposes a settled() the caller can await before attributing anything", async () => {
  const order = [];
  const core = { close: async () => { await new Promise((r) => setTimeout(r, 10)); order.push("real-close"); } };
  const state = wrapCoreTeardown(core, {
    beforeClose: async () => void order.push("before"),
    afterClose: async () => void order.push("after"),
  });
  void core.close();
  await state.settled();
  assert.deepEqual(order, ["before", "real-close", "after"]);
});

test("wrapCoreTeardown tolerates a core with no kill method", () => {
  const core = { close: async () => "ok" };
  assert.doesNotThrow(() => wrapCoreTeardown(core, { beforeClose: async () => {}, afterClose: async () => {} }));
});

// --- env parsing ----------------------------------------------------------------------------------------

test("resolveFault defaults to none and rejects a typo instead of silently disarming", () => {
  assert.equal(resolveFault(undefined).mode, "none");
  assert.equal(resolveFault("").mode, "none");
  assert.equal(resolveFault("mute-observer").muteObserver, true);
  assert.equal(resolveFault("forge-download").forgeDownload, true);
  assert.equal(resolveFault("leak-temp-path").leakTempPath, true);
  assert.equal(resolveFault("break-fixture").breakFixture, true);
  // A typo reading as `none` would turn an intended RED demonstration into a green run.
  assert.throws(() => resolveFault("mute-observor"), /unknown BGW_EID_MEASURE_FAULT/);
  for (const mode of FAULT_MODES) assert.equal(resolveFault(mode).mode, mode);
});

test("resolveSurfaces defaults to all three and rejects an unknown surface", () => {
  assert.deepEqual(resolveSurfaces(undefined), ["browser", "retrieve", "drive"]);
  assert.deepEqual(resolveSurfaces("browser"), ["browser"]);
  assert.deepEqual(resolveSurfaces("browser, drive"), ["browser", "drive"]);
  assert.throws(() => resolveSurfaces("browsr"), /unknown BGW_EID_MEASURE_SURFACES/);
});

// --- fixture self-check --------------------------------------------------------------------------------

test("fixtureRouteProblems is quiet on a matching response and loud on each mismatch", () => {
  const expected = { path: "/attachment.pdf", status: 200, contentType: "application/pdf", dispositionPrefix: "attachment" };
  assert.deepEqual(fixtureRouteProblems(expected, { status: 200, contentType: "application/pdf", disposition: 'attachment; filename="a.pdf"' }), []);
  assert.equal(fixtureRouteProblems(expected, { status: 404, contentType: "application/pdf", disposition: "attachment" }).length, 1);
  assert.equal(fixtureRouteProblems(expected, { status: 200, contentType: "text/html", disposition: "attachment" }).length, 1);
  assert.equal(fixtureRouteProblems(expected, { status: 200, contentType: "application/pdf", disposition: "inline" }).length, 1);
  assert.equal(fixtureRouteProblems(expected, { status: 200, contentType: "application/pdf", disposition: undefined }).length, 1);
  // The html route must have NO disposition at all.
  const html = { path: "/control.html", status: 200, contentType: "text/html", dispositionPrefix: null };
  assert.deepEqual(fixtureRouteProblems(html, { status: 200, contentType: "text/html; charset=utf-8", disposition: undefined }), []);
  assert.equal(fixtureRouteProblems(html, { status: 200, contentType: "text/html", disposition: "attachment" }).length, 1);
});

test("fixtureRouteProblems reports a transport failure as its own problem", () => {
  const expected = { path: "/attachment.pdf", status: 200, contentType: "application/pdf", dispositionPrefix: "attachment" };
  const problems = fixtureRouteProblems(expected, { status: null, contentType: null, disposition: null, error: "timeout" });
  assert.ok(problems.some((p) => p.includes("timeout")), JSON.stringify(problems));
});

test("probeRoute gives up on a stalled fixture instead of hanging the measurement", async (t) => {
  const stalled = http.createServer(() => {}); // accepts, never answers
  await listenBounded(stalled, 0, "127.0.0.1");
  const base = `http://127.0.0.1:${stalled.address().port}`;
  t.after(() => new Promise((r) => stalled.close(r)));
  const actual = await probeRoute(base, "/attachment.pdf", { timeoutMs: 150 });
  assert.equal(actual.error, "timeout");
  assert.equal(actual.status, null);
});

test("probeRoute reports a refused connection rather than throwing", async () => {
  // Port 1 on loopback: nothing listens, and binding it would need privileges.
  const actual = await probeRoute("http://127.0.0.1:1", "/attachment.pdf", { timeoutMs: 500 });
  assert.equal(actual.error, "request-error");
  assert.equal(actual.status, null);
});

test("listenBounded rejects — with no path in the message — when the bind fails", async (t) => {
  const first = http.createServer(() => {});
  await listenBounded(first, 0, "127.0.0.1");
  const port = first.address().port;
  t.after(() => new Promise((r) => first.close(r)));

  const second = http.createServer(() => {});
  await assert.rejects(() => listenBounded(second, port, "127.0.0.1"), (err) => {
    assert.deepEqual(structuralViolations(String(err.message)), []);
    return /fixture listen failed/.test(err.message);
  });
});

/** Drive the real fixture over a real socket — the headers under measurement are the fixture's whole job. */
async function fetchHead(base, path) {
  return new Promise((resolve) => {
    http.get(`${base}${path}?probe=1`, (res) => {
      res.resume();
      resolve({ status: res.statusCode, contentType: res.headers["content-type"], disposition: res.headers["content-disposition"] });
    });
  });
}

test("the real fixture serves every expected shape (and the break-fixture fault breaks it)", async (t) => {
  const server = createFixtureServer();
  await listenBounded(server, 0, "127.0.0.1");
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((r) => server.close(r)));

  for (const expected of FIXTURE_EXPECTATIONS) {
    assert.deepEqual(fixtureRouteProblems(expected, await fetchHead(base, expected.path)), [], expected.path);
  }

  const broken = createFixtureServer({ breakFixture: true });
  await listenBounded(broken, 0, "127.0.0.1");
  const brokenBase = `http://127.0.0.1:${broken.address().port}`;
  t.after(() => new Promise((r) => broken.close(r)));

  const attachment = FIXTURE_EXPECTATIONS.find((e) => e.path === "/attachment.pdf");
  const problems = fixtureRouteProblems(attachment, await fetchHead(brokenBase, "/attachment.pdf"));
  assert.equal(problems.length, 1, "break-fixture must make the attachment route fail its own expectation");
  assert.match(problems[0], /content-disposition/);
  // The inline route is unaffected by the fault — otherwise the fault would prove nothing specific.
  const inline = FIXTURE_EXPECTATIONS.find((e) => e.path === "/inline.pdf");
  assert.deepEqual(fixtureRouteProblems(inline, await fetchHead(brokenBase, "/inline.pdf")), []);
});
