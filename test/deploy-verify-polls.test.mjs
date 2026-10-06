/**
 * VIL-291 — the post-swap verify in `deploy-on-host.sh` must POLL for the new container to come up,
 * not take one look after a fixed sleep.
 *
 * The regression this locks: verify() used to `sleep 4` and then check exactly once. That was tuned
 * on a native host. On a slower host (an amd64 image under binary translation boots measurably
 * slower) a perfectly healthy image is still starting at the 4 s mark, so verify fails, the deploy
 * auto-rolls back a good image, and the rollback's own one-shot verify can fail the same way —
 * ending in "ROLLBACK ALSO FAILED" with nothing actually wrong.
 *
 * The REAL deploy-on-host.sh runs against a fake docker whose `logs` only shows the boot line after
 * N calls, so a slow boot is constructed at the source rather than asserted on a string. `sleep` is
 * shimmed to a counter so the polling costs no wall-clock time.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname;
const IMAGE = `ghcr.io/testowner/browse-gateway@sha256:${"a".repeat(64)}`;

/**
 * @param readyAfter the `docker logs` call number on which the boot line first appears
 * @param state      what `docker inspect` reports as Status/Running/RestartCount
 */
function sandbox({ readyAfter, state = "running/true/0", bigLogs = false, stalledProbe = false }) {
  const dir = mkdtempSync(join(tmpdir(), "bgw-verify-"));
  const bin = join(dir, "bin");
  const deploy = join(dir, "deploy");
  const marks = join(dir, "marks");
  for (const d of [bin, deploy, marks]) mkdirSync(d, { recursive: true });

  copyFileSync(join(repoRoot, "scripts/deploy/deploy-on-host.sh"), join(deploy, "deploy-on-host.sh"));
  chmodSync(join(deploy, "deploy-on-host.sh"), 0o755);
  // Fake launcher: records each launch, so a rollback shows up as a SECOND live launch.
  writeFileSync(join(deploy, "launch-http.sh"),
    `#!/usr/bin/env bash\necho "\${BGW_CONTAINER:-browse-gateway-http}|$BGW_DEPLOY_IMAGE" >> "${marks}/LAUNCHED"\nexit 0\n`);
  chmodSync(join(deploy, "launch-http.sh"), 0o755);
  // The image's smoke passes; this test is about what happens AFTER the swap.
  writeFileSync(join(dir, "image-smoke.sh"), "#!/usr/bin/env bash\nexit 0\n");

  writeFileSync(join(bin, "docker"), `#!/usr/bin/env bash
echo "$1" >> "${marks}/docker-calls"
case "$1" in
  pull|rm|rmi|images|run) exit 0 ;;
  create) echo "deadbeefcafe"; exit 0 ;;
  cp)
    if [ "\${2#*:}" = "/app/scripts/deploy/preswap-smoke.sh" ]; then cp "${dir}/image-smoke.sh" "$3"; exit 0; fi
    exit 1 ;;
  logs)
    n=$(( $(cat "${marks}/logs-calls" 2>/dev/null || echo 0) + 1 )); echo "$n" > "${marks}/logs-calls"
    if [ "$n" -ge ${readyAfter} ]; then echo "gateway listening dnsRebindProtection=true version=1.0.0 mode=http"; fi
    # A log far larger than a pipe buffer, AFTER the marker: a reader that stops at the first match
    # closes the pipe while this is still writing, exactly as the real CLI would be SIGPIPEd.
    ${bigLogs ? `head -c 3000000 /dev/zero | tr '\\0' x; echo` : ""}
    exit $? ;;
  inspect)
    case "$*" in
      *State.Status*) echo "${state}" ;;
      *) echo "sha256:feedfacefeedface" ;;
    esac
    exit 0 ;;
esac
exit 0
`);
  // A stalled probe honours --max-time the way real curl does: it hangs for the whole allowance.
  // Real /bin/sleep, because "sleep" on PATH is the counting shim.
  writeFileSync(join(bin, "curl"), stalledProbe
    ? `#!/usr/bin/env bash\nwhile [ $# -gt 0 ]; do [ "$1" = "--max-time" ] && t="$2"; shift; done\n/bin/sleep "\${t:-3}"; echo 000; exit 28\n`
    : "#!/usr/bin/env bash\necho 401\n");
  writeFileSync(join(bin, "sha256sum"), `#!/usr/bin/env bash\nshasum -a 256 "$@" 2>/dev/null || echo "0000000000000000  $1"\n`);
  // Count sleeps instead of spending them.
  writeFileSync(join(bin, "sleep"), `#!/usr/bin/env bash\necho "$1" >> "${marks}/sleeps"\n`);
  for (const f of ["docker", "curl", "sha256sum", "sleep"]) chmodSync(join(bin, f), 0o755);

  writeFileSync(join(dir, "config.env"), [
    "BGW_EXPECTED_REPO=ghcr.io/testowner/browse-gateway",
    "BGW_BIND_ADDR=127.0.0.1",
    "BGW_HOST_PORT=8080",
    `GATE_LOG=${join(dir, "gate.log")}`,
  ].join("\n") + "\n");
  return { dir, deploy, marks };
}

