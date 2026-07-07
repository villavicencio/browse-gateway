/**
 * Warm-up navigation (PerimeterX deep-URL-first fix). On warm-open to an opted-in owner host
 * (BGW_WARMUP_HOSTS), the gateway navigates a shallow same-owner page (BGW_WARMUP_PATHS; default `/`)
 * FIRST so the edge WAF issues a clearance token into the live session, THEN the consumer's real
 * (possibly deep) target — which now carries the token instead of hard-403'ing. Server-side move of the
 * proven client-side two-step (solution 2026-06-28). These tests cover the pure path parser (fail-closed)
 * and the controller sequencing, asserting the load-bearing invariants: warm-up fires before the target,
 * on the SAME sealed exit-pinned session; a no-match host runs zero warm-up (non-regression); a blocked
 * warm-up never discards the session (target stays the gate); and R3 fail-closed still trips BEFORE any
 * warm-up. The live gate is scripts/validate-vault-warm-open.mjs (in-container, real browser).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWarmupPaths } from "../dist/verbs/index.js";
import { GatewayDriveController } from "../dist/mcp/drive-controller.js";
import { SecretStore } from "../dist/security/index.js";
import { Allowlist } from "../dist/policy/index.js";

// --- pure parser: parseWarmupPaths (fail-closed at boot) ------------------------------------------

test("parseWarmupPaths: comma-splits/trims/filters; empty or unset → the host-root default", () => {
  assert.deepEqual(parseWarmupPaths("/, /wine ,, /spirits"), ["/", "/wine", "/spirits"]);
  assert.deepEqual(parseWarmupPaths(""), ["/"], "empty → default host root");
  assert.deepEqual(parseWarmupPaths(undefined), ["/"], "unset → default host root");
  assert.deepEqual(parseWarmupPaths("   "), ["/"], "all-whitespace → default host root");
});

test("parseWarmupPaths: FAILS CLOSED on anything that could carry an off-owner authority", () => {
  assert.throws(() => parseWarmupPaths("https://evil.example/"), /same-host absolute path/, "full scheme://host rejected");
  assert.throws(() => parseWarmupPaths("//evil.example"), /same-host absolute path/, "protocol-relative //host rejected");
  assert.throws(() => parseWarmupPaths("wine"), /same-host absolute path/, "no leading slash rejected");
  assert.throws(() => parseWarmupPaths("/, //evil.example"), /same-host absolute path/, "one bad path in the list fails the whole parse");
  assert.throws(() => parseWarmupPaths("/ok/../../x?u=http://x"), /same-host absolute path/, "an embedded scheme (://) rejected");
});

// --- controller sequencing -----------------------------------------------------------------------

/** A gateway that records every open's coreOverride and, IN ORDER, every navigated URL. `navSeq` (by
 *  nav index) overrides the default 200 OK snapshot so a hop can be made to fail. Never a real browser. */
function makeNavRecordingGateway(navSeq) {
  let nextId = 1;
  const open = new Map();
  const opens = []; // coreOverride per openConsumerSession (undefined = cold)
  const navs = []; // navigated URLs, in order across the whole controller lifetime
  const closed = [];
  let navCount = 0;
  const ok = (url) => ({ url, title: "ok", tree: "real content ".repeat(12), status: 200 });
  const gateway = {
    sessions: { get: (h) => open.get(h) },
    async openConsumerSession(_t, override) {
      opens.push(override);
      const id = "h" + nextId++;
      open.set(id, {
        core: {
          async navigate(url) {
            navs.push(url);
            const seq = navSeq ? navSeq[Math.min(navCount, navSeq.length - 1)] : undefined;
            navCount++;
            return seq ? { ...ok(url), ...seq } : ok(url);
          },
          async snapshot() { return ok("u"); },
        },
      });
      return id;
    },
    async useConsumerSession(_t, handle, fn) {
      const s = open.get(handle);
      if (!s) throw new Error(`no open session for handle ${handle}`);
      return fn(s);
    },
    async closeConsumerSession(_t, h) { if (open.delete(h)) closed.push(h); },
  };
  return { gateway, open, opens, navs, closed };
}

/** A duck-typed VaultEntryStore returning `entry` for exactly (consumerId, host). */
function makeVault(consumerId, host, entry) {
  return {
    get(cid, h) { return cid === consumerId && h === host ? entry : null; },
    has(cid, h) { return cid === consumerId && h === host; },
    put() {},
    remove() { return false; },
  };
}

