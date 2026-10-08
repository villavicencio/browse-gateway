/**
 * Obscura keys lifecycle tests (U3) — `new`/`list`/`revoke` against a REAL local `sh` shell
 * (the admin-SSH transport's loopback fake) and a temp-dir manifest/env pair, plus an in-memory
 * keychain. Real SSH is deferred to manual verification; everything else is the genuine article:
 * the same scripts, atomic-write paths, and file modes that will run on prod.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  keysNew,
  keysList,
  keysRevoke,
  localShell,
  memoryKeychain,
  writeRemoteFileAtomic,
  readRemoteFile,
  shQuote,
  tokenEnvKey,
  execCapture,
} from "../dist/cli/index.js";

function fixture({ manifest, env } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "obscura-keys-"));
  const manifestPath = join(dir, "consumers.json");
  const envFilePath = join(dir, "gateway.env");
  if (manifest !== undefined) writeFileSync(manifestPath, manifest);
  if (env !== undefined) writeFileSync(envFilePath, env);
  const lines = [];
  const keychain = memoryKeychain();
  const deps = {
    shell: localShell(),
    keychain,
    manifestPath,
    envFilePath,
    container: "browse-gateway-http",
    gatewayHost: "127.0.0.1:8080",
    out: (line) => lines.push(line),
    wait: async () => {},
  };
  return { deps, lines, keychain, manifestPath, envFilePath };
}

const BASE_MANIFEST = JSON.stringify([{ id: "consumer-1", allow: ["*"] }], null, 2);
// A realistic cap: with no BGW_MAX_SESSIONS the boot default (2) admits ONE consumer, so a fixture that
// adds a second would describe a config the real gateway refuses to boot (VIL-133).
const BASE_ENV = `export ${tokenEnvKey("consumer-1")}=${"a".repeat(64)}\nexport BGW_MAX_SESSIONS=8\nexport BGW_PER_CONSUMER_MAX=1\n`;

test("keys new writes manifest entry + env token, stores in keychain, prints token once", async () => {
  const { deps, lines, keychain, manifestPath, envFilePath } = fixture({ manifest: BASE_MANIFEST, env: BASE_ENV });
  await keysNew(deps, "consumer-2");

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.deepEqual(manifest[1], { id: "consumer-2", allow: ["*"] }, "--allow defaults to ['*']");

  const env = readFileSync(envFilePath, "utf8");
  const match = env.match(new RegExp(`^export ${tokenEnvKey("consumer-2")}=([0-9a-f]{64})$`, "m"));
  assert.ok(match, "env line appended");
  const token = match[1];
  assert.ok(env.startsWith("export BGW_CONSUMER_TOKEN_CONSUMER_1="), "existing env content preserved");

  assert.equal(statSync(envFilePath).mode & 0o777, 0o600, "env file forced to 0600");
  assert.equal(keychain.items.get("consumer-2"), token, "literal token in keychain");

  const tokenLines = lines.filter((l) => l.includes(token));
  assert.equal(tokenLines.length, 1, "token printed exactly once");
  assert.ok(lines.some((l) => l.includes("staged only")), "default stages and prints the restart instruction");
});

test("keys new honors --allow and rejects duplicates, collisions, and bad ids", async () => {
  const { deps, manifestPath } = fixture({ manifest: BASE_MANIFEST, env: BASE_ENV });
  await keysNew(deps, "scoped", { allow: ["x.com", "*.y.com"] });
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.deepEqual(manifest[1], { id: "scoped", allow: ["x.com", "*.y.com"] });

  await assert.rejects(() => keysNew(deps, "consumer-1"), /already exists/);
  // "consumer.1" normalizes to the same env key as "consumer-1" — must be rejected at mint time.
  await assert.rejects(() => keysNew(deps, "consumer.1"), /collides with existing consumer "consumer-1"/);
  await assert.rejects(() => keysNew(deps, "-bad"), /invalid consumer id/);
  await assert.rejects(() => keysNew(deps, "sh$(boom)"), /invalid consumer id/);
});

test("keys new fails loudly on missing files and on env/manifest desync", async () => {
  const missing = fixture();
  await assert.rejects(() => keysNew(missing.deps, "c"), /manifest not found/);

  const desync = fixture({ manifest: BASE_MANIFEST, env: `${BASE_ENV}export ${tokenEnvKey("ghost")}=${"b".repeat(64)}\n` });
  await assert.rejects(() => keysNew(desync.deps, "ghost"), /desync/);
});

test("atomicity: an interrupt between manifest and env write leaves the LOUD state", async () => {
  const { deps, manifestPath, envFilePath } = fixture({ manifest: BASE_MANIFEST, env: BASE_ENV });
  // Fail every WRITE that targets the env file (reads still work) — the simulated interrupt
  // after the manifest write.
  const inner = deps.shell;
  deps.shell = {
    run: (script, input) =>
      script.includes("gateway.env.obscura-tmp")
        ? Promise.resolve({ code: 1, stdout: "", stderr: "interrupted" })
        : inner.run(script, input),
  };
  await assert.rejects(() => keysNew(deps, "consumer-2"), /remote write .* failed/);

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.ok(manifest.some((e) => e.id === "consumer-2"), "manifest entry landed (gateway will fail startup loudly)");
  assert.ok(!readFileSync(envFilePath, "utf8").includes(tokenEnvKey("consumer-2")), "no orphan env token, ever");
});

test("atomic write is temp+rename: no torn file visible, mode applied", async () => {
  const { deps, envFilePath } = fixture({ env: "old\n" });
  await writeRemoteFileAtomic(deps.shell, envFilePath, "new contents\n", "0600");
  assert.equal(readFileSync(envFilePath, "utf8"), "new contents\n");
  assert.equal(statSync(envFilePath).mode & 0o777, 0o600);
  assert.ok(!existsSync(`${envFilePath}.obscura-tmp`), "temp file cleaned up by the rename");
});

test("keys list shows ids/allow/token-set and flags desync, never a token value", async () => {
  const { deps, lines } = fixture({
    manifest: JSON.stringify([
      { id: "consumer-1", allow: ["*"], tags: ["prod"] },
      { id: "consumer-2", allow: ["x.com"] }, // no env token → MISSING
    ]),
    env: `${BASE_ENV}export ${tokenEnvKey("ghost")}=${"b".repeat(64)}\n`, // orphan → desync
  });
  const result = await keysList(deps);

  assert.deepEqual(
    result.consumers.map((c) => [c.id, c.tokenSet]),
    [["consumer-1", true], ["consumer-2", false]],
  );
  assert.deepEqual(result.orphanEnvKeys, [tokenEnvKey("ghost")]);
  assert.ok(lines.some((l) => l.includes("consumer-1") && l.includes("token=set") && l.includes("tags=prod")));
  assert.ok(lines.some((l) => l.includes("consumer-2") && l.includes("token=MISSING")));
  assert.ok(lines.some((l) => l.includes("desync")));
  for (const line of lines) {
    assert.ok(!line.includes("a".repeat(64)) && !line.includes("b".repeat(64)), "no token value in output");
  }
});

test("keys revoke removes both lines and surfaces the restart-window caveat", async () => {
  const { deps, lines, keychain, manifestPath, envFilePath } = fixture({
    manifest: JSON.stringify([{ id: "consumer-1", allow: ["*"] }, { id: "consumer-2", allow: ["x.com"] }]),
    env: `${BASE_ENV}export ${tokenEnvKey("consumer-2")}=${"c".repeat(64)}\n`,
  });
  await keychain.set("consumer-2", "c".repeat(64));
  await keysRevoke(deps, "consumer-2");

  assert.deepEqual(JSON.parse(readFileSync(manifestPath, "utf8")).map((e) => e.id), ["consumer-1"]);
  const env = readFileSync(envFilePath, "utf8");
  assert.ok(!env.includes(tokenEnvKey("consumer-2")), "env token line removed");
  assert.ok(env.includes(tokenEnvKey("consumer-1")), "other consumers untouched");
  assert.equal(keychain.items.has("consumer-2"), false, "keychain copy removed");
  assert.ok(lines.some((l) => l.includes("valid until the gateway is re-created")), "R-Risk5 surfaced");
});

test("keys revoke: unknown id errors; one-sided desync is reported then fully cleaned", async () => {
  const unknown = fixture({ manifest: BASE_MANIFEST, env: BASE_ENV });
  await assert.rejects(() => keysRevoke(unknown.deps, "nope"), /unknown consumer "nope"/);

  // id present only in env (not manifest) — reported, and the env line still removed.
  const desync = fixture({ manifest: BASE_MANIFEST, env: `${BASE_ENV}export ${tokenEnvKey("ghost")}=${"b".repeat(64)}\n` });
  await keysRevoke(desync.deps, "ghost");
  assert.ok(desync.lines.some((l) => l.includes("desync")), "desync reported");
  assert.ok(!readFileSync(desync.envFilePath, "utf8").includes("ghost".toUpperCase()), "orphan env line cleaned");
  assert.deepEqual(JSON.parse(readFileSync(desync.manifestPath, "utf8")).map((e) => e.id), ["consumer-1"], "manifest untouched");
});

test("keys revoke refuses an id that merely normalizes onto another consumer's env key", async () => {
  // revoke 'consumer.1' when 'consumer-1' exists: same env key — deleting it would brick the
  // next gateway boot (manifest entry left with no token).
  const { deps, manifestPath, envFilePath } = fixture({ manifest: BASE_MANIFEST, env: BASE_ENV });
  await assert.rejects(() => keysRevoke(deps, "consumer.1"), /belongs to "consumer-1".*did you mean/s);
  assert.ok(readFileSync(envFilePath, "utf8").includes(tokenEnvKey("consumer-1")), "token untouched");
  assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).length, 1, "manifest untouched");
});

/** Shell fake for the --apply path: smoke, applyCmd, curl poll, and docker-exec printenv are scripted. */
function applyShell({ curlCodes = ["401"], envKeyPresent = true, applyCmdFails = false, smokeCode = 0 } = {}) {
  const calls = [];
  let curlAt = 0;
  return {
    calls,
    run: async (script, _input, opts) => {
      calls.push({ script, opts });
      if (script.includes("preswap-smoke")) {
        if (smokeCode === 0) return { code: 0, stdout: "smoke: OK", stderr: "" };
        // -1 is the execCapture watchdog's timeout result; positive codes are a clean smoke failure.
        return { code: smokeCode, stdout: "", stderr: smokeCode === -1 ? "ssh timed out after 120000ms" : "BGW_MAX_SESSIONS too low" };
      }
      if (script.includes("printenv")) return { code: envKeyPresent ? 0 : 1, stdout: "", stderr: "" };
      if (script.includes("curl")) {
        const code = curlCodes[Math.min(curlAt, curlCodes.length - 1)];
        curlAt++;
        return { code: 0, stdout: code, stderr: "" };
      }
      // anything else with DOCKER_HOST is the applyCmd invocation
      return applyCmdFails ? { code: 1, stdout: "", stderr: "boom" } : { code: 0, stdout: "", stderr: "" };
    },
  };
}

