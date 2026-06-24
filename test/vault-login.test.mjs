/**
 * Unit tests for the vault credential/session orchestration (U6c). Capture/import persist a
 * VaultEntry through the REAL encrypted VaultStore (temp dir + random KEK), so the entry shape is
 * proven to round-trip through encryption — not a fake store. The browser/gateway login is injected
 * as a fake runLogin seam (the live path is a follow-up validator). buildWarmOverride is checked for
 * the R3 invariant: the warm session restores the captured state AND re-pins the bound sticky exit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  captureLoginToVault,
  importLoginToVault,
  getVaultEntry,
  revokeVaultEntry,
  buildWarmOverride,
  stripIpBoundTokens,
  isIpBoundChallengeCookie,
} from "../dist/mcp/vault-login.js";
import { VaultStore, canonicalizeHost, SecretStore } from "../dist/security/index.js";

const SEED = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"; // 160-bit, valid
const SESSION = {
  cookies: [{ name: "sid", value: "x".repeat(40), domain: "ex.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }],
  origins: [{ origin: "https://ex.com", localStorage: [{ name: "tok", value: "y".repeat(24) }] }],
};
const CREDS = { username: "atlas-user", password: "p".repeat(20), totpSeed: SEED };
const RECIPE = { loginUrl: "https://ex.com/login", usernameField: "#u", passwordField: "#p", submit: "#s", successText: "Welcome" };

const cookie = (name, value = "v") => ({ name, value, domain: "ex.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" });
// A captured session carrying a durable login cookie PLUS IP-bound anti-bot challenge tokens.
const CHALLENGED = {
  cookies: [cookie("sid", "x".repeat(40)), cookie("cf_clearance", "cf"), cookie("__cf_bm", "bm"), cookie("_px3", "px"), cookie("datadome", "dd"), cookie("_abck", "ak")],
  origins: [{ origin: "https://ex.com", localStorage: [{ name: "tok", value: "keepme" }] }],
};

function tmpVault() {
  const dir = mkdtempSync(join(tmpdir(), "bgw-vault-login-"));
  return { vault: new VaultStore({ kek: randomBytes(32), dir, canonicalizeHost }), dir };
}
/** A fake LoginRunner. Returns `{state}` for a direct capture, or `{state, stickyExitId}` to
 *  simulate an escalated capture that bound an exit (the runner owns the direct-first decision). */
function fakeRunner(state, stickyExitId) {
  const calls = [];
  return { calls, run: async (args) => (calls.push(args), { state, ...(stickyExitId ? { stickyExitId } : {}) }) };
}

