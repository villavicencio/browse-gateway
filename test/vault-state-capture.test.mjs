/**
 * Unit tests for the localStorage seed-script builder (U5 — credential vault Phase 2).
 *
 * The real capture/restore round-trip (cookies + localStorage replayed into a cold Chrome) needs a
 * browser and is proven in-container by `scripts/validate-vault-roundtrip.mjs` — matching how the
 * anti-bot bypass is proven by the kill-gate, not here. What IS pure logic, and tested here, is the
 * script `buildLocalStorageSeedScript` emits: we run it against a fake `window` and assert the two
 * invariants the KTD-4 init-script contract demands — origin-guarding and idempotent seed-if-absent
 * — plus that arbitrary values survive the JSON embedding.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLocalStorageSeedScript, restoreOrClose } from "../dist/browser/index.js";

/** A Map-backed stand-in for the DOM `Storage` interface — getItem returns `null` when absent. */
function fakeLocalStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    dump: () => Object.fromEntries(m),
  };
}

/**
 * Execute the generated init script against a fake `window`. The script is an IIFE referencing the
 * free variable `window`; `new Function("window", script)` binds that to our stub, exactly as the
 * browser binds the real global. Returns the resulting localStorage contents.
 */
function run(script, { origin, initial = {} } = {}) {
  const ls = fakeLocalStorage(initial);
  const window = { location: { origin }, localStorage: ls };
  // eslint-disable-next-line no-new-func — deliberately eval the emitted browser script under test.
  new Function("window", script)(window);
  return ls.dump();
}

const ORIGIN = "https://app.example.com";
const origins = [{ origin: ORIGIN, localStorage: [{ name: "token", value: "secret-abc" }, { name: "uid", value: "42" }] }];

test("seeds localStorage when the document origin matches the captured origin", () => {
  const out = run(buildLocalStorageSeedScript(origins), { origin: ORIGIN });
  assert.deepEqual(out, { token: "secret-abc", uid: "42" });
});

test("origin-guard: writes NOTHING when on a different origin", () => {
  const out = run(buildLocalStorageSeedScript(origins), { origin: "https://evil.example.com" });
  assert.deepEqual(out, {}, "a captured value must never leak onto another origin");
});

test("multi-origin blob seeds only the matching origin", () => {
  const multi = [
    { origin: "https://a.example", localStorage: [{ name: "ka", value: "va" }] },
    { origin: "https://b.example", localStorage: [{ name: "kb", value: "vb" }] },
  ];
  assert.deepEqual(run(buildLocalStorageSeedScript(multi), { origin: "https://a.example" }), { ka: "va" });
  assert.deepEqual(run(buildLocalStorageSeedScript(multi), { origin: "https://b.example" }), { kb: "vb" });
});

test("seed-if-absent: never clobbers a value the page already wrote (idempotency / no-clobber)", () => {
  // First navigation seeds; the page then updates `token`; a second navigation re-fires the script.
  const out = run(buildLocalStorageSeedScript(origins), {
    origin: ORIGIN,
    initial: { token: "page-updated-value" }, // present already → must be left alone
  });
  assert.equal(out.token, "page-updated-value", "existing key preserved, not overwritten");
  assert.equal(out.uid, "42", "absent key still seeded");
});

test("re-running the script twice produces the identical store (idempotent re-fire)", () => {
  const script = buildLocalStorageSeedScript(origins);
  const once = run(script, { origin: ORIGIN });
  // Feed the first run's output back in as the starting store, then run again.
  const twice = run(script, { origin: ORIGIN, initial: once });
  assert.deepEqual(twice, once);
});

test("arbitrary values survive the JSON embedding (quotes, newline, backtick, unicode, separators)", () => {
  // U+2028 / U+2029 built via escapes — never literal separators in source (break grep/diff).
  const sepValue = "a\u2028b\u2029c";
  const gnarly = [
    {
      origin: ORIGIN,
      localStorage: [
        { name: "q", value: 'a"b\'c' },
        { name: "nl", value: "line1\nline2" },
        { name: "tick", value: "back`tick`${x}" },
        { name: "uni", value: "café — 日本語" },
        // U+2028 / U+2029: valid JSON, escaped by the builder so the JS literal stays legal.
        { name: "sep", value: sepValue },
      ],
    },
  ];
  const out = run(buildLocalStorageSeedScript(gnarly), { origin: ORIGIN });
  assert.equal(out.q, 'a"b\'c');
  assert.equal(out.nl, "line1\nline2");
  assert.equal(out.tick, "back`tick`${x}");
  assert.equal(out.uni, "café — 日本語");
  assert.equal(out.sep, sepValue);
});

