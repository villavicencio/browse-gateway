#!/usr/bin/env node
/**
 * Stealth-validation kill-gate (U1).
 *
 * Stands the browser core up and reproduces the spike's anti-bot bypass through the
 * shipping vehicle (Patchright + real Chrome, headful under Xvfb). Everything downstream
 * is blocked on this passing. Run inside the Docker image (`docker/Dockerfile`) so the
 * headful-under-Xvfb path is exercised, not a bare host browser.
 *
 * Gate: each category (Cloudflare, DataDome) must clear >= REQUIRED of ATTEMPTS, and the
 * negative control must confirm strict headless is blocked (i.e. Xvfb is load-bearing).
 *
 * Tunables (env):
 *   BGW_ATTEMPTS=3              attempts per category (round-robin across its URLs)
 *   BGW_REQUIRED=3             clears needed per category to pass
 *   BGW_CLEARANCE_TIMEOUT_MS=20000  max poll-for-clearance per attempt
 *   BGW_CHANNEL=chrome         browser channel ("" = patched chromium)
 *   BGW_NO_SANDBOX=0           "1" to pass --no-sandbox (root in container)
 *   BGW_SKIP_NEGATIVE_CONTROL=0  "1" to skip the headless negative control
 */
import { createBrowserCore, assess } from "../dist/browser/index.js";

const ATTEMPTS = Number(process.env.BGW_ATTEMPTS ?? 3);
const REQUIRED = Number(process.env.BGW_REQUIRED ?? 3);
const CLEARANCE_TIMEOUT_MS = Number(process.env.BGW_CLEARANCE_TIMEOUT_MS ?? 20_000);
const CHANNEL = process.env.BGW_CHANNEL ?? "chrome";
const NO_SANDBOX = process.env.BGW_NO_SANDBOX === "1";
const SKIP_NEGATIVE_CONTROL = process.env.BGW_SKIP_NEGATIVE_CONTROL === "1";

// Targets are env-configurable. Defaults are stable, content-rich, actively-challenging
// targets confirmed fresh (what-antibot): pure-Cloudflare (udemy/glassdoor) and DataDome
// (seloger/leboncoin). The spike's original targets remain available for parity checks:
//   BGW_CF_URLS=https://www.scrapingcourse.com/cloudflare-challenge
//   BGW_DD_URLS=https://www.leboncoin.fr/,https://www.g2.com/
// (scrapingcourse is an always-on managed challenge and IP-reputation-flaky, so it makes a
// poor stable gate target — see the cf-scrapingcourse-ip-reputation note.)
const parseUrls = (val, def) =>
  (val ?? def).split(",").map((s) => s.trim()).filter(Boolean);
const GROUPS = {
  cloudflare: parseUrls(process.env.BGW_CF_URLS, "https://www.udemy.com/,https://www.glassdoor.com/"),
  datadome: parseUrls(process.env.BGW_DD_URLS, "https://www.seloger.com/,https://www.leboncoin.fr/"),
};
// Negative control runs strict headless and must be blocked. scrapingcourse's CF challenge
// reliably blocks headless, making it a clean "Xvfb is load-bearing" signal.
const NEGATIVE_URL =
  process.env.BGW_NEGATIVE_URL ?? "https://www.scrapingcourse.com/cloudflare-challenge";

const coreOpts = { channel: CHANNEL, noSandbox: NO_SANDBOX };

/** One cold attempt: fresh context → render → classify. Returns the assessment + result. */
async function attempt(url, { headless = false } = {}) {
  const core = await createBrowserCore({ ...coreOpts, headless });
  try {
    const result = await core.render(url, {
      clearanceTimeoutMs: CLEARANCE_TIMEOUT_MS,
    });
    return { result, assessment: assess(result) };
  } finally {
    await core.close();
  }
}

function logAttempt(label, url, result, assessment) {
  const title = JSON.stringify(result.title).slice(0, 70);
  const markers = assessment.markers.length ? assessment.markers.join(", ") : "none";
  const hints = assessment.vendorHints.length ? assessment.vendorHints.join(", ") : "none";
  console.log(
    `  [${label}] ${assessment.verdict}  ${url}\n` +
      `      status=${result.status} title=${title} textLen=${assessment.textLength} ` +
      `waited=${result.clearanceWaitedMs}ms\n` +
      `      block-phrases=${markers}  vendor-hints=${hints}`,
  );
}

