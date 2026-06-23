/**
 * Obscura tunnel automation tests (U4) — the pure artifact generators (keeper/plist/ssh alias),
 * the state classifiers fed sample launchctl/lsof output, and ensure()'s idempotency against a
 * temp home. Actual launchctl/ssh side effects are deferred to manual verification; the exec
 * boundary is faked with canned results.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import {
  tunnelSpec,
  keeperScript,
  launchAgentPlist,
  sshConfigBlock,
  authorizedKeysLine,
  classifyAgentState,
  classifyPortOwner,
  parsePortListeners,
  sshDestination,
  tunnelState,
  ensureTunnel,
  SELF_DISABLE_MARKER,
} from "../dist/cli/index.js";

const HOSTNAME = "prod-host.example"; // placeholder fleet value — comes from local config in real use

function makeSpec(home = mkdtempSync(join(tmpdir(), "obscura-tunnel-"))) {
  return tunnelSpec({ alias: "browse-gateway-tunnel", hostName: HOSTNAME, home });
}

/** A fake exec that returns canned results per command and records every call. */
function fakeExec(results = {}) {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const result = typeof results[cmd] === "function" ? results[cmd](args) : results[cmd];
    return result ?? { code: 0, stdout: "", stderr: "" };
  };
  exec.calls = calls;
  return exec;
}

test("generated keeper passes sh -n, self-disables, and re-enables with the right command", () => {
  const spec = makeSpec();
  const keeper = keeperScript(spec);

  const path = join(spec.home, "keeper-under-test.sh");
  writeFileSync(path, keeper);
  execFileSync("sh", ["-n", path]); // throws on any syntax error

  assert.ok(keeper.includes(SELF_DISABLE_MARKER), "self-disable branch present");
  assert.ok(keeper.includes("MAX_FAILS=10"), "10-fast-fail valve preserved");
  assert.ok(keeper.includes("GRACE=30"), "30s establishment grace preserved");
  assert.ok(keeper.includes(`launchctl bootout "gui/$(id -u)/\${LABEL}"`), "boots ITSELF out");
  assert.ok(keeper.includes(`launchctl bootstrap gui/$(id -u) \\"$PLIST\\"`), "re-enable instruction in the log");
  assert.ok(keeper.includes("-L 8080:127.0.0.1:8080"), "local port 8080 (KTD5) forwarding to the gateway");
  assert.ok(keeper.includes('ALIAS="browse-gateway-tunnel"'), "uses the configured alias");
  rmSync(spec.home, { recursive: true, force: true });
});

test("generated plist parses and carries KeepAlive/RunAtLoad/ThrottleInterval + the keeper", () => {
  const spec = makeSpec();
  const plist = launchAgentPlist(spec);

  if (process.platform === "darwin") {
    const path = join(spec.home, "agent-under-test.plist");
    writeFileSync(path, plist);
    execFileSync("plutil", ["-lint", path]); // throws when the plist doesn't parse
  }
  assert.ok(plist.includes("<key>KeepAlive</key>"));
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
  assert.ok(plist.includes(`<string>${spec.keeperPath}</string>`), "runs the keeper, not ssh directly");
  assert.ok(plist.includes(`<string>${spec.label}</string>`));
  rmSync(spec.home, { recursive: true, force: true });
});

test("generated ssh alias is the hardened forward-only block, host from config only", () => {
  const spec = makeSpec();
  const block = sshConfigBlock(spec);

  assert.ok(block.includes("User bgwtunnel"), "restricted non-root user");
  assert.ok(block.includes("IdentitiesOnly yes"));
  assert.ok(block.includes(`IdentityFile ${spec.keyPath}`), "dedicated key");
  for (const opt of ["BatchMode yes", "ExitOnForwardFailure yes", "ServerAliveInterval 15", "ConnectTimeout 10"]) {
    assert.ok(block.includes(opt), `carries ${opt}`);
  }
  assert.ok(block.includes(`HostName ${HOSTNAME}`), "HostName comes from the spec (config)");

  // The committed generator must not bake in any HostName literal: a different config value
  // flows straight through.
  const other = tunnelSpec({ alias: "t", hostName: "other-host.example", home: spec.home });
  assert.ok(sshConfigBlock(other).includes("HostName other-host.example"));
  rmSync(spec.home, { recursive: true, force: true });
});

