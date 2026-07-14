/**
 * U3 (issue #21) — structured proxy-escalation diagnostics. Replaces the opaque
 * "could not land a working proxied exit ... last status=403" with an EscalationDiagnostics object
 * surfaced to the MCP caller (drive: EscalationError.diagnostics; retrieve: result.proxyDiagnostic).
 * Secrets must never appear in the diagnostics surface (R5).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  escalationDiagnostics,
  EscalationError,
  retrieve,
  PROXY_OPEN_ATTEMPTS,
} from "../dist/verbs/index.js";
import { SecretStore, redactSecrets } from "../dist/security/index.js";
import { GatewayDriveController } from "../dist/mcp/drive-controller.js";

const THIN_403 = { status: 403, tree: "Forbidden" }; // hard block: 4xx + thin body
const REAL = "real accessibility tree ".repeat(60); // > MIN_CONTENT_LENGTH, not blocked

// --- escalationDiagnostics builder -----------------------------------------------------------

test("escalationDiagnostics: classifies the last signal and passes the tally through", () => {
  const d = escalationDiagnostics({
    proxyConfigured: true,
    proxyApplied: true,
    forced: false,
    attempts: 3,
    last: { title: "", text: "Forbidden", status: 403 },
  });
  assert.deepEqual(d, { proxyConfigured: true, proxyApplied: true, forced: false, attempts: 3, lastStatus: 403, reason: "hard-block" });
});

test("escalationDiagnostics: null last → reason null, lastStatus null", () => {
  const d = escalationDiagnostics({ proxyConfigured: false, proxyApplied: false, forced: false, attempts: 0, last: null });
  assert.equal(d.reason, null);
  assert.equal(d.lastStatus, null);
});

test("EscalationError: is an Error and carries the diagnostics object", () => {
  const dx = escalationDiagnostics({ proxyConfigured: true, proxyApplied: true, forced: false, attempts: 2, last: { title: "", text: "x", status: 403 } });
  const err = new EscalationError("boom", dx);
  assert.ok(err instanceof Error);
  assert.equal(err.name, "EscalationError");
  assert.equal(err.diagnostics.attempts, 2);
});

// --- drive path: a fake gateway that programs per-session navigation results -----------------

/** sessionNavLists[N] = the nav results the Nth opened session returns (session 0 = direct). */
function makeProxyGateway(sessionNavLists) {
  let si = -1;
  let nextId = 1;
  const open = new Map();
  const opened = [];
  const gateway = {
    sessions: { get: (h) => open.get(h) },
    async openConsumerSession(_token, overrides) {
      si += 1;
      const navs = sessionNavLists[Math.min(si, sessionNavLists.length - 1)] ?? [{}];
      let ni = 0;
      const id = "h" + nextId++;
      open.set(id, {
        core: {
          async navigate(url) {
            const out = navs[Math.min(ni, navs.length - 1)] ?? {};
            ni += 1;
            return { url, title: "t", tree: out.tree ?? REAL, status: out.status ?? 200, cfHint: out.cfHint, pxHint: out.pxHint };
          },
          async snapshot() {
            return { url: "u", title: "t", tree: REAL, status: 200 };
          },
        },
      });
      opened.push({ id, overrides });
      return id;
    },
    async useConsumerSession(_token, handle, fn) {
      const s = open.get(handle);
      if (!s) throw new Error("session not found");
      return fn(s);
    },
    async closeConsumerSession(_token, handle) {
      open.delete(handle);
    },
  };
  return { gateway, opened };
}

test("drive: exhausted proxied exits throw EscalationError with structured diagnostics", async () => {
  // Direct blocks (hard 403), then every proxied exit also blocks → exhaustion.
  const { gateway, opened } = makeProxyGateway([[THIN_403], [THIN_403]]);
  const secrets = new SecretStore(() => ({ BGW_PROXY_URL: "http://proxy:8080", BGW_PROXY_PASSWORD: "pwd" }));
  const drive = new GatewayDriveController(gateway, secrets, "tok", { onDatacenterIp: true });

  await assert.rejects(
    drive.navigate("https://hostile.example/p/1"),
    (err) => {
      assert.ok(err instanceof EscalationError, "throws EscalationError");
      assert.equal(err.diagnostics.proxyConfigured, true);
      assert.equal(err.diagnostics.proxyApplied, true);
      assert.equal(err.diagnostics.forced, false);
      assert.equal(err.diagnostics.attempts, PROXY_OPEN_ATTEMPTS);
      assert.equal(err.diagnostics.lastStatus, 403);
      assert.equal(err.diagnostics.reason, "hard-block");
      return true;
    },
  );
  // 1 direct + PROXY_OPEN_ATTEMPTS proxied sessions were opened.
  assert.equal(opened.length, 1 + PROXY_OPEN_ATTEMPTS);
});