/** Route the --apply remote calls (smoke/applyCmd/curl/printenv) to the fake, file ops to the real shell. */
function routeApply(fileShell, remote) {
  return {
    run: (script, input, opts) =>
      /preswap-smoke|relaunch\.sh|curl|printenv/.test(script) ? remote.run(script, input, opts) : fileShell.run(script, input, opts),
  };
}

test("keys --apply runs the pre-swap smoke FIRST and aborts (live container untouched) when it fails", async () => {
  const { deps, manifestPath } = fixture({ manifest: BASE_MANIFEST, env: BASE_ENV });
  const fileShell = deps.shell;
  const remote = applyShell({ smokeCode: 1 });
  deps.applyCmd = "~/deploy/relaunch.sh";
  deps.smokeCmd = "~/deploy/preswap-smoke.sh";
  deps.shell = routeApply(fileShell, remote);

  await assert.rejects(() => keysNew(deps, "consumer-2", { apply: true }), /pre-swap smoke FAILED.*left untouched/s);
  assert.ok(remote.calls.some((c) => c.script.includes("preswap-smoke")), "smoke ran");
  assert.ok(!remote.calls.some((c) => c.script.includes("relaunch.sh")), "re-create NEVER ran after a failed smoke");
  // The mutation itself still landed (staged) — only the activation aborted.
  assert.ok(JSON.parse(readFileSync(manifestPath, "utf8")).some((e) => e.id === "consumer-2"), "change staged");
});

