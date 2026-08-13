/**
 * Unit tests for the EID download MEASUREMENT harness (scripts/measure-eid-download.mjs).
 *
 * These cover the harness's own logic — redaction, the filename safety gate, the three-valued
 * temp-file reading, the closed-vocabulary error marker, the fixture self-check, the teardown
 * wrapper, and BOTH guards (validity + hygiene). They do NOT launch a browser: what Chrome does
 * with a PDF is measured by the in-container run, and a unit test asserting it would be a stub
 * guaranteeing its own answer (docs/solutions/best-practices/a-test-whose-stub-guarantees-the-
 * assertion-proves-nothing.md).
 *
 * Every guard arm is tested in BOTH directions — a green-only test of a guard proves the guard can
 * say yes, which is not the property that matters.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import {
  redactUrl,
  safeFilename,
  tempFileState,
  errorMarker,
  downloadsForCase,
  measurementValidity,
  literalViolations,
  structuralViolations,
  wrapCoreTeardown,
  resolveFault,
  resolveSurfaces,
  fixtureRouteProblems,
  createFixtureServer,
  FIXTURE_EXPECTATIONS,
  POSITIVE_CONTROL,
  NEGATIVE_CONTROL,
  CASES,
  FAULT_MODES,
} from "../scripts/measure-eid-download.mjs";

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

// --- per-case attribution -------------------------------------------------------------------------

test("downloadsForCase attributes by served path, not by arrival order", () => {
  const downloads = [
    { redactedUrl: "http://127.0.0.1:1/control.bin" },
    { redactedUrl: "http://127.0.0.1:1/attachment.pdf" },
    { redactedUrl: "http://127.0.0.1:1/attachment.pdf" },
  ];
  assert.equal(downloadsForCase(downloads, "/attachment.pdf").length, 2);
  assert.equal(downloadsForCase(downloads, "/control.bin").length, 1);
  assert.equal(downloadsForCase(downloads, "/inline.pdf").length, 0);
});

// --- the validity guard, in both directions --------------------------------------------------------

const row = (surface, caseId, eventCount, coresObserved = 1) => ({
  surface,
  case: caseId,
  role: CASES.find((c) => c.id === caseId)?.role ?? "measured",
  nav: { outcome: "returned", status: 200, failureClass: null },
  download: { eventCount },
  coresObserved,
});

/** A reading in which every arm is satisfied: the control fired, the page did not, a core was seen. */
const healthyRows = () => [
  row("browser", POSITIVE_CONTROL, 1),
  row("browser", NEGATIVE_CONTROL, 0),
  row("browser", "attachment-pdf", 1),
  row("browser", "inline-pdf", 0),
];

const okFixture = { ok: true, problems: [] };

test("measurementValidity is GREEN on a healthy reading — including a quiet measured row", () => {
  const v = measurementValidity(healthyRows(), okFixture);
  assert.equal(v.valid, true, JSON.stringify(v.problems));
  // The point of the guard: "the inline PDF produced no download" is a RESULT, not a failure.
  assert.deepEqual(v.problems, []);
});

test("measurementValidity goes RED when the positive control is silent (deaf apparatus)", () => {
  const rows = healthyRows();
  rows[0].download.eventCount = 0;
  const v = measurementValidity(rows, okFixture);
  assert.equal(v.valid, false);
  assert.ok(v.problems.some((p) => p.code === "positive-control-silent" && p.surface === "browser"));
});

test("measurementValidity goes RED when the negative control fires (over-firing apparatus)", () => {
  const rows = healthyRows();
  rows[1].download.eventCount = 1;
  const v = measurementValidity(rows, okFixture);
  assert.equal(v.valid, false);
  assert.ok(v.problems.some((p) => p.code === "negative-control-fired"));
});

test("measurementValidity goes RED when a control never ran, or no core was observed, or nothing ran", () => {
  const missing = measurementValidity([row("browser", "attachment-pdf", 1)], okFixture);
  assert.equal(missing.valid, false);
  assert.ok(missing.problems.some((p) => p.code === "positive-control-missing"));
  assert.ok(missing.problems.some((p) => p.code === "negative-control-missing"));

  const noCore = measurementValidity(healthyRows().map((r) => ({ ...r, coresObserved: 0 })), okFixture);
  assert.ok(noCore.problems.some((p) => p.code === "no-core-observed"));

  const empty = measurementValidity([], okFixture);
  assert.equal(empty.valid, false);
  assert.ok(empty.problems.some((p) => p.code === "no-legs-ran"));
});

test("measurementValidity goes RED on a drifted fixture even when every leg looks healthy", () => {
  const v = measurementValidity(healthyRows(), { ok: false, problems: ["/attachment.pdf: content-disposition \"inline\" (expected attachment)"] });
  assert.equal(v.valid, false);
  assert.ok(v.problems.some((p) => p.code === "fixture-self-check"));
});

test("measurementValidity checks EVERY surface, not just the first", () => {
  const rows = [...healthyRows(), row("drive", POSITIVE_CONTROL, 0), row("drive", NEGATIVE_CONTROL, 0)];
  const v = measurementValidity(rows, okFixture);
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

test("structuralViolations catches PDF bytes, absolute temp paths and query strings", () => {
  assert.deepEqual(structuralViolations('{"rows":[{"case":"attachment-pdf"}]}'), []);
  assert.deepEqual(structuralViolations('{"content":"%PDF-1.4"}'), ["pdf-content"]);
  assert.deepEqual(structuralViolations('{"tempFilePath":"/tmp/pw-artifacts/x"}'), ["absolute-temp-path"]);
  assert.deepEqual(structuralViolations('{"p":"/var/folders/z/x"}'), ["absolute-temp-path"]);
  assert.deepEqual(structuralViolations('{"u":"http://h/a.pdf?doc=1"}'), ["query-string"]);
  assert.deepEqual(structuralViolations('{"p":"playwright-artifacts-abc"}'), ["playwright-artifact-path"]);
});

test("structuralViolations does not fire on the report's own vocabulary", () => {
  // A false positive here would make the harness unable to publish an honest reading.
  const clean = JSON.stringify({
    meta: { task: "eid-download-measurement-0", surfaces: ["browser", "retrieve", "drive"] },
    rows: [{ surface: "retrieve", case: "inline-pdf", download: { suggestedFilename: "eid-inline.pdf", tempFileBeforeClose: "unknown" }, nav: { errorMarker: "net::ERR_ABORTED" } }],
  });
  assert.deepEqual(structuralViolations(clean), []);
});

// --- teardown wrapper ---------------------------------------------------------------------------------

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
  wrapCoreTeardown(core, {
    beforeClose: async () => void order.push("before"),
    afterClose: async () => void order.push("after"),
  });
  assert.equal(core.context, "the-real-context", "wrapping must not shadow the core's getters");
  assert.equal(await core.close(), "closed", "the real close's return value must survive");
  assert.deepEqual(order, ["before", "real-close", "after"]);
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
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((r) => server.close(r)));

  for (const expected of FIXTURE_EXPECTATIONS) {
    assert.deepEqual(fixtureRouteProblems(expected, await fetchHead(base, expected.path)), [], expected.path);
  }

  const broken = createFixtureServer({ breakFixture: true });
  await new Promise((r) => broken.listen(0, "127.0.0.1", r));
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