/** A captured entry whose durable cookie belongs to `host`. A `stickyExitId` makes warm replay bind a
 *  residential exit (R3); absent = a direct capture (replays direct). */
function warmEntry(host, opts = {}) {
  return {
    session: { cookies: [{ name: "sid", value: "logged-in", domain: host, path: "/" }], origins: [] },
    creds: { username: "u", password: "p" },
    ...(opts.stickyExitId ? { stickyExitId: opts.stickyExitId } : {}),
    updatedAt: 1,
  };
}

const noSecrets = () => new SecretStore(() => ({}));
const proxySecrets = () => new SecretStore(() => ({ BGW_PROXY_URL: "http://proxy:8080", BGW_PROXY_PASSWORD: "pw" }));
const allowAll = new Allowlist(["*"]);

test("warm-up: an opted-in owner host warms up the shallow root BEFORE the deep target, on ONE session", async () => {
  const { gateway, opens, navs, open } = makeNavRecordingGateway();
  const vault = makeVault("vault", "example.com", warmEntry("example.com"));
  const c = new GatewayDriveController(gateway, noSecrets(), "tok", {
    vault, consumerId: "vault", allowlist: allowAll, warmupHosts: ["example.com"], // default paths (["/"])
  });
  const snap = await c.navigate("https://example.com/deep/account");
  assert.equal(snap.status, 200, "the target navigate landed");
  assert.deepEqual(
    navs,
    ["https://example.com/", "https://example.com/deep/account"],
    "warm-up root fired FIRST, then the deep target — in order",
  );
  assert.equal(opens.length, 1, "exactly one session opened — warm-up ran on the SAME warm session, not a new one");
  assert.ok(opens[0]?.restoreState, "that session was the sealed warm session");
  assert.equal(open.size, 1, "session still live and pinned after the target");
});

test("warm-up: honors multiple configured shallow paths, in order, before the target", async () => {
  const { gateway, navs } = makeNavRecordingGateway();
  const vault = makeVault("vault", "example.com", warmEntry("example.com"));
  const c = new GatewayDriveController(gateway, noSecrets(), "tok", {
    vault, consumerId: "vault", allowlist: allowAll,
    warmupHosts: ["example.com"], warmupPaths: ["/", "/wine"],
  });
  await c.navigate("https://example.com/deep/account");
  assert.deepEqual(navs, [
    "https://example.com/",
    "https://example.com/wine",
    "https://example.com/deep/account",
  ], "both shallow hops fired in order, then the target");
});

test("warm-up: every warm-up hop stays on the OWNER host (single-host clamp holds)", async () => {
  const { gateway, navs } = makeNavRecordingGateway();
  const vault = makeVault("vault", "example.com", warmEntry("example.com"));
  const c = new GatewayDriveController(gateway, noSecrets(), "tok", {
    vault, consumerId: "vault", allowlist: allowAll,
    warmupHosts: ["example.com"], warmupPaths: ["/", "/wine"],
  });
  await c.navigate("https://example.com/deep/account");
  for (const u of navs.slice(0, -1)) {
    assert.equal(new URL(u).host, "example.com", `warm-up hop ${u} is on the owner host, never off-owner`);
  }
});

test("warm-up: a host NOT on BGW_WARMUP_HOSTS runs ZERO warm-up (non-regression: today's behavior)", async () => {
  const { gateway, navs, opens } = makeNavRecordingGateway();
  const vault = makeVault("vault", "example.com", warmEntry("example.com"));
  const c = new GatewayDriveController(gateway, noSecrets(), "tok", {
    vault, consumerId: "vault", allowlist: allowAll, warmupHosts: ["other.example"], // not example.com
  });
  await c.navigate("https://example.com/deep/account");
  assert.deepEqual(navs, ["https://example.com/deep/account"], "only the target — no warm-up hop");
  assert.equal(opens.length, 1, "one warm session, no extra opens");
});

test("warm-up: warm-up disabled entirely (no warmupHosts) is unchanged (non-regression)", async () => {
  const { gateway, navs } = makeNavRecordingGateway();
  const vault = makeVault("vault", "example.com", warmEntry("example.com"));
  const c = new GatewayDriveController(gateway, noSecrets(), "tok", {
    vault, consumerId: "vault", allowlist: allowAll, // no warmupHosts at all
  });
  await c.navigate("https://example.com/deep/account");
  assert.deepEqual(navs, ["https://example.com/deep/account"], "single target navigate, exactly as before this feature");
});

