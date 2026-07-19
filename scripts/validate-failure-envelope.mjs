#!/usr/bin/env node
/**
 * Failure-diagnostics envelope proof (issue #39). Run IN-CONTAINER (headful Chrome under Xvfb) — it
 * drives the FULL stack with NO mocks, exactly like validate-retrieve.mjs / validate-drive.mjs, and
 * confirms the evidence envelope is populated at parity across the retrieve and drive paths on failure,
 * and is SECRET-FREE after redaction. Cannot run on the host (needs Docker/Xvfb + network).
 *
 * Checks:
 *   1. nav-failed (off-allowlist) — retrieve returns `blocked` with a populated `diagnostics`
 *      envelope (finalUrl + status), and the drive path THROWS an error carrying the same envelope
 *      (`failureOf(err)`), so both surfaces expose it at parity.
 *   2. post-redirect finalUrl + redirectChain — a drive navigate through a 302 lands with
 *      `diagnostics.finalUrl` = the FINAL (post-redirect) URL and a multi-hop `redirectChain`
 *      (the retrieve URL-bug fix, proven on real evidence). (Notes if httpbin is unreachable.)
 *   3. redaction on LIVE evidence — a token present in the captured finalUrl is scrubbed to
 *      `[REDACTED]` by `redactFailureDiagnostics`, proving the redaction seam works end-to-end on
 *      real captured evidence, not just a synthetic string.
 *   4. cf-challenge — a real Cloudflare target populates the envelope (finalUrl/status/redirect);
 *      when the challenge clears (or an IP-reputation block hits), degrades to a note.
 */
import { Gateway, loadConfig } from "../dist/gateway/index.js";
import { PolicyEngine, ConsumerRegistry } from "../dist/policy/index.js";
import { SecretStore } from "../dist/security/index.js";
import { retrieve } from "../dist/verbs/index.js";
import { GatewayDriveController } from "../dist/mcp/drive-controller.js";
import { redactFailureDiagnostics, failureOf } from "../dist/observability/index.js";

const TOKEN = "tok-fd";
const CF_TARGET = process.env.BGW_FD_CF_URL ?? "https://www.udemy.com/";
const cfApex = new URL(CF_TARGET).hostname.split(".").slice(-2).join(".");
// A deterministic 302 → post-redirect finalUrl + a 2-hop redirect chain (best-effort; httpbin may be down).
const REDIRECT_URL = "https://httpbin.org/redirect-to?url=https%3A%2F%2Fhttpbin.org%2Fhtml&status_code=302";
const REDIRECT_FINAL = "https://httpbin.org/html";
const OFF_ALLOWLIST = "https://www.google.com/"; // deliberately NOT in ALLOW → guard-blocked → nav-failed
const ALLOW = ["httpbin.org", "*.httpbin.org", cfApex, `*.${cfApex}`];

const policy = new PolicyEngine({
  registry: new ConsumerRegistry([{ id: "agent-1", token: TOKEN, allow: ALLOW }]),
});
const gateway = Gateway.create(loadConfig(), undefined, policy);
const secrets = new SecretStore(() => ({})); // no proxy configured
const drive = new GatewayDriveController(gateway, secrets, TOKEN);

let failures = 0;
let notes = 0;
const check = (label, ok) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};
const note = (label) => {
  console.log(`  ~~~~  ${label}`);
  notes++;
};
/** A minimal structural secret store — only the value set matters to redactSecrets. */
const storeOf = (...values) => ({ redactableValues: () => values });
const nonEmpty = (v) => Array.isArray(v) && v.length > 0;

console.log("=== browse-gateway :: failure-diagnostics envelope proof (issue #39) ===");
console.log(`[fd] cf=${CF_TARGET} allow=[${ALLOW.join(", ")}]`);

