/**
 * Failure-diagnostics envelope tests (issue #39). Three axes:
 *  (a) REDACTION — a secret / cookie / authorization header in a console|network|redirect|url dump is
 *      scrubbed before the envelope is surfaced;
 *  (b) ENVELOPE POPULATED per failure path — a blocked retrieve and a drive failure (EscalationError
 *      and a plain decorated error) both surface the same bundle through the MCP tool surface;
 *  (c) SUCCESS SHAPE UNCHANGED — a successful retrieve / drive snapshot carries no envelope + no
 *      `failure:` line (non-regression).
 * Pure functions run directly; the surfacing is exercised through a real MCP client over an in-memory
 * transport with injected fakes (no real browser), mirroring mcp-surface.test.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  buildFailureDiagnostics,
  redactFailureDiagnostics,
  summarizeFailureDiagnostics,
  attachFailure,
  failureOf,
  FAILURE_DIAGNOSTICS_CAP,
} from "../dist/observability/index.js";
import { createGatewayMcpServer } from "../dist/mcp/index.js";
import { GatewayDriveController } from "../dist/mcp/drive-controller.js";
import { EscalationError, isRetrieveFailure } from "../dist/verbs/index.js";
import { SecretStore } from "../dist/security/index.js";
import { isTopLevelNavStart } from "../dist/browser/patchright-core.js";

// --- (a) redaction ---------------------------------------------------------------------------

/** A minimal structural secret store: only the value set matters to redactSecrets. */
const storeOf = (...values) => ({ redactableValues: () => values });

test("redaction scrubs a registered secret out of console/network/redirect/url dumps", () => {
  const SECRET = "sup3r-secret-proxy-pw";
  const diag = buildFailureDiagnostics({
    finalUrl: `https://target.example/?tok=${SECRET}`,   // secret in a QUERY → stripped by URL-sanitize
    title: "blocked",
    status: 403,
    redirectChain: [`https://a.example/${SECRET}`, "https://b.example/"], // secret in the PATH → registered-secret pass
    consoleErrors: [`error: failed auth with ${SECRET}`],
    networkFailures: [`GET https://c.example/x net::ERR (${SECRET})`],
  });
  const red = redactFailureDiagnostics(diag, storeOf(SECRET));
  const blob = JSON.stringify(red);
  assert.ok(!blob.includes(SECRET), "the secret must not survive anywhere in the envelope");
  // The query-borne secret is stripped to the marker on a root path (it never reaches the secret pass).
  assert.equal(red.finalUrl, "https://target.example/?<redacted>");
  // The path-borne secret is collapsed to the depth marker (origin+depth only).
  assert.equal(red.redirectChain[0], "https://a.example/<redacted>");
  // Non-URL occurrences are still caught by the registered-secret pass.
  assert.match(red.consoleErrors[0], /\[REDACTED\]/);
  assert.match(red.networkFailures[0], /\[REDACTED\]/);
  // status + the non-secret ROOT hop pass through unchanged.
  assert.equal(red.status, 403);
  assert.equal(red.redirectChain[1], "https://b.example/");
});

test("redaction strips cookie/set-cookie/authorization header values even when NOT a registered secret", () => {
  const diag = buildFailureDiagnostics({
    networkFailures: [
      "GET https://x.example/ set-cookie: session=abc123def456; Path=/",
      "GET https://y.example/ authorization: Bearer eyJraw.token.value",
    ],
    consoleErrors: ["Cookie: sid=deadbeef was rejected"],
  });
  // Empty secret set — the header strip must fire on its own (these are always-sensitive).
  const red = redactFailureDiagnostics(diag, storeOf());
  assert.ok(!red.networkFailures[0].includes("abc123def456"), "set-cookie value must be stripped");
  assert.ok(!red.networkFailures[1].includes("eyJraw.token.value"), "authorization value must be stripped");
  assert.ok(!red.consoleErrors[0].includes("deadbeef"), "cookie value must be stripped");
  assert.match(red.networkFailures[0], /set-cookie:\s*\[REDACTED\]/i);
  assert.match(red.networkFailures[1], /authorization:\s*\[REDACTED\]/i);
});

