/**
 * U4 drive proxy-posture tests — the proxyOverrideFor/navFailed helpers, plus the controller's
 * escalate-on-block first navigate (direct first; escalate to a proxied exit only when direct is
 * blocked), the fresh-exit retry + pinning, secret-rotation safety, and mid-flow failure recovery.
 * Exercised with a fake gateway (no real browser); the live path is proven by scripts/validate-drive.mjs (U5).
 *
 * In the fake gateway, session index 0 is the DIRECT attempt (override undefined) and sessions 1+ are
 * proxied — so a test triggers escalation by making session 0 block.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { proxyOverrideFor, proxyOverrideForPinned, navFailed, shouldEscalateDrive, newStickyExitId } from "../dist/verbs/index.js";
import { GatewayDriveController } from "../dist/mcp/drive-controller.js";
import { SecretStore } from "../dist/security/index.js";

const withProxy = () => new SecretStore(() => ({ BGW_PROXY_URL: "http://p:1" }));
const noSecrets = () => new SecretStore(() => ({}));
const REAL = "x".repeat(500); // a "real content" accessibility tree (above the thin-page threshold)

test("proxyOverrideFor: {proxy} only with a proxy configured AND on a datacenter IP", () => {
  assert.ok(proxyOverrideFor(withProxy(), true)?.proxy, "proxy + DC -> override");
  assert.equal(proxyOverrideFor(withProxy(), false), undefined, "not on a DC IP -> no override");
  assert.equal(proxyOverrideFor(noSecrets(), true), undefined, "no proxy -> no override");
});

test("proxyOverrideFor: with a sticky suffix, EACH CALL mints a fresh held exit", () => {
  const secrets = new SecretStore(() => ({ BGW_PROXY_URL: "http://p:1", BGW_PROXY_PASSWORD: "pwd" }));
  const a = proxyOverrideFor(secrets, true, "_s-{id}");
  const b = proxyOverrideFor(secrets, true, "_s-{id}");
  assert.match(a?.proxy?.password, /^pwd_s-[0-9a-f]+$/);
  assert.notEqual(a?.proxy?.password, b?.proxy?.password, "fresh sticky session per resolve");
  // No suffix → base password untouched (prior rotating behavior).
  assert.equal(proxyOverrideFor(secrets, true)?.proxy?.password, "pwd");
});

test("proxyOverrideFor: a PINNED stickyExitId re-pins the SAME held exit across calls (vault warm replay, R3)", () => {
  const secrets = new SecretStore(() => ({ BGW_PROXY_URL: "http://p:1", BGW_PROXY_PASSWORD: "pwd" }));
  const a = proxyOverrideFor(secrets, true, "_s-{id}", "abcd1234");
  const b = proxyOverrideFor(secrets, true, "_s-{id}", "abcd1234");
  assert.equal(a?.proxy?.password, "pwd_s-abcd1234");
  assert.equal(a?.proxy?.password, b?.proxy?.password, "same id → same exit, every replay");
  // A pinned id differs from a fresh mint, and 3-arg callers are unchanged (fresh per call).
  assert.notEqual(proxyOverrideFor(secrets, true, "_s-{id}")?.proxy?.password, "pwd_s-abcd1234");
});

test("proxyOverrideForPinned: returns the override ONLY when the exit is VERIFIABLY pinned (R3 fail-closed)", () => {
  const full = new SecretStore(() => ({ BGW_PROXY_URL: "http://p:1", BGW_PROXY_PASSWORD: "pwd" }));
  // Truly pinned: proxy + datacenter + a sticky suffix that applies the id.
  assert.equal(proxyOverrideForPinned(full, true, "_s-{id}", "abcd1234")?.proxy?.password, "pwd_s-abcd1234");
  // NOT pinnable → undefined so the caller fails closed (never a wrong/rotating-exit replay):
  assert.equal(proxyOverrideForPinned(full, true, undefined, "abcd1234"), undefined, "no sticky suffix → base (rotating) proxy → undefined");
  assert.equal(proxyOverrideForPinned(full, true, "_s-static", "abcd1234"), undefined, "suffix without {id} → id not applied → undefined");
  assert.equal(proxyOverrideForPinned(full, false, "_s-{id}", "abcd1234"), undefined, "not on a datacenter IP → undefined");
  assert.equal(proxyOverrideForPinned(noSecrets(), true, "_s-{id}", "abcd1234"), undefined, "no proxy → undefined");
  const noPw = new SecretStore(() => ({ BGW_PROXY_URL: "http://p:1" })); // no password to suffix
  assert.equal(proxyOverrideForPinned(noPw, true, "_s-{id}", "abcd1234"), undefined, "no proxy password → can't apply the id → undefined");
  // Collision-resistance (structural, not substring): a base password that ALREADY contains the exit id
  // must NOT be mistaken for a real pin when the suffix can't actually apply it.
  const collide = new SecretStore(() => ({ BGW_PROXY_URL: "http://p:1", BGW_PROXY_PASSWORD: "pre-abcd1234-x" }));
  assert.equal(proxyOverrideForPinned(collide, true, undefined, "abcd1234"), undefined, "no suffix → unpinned even though base pw contains the id");
  assert.equal(proxyOverrideForPinned(collide, true, "_s-static", "abcd1234"), undefined, "suffix without {id} → unpinned even though base pw contains the id");
  // A REAL pin on top of a colliding base still works (minted pw == base + suffix-with-id, exactly).
  assert.equal(proxyOverrideForPinned(collide, true, "_s-{id}", "abcd1234")?.proxy?.password, "pre-abcd1234-x_s-abcd1234");
});

test("newStickyExitId: an 8-hex id (the IPRoyal quantum), distinct across calls", () => {
  assert.match(newStickyExitId(), /^[0-9a-f]{8}$/);
  assert.notEqual(newStickyExitId(), newStickyExitId());
});

test("navFailed: fails on null status, a 4xx+thin page, or a visible interstitial; a real cleared page does not", () => {
  assert.equal(navFailed({ url: "u", title: "t", tree: "", status: null }), true);
  assert.equal(navFailed({ url: "u", title: "t", tree: "Forbidden", status: 403 }), true);
  // CF interstitial: 200 + non-thin content, but a visible block phrase -> still failed, so a
  // proxied first navigate rotates past the blocked exit instead of pinning it.
  assert.equal(navFailed({ url: "u", title: "Just a moment...", tree: REAL, status: 200 }), true);
  // A dead navigation (reset socket / unreachable) lands on chrome-error:// and can inherit the
  // PRIOR page's status via the response listener — the url must still mark it failed.
  assert.equal(navFailed({ url: "chrome-error://chromewebdata/", title: "", tree: "", status: 200 }), true);
  assert.equal(navFailed({ url: "u", title: "t", tree: REAL, status: 200 }), false);
  assert.equal(navFailed({ url: "u", title: "t", tree: REAL, status: 403 }), false);
  // #66: a core-marked DEADLINE-TRUNCATED nav is failed even though every other arm reads healthy — the
  // headers-before-DCL partial-200 the truncated goto pinned must not be pinned as a success. navFailed
  // TRUSTS the core's flag (the core only sets it on a thin, unblocked page — asserted with a fat tree
  // here precisely to show the flag, not the content, decides).
  assert.equal(navFailed({ url: "u", title: "t", tree: REAL, status: 200, deadlineTruncated: true }), true);
  assert.equal(navFailed({ url: "u", title: "t", tree: "", status: 200, deadlineTruncated: true }), true);
});

test("shouldEscalateDrive: escalates on a CF challenge (visible OR vendor-hint) or a hard block; NOT a generic block or dead nav", () => {
  // CF challenge (visible phrase) -> escalate
  assert.equal(shouldEscalateDrive({ url: "u", title: "Just a moment...", tree: REAL, status: 200 }), true);
  // CF detected ONLY by the HTML vendor hint (cfHint), no CF visible phrase -> escalate, matching
  // retrieve, which sees challenge-platform in the HTML. ("Enable JavaScript and cookies" is a generic
  // BLOCK phrase, NOT a CF_BLOCK_PHRASE, so the visible check alone would miss it.)
  assert.equal(
    shouldEscalateDrive({ url: "u", title: "", tree: "Enable JavaScript and cookies to continue " + REAL, cfHint: true, status: 200 }),
    true,
  );
  // ...the SAME page without the CF hint -> generic block, NOT escalated
  assert.equal(
    shouldEscalateDrive({ url: "u", title: "", tree: "Enable JavaScript and cookies to continue " + REAL, status: 200 }),
    false,
  );
  // hard reputation block (4xx + thin) -> escalate
  assert.equal(shouldEscalateDrive({ url: "u", title: "t", tree: "Forbidden", status: 403 }), true);
  // generic NON-CF visible block on a non-thin 200 (e.g. "Access denied") -> NOT escalated (matches
  // retrieve's scope; surfaced via navFailed, but no residential proxy spent)
  assert.equal(shouldEscalateDrive({ url: "u", title: "Access denied", tree: REAL, status: 200 }), false);
  // dead navigation (chrome-error, stale status) -> NOT escalated; a fresh exit won't fix it
  assert.equal(shouldEscalateDrive({ url: "chrome-error://chromewebdata/", title: "", tree: "", status: 200 }), false);
  // healthy page -> no escalation
  assert.equal(shouldEscalateDrive({ url: "u", title: "t", tree: REAL, status: 200 }), false);
});

/** Fake gateway: opened session N navigates through sessionNavLists[N] (each nav consumes the next). */
function makeProxyGateway(sessionNavLists) {
  let si = -1;
  let nextId = 1;
  const open = new Map();
  const opened = [];
  const gateway = {
    sessions: { get: (h) => open.get(h) },
    async openConsumerSession(token, overrides) {
      si++;
      const navs = sessionNavLists[Math.min(si, sessionNavLists.length - 1)] ?? [{}];
      let ni = 0;
      const id = "h" + nextId++;
      open.set(id, {
        core: {
          async navigate(url) {
            const out = navs[Math.min(ni, navs.length - 1)] ?? {};
            ni++;
            const status = out.status === undefined ? 200 : out.status; // preserve an explicit null (a dead exit)
            return {
              url,
              title: "t",
              tree: out.tree === undefined ? REAL : out.tree,
              status,
              cfHint: out.cfHint, // a scrubbed CF vendor-hint flag, undefined unless the spec sets it
              // #67/#66: the main-frame response RECEIPT and the deadline-truncation flag, passed through
              // only when the spec sets them (an omitting spec models a receipt-less fixture → status fallback).
              ...(out.responseReceived !== undefined ? { responseReceived: out.responseReceived } : {}),
              ...(out.deadlineTruncated ? { deadlineTruncated: true } : {}),
              // A minimal #39 envelope so the seam-level failureClass is assertable on thrown failures.
              diagnostics: { finalUrl: url, title: "t", status },
            };
          },
          async snapshot() { return { url: "u", title: "t", tree: REAL, status: 200 }; },
        },
      });
      opened.push({ id, overrides });
      return id;
    },
    async useConsumerSession(token, handle, fn) {
      const s = open.get(handle);
      if (!s) throw new Error(`no open session for handle ${handle}`);
      return fn(s);
    },
    async closeConsumerSession(token, handle) { open.delete(handle); },
  };
  return { gateway, open, opened };
}

