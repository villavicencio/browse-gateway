/**
 * Mac-side `obscura vault` marshalling tests (U8a). The on-host entrypoint is faked as a RemoteShell
 * that captures the script + stdin and returns a canned JSON result — so these prove the wire
 * discipline (secret material ONLY on stdin, never in the SSH command line), the local-file
 * validation, and the result rendering, with no Docker and no crypto.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { vaultStatus, vaultImport, vaultRevoke } from "../dist/cli/index.js";

function fakeShell(result) {
  const calls = [];
  return {
    calls,
    run: async (script, input, opts) => {
      calls.push({ script, input, opts });
      return typeof result === "function" ? result(script, input) : result;
    },
  };
}
const okResult = (obj) => ({ code: 0, stdout: `${JSON.stringify(obj)}\n`, stderr: "[obscura-vault-host] log line\n" });
const collect = () => {
  const out = [];
  return { out, push: (l) => out.push(l) };
};

test("vault status renders entries from the on-host JSON, touching no crypto", async () => {
  const shell = fakeShell(
    okResult({
      command: "status",
      ok: true,
      vaultEnabled: true,
      hasKey: true,
      bootBlocked: false,
      entries: [{ consumerId: "atlas", host: "ex.com", updatedAt: 1_700_000_000_000, bytes: 512 }],
    }),
  );
  const { out, push } = collect();
  await vaultStatus({ shell, container: "browse-gateway-http", out: push });

  assert.equal(shell.calls.length, 1);
  const { script } = shell.calls[0];
  assert.match(script, /docker exec -i -w '\/app' 'browse-gateway-http' node 'dist\/cli\/vault-host\.js' 'status'/);
  assert.ok(out.some((l) => l.includes("atlas") && l.includes("ex.com")), "lists the entry");
});

test("vault status surfaces disabled and boot-blocked states", async () => {
  const disabled = collect();
  await vaultStatus({ shell: fakeShell(okResult({ vaultEnabled: false, entries: [] })), container: "c", out: disabled.push });
  assert.ok(disabled.out.some((l) => /not enabled/.test(l)));

  const blocked = collect();
  await vaultStatus({
    shell: fakeShell(okResult({ vaultEnabled: true, hasKey: false, bootBlocked: true, entries: [{ consumerId: "a", host: "h", updatedAt: 1, bytes: 1 }] })),
    container: "c",
    out: blocked.push,
  });
  assert.ok(blocked.out.some((l) => /refuse to boot/i.test(l)), "warns the gateway will not boot");
});

test("vault import sends creds on STDIN, never in the SSH command line", async () => {
  const files = {
    "s.json": JSON.stringify({ cookies: [{ name: "sid", value: "v" }], origins: [] }),
    "c.json": JSON.stringify({ username: "atlas-user", password: "SUPERSECRETpw", totpSeed: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP" }),
  };
  const shell = fakeShell(
    okResult({ command: "import", ok: true, consumerId: "atlas", host: "ex.com", updatedAt: 1, cookieNames: ["sid"], strippedCount: 2, bound: false, verified: true }),
  );
  const { out, push } = collect();
  await vaultImport(
    { shell, container: "c", out: push, readLocalFile: (p) => files[p] },
    { consumerId: "atlas", host: "ex.com", sessionPath: "s.json", credsPath: "c.json" },
  );

  const { script, input } = shell.calls[0];
  // Secret material rides on stdin...
  assert.ok(input.includes("SUPERSECRETpw") && input.includes("atlas-user"), "creds shipped on stdin");
  assert.ok(input.includes('"sid"'), "session shipped on stdin");
  // ...and NEVER in the command the process table / shell history would show.
  assert.ok(!script.includes("SUPERSECRETpw"), "password must not be in the SSH command");
  assert.ok(!script.includes("atlas-user"), "username must not be in the SSH command");
  assert.match(script, /'import' --consumer 'atlas' --host 'ex.com'/);
  assert.ok(out.some((l) => /imported login for atlas @ ex\.com/.test(l) && /decrypt-verified/.test(l)));
});

test("vault import binds a sticky exit only when --exit is given", async () => {
  const files = { s: JSON.stringify({ cookies: [], origins: [] }), c: JSON.stringify({ username: "u", password: "p".repeat(16) }) };
  const shell = fakeShell(okResult({ command: "import", ok: true, consumerId: "a", host: "h", cookieNames: [], strippedCount: 0, bound: true, verified: true }));
  const { out, push } = collect();
  await vaultImport(
    { shell, container: "c", out: push, readLocalFile: (p) => files[p] },
    { consumerId: "a", host: "h", sessionPath: "s", credsPath: "c", exit: "feed0000" },
  );
  assert.match(shell.calls[0].script, /--exit 'feed0000'/);
  assert.ok(out.some((l) => /sticky exit/.test(l)));
});

test("vault import validates the local files before any SSH round-trip", async () => {
  const shell = fakeShell(okResult({}));
  await assert.rejects(
    () => vaultImport({ shell, container: "c", out: () => {}, readLocalFile: () => "{ not json" }, { consumerId: "a", host: "h", sessionPath: "s", credsPath: "c" }),
    /not readable as JSON/,
  );
  const files = { s: "{}", c: JSON.stringify({ username: "u" }) };
  await assert.rejects(
    () => vaultImport({ shell, container: "c", out: () => {}, readLocalFile: (p) => files[p] }, { consumerId: "a", host: "h", sessionPath: "s", credsPath: "c" }),
    /must contain string "username" and "password"/,
  );
  assert.equal(shell.calls.length, 0, "no SSH call is made when local validation fails");
});

test("vault revoke reports shred vs nothing-to-shred", async () => {
  const yes = collect();
  await vaultRevoke({ shell: fakeShell(okResult({ removed: true })), container: "c", out: yes.push }, "atlas", "ex.com");
  assert.ok(yes.out.some((l) => /crypto-shredded/.test(l)));
  assert.match(yes.out.join("\n"), /atlas @ ex\.com/);

  const no = collect();
  await vaultRevoke({ shell: fakeShell(okResult({ removed: false })), container: "c", out: no.push }, "atlas", "ex.com");
  assert.ok(no.out.some((l) => /nothing to shred/.test(l)));
});

test("a nonzero on-host exit surfaces the (already-redacted) stderr to the operator", async () => {
  const shell = fakeShell({ code: 1, stdout: "", stderr: "[obscura-vault-host] consumer \"ghost\" is not in the manifest\n" });
  await assert.rejects(() => vaultStatus({ shell, container: "c", out: () => {} }), /not in the manifest/);
});