test("adversarial redaction (EMPTY secret store): OAuth URLs, JSON cookies, folded auth are ALL scrubbed", () => {
  // No value here is a REGISTERED secret — the leak must be closed by URL-sanitization + header-strip,
  // not by the secret set. This is the Codex r1 HIGH finding (an unregistered access token leaked).
  const oauthUrl = "https://idp.example/callback?code=SECRETCODE123&access_token=AT-SECRET-XYZ&state=s#tok=FRAGSECRET";
  const diag = buildFailureDiagnostics({
    finalUrl: oauthUrl,
    title: "ok",
    status: 302,
    redirectChain: ["https://start.example/go?session=SESS-SECRET-1", oauthUrl],
    consoleErrors: [
      `refused to load ${oauthUrl}`,
      'config {"Cookie":"sid=COOKIESECRET; Path=/"}',
    ],
    networkFailures: [
      "GET https://api.example/v1?api_key=NETKEYSECRET net::ERR_FAILED",
      "req headers: Authorization: Bearer FOLDEDSECRET\n  continued-more-secret",
    ],
  });
  const red = redactFailureDiagnostics(diag, storeOf()); // EMPTY store — no registered secrets
  const blob = JSON.stringify(red);
  for (const leak of [
    "SECRETCODE123", "AT-SECRET-XYZ", "FRAGSECRET", "SESS-SECRET-1",
    "COOKIESECRET", "NETKEYSECRET", "FOLDEDSECRET", "continued-more-secret",
  ]) {
    assert.ok(!blob.includes(leak), `leak survived redaction: ${leak}`);
  }
  // finalUrl: origin + DEPTH only (path collapsed to a marker), query + fragment stripped to markers.
  assert.equal(red.finalUrl, "https://idp.example/<redacted>?<redacted>#<redacted>");
  assert.equal(red.redirectChain[0], "https://start.example/<redacted>?<redacted>");
  assert.equal(red.redirectChain[1], "https://idp.example/<redacted>?<redacted>#<redacted>");
  // an embedded URL inside a console/network line is sanitized too (origin kept, path+params gone).
  assert.ok(red.consoleErrors[0].includes("https://idp.example/<redacted>"));
  assert.ok(!red.consoleErrors[0].includes("callback") && !red.consoleErrors[0].includes("code="));
  assert.match(red.consoleErrors[1], /"Cookie":\[REDACTED\]/);
  assert.ok(red.networkFailures[0].includes("https://api.example/<redacted>?<redacted>"));
  assert.match(red.networkFailures[1], /Authorization:\s*\[REDACTED\]/i);
});

test("adversarial redaction r2 (EMPTY store): path tokens, basic-auth, escaped URLs, split/unindented headers", () => {
  const diag = buildFailureDiagnostics({
    // 1a. path segment token + 1b. basic-auth userinfo — both must be dropped (origin+depth only).
    finalUrl: "https://user:BASIC_PASS@idp.example/reset/PATH_TOKEN_XYZ?k=QP",
    status: 401,
    redirectChain: [
      "https://user:BASIC_PASS@idp.example/reset/PATH_TOKEN_XYZ",
      "https://svc.example/magic/MAGIC_LINK_TOK",
    ],
    consoleErrors: [
      // 2. backslash-escaped URL notation (JSON-escaped slashes) — its query must not leak.
      'blocked {"u":"https:\\/\\/idp.example\\/callback?code=ESCAPED_CODE_TOK"}',
      // 3. UNINDENTED header continuation — a token split across a raw newline; the tail must go too,
      //    and a real following field (Content-Type) must still STOP the redaction.
      "Authorization: Bearer FIRST_HALF_TOK\nSECOND_HALF_TOK\nContent-Type: text/html",
      // 4. same sensitive header repeated across two entries — each entry redacts independently.
      "log a -- Set-Cookie: sid=SPLIT_A_TOK",
    ],
    networkFailures: [
      "log b -- Set-Cookie: sid=SPLIT_B_TOK",
    ],
  });
  const red = redactFailureDiagnostics(diag, storeOf()); // EMPTY store — closed by URL/header scrubbers
  const blob = JSON.stringify(red);
  for (const leak of [
    "BASIC_PASS", "PATH_TOKEN_XYZ", "MAGIC_LINK_TOK", "ESCAPED_CODE_TOK",
    "FIRST_HALF_TOK", "SECOND_HALF_TOK", "SPLIT_A_TOK", "SPLIT_B_TOK",
  ]) {
    assert.ok(!blob.includes(leak), `leak survived r2 redaction: ${leak}`);
  }
  // origin + depth only; userinfo, path token, and query all gone.
  assert.equal(red.finalUrl, "https://idp.example/<redacted>?<redacted>");
  assert.equal(red.redirectChain[0], "https://idp.example/<redacted>");
  assert.equal(red.redirectChain[1], "https://svc.example/<redacted>");
  // the escaped URL's query is stripped (origin kept).
  assert.ok(red.consoleErrors[0].includes("https://idp.example/<redacted>"));
  // a real next header field still ends the Authorization redaction.
  assert.match(red.consoleErrors[1], /Authorization:\s*\[REDACTED\]/i);
  assert.ok(red.consoleErrors[1].includes("Content-Type: text/html"), "a following real field is NOT swallowed");
});