test("controller: direct blocked -> escalates to a proxied exit, retrying fresh exits until healthy, then pins", async () => {
  const { gateway, open, opened } = makeProxyGateway([
    [{ status: 403, tree: "Forbidden" }], // session 0: DIRECT attempt — hard-blocked
    [{ status: null, tree: "" }], //          session 1: proxied attempt 1 — dead exit
    [{ status: 200, tree: REAL }], //         session 2: proxied attempt 2 — healthy
  ]);
  const c = new GatewayDriveController(gateway, withProxy(), "tok", { onDatacenterIp: true });
  const snap = await c.navigate("https://example.com/");
  assert.equal(snap.status, 200, "landed a healthy proxied exit after direct was blocked");
  assert.equal(opened.length, 3, "one direct attempt + two proxied attempts");
  assert.equal(opened[0].overrides, undefined, "first attempt was DIRECT (no proxy spent)");
  assert.ok(opened[1].overrides?.proxy, "escalated to the proxy after the direct block");
  assert.ok(opened[2].overrides?.proxy, "retried a fresh proxied exit");
  assert.equal(open.size, 1, "only the healthy session remains open");
  await c.navigate("https://example.com/next"); // pinned -> no re-roll
  assert.equal(opened.length, 3, "no re-open after pinning");
});

