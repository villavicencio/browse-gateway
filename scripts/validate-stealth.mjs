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
import { proxyFromSecrets } from "../dist/verbs/index.js";
import { SecretStore, redactSecrets } from "../dist/security/index.js";
import { RedactingAuditSink, InMemoryAuditSink } from "../dist/policy/index.js";

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

// Optional: route the anti-bot legs (CF/DataDome) through the configured residential proxy when
// BGW_PROXY_* is set. Production serves CF via a residential exit, NEVER the bare host IP — so a
// direct run on a datacenter host fails CF on IP reputation alone (not a fingerprint signal), making
// a prod-direct gate a false negative. With the proxy set this becomes a REPRESENTATIVE fingerprint
// check; unset, it stays direct (the default — local/CI runs on a clean residential IP need no proxy).
// The webrtc/webgl/negative-control legs stay DIRECT by design: they are IP-independent fingerprint
// checks, a proxy could perturb ICE gathering, and the negative control must not be helped by a clean
// exit IP. proxyFromSecrets reads BGW_PROXY_URL/_USERNAME/_PASSWORD; never printed (secret).
const PROXY = proxyFromSecrets(new SecretStore());

// Production installs a navigation guard on every session BEFORE navigating, so all real anti-bot
// traffic egresses THROUGH the CDP-Fetch interception (setNavigationGuard). Engage that same path
// here (an allow-all guard changes nothing about which requests go out — it only turns on the
// interception machinery) so this kill-gate actually proves the CDP-Fetch backend did not regress
// the fingerprint. Set BGW_STEALTH_NO_GUARD=1 for a guard-off A/B baseline.
const GUARD_ON = process.env.BGW_STEALTH_NO_GUARD !== "1";
const ALLOW_ALL = () => "allow";
async function guardedCore(opts) {
  const core = await createBrowserCore(opts);
  if (GUARD_ON) await core.setNavigationGuard(ALLOW_ALL);
  return core;
}

/** One cold attempt: fresh context → render → classify. Returns the assessment + result. */
async function attempt(url, { headless = false, proxy } = {}) {
  const core = await guardedCore({ ...coreOpts, headless, ...(proxy ? { proxy } : {}) });
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
    const { result, assessment } = await attempt(url, { proxy: PROXY });
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
  const core = await guardedCore({ ...coreOpts });
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
      await new Promise((resolve) => {
        pc.onicegatheringstatechange = () => {
          if (pc.iceGatheringState === "complete") resolve();
        };
        setTimeout(resolve, 8_000); // cap; gathering normally completes well before
      });
      pc.close();
      return out;
    });
    // Gate on ANY UDP candidate, not just srflx: under the policy (and with no proxy
    // configured, as in this gate) no non-proxied UDP is allowed at all, so even mDNS
    // host candidates over UDP must be absent. Host candidates gather without any
    // network reachability, so a policy-less image FAILS here even if STUN is
    // unreachable — no vacuous pass.
    const udp = candidates.filter((c) => / udp /i.test(c));
    const srflx = candidates.filter((c) => c.includes("typ srflx"));
    const passed = udp.length === 0;
    console.log(
      `  candidates=${candidates.length} udp=${udp.length} srflx=${srflx.length} — ` +
        `${passed ? "PASS" : "FAIL (non-proxied UDP escaped — policy file missing/ignored)"}`,
    );
    for (const c of udp) console.log(`    ${c}`);
    return passed;
  } finally {
    await core.close();
  }
}

/**
 * WebGL presence check: the software-GL launch args (--use-gl=angle --use-angle=swiftshader
 * --enable-unsafe-swiftshader) must produce a real WebGL context. Under Xvfb with no GPU,
 * Chrome 149 otherwise returns NO context (`getContext('webgl')` === null) — "WebGL absent"
 * is a strong anti-bot tell and was the top divergence vs a real desktop. A non-null renderer
 * (SwiftShader is expected and fine) passes; null fails.
 */
async function runWebglCheck() {
  console.log(`\n── webgl: a real context exists (software-GL args) ──`);
  const core = await guardedCore({ ...coreOpts });
  try {
    const page = await core.context.newPage();
    await page
      .goto("https://example.com/", { waitUntil: "domcontentloaded", timeout: 30_000 })
      .catch(() => {});
    const webgl = await page.evaluate(() => {
      try {
        const c = document.createElement("canvas");
        const gl = c.getContext("webgl") || c.getContext("experimental-webgl");
        if (!gl) return null;
        const dbg = gl.getExtension("WEBGL_debug_renderer_info");
        return {
          renderer: gl.getParameter(gl.RENDERER),
          unmaskedRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
        };
      } catch (e) {
        return { error: String(e) };
      }
    });
    // Pass = a context EXISTS (webgl non-null, no exception). The renderer string is
    // informational — some privacy configs mask it to "" even with a live context, so
    // gating on its truthiness would false-FAIL a browser that actually has WebGL.
    const passed = Boolean(webgl && !webgl.error);
    console.log(
      `  webgl=${JSON.stringify(webgl)} — ` +
        `${passed ? "PASS" : "FAIL (no WebGL context — software-GL args missing/ineffective)"}`,
    );
    return passed;
  } finally {
    await core.close();
  }
}