test("fail-closed URL sanitize r3 (EMPTY store): unusual port, basic-auth, data: URL, key=value continuation", () => {
  const diag = buildFailureDiagnostics({
    // out-of-range port → new URL() REJECTS → fail closed (must NOT leak the raw creds/token).
    finalUrl: "https://user:BASICPASS_TOK@idp.example:99999/reset/PATH_TOK?code=CODE_TOK",
    redirectChain: [
      "https://user:BASICPASS2_TOK@svc.example/magic/MAGIC_TOK", // basic-auth userinfo + path token
      "data:text/html,<DATA_TOK>",                              // non-http opaque body
    ],
    consoleErrors: [
      "loaded data:text/html,<DATACON_TOK> then failed",        // data: URL embedded in free text
      "Authorization: Bearer FIRST_TOK\naccess_token=SECOND_TOK\nContent-Type: text/html", // key=value tail
    ],
  });
  const red = redactFailureDiagnostics(diag, storeOf()); // EMPTY store
  const blob = JSON.stringify(red);
  for (const leak of [
    "BASICPASS_TOK", "PATH_TOK", "CODE_TOK", "BASICPASS2_TOK", "MAGIC_TOK",
    "DATA_TOK", "DATACON_TOK", "FIRST_TOK", "SECOND_TOK",
  ]) {
    assert.ok(!blob.includes(leak), `leak survived r3 redaction: ${leak}`);
  }
  assert.equal(red.finalUrl, "<unparseable-url>", "an out-of-range port fails closed");
  assert.equal(red.redirectChain[0], "https://svc.example/<redacted>", "userinfo dropped, path collapsed, host kept");
  assert.equal(red.redirectChain[1], "data:<redacted>", "non-http opaque body dropped");
  assert.ok(red.consoleErrors[0].includes("data:<redacted>"), "embedded data: URL collapsed");
  assert.match(red.consoleErrors[1], /Authorization:\s*\[REDACTED\]/i);
  assert.ok(red.consoleErrors[1].includes("Content-Type: text/html"), "a real next COLON field survives");
});

test("in-text URL match r4 (EMPTY store): a valid-URL tail after )/] can't leak past the delimiter", () => {
  const red = redactFailureDiagnostics(buildFailureDiagnostics({
    consoleErrors: [
      "load https://safe.example/reset/PREFIX)TAIL_RP_SECRET?code=Q_RP_SECRET failed", // ')' is legal in a URL
      "see [https://safe.example/p/BRACK]TAIL_SB_SECRET?code=Q_SB_SECRET]",             // ']' is legal in a URL
      'json {"u":"https://safe.example/q/QUOTED?code=Q_QT_SECRET"} done',               // quote IS a delimiter
    ],
    networkFailures: [
      "GET https://safe.example/dl/(GROUP)NET_SECRET?code=Q_NET_SECRET net::ERR_FAILED",
    ],
  }), storeOf()); // EMPTY store — closed by URL sanitization alone
  const blob = JSON.stringify(red);
  for (const leak of [
    "TAIL_RP_SECRET", "Q_RP_SECRET", "TAIL_SB_SECRET", "Q_SB_SECRET",
    "Q_QT_SECRET", "NET_SECRET", "Q_NET_SECRET",
  ]) {
    assert.ok(!blob.includes(leak), `a valid-URL tail leaked past the in-text delimiter: ${leak}`);
  }
  // origin preserved on each; no ?code= survives.
  for (const line of [...red.consoleErrors, ...red.networkFailures]) {
    assert.ok(!/\?code=/.test(line), `?code= survived in: ${line}`);
    assert.ok(line.includes("https://safe.example/"), `origin lost in: ${line}`);
  }
});