test("controller: a CF page detected only by a vendor hint (no visible CF phrase) escalates, matching retrieve", async () => {
  const { gateway, opened } = makeProxyGateway([
    [{ status: 200, tree: "Enable JavaScript and cookies to continue", cfHint: true }], // s0 direct: CF via hint only
    [{ status: 200, tree: REAL }], //                                                      s1 proxied: healthy
  ]);
  const c = new GatewayDriveController(gateway, withProxy(), "tok", { onDatacenterIp: true });
  const snap = await c.navigate("https://example.com/");
  assert.equal(snap.status, 200);
  assert.equal(opened.length, 2, "escalated to a proxied exit on the CF vendor-hint signal");
  assert.equal(opened[0].overrides, undefined, "direct attempt first");
  assert.ok(opened[1].overrides?.proxy, "escalated to the proxy");
});

test("controller: direct that clears (no block) pins direct and never opens the proxy", async () => {
  const { gateway, opened } = makeProxyGateway([[{ status: 200, tree: REAL }]]); // direct succeeds
  const c = new GatewayDriveController(gateway, withProxy(), "tok", { onDatacenterIp: true });
  const snap = await c.navigate("https://example.com/");
  assert.equal(snap.status, 200);
  assert.equal(opened.length, 1, "only the direct session was opened");
  assert.equal(opened[0].overrides, undefined, "no proxy spent — direct cleared on its own");
});

