/**
 * U4 security-boundary tests — egress classification, egress-deny-wins in the guard, CDP
 * exposure guard, and secret isolation/redaction/rotation. The in-container proof that a
 * page can't reach 169.254.169.254 runs via scripts/validate-policy.mjs (egress section).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isBlockedEgressHost,
  assertLocalCdpOnly,
  SecretStore,
  redactSecrets,
} from "../dist/security/index.js";
import {
  PolicyEngine,
  ConsumerRegistry,
  InMemoryAuditSink,
  RedactingAuditSink,
} from "../dist/policy/index.js";

const nav = (host, url = `http://${host}/`) => ({
  url,
  host,
  resourceType: "document",
  isNavigationRequest: true,
});

test("isBlockedEgressHost: blocks metadata + private/loopback/link-local/CGNAT + internal names", () => {
  for (const h of [
    "169.254.169.254", "10.0.0.5", "192.168.1.1", "172.16.0.1", "172.31.255.255",
    "127.0.0.1", "0.0.0.0", "100.64.0.1", "localhost", "svc.internal",
    "metadata.google.internal", "::1", "[::1]", "fe80::1", "fc00::1", "::ffff:10.0.0.1",
  ]) {
    assert.equal(isBlockedEgressHost(h), true, `expected ${h} blocked`);
  }
});

test("isBlockedEgressHost: allows ordinary public hosts/IPs", () => {
  for (const h of ["example.com", "8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "203.0.113.7"]) {
    assert.equal(isBlockedEgressHost(h), false, `expected ${h} allowed`);
  }
});

test("assertLocalCdpOnly: throws on a non-local debugging address, allows local/none", () => {
  assert.throws(() => assertLocalCdpOnly(["--remote-debugging-address=0.0.0.0"]), /non-local/);
  assertLocalCdpOnly(["--remote-debugging-address=127.0.0.1"]);
  assertLocalCdpOnly(["--no-sandbox"]);
  assertLocalCdpOnly([]);
});

test("guard: egress deny wins over an allowlist entry (R19)", () => {
  const audit = new InMemoryAuditSink();
  const policy = new PolicyEngine({
    // 169.254.169.254 is explicitly allowlisted, yet egress must still block it.
    registry: new ConsumerRegistry([{ id: "agent-1", token: "t", allow: ["169.254.169.254", "example.com"] }]),
    audit,
  });
  const guard = policy.guardFor(policy.authenticate("t"));
  assert.equal(guard(nav("169.254.169.254", "http://169.254.169.254/latest/meta-data/")), "block");
  assert.equal(guard(nav("example.com")), "allow");
  const blocked = audit.forConsumer("agent-1").find((r) => r.decision === "block");
  assert.match(blocked.reason, /egress/);
});

test("SecretStore: loads known keys, reload picks up rotation, never stringifies values", () => {
  let env = { BGW_CAPTCHA_API_KEY: "key-aaaa-1111", OTHER: "ignored" };
  const store = new SecretStore(() => env);
  assert.equal(store.get("BGW_CAPTCHA_API_KEY"), "key-aaaa-1111");
  assert.equal(store.has("BGW_PROXY_URL"), false);
  env = { BGW_CAPTCHA_API_KEY: "key-bbbb-2222" };
  store.reload();
  assert.equal(store.get("BGW_CAPTCHA_API_KEY"), "key-bbbb-2222");
  assert.equal(JSON.stringify(store), JSON.stringify({ BGW_CAPTCHA_API_KEY: "[REDACTED]" }));
});

test("redactSecrets: scrubs secret values, leaves short noise, no secret survives", () => {
  const store = new SecretStore(() => ({
    BGW_PROXY_PASSWORD: "hunter2-long-password",
    BGW_CAPTCHA_API_KEY: "abcd-1234-secret",
  }));
  const out = redactSecrets("proxy=hunter2-long-password captcha=abcd-1234-secret", store);
  assert.ok(!out.includes("hunter2-long-password"));
  assert.ok(!out.includes("abcd-1234-secret"));
  assert.equal(out, "proxy=[REDACTED] captcha=[REDACTED]");
});

test("RedactingAuditSink: secret material never reaches the underlying sink", () => {
  const store = new SecretStore(() => ({ BGW_PROXY_URL: "http://u:p4ssw0rd-secret@proxy.internal:8080" }));
  const inner = new InMemoryAuditSink();
  const sink = new RedactingAuditSink(inner, store);
  sink.record({
    ts: 1,
    consumerId: "agent-1",
    action: "navigate",
    decision: "allow",
    url: "https://x/?via=http://u:p4ssw0rd-secret@proxy.internal:8080",
    reason: "routed via http://u:p4ssw0rd-secret@proxy.internal:8080",
  });
  const serialized = JSON.stringify(inner.records[0]);
  assert.ok(!serialized.includes("p4ssw0rd-secret"), "secret leaked into audit record");
  assert.ok(serialized.includes("[REDACTED]"));
});
