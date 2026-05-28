#!/usr/bin/env node
/**
 * U5 retrieve() proof (AE1). Run in-container. Drives the full stack — authenticate ->
 * allowlist-guarded session -> headful stealth render -> readable-markdown extraction —
 * and confirms retrieve() returns clean content for a hard (Cloudflare-protected) target.
 * No proxy is needed from the residential IP (escalation stays off).
 */
import { Gateway, loadConfig } from "../dist/gateway/index.js";
import { PolicyEngine, ConsumerRegistry } from "../dist/policy/index.js";
import { SecretStore } from "../dist/security/index.js";
import { retrieve } from "../dist/verbs/index.js";

const TARGET = process.env.BGW_RETRIEVE_URL ?? "https://www.udemy.com/";
const host = new URL(TARGET).hostname.replace(/^www\./, "");

const policy = new PolicyEngine({
  registry: new ConsumerRegistry([{ id: "agent-1", token: "tok-agent-1", allow: [host, `*.${host}`] }]),
});
const gateway = Gateway.create(loadConfig(), undefined, policy);
const secrets = new SecretStore(() => ({})); // no proxy configured

let failures = 0;
const check = (label, ok) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

console.log("=== browse-gateway :: retrieve() proof (U5 / AE1) ===");
console.log(`[retrieve] target=${TARGET} allow=[${host}, *.${host}]`);

try {
  const r = await retrieve(gateway, secrets, { token: "tok-agent-1", url: TARGET, clearanceTimeoutMs: 15_000 });
  console.log(
    `  result: status=${r.status} blocked=${r.blocked} degraded=${r.degraded} proxyUsed=${r.proxyUsed} markdownLen=${r.markdown.length}`,
  );
  console.log("  --- markdown head ---");
  console.log(r.markdown.split("\n").slice(0, 6).map((l) => `  | ${l}`).join("\n"));
  check("retrieve returned substantial readable markdown", r.markdown.length > 200);
  check("hard CF target not blocked", r.blocked === false);
  check("no proxy engaged from residential IP (AE2-adjacent)", r.proxyUsed === false);
} finally {
  await gateway.shutdown();
}

console.log(`\n=== RETRIEVE GATE: ${failures === 0 ? "PASS ✅" : "FAIL ❌"} (${failures} failure(s)) ===`);
process.exit(failures === 0 ? 0 : 1);
