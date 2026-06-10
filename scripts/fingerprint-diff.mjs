#!/usr/bin/env node
/**
 * Fingerprint-parity diff — compare two snapshots (see scripts/fingerprint-snapshot.mjs) and
 * print the divergent axes, grouped by severity:
 *   HIGH  likely datacenter/headless/automation tell (WebGL renderer, fonts, WebRTC UDP, …)
 *   GEO   must align with the proxy exit (timezone, locale, languages)
 *   INFO  divergent but not pre-judged (userAgent across Chrome builds, screen, …)
 *
 *   node scripts/fingerprint-diff.mjs mac.fp.json vps.fp.json
 *
 * Exit code: number of HIGH divergences (capped at 250), so it can gate later if desired;
 * 0 when the two browsers look identical on the high-severity axes.
 */
import { readFileSync } from "node:fs";
import { diffFingerprints } from "../dist/browser/index.js";

const [, , fileA, fileB] = process.argv;
if (!fileA || !fileB) {
  console.error("usage: node scripts/fingerprint-diff.mjs <a.json> <b.json>");
  process.exit(2);
}

const load = (p) => JSON.parse(readFileSync(p, "utf8"));
const A = load(fileA);
const B = load(fileB);
const fpA = A.fingerprint ?? A;
const fpB = B.fingerprint ?? B;
const labelA = A.meta?.label ?? fileA;
const labelB = B.meta?.label ?? fileB;

const fmt = (v) => {
  const s = JSON.stringify(v);
  return s.length > 160 ? s.slice(0, 157) + "…" : s;
};
const metaLine = (label, m) =>
  !m
    ? `  ${label}: (no meta)`
    : `  ${label}: chromeUA=${fmt(m.chromeUA)} proxied=${m.proxied} egressIp=${m.egressIp} at=${m.capturedAt}`;

console.log(`=== fingerprint parity diff: ${labelA} ↔ ${labelB} ===`);
console.log(metaLine(labelA, A.meta));
console.log(metaLine(labelB, B.meta));

const diffs = diffFingerprints(fpA, fpB);
const groups = { high: [], geo: [], info: [] };
for (const d of diffs) groups[d.severity].push(d);

const HEADINGS = {
  high: "HIGH — likely tells",
  geo: "GEO — must match proxy exit",
  info: "INFO — divergent, not pre-judged",
};
for (const sev of ["high", "geo", "info"]) {
  const g = groups[sev];
  console.log(`\n${HEADINGS[sev]} — ${g.length}`);
  if (!g.length) {
    console.log("  (none)");
    continue;
  }
  for (const d of g) {
    console.log(`  ${d.path}`);
    console.log(`    ${labelA}: ${fmt(d.a)}`);
    console.log(`    ${labelB}: ${fmt(d.b)}`);
  }
}

console.log(
  `\nSummary: ${groups.high.length} HIGH, ${groups.geo.length} GEO, ${groups.info.length} INFO ` +
    `(${diffs.length} divergent axes).` +
    (groups.high.length ? "" : " No high-severity divergence — the browsers look alike where it counts."),
);

process.exit(Math.min(groups.high.length, 250));
