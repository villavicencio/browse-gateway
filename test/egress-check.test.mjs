/**
 * U4 (issue #21) — opt-in egress verification. classifyExitOrg/parseExitOrg are the pure core; the
 * drive controller's probe (off unless BGW_DIAG_VERIFY_EGRESS=1) fetches an ip-info endpoint through
 * the proxy and classifies the exit as residential vs datacenter, attaching it to the diagnostics.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyExitOrg, parseExitOrg, EscalationError } from "../dist/verbs/index.js";
import { SecretStore } from "../dist/security/index.js";
import { GatewayDriveController } from "../dist/mcp/drive-controller.js";

const REAL = "real accessibility tree ".repeat(60);
const THIN_403 = { status: 403, tree: "Forbidden" };

// --- classifyExitOrg --------------------------------------------------------------------------

test("classifyExitOrg: known datacenter/hosting orgs → datacenter", () => {
  for (const org of [
    "AS24940 Hetzner Online GmbH",
    "AS16509 Amazon.com, Inc.",
    "AS15169 Google LLC",
    "AS16276 OVH SAS",
    "AS14061 DigitalOcean, LLC",
    "AS20473 The Constant Company (Vultr)",
  ]) {
    assert.equal(classifyExitOrg(org), "datacenter", org);
  }
});

test("classifyExitOrg: a residential ISP org → residential", () => {
  assert.equal(classifyExitOrg("AS7922 Comcast Cable Communications, LLC"), "residential");
  assert.equal(classifyExitOrg("AS701 Verizon Business"), "residential");
});

test("classifyExitOrg: absent/empty org → unknown", () => {
  assert.equal(classifyExitOrg(undefined), "unknown");
  assert.equal(classifyExitOrg(""), "unknown");
  assert.equal(classifyExitOrg("   "), "unknown");
});

// --- parseExitOrg -----------------------------------------------------------------------------

test("parseExitOrg: extracts org from an ip-info JSON body (raw or HTML-wrapped); undefined when absent", () => {
  assert.equal(parseExitOrg('{"ip":"1.2.3.4","org":"AS24940 Hetzner Online GmbH","city":"x"}'), "AS24940 Hetzner Online GmbH");
  assert.equal(parseExitOrg('<pre>{\n  "org": "AS7922 Comcast Cable"\n}</pre>'), "AS7922 Comcast Cable");
  assert.equal(parseExitOrg('{"ip":"1.2.3.4"}'), undefined);
  assert.equal(parseExitOrg("not json at all"), undefined);
});

// --- drive probe integration ------------------------------------------------------------------

function makeProxyGateway(sessionNavLists, exitOrgJson) {
  let si = -1;
  let nextId = 1;
  const open = new Map();
  const opened = [];
  const gateway = {
    sessions: { get: (h) => open.get(h) },
    async openConsumerSession(_token, overrides, opts) {
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
          async render() {
            // The opt-in egress probe renders an ip-info endpoint; return the programmed JSON body.
            return { url: "u", status: 200, title: "", text: exitOrgJson, html: exitOrgJson, clearanceWaitedMs: 0 };
          },
        },
      });
      opened.push({ id, overrides, opts });
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

test("drive: with verifyEgress on, an exhausted escalation attaches a classified exitCheck", async () => {
  const { gateway, opened } = makeProxyGateway([[THIN_403], [THIN_403]], '{"ip":"5.78.127.182","org":"AS24940 Hetzner Online GmbH"}');
  const drive = new GatewayDriveController(gateway, new SecretStore(() => ({ BGW_PROXY_URL: "http://p:8080", BGW_PROXY_PASSWORD: "pw" })), "tok", {
    onDatacenterIp: true,
    verifyEgress: true,
  });
  await assert.rejects(drive.navigate("https://hostile.example/"), (err) => {
    assert.ok(err instanceof EscalationError);
    assert.equal(err.diagnostics.exitCheck?.kind, "datacenter", "Hetzner exit classified as datacenter");
    assert.match(err.diagnostics.exitCheck?.org ?? "", /Hetzner/);
    return true;
  });
  // The probe opened a CONSTRAINED diagnostics session (guarded to the ip-info host only), not a
  // normal consumer-allowlist session — so a restrictive allowlist can't block egress verification.
  assert.ok(opened.some((o) => o.opts?.diagnosticsHost === "ipinfo.io"), "probe used the diagnostics-host path");
});

test("drive: with verifyEgress OFF (default), no exitCheck is attached (no extra proxied probe)", async () => {
  const { gateway } = makeProxyGateway([[THIN_403], [THIN_403]], '{"org":"AS24940 Hetzner Online GmbH"}');
  const drive = new GatewayDriveController(gateway, new SecretStore(() => ({ BGW_PROXY_URL: "http://p:8080", BGW_PROXY_PASSWORD: "pw" })), "tok", {
    onDatacenterIp: true,
  });
  await assert.rejects(drive.navigate("https://hostile.example/"), (err) => {
    assert.ok(err instanceof EscalationError);
    assert.equal(err.diagnostics.exitCheck, undefined, "no egress probe when the flag is off");
    return true;
  });
});
