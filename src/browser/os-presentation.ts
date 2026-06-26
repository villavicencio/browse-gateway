/**
 * OS-presentation override — make the headful-Chrome-under-Xvfb container present as **Windows**
 * Chrome instead of `Linux x86_64`, OPT-IN PER HOST.
 *
 * WHY: PerimeterX/HUMAN (and the same class of scorer) weight a Linux-desktop Chrome heavily as
 * bot-like — it is the dominant headless-bot OS — and 403 it even from a clean residential exit.
 * Measured on Total Wine (2026-06-26): on a FIXED residential exit IP, the identical container
 * 403'd as `Linux x86_64` and CLEARED (200) when ONLY the OS identity was flipped to Windows —
 * SwiftShader/canvas/fonts/screen/WebRTC all left untouched and individually exonerated. So the OS
 * string (UA + `navigator.platform` + `userAgentData`/client-hints) is the deciding signal, and PX
 * is not cross-checking fonts/canvas against the claimed OS hard enough to catch a UA-level spoof.
 * Confirmed end-to-end through the real `core.navigate()` path (4/4 fresh exits, paired same-exit A/B).
 *
 * OPT-IN PER HOST (BGW_WINDOWS_UA_HOSTS), not global: a Windows UA over Linux fonts/canvas is
 * internally INCOHERENT and a different anti-bot could cross-check it, so we present Windows only for
 * hosts that demonstrably need it and keep every other target on the coherent Linux identity. The core
 * therefore RESTORES the native identity when a (reused) drive page navigates away from a listed host
 * to a non-listed one, so the override never bleeds past the opt-in boundary.
 *
 * COHERENCE: we mutate ONLY the OS-bearing fields (UA platform token, `navigator.platform`, the UA-CH
 * `platform`/`platformVersion`) and PRESERVE the live browser's `brands`/`fullVersionList`/architecture
 * etc. — so the brand list / full-version / GREASE stay exactly what the real engine reports and do not
 * become a fabricated, version-drifting tell of their own. The live values are read from the page once
 * (before the first override) via {@link READ_LIVE_UA_JS}.
 *
 * MECHANISM: CDP `Emulation.setUserAgentOverride` with a full `userAgentMetadata` drives BOTH the JS
 * surface (`navigator.userAgent`/`.platform`/`.userAgentData`) AND the outgoing `User-Agent` +
 * `Sec-CH-UA-Platform*` request headers, so server and in-page sensor agree. Applied before a page's
 * first (relevant) navigation — see patchright-core.
 */

/** Default Chrome major used only when the live UA can't be parsed (keeps the override well-formed). */
export const DEFAULT_CHROME_MAJOR = "149";

const WINDOWS_PLATFORM_TOKEN = "Windows NT 10.0; Win64; x64";

interface Brand {
  brand: string;
  version: string;
}

/** The live UA / client-hint values read from the page, so an override can preserve the non-OS fields. */
export interface LiveUserAgent {
  userAgent: string;
  /** `navigator.platform` (e.g. "Linux x86_64" / "MacIntel"). */
  platform: string;
  /** `userAgentData.platform` (e.g. "Linux" / "macOS"). */
  uaPlatform?: string;
  platformVersion?: string;
  architecture?: string;
  bitness?: string;
  model?: string;
  mobile?: boolean;
  wow64?: boolean;
  brands?: Brand[];
  fullVersionList?: Brand[];
}

/** The CDP `Emulation.setUserAgentOverride` parameter shape (the subset we set). */
export interface UserAgentOverride {
  userAgent: string;
  platform: string;
  acceptLanguage: string;
  userAgentMetadata: {
    platform: string;
    platformVersion: string;
    architecture: string;
    model: string;
    mobile: boolean;
    bitness: string;
    wow64: boolean;
    brands: Brand[];
    fullVersionList: Brand[];
  };
}

/**
 * Page-side reader (isolated world is fine — `navigator` is shared): the live UA + high-entropy
 * client-hint values. Async because `getHighEntropyValues` is a promise; degrades to just the UA
 * string when `userAgentData` / high-entropy is unavailable. Self-contained for `page.evaluate(string)`.
 */
export const READ_LIVE_UA_JS = `(async () => {
  const out = { userAgent: navigator.userAgent, platform: navigator.platform };
  try {
    const uad = navigator.userAgentData;
    if (uad) {
      out.uaPlatform = uad.platform;
      out.mobile = !!uad.mobile;
      out.brands = (uad.brands || []).map(function (b) { return { brand: b.brand, version: b.version }; });
      const hi = await uad.getHighEntropyValues(['architecture','bitness','model','platformVersion','fullVersionList','wow64']);
      out.architecture = hi.architecture; out.bitness = hi.bitness; out.model = hi.model || '';
      out.platformVersion = hi.platformVersion; out.wow64 = !!hi.wow64;
      out.fullVersionList = (hi.fullVersionList || []).map(function (b) { return { brand: b.brand, version: b.version }; });
    }
  } catch (e) { /* no userAgentData / blocked high-entropy — fall back to UA-string-only */ }
  return out;
})()`;