test("warm-up: when the target IS the shallow root, warm-up is skipped (no redundant double-load)", async () => {
  const { gateway, navs } = makeNavRecordingGateway();
  const vault = makeVault("vault", "example.com", warmEntry("example.com"));
  const c = new GatewayDriveController(gateway, noSecrets(), "tok", {
    vault, consumerId: "vault", allowlist: allowAll, warmupHosts: ["example.com"], warmupPaths: ["/"],
  });
  await c.navigate("https://example.com/");
  assert.deepEqual(navs, ["https://example.com/"], "the target's own navigate clears the shallow page — no duplicate warm-up hop");
});

test("warm-up: a BLOCKED warm-up hop is best-effort — it does NOT discard the session and the target still lands", async () => {
  // nav #0 = warm-up "/" → 403 (blocked). nav #1 = target → 200. The blocked warm-up must NOT discard
  // the warm session; the target navigate is the authoritative gate and here it succeeds.
  const { gateway, navs, opens, open, closed } = makeNavRecordingGateway([
    { status: 403, title: "Access Denied", tree: "blocked" }, // warm-up hop blocked
    undefined, // target → default 200
  ]);
  const vault = makeVault("vault", "example.com", warmEntry("example.com"));
  const c = new GatewayDriveController(gateway, noSecrets(), "tok", {
    vault, consumerId: "vault", allowlist: allowAll, warmupHosts: ["example.com"],
  });
  const snap = await c.navigate("https://example.com/deep/account");
  assert.equal(snap.status, 200, "the target still landed despite the blocked warm-up hop");
  assert.deepEqual(navs, ["https://example.com/", "https://example.com/deep/account"], "warm-up was attempted, then the target");
  assert.equal(opens.length, 1, "no re-open — the warm session was reused, not discarded, across the blocked hop");
  assert.equal(closed.length, 0, "the warm session was never closed/discarded by the blocked warm-up");
  assert.equal(open.size, 1, "session live and pinned");
});

test("warm-up: multiple hops abort at the first block (don't hammer the exit), then go to the target", async () => {
  // hops = ["/", "/wine"]. nav #0 = "/" → 403 → abort remaining hops. Next nav is the TARGET, not "/wine".
  const { gateway, navs } = makeNavRecordingGateway([
    { status: 403, title: "Access Denied", tree: "blocked" }, // "/" blocked
    undefined, // whatever runs next → 200
  ]);
  const vault = makeVault("vault", "example.com", warmEntry("example.com"));
  const c = new GatewayDriveController(gateway, noSecrets(), "tok", {
    vault, consumerId: "vault", allowlist: allowAll, warmupHosts: ["example.com"], warmupPaths: ["/", "/wine"],
  });
  await c.navigate("https://example.com/deep/account");
  assert.deepEqual(
    navs,
    ["https://example.com/", "https://example.com/deep/account"],
    "second warm-up hop /wine was skipped after the first blocked; jumped straight to the target",
  );
});

test("warm-up: R3 fail-closed still trips BEFORE any warm-up (a bound entry with no re-pin never warms up)", async () => {
  // A bound (residential-exit) entry with no proxy configured → buildWarmOverride throws (R3) in
  // #firstNavigate, BEFORE #openWarmAndNavigate. So NO session opens and NO warm-up hop fires — warm-up
  // cannot weaken the fail-closed refusal.
  const { gateway, navs, opens } = makeNavRecordingGateway();
  const vault = makeVault("vault", "example.com", warmEntry("example.com", { stickyExitId: "abcd1234" }));
  const c = new GatewayDriveController(gateway, noSecrets(), "tok", {
    vault, consumerId: "vault", allowlist: allowAll, warmupHosts: ["example.com"], onDatacenterIp: true,
  });
  await assert.rejects(c.navigate("https://example.com/deep/account"), /cannot be re-pinned|wrong network posture/i);
  assert.equal(opens.length, 0, "fail-closed before any session opened — warm-up never reached");
  assert.deepEqual(navs, [], "no warm-up navigation fired");
});