test("keys --apply aborts when the smoke TIMES OUT (code -1), never reaching the re-create", async () => {
  const { deps } = fixture({ manifest: BASE_MANIFEST, env: BASE_ENV });
  const fileShell = deps.shell;
  const remote = applyShell({ smokeCode: -1 }); // execCapture watchdog result for a hung smoke
  deps.applyCmd = "~/deploy/relaunch.sh";
  deps.smokeCmd = "~/deploy/preswap-smoke.sh";
  deps.shell = routeApply(fileShell, remote);

  await assert.rejects(() => keysNew(deps, "consumer-2", { apply: true }), /pre-swap smoke FAILED.*left untouched/s);
  assert.ok(!remote.calls.some((c) => c.script.includes("relaunch.sh")), "a timed-out smoke must NOT proceed to the re-create");
});

test("keys revoke --apply also gates the re-create on the pre-swap smoke", async () => {
  const { deps, keychain } = fixture({
    manifest: JSON.stringify([{ id: "consumer-1", allow: ["*"] }, { id: "consumer-2", allow: ["x.com"] }]),
    env: `${BASE_ENV}export ${tokenEnvKey("consumer-2")}=${"c".repeat(64)}\n`,
  });
  await keychain.set("consumer-2", "c".repeat(64));
  const fileShell = deps.shell;
  const remote = applyShell({ curlCodes: ["401"], envKeyPresent: false }); // revoke expects the token GONE
  deps.applyCmd = "~/deploy/relaunch.sh";
  deps.smokeCmd = "~/deploy/preswap-smoke.sh";
  deps.shell = routeApply(fileShell, remote);

  await keysRevoke(deps, "consumer-2", { apply: true });
  const smokeIdx = remote.calls.findIndex((c) => c.script.includes("preswap-smoke"));
  const recreateIdx = remote.calls.findIndex((c) => c.script.includes("relaunch.sh"));
  assert.ok(smokeIdx >= 0 && recreateIdx >= 0 && smokeIdx < recreateIdx, "smoke precedes the re-create on revoke too");
});