function runDeploy(sb, extraEnv = {}) {
  return spawnSync("bash", [join(sb.deploy, "deploy-on-host.sh"), IMAGE], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(sb.dir, "bin")}:${process.env.PATH}`,
      BGW_DEPLOY_CONFIG: join(sb.dir, "config.env"),
      TMPDIR: sb.dir,
      ...extraEnv,
    },
  });
}

const liveLaunches = (sb) => {
  const f = join(sb.marks, "LAUNCHED");
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).filter((l) => !l.startsWith("browse-gateway-http-presmoke")) : [];
};
const count = (sb, name) => {
  const f = join(sb.marks, name);
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).length : 0;
};

test("a healthy image that is still booting at the first check is NOT rolled back", () => {
  const sb = sandbox({ readyAfter: 4 });
  const r = runDeploy(sb);
  assert.equal(r.status, 0, `deploy should succeed once the boot line appears:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /deploy: SUCCESS/);
  assert.doesNotMatch(r.stderr, /rolling back/);
  assert.equal(liveLaunches(sb).length, 1, `exactly one live launch (the swap), no rollback launch: ${liveLaunches(sb)}`);
});

test("an image that never boots fails verify within the bound and rolls back", () => {
  const sb = sandbox({ readyAfter: 1_000_000 });
  const r = runDeploy(sb, { BGW_VERIFY_TIMEOUT: "5" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /verify FAILED — rolling back/);
  assert.equal(liveLaunches(sb).length, 2, "swap + rollback launch");
  // Two verifies (the deploy's and the rollback's), each bounded by BGW_VERIFY_TIMEOUT polls.
  assert.ok(count(sb, "logs-calls") === 0 || Number(readFileSync(join(sb.marks, "logs-calls"), "utf8")) <= 10,
    `verify must stop polling at the bound; logs was read ${readFileSync(join(sb.marks, "logs-calls"), "utf8").trim()} times`);
  assert.match(r.stdout + r.stderr, /verify: .*timed out after 5s/);
});

test("a container that has already restarted fails at once instead of waiting out the bound", () => {
  // A crash-looping container will not heal by waiting; the old check also failed this case, and the
  // poll must not turn a fast failure into a 30 s one.
  const sb = sandbox({ readyAfter: 1, state: "running/true/1" });
  const r = runDeploy(sb, { BGW_VERIFY_TIMEOUT: "30" });
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /verify: .*restarts=1/);
  assert.ok(count(sb, "sleeps") <= 2, `failed fast: ${count(sb, "sleeps")} sleeps across both verifies (bound would be 60)`);
});

test("a large container log does not make verify miss a marker it found (grep -q + pipefail SIGPIPE)", () => {
  const sb = sandbox({ readyAfter: 1, bigLogs: true });
  const r = runDeploy(sb, { BGW_VERIFY_TIMEOUT: "5" });
  assert.equal(r.status, 0, `the boot line is there; verify must see it:\n${r.stdout}\n${r.stderr}`);
  assert.equal(liveLaunches(sb).length, 1, "no rollback");
});

test("REFUSED before touching anything: a BGW_VERIFY_TIMEOUT that is not 1..600 whole seconds", () => {
  for (const bad of ["0", "000", "abc", "-5", "2.5", "601", "99999999999999999999", ""]) {
    const sb = sandbox({ readyAfter: 1 });
    const r = runDeploy(sb, { BGW_VERIFY_TIMEOUT: bad });
    if (bad === "") { assert.equal(r.status, 0, "empty means unset -> the default"); continue; }
    assert.equal(r.status, 2, `'${bad}': ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /BGW_VERIFY_TIMEOUT/);
    assert.equal(count(sb, "docker-calls"), 0, `'${bad}' must be refused before any docker call`);
    assert.equal(liveLaunches(sb).length, 0);
  }
  const ok = runDeploy(sandbox({ readyAfter: 1 }), { BGW_VERIFY_TIMEOUT: "007" });
  assert.equal(ok.status, 0, "leading zeros are still a whole number of seconds");
});

test("a stalled /mcp probe cannot stretch verify past its budget", () => {
  // Booted, healthy state, but every probe hangs until --max-time. With a 1 s budget the fixed verify
  // caps the probe at the 1 s left (~1 s per verify, ~2 s for verify + rollback-verify). An uncapped
  // probe spends its full 3 s regardless (~6 s): that is the regression this pins.
  const sb = sandbox({ readyAfter: 1, stalledProbe: true });
  const t0 = Date.now();
  const r = runDeploy(sb, { BGW_VERIFY_TIMEOUT: "1" });
  const secs = (Date.now() - t0) / 1000;
  assert.equal(r.status, 1, "probe never answers 401 -> verify fails -> rollback");
  assert.ok(secs < 5, `deploy took ${secs.toFixed(1)} s; two 1 s verifies must not take ~6 s`);
});