test("drive: a direct block with no proxy configured reports proxyApplied=false, proxyConfigured=false", async () => {
  const { gateway } = makeProxyGateway([[THIN_403]]);
  const secrets = new SecretStore(() => ({})); // no proxy secrets
  const drive = new GatewayDriveController(gateway, secrets, "tok", { onDatacenterIp: true });

  await assert.rejects(drive.navigate("https://hostile.example/p/1"), (err) => {
    assert.ok(err instanceof EscalationError);
    assert.equal(err.diagnostics.proxyConfigured, false);
    assert.equal(err.diagnostics.proxyApplied, false);
    assert.equal(err.diagnostics.attempts, 0);
    assert.equal(err.diagnostics.reason, "hard-block");
    return true;
  });
});

// --- retrieve path: proxyDiagnostic on the result -------------------------------------------

const cfBlockRender = {
  url: "u",
  status: 403,
  title: "Just a moment...",
  text: "Enable JavaScript and cookies to continue",
  html: "<div id='challenge-platform' class='cf-chl-opt'></div>",
  clearanceWaitedMs: 0,
};

function makeRenderGateway(result) {
  return {
    async withConsumerSession(_token, fn) {
      return fn({ core: { async render() { return result; }, async setNavigationGuard() {}, async close() {} } }, { id: "agent-1" });
    },
  };
}

test("retrieve: a CF block that never clears populates proxyDiagnostic with attempts + reason", async () => {
  const gateway = makeRenderGateway(cfBlockRender);
  const secrets = new SecretStore(() => ({ BGW_PROXY_URL: "http://proxy:8080", BGW_PROXY_PASSWORD: "pwd" }));
  const r = await retrieve(gateway, secrets, { token: "t", url: "https://hard.example/", escalation: { onDatacenterIp: true } });
  assert.equal(r.blocked, true);
  assert.equal(r.proxyUsed, true);
  assert.ok(r.proxyDiagnostic, "proxyDiagnostic present when escalation ran");
  assert.equal(r.proxyDiagnostic.proxyApplied, true);
  assert.equal(r.proxyDiagnostic.attempts, PROXY_OPEN_ATTEMPTS);
  assert.equal(r.proxyDiagnostic.reason, "cf-challenge");
});

test("retrieve: no escalation → no proxyDiagnostic", async () => {
  const gateway = makeRenderGateway({ url: "u", status: 200, title: "OK", text: REAL, html: `<main>${REAL}</main>`, clearanceWaitedMs: 0 });
  const r = await retrieve(gateway, new SecretStore(() => ({})), { token: "t", url: "https://soft/" });
  assert.equal(r.proxyDiagnostic, undefined);
});

// --- R5: the diagnostics surface never carries secret material ------------------------------

test("diagnostics are secrets-free: serialized + redacted contains no proxy credential", () => {
  const secrets = new SecretStore(() => ({ BGW_PROXY_URL: "http://user:s3cr3t-pass@proxy:8080", BGW_PROXY_PASSWORD: "s3cr3t-pass" }));
  const dx = escalationDiagnostics({
    proxyConfigured: true,
    proxyApplied: true,
    forced: false,
    attempts: 3,
    last: { title: "", text: "Forbidden", status: 403 },
  });
  const serialized = JSON.stringify(dx);
  assert.ok(!serialized.includes("s3cr3t-pass"), "no credential in the diagnostics object");
  // Belt-and-suspenders: even after redaction nothing changes (there was nothing to redact).
  assert.equal(redactSecrets(serialized, secrets), serialized);
});