/**
 * Secret-leak check (U7 R4): prove the redaction mechanism actually scrubs a stored vault value out of
 * the surfaces redaction is wired into — process logs/errors (`redactSecrets`) and the audit trail
 * (`RedactingAuditSink`) — so a regression that re-exposed a credential turns this leg RED. Modeled on
 * the WebRTC leg: plant a sentinel, exercise the real surfaces, FAIL on any leak. It needs no real
 * credential — the sentinel stands in for a cookie/password/TOTP value, registered exactly as vault
 * creds are (`addRedactable`) — and runs without a browser, so it is the cheapest leg in the gate.
 *
 * A POSITIVE CONTROL guards against a vacuous pass: the same sentinel, through a store that was NEVER
 * told about it, MUST survive — so an empty/misrouted capture (which would trivially "find no leak")
 * fails here instead of passing. This is the WebRTC leg's "no vacuous pass" property ported to secrets.
 *
 * SCOPE (honest, by design — see docs/solutions/architecture-patterns/vault-observability-redaction-gap.md): this covers the
 * surfaces redaction exists on today. Session-observability output (rendered HTML/frameHtml,
 * screenshots) and egress request bodies have NO redactor yet — a stored value rendered into the page
 * DOM is not scrubbed there. That gap is tracked follow-up; this leg deliberately does not claim it.
 */
async function runSecretLeakCheck() {
  console.log(`\n── secret-leak: stored values never survive the redaction surfaces (U7 R4) ──`);
  // A distinctive, high-entropy stand-in for a stored cookie/password/TOTP value (well over the
  // redactor's 3-char floor; characters chosen so verbatim and URL-encoded forms coincide).
  const SENTINEL = "S3NT1NEL_vault_7f3a9c2e1b8d4056_do_not_log";
  const store = new SecretStore(() => ({}));
  store.addRedactable([SENTINEL]); // folded in exactly as a decrypted vault credential is

  const carrier = `boot ok; warm session cookie=${SENTINEL}; proceeding`;
  const leaks = [];

  // Surface 1 — the log/error scrubber (every verb/MCP/CLI boundary throws redactSecrets(message)).
  const scrubbedLog = redactSecrets(carrier, store);
  if (scrubbedLog.includes(SENTINEL)) leaks.push(`log scrub leaked the sentinel: ${scrubbedLog}`);

  // Surface 2 — the audit trail (RedactingAuditSink scrubs host/url/reason before recording).
  const inner = new InMemoryAuditSink();
  new RedactingAuditSink(inner, store).record({
    ts: 0,
    consumerId: "probe",
    action: "navigate",
    decision: "block",
    host: SENTINEL,
    url: `https://example.test/${SENTINEL}`,
    reason: `blocked ${SENTINEL}`,
  });
  const serialized = JSON.stringify(inner.records);
  if (serialized.includes(SENTINEL)) leaks.push(`audit sink leaked the sentinel into a record: ${serialized}`);

  // Positive control — a store that never learned the sentinel must NOT scrub it. If this fails, the
  // probe is not exercising a live value and a "no leak" result above would be meaningless.
  const controlOk = redactSecrets(carrier, new SecretStore(() => ({}))).includes(SENTINEL);
  if (!controlOk) leaks.push("positive control FAILED — an unregistered sentinel did not survive (probe not exercising a live value)");

  const passed = leaks.length === 0;
  console.log(
    `  surfaces=2 (log-scrub, audit) control=${controlOk ? "ok" : "BROKEN"} — ` +
      `${passed ? "PASS" : "FAIL (a stored value escaped a redaction surface)"}`,
  );
  for (const l of leaks) console.log(`    ${l}`);
  console.log("  (scope: log + audit surfaces; observability HTML/screenshots + egress payloads are an unredacted, documented gap)");
  return passed;
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
  console.log(
    `anti-bot legs: ${PROXY ? "via configured proxy (representative)" : "DIRECT — set BGW_PROXY_* to route CF/DataDome through a residential exit (a datacenter-direct CF fail is IP reputation, not a fingerprint signal)"}`,
  );

  const cloudflare = await runGroup("cloudflare", GROUPS.cloudflare);
  const datadome = await runGroup("datadome", GROUPS.datadome);
  const webrtc = await runWebrtcLeakCheck();
  const webgl = await runWebglCheck();
  const secretLeak = await runSecretLeakCheck();
  const negative = SKIP_NEGATIVE_CONTROL ? true : await runNegativeControl();
  if (SKIP_NEGATIVE_CONTROL) console.log("\n(negative control skipped)");

  const passed = cloudflare && datadome && webrtc && webgl && secretLeak && negative;
  console.log(`\n=== GATE: ${passed ? "PASS ✅" : "FAIL ❌"} ===`);
  console.log(
    `  cloudflare=${cloudflare ? "PASS" : "FAIL"} ` +
      `datadome=${datadome ? "PASS" : "FAIL"} ` +
      `webrtc=${webrtc ? "PASS" : "FAIL"} ` +
      `webgl=${webgl ? "PASS" : "FAIL"} ` +
      `secret-leak=${secretLeak ? "PASS" : "FAIL"} ` +
      `negative-control=${negative ? "PASS" : "FAIL"}`,
  );
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error("\n=== GATE: FAIL ❌ (harness error) ===");
  console.error(err);
  process.exit(1);
});