// --- isRetrieveFailure predicate (shared by retrieve() and the MCP surface) -------------------

test("isRetrieveFailure: blocked / empty / whitespace / failed-nav are failures; short-valid is not", () => {
  assert.equal(isRetrieveFailure({ blocked: true, markdown: "plenty of content here", status: 200 }), true);
  assert.equal(isRetrieveFailure({ blocked: false, markdown: "", status: 200 }), true, "empty extraction");
  assert.equal(isRetrieveFailure({ blocked: false, markdown: "   \n  ", status: 200 }), true, "whitespace-only");
  assert.equal(isRetrieveFailure({ blocked: false, markdown: "This site can't be reached", status: null }), true, "failed nav (null status + thin)");
  assert.equal(isRetrieveFailure({ blocked: false, markdown: "A short but legitimate page.", status: 200 }), false, "short-but-valid is NOT a failure");
});

// --- isTopLevelNavStart (the per-navigation evidence-reset decision) --------------------------

test("isTopLevelNavStart: resets only on a main-frame nav that is not a redirect hop", () => {
  assert.equal(isTopLevelNavStart(true, true, false), true, "fresh top-level nav → reset");
  assert.equal(isTopLevelNavStart(true, true, true), false, "a redirect hop CONTINUES the nav → keep the chain");
  assert.equal(isTopLevelNavStart(false, true, false), false, "a subresource never resets");
  assert.equal(isTopLevelNavStart(true, false, false), false, "a subframe nav never resets");
});

// --- envelope assembly + slot discipline -----------------------------------------------------

test("buildFailureDiagnostics copies evidence fields and leaves EVERY downstream slot unset", () => {
  const diag = buildFailureDiagnostics({
    finalUrl: "https://z.example/",
    title: "t",
    status: 200,
    redirectChain: ["https://z.example/"],
    consoleErrors: [],
    networkFailures: [],
  });
  assert.equal(diag.finalUrl, "https://z.example/");
  assert.equal(diag.title, "t");
  assert.equal(diag.status, 200);
  assert.deepEqual(diag.redirectChain, ["https://z.example/"]);
  // Empty lists are omitted (not surfaced as []), and screenshot is absent by default.
  assert.equal(diag.consoleErrors, undefined);
  assert.equal(diag.networkFailures, undefined);
  assert.equal(diag.screenshotRef, undefined);
  // Downstream slots (#40/#41/#42/#44/#48) must stay UNSET — this ticket only declares them.
  for (const slot of ["wafVendor", "failureClass", "timing", "captchaSolveReason", "solverEligible", "homeFallback"]) {
    assert.equal(diag[slot], undefined, `slot ${slot} must be left unset by this ticket`);
  }
});

test("redactFailureDiagnostics passes the #40 wafVendor slot through untouched (closed vocabulary, not free text)", () => {
  // The vendor label is attached at the redaction seam (retrieve.ts / drive #failure), not by
  // buildFailureDiagnostics — so assert the redactor preserves it verbatim. Safe precisely BECAUSE it is a
  // closed WafVendor vocabulary: it is deliberately not in the scrub list, so a token elsewhere is still
  // scrubbed while the vendor survives.
  const red = redactFailureDiagnostics(
    { finalUrl: "https://dd.example/?token=SECRET", wafVendor: "datadome" },
    { redactableValues: () => ["SECRET"] },
  );
  assert.equal(red.wafVendor, "datadome", "vendor label survives redaction unchanged");
  assert.ok(!/SECRET/.test(JSON.stringify(red)), "an actual secret is still scrubbed alongside it");
});

test("buildFailureDiagnostics bounds each list to the cap (keeping the most recent)", () => {
  const big = Array.from({ length: FAILURE_DIAGNOSTICS_CAP + 20 }, (_, i) => `line-${i}`);
  const diag = buildFailureDiagnostics({ consoleErrors: big, networkFailures: big, redirectChain: big });
  assert.equal(diag.consoleErrors.length, FAILURE_DIAGNOSTICS_CAP);
  assert.equal(diag.networkFailures.length, FAILURE_DIAGNOSTICS_CAP);
  assert.equal(diag.redirectChain.length, FAILURE_DIAGNOSTICS_CAP);
  assert.equal(diag.consoleErrors.at(-1), `line-${FAILURE_DIAGNOSTICS_CAP + 19}`, "keeps the most recent");
});