test("controller: escalation throws when no proxied exit lands within the attempt budget", async () => {
  const { gateway, opened } = makeProxyGateway([
    [{ status: 403, tree: "Forbidden" }], // direct: blocked
    [{ status: null, tree: "" }], //          proxied attempts: all dead (repeats for si>=1)
  ]);
  const c = new GatewayDriveController(gateway, withProxy(), "tok", { onDatacenterIp: true });
  // #45: every proxied exit died reaching the site (all dead-nav) → a BURNED-EXIT verdict (our pool died),
  // distinct from the site blocking a live exit. Evidence on the diagnostics + a seam-level FailureClass.
  await assert.rejects(c.navigate("https://example.com/"), (err) => {
    assert.equal(err.name, "EscalationError");
    assert.match(err.message, /burned exit/i, "all-dead exhaustion reads as a burned exit, not a generic exhaustion");
    assert.equal(err.diagnostics.burnedExit, true);
    return true;
  });
  assert.equal(opened.length, 4, "one direct attempt + the full 3-attempt proxied budget");
});

test("controller: a deadline-truncated direct nav surfaces a timeout and is NOT escalated (#66)", async () => {
  const { failureOf } = await import("../dist/observability/index.js");
  // The #66 bug shape: a budget/nav-timeout-cut goto whose headers arrived first — status 200, thin
  // page, no block signal. Pre-#66 this PINNED as a success; now the core's deadlineTruncated flag
  // fails it as a timeout. No CF signal → not escalated (a fresh exit doesn't fix a slow nav).
  const { gateway, opened } = makeProxyGateway([[{ status: 200, tree: "", deadlineTruncated: true }]]);
  const c = new GatewayDriveController(gateway, withProxy(), "tok", { onDatacenterIp: true });
  let caught;
  try { await c.navigate("https://example.com/"); } catch (e) { caught = e; }
  assert.ok(caught, "a truncated direct nav must throw, not pin the partial page");
  assert.match(caught.message, /navigation timed out .*truncated by its timeout/i);
  assert.equal(opened.length, 1, "not escalated — only the direct session was opened");
  assert.equal(failureOf(caught)?.failureClass, "timeout", "the seam classifies a truncated nav as timeout");
});