test("does not throw when localStorage is unavailable (opaque/sandboxed origin)", () => {
  const ls = { get localStorage() { throw new Error("SecurityError: opaque origin"); } };
  const window = { location: { origin: ORIGIN }, localStorage: undefined };
  Object.defineProperty(window, "localStorage", Object.getOwnPropertyDescriptor(ls, "localStorage"));
  assert.doesNotThrow(() => new Function("window", buildLocalStorageSeedScript(origins))(window));
});

test("empty origins → an inert no-op script (no entries, still valid JS)", () => {
  const out = run(buildLocalStorageSeedScript([]), { origin: ORIGIN, initial: { keep: "me" } });
  assert.deepEqual(out, { keep: "me" });
});

// --- restoreOrClose: the close-on-failure invariant (no real browser; a fake context records calls) ---
// A just-launched Chrome must not be orphaned when a malformed/legacy persisted cookie makes
// addCookies reject; restoreOrClose closes the context and rethrows the ORIGINAL error.

/** A minimal BrowserContext stand-in recording cookie/init-script/close calls; addCookies can throw. */
function fakeContext({ cookiesThrow = null } = {}) {
  const ctx = {
    closed: 0,
    cookies: null,
    initScript: null,
    async addCookies(c) {
      if (cookiesThrow) throw cookiesThrow;
      ctx.cookies = c;
    },
    async addInitScript(s) {
      ctx.initScript = s;
    },
    async close() {
      ctx.closed++;
    },
  };
  return ctx;
}

test("restoreOrClose: closes the context and rethrows the original error when restore fails", async () => {
  const boom = new Error("addCookies: Cookie should have a url or a domain/path pair");
  const ctx = fakeContext({ cookiesThrow: boom });
  // A legacy/malformed persisted cookie (no domain/path) — the real addCookies-rejection trigger.
  const bad = { cookies: [{ name: "sid", value: "x" }], origins: [] };
  await assert.rejects(() => restoreOrClose(ctx, { state: bad, ownerHost: "ex.com" }), (e) => e === boom, "rethrows the ORIGINAL error");
  assert.equal(ctx.closed, 1, "context closed exactly once on failure (no orphan Chrome)");
});

test("restoreOrClose: success path applies state and never closes the context", async () => {
  const ctx = fakeContext();
  await restoreOrClose(ctx, {
    state: {
      cookies: [{ name: "sid", value: "x", domain: "ex.com", path: "/" }],
      origins: [{ origin: "https://ex.com", localStorage: [{ name: "k", value: "v" }] }],
    },
    ownerHost: "ex.com",
  });
  assert.equal(ctx.closed, 0, "a successful restore leaves the context open");
  assert.ok(ctx.cookies, "cookies applied");
  assert.match(ctx.initScript?.content ?? "", /localStorage/, "init script applied");
});

test("restoreOrClose: absent state is a no-op (ordinary cold session, context untouched)", async () => {
  const ctx = fakeContext();
  await restoreOrClose(ctx, undefined);
  assert.equal(ctx.closed, 0);
  assert.equal(ctx.cookies, null);
  assert.equal(ctx.initScript, null);
});

test("emitted script structurally carries both guards (regression backstop for the eval paths)", () => {
  const script = buildLocalStorageSeedScript(origins);
  assert.match(script, /o\.origin !== here/, "origin-guard present");
  assert.match(script, /getItem\([^)]*\) === null/, "seed-if-absent guard present");
  // No raw U+2028/U+2029 in the emitted source — they must be backslash-escaped.
  assert.ok(!/[\u2028\u2029]/.test(script), "separators must be escaped in the emitted JS");
});