test("summarizeFailureDiagnostics shrinks a base64 screenshot to a size marker", () => {
  const withShot = { finalUrl: "https://z.example/", screenshotRef: "A".repeat(1000) };
  const summ = summarizeFailureDiagnostics(withShot);
  assert.match(summ.screenshotRef, /^<png 1000b base64>$/);
  // No screenshot ⇒ returned unchanged.
  const noShot = { finalUrl: "https://z.example/" };
  assert.equal(summarizeFailureDiagnostics(noShot), noShot);
});

test("attachFailure / failureOf round-trip on a plain error; non-enumerable so it doesn't widen JSON", () => {
  const env = { finalUrl: "https://z.example/", status: 500 };
  const err = attachFailure(new Error("boom"), env);
  assert.equal(failureOf(err), env);
  assert.ok(!Object.keys(err).includes("failure"), "the carrier must be non-enumerable");
  // A no-op when there is no envelope.
  assert.equal(failureOf(attachFailure(new Error("x"), undefined)), undefined);
  assert.equal(failureOf(new Error("plain")), undefined);
  assert.equal(failureOf("not an error"), undefined);
});

// --- (b)+(c) surfaced through the MCP tool surface -------------------------------------------

const outcome = (over = {}) => ({
  markdown: "# Title\n\nbody",
  title: "Title",
  status: 200,
  blocked: false,
  reason: null,
  degraded: false,
  proxyUsed: false,
  captchaSolved: false,
  ...over,
});