async function runGroup(category, urls) {
  console.log(`\n── ${category} (need ${REQUIRED}/${ATTEMPTS}) ──`);
  let passes = 0;
  for (let i = 0; i < ATTEMPTS; i++) {
    const url = urls[i % urls.length];
    const { result, assessment } = await attempt(url);
    const ok = assessment.verdict === "GO";
    if (ok) passes++;
    logAttempt(`${i + 1}/${ATTEMPTS} ${ok ? "PASS" : "FAIL"}`, url, result, assessment);
  }
  const passed = passes >= REQUIRED;
  console.log(`  → ${category}: ${passes}/${ATTEMPTS} cleared — ${passed ? "PASS" : "FAIL"}`);
  return passed;
}

/**
 * WebRTC leak check: the managed policy baked into the image (WebRtcIPHandling =
 * disable_non_proxied_udp, docker/policies/) must prevent any server-reflexive ICE
 * candidate — `typ srflx` is STUN over plain UDP carrying the HOST's real IP, which
 * bypasses any configured proxy and reads as "proxy detected" to anti-bot vendors.
 * No proxy is needed for the check: under the policy no non-proxied UDP is allowed at
 * all, so a compliant image gathers no srflx candidate even direct. The launch switch
 * alone does NOT pass this (ignored by Chrome 149) — the policy file is load-bearing.
 */
async function runWebrtcLeakCheck() {
  console.log(`\n── webrtc: no non-proxied ICE candidates (managed policy) ──`);
  const core = await createBrowserCore({ ...coreOpts });
  try {
    const page = await core.context.newPage();
    await page
      .goto("https://example.com/", { waitUntil: "domcontentloaded", timeout: 30_000 })
      .catch(() => {}); // any document works; ICE gathering needs no page network
    const candidates = await page.evaluate(async () => {
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      pc.createDataChannel("probe");
      const out = [];
      pc.onicecandidate = (e) => {
        if (e.candidate && e.candidate.candidate) out.push(e.candidate.candidate);
      };
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise((r) => setTimeout(r, 8_000));
      pc.close();
      return out;
    });
    const srflx = candidates.filter((c) => c.includes("typ srflx"));
    const passed = srflx.length === 0;
    console.log(
      `  candidates=${candidates.length} srflx=${srflx.length} — ` +
        `${passed ? "PASS" : "FAIL (non-proxied UDP escaped — policy file missing/ignored)"}`,
    );
    for (const c of srflx) console.log(`    ${c}`);
    return passed;
  } finally {
    await core.close();
  }
}

/** Negative control: strict headless on the CF target must be blocked (proves Xvfb works). */
async function runNegativeControl() {
  console.log(`\n── negative control: strict headless must be blocked ──`);
  const url = NEGATIVE_URL;
  const { result, assessment } = await attempt(url, { headless: true });
  const blocked = assessment.verdict !== "GO";
  logAttempt(blocked ? "headless PASS(blocked)" : "headless FAIL(cleared)", url, result, assessment);
  console.log(
    `  → headless ${blocked ? "blocked as expected" : "UNEXPECTEDLY cleared"} — ` +
      `${blocked ? "PASS" : "FAIL"}`,
  );
  return blocked;
}

async function main() {
  console.log("=== browse-gateway :: stealth-validation kill-gate (U1) ===");
  console.log(
    `channel=${CHANNEL || "patched-chromium"} noSandbox=${NO_SANDBOX} ` +
      `attempts=${ATTEMPTS} required=${REQUIRED} clearanceTimeout=${CLEARANCE_TIMEOUT_MS}ms`,
  );

  const cloudflare = await runGroup("cloudflare", GROUPS.cloudflare);
  const datadome = await runGroup("datadome", GROUPS.datadome);
  const webrtc = await runWebrtcLeakCheck();
  const negative = SKIP_NEGATIVE_CONTROL ? true : await runNegativeControl();
  if (SKIP_NEGATIVE_CONTROL) console.log("\n(negative control skipped)");

  const passed = cloudflare && datadome && webrtc && negative;
  console.log(`\n=== GATE: ${passed ? "PASS ✅" : "FAIL ❌"} ===`);
  console.log(
    `  cloudflare=${cloudflare ? "PASS" : "FAIL"} ` +
      `datadome=${datadome ? "PASS" : "FAIL"} ` +
      `webrtc=${webrtc ? "PASS" : "FAIL"} ` +
      `negative-control=${negative ? "PASS" : "FAIL"}`,
  );
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error("\n=== GATE: FAIL ❌ (harness error) ===");
  console.error(err);
  process.exit(1);
});
