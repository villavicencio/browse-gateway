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
import { mintStickyProxy, stickySuffixRedactables } from "../dist/verbs/index.js";

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

test("isBlockedEgressHost: blocks alternate-encoding + trailing-dot bypasses (SSRF regression)", () => {
  for (const h of [
    // IPv4-mapped IPv6 in the hex form URL canonicalization produces — the metadata/loopback bypass
    "[::ffff:7f00:1]", "::ffff:7f00:1", "[::ffff:a9fe:a9fe]", "::ffff:a9fe:a9fe", "[::ffff:a00:5]",
    // trailing-dot FQDNs resolve identically to the dotted form, must not evade the name checks
    "metadata.google.internal.", "localhost.", "svc.internal.",
    // IPv6 site-local
    "[fec0::1]", "fec0::1",
  ]) {
    assert.equal(isBlockedEgressHost(h), true, `expected ${h} blocked`);
  }
});

test("isBlockedEgressHost: does NOT over-block public hosts beginning fc/fd/fe (availability regression)", () => {
  // The old IPv6-prefix regexes (/^f[cd]/, /^fe[89ab]/) ran on every host and wrongly blocked these.
  for (const h of ["fc-barcelona.com", "fdn.example.com", "febreze.com", "fcc.gov", "fda.gov"]) {
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

test("redactSecrets: also scrubs the URL-encoded form; skips 1-2 char secrets", () => {
  const store = new SecretStore(() => ({
    BGW_PROXY_PASSWORD: "p@ss",   // encodes to p%40ss — the realistic proxy-error leak form
    BGW_PROXY_USERNAME: "ab",     // 2 chars -> skipped so it can't blanket-redact ordinary text
    BGW_CAPTCHA_API_KEY: "key123",
  }));
  const out = redactSecrets("raw=p@ss enc=p%40ss key=key123", store);
  assert.ok(!out.includes("p@ss"), "verbatim secret leaked");
  assert.ok(!out.includes("p%40ss"), "url-encoded secret leaked");
  assert.ok(!out.includes("key123"));
  assert.equal(redactSecrets("about the table", store), "about the table", "2-char secret must not blanket-redact");
});

test("redactSecrets: still scrubs a credential rotated OUT of the store (rotation can't un-redact)", () => {
  let env = { BGW_PROXY_PASSWORD: "old-rotated-password" };
  const store = new SecretStore(() => env);
  env = { BGW_PROXY_PASSWORD: "new-current-password" };
  store.reload(); // rotation: the old value is gone from the *current* set
  const out = redactSecrets("err old=old-rotated-password new=new-current-password", store);
  assert.ok(!out.includes("old-rotated-password"), "a retired-but-in-flight credential must still be redacted");
  assert.ok(!out.includes("new-current-password"), "current credential redacted");
  assert.equal(out, "err old=[REDACTED] new=[REDACTED]");
});

test("redactSecrets: scrubs a LARGE folded value without throwing (regex-too-large regression)", () => {
  // A big credential (e.g. a long session token) folded into the set used to make redactSecrets throw
  // V8's "regular expression too large" when it compiled new RegExp(escapeRegExp(value)). The literal
  // replaceAll path must scrub it cleanly instead.
  const big = "T" + "k".repeat(70000);
  const store = new SecretStore(() => ({}));
  store.addRedactable([big]);
  let out;
  assert.doesNotThrow(() => { out = redactSecrets(`log token=${big} tail`, store); });
  assert.equal(out, "log token=[REDACTED] tail");
});

test("stickySuffixRedactables + redactSecrets: a minted sticky proxy password never leaks the provider param structure", () => {
  const suffix = "_country-us_session-{id}_lifetime-30m";
  const store = new SecretStore(() => ({ BGW_PROXY_PASSWORD: "hunter2-long-password" }));
  // Boot-time fold of the suffix's literal fragments (mirrors runtime.ts / main.ts).
  store.addRedactable(stickySuffixRedactables(suffix));
  // What mintStickyProxy produces for one escalation attempt (fresh 8-hex id), if a driver echoed it.
  const minted = mintStickyProxy({ server: "http://p.example:1", password: "hunter2-long-password" }, suffix, "abc12345");
  const out = redactSecrets(`ERR_PROXY_CONNECTION_FAILED pass=${minted.password}`, store);
  assert.ok(!out.includes("hunter2-long-password"), "base proxy password leaked");
  assert.ok(!out.includes("_country-us_session-"), "provider session/geo structure leaked");
  assert.ok(!out.includes("_lifetime-30m"), "provider lifetime structure leaked");
  // Only the ephemeral, opaque per-attempt exit id remains — non-credential, not knowable ahead of time.
  assert.ok(out.includes("abc12345"), "the ephemeral exit id is the expected residual");
});

test("stickySuffixRedactables: degenerate suffixes never blanket-redact ordinary output", () => {
  assert.deepEqual(stickySuffixRedactables(undefined), []);
  assert.deepEqual(stickySuffixRedactables("{id}"), []); // pure placeholder -> nothing to fold
  const store = new SecretStore(() => ({}));
  store.addRedactable(stickySuffixRedactables("_s{id}")); // "_s" is 2 chars -> redactSecrets skips it
  assert.equal(redactSecrets("path_saved ok", store), "path_saved ok");
});

test("InMemoryAuditSink: maxRecords keeps only the most recent N (ring buffer)", () => {
  const sink = new InMemoryAuditSink(2);
  for (let i = 0; i < 5; i++) sink.record({ ts: i, consumerId: "a", action: "navigate", decision: "allow" });
  assert.equal(sink.records.length, 2);
  assert.deepEqual(sink.records.map((r) => r.ts), [3, 4]);
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