test("authorizedKeysLine pins the key to forward-only on exactly the gateway port", () => {
  const spec = makeSpec();
  const line = authorizedKeysLine(spec, "ssh-ed25519 AAAA... obscura\n");
  assert.equal(line, 'restrict,port-forwarding,permitopen="127.0.0.1:8080" ssh-ed25519 AAAA... obscura');
  rmSync(spec.home, { recursive: true, force: true });
});

test("classifyAgentState: running / stopped / self-disabled / not-bootstrapped", () => {
  const running = "system info:\n\tstate = running\n\tpid = 4242\n\truns = 7\n";
  assert.equal(classifyAgentState(running, ""), "running");

  const stopped = "system info:\n\tstate = waiting\n\truns = 7\n";
  assert.equal(classifyAgentState(stopped, ""), "stopped");

  const disabledLog = `12:00 tunnel died in 1s (rc=255) — fast-fail 10/10\n12:00 *** 10 consecutive fast failures — ${SELF_DISABLE_MARKER} the tunnel LaunchAgent. ***\n`;
  assert.equal(classifyAgentState(null, disabledLog), "self-disabled");

  assert.equal(classifyAgentState(null, ""), "not-bootstrapped");
  assert.equal(classifyAgentState(null, "12:00 tunnel up 3600s then exited (rc=0)\n"), "not-bootstrapped");

  // An OLD self-disable buried beyond the recent tail does not mask a deliberate stop.
  const oldMarker = `${disabledLog}${Array.from({ length: 25 }, (_, i) => `12:0${i % 10} tunnel up 3600s then exited (rc=0)`).join("\n")}\n`;
  assert.equal(classifyAgentState(null, oldMarker), "not-bootstrapped");
});

test("parsePortListeners extracts (command, pid), dropping header/blank lines", () => {
  const out =
    "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nssh 123 user 5u IPv4 0x0 0t0 TCP 127.0.0.1:8080 (LISTEN)\nssh 123 user 6u IPv6 0x0 0t0 TCP [::1]:8080 (LISTEN)\n";
  assert.deepEqual(parsePortListeners(out), [
    { command: "ssh", pid: "123" },
    { command: "ssh", pid: "123" },
  ]);
  assert.deepEqual(parsePortListeners(null), []);
  assert.deepEqual(parsePortListeners("COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n"), []);
});

test("classifyPortOwner: provenance (UID + keeper ancestry) + the keeper's argv shape", () => {
  const spec = makeSpec();
  const MYUID = 501;
  // Build a listener; defaults are OUR provenance (current uid, parent = our keeper), overridable.
  const mk = (argv, o = {}) => ({
    command: o.command ?? "ssh",
    pid: o.pid ?? "1",
    uid: "uid" in o ? o.uid : MYUID,
    argv,
    parentCommand: "parentCommand" in o ? o.parentCommand : `/bin/sh ${spec.keeperPath}`,
  });
  const good = "/usr/bin/ssh -N -T -L 8080:127.0.0.1:8080 browse-gateway-tunnel";

  // Our real keeper invocation, owned by us, descending from our keeper.
  assert.equal(classifyPortOwner([mk(good)], spec, MYUID), "ours");

  // PROVENANCE (P1, PR #26 3rd review): a FOREIGN local account runs the EXACT allowlisted argv with
  // its OWN ~/.ssh/config (alias → attacker). argv shape matches, but the UID does not → foreign.
  assert.equal(classifyPortOwner([mk(good, { uid: MYUID + 1 })], spec, MYUID), "foreign");
  // Same user, right argv, but NOT descended from our keeper (clean config, foreign parent) → foreign.
  assert.equal(classifyPortOwner([mk(good, { parentCommand: "/bin/sh /tmp/evil.sh" })], spec, MYUID), "foreign");
  assert.equal(classifyPortOwner([mk(good, { parentCommand: null })], spec, MYUID), "foreign");

  // argv-shape defenses (still enforced on top of provenance).
  assert.equal(classifyPortOwner([mk("/usr/bin/ssh -N -L 8080:10.0.0.5:5432 someone@otherhost")], spec, MYUID), "foreign");
  assert.equal(classifyPortOwner([mk("/usr/bin/ssh -N -L 8080:127.0.0.1:8080 -o UserKnownHostsFile=/home/x/browse-gateway-tunnel.hosts evil@h")], spec, MYUID), "foreign"); // alias as substring
  assert.equal(classifyPortOwner([mk("ssh -N -l browse-gateway-tunnel -L 8080:127.0.0.1:8080 attacker@elsewhere")], spec, MYUID), "foreign"); // alias as -l value
  assert.equal(classifyPortOwner([mk("ssh -N -T -o HostName=attacker.example -L 8080:127.0.0.1:8080 browse-gateway-tunnel")], spec, MYUID), "foreign"); // -o HostName
  assert.equal(classifyPortOwner([mk("ssh -N -T -F /tmp/evil.conf -L 8080:127.0.0.1:8080 browse-gateway-tunnel")], spec, MYUID), "foreign"); // -F
  assert.equal(classifyPortOwner([mk("ssh -N -T -J attacker@jump -L 8080:127.0.0.1:8080 browse-gateway-tunnel")], spec, MYUID), "foreign"); // -J

  // gatewayHost DRIFT (F3): our own keeper still forwards the OLD target after a config change → ours.
  assert.equal(classifyPortOwner([mk("/usr/bin/ssh -N -T -L 8080:127.0.0.1:9090 browse-gateway-tunnel")], spec, MYUID), "ours");
  // Combined `-L8080:...` form (no space).
  assert.equal(classifyPortOwner([mk("ssh -N -L8080:127.0.0.1:8080 browse-gateway-tunnel")], spec, MYUID), "ours");

  // Non-ssh binder; unresolvable argv → fail closed.
  assert.equal(classifyPortOwner([mk("node server.js", { command: "node" })], spec, MYUID), "foreign");
  assert.equal(classifyPortOwner([mk(null)], spec, MYUID), "foreign");
  // Mixed: one ours + one foreign → foreign.
  assert.equal(classifyPortOwner([mk(good), mk("node x", { command: "node" })], spec, MYUID), "foreign");
  // Nothing listening.
  assert.equal(classifyPortOwner([], spec, MYUID), "none");
  assert.equal(classifyPortOwner(null, spec, MYUID), "none");
  rmSync(spec.home, { recursive: true, force: true });
});