test("controller: truncated proxied attempts are LIVE responses, not a burned exit (#66 receipt precision)", async () => {
  const { failureOf } = await import("../dist/observability/index.js");
  // Direct is hard-blocked, then every proxied attempt is deadline-truncated WITH the response receipt
  // (headers arrived — the exit responded, then the nav was cut). Exhaustion must read as "could not land
  // a working exit" (site/timeout story), NEVER the burned-exit (all-exits-dead) verdict — the receipt is
  // exactly what tells a responded-but-slow exit from a dead one (#67 wired into drive by #66).
  const { gateway, opened } = makeProxyGateway([
    [{ status: 403, tree: "Forbidden" }], // direct: hard-blocked → escalate
    [{ status: 200, tree: "", deadlineTruncated: true, responseReceived: true }], // proxied: all truncated-but-live
  ]);
  const c = new GatewayDriveController(gateway, withProxy(), "tok", { onDatacenterIp: true });
  let caught;
  try { await c.navigate("https://example.com/"); } catch (e) { caught = e; }
  assert.ok(caught, "exhausted escalation must throw");
  assert.equal(caught.name, "EscalationError");
  assert.doesNotMatch(caught.message, /burned exit/i, "a responded-but-truncated exit is not a burned exit");
  assert.notEqual(caught.diagnostics.burnedExit, true, "no all-exits-dead evidence when every exit responded");
  assert.equal(failureOf(caught)?.failureClass, "timeout", "the truncated final attempt classifies as timeout");
  assert.equal(opened.length, 4, "one direct attempt + the full 3-attempt proxied budget");
});

test("controller: a responded-but-slow proxied exit (status null + receipt) is not a burned exit (#67 via #66)", async () => {
  // The #67 precision, now reachable on drive because the core carries the receipt (#66): every proxied
  // attempt RESPONDED (receipt true) but died before DCL (status null). navFailed still fails each attempt,
  // but the exhaustion is NOT the all-exits-dead burned verdict — the exits reached the site.
  const { gateway } = makeProxyGateway([
    [{ status: 403, tree: "Forbidden" }], // direct: hard-blocked → escalate
    [{ status: null, tree: "", responseReceived: true }], // proxied: responded, then died before DCL
  ]);
  const c = new GatewayDriveController(gateway, withProxy(), "tok", { onDatacenterIp: true });
  await assert.rejects(c.navigate("https://example.com/"), (err) => {
    assert.equal(err.name, "EscalationError");
    assert.doesNotMatch(err.message, /burned exit/i, "a responded exit must not read as burned");
    assert.notEqual(err.diagnostics.burnedExit, true);
    return true;
  });
});

test("controller: a pinned session whose next nav is deadline-truncated surfaces a timeout and discards (#66)", async () => {
  const { gateway, open } = makeProxyGateway([
    [{ status: 200, tree: REAL }, { status: 200, tree: "", deadlineTruncated: true }], // pin, then truncated
  ]);
  const c = new GatewayDriveController(gateway, withProxy(), "tok", { onDatacenterIp: true });
  const snap = await c.navigate("https://example.com/");
  assert.equal(snap.status, 200, "first navigate pins the direct session");
  await assert.rejects(
    c.navigate("https://example.com/deep"),
    /navigation timed out .*truncated by its timeout/i,
    "the pinned single-shot surfaces the truncation as a timeout, not a generic block",
  );
  assert.equal(open.size, 0, "the truncated session was discarded (next navigate re-runs escalation)");
});

test("controller: a direct-only session (no proxy) surfaces a failed navigation as an error", async () => {
  const { gateway } = makeProxyGateway([[{ status: null, tree: "" }]]);
  const c = new GatewayDriveController(gateway, noSecrets(), "tok", { onDatacenterIp: true }); // no proxy -> direct only
  await assert.rejects(c.navigate("https://example.com/"), /navigation failed/);
});