test("keys --apply runs the smoke BEFORE the re-create when it passes", async () => {
  const { deps } = fixture({ manifest: BASE_MANIFEST, env: BASE_ENV });
  const fileShell = deps.shell;
  const remote = applyShell({ curlCodes: ["401"], envKeyPresent: true });
  deps.applyCmd = "~/deploy/relaunch.sh";
  deps.smokeCmd = "~/deploy/preswap-smoke.sh";
  deps.shell = routeApply(fileShell, remote);

  await keysNew(deps, "consumer-2", { apply: true });
  const smokeIdx = remote.calls.findIndex((c) => c.script.includes("preswap-smoke"));
  const recreateIdx = remote.calls.findIndex((c) => c.script.includes("relaunch.sh"));
  assert.ok(smokeIdx >= 0, "smoke ran");
  assert.ok(recreateIdx >= 0, "re-create ran");
  assert.ok(smokeIdx < recreateIdx, "smoke precedes the re-create");
});

test("keys --apply refuses without smokeCmd BEFORE anything is staged (new and revoke)", async () => {
  // VIL-133: the smoke's boot check is the one authority on whether the staged config boots.
  const newer = fixture({ manifest: BASE_MANIFEST, env: BASE_ENV });
  newer.deps.applyCmd = "~/deploy/relaunch.sh"; // no smokeCmd
  await assert.rejects(() => keysNew(newer.deps, "consumer-2", { apply: true }), /needs the `smokeCmd` config key.*Nothing was staged/s);
  assert.equal(readFileSync(newer.manifestPath, "utf8"), BASE_MANIFEST, "manifest untouched");
  assert.equal(readFileSync(newer.envFilePath, "utf8"), BASE_ENV, "env file untouched");
  assert.equal(newer.keychain.items.size, 0, "no token minted");

  const rev = fixture({ manifest: BASE_MANIFEST, env: BASE_ENV });
  rev.deps.applyCmd = "~/deploy/relaunch.sh";
  await assert.rejects(() => keysRevoke(rev.deps, "consumer-1", { apply: true }), /needs the `smokeCmd` config key/);
  assert.equal(readFileSync(rev.manifestPath, "utf8"), BASE_MANIFEST, "revoke staged nothing either");
  assert.equal(readFileSync(rev.envFilePath, "utf8"), BASE_ENV);
});