test("sshDestination locates the host operand, not an option value", () => {
  const dest = (cmd) => sshDestination(cmd.split(/\s+/));
  // Our keeper's shape.
  assert.equal(dest("/usr/bin/ssh -N -T -L 8080:127.0.0.1:8080 browse-gateway-tunnel"), "browse-gateway-tunnel");
  // Value-taking options must not be mistaken for the destination.
  assert.equal(dest("ssh -N -l browse-gateway-tunnel -L 8080:127.0.0.1:8080 attacker@elsewhere"), "attacker@elsewhere");
  assert.equal(dest("ssh -i browse-gateway-tunnel -L 8080:1 host"), "host");
  assert.equal(dest("ssh -o User=browse-gateway-tunnel -p 22 realhost"), "realhost");
  // Attached value + bundled no-arg flags.
  assert.equal(dest("ssh -NT -L8080:127.0.0.1:8080 alias"), "alias");
  // End-of-options marker.
  assert.equal(dest("ssh -N -- some-host"), "some-host");
  // No operand → null (fail closed at the caller).
  assert.equal(dest("ssh -N -L 8080:127.0.0.1:8080"), null);
});

// ps fake covering both call shapes: the `uid=,ppid=,command=` lookup and the parent `command=` lookup.
function psFake(spec, { uid, ppid = "4240", argv, parent }) {
  return (args) =>
    args.join(" ").includes("uid=,ppid=,command=")
      ? { code: 0, stdout: `${uid} ${ppid} ${argv}\n`, stderr: "" }
      : { code: 0, stdout: `${parent ?? `/bin/sh ${spec.keeperPath}`}\n`, stderr: "" };
}

test("tunnelState: our own keeper listener (UID + parent + argv) is ours", async () => {
  const spec = makeSpec();
  const myUid = process.getuid?.() ?? 0;
  const exec = fakeExec({
    launchctl: { code: 0, stdout: "state = running\npid = 5\n", stderr: "" },
    lsof: { code: 0, stdout: "COMMAND PID USER\nssh 4242 me 5u IPv4 TCP 127.0.0.1:8080 (LISTEN)\n", stderr: "" },
    ps: psFake(spec, { uid: myUid, argv: "/usr/bin/ssh -N -T -L 8080:127.0.0.1:8080 browse-gateway-tunnel" }),
  });
  const state = await tunnelState(spec, exec);
  assert.equal(state.port, "ours");
  assert.ok(exec.calls.some((c) => c[0] === "ps" && c.includes("4242")), "ps resolved the listening pid");
  rmSync(spec.home, { recursive: true, force: true });
});

