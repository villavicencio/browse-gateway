/**
 * U7 vault-safety rail tests. Pure-logic-here for the four rails; the live secret-leak proof runs
 * in-container via scripts/validate-stealth.mjs (runSecretLeakCheck), and the live warm-replay /
 * host-scoping proof runs via scripts/validate-vault-login.mjs + validate-vault-host-login.mjs.
 *
 *   Rail 1 — host-scoped no-exfil:  cookieBelongsToHost + hostScopeSession + buildWarmOverride filter.
 *   Rail 2 — audit every credentialed session: openConsumerSession emits a session-open record.
 *   Rail 3 — origination boundary:  OriginationBoundary.denies + guardFor deny (below the verb layer).
 *   Rail 4 — secret-leak (unit half): redactSecrets + RedactingAuditSink scrub stored values; the
 *            validate-stealth.mjs leg is the live backstop on the same surfaces.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  cookieBelongsToHost,
  SecretStore,
  redactSecrets,
  VaultStore,
  canonicalizeHost,
} from "../dist/security/index.js";
import { hostScopeSession, buildWarmOverride, importLoginToVault, getVaultEntry } from "../dist/mcp/vault-login.js";
import {
  PolicyEngine,
  ConsumerRegistry,
  InMemoryAuditSink,
  RedactingAuditSink,
  OriginationBoundary,
  ORIGINATION_DENY_REASON,
} from "../dist/policy/index.js";
import { Gateway } from "../dist/gateway/index.js";

const ck = (name, domain) => ({ name, value: "v".repeat(12), domain, path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" });
const SESSION = { cookies: [ck("sid", "ex.com")], origins: [{ origin: "https://ex.com", localStorage: [{ name: "t", value: "y".repeat(16) }] }] };
const CREDS = { username: "atlas-user", password: "p".repeat(16) };

// ───────────────────────────── Rail 1: host-scoped no-exfil ─────────────────────────────

test("cookieBelongsToHost: exact, subdomain, and dotted-parent (SSO apex) belong; unrelated + bare-TLD do not", () => {
  // Same host, leading/trailing dots, case all normalize to a match.
  assert.equal(cookieBelongsToHost("ex.com", "ex.com"), true);
  assert.equal(cookieBelongsToHost(".ex.com", "ex.com"), true);
  assert.equal(cookieBelongsToHost("EX.COM.", "ex.com"), true);
  // Cookie domain is a subdomain of the owner host.
  assert.equal(cookieBelongsToHost("sub.ex.com", "ex.com"), true);
  // Cookie domain is a DOTTED parent of the owner host (the apex/SSO case).
  assert.equal(cookieBelongsToHost("ex.com", "accounts.ex.com"), true);
  assert.equal(cookieBelongsToHost(".ex.com", "accounts.ex.com"), true);
  // Unrelated / substring-smuggle attempts do NOT belong.
  assert.equal(cookieBelongsToHost("evil.com", "ex.com"), false);
  assert.equal(cookieBelongsToHost("evilex.com", "ex.com"), false, "no dot boundary — not a subdomain");
  assert.equal(cookieBelongsToHost("ex.com.evil.com", "ex.com"), false, "suffixed attacker host is not owned");
  // A bare TLD can never OWN a host (the parent must contain a dot).
  assert.equal(cookieBelongsToHost("com", "ex.com"), false);
  // ...and the reverse direction: a bare-TLD / single-label OWNER matches ONLY exactly — it must NOT
  // own the labels beneath it, or hostScopeSession becomes a near-no-op against every "*.com" cookie.
  assert.equal(cookieBelongsToHost("ex.com", "com"), false, "a bare-TLD owner does not own *.com");
  assert.equal(cookieBelongsToHost("a.intranet", "intranet"), false, "a single-label owner does not own its subdomains");
  assert.equal(cookieBelongsToHost("localhost", "localhost"), true, "an exact single-label match still belongs");
  // IDN: a Unicode owner host and the punycode form Chrome emits in cookie domains are the same host.
  assert.equal(cookieBelongsToHost("xn--bcher-kva.example", "bücher.example"), true);
  assert.equal(cookieBelongsToHost("sub.xn--bcher-kva.example", "bücher.example"), true);
  // Empty inputs fail closed.
  assert.equal(cookieBelongsToHost("", "ex.com"), false);
  assert.equal(cookieBelongsToHost("ex.com", ""), false);
});

test("hostScopeSession: keeps only owner-host cookies + origins, drops third-party and smuggled off-host", () => {
  const state = {
    cookies: [ck("sid", "ex.com"), ck("apex", ".ex.com"), ck("ga", "analytics.example"), ck("smug", "evil.com")],
    origins: [
      { origin: "https://ex.com", localStorage: [{ name: "a", value: "1" }] },
      { origin: "https://evil.com", localStorage: [{ name: "b", value: "2" }] },
    ],
  };
  const scoped = hostScopeSession(state, "ex.com");
  assert.deepEqual(scoped.cookies.map((c) => c.name), ["sid", "apex"], "third-party + off-host cookies dropped");
  assert.deepEqual(scoped.origins.map((o) => o.origin), ["https://ex.com"], "off-host localStorage origin dropped");
});

test("buildWarmOverride: a smuggled off-host cookie can NEVER reach the restored session (R4 no-exfil)", () => {
  const entry = {
    session: { cookies: [ck("sid", "ex.com"), ck("evil", "attacker.test")], origins: [] },
    creds: CREDS,
    updatedAt: 1,
  };
  const override = buildWarmOverride(entry, new SecretStore(() => ({})), { onDatacenterIp: false, ownerHost: "ex.com" });
  assert.deepEqual(
    override.restoreState.cookies.map((c) => c.name),
    ["sid"],
    "only the owning-host cookie is injected; the off-host cookie is filtered out before it can reach the jar",
  );
});

test("cross-consumer: an entry stored for one consumer is never readable as another (injection-layer ownership)", () => {
  const dir = mkdtempSync(join(tmpdir(), "bgw-vault-safety-"));
  try {
    const vault = new VaultStore({ kek: randomBytes(32), dir, canonicalizeHost });
    importLoginToVault(vault, { consumerId: "vault", host: "ex.com", session: SESSION, creds: CREDS });
    assert.ok(getVaultEntry(vault, "vault", "ex.com"), "the owning consumer reads its own entry");
    assert.equal(getVaultEntry(vault, "atlas", "ex.com"), null, "a different consumer's lookup returns null (never the other's entry)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ───────────────────────── Rail 2: audit every credentialed session ─────────────────────────

function makeFactory() {
  const cores = [];
  const factory = async () => {
    const core = {
      kind: "fake",
      closed: false,
      async setNavigationGuard(g) {
        this.guard = g;
      },
      async render(url) {
        return { url, status: 200, title: "t", text: "x".repeat(1000), html: "", clearanceWaitedMs: 0 };
      },
      async close() {
        this.closed = true;
      },
    };
    cores.push(core);
    return core;
  };
  return { factory, cores };
}
const config = (maxSessions) => ({ maxSessions, core: {} });

test("Rail 2: a credentialed open emits a session-open audit record (consumer + host, no credential material)", async () => {
  const audit = new InMemoryAuditSink();
  const policy = new PolicyEngine({ registry: new ConsumerRegistry([{ id: "atlas", token: "tok", allow: ["ex.com"] }]), audit });
  const { factory } = makeFactory();
  const gw = Gateway.create(config(3), factory, policy);

  const handle = await gw.openConsumerSession("tok", { restoreState: SESSION }, { credentialHost: "ex.com" });
  const rec = audit.records.find((r) => r.action === "session-open");
  assert.ok(rec, "a session-open record was emitted");
  assert.equal(rec.decision, "open");
  assert.equal(rec.consumerId, "atlas");
  assert.equal(rec.host, "ex.com");
  // The record carries only attribution — never a credential value.
  const serialized = JSON.stringify(rec);
  assert.equal(serialized.includes(CREDS.password), false);
  assert.equal(serialized.includes("sid"), false, "no cookie name/value leaks into the audit record");
  await gw.closeConsumerSession("tok", handle);
});

test("Rail 2: a COLD open (no credentialHost) emits NO session-open record — only credentialed sessions are on the trail", async () => {
  const audit = new InMemoryAuditSink();
  const policy = new PolicyEngine({ registry: new ConsumerRegistry([{ id: "atlas", token: "tok", allow: ["ex.com"] }]), audit });
  const { factory } = makeFactory();
  const gw = Gateway.create(config(3), factory, policy);

  const handle = await gw.openConsumerSession("tok"); // cold, stateless
  assert.equal(audit.records.some((r) => r.action === "session-open"), false, "no session-open record for a cold session");
  assert.ok(audit.records.some((r) => r.decision === "auth-ok"), "auth was still audited");
  await gw.closeConsumerSession("tok", handle);
});

// ─────────────────────────── Rail 3: origination boundary ───────────────────────────

const navReq = (host, path = "/", isNavigationRequest = true) => ({ url: `https://${host}${path}`, host, resourceType: "document", isNavigationRequest });

test("OriginationBoundary.denies: account-creation + money-movement paths and payment hosts; login + reads pass", () => {
  const b = new OriginationBoundary();
  // Account creation paths.
  assert.equal(b.denies("ex.com", "https://ex.com/signup"), true);
  assert.equal(b.denies("ex.com", "https://ex.com/account/create"), true);
  assert.equal(b.denies("ex.com", "https://ex.com/register"), true);
  // Money movement paths + payment hosts.
  assert.equal(b.denies("ex.com", "https://ex.com/transfer"), true);
  assert.equal(b.denies("ex.com", "https://ex.com/add-card"), true);
  assert.equal(b.denies("checkout.stripe.com", "https://checkout.stripe.com/pay/abc"), true);
  // The vault's PURPOSE — login — is deliberately NOT denied.
  assert.equal(b.denies("ex.com", "https://ex.com/login"), false);
  assert.equal(b.denies("ex.com", "https://ex.com/signin"), false);
  // Ordinary reads pass, including false-positive-prone near-misses.
  assert.equal(b.denies("ex.com", "https://ex.com/products"), false);
  assert.equal(b.denies("ex.com", "https://ex.com/registered-trademarks"), false, "/register must not match /registered-...");
});

test("OriginationBoundary.denies: percent-encoded paths are decoded before matching (no /sign%75p evasion)", () => {
  const b = new OriginationBoundary();
  // A server decodes these to the denied route; matching the raw escaped pathname alone would miss it.
  assert.equal(b.denies("ex.com", "https://ex.com/sign%75p"), true, "/sign%75p -> /signup");
  assert.equal(b.denies("ex.com", "https://ex.com/trans%66er"), true, "/trans%66er -> /transfer");
  assert.equal(b.denies("ex.com", "https://ex.com/account/cr%65ate"), true, "/account/cr%65ate -> /account/create");
  // Double-encoded — iterated decode catches it.
  assert.equal(b.denies("ex.com", "https://ex.com/sign%2575p"), true, "/sign%2575p -> /sign%75p -> /signup");
  // A malformed escape must not throw and must not wrongly match.
  assert.equal(b.denies("ex.com", "https://ex.com/products%"), false);
  // A legitimately encoded NON-origination path stays allowed.
  assert.equal(b.denies("ex.com", "https://ex.com/sea%72ch"), false, "/search is not origination");
});

test("OriginationBoundary.denies: matrix params (;) and NUL truncation can't hide a denied route behind the anchor", () => {
  const b = new OriginationBoundary();
  // Matrix / path-parameter: servlet containers strip `;...` and route to the bare segment.
  assert.equal(b.denies("ex.com", "https://ex.com/transfer;id=1"), true, "/transfer;id=1 routes to /transfer");
  assert.equal(b.denies("ex.com", "https://ex.com/signup;jsessionid=x"), true);
  assert.equal(b.denies("ex.com", "https://ex.com/account/create;x=1"), true);
  assert.equal(b.denies("ex.com", "https://ex.com/foo;a=1/transfer;b=2"), true, "matrix params stripped per segment");
  assert.equal(b.denies("ex.com", "https://ex.com/trans%66er;x"), true, "composes with percent-encoding");
  // NUL truncation: a backend that cuts the path at \0 sees the denied route.
  assert.equal(b.denies("ex.com", "https://ex.com/transfer%00"), true, "/transfer%00 truncates to /transfer");
  assert.equal(b.denies("ex.com", "https://ex.com/account/create%00.html"), true);
  // A legitimate path with no denied segment after normalization stays allowed.
  assert.equal(b.denies("ex.com", "https://ex.com/account/settings;tab=2"), false);
});

test("OriginationBoundary.fromEnv: env extends the public defaults, never replaces them", () => {
  const b = OriginationBoundary.fromEnv({ BGW_ORIGINATION_DENY_HOSTS: "custom-pay.example", BGW_ORIGINATION_DENY_PATHS: "/donate(?:[/?.]|$)" });
  assert.equal(b.denies("custom-pay.example", "https://custom-pay.example/"), true, "env host added");
  assert.equal(b.denies("ex.com", "https://ex.com/donate"), true, "env path added");
  assert.equal(b.denies("paypal.com", "https://paypal.com/"), true, "default host still present");
  assert.equal(b.denies("ex.com", "https://ex.com/products"), false);
});

test("OriginationBoundary: a malformed deny-path pattern fails closed at construction (boot)", () => {
  assert.throws(() => new OriginationBoundary({ paths: ["(unterminated"] }), /invalid deny-path pattern/);
});

test("Rail 3: guardFor refuses an origination navigation below the verb layer (overrides the allowlist) and audits it", () => {
  const audit = new InMemoryAuditSink();
  // ex.com AND paypal.com are BOTH allowlisted — proving the origination deny wins over the allowlist.
  const policy = new PolicyEngine({
    registry: new ConsumerRegistry([{ id: "atlas", token: "tok", allow: ["ex.com", "paypal.com"] }]),
    audit,
  });
  const guard = policy.guardFor(policy.authenticate("tok"));

  assert.equal(guard(navReq("ex.com", "/signup")), "block", "account-creation path blocked even on an allowlisted host");
  const rec = audit.records.find((r) => r.decision === "block" && r.host === "ex.com");
  assert.equal(rec.reason, ORIGINATION_DENY_REASON);

  assert.equal(guard(navReq("paypal.com", "/")), "block", "payment-processor host blocked even though allowlisted");
  // Login + ordinary reads on an allowlisted host still pass.
  assert.equal(guard(navReq("ex.com", "/login")), "allow");
  assert.equal(guard(navReq("ex.com", "/products")), "allow");
  // The boundary is gated on TOP-LEVEL navigations: an embedded subresource to the same path is NOT
  // origination-blocked (display, not origination — left to the allowlist).
  assert.equal(guard(navReq("ex.com", "/signup", false)), "allow", "a subresource is not an origination event");
});

test("Rail 3: the origination boundary is ON BY DEFAULT (no explicit boundary passed to PolicyEngine)", () => {
  const audit = new InMemoryAuditSink();
  const policy = new PolicyEngine({ registry: new ConsumerRegistry([{ id: "atlas", token: "tok", allow: ["ex.com"] }]), audit });
  const guard = policy.guardFor(policy.authenticate("tok"));
  assert.equal(guard(navReq("ex.com", "/account/create")), "block", "the public deny set applies with no opt-in");
});

// ───────── Rail 1 (second half): credentialed-session navigation is clamped to the owner host ─────────

test("Rail 1: a credentialed session clamps NAVIGATION to the owner host — a retained parent cookie can't ride to a sibling", () => {
  const audit = new InMemoryAuditSink();
  // *.example.com is allowlisted, so the consumer guard alone would let the session reach any subdomain.
  const policy = new PolicyEngine({ registry: new ConsumerRegistry([{ id: "atlas", token: "tok", allow: ["*.example.com"] }]), audit });
  const guard = policy.guardForCredentialHost(policy.authenticate("tok"), "accounts.example.com");

  assert.equal(guard(navReq("accounts.example.com", "/dashboard")), "allow", "the owner host is navigable");
  assert.equal(guard(navReq("evil.example.com", "/")), "block", "a sibling subdomain is blocked — the parent cookie must not ride there");
  assert.equal(guard(navReq("www.example.com", "/")), "block");
  assert.equal(guard(navReq("example.com", "/")), "block", "even the apex is blocked");
  // Subresources still load within the consumer allowlist so the owner-host page renders.
  assert.equal(guard(navReq("cdn.example.com", "/app.js", false)), "allow", "a subresource is not nav-clamped");
  // The origination boundary still applies on the owner host.
  assert.equal(guard(navReq("accounts.example.com", "/signup")), "block", "origination still enforced");
  // A blocked sibling navigation is audited with the credential-scope reason.
  assert.ok(audit.records.find((r) => r.host === "evil.example.com" && /credential scope/.test(r.reason ?? "")));
});

test("Rail 1: guardForCredentialHost is never WIDER than the consumer allowlist (owner host ∩ allowlist)", () => {
  const policy = new PolicyEngine({ registry: new ConsumerRegistry([{ id: "atlas", token: "tok", allow: ["accounts.example.com"] }]) });
  const guard = policy.guardForCredentialHost(policy.authenticate("tok"), "other.com");
  assert.equal(guard(navReq("other.com", "/")), "block", "an owner host outside the consumer allowlist is still blocked");
});

test("Rail 1+2: openConsumerSession with credentialHost installs the owner-host-clamped guard AND audits the open", async () => {
  const audit = new InMemoryAuditSink();
  const policy = new PolicyEngine({ registry: new ConsumerRegistry([{ id: "atlas", token: "tok", allow: ["*.example.com"] }]), audit });
  const { factory, cores } = makeFactory();
  const gw = Gateway.create(config(3), factory, policy);

  const handle = await gw.openConsumerSession("tok", { restoreState: SESSION }, { credentialHost: "accounts.example.com" });
  const guard = cores[0].guard; // the guard installed on the session's core
  assert.equal(guard(navReq("accounts.example.com", "/")), "allow");
  assert.equal(guard(navReq("evil.example.com", "/")), "block", "sibling blocked by the credential clamp, not just the consumer allowlist");
  assert.ok(
    audit.records.find((r) => r.action === "session-open" && r.host === "accounts.example.com"),
    "the credentialed open is on the audit trail",
  );
  await gw.closeConsumerSession("tok", handle);
});

// ─────────────────── Rail 4: secret-leak (deterministic unit half) ───────────────────

test("Rail 4: a stored value folded via addRedactable is scrubbed from logs AND audit; the positive control survives", () => {
  const SENTINEL = "S3NT1NEL_cookie_7f3a9c2e1b8d4056";
  const store = new SecretStore(() => ({}));
  store.addRedactable([SENTINEL]); // exactly how a decrypted vault cookie/password/TOTP is registered
  const carrier = `warm session cookie=${SENTINEL}; ok`;

  // Surface 1 — log/error scrubber.
  const scrubbed = redactSecrets(carrier, store);
  assert.equal(scrubbed.includes(SENTINEL), false, "sentinel never survives the log scrub");
  assert.equal(scrubbed.includes("[REDACTED]"), true);

  // Surface 2 — audit trail (host/url/reason scrubbed before record()).
  const inner = new InMemoryAuditSink();
  new RedactingAuditSink(inner, store).record({
    ts: 0,
    consumerId: "atlas",
    action: "navigate",
    decision: "block",
    host: SENTINEL,
    url: `https://example.test/${SENTINEL}`,
    reason: `blocked ${SENTINEL}`,
  });
  assert.equal(JSON.stringify(inner.records).includes(SENTINEL), false, "sentinel never lands in an audit record");

  // Positive control (no vacuous pass): an unregistered sentinel MUST survive.
  assert.equal(redactSecrets(carrier, new SecretStore(() => ({}))).includes(SENTINEL), true);
});

test("Rail 4: the URL-encoded form of a stored value is also scrubbed (proxy-cred-style percent-encoded leak)", () => {
  const RAW = "p@ss/w+rd-7f3a9c"; // contains chars that percent-encode
  const store = new SecretStore(() => ({}));
  store.addRedactable([RAW]);
  const out = redactSecrets(`verbatim=${RAW} encoded=${encodeURIComponent(RAW)}`, store);
  assert.equal(out.includes(RAW), false, "verbatim form scrubbed");
  assert.equal(out.includes(encodeURIComponent(RAW)), false, "percent-encoded form scrubbed");
});
