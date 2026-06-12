/**
 * Obscura connect tests (U5) — token discovery priority, register idempotency, partial-failure
 * honesty (tunnel left up, no false "connected"), the foreign-binder guard, and the --full
 * stealth append. The tunnel/register/probe seams are faked; verify's mapping itself is pinned
 * in cli-verify.test.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, discoverToken, registerMcp, memoryKeychain, tunnelSpec } from "../dist/cli/index.js";

const TOKEN = "d".repeat(64);

function makeDeps(over = {}) {
  const lines = [];
  const spec = tunnelSpec({ alias: "browse-gateway-tunnel", hostName: "prod-host.example", home: "/tmp/unused" });
  const deps = {
    consumer: "consumer-1",
    spec,
    gatewayHost: "127.0.0.1:8080",
    keychain: memoryKeychain({ "consumer-1": TOKEN }),
    out: (line) => lines.push(line),
    ensure: async () => ({ created: [], newKeypair: false, action: "none" }),
    state: async () => ({ agent: "running", port: "ours" }),
    register: async () => "unchanged",
    probe: async () => "401",
    // The gateway answers 400 (missing session id) to an ACCEPTED bearer; 401 means rejected.
    authedProbe: async () => "400",
    wait: async () => {},
    verifyTimeoutMs: 200,
    verifyPollMs: 1,
    ...over,
  };
  return { deps, lines };
}

test("discovery priority: keychain wins, config fallback, conflict warns, missing is actionable", async () => {
  const kc = memoryKeychain({ "consumer-1": TOKEN });
  assert.deepEqual(await discoverToken(kc, "consumer-1"), { token: TOKEN, source: "keychain" });
  assert.deepEqual(await discoverToken(memoryKeychain(), "consumer-1", "cfg-token"), { token: "cfg-token", source: "config" });

  const conflicted = await discoverToken(kc, "consumer-1", "different");
  assert.equal(conflicted.token, TOKEN, "keychain wins the conflict");
  assert.match(conflicted.warning, /disagree/);

  await assert.rejects(() => discoverToken(memoryKeychain(), "consumer-1"), /run: obscura keys new consumer-1/);
});

test("happy path prints the ✓ connect moment", async () => {
  const { deps, lines } = makeDeps();
  await connect(deps);
  assert.ok(lines.includes("✓ connected as consumer-1 · gateway healthy"), `got: ${lines.join(" | ")}`);
});

test("verify failures are distinct: 403 mismatch vs tunnel down vs unexpected — never a false ✓", async () => {
  const mismatch = makeDeps({ probe: async () => "403" });
  await assert.rejects(() => connect(mismatch.deps), /host\/token mismatch.*BGW_ALLOWED_HOSTS/s);

  const down = makeDeps({ probe: async () => "000" });
  // Shrink the window so the test doesn't ride the full 30s retry.
  await assert.rejects(() => connect(down.deps), /tunnel down/);

  const odd = makeDeps({ probe: async () => "502" });
  await assert.rejects(() => connect(odd.deps), /HTTP 502/);

  for (const { lines } of [mismatch, down, odd]) {
    assert.ok(!lines.some((l) => l.includes("connected as")), "no false connected line");
  }
});

test("000-then-401 within the window still lands the ✓ (redeploy race)", async () => {
  let calls = 0;
  const { deps, lines } = makeDeps({ probe: async () => (++calls < 3 ? "000" : "401") });
  await connect(deps);
  assert.ok(lines.some((l) => l.includes("✓ connected as consumer-1")));
});

test("a stale/revoked key is caught by the authenticated probe — no false ✓ on liveness alone", async () => {
  // Liveness 401 says the gateway is up; the authed probe answering 401 means OUR bearer was
  // rejected. connect must fail with the re-mint instruction, not print connected.
  const { deps, lines } = makeDeps({ authedProbe: async () => "401" });
  await assert.rejects(() => connect(deps), /rejected the keychain key.*stale or revoked.*obscura keys new/s);
  assert.ok(!lines.some((l) => l.includes("connected as")), "no false connected");
});

test("--full without the stealth dep wired is a hard error, not a silent skip", async () => {
  const { deps } = makeDeps({ stealth: undefined });
  await assert.rejects(() => connect(deps, { full: true }), /--full requires the admin SSH config/);
});

test("tunnel artifact drift from ensure is surfaced as warnings", async () => {
  const { deps, lines } = makeDeps({
    ensure: async () => ({
      created: [],
      newKeypair: false,
      drift: ["ssh alias \"browse-gateway-tunnel\" points at HostName old-host.example, but config says prod-host.example"],
      action: "none",
    }),
  });
  await connect(deps);
  assert.ok(lines.some((l) => l.includes("tunnel artifact drift") && l.includes("old-host.example")));
  assert.ok(lines.some((l) => l.includes("✓ connected as consumer-1")), "drift warns, doesn't abort");
});

test("register failure: tunnel left up, partial reported, exit non-zero", async () => {
  const { deps, lines } = makeDeps({
    register: async () => {
      throw new Error("the `claude` CLI is not available (spawn claude ENOENT) — install Claude Code, then re-run obscura connect");
    },
  });
  await assert.rejects(() => connect(deps), /connect incomplete: MCP registration failed/);
  assert.ok(lines.some((l) => l.includes("claude") && l.includes("not available")), "cause surfaced");
  assert.ok(lines.some((l) => l.includes("tunnel is left up")), "explicitly says the tunnel survives");
  assert.ok(!lines.some((l) => l.includes("connected as")), "no false connected");
});

test("foreign binder on the local port aborts before registration", async () => {
  let registered = false;
  const { deps } = makeDeps({
    state: async () => ({ agent: "running", port: "foreign" }),
    register: async () => {
      registered = true;
      return "added";
    },
  });
  await assert.rejects(() => connect(deps), /bound by another process/);
  assert.equal(registered, false, "never registers against an unknown binder");
});

test("self-disabled tunnel is re-enabled and a new keypair prints the prod install line", async () => {
  const { deps, lines } = makeDeps({
    ensure: async () => ({
      created: ["/tmp/unused/.ssh/browse-gateway-tunnel"],
      newKeypair: true,
      installLine: 'restrict,port-forwarding,permitopen="127.0.0.1:8080" ssh-ed25519 AAAA new',
      action: "re-enabled",
    }),
  });
  await connect(deps);
  assert.ok(lines.some((l) => l.includes("re-enabled")));
  assert.ok(lines.some((l) => l.includes("prod does not trust it yet")));
  assert.ok(lines.some((l) => l.includes('permitopen="127.0.0.1:8080"')));
});

test("--full appends stealth green only on a passing gate; a red gate fails the run", async () => {
  const green = makeDeps({ stealth: async () => true });
  await connect(green.deps, { full: true });
  assert.ok(green.lines.some((l) => l === "✓ connected as consumer-1 · gateway healthy · stealth green"));

  const red = makeDeps({ stealth: async () => false });
  await assert.rejects(() => connect(red.deps, { full: true }), /stealth gate failed/);
  assert.ok(!red.lines.some((l) => l.includes("stealth green")), "no stealth green on a red gate");
  assert.ok(red.lines.some((l) => l === "✓ connected as consumer-1 · gateway healthy"), "the base connect is still honest");
});

test("registerMcp idempotency: unchanged / updated / added / claude missing", async () => {
  const calls = [];
  const mk = (getResult) => async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[1] === "get") return getResult;
    return { code: 0, stdout: "", stderr: "" };
  };

  // Existing registration with same URL + token → unchanged, nothing rewritten.
  const same = await registerMcp({
    url: "http://127.0.0.1:8080/mcp",
    token: TOKEN,
    exec: mk({ code: 0, stdout: `URL: http://127.0.0.1:8080/mcp\nAuthorization: Bearer ${TOKEN}\n`, stderr: "" }),
  });
  assert.equal(same, "unchanged");
  assert.ok(!calls.some((c) => c.includes("add")), "no rewrite when unchanged");

  // Existing with a different token → remove + add → updated.
  calls.length = 0;
  const updated = await registerMcp({
    url: "http://127.0.0.1:8080/mcp",
    token: TOKEN,
    exec: mk({ code: 0, stdout: "URL: http://127.0.0.1:8080/mcp\nAuthorization: Bearer old\n", stderr: "" }),
  });
  assert.equal(updated, "updated");
  assert.ok(calls.some((c) => c.includes("remove")));
  const add = calls.find((c) => c.includes("add"));
  assert.ok(add.includes(`Authorization: Bearer ${TOKEN}`), "literal token via execFile args");
  assert.ok(add.includes("--transport") && add.includes("http"));

  // Absent → added.
  calls.length = 0;
  const added = await registerMcp({
    url: "http://127.0.0.1:8080/mcp",
    token: TOKEN,
    exec: mk({ code: 1, stdout: "", stderr: "No MCP server found" }),
  });
  assert.equal(added, "added");
  assert.ok(!calls.some((c) => c.includes("remove")));

  // `claude` not installed → actionable error.
  await assert.rejects(
    () =>
      registerMcp({
        url: "http://127.0.0.1:8080/mcp",
        token: TOKEN,
        exec: async () => {
          throw new Error("spawn claude ENOENT");
        },
      }),
    /`claude` CLI is not available .* install Claude Code/,
  );
});

test("registerMcp is non-destructive: a failed add after remove RESTORES the old registration", async () => {
  const oldGet = `URL: http://127.0.0.1:8080/mcp\nAuthorization: Bearer ${"e".repeat(64)}\n`;
  const calls = [];
  let addCount = 0;
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[1] === "get") return { code: 0, stdout: oldGet, stderr: "" };
    if (args[1] === "remove") return { code: 0, stdout: "", stderr: "" };
    if (args[1] === "add") {
      addCount++;
      // First add (the new registration) fails; the restore add succeeds.
      return addCount === 1 ? { code: 1, stdout: "", stderr: "config locked" } : { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  await assert.rejects(
    () => registerMcp({ url: "http://127.0.0.1:8080/mcp", token: TOKEN, exec }),
    /add browse-gateway failed.*was RESTORED/s,
  );
  const restore = calls.filter((c) => c.includes("add")).at(-1);
  assert.ok(restore.includes(`Authorization: Bearer ${"e".repeat(64)}`), "restore re-adds the OLD token");
});

test("registerMcp: remove failure aborts before any destructive add", async () => {
  const exec = async (cmd, args) => {
    if (args[1] === "get") return { code: 0, stdout: "URL: http://127.0.0.1:8080/mcp\nAuthorization: Bearer old\n", stderr: "" };
    if (args[1] === "remove") return { code: 1, stdout: "", stderr: "permission denied" };
    throw new Error("add must not run after a failed remove");
  };
  await assert.rejects(
    () => registerMcp({ url: "http://127.0.0.1:8080/mcp", token: TOKEN, exec }),
    /remove browse-gateway failed \(exit 1\): permission denied/,
  );
});

test("registerMcp: redacted `claude mcp get` output takes the update path, never a false unchanged", async () => {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push(args[1]);
    if (args[1] === "get") return { code: 0, stdout: "URL: http://127.0.0.1:8080/mcp\nAuthorization: Bearer ****\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const outcome = await registerMcp({ url: "http://127.0.0.1:8080/mcp", token: TOKEN, exec });
  assert.equal(outcome, "updated", "redaction means we cannot prove unchanged — rewrite");
  assert.ok(calls.includes("remove") && calls.includes("add"));
});