async function connect({ retrieve, drive } = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createGatewayMcpServer({ retrieve: retrieve ?? (async () => outcome()), ...(drive ? { drive } : {}) });
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

test("a blocked retrieve surfaces the failure envelope (finalUrl post-redirect + status)", async () => {
  const diagnostics = {
    finalUrl: "https://www.example.com/challenge",
    title: "Just a moment...",
    status: 403,
    redirectChain: ["https://example.com/", "https://www.example.com/challenge"],
    consoleErrors: ["error: challenge script failed"],
    networkFailures: ["GET https://cdn.example/ net::ERR_FAILED"],
  };
  const client = await connect({
    retrieve: async () => outcome({ blocked: true, markdown: "", reason: "cf-challenge", status: 403, diagnostics }),
  });
  const res = await client.callTool({ name: "retrieve", arguments: { url: "https://example.com/" } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /failure:/);
  assert.match(res.content[0].text, /www\.example\.com\/challenge/, "the POST-redirect finalUrl is surfaced");
  assert.match(res.content[0].text, /"status":403/);
  assert.match(res.content[0].text, /challenge script failed/);
});

test("an empty-content retrieve (status 200, blank markdown, NOT blocked) still surfaces the envelope", async () => {
  // Codex r1 coverage finding: population was gated on `blocked`, but the MCP layer fails empty markdown
  // independently — so a status-200 blank page got NO evidence. It must now carry the (redacted) envelope.
  const diagnostics = {
    finalUrl: "https://empty.example/article",
    title: "Empty",
    status: 200,
    redirectChain: ["https://empty.example/article"],
    consoleErrors: ["error: hydration failed"],
  };
  const client = await connect({
    retrieve: async () => outcome({ status: 200, markdown: "", degraded: true, blocked: false, reason: null, diagnostics }),
  });
  const res = await client.callTool({ name: "retrieve", arguments: { url: "https://empty.example/article" } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /reason=empty-content/);
  assert.match(res.content[0].text, /failure:/, "the empty-content failure carries an evidence envelope");
  assert.match(res.content[0].text, /empty\.example\/article/);
});

test("the MCP retrieve error surface sanitizes the interpolated request URL (r3, no raw creds/token echoed)", async () => {
  const raw = "https://user:PASS_LEAK@idp.example/reset/PATH_LEAK?code=CODE_LEAK";
  const client = await connect({
    retrieve: async () => outcome({ blocked: true, markdown: "", reason: "hard-block", status: 403 }),
  });
  const res = await client.callTool({ name: "retrieve", arguments: { url: raw } });
  assert.equal(res.isError, true);
  const text = res.content[0].text;
  for (const leak of ["PASS_LEAK", "PATH_LEAK", "CODE_LEAK"]) {
    assert.ok(!text.includes(leak), `the error surface echoed a raw ${leak}`);
  }
  assert.ok(text.includes("https://idp.example/"), "the origin is preserved for diagnostics");
});

test("the MCP retrieve CATCH surface sanitizes a raw URL in a thrown error message (r3)", async () => {
  const client = await connect({
    retrieve: async () => { throw new Error("unsupported URL scheme (https://user:CATCHPASS@x.example/p/CATCHTOK?c=CQ)"); },
  });
  const res = await client.callTool({ name: "retrieve", arguments: { url: "https://x.example/" } });
  assert.equal(res.isError, true);
  for (const leak of ["CATCHPASS", "CATCHTOK", "CQ"]) {
    assert.ok(!res.content[0].text.includes(leak), `the catch surface echoed a raw ${leak}`);
  }
});

test("the drive fail() surface sanitizes a raw URL in the error message (r3)", async () => {
  const drive = {
    async open() {},
    async navigate() { throw new Error("navigation failed for https://user:DRIVEPASS@site.example/deep/DRIVETOK?x=DQ"); },
    async snapshot() { return { url: "u", title: "t", tree: "x", status: 200 }; },
    async click() {}, async type() {}, async selectOption() {}, async pressKey() {},
    async waitFor() {}, async screenshot() { return "QUJD"; }, async close() {},
  };
  const client = await connect({ drive });
  const res = await client.callTool({ name: "browser_navigate", arguments: { url: "https://site.example/" } });
  assert.equal(res.isError, true);
  for (const leak of ["DRIVEPASS", "DRIVETOK", "DQ"]) {
    assert.ok(!res.content[0].text.includes(leak), `the drive fail() surface echoed a raw ${leak}`);
  }
  assert.ok(res.content[0].text.includes("https://site.example/"), "the origin is preserved");
});

test("the drive fail() surface handles a )-containing valid URL without leaking the tail (r4)", async () => {
  const drive = {
    async open() {},
    async navigate() { throw new Error("navigation failed for https://site.example/reset/(GRP)DRIVE_RP_TAIL?code=DRIVE_RP_Q"); },
    async snapshot() { return { url: "u", title: "t", tree: "x", status: 200 }; },
    async click() {}, async type() {}, async selectOption() {}, async pressKey() {},
    async waitFor() {}, async screenshot() { return "QUJD"; }, async close() {},
  };
  const client = await connect({ drive });
  const res = await client.callTool({ name: "browser_navigate", arguments: { url: "https://site.example/" } });
  assert.equal(res.isError, true);
  const text = res.content[0].text;
  for (const leak of ["DRIVE_RP_TAIL", "DRIVE_RP_Q"]) {
    assert.ok(!text.includes(leak), `a valid-URL tail leaked past the delimiter on the drive surface: ${leak}`);
  }
  assert.ok(!/\?code=/.test(text) && text.includes("https://site.example/"), "origin kept, query gone");
});

test("MCP drive force-proxy error structurally sanitizes a NON-CANONICAL URL spelling (r5, exact repro)", async () => {
  // The exact reachable repro: a valid HTTPS url with NO `//` (Zod .url() + new URL() accept it) whose
  // controller force-proxy error interpolated it raw — the after-the-fact regex net (requires `//`)
  // missed it. Now sanitized STRUCTURALLY at the source in GatewayDriveController.
  const open = new Map();
  let n = 1;
  const gateway = {
    sessions: { get: (h) => open.get(h) },
    async openConsumerSession() { const id = "h" + n++; open.set(id, { core: {} }); return id; },
    async useConsumerSession(_t, h, fn) { return fn(open.get(h)); },
    async closeConsumerSession(_t, h) { open.delete(h); },
  };
  const drive = new GatewayDriveController(gateway, new SecretStore(() => ({})), "tok"); // no proxy configured
  const client = await connect({ drive });
  const res = await client.callTool({
    name: "browser_navigate",
    arguments: { url: "https:example.com/reset/DRIVE_SECRET?code=QUERY_SECRET", forceProxy: true },
  });
  assert.equal(res.isError, true);
  const text = res.content[0].text;
  for (const leak of ["DRIVE_SECRET", "QUERY_SECRET"]) {
    assert.ok(!text.includes(leak), `the drive force-proxy surface leaked ${leak}`);
  }
  assert.ok(!/\?code=/.test(text), "the query is gone");
  assert.ok(text.includes("https://example.com"), "the origin is preserved (spelling normalized)");
});

test("MCP retrieve error surface handles a NON-CANONICAL URL spelling (r5, structural sanitizeUrlForError)", async () => {
  const client = await connect({
    retrieve: async () => outcome({ blocked: true, markdown: "", reason: "hard-block", status: 403 }),
  });
  const res = await client.callTool({
    name: "retrieve",
    arguments: { url: "https:example.com/reset/R5_SECRET?code=R5Q_SECRET" },
  });
  assert.equal(res.isError, true);
  const text = res.content[0].text;
  for (const leak of ["R5_SECRET", "R5Q_SECRET"]) {
    assert.ok(!text.includes(leak), `the retrieve surface leaked ${leak}`);
  }
  assert.ok(!/\?code=/.test(text) && text.includes("https://example.com"), "query gone, origin preserved");
});

test("a successful retrieve carries NO failure envelope (success shape unchanged)", async () => {
  const client = await connect({ retrieve: async ({ url }) => outcome({ markdown: `content for ${url}` }) });
  const res = await client.callTool({ name: "retrieve", arguments: { url: "https://example.com/" } });
  assert.equal(res.isError ?? false, false);
  assert.equal(res.content[0].text, "content for https://example.com/");
  assert.ok(!/failure:/.test(res.content[0].text));
});

/** A fake drive whose navigate throws per-URL: an EscalationError with a `.failure`, or a plain error
 *  decorated by attachFailure, or a clean snapshot for the success case. */
function makeFailingDrive() {
  const snap = (over = {}) => ({ url: "https://ok.example/", title: "OK", tree: '- link "x" [ref=e2]', ...over });
  const envelope = {
    finalUrl: "https://blocked.example/final",
    title: "Access Denied",
    status: 403,
    redirectChain: ["https://blocked.example/", "https://blocked.example/final"],
    consoleErrors: ["error: waf blocked"],
    networkFailures: ["GET https://blocked.example/x net::ERR_ACCESS_DENIED"],
  };
  const dx = { proxyConfigured: true, proxyApplied: true, forced: false, attempts: 3, lastStatus: 403, reason: "hard-block" };
  return {
    envelope,
    drive: {
      async open() {},
      async navigate(url) {
        if (url === "https://escalation-fail/") throw new EscalationError("could not land a working proxied exit", dx, envelope);
        if (url === "https://plain-fail/") throw attachFailure(new Error("the action landed on a blocked/challenge page"), envelope);
        return snap({ url, status: 200 }); // success: carries status but no diagnostics
      },
      async snapshot() { return snap({ status: 200 }); },
      async click() { return snap(); },
      async type() { return snap(); },
      async selectOption() { return snap(); },
      async pressKey() { return snap(); },
      async waitFor() { return snap(); },
      async screenshot() { return "QUJD"; },
      async close() {},
    },
  };
}

test("a drive EscalationError surfaces BOTH the escalation tally and the failure envelope", async () => {
  const { drive } = makeFailingDrive();
  const client = await connect({ drive });
  const res = await client.callTool({ name: "browser_navigate", arguments: { url: "https://escalation-fail/" } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /diagnostics:/, "the proxy-escalation tally is still rendered");
  assert.match(res.content[0].text, /failure:/, "the new page-evidence envelope is rendered at parity");
  assert.match(res.content[0].text, /blocked\.example\/final/);
  assert.match(res.content[0].text, /waf blocked/);
});

test("a plain drive error decorated with a failure envelope also surfaces it (retrieve↔drive parity)", async () => {
  const { drive } = makeFailingDrive();
  const client = await connect({ drive });
  const res = await client.callTool({ name: "browser_navigate", arguments: { url: "https://plain-fail/" } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /failure:/);
  assert.match(res.content[0].text, /blocked\.example\/final/);
  // A plain (non-Escalation) error has no proxy tally.
  assert.ok(!/diagnostics:/.test(res.content[0].text));
});

test("a successful drive navigate carries no failure line but DOES surface status (formatSnapshot)", async () => {
  const { drive } = makeFailingDrive();
  const client = await connect({ drive });
  const res = await client.callTool({ name: "browser_navigate", arguments: { url: "https://ok.example/" } });
  assert.equal(res.isError ?? false, false);
  assert.ok(!/failure:/.test(res.content[0].text));
  assert.match(res.content[0].text, /status: 200/, "captured status is surfaced, no longer dropped");
});
