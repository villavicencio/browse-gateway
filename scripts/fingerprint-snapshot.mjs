#!/usr/bin/env node
/**
 * Fingerprint-parity snapshot — capture one host's browser fingerprint through the shipping
 * core, for diffing against another host (see scripts/fingerprint-diff.mjs).
 *
 * The whole point is to run the SAME build on two environments — your residential desktop and
 * the prod VPS container, ideally through the SAME proxy — and compare. A divergent axis is a
 * candidate anti-bot tell.
 *
 * ── Run ─────────────────────────────────────────────────────────────────────────────────────
 *   npm run build
 *   # Mac (direct, or `set -a; . .env.spike; set +a` first to route through the proxy):
 *   FP_LABEL=mac FP_OUT=mac.fp.json node scripts/fingerprint-snapshot.mjs
 *   # Prod container (mount this script + pass the proxy creds):
 *   docker run --rm --init --shm-size=1g \
 *     -v $PWD/scripts/fingerprint-snapshot.mjs:/app/scripts/fingerprint-snapshot.mjs:ro \
 *     -e BGW_NO_SANDBOX -e BGW_PROXY_URL -e BGW_PROXY_USERNAME -e BGW_PROXY_PASSWORD \
 *     -e FP_LABEL=vps <image> node scripts/fingerprint-snapshot.mjs > vps.fp.json
 *
 * Snapshot files (*.fp.json / fingerprint-*.json) are gitignored — they carry the egress IP.
 *
 * Env:
 *   FP_LABEL        snapshot label (e.g. "mac" / "vps"); default "unlabeled"
 *   FP_OUT          also write the JSON to this path (always printed to stdout regardless)
 *   BGW_CHANNEL     browser channel; default "chrome"
 *   BGW_NO_SANDBOX  "1" to pass --no-sandbox (root in container)
 *   BGW_PROXY_URL / _USERNAME / _PASSWORD   route through a proxy if set
 *     (SPIKE_PROXY_* accepted as a fallback, matching the spike harnesses)
 */
import { writeFileSync } from "node:fs";
import { createBrowserCore, collectFingerprint } from "../dist/browser/index.js";

const LABEL = process.env.FP_LABEL ?? "unlabeled";
const OUT = process.env.FP_OUT ?? "";
const CHANNEL = process.env.BGW_CHANNEL ?? "chrome";
const NO_SANDBOX = process.env.BGW_NO_SANDBOX === "1";

const proxyUrl = process.env.BGW_PROXY_URL ?? process.env.SPIKE_PROXY_URL ?? "";
const proxy = proxyUrl
  ? {
      server: proxyUrl,
      username: process.env.BGW_PROXY_USERNAME ?? process.env.SPIKE_PROXY_USERNAME ?? "",
      password: process.env.BGW_PROXY_PASSWORD ?? process.env.SPIKE_PROXY_PASSWORD ?? "",
    }
  : undefined;

const core = await createBrowserCore({
  channel: CHANNEL,
  noSandbox: NO_SANDBOX,
  ...(proxy ? { proxy } : {}),
});
let page;
try {
  // newPage is inside the try so a context-spawn failure still reaches the finally and
  // closes the core (no orphaned headful-Chrome-under-Xvfb process tree).
  page = await core.context.newPage();
  // Secure origin so the canvas-hash (crypto.subtle) works; also a realistic document.
  await page.goto("https://example.com/", { waitUntil: "domcontentloaded", timeout: 30_000 });
  const fingerprint = await collectFingerprint(page);

  let egressIp = null;
  try {
    egressIp = await page.evaluate(async () => {
      const r = await fetch("https://api.ipify.org?format=json", { cache: "no-store" });
      return (await r.json()).ip;
    });
  } catch {
    /* best-effort; a null egress IP just means the echo was unreachable */
  }

  const snapshot = {
    meta: {
      label: LABEL,
      capturedAt: new Date().toISOString(),
      channel: CHANNEL,
      proxied: Boolean(proxy),
      egressIp,
      chromeUA: typeof fingerprint.userAgent === "string" ? fingerprint.userAgent : null,
    },
    fingerprint,
  };

  const json = JSON.stringify(snapshot, null, 2);
  console.log(json);
  if (OUT) {
    writeFileSync(OUT, json);
    console.error(`[fingerprint-snapshot] wrote ${OUT} (label=${LABEL}, egressIp=${egressIp})`);
  }
} finally {
  if (page) await page.close().catch(() => {});
  await core.close();
}