test("warm-up: a reaped DIRECT warm session RE-WARMS the shallow page before the deep target on reopen", async () => {
  // The gap Codex caught: after an idle reap, the reopen-after-reap path re-warms a fresh warm session
  // with NO clearance token and would go deep-URL-first. It must run the SAME warm-up before the target,
  // symmetric with the first warm-open — else a warm-up host regresses to the PX 403 this feature fixes.
  const { gateway, navs, open, opens } = makeNavRecordingGateway();
  const vault = makeVault("vault", "example.com", warmEntry("example.com")); // direct capture (no exit)
  const c = new GatewayDriveController(gateway, noSecrets(), "tok", {
    vault, consumerId: "vault", allowlist: allowAll, warmupHosts: ["example.com"],
  });
  await c.navigate("https://example.com/deep/account"); // first warm-open: warm-up "/" then target, pinned
  open.delete([...open.keys()][0]); // idle reap closes the held session out from under us
  await assert.rejects(c.navigate("https://example.com/deep/account"), /no open session/); // reap detected, handle reset
  const before = navs.length;
  await c.navigate("https://example.com/deep/again"); // reopen-after-reap path
  assert.deepEqual(
    navs.slice(before),
    ["https://example.com/", "https://example.com/deep/again"],
    "reopen re-warmed the shallow root BEFORE the deep target — no deep-URL-first regression",
  );
  assert.equal(opens[opens.length - 1]?.restoreState?.ownerHost, "example.com", "reopen re-warmed (sealed), not cold");
});

test("warm-up: a reaped BOUND warm session re-warms through the SAME re-pinned exit before the target on reopen", async () => {
  const { gateway, navs, open, opens } = makeNavRecordingGateway();
  const vault = makeVault("vault", "example.com", warmEntry("example.com", { stickyExitId: "abcd1234" }));
  const c = new GatewayDriveController(gateway, proxySecrets(), "tok", {
    vault, consumerId: "vault", allowlist: allowAll,
    warmupHosts: ["example.com"], onDatacenterIp: true, stickySuffix: "_s-{id}",
  });
  await c.navigate("https://example.com/deep/account");
  open.delete([...open.keys()][0]);
  await assert.rejects(c.navigate("https://example.com/deep/account"), /no open session/);
  const before = navs.length;
  await c.navigate("https://example.com/deep/again");
  assert.deepEqual(
    navs.slice(before),
    ["https://example.com/", "https://example.com/deep/again"],
    "bound reopen re-warmed the shallow root before the deep target",
  );
  assert.equal(opens[opens.length - 1]?.proxy?.password, "pw_s-abcd1234", "reopen re-pinned the SAME captured exit (R3); warm-up rode it");
});

test("warm-up: a LIVE (non-reaped) pinned navigate does NOT re-warm (token already held)", async () => {
  // Only an actual reopen re-warms. A second navigate on a still-live warm session must NOT re-run
  // warm-up (the live session already carries the clearance token; re-warming every navigate is wrong).
  const { gateway, navs } = makeNavRecordingGateway();
  const vault = makeVault("vault", "example.com", warmEntry("example.com"));
  const c = new GatewayDriveController(gateway, noSecrets(), "tok", {
    vault, consumerId: "vault", allowlist: allowAll, warmupHosts: ["example.com"],
  });
  await c.navigate("https://example.com/deep/account"); // warm-up "/" + target
  const before = navs.length;
  await c.navigate("https://example.com/deep/more"); // live pinned navigate — no reap, no re-warm
  assert.deepEqual(navs.slice(before), ["https://example.com/deep/more"], "live pinned navigate goes straight to the target, no extra warm-up");
});

test("warm-up: a BOUND (proxied) warm session warms up through the SAME re-pinned exit, then the target", async () => {
  // The proven PX case is a bound/fresh residential exit. Warm-up must run through the SAME sealed
  // proxied session (never an unpinned one), so the warm-up + target share the re-pinned exit (R3).
  const { gateway, navs, opens } = makeNavRecordingGateway();
  const vault = makeVault("vault", "example.com", warmEntry("example.com", { stickyExitId: "abcd1234" }));
  const c = new GatewayDriveController(gateway, proxySecrets(), "tok", {
    vault, consumerId: "vault", allowlist: allowAll,
    warmupHosts: ["example.com"], onDatacenterIp: true, stickySuffix: "_s-{id}",
  });
  await c.navigate("https://example.com/deep/account");
  assert.deepEqual(navs, ["https://example.com/", "https://example.com/deep/account"], "warm-up root, then target");
  assert.equal(opens.length, 1, "one bound proxied session for BOTH the warm-up and the target");
  assert.equal(opens[0]?.proxy?.password, "pw_s-abcd1234", "the SAME re-pinned captured exit (R3) carried the warm-up");
});