test("tunnelState: a FOREIGN-owned listener running the EXACT keeper argv is NOT ours (P1 provenance)", async () => {
  const spec = makeSpec();
  const foreignUid = (process.getuid?.() ?? 0) + 1;
  const exec = fakeExec({
    launchctl: { code: 0, stdout: "state = running\npid = 5\n", stderr: "" },
    // lsof shows a foreign USER squatting on 8080; the argv is byte-for-byte our keeper's.
    lsof: { code: 0, stdout: "COMMAND PID USER\nssh 4242 attacker 5u IPv4 TCP 127.0.0.1:8080 (LISTEN)\n", stderr: "" },
    ps: psFake(spec, { uid: foreignUid, argv: "/usr/bin/ssh -N -T -L 8080:127.0.0.1:8080 browse-gateway-tunnel" }),
  });
  const state = await tunnelState(spec, exec);
  assert.equal(state.port, "foreign", "exact keeper argv but a foreign UID must NOT be ours — or connect leaks the token");
  rmSync(spec.home, { recursive: true, force: true });
});

test("tunnelState surfaces the keeper-log reason when self-disabled", async () => {
  const spec = makeSpec();
  mkdirSync(dirname(spec.logPath), { recursive: true });
  writeFileSync(
    spec.logPath,
    `12:00 tunnel died in 1s (rc=255) — fast-fail 10/10\n12:00 *** 10 consecutive fast failures — ${SELF_DISABLE_MARKER} the tunnel LaunchAgent. ***\n    Likely cause: prod VPS gone/replaced...\n`,
  );
  const exec = fakeExec({
    launchctl: { code: 113, stdout: "", stderr: "Could not find service" },
    lsof: { code: 1, stdout: "", stderr: "" },
  });
  const state = await tunnelState(spec, exec);
  assert.equal(state.agent, "self-disabled");
  assert.equal(state.port, "none");
  assert.ok(state.selfDisableReason.includes("Likely cause"), "reason carries the keeper's why");
  rmSync(spec.home, { recursive: true, force: true });
});

test("ensureTunnel creates all artifacts from nothing and bootstraps", async () => {
  const spec = makeSpec();
  const exec = fakeExec({
    "ssh-keygen": (args) => {
      // Simulate keygen: write both halves where -f points.
      const f = args[args.indexOf("-f") + 1];
      writeFileSync(f, "PRIVATE");
      writeFileSync(`${f}.pub`, "ssh-ed25519 AAAATEST obscura-browse-gateway-tunnel\n");
      return { code: 0, stdout: "", stderr: "" };
    },
    launchctl: (args) => (args[0] === "print" ? { code: 113, stdout: "", stderr: "not found" } : { code: 0, stdout: "", stderr: "" }),
    lsof: { code: 1, stdout: "", stderr: "" },
  });

  const result = await ensureTunnel(spec, exec);
  assert.equal(result.action, "bootstrapped");
  assert.equal(result.newKeypair, true);
  assert.match(result.installLine, /^restrict,port-forwarding,permitopen="127\.0\.0\.1:8080" ssh-ed25519 AAAATEST/);

  assert.ok(existsSync(spec.keeperPath), "keeper written");
  assert.ok(existsSync(spec.plistPath), "plist written");
  assert.ok(readFileSync(spec.sshConfigPath, "utf8").includes(`Host ${spec.alias}`), "ssh alias appended");
  assert.ok(exec.calls.some((c) => c[0] === "launchctl" && c[1] === "bootstrap"), "bootstrapped");
  rmSync(spec.home, { recursive: true, force: true });
});

test("labelPrefix is configurable and derives the label + plist path", () => {
  const home = mkdtempSync(join(tmpdir(), "obscura-tunnel-"));
  const spec = tunnelSpec({ alias: "t", hostName: HOSTNAME, home, labelPrefix: "com.example" });
  assert.equal(spec.label, "com.example.t");
  assert.ok(spec.plistPath.endsWith("com.example.t.plist"));
  rmSync(home, { recursive: true, force: true });
});

