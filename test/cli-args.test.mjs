/**
 * Obscura CLI dispatcher tests (U1) — the hand-rolled argv parser: command/subcommand routing,
 * flag shapes, and usage errors. Pure parser, no process side effects.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCliArgs, usage } from "../dist/cli/index.js";

test("keys new dispatches with positional consumer and flag shapes", () => {
  const r = parseCliArgs(["keys", "new", "consumer-1"]);
  assert.equal(r.ok, true);
  assert.equal(r.invocation.command, "keys");
  assert.equal(r.invocation.subcommand, "new");
  assert.deepEqual(r.invocation.positionals, ["consumer-1"]);
  assert.deepEqual(r.invocation.flags, {});

  const withFlags = parseCliArgs(["keys", "new", "consumer-1", "--allow", "x.com", "--apply"]);
  assert.equal(withFlags.ok, true);
  assert.deepEqual(withFlags.invocation.flags.allow, ["x.com"]);
  assert.equal(withFlags.invocation.flags.apply, true);
});

test("--allow accepts repeats, comma lists, and --allow=value", () => {
  const repeated = parseCliArgs(["keys", "new", "c", "--allow", "x.com", "--allow", "*.y.com"]);
  assert.deepEqual(repeated.invocation.flags.allow, ["x.com", "*.y.com"]);

  const comma = parseCliArgs(["keys", "new", "c", "--allow", "x.com,*.y.com"]);
  assert.deepEqual(comma.invocation.flags.allow, ["x.com", "*.y.com"]);

  const eq = parseCliArgs(["keys", "new", "c", "--allow=x.com"]);
  assert.deepEqual(eq.invocation.flags.allow, ["x.com"]);

  const missing = parseCliArgs(["keys", "new", "c", "--allow"]);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /--allow requires a value/);

  // A following flag is never eaten as the value: `--allow --apply` is a mistake, and silently
  // minting an allow rule called "--apply" (while skipping the apply) would be a policy bug.
  const ateFlag = parseCliArgs(["keys", "new", "c", "--allow", "--apply"]);
  assert.equal(ateFlag.ok, false);
  assert.match(ateFlag.error, /--allow requires a value/);

  // Explicit-but-empty must not silently fall back to the allow-all default.
  const empty = parseCliArgs(["keys", "new", "c", "--allow", ","]);
  assert.equal(empty.ok, false);
  assert.match(empty.error, /at least one non-empty rule/);
});

test("connect --full and status --stealth parse as booleans", () => {
  const c = parseCliArgs(["connect", "--full"]);
  assert.equal(c.ok, true);
  assert.equal(c.invocation.command, "connect");
  assert.equal(c.invocation.flags.full, true);
  assert.equal(c.invocation.subcommand, undefined);

  const s = parseCliArgs(["status", "--stealth"]);
  assert.equal(s.ok, true);
  assert.equal(s.invocation.flags.stealth, true);

  const bare = parseCliArgs(["status"]);
  assert.equal(bare.ok, true);
  assert.deepEqual(bare.invocation.flags, {});
});

test("unknown command, bare invocation, and unknown subcommand are usage errors", () => {
  const unknown = parseCliArgs(["frobnicate"]);
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /unknown command: frobnicate/);

  const bare = parseCliArgs([]);
  assert.equal(bare.ok, false);
  assert.equal(bare.error, undefined); // bare invocation is not an error worth shouting — just usage

  const badSub = parseCliArgs(["keys", "destroy", "c"]);
  assert.equal(badSub.ok, false);
  assert.match(badSub.error, /usage: obscura keys <new\|list\|revoke>/);

  const noSub = parseCliArgs(["keys"]);
  assert.equal(noSub.ok, false);
});

test("flags are validated per command — no silent cross-command leakage", () => {
  const wrong = parseCliArgs(["connect", "--apply"]);
  assert.equal(wrong.ok, false);
  assert.match(wrong.error, /unknown flag for connect: --apply/);

  const wrongSub = parseCliArgs(["keys", "list", "--allow", "x.com"]);
  assert.equal(wrongSub.ok, false);
  assert.match(wrongSub.error, /unknown flag for keys list: --allow/);

  const boolWithValue = parseCliArgs(["connect", "--full=yes"]);
  assert.equal(boolWithValue.ok, false);
  assert.match(boolWithValue.error, /--full takes no value/);
});

test("usage names every command", () => {
  const text = usage();
  for (const word of ["keys new", "keys list", "keys revoke", "connect", "status", "vault status", "vault import", "vault login", "vault revoke"]) {
    assert.ok(text.includes(word), `usage mentions ${word}`);
  }
});

test("vault subcommands route with single-value flags (not allow-accumulation)", () => {
  const status = parseCliArgs(["vault", "status"]);
  assert.equal(status.ok, true);
  assert.equal(status.invocation.command, "vault");
  assert.equal(status.invocation.subcommand, "status");
  assert.deepEqual(status.invocation.flags, {});

  const imp = parseCliArgs(["vault", "import", "--consumer", "atlas", "--host", "ex.com", "--session", "s.json", "--creds", "c.json", "--exit", "feed0000"]);
  assert.equal(imp.ok, true);
  assert.equal(imp.invocation.subcommand, "import");
  // Single-value flags store a STRING, not the comma-split list `allow` uses.
  assert.equal(imp.invocation.flags.consumer, "atlas");
  assert.equal(imp.invocation.flags.host, "ex.com");
  assert.equal(imp.invocation.flags.session, "s.json");
  assert.equal(imp.invocation.flags.creds, "c.json");
  assert.equal(imp.invocation.flags.exit, "feed0000");
  assert.equal(imp.invocation.flags.allow, undefined);

  const login = parseCliArgs(["vault", "login", "--consumer", "atlas", "--host", "ex.com", "--recipe", "r.json", "--creds", "c.json"]);
  assert.equal(login.ok, true);
  assert.equal(login.invocation.flags.recipe, "r.json");
});

test("vault: a value with a comma is NOT split (a host/path is one token)", () => {
  const r = parseCliArgs(["vault", "revoke", "--consumer", "atlas", "--host", "a.com,b.com"]);
  assert.equal(r.ok, true);
  assert.equal(r.invocation.flags.host, "a.com,b.com"); // last-value string, never a list
});

test("vault rejects unknown subcommands, unknown flags, and missing values", () => {
  const badSub = parseCliArgs(["vault", "destroy"]);
  assert.equal(badSub.ok, false);
  assert.match(badSub.error, /usage: obscura vault <status\|import\|login\|revoke>/);

  const badFlag = parseCliArgs(["vault", "status", "--consumer", "x"]);
  assert.equal(badFlag.ok, false);
  assert.match(badFlag.error, /unknown flag for vault status: --consumer/);

  const noValue = parseCliArgs(["vault", "revoke", "--host"]);
  assert.equal(noValue.ok, false);
  assert.match(noValue.error, /--host requires a value/);
});
