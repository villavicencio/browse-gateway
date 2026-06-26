/**
 * OS-presentation (windows-UA) opt-in. PerimeterX-class scorers 403 the container's `Linux x86_64`
 * Chrome even from a clean residential exit; flipping ONLY the OS identity to Windows (UA + platform +
 * userAgentData/client-hints) clears it (measured on Total Wine 2026-06-26, same-exit A/B, 4/4 exits).
 * Applied opt-in per host (BGW_WINDOWS_UA_HOSTS) so non-listed targets keep the coherent Linux identity.
 *
 * Covered here: the pure override builder + version derivation, the shared host parse/match helpers
 * (one matcher across force-proxy / fresh-exit / windows-UA), and the config wiring. The live in-core
 * application is exercised by the in-container px-probe runtime gate (validate-vault-warm-open path).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWindowsUaOverride, buildNativeUaOverride, chromeMajorFrom, DEFAULT_CHROME_MAJOR } from "../dist/browser/index.js";
import { parseHostSuffixList, hostMatchesAnySuffix } from "../dist/security/index.js";
import { parseForceProxyHosts, hostForcesProxy } from "../dist/verbs/index.js";
import { loadConfig } from "../dist/gateway/index.js";

// A realistic LIVE Linux Chrome 149 UA-CH read (what READ_LIVE_UA_JS returns in-container).
const LIVE_LINUX = {
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
  platform: "Linux x86_64",
  uaPlatform: "Linux",
  platformVersion: "6.6.0",
  architecture: "x86",
  bitness: "64",
  model: "",
  mobile: false,
  wow64: false,
  brands: [{ brand: "Google Chrome", version: "149" }, { brand: "Chromium", version: "149" }, { brand: "Not)A;Brand", version: "24" }],
  fullVersionList: [{ brand: "Google Chrome", version: "149.0.7827.196" }, { brand: "Chromium", version: "149.0.7827.196" }, { brand: "Not)A;Brand", version: "24.0.0.0" }],
};

// --- chromeMajorFrom -------------------------------------------------------------------------

test("chromeMajorFrom: extracts the Chrome major; falls back when absent", () => {
  assert.equal(chromeMajorFrom("Mozilla/5.0 (X11; Linux x86_64) … Chrome/149.0.0.0 Safari/537.36"), "149");
  assert.equal(chromeMajorFrom("… Chrome/151.0.7100.5 Safari/537.36"), "151");
  assert.equal(chromeMajorFrom(""), DEFAULT_CHROME_MAJOR);
  assert.equal(chromeMajorFrom(undefined), DEFAULT_CHROME_MAJOR);
  assert.equal(chromeMajorFrom("Mozilla/5.0 (no chrome token)"), DEFAULT_CHROME_MAJOR);
});

// --- buildWindowsUaOverride: OS-only mutation, live non-OS fields PRESERVED -------------------

test("buildWindowsUaOverride: flips ONLY the OS identity, preserving the live Chrome version in the UA", () => {
  const o = buildWindowsUaOverride(LIVE_LINUX);
  // UA string: Windows platform token swapped in; same Chrome version token kept; no Linux/X11 trace.
  assert.match(o.userAgent, /Windows NT 10\.0; Win64; x64/);
  assert.match(o.userAgent, /Chrome\/149\.0\.0\.0/);
  assert.doesNotMatch(o.userAgent, /Linux|X11/);
  // navigator.platform → Win32; client-hint platform → Windows 11 (platformVersion ≥ 13).
  assert.equal(o.platform, "Win32");
  assert.equal(o.userAgentMetadata.platform, "Windows");
  assert.equal(o.userAgentMetadata.mobile, false);
  assert.ok(Number(o.userAgentMetadata.platformVersion.split(".")[0]) >= 13, "Win11 platformVersion");
});

test("buildWindowsUaOverride: PRESERVES the live brands + fullVersionList (no fabricated/drifting tell)", () => {
  // A non-149 live read with a DIFFERENT GREASE brand + ordering — the override must carry it verbatim.
  const live = {
    ...LIVE_LINUX,
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
    brands: [{ brand: "Not/A)Brand", version: "8" }, { brand: "Chromium", version: "151" }, { brand: "Google Chrome", version: "151" }],
    fullVersionList: [{ brand: "Not/A)Brand", version: "8.0.0.0" }, { brand: "Chromium", version: "151.0.7100.5" }, { brand: "Google Chrome", version: "151.0.7100.5" }],
  };
  const o = buildWindowsUaOverride(live);
  assert.match(o.userAgent, /Chrome\/151\.0\.0\.0/);
  assert.deepEqual(o.userAgentMetadata.brands, live.brands, "live brands carried verbatim (order + GREASE)");
  assert.deepEqual(o.userAgentMetadata.fullVersionList, live.fullVersionList, "live fullVersionList carried verbatim");
  assert.equal(o.userAgentMetadata.architecture, "x86");
});

test("buildWindowsUaOverride: falls back to derived defaults when live UA-CH is absent (UA-string only)", () => {
  const o = buildWindowsUaOverride({ userAgent: "", platform: "" });
  assert.match(o.userAgent, new RegExp(`Chrome/${DEFAULT_CHROME_MAJOR}\\.0\\.0\\.0`));
  assert.equal(o.platform, "Win32");
  assert.equal(o.userAgentMetadata.brands.find((b) => b.brand === "Google Chrome").version, DEFAULT_CHROME_MAJOR);
});

// --- buildNativeUaOverride: faithful restore of the captured live identity (opt-in-boundary fix) ----

test("buildNativeUaOverride: round-trips the live identity (used to restore after a Windows override)", () => {
  const o = buildNativeUaOverride(LIVE_LINUX);
  assert.equal(o.userAgent, LIVE_LINUX.userAgent, "native UA restored verbatim");
  assert.equal(o.platform, "Linux x86_64");
  assert.equal(o.userAgentMetadata.platform, "Linux");
  assert.equal(o.userAgentMetadata.platformVersion, "6.6.0");
  assert.deepEqual(o.userAgentMetadata.brands, LIVE_LINUX.brands);
  assert.doesNotMatch(o.userAgent, /Windows/);
});

// --- shared host helpers (one matcher across force-proxy / fresh-exit / windows-UA) -----------

test("parseHostSuffixList: comma-splits, trims, canonicalizes; empty/unset → []", () => {
  assert.deepEqual(parseHostSuffixList("totalwine.com, WWW.Example.com. ,, foo.io"), ["totalwine.com", "www.example.com", "foo.io"]);
  assert.deepEqual(parseHostSuffixList(""), []);
  assert.deepEqual(parseHostSuffixList(undefined), []);
});

test("hostMatchesAnySuffix: exact + dotted-subdomain; not a substring; trailing-dot canonicalized", () => {
  const list = ["totalwine.com"];
  assert.equal(hostMatchesAnySuffix("totalwine.com", list), true);
  assert.equal(hostMatchesAnySuffix("www.totalwine.com", list), true);
  assert.equal(hostMatchesAnySuffix("www.totalwine.com.", list), true, "trailing-dot FQDN can't bypass");
  assert.equal(hostMatchesAnySuffix("nottotalwine.com", list), false, "suffix, not substring");
  assert.equal(hostMatchesAnySuffix("totalwine.com.evil.com", list), false);
  assert.equal(hostMatchesAnySuffix("totalwine.com", []), false);
});

test("escalation helpers still delegate to the shared matcher (no behavior drift)", () => {
  assert.deepEqual(parseForceProxyHosts("totalwine.com, WWW.Example.com"), ["totalwine.com", "www.example.com"]);
  assert.equal(hostForcesProxy("www.totalwine.com", ["totalwine.com"]), true);
  assert.equal(hostForcesProxy("nottotalwine.com", ["totalwine.com"]), false);
});

// --- config wiring ---------------------------------------------------------------------------

test("loadConfig: BGW_WINDOWS_UA_HOSTS → core.windowsUaHosts (canonicalized); unset → absent", () => {
  const withHosts = loadConfig({ BGW_WINDOWS_UA_HOSTS: "totalwine.com, WWW.Example.com" });
  assert.deepEqual(withHosts.core.windowsUaHosts, ["totalwine.com", "www.example.com"]);

  const none = loadConfig({});
  assert.equal(none.core.windowsUaHosts, undefined, "no env ⇒ no windowsUaHosts (native Linux everywhere)");

  const blank = loadConfig({ BGW_WINDOWS_UA_HOSTS: "  ,, " });
  assert.equal(blank.core.windowsUaHosts, undefined, "blank list ⇒ absent, not an empty array");
});