test("ensureTunnel surfaces drift when adopted artifacts disagree with the current config", async () => {
  const spec = makeSpec();
  // Adopted artifacts generated from a DIFFERENT config: old HostName, old forward target.
  const oldSpec = tunnelSpec({ alias: spec.alias, hostName: "old-host.example", gatewayHost: "127.0.0.1:9999", home: spec.home });
  mkdirSync(dirname(spec.keyPath), { recursive: true });
  writeFileSync(spec.keyPath, "PRIVATE");
  writeFileSync(`${spec.keyPath}.pub`, "ssh-ed25519 AAAA live\n");
  writeFileSync(spec.sshConfigPath, sshConfigBlock(oldSpec));
  mkdirSync(spec.keeperDir, { recursive: true });
  writeFileSync(spec.keeperPath, keeperScript(oldSpec));
  mkdirSync(dirname(spec.plistPath), { recursive: true });
  writeFileSync(spec.plistPath, launchAgentPlist(oldSpec));

  const exec = fakeExec({
    launchctl: { code: 0, stdout: "state = running\npid = 99\n", stderr: "" },
    lsof: { code: 1, stdout: "", stderr: "" },
  });
  const result = await ensureTunnel(spec, exec);
  assert.equal(result.drift.length, 2, `got: ${JSON.stringify(result.drift)}`);
  assert.ok(result.drift.some((d) => d.includes("old-host.example") && d.includes(HOSTNAME)), "HostName drift named");
  assert.ok(result.drift.some((d) => d.includes("8080:127.0.0.1:9999") && d.includes("8080:127.0.0.1:8080")), "forward drift named");
  rmSync(spec.home, { recursive: true, force: true });
});

test("ensureTunnel is a no-op when everything exists and runs; re-enables when self-disabled", async () => {
  const spec = makeSpec();
  // Pre-build every artifact (the adopted live setup).
  mkdirSync(dirname(spec.keyPath), { recursive: true });
  writeFileSync(spec.keyPath, "PRIVATE");
  writeFileSync(`${spec.keyPath}.pub`, "ssh-ed25519 AAAA live\n");
  writeFileSync(spec.sshConfigPath, `${sshConfigBlock(spec)}\nHost other\n    HostName elsewhere.example\n`);
  mkdirSync(spec.keeperDir, { recursive: true });
  writeFileSync(spec.keeperPath, keeperScript(spec));
  mkdirSync(dirname(spec.plistPath), { recursive: true });
  writeFileSync(spec.plistPath, launchAgentPlist(spec));

  const runningExec = fakeExec({
    launchctl: { code: 0, stdout: "state = running\npid = 99\n", stderr: "" },
    lsof: { code: 0, stdout: "COMMAND PID\nssh 99 user 5u IPv4 TCP 127.0.0.1:8080 (LISTEN)\n", stderr: "" },
    ps: psFake(spec, { uid: process.getuid?.() ?? 0, ppid: "98", argv: "/usr/bin/ssh -N -T -L 8080:127.0.0.1:8080 browse-gateway-tunnel" }),
  });
  const noop = await ensureTunnel(spec, runningExec);
  assert.equal(noop.action, "none");
  assert.deepEqual(noop.created, [], "nothing rewritten");
  assert.equal(noop.newKeypair, false);
  assert.equal(noop.drift, undefined, "matching artifacts report no drift");
  assert.ok(!runningExec.calls.some((c) => c[1] === "bootstrap"), "no bootstrap when running");
  const sshConfig = readFileSync(spec.sshConfigPath, "utf8");
  assert.equal(sshConfig.match(/Host browse-gateway-tunnel/g).length, 1, "alias not duplicated");

  // Self-disabled: launchctl print fails + the keeper log carries the marker → re-enable.
  mkdirSync(dirname(spec.logPath), { recursive: true });
  writeFileSync(spec.logPath, `*** 10 consecutive fast failures — ${SELF_DISABLE_MARKER} the tunnel LaunchAgent. ***\n`);
  const disabledExec = fakeExec({
    launchctl: (args) => (args[0] === "print" ? { code: 113, stdout: "", stderr: "not found" } : { code: 0, stdout: "", stderr: "" }),
    lsof: { code: 1, stdout: "", stderr: "" },
  });
  const reenabled = await ensureTunnel(spec, disabledExec);
  assert.equal(reenabled.action, "re-enabled");
  assert.ok(disabledExec.calls.some((c) => c[1] === "bootstrap"), "bootstrap chosen for the re-enable");
  rmSync(spec.home, { recursive: true, force: true });
});