test("keys new --apply runs applyCmd, waits for 401, and confirms the token is ACTIVE in the container", async () => {
  const { deps, lines } = fixture({ manifest: BASE_MANIFEST, env: BASE_ENV });
  const fileShell = deps.shell; // keep real file ops for the staged writes
  const remote = applyShell({ curlCodes: ["000", "000", "401"], envKeyPresent: true });
  deps.applyCmd = "~/deploy/relaunch.sh";
  deps.smokeCmd = "~/deploy/preswap-smoke.sh";
  deps.shell = routeApply(fileShell, remote);
  await keysNew(deps, "consumer-2", { apply: true });

  const applyCall = remote.calls.find((c) => c.script.includes("relaunch.sh"));
  assert.ok(applyCall, "applyCmd invoked over the shell");
  assert.ok(applyCall.script.includes("DOCKER_HOST"), "rootless socket defaulted for the re-create");
  assert.ok(remote.calls.some((c) => c.script.includes("printenv BGW_CONSUMER_TOKEN_CONSUMER_2")), "activation checked in-container");
  assert.ok(lines.some((l) => l.includes("healthy after re-create") && l.includes("active")));
});

test("keys --apply refuses without applyCmd (docker restart cannot activate env changes), before staging", async () => {
  const { deps, manifestPath } = fixture({ manifest: BASE_MANIFEST, env: BASE_ENV });
  deps.smokeCmd = "~/deploy/preswap-smoke.sh";
  await assert.rejects(() => keysNew(deps, "consumer-2", { apply: true }), /applyCmd.*OBSCURA_APPLY_CMD.*docker restart.*Nothing was staged/s);
  assert.equal(readFileSync(manifestPath, "utf8"), BASE_MANIFEST, "nothing staged");
});

test("keys new --apply fails loudly when the re-created container lacks the new token", async () => {
  const { deps } = fixture({ manifest: BASE_MANIFEST, env: BASE_ENV });
  const fileShell = deps.shell;
  const remote = applyShell({ curlCodes: ["401"], envKeyPresent: false });
  deps.applyCmd = "~/deploy/relaunch.sh";
  deps.smokeCmd = "~/deploy/preswap-smoke.sh";
  deps.shell = routeApply(fileShell, remote);
  await assert.rejects(() => keysNew(deps, "consumer-2", { apply: true }), /NOT in the container env.*did not re-read/s);
});

test("keys --apply times out when the gateway never answers 401 after the re-create", async () => {
  const { deps } = fixture({ manifest: BASE_MANIFEST, env: BASE_ENV });
  const fileShell = deps.shell;
  const remote = applyShell({ curlCodes: ["000"] });
  deps.applyCmd = "~/deploy/relaunch.sh";
  deps.smokeCmd = "~/deploy/preswap-smoke.sh";
  deps.applyTimeoutMs = 20;
  deps.shell = routeApply(fileShell, remote);
  await assert.rejects(() => keysNew(deps, "consumer-2", { apply: true }), /did not come back healthy/);
});

test("shQuote survives hostile values through a real shell", async () => {
  const shell = localShell();
  const hostile = `a'b"$(boom) \`tick\``;
  const r = await shell.run(`printf '%s' ${shQuote(hostile)}`);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, hostile);
});

test("execCapture watchdog: a hung child resolves code -1 instead of hanging the CLI", async () => {
  const r = await execCapture("sleep", ["5"], { timeoutMs: 100 });
  assert.equal(r.code, -1);
  assert.match(r.stderr, /timed out after 100ms/);
});

test("readRemoteFile distinguishes missing from empty", async () => {
  const { deps, envFilePath } = fixture({ env: "" });
  assert.equal(await readRemoteFile(deps.shell, envFilePath), "");
  assert.equal(await readRemoteFile(deps.shell, join(tmpdir(), "obscura-definitely-absent")), null);
});

// --- VIL-133: the pool-floor pre-flight -------------------------------------------------------------