test("captureLoginToVault: drives the login and persists the bound exit the runner reports (escalated capture)", async () => {
  const { vault, dir } = tmpVault();
  try {
    const r = fakeRunner(SESSION, "abcd1234"); // runner escalated → reports a bound exit
    const entry = await captureLoginToVault({ vault, runLogin: r.run }, { consumerId: "atlas", host: "ex.com", recipe: RECIPE, creds: CREDS });
    // the runner is called with host/recipe/creds — NOT a pre-minted exit id (it owns the decision)
    assert.equal(r.calls.length, 1);
    assert.deepEqual(r.calls[0], { host: "ex.com", recipe: RECIPE, creds: CREDS });
    // the runner-reported exit is persisted with the captured session + creds
    const stored = getVaultEntry(vault, "atlas", "ex.com");
    assert.deepEqual(stored.session, SESSION);
    assert.deepEqual(stored.creds, CREDS);
    assert.equal(stored.stickyExitId, "abcd1234");
    assert.equal(stored.stickyExitId, entry.stickyExitId);
    assert.equal(typeof stored.updatedAt, "number");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("captureLoginToVault: a DIRECT capture (runner reports no exit) binds no stickyExitId", async () => {
  const { vault, dir } = tmpVault();
  try {
    const r = fakeRunner(SESSION); // direct — runner cleared without escalating
    const entry = await captureLoginToVault({ vault, runLogin: r.run }, { consumerId: "atlas", host: "ex.com", recipe: RECIPE, creds: CREDS });
    assert.equal("stickyExitId" in entry, false, "no bound exit recorded for a direct capture");
    assert.equal("stickyExitId" in getVaultEntry(vault, "atlas", "ex.com"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("importLoginToVault: persists an operator-provided session, with and without a bound exit", async () => {
  const { vault, dir } = tmpVault();
  try {
    const bound = importLoginToVault(vault, { consumerId: "atlas", host: "ex.com", session: SESSION, creds: CREDS, stickyExitId: "feed0000" });
    assert.equal(bound.stickyExitId, "feed0000");
    assert.deepEqual(getVaultEntry(vault, "atlas", "ex.com").session, SESSION);

    const unbound = importLoginToVault(vault, { consumerId: "atlas", host: "other.com", session: SESSION, creds: { username: "u", password: "p".repeat(16) } });
    assert.equal("stickyExitId" in unbound, false, "no exit bound → no stickyExitId field");
    assert.deepEqual(getVaultEntry(vault, "atlas", "other.com").creds, { username: "u", password: "p".repeat(16) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getVaultEntry returns null when absent; revokeVaultEntry crypto-shreds", async () => {
  const { vault, dir } = tmpVault();
  try {
    assert.equal(getVaultEntry(vault, "atlas", "nope.com"), null);
    importLoginToVault(vault, { consumerId: "atlas", host: "ex.com", session: SESSION, creds: CREDS });
    assert.equal(revokeVaultEntry(vault, "atlas", "ex.com"), true);
    assert.equal(getVaultEntry(vault, "atlas", "ex.com"), null, "gone after revoke");
    assert.equal(revokeVaultEntry(vault, "atlas", "ex.com"), false, "second revoke is a no-op");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an invalid TOTP seed is rejected at STORE time, before driving the login (U6a check)", async () => {
  const { vault, dir } = tmpVault();
  try {
    const r = fakeRunner(SESSION);
    const weak = { username: "u", password: "p".repeat(16), totpSeed: "JBSWY3DPEHPK3PXP" }; // 80-bit
    await assert.rejects(
      () => captureLoginToVault({ vault, runLogin: r.run }, { consumerId: "atlas", host: "ex.com", recipe: RECIPE, creds: weak }),
      /TOTP seed is invalid/,
    );
    assert.equal(r.calls.length, 0, "rejected before any login was driven");
    assert.throws(
      () => importLoginToVault(vault, { consumerId: "atlas", host: "ex.com", session: SESSION, creds: weak }),
      /TOTP seed is invalid/,
    );
    assert.equal(vault.has("atlas", "ex.com"), false, "nothing stored for a bad seed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildWarmOverride: restores the captured state AND re-pins the bound sticky exit (R3)", () => {
  const secrets = new SecretStore(() => ({ BGW_PROXY_URL: "http://p:1", BGW_PROXY_PASSWORD: "pw" }));
  const entry = { session: SESSION, creds: CREDS, stickyExitId: "abcd1234", updatedAt: 1 };
  const override = buildWarmOverride(entry, secrets, { onDatacenterIp: true, stickySuffix: "_session-{id}", ownerHost: "ex.com" });
  assert.deepEqual(override.restoreState, { state: SESSION, ownerHost: "ex.com" }, "warm session restores the captured state, owner-bound to ex.com");
  assert.ok(override.proxy, "proxy applied (configured + on datacenter IP)");
  assert.ok(override.proxy.password.startsWith("pw"), "base proxy password preserved");
  assert.ok(override.proxy.password.includes("abcd1234"), "the BOUND exit id is pinned, not a fresh one");
});

test("buildWarmOverride: a DIRECT-captured entry (no bound exit) replays direct even with proxy configured (R7)", () => {
  const secrets = new SecretStore(() => ({ BGW_PROXY_URL: "http://p:1", BGW_PROXY_PASSWORD: "pw" }));
  const entry = { session: SESSION, creds: CREDS, updatedAt: 1 }; // no stickyExitId → direct capture
  assert.deepEqual(buildWarmOverride(entry, secrets, { onDatacenterIp: true, stickySuffix: "_session-{id}", ownerHost: "ex.com" }), { restoreState: { state: SESSION, ownerHost: "ex.com" } });
});

test("buildWarmOverride: warm session is direct (state only) when no proxy is configured", () => {
  const bare = new SecretStore(() => ({}));
  const entry = { session: SESSION, creds: CREDS, stickyExitId: "abcd1234", updatedAt: 1 };
  assert.deepEqual(buildWarmOverride(entry, bare, { onDatacenterIp: true, ownerHost: "ex.com" }), { restoreState: { state: SESSION, ownerHost: "ex.com" } });
});

test("buildWarmOverride: no proxy when not on a datacenter IP, even with proxy configured", () => {
  const secrets = new SecretStore(() => ({ BGW_PROXY_URL: "http://p:1", BGW_PROXY_PASSWORD: "pw" }));
  const entry = { session: SESSION, creds: CREDS, stickyExitId: "abcd1234", updatedAt: 1 };
  assert.deepEqual(buildWarmOverride(entry, secrets, { onDatacenterIp: false, stickySuffix: "_session-{id}", ownerHost: "ex.com" }), { restoreState: { state: SESSION, ownerHost: "ex.com" } });
});

test("capture drops IP-bound challenge tokens; the durable cookie + localStorage survive capture→vault→warm (PR #31 P1)", async () => {
  const { vault, dir } = tmpVault();
  try {
    const r = fakeRunner(CHALLENGED);
    const entry = await captureLoginToVault({ vault, runLogin: r.run }, { consumerId: "atlas", host: "ex.com", recipe: RECIPE, creds: CREDS });
    assert.deepEqual(entry.session.cookies.map((c) => c.name), ["sid"], "only the durable login cookie is persisted");
    assert.deepEqual(entry.session.origins, CHALLENGED.origins, "localStorage is preserved");
    // it round-trips through the encrypted store stripped...
    assert.deepEqual(getVaultEntry(vault, "atlas", "ex.com").session.cookies.map((c) => c.name), ["sid"]);
    // ...and the warm-replay override carries no IP-bound clearance either.
    const override = buildWarmOverride(entry, new SecretStore(() => ({})), { onDatacenterIp: true, ownerHost: "ex.com" });
    assert.deepEqual(override.restoreState.state.cookies.map((c) => c.name), ["sid"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("import also drops IP-bound challenge tokens from an operator-provided state (PR #31 P1)", () => {
  const { vault, dir } = tmpVault();
  try {
    const e = importLoginToVault(vault, { consumerId: "atlas", host: "imp.com", session: CHALLENGED, creds: CREDS });
    assert.deepEqual(e.session.cookies.map((c) => c.name), ["sid"]);
    assert.deepEqual(getVaultEntry(vault, "atlas", "imp.com").session.cookies.map((c) => c.name), ["sid"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stripIpBoundTokens / isIpBoundChallengeCookie: vendor challenge cookies dropped, durable cookies kept", () => {
  const drop = ["cf_clearance", "CF_CLEARANCE", "__cf_bm", "cf_chl_2", "_px", "_px3", "_pxhd", "pxcts", "datadome", "_abck", "bm_sz", "ak_bmsc", "incap_ses_1_2", "visid_incap_99", "nlbi_123"];
  const keep = ["sid", "session", "auth_token", "csrf_token", "__Host-session", "remember_me", "JSESSIONID", "laravel_session"];
  for (const n of drop) assert.equal(isIpBoundChallengeCookie(n), true, `${n} must be treated as IP-bound`);
  for (const n of keep) assert.equal(isIpBoundChallengeCookie(n), false, `${n} must be kept`);
  const state = { cookies: [...drop, ...keep].map((n) => cookie(n)), origins: [] };
  assert.deepEqual(stripIpBoundTokens(state).cookies.map((c) => c.name), keep, "exactly the durable cookies remain");
});