test("controller: a null-status direct failure (off-allowlist/unreachable) is surfaced, NOT escalated to the proxy", async () => {
  // Direct returns null status (an off-allowlist abort or an unreachable host) — no visible block,
  // no hard-block status. A fresh residential exit won't fix it, so it must not spend proxy retries.
  const { gateway, opened } = makeProxyGateway([[{ status: null, tree: "" }]]);
  const c = new GatewayDriveController(gateway, withProxy(), "tok", { onDatacenterIp: true });
  await assert.rejects(c.navigate("https://example.com/"), /navigation failed/);
  assert.equal(opened.length, 1, "only the direct attempt — a null-status failure does not escalate");
});

test("controller: resolves the proxy override per open, so a secret rotation takes effect (no cached creds)", async () => {
  let env = { BGW_PROXY_URL: "http://old-exit:1111" };
  const secrets = new SecretStore(() => env);
  const { gateway, opened } = makeProxyGateway([
    [{ status: 403, tree: "Forbidden" }], // s0 direct: blocked -> escalate
    [{ status: 200, tree: REAL }], //         s1 proxied: healthy (old creds)
    [{ status: 403, tree: "Forbidden" }], // s2 direct: blocked -> escalate
    [{ status: 200, tree: REAL }], //         s3 proxied: healthy (new creds)
  ]);
  const c = new GatewayDriveController(gateway, secrets, "tok", { onDatacenterIp: true });
  await c.navigate("https://example.com/");
  assert.match(opened[1].overrides?.proxy?.server ?? "", /old-exit/, "escalated with the original proxy");
  await c.close();
  env = { BGW_PROXY_URL: "http://new-exit:2222" }; // rotate the proxy out from under the controller
  secrets.reload();
  await c.navigate("https://example.com/again");
  assert.match(opened[3].overrides?.proxy?.server ?? "", /new-exit/, "next escalation used the rotated proxy, not a cached override");
});

test("controller: a pinned proxied session that fails mid-flow discards, so the next navigate re-escalates a fresh exit", async () => {
  const { gateway, opened } = makeProxyGateway([
    [{ status: 403, tree: "Forbidden" }], //                     s0 direct: blocked -> escalate
    [{ status: 200, tree: REAL }, { status: null, tree: "" }], // s1 proxied: 1st nav healthy (pins), 2nd fails
    [{ status: 403, tree: "Forbidden" }], //                     s2 direct (retry): blocked -> escalate
    [{ status: 200, tree: REAL }], //                            s3 proxied: a fresh healthy exit
  ]);
  const c = new GatewayDriveController(gateway, withProxy(), "tok", { onDatacenterIp: true });
  const first = await c.navigate("https://example.com/");
  assert.equal(first.status, 200, "escalated to a healthy proxied exit");
  assert.equal(opened.length, 2, "one direct attempt + one proxied (healthy)");
  await assert.rejects(c.navigate("https://example.com/2"), /retry navigate for a fresh exit/);
  // The pinned exit went bad mid-flow: discarded, so the next navigate re-runs direct-first escalation.
  const recovered = await c.navigate("https://example.com/3");
  assert.equal(recovered.status, 200, "re-escalated to a fresh healthy exit");
  assert.equal(opened.length, 4, "a fresh direct attempt + a fresh proxied exit on recovery");
});

test("controller: concurrent navigate calls are serialized — no double-open (mutex, H3)", async () => {
  // Session 0 is a healthy direct exit that pins. Two navigates fired with no await between them
  // both reach the `!#pinned` / `!#handle` checks across the openConsumerSession await WITHOUT the
  // mutex, opening two sessions and leaking one handle. The promise-chain mutex serializes them:
  // the first opens+pins, the second runs on the pinned session — exactly one open.
  const { gateway, opened, open } = makeProxyGateway([[{ status: 200, tree: REAL }]]);
  const c = new GatewayDriveController(gateway, noSecrets(), "tok");
  const [a, b] = await Promise.all([
    c.navigate("https://example.com/a"),
    c.navigate("https://example.com/b"),
  ]);
  assert.equal(opened.length, 1, "exactly one session opened despite concurrent navigates");
  assert.equal(open.size, 1, "no leaked session");
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
});