test("keys new REFUSES a consumer that would breach the pool floor, before writing anything", async () => {
  // Genuinely AT the floor: 2 consumers × perConsumerMax 1 + 1 = 3 = BGW_MAX_SESSIONS. A third needs 4.
  const manifest = JSON.stringify([{ id: "c1", allow: ["*"] }, { id: "c2", allow: ["*"] }], null, 2);
  const env = `export BGW_MAX_SESSIONS=3\nexport BGW_PER_CONSUMER_MAX=1\nexport ${tokenEnvKey("c1")}=${"a".repeat(64)}\nexport ${tokenEnvKey("c2")}=${"b".repeat(64)}\n`;
  for (const apply of [false, true]) {
    const { deps, keychain, manifestPath, envFilePath } = fixture({ manifest, env });
    const remote = applyShell();
    deps.applyCmd = "~/deploy/relaunch.sh";
    deps.smokeCmd = "~/deploy/preswap-smoke.sh";
    deps.shell = routeApply(deps.shell, remote);
    await assert.rejects(
      () => keysNew(deps, "c3", { apply }),
      (err) => {
        assert.match(err.message, /BGW_MAX_SESSIONS=3 is too low for 3 consumer\(s\): need >= 4/);
        assert.match(err.message, /raise BGW_MAX_SESSIONS to at least 4/);
        assert.match(err.message, /keys revoke <id> --apply/);
        assert.match(err.message, /Nothing was staged/);
        return true;
      },
    );
    assert.equal(readFileSync(manifestPath, "utf8"), manifest, `manifest untouched (apply=${apply})`);
    assert.equal(readFileSync(envFilePath, "utf8"), env, `env file untouched (apply=${apply})`);
    assert.equal(keychain.items.size, 0, "no token minted into the keychain");
    assert.deepEqual(remote.calls, [], "no smoke, no re-create, no probe — the live container is never touched");
  }
});

test("keys new is allowed when the new consumer still fits — exactly at the floor", async () => {
  const env = `export BGW_MAX_SESSIONS=3\nexport BGW_PER_CONSUMER_MAX=1\nexport ${tokenEnvKey("consumer-1")}=${"a".repeat(64)}\n`;
  const { deps, manifestPath } = fixture({ manifest: BASE_MANIFEST, env });
  await keysNew(deps, "consumer-2"); // 2 × 1 + 1 = 3 ≤ 3
  assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).length, 2);
});

const BOTH = "BGW_MAX_SESSIONS=8\nBGW_PER_CONSUMER_MAX=1\n";
const { INHERITED } = await import("../dist/cli/keys.js");