try {
  // 1) nav-failed (off-allowlist) — envelope on BOTH surfaces at parity.
  const r = await retrieve(gateway, secrets, { token: TOKEN, url: OFF_ALLOWLIST, clearanceTimeoutMs: 8_000 });
  console.log(`  retrieve(off-allowlist): blocked=${r.blocked} reason=${r.reason} status=${r.status} hasDiag=${!!r.diagnostics}`);
  check("retrieve reports the off-allowlist nav as blocked", r.blocked === true);
  check("retrieve attaches a failure envelope on the block", !!r.diagnostics);
  if (r.diagnostics) {
    check("envelope carries a finalUrl", typeof r.diagnostics.finalUrl === "string" && r.diagnostics.finalUrl.length > 0);
    check("envelope carries the (null) status field", "status" in r.diagnostics);
    // Downstream slots must stay UNSET (this ticket only declares them).
    check("downstream slots (wafVendor/failureClass/timing) are left unset",
      r.diagnostics.wafVendor === undefined && r.diagnostics.failureClass === undefined && r.diagnostics.timing === undefined);
    check("envelope is secret-free (no cookie/authorization value leaked)",
      !/set-cookie:\s*\S/i.test(JSON.stringify(r.diagnostics)) && !/authorization:\s*\S/i.test(JSON.stringify(r.diagnostics)));
  }

  let driveEnv;
  try {
    await drive.navigate(OFF_ALLOWLIST);
  } catch (err) {
    driveEnv = failureOf(err);
    console.log(`  drive(off-allowlist) threw: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  }
  check("the drive path throws with a failure envelope attached (retrieve↔drive parity)", !!driveEnv);
  if (driveEnv) check("drive envelope carries a finalUrl", typeof driveEnv.finalUrl === "string");
  await drive.close().catch(() => {});

  // 2) post-redirect finalUrl + redirect chain (the retrieve URL-bug fix, on real evidence).
  const redir = await drive.navigate(REDIRECT_URL).catch((e) => { console.log(`  redirect nav err: ${e?.message?.split("\n")[0]}`); return null; });
  if (!redir || redir.status === null) {
    note(`redirect target unreachable (${REDIRECT_URL}) — skipping the post-redirect finalUrl + chain check`);
  } else {
    const d = redir.diagnostics ?? {};
    console.log(`  drive(302): url=${redir.url} finalUrl=${d.finalUrl} chainLen=${(d.redirectChain ?? []).length}`);
    check("a successful navigate always carries a diagnostics envelope", !!redir.diagnostics);
    check("finalUrl is the POST-redirect URL (not the requested one)", d.finalUrl === REDIRECT_FINAL);
    check("redirectChain recorded more than one hop across the 302", nonEmpty(d.redirectChain) && d.redirectChain.length >= 2);

    // 3) redaction on LIVE captured evidence — a token in the real finalUrl is scrubbed.
    const red = redactFailureDiagnostics(d, storeOf("httpbin"));
    check("redactFailureDiagnostics scrubs a secret token out of live-captured evidence",
      /\[REDACTED\]/.test(red.finalUrl) && !/httpbin/.test(red.finalUrl));
  }
  await drive.close().catch(() => {});

  // 4) cf-challenge — envelope populated; degrades to a note if the challenge clears / IP-reputation blocks.
  try {
    const cf = await drive.navigate(CF_TARGET);
    const d = cf.diagnostics ?? {};
    console.log(`  drive(cf): status=${cf.status} finalUrl=${d.finalUrl}`);
    check("the CF navigate carries a populated envelope (finalUrl + status)",
      !!cf.diagnostics && typeof d.finalUrl === "string" && "status" in d);
  } catch (err) {
    const env = failureOf(err);
    if (env) {
      check("a CF block throws with a populated failure envelope", typeof env.finalUrl === "string" && "status" in env);
    } else {
      note(`CF check skipped (${CF_TARGET}): ${err instanceof Error ? err.message.split("\n")[0] : String(err)} — likely IP reputation on a direct session`);
    }
  }
  await drive.close().catch(() => {});
} catch (err) {
  console.log(`  FAIL  threw: ${err instanceof Error ? err.message : String(err)}`);
  failures++;
} finally {
  await gateway.shutdown();
}

const verdict = failures === 0 ? (notes ? "PASS (with notes) ⚠️" : "PASS ✅") : "FAIL ❌";
console.log(`\n=== FAILURE-ENVELOPE GATE: ${verdict} (${failures} failure(s), ${notes} note(s)) ===`);
process.exit(failures === 0 ? 0 : 1);