/** Extract the Chrome major version from a UA string (e.g. "…Chrome/149.0.0.0…" → "149"); falls
 *  back to {@link DEFAULT_CHROME_MAJOR} when absent so the override is always well-formed. */
export function chromeMajorFrom(userAgent: string | undefined): string {
  const m = /Chrome\/(\d+)\./.exec(userAgent ?? "");
  return m?.[1] ?? DEFAULT_CHROME_MAJOR;
}

/** Default brand trio for `major` — used only when the live `userAgentData.brands` couldn't be read.
 *  The GREASE brand ("Not)A;Brand";24) matches Chrome 149's real brands (captured empirically); it is
 *  OS-independent. Preferring the LIVE brands (see {@link buildWindowsUaOverride}) avoids version drift. */
function defaultBrands(major: string): Brand[] {
  return [
    { brand: "Google Chrome", version: major },
    { brand: "Chromium", version: major },
    { brand: "Not)A;Brand", version: "24" },
  ];
}

function defaultFullVersionList(major: string): Brand[] {
  return [
    { brand: "Google Chrome", version: `${major}.0.0.0` },
    { brand: "Chromium", version: `${major}.0.0.0` },
    { brand: "Not)A;Brand", version: "24.0.0.0" },
  ];
}

const STD_ACCEPT_LANGUAGE = "en-US,en;q=0.9";

/** Swap the FIRST UA parenthetical (the platform token) to Windows, preserving the rest of the live UA
 *  (AppleWebKit/Chrome/Safari tokens, version). Falls back to a full template if the live UA is empty. */
function windowsUaString(live: LiveUserAgent): string {
  const ua = live.userAgent ?? "";
  if (ua.includes("(")) return ua.replace(/\([^)]*\)/, `(${WINDOWS_PLATFORM_TOKEN})`);
  const major = chromeMajorFrom(ua);
  return `Mozilla/5.0 (${WINDOWS_PLATFORM_TOKEN}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/**
 * Build a coherent **Windows 10/11** override from the LIVE UA-CH: mutate ONLY the OS-bearing fields
 * (UA platform token → Windows, `navigator.platform` → Win32, UA-CH `platform`/`platformVersion` →
 * Windows 11) and PRESERVE the live `brands`/`fullVersionList`/architecture/bitness so the brand list
 * and full-version values stay exactly what the real Chrome reports (no fabricated, drifting tell).
 * Falls back to derived defaults only when the live values are absent.
 */
export function buildWindowsUaOverride(live: LiveUserAgent): UserAgentOverride {
  const major = chromeMajorFrom(live.userAgent);
  const brands = live.brands?.length ? live.brands : defaultBrands(major);
  const fullVersionList = live.fullVersionList?.length ? live.fullVersionList : defaultFullVersionList(major);
  return {
    userAgent: windowsUaString(live),
    platform: "Win32",
    acceptLanguage: STD_ACCEPT_LANGUAGE,
    userAgentMetadata: {
      platform: "Windows",
      platformVersion: "15.0.0", // Sec-CH-UA-Platform-Version ≥ 13 ⇒ Windows 11
      architecture: live.architecture ?? "x86",
      model: live.model ?? "",
      mobile: live.mobile ?? false,
      bitness: live.bitness ?? "64",
      wow64: live.wow64 ?? false,
      brands,
      fullVersionList,
    },
  };
}

/**
 * Rebuild the NATIVE override from the captured live values — re-applied to RESTORE the native identity
 * after a Windows override, so a reused drive page that leaves a listed host stops presenting Windows on
 * the next (non-listed) navigation. Functionally equal to the un-overridden state (same values), so it
 * is JS-indistinguishable from "no override," while giving us a single clean mechanism (one CDP call)
 * to flip back. Falls back to a Linux template only if the live UA was never captured.
 */
export function buildNativeUaOverride(live: LiveUserAgent): UserAgentOverride {
  const major = chromeMajorFrom(live.userAgent);
  const brands = live.brands?.length ? live.brands : defaultBrands(major);
  const fullVersionList = live.fullVersionList?.length ? live.fullVersionList : defaultFullVersionList(major);
  return {
    userAgent: live.userAgent || `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    platform: live.platform || "Linux x86_64",
    acceptLanguage: STD_ACCEPT_LANGUAGE,
    userAgentMetadata: {
      platform: live.uaPlatform ?? "Linux",
      platformVersion: live.platformVersion ?? "",
      architecture: live.architecture ?? "x86",
      model: live.model ?? "",
      mobile: live.mobile ?? false,
      bitness: live.bitness ?? "64",
      wow64: live.wow64 ?? false,
      brands,
      fullVersionList,
    },
  };
}
