/**
 * Obscura keys lifecycle tests (U3) — `new`/`list`/`revoke` against a REAL local `sh` shell
 * (the admin-SSH transport's loopback fake) and a temp-dir manifest/env pair, plus an in-memory
 * keychain. Real SSH is deferred to manual verification; everything else is the genuine article:
 * the same scripts, atomic-write paths, and file modes that will run on prod.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync } from "node:fs";
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
const BASE_ENV = `export ${tokenEnvKey("consumer-1")}=${"a".repeat(64)}\n`;

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

test("keys --apply without smokeCmd warns about the missing gate but still applies", async () => {
  const { deps, lines } = fixture({ manifest: BASE_MANIFEST, env: BASE_ENV });
  const fileShell = deps.shell;
  const remote = applyShell({ curlCodes: ["401"], envKeyPresent: true });
  deps.applyCmd = "~/deploy/relaunch.sh"; // no smokeCmd
  deps.shell = routeApply(fileShell, remote);

  await keysNew(deps, "consumer-2", { apply: true });
  assert.ok(lines.some((l) => l.includes("WITHOUT a pre-swap smoke")), "warns about the missing smoke gate");
  assert.ok(!remote.calls.some((c) => c.script.includes("preswap-smoke")), "no smoke attempted when unconfigured");
  assert.ok(remote.calls.some((c) => c.script.includes("relaunch.sh")), "still re-creates");
});

test("keys new --apply runs applyCmd, waits for 401, and confirms the token is ACTIVE in the container", async () => {
  const { deps, lines } = fixture({ manifest: BASE_MANIFEST, env: BASE_ENV });
  const fileShell = deps.shell; // keep real file ops for the staged writes
  const remote = applyShell({ curlCodes: ["000", "000", "401"], envKeyPresent: true });
  deps.applyCmd = "~/deploy/relaunch.sh";
  deps.shell = {
    run: (script, input, opts) =>
      script.includes("curl") || script.includes("printenv") || script.includes("relaunch.sh")
        ? remote.run(script, input, opts)
        : fileShell.run(script, input, opts),
  };
  await keysNew(deps, "consumer-2", { apply: true });

  const applyCall = remote.calls.find((c) => c.script.includes("relaunch.sh"));
  assert.ok(applyCall, "applyCmd invoked over the shell");
  assert.ok(applyCall.script.includes("DOCKER_HOST"), "rootless socket defaulted for the re-create");
  assert.ok(remote.calls.some((c) => c.script.includes("printenv BGW_CONSUMER_TOKEN_CONSUMER_2")), "activation checked in-container");
  assert.ok(lines.some((l) => l.includes("healthy after re-create") && l.includes("active")));
});

test("keys --apply refuses without applyCmd (docker restart cannot activate env changes)", async () => {
  const { deps, manifestPath } = fixture({ manifest: BASE_MANIFEST, env: BASE_ENV });
  await assert.rejects(() => keysNew(deps, "consumer-2", { apply: true }), /applyCmd.*OBSCURA_APPLY_CMD.*docker restart/s);
  // The mutation itself still landed (staged) — only the apply step refused.
  assert.ok(JSON.parse(readFileSync(manifestPath, "utf8")).some((e) => e.id === "consumer-2"), "change staged");
});

test("keys new --apply fails loudly when the re-created container lacks the new token", async () => {
  const { deps } = fixture({ manifest: BASE_MANIFEST, env: BASE_ENV });
  const fileShell = deps.shell;
  const remote = applyShell({ curlCodes: ["401"], envKeyPresent: false });
  deps.applyCmd = "~/deploy/relaunch.sh";
  deps.shell = {
    run: (script, input, opts) =>
      script.includes("curl") || script.includes("printenv") || script.includes("relaunch.sh")
        ? remote.run(script, input, opts)
        : fileShell.run(script, input, opts),
  };
  await assert.rejects(() => keysNew(deps, "consumer-2", { apply: true }), /NOT in the container env.*did not re-read/s);
});

test("keys --apply times out when the gateway never answers 401 after the re-create", async () => {
  const { deps } = fixture({ manifest: BASE_MANIFEST, env: BASE_ENV });
  const fileShell = deps.shell;
  const remote = applyShell({ curlCodes: ["000"] });
  deps.applyCmd = "~/deploy/relaunch.sh";
  deps.applyTimeoutMs = 20;
  deps.shell = {
    run: (script, input, opts) =>
      script.includes("curl") || script.includes("relaunch.sh") ? remote.run(script, input, opts) : fileShell.run(script, input, opts),
  };
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
