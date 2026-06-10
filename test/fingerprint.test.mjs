import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FINGERPRINT_COLLECTOR_JS,
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
  // Touches the axes the diff classifies as high-severity tells.
  for (const probe of ["WEBGL_debug_renderer_info", "srflx", "canvasHash", "fonts", "timeZone"]) {
    assert.ok(FINGERPRINT_COLLECTOR_JS.includes(probe), `collector should reference ${probe}`);
  }
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