/** The raw sizing values bash gives the launcher for `envText`, through the real resolver over a real shell. */
async function sizingOf(envText) {
  const { resolveEnvSizing } = await import("../dist/cli/keys.js");
  const dir = mkdtempSync(join(tmpdir(), "obscura-sizing-"));
  const path = join(dir, "prod.env");
  writeFileSync(path, envText);
  try {
    return await resolveEnvSizing(localShell(), path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
async function preflight(consumers, envText) {
  const { poolFloorPreflight } = await import("../dist/cli/keys.js");
  return poolFloorPreflight(consumers, await sizingOf(envText));
}

/** Run `fn` with `vars` set in this process's environment, restoring every prior value (or absence) after
 *  (MergeWren on #157: the old cleanup deleted a variable that was set before the test). */
async function withEnv(vars, fn) {
  const prior = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("the pre-flight sees what bash gives the launcher: last assignment wins, quotes and export are bash's", async () => {
  assert.deepEqual(await sizingOf("BGW_MAX_SESSIONS=4\nexport BGW_MAX_SESSIONS='6'\nBGW_PER_CONSUMER_MAX=\"2\"\n"), { maxSessions: "6", perConsumerMax: "2" });
  assert.deepEqual(await sizingOf("XBGW_MAX_SESSIONS=9\n"), { maxSessions: INHERITED, perConsumerMax: INHERITED }, "a longer name is not a match");
  // perConsumerMax multiplies the floor exactly as the boot check does.
  const r = await preflight(3, "BGW_MAX_SESSIONS=6\nBGW_PER_CONSUMER_MAX=2\n");
  assert.equal(r.kind, "refuse");
  assert.match(r.message, /need >= 7/);
});

test("like the launcher, the evaluation inherits its shell's environment", async () => {
  // MergeWren on #157: a cleared environment disagrees with launch-http.sh, which inherits its caller's.
  await withEnv({ BGW_TEST_CAP: "3" }, async () => {
    assert.deepEqual(await sizingOf("BGW_MAX_SESSIONS=8\nBGW_PER_CONSUMER_MAX=${BGW_TEST_CAP:-7}\n"), { maxSessions: "8", perConsumerMax: "3" });
  });
});

test("the file runs unmodified: one that branches on a sizing variable takes the launcher's branch", async () => {
  // MergeWren on #157: presetting the variables made this take the `2` branch and falsely refuse.
  const env = '[ -n "${BGW_MAX_SESSIONS+x}" ] && BGW_MAX_SESSIONS=2 || BGW_MAX_SESSIONS=8\nBGW_PER_CONSUMER_MAX=${BGW_PER_CONSUMER_MAX:-1}\n';
  assert.deepEqual(await sizingOf(env), { maxSessions: "8", perConsumerMax: "1" });
  assert.deepEqual(await preflight(2, env), { kind: "ok" });
});

test("a sizing variable already in this shell's environment makes the check unchecked, named, never a refusal", async () => {
  await withEnv({ BGW_MAX_SESSIONS: "3" }, async () => {
    const r = await preflight(9, BOTH);
    assert.equal(r.kind, "unchecked");
    assert.match(r.message, /environment already sets BGW_MAX_SESSIONS,/);
    assert.match(r.message, /boot check decides/);
  });
  await withEnv({ BGW_MAX_SESSIONS: "3", BGW_PER_CONSUMER_MAX: "1" }, async () => {
    assert.match((await preflight(9, BOTH)).message, /sets BGW_MAX_SESSIONS and BGW_PER_CONSUMER_MAX,/);
  });
});

test("a sizing variable the file leaves unset never drives a refusal: unchecked, named", async () => {
  for (const [env, names] of [
    ["", /BGW_MAX_SESSIONS and BGW_PER_CONSUMER_MAX/],
    ["BGW_PER_CONSUMER_MAX=1\n", /leaves BGW_MAX_SESSIONS to the environment/],
    [`${BOTH}unset BGW_PER_CONSUMER_MAX\n`, /leaves BGW_PER_CONSUMER_MAX to the environment/],
  ]) {
    const r = await preflight(9, env);
    assert.equal(r.kind, "unchecked", env);
    assert.match(r.message, names, env);
    assert.match(r.message, /boot check decides/, env);
  }
});

test("the env file is sourced exactly once per pre-flight", async () => {
  // MergeWren on #157: the file is executed, so it must not run twice.
  const { resolveEnvSizing } = await import("../dist/cli/keys.js");
  const dir = mkdtempSync(join(tmpdir(), "obscura-once-"));
  const marker = join(dir, "runs");
  const path = join(dir, "prod.env");
  writeFileSync(path, `${BOTH}echo x >> '${marker}'\n`);
  try {
    await resolveEnvSizing(localShell(), path);
    assert.equal(readFileSync(marker, "utf8"), "x\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- CodeRabbit + MergeWren #157: every bash rule a hand-written reader missed, now settled by bash ------

test("an inline comment is dropped as bash drops it — the exact understated-floor scenario is refused", async () => {
  // bash gives the gateway perConsumerMax=2, so 2 consumers need 2×2+1 = 5 sessions, not the 3 a
  // comment-blind reader (falling back to perConsumerMax 1) would compute.
  const r = await preflight(2, "export BGW_MAX_SESSIONS=3\nexport BGW_PER_CONSUMER_MAX=2 # capacity\n");
  assert.equal(r.kind, "refuse");
  assert.match(r.message, /need >= 5/);
});

for (const [label, env, expected] of [
  ["a quoted # is not a comment; the unset after it runs", `${BOTH}X="a # b"; unset BGW_MAX_SESSIONS\n`, { maxSessions: INHERITED, perConsumerMax: "1" }],
  ["an escaped space keeps the # in the word; the unset after it runs", `${BOTH}X=a\\ #b; unset BGW_MAX_SESSIONS\n`, { maxSessions: INHERITED, perConsumerMax: "1" }],
  ["a ; separator starts a comment, so a mention after ;# is not a command", `${BOTH}X=1;# unset BGW_MAX_SESSIONS\n`, { maxSessions: "8", perConsumerMax: "1" }],
  ["an assignment in a branch that never runs does not count", `${BOTH}if false; then BGW_MAX_SESSIONS=99; fi\n`, { maxSessions: "8", perConsumerMax: "1" }],
  ["+= appends, as bash does", `${BOTH}BGW_MAX_SESSIONS+=0\n`, { maxSessions: "80", perConsumerMax: "1" }],
  ["a quoted value spanning lines is followed", `${BOTH}X="a\n# "; unset BGW_MAX_SESSIONS\n`, { maxSessions: INHERITED, perConsumerMax: "1" }],
  ["a trailing comment naming a sizing variable is only a comment", `${BOTH}OTHER=1 # see BGW_PER_CONSUMER_MAX\n`, { maxSessions: "8", perConsumerMax: "1" }],
  ["command substitution is evaluated as the launcher would", "BGW_MAX_SESSIONS=$(echo 5)\nBGW_PER_CONSUMER_MAX=1\n", { maxSessions: "5", perConsumerMax: "1" }],
  ["export -n still leaves a shell variable, which the launcher forwards", `${BOTH}export -n BGW_MAX_SESSIONS\n`, { maxSessions: "8", perConsumerMax: "1" }],
]) {
  test(`bash semantics: ${label}`, async () => {
    assert.deepEqual(await sizingOf(env), expected);
  });
}

test("an invalid value the file sets takes the boot default, exactly as boot does", async () => {
  // MergeWren on #157 (f7c3ac5#2): mirror boot's defaults rather than refusing on the value alone.
  for (const env of ["BGW_MAX_SESSIONS=lots\nBGW_PER_CONSUMER_MAX=1\n", "BGW_MAX_SESSIONS=8#c\nBGW_PER_CONSUMER_MAX=1\n", "BGW_MAX_SESSIONS=0\nBGW_PER_CONSUMER_MAX=1\n"]) {
    assert.deepEqual(await preflight(1, env), { kind: "ok" }, `default 2 fits one consumer: ${env}`);
    const r = await preflight(2, env);
    assert.equal(r.kind, "refuse", env);
    assert.match(r.message, /BGW_MAX_SESSIONS=2 is too low for 2 consumer\(s\): need >= 3/, env);
  }
  // An invalid perConsumerMax falls back to 1, as boot does.
  assert.deepEqual(await preflight(7, "BGW_MAX_SESSIONS=8\nBGW_PER_CONSUMER_MAX=0\n"), { kind: "ok" });
});

test("values the boot parser accepts are accepted (leading zeros), exactly at the floor", async () => {
  assert.deepEqual(await preflight(2, "BGW_MAX_SESSIONS=03\nBGW_PER_CONSUMER_MAX=01\n"), { kind: "ok" });
  assert.match((await preflight(3, "BGW_MAX_SESSIONS=03\nBGW_PER_CONSUMER_MAX=01\n")).message, /need >= 4/);
});

for (const [label, env] of [
  ["an unset expansion (set -u)", "BGW_MAX_SESSIONS=$BGW_TEST_UNDEFINED_CAP\nBGW_PER_CONSUMER_MAX=1\n"],
  ["a sourced file that does not exist", `${BOTH}. /nonexistent/extra.env\n`],
  ["a file that exits early", `${BOTH}exit 0\n`],
]) {
  test(`a file the pre-flight cannot evaluate is left to the boot check, not refused: ${label}`, async () => {
    const r = await preflight(1, env);
    assert.equal(r.kind, "unchecked");
    assert.match(r.message, /could not check the pool floor/);
    assert.match(r.message, /boot check decides at the next pre-swap smoke/);
  });
}

test("keys new stages with a warning when the env file cannot be evaluated (no --apply)", async () => {
  const env = `export ${tokenEnvKey("consumer-1")}=${"a".repeat(64)}\nexport BGW_MAX_SESSIONS=$BGW_TEST_UNDEFINED_CAP\n`;
  const { deps, manifestPath, lines } = fixture({ manifest: BASE_MANIFEST, env });
  await keysNew(deps, "consumer-2");
  assert.ok(lines.some((l) => l.includes("could not check the pool floor")), "the operator is told");
  assert.ok(JSON.parse(readFileSync(manifestPath, "utf8")).some((e) => e.id === "consumer-2"), "staged");
});

test("keys new --apply with an unevaluable env file still smokes before any re-create, and the smoke decides", async () => {
  const env = `export ${tokenEnvKey("consumer-1")}=${"a".repeat(64)}\nexport BGW_MAX_SESSIONS=$BGW_TEST_UNDEFINED_CAP\n`;
  const { deps } = fixture({ manifest: BASE_MANIFEST, env });
  const remote = applyShell({ smokeCode: 1 });
  deps.applyCmd = "~/deploy/relaunch.sh";
  deps.smokeCmd = "~/deploy/preswap-smoke.sh";
  deps.shell = routeApply(deps.shell, remote);
  await assert.rejects(() => keysNew(deps, "consumer-2", { apply: true }), /pre-swap smoke FAILED/);
  assert.ok(!remote.calls.some((c) => c.script.includes("relaunch.sh")), "the live container was never re-created");
});
