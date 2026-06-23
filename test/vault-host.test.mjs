/**
 * On-host vault entrypoint tests (U8a) — run the REAL `dist/cli/vault-host.js` as a subprocess (the
 * way `docker exec` runs it), against a temp-dir vault + a 0600 key file + a manifest. This is the
 * genuine article: the same arg parsing, stdin payload handling, encrypted VaultStore round-trip,
 * and post-write fresh-decrypt verify that run in the gateway container. A restricted env is used so
 * the test never inherits a stray BGW_* secret from the dev shell.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { VaultStore, canonicalizeHost } from "../dist/security/index.js";
import { getVaultEntry } from "../dist/mcp/vault-login.js";

const ENTRY = fileURLToPath(new URL("../dist/cli/vault-host.js", import.meta.url));
const SEED = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"; // 160-bit, valid

function setup({ withKey = true, manifest = [{ id: "atlas", allow: ["*"] }] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "bgw-vaulthost-"));
  const vaultDir = join(root, "vault");
  const keyB64 = randomBytes(32).toString("base64");
  const keyFile = join(root, "vault.key");
  writeFileSync(keyFile, keyB64);
  chmodSync(keyFile, 0o600);
  const manifestPath = join(root, "consumers.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  // Restricted env: only what the entrypoint needs (+ PATH so `node` resolves) — no inherited secrets.
  // A bearer token per manifest consumer + a pool size, so the `login` path can build the full runtime.
  const env = { PATH: process.env.PATH, BGW_VAULT_DIR: vaultDir, BGW_CONSUMERS_MANIFEST: manifestPath, BGW_MAX_SESSIONS: "3" };
  for (const m of manifest) env[`BGW_CONSUMER_TOKEN_${m.id.toUpperCase()}`] = `tok-${m.id}-${"z".repeat(40)}`;
  if (withKey) env.BGW_VAULT_KEY_FILE = keyFile;
  return { root, vaultDir, keyB64, keyFile, manifestPath, env, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function run(env, args, input = "") {
  const r = spawnSync("node", [ENTRY, ...args], { env, input, encoding: "utf8" });
  const lastLine = (r.stdout ?? "").trim().split("\n").filter(Boolean).pop();
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", json: lastLine ? JSON.parse(lastLine) : undefined };
}

const SESSION = (extra = []) => ({
  cookies: [
    { name: "sid", value: "x".repeat(40), domain: "ex.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" },
    ...extra,
  ],
  origins: [{ origin: "https://ex.com", localStorage: [{ name: "tok", value: "y".repeat(24) }] }],
});
const challenge = (name) => ({ name, value: "ip-bound", domain: "ex.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" });
const PASSWORD = "correct-horse-battery-staple";
const importPayload = (session, creds = { username: "atlas-user", password: PASSWORD, totpSeed: SEED }) => JSON.stringify({ session, creds });

test("status: empty (key present) reports enabled + no entries, never trips the boot guard", () => {
  const fx = setup();
  try {
    const r = run(fx.env, ["status"]);
    assert.equal(r.code, 0);
    assert.deepEqual({ vaultEnabled: r.json.vaultEnabled, hasKey: r.json.hasKey, bootBlocked: r.json.bootBlocked, n: r.json.entries.length }, { vaultEnabled: true, hasKey: true, bootBlocked: false, n: 0 });
  } finally {
    fx.cleanup();
  }
});

test("status: BGW_VAULT_DIR unset reports the feature as disabled", () => {
  const fx = setup();
  try {
    const { BGW_VAULT_DIR, ...envNoDir } = fx.env;
    const r = run(envNoDir, ["status"]);
    assert.equal(r.code, 0);
    assert.equal(r.json.vaultEnabled, false);
    assert.deepEqual(r.json.entries, []);
  } finally {
    fx.cleanup();
  }
});

test("import: stores the durable cookie, strips IP-bound challenge tokens, verifies the decrypt", () => {
  const fx = setup();
  try {
    const session = SESSION([challenge("cf_clearance"), challenge("__cf_bm")]);
    const r = run(fx.env, ["import", "--consumer", "atlas", "--host", "ex.com"], importPayload(session));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json.cookieNames, ["sid"], "only the durable cookie persists");
    assert.equal(r.json.strippedCount, 2, "cf_clearance + __cf_bm stripped");
    assert.equal(r.json.bound, false);
    assert.equal(r.json.verified, true);
    // The result line carries NO secret material.
    assert.ok(!r.stdout.includes(PASSWORD) && !r.stdout.includes("atlas-user"), "no creds in stdout");

    // Decrypt the stored entry independently to prove the round-trip (challenge cookies really gone).
    const store = new VaultStore({ kek: Buffer.from(fx.keyB64, "base64"), dir: fx.vaultDir, canonicalizeHost });
    const entry = getVaultEntry(store, "atlas", "ex.com");
    const names = (entry.session.cookies ?? []).map((c) => c.name);
    assert.deepEqual(names, ["sid"]);
    assert.equal(entry.creds.password, PASSWORD, "creds round-trip through encryption");

    // status now lists exactly that entry.
    const s = run(fx.env, ["status"]);
    assert.equal(s.json.entries.length, 1);
    assert.deepEqual({ c: s.json.entries[0].consumerId, h: s.json.entries[0].host }, { c: "atlas", h: "ex.com" });
  } finally {
    fx.cleanup();
  }
});

test("import: --exit binds a sticky exit on the stored entry", () => {
  const fx = setup();
  try {
    const r = run(fx.env, ["import", "--consumer", "atlas", "--host", "ex.com", "--exit", "feed0000"], importPayload(SESSION()));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.bound, true);
    const store = new VaultStore({ kek: Buffer.from(fx.keyB64, "base64"), dir: fx.vaultDir, canonicalizeHost });
    assert.equal(getVaultEntry(store, "atlas", "ex.com").stickyExitId, "feed0000");
  } finally {
    fx.cleanup();
  }
});

test("import: refuses a consumer not in the manifest (no dead entries)", () => {
  const fx = setup();
  try {
    const r = run(fx.env, ["import", "--consumer", "ghost", "--host", "ex.com"], importPayload(SESSION()));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /"ghost" is not in the manifest/);
  } finally {
    fx.cleanup();
  }
});

test("import: rejects a malformed / incomplete payload", () => {
  const fx = setup();
  try {
    const noStdin = run(fx.env, ["import", "--consumer", "atlas", "--host", "ex.com"], "");
    assert.equal(noStdin.code, 1);
    assert.match(noStdin.stderr, /expects a JSON payload .* on stdin/);

    const noCreds = run(fx.env, ["import", "--consumer", "atlas", "--host", "ex.com"], JSON.stringify({ session: SESSION() }));
    assert.equal(noCreds.code, 1);
    assert.match(noCreds.stderr, /missing valid `creds`/);
  } finally {
    fx.cleanup();
  }
});

test("import: refuses when the vault has no master key", () => {
  const fx = setup({ withKey: false });
  try {
    const r = run(fx.env, ["import", "--consumer", "atlas", "--host", "ex.com"], importPayload(SESSION()));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no master key configured/);
  } finally {
    fx.cleanup();
  }
});

test("revoke: crypto-shreds an entry, then reports nothing-to-shred", () => {
  const fx = setup();
  try {
    run(fx.env, ["import", "--consumer", "atlas", "--host", "ex.com"], importPayload(SESSION()));
    const first = run(fx.env, ["revoke", "--consumer", "atlas", "--host", "ex.com"]);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.json.removed, true);
    assert.equal(run(fx.env, ["status"]).json.entries.length, 0, "entry gone after shred");

    const again = run(fx.env, ["revoke", "--consumer", "atlas", "--host", "ex.com"]);
    assert.equal(again.json.removed, false);
  } finally {
    fx.cleanup();
  }
});

test("status: entries on disk with NO key loads → boot-blocked, but the keyless listing still works", () => {
  const fx = setup();
  try {
    run(fx.env, ["import", "--consumer", "atlas", "--host", "ex.com"], importPayload(SESSION()));
    const { BGW_VAULT_KEY_FILE, ...envNoKey } = fx.env;
    const r = run(envNoKey, ["status"]);
    assert.equal(r.code, 0);
    assert.equal(r.json.hasKey, false);
    assert.equal(r.json.bootBlocked, true);
    assert.equal(r.json.entries.length, 1, "keyless listing reads the plaintext tuple");
  } finally {
    fx.cleanup();
  }
});

// --- login guards (these all fail BEFORE a browser launches, so they stay fast + Chrome-free) ---
const RECIPE = (loginUrl) => ({ loginUrl, usernameField: "#u", passwordField: "#p", submit: "#s", successText: "Welcome" });
const loginPayload = (recipe, creds = { username: "u", password: PASSWORD, totpSeed: SEED }) => JSON.stringify({ recipe, creds });

test("login: rejects a recipe whose loginUrl host ≠ --host (before launching a browser)", () => {
  const fx = setup();
  try {
    const r = run(fx.env, ["login", "--consumer", "atlas", "--host", "ex.com"], loginPayload(RECIPE("https://evil.com/login")));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /does not match the entry host/);
  } finally {
    fx.cleanup();
  }
});

test("login: refuses a consumer not in the manifest", () => {
  const fx = setup();
  try {
    const r = run(fx.env, ["login", "--consumer", "ghost", "--host", "ex.com"], loginPayload(RECIPE("https://ex.com/login")));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /"ghost" is not in the manifest/);
  } finally {
    fx.cleanup();
  }
});

test("login: rejects a malformed payload / missing success condition", () => {
  const fx = setup();
  try {
    const noStdin = run(fx.env, ["login", "--consumer", "atlas", "--host", "ex.com"], "");
    assert.equal(noStdin.code, 1);
    assert.match(noStdin.stderr, /expects a JSON payload .* on stdin/);

    const noSuccess = run(
      fx.env,
      ["login", "--consumer", "atlas", "--host", "ex.com"],
      JSON.stringify({ recipe: { loginUrl: "https://ex.com/login", usernameField: "#u", passwordField: "#p", submit: "#s" }, creds: { username: "u", password: PASSWORD } }),
    );
    assert.equal(noSuccess.code, 1);
    assert.match(noSuccess.stderr, /success condition/);
  } finally {
    fx.cleanup();
  }
});

test("login: refuses when the vault has no master key", () => {
  const fx = setup({ withKey: false });
  try {
    const r = run(fx.env, ["login", "--consumer", "atlas", "--host", "ex.com"], loginPayload(RECIPE("https://ex.com/login")));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no master key configured/);
  } finally {
    fx.cleanup();
  }
});
