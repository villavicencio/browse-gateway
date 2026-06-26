#!/usr/bin/env node
/**
 * Runtime gate for the opt-in per-host OS presentation (BGW_WINDOWS_UA_HOSTS).
 *
 * Proves, against a REAL browser core (the thing the unit tests can't), that:
 *   1. a navigation to a LISTED host presents as Windows (UA + navigator.platform + userAgentData);
 *   2. a REUSED drive page navigating to a NON-listed host RESTORES the native identity — the Windows
 *      override does NOT bleed past the opt-in boundary (the Codex-flagged high finding);
 *   3. navigating back to a listed host re-applies Windows;
 *   4. a session that only ever visits non-listed hosts is NEVER touched (stays native).
 *
 * Uses benign hosts (example.com listed, example.org/example.net not) so it needs no proxy and no
 * anti-bot target — it asserts the override MECHANICS, not a PX clear (that is the px-probe's job).
 *
 *   npm run build && node scripts/validate-os-presentation.mjs
 *   # in-container: docker run … -e BGW_NO_SANDBOX=1 <image> node scripts/validate-os-presentation.mjs
 */
import { createBrowserCore } from "../dist/browser/index.js";

const NO_SANDBOX = process.env.BGW_NO_SANDBOX === "1";
const LISTED = "https://example.com/";
const UNLISTED = "https://example.org/";

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "✔" : "✖"} ${name}${ok ? "" : `  — ${detail}`}`);
  if (!ok) failures++;
};

/** Read the active page's live identity (isolated world reflects a CDP UA override). */
async function readActiveUa(core) {
  const page = core.context.pages().filter((p) => p.url() && p.url() !== "about:blank").pop();
  if (!page) return { userAgent: "", platform: "", uaPlatform: "" };
  return page.evaluate(`(() => ({
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    uaPlatform: (navigator.userAgentData && navigator.userAgentData.platform) || null,
  }))()`);
}
const isWindows = (ua) => /Windows NT/.test(ua.userAgent) && ua.platform === "Win32" && (ua.uaPlatform === null || ua.uaPlatform === "Windows");
const isNative = (ua) => !/Windows NT/.test(ua.userAgent) && ua.platform !== "Win32";

async function run(label, windowsUaHosts, steps) {
  const core = await createBrowserCore({ channel: "chrome", noSandbox: NO_SANDBOX, windowsUaHosts });
  try {
    for (const step of steps) await step(core);
  } finally {
    await core.close();
  }
  console.log(`  [${label}] done`);
}

console.log("=== OS-presentation runtime gate (example.com listed) ===");

await run("opt-in flip/restore", ["example.com"], [
  async (core) => {
    await core.navigate(LISTED);
    const ua = await readActiveUa(core);
    check("listed host → Windows", isWindows(ua), JSON.stringify(ua));
  },
  async (core) => {
    await core.navigate(UNLISTED);
    const ua = await readActiveUa(core);
    check("listed→non-listed → RESTORED native (no bleed)", isNative(ua), JSON.stringify(ua));
  },
  async (core) => {
    await core.navigate(LISTED);
    const ua = await readActiveUa(core);
    check("back to listed → Windows again", isWindows(ua), JSON.stringify(ua));
  },
]);

await run("never-listed untouched", ["example.com"], [
  async (core) => {
    await core.navigate(UNLISTED);
    const ua = await readActiveUa(core);
    check("non-listed-only session → native (never overridden)", isNative(ua), JSON.stringify(ua));
  },
]);

// Unlisted-FIRST then listed: the Windows override for the listed host must be built from the CLEAN
// baseline captured on the fresh about:blank page (in #ensureActivePage) — NOT lazily read from the
// already-loaded unlisted document. Asserts the override applies correctly with a valid Chrome major.
await run("unlisted-first then listed (clean baseline)", ["example.com"], [
  async (core) => {
    await core.navigate(UNLISTED);
    const ua1 = await readActiveUa(core);
    check("unlisted first → native", isNative(ua1), JSON.stringify(ua1));
    await core.navigate(LISTED);
    const ua2 = await readActiveUa(core);
    check(
      "then listed → Windows from clean baseline (valid Chrome major)",
      isWindows(ua2) && /Chrome\/\d+\.0\.0\.0/.test(ua2.userAgent),
      JSON.stringify(ua2),
    );
  },
]);

await run("opt-out disabled (no list)", [], [
  async (core) => {
    await core.navigate(LISTED);
    const ua = await readActiveUa(core);
    check("empty list → even example.com stays native (feature off)", isNative(ua), JSON.stringify(ua));
  },
]);

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
