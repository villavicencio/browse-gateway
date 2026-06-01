#!/usr/bin/env node
/**
 * Proxy-escalation proof (R7 / cutover findings #2 + #3). Run IN-CONTAINER with the BYO proxy
 * env set (BGW_PROXY_URL[, BGW_PROXY_USERNAME, BGW_PROXY_PASSWORD]). Confirms, end-to-end
 * through the shipping image:
 *   1. the residential proxy is reachable and exits from a DIFFERENT IP than the host (proves
 *      the creds are valid and the exit is residential, not the datacenter IP);
 *   2. a HARD block (4xx/5xx + thin body) is flagged `blocked` (finding #2) and ARMS + fires
 *      scoped escalation through the proxy (finding #3) — deterministic via httpbin /status/403;
 *   3. (best-effort) a real reputation-403 target returns content instead of "Forbidden" —
 *      depends on the host IP currently being hot, so it's a note, not a hard failure.
 *
 * Escalation is gated on `onDatacenterIp`; this script forces it true (the prod host is a DC IP).
 * SKIPs cleanly when no proxy is configured. Secret values are never printed (only exit IPs).
 */
import { Gateway, loadConfig } from "../dist/gateway/index.js";
import { PolicyEngine, ConsumerRegistry } from "../dist/policy/index.js";
import { SecretStore } from "../dist/security/index.js";
import { retrieve, proxyFromSecrets } from "../dist/verbs/index.js";

const HARD_TARGET = process.env.BGW_RETRIEVE_URL ?? "https://www.udemy.com/"; // the F1 reputation-403 case
const IP_ECHO = "https://api.ipify.org/"; // plain-text exit IP
const HARD_403 = "https://httpbin.org/status/403"; // deterministic 4xx + empty body

const hosts = [HARD_TARGET, IP_ECHO, HARD_403].map((u) => new URL(u).hostname.replace(/^www\./, ""));
const allow = [...new Set(hosts.flatMap((h) => [h, `*.${h}`]))];

const secrets = new SecretStore(); // reads BGW_PROXY_* from process.env
const proxy = proxyFromSecrets(secrets);

console.log("=== browse-gateway :: proxy-escalation proof (R7 / findings #2 + #3) ===");
if (!proxy) {
  console.log("  SKIP: BGW_PROXY_URL not set — nothing to escalate to. Set the proxy env and re-run.");
  process.exit(0);
}

const policy = new PolicyEngine({ registry: new ConsumerRegistry([{ id: "agent-1", token: "tok", allow }]) });
const gateway = Gateway.create(loadConfig(), undefined, policy);
const token = "tok";

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

const ipOf = (text) => (text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/) ?? [null])[0];
const fastRender = { clearedTextLength: 0, clearanceTimeoutMs: 10_000 }; // IP echo is a tiny page

try {
  // 1) Residential exit IP — direct vs through the proxy.
  const direct = await gateway.withConsumerSession(token, (s) => s.core.render(IP_ECHO, fastRender));
  const viaProxy = await gateway.withConsumerSession(token, (s) => s.core.render(IP_ECHO, fastRender), { proxy });
  const directIp = ipOf(direct.text);
  const proxyIp = ipOf(viaProxy.text);
  console.log(`  exit IP: direct=${directIp ?? "?"}  via-proxy=${proxyIp ?? "?"}`);
  check("proxy reachable and returned an exit IP", Boolean(proxyIp));
  check("proxy exits from a different IP than direct (residential, not the DC IP)", Boolean(directIp && proxyIp && directIp !== proxyIp));

  // 2) Hard block (4xx + thin) — flagged blocked AND fires escalation through the proxy. Deterministic.
  const r403 = await retrieve(gateway, secrets, { token, url: HARD_403, escalation: { onDatacenterIp: true }, clearanceTimeoutMs: 10_000 });
  console.log(`  httpbin/403: status=${r403.status} blocked=${r403.blocked} proxyUsed=${r403.proxyUsed}`);
  check("a 4xx + thin response is flagged blocked, not returned as content (finding #2)", r403.blocked === true);
  check("escalation fired through the proxy on the hard block (finding #3)", r403.proxyUsed === true);

  // 3) Real reputation-403 target — best-effort (depends on current DC-IP heat).
  const rt = await retrieve(gateway, secrets, { token, url: HARD_TARGET, escalation: { onDatacenterIp: true }, clearanceTimeoutMs: 20_000 });
  console.log(`  ${HARD_TARGET}: status=${rt.status} blocked=${rt.blocked} proxyUsed=${rt.proxyUsed} markdownLen=${rt.markdown.length}`);
  if (rt.blocked === false && rt.markdown.length > 200) {
    check(`real target returned content${rt.proxyUsed ? " VIA PROXY — reputation block cleared 🎯" : " direct (DC IP not currently blocked)"}`, true);
  } else {
    note(`real target still blocked (proxyUsed=${rt.proxyUsed}) — DC IP may need heating, or the proxy exit is also blocked. Re-run, or hammer the target direct first to provoke the 403.`);
  }
} catch (err) {
  console.log(`  FAIL  threw: ${err instanceof Error ? err.message : String(err)}`);
  failures++;
} finally {
  await gateway.shutdown();
}

const verdict = failures === 0 ? (notes ? "PASS (with notes) ⚠️" : "PASS ✅") : "FAIL ❌";
console.log(`\n=== PROXY-ESCALATION GATE: ${verdict} (${failures} failure(s), ${notes} note(s)) ===`);
process.exit(failures === 0 ? 0 : 1);
