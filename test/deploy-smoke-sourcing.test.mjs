/**
 * VIL-134 — the CD deploy must run the pre-swap smoke THAT SHIPS IN THE IMAGE IT IS DEPLOYING,
 * and must refuse to deploy at all when it cannot.
 *
 * The regression this locks: `deploy-on-host.sh` used to carry an inline copy of the smoke. The repo
 * hardened the smoke, the host kept running its own older function, and the new assertion never
 * executed in production while CI stayed green. A gate that silently is not there is worse than no
 * gate, because the repo reads as gated.
 *
 * Every RED here is constructed AT THE SOURCE — a real image fixture with a missing/empty/failing
 * smoke, run through the REAL `deploy-on-host.sh` — rather than by asserting on a string. See
 * docs/solutions/best-practices/a-test-whose-stub-guarantees-the-assertion-proves-nothing.md.
 *
 * `docker` and `curl` are replaced by fakes on PATH, so the script under test is the real one and
 * only the daemon is simulated. `sha256sum` is shimmed too: the script is Linux-only by design (it
 * runs as the prod host's forced command) and macOS ships `shasum` instead.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname;
const DIGEST = "a".repeat(64);
const IMAGE = `ghcr.io/testowner/browse-gateway@sha256:${DIGEST}`;

/**
 * Build a throwaway deploy host: real deploy-on-host.sh + real launch-http.sh path, a fake docker
 * whose behaviour is driven by files in the sandbox, and a fake launcher that records that the SWAP
 * happened. `imageSmoke: null` models an image that does not carry the script at all.
 */
function sandbox({ imageSmoke, imageLauncher = null, hostSmoke = "#!/usr/bin/env bash\ntouch \"$MARK_DIR/HOST-SMOKE-RAN\"\nexit 0\n" }) {
  const dir = mkdtempSync(join(tmpdir(), "bgw-deploy-"));
  const bin = join(dir, "bin");
  const deploy = join(dir, "deploy");
  const marks = join(dir, "marks");
  for (const d of [bin, deploy, marks]) mkdirSync(d, { recursive: true });

  // The real script under test, plus a host-side smoke that must NEVER run on the CD path.
  copyFileSync(join(repoRoot, "scripts/deploy/deploy-on-host.sh"), join(deploy, "deploy-on-host.sh"));
  chmodSync(join(deploy, "deploy-on-host.sh"), 0o755);
  writeFileSync(join(deploy, "preswap-smoke.sh"), hostSmoke);
  chmodSync(join(deploy, "preswap-smoke.sh"), 0o755);

  // Fake launcher: the SWAP marker. Its absence is how a RED proves "live container untouched".
  writeFileSync(join(deploy, "launch-http.sh"),
    `#!/usr/bin/env bash\necho "$BGW_DEPLOY_IMAGE" >> "${marks}/LAUNCHED"\nexit 0\n`);
  chmodSync(join(deploy, "launch-http.sh"), 0o755);

  // What the "image" carries at /app/scripts/deploy/preswap-smoke.sh. null = absent.
  if (imageSmoke !== null) writeFileSync(join(dir, "image-smoke.sh"), imageSmoke);
  if (imageLauncher !== null) writeFileSync(join(dir, "image-launch.sh"), imageLauncher);

  // Fake docker. `create` writes its warning to STDERR on purpose — folding it into the container id
  // is a defect this test would otherwise not see.
  writeFileSync(join(bin, "docker"), `#!/usr/bin/env bash
case "$1" in
  pull) exit 0 ;;
  create)
    echo "WARNING: IPv4 forwarding is disabled. Networking will not work." >&2
    echo "deadbeefcafe"
    exit 0 ;;
  cp)
    src="\${2#*:}"
    if [ "$src" = "/app/scripts/deploy/preswap-smoke.sh" ] && [ -f "${dir}/image-smoke.sh" ]; then
      cp "${dir}/image-smoke.sh" "$3"; exit 0
    fi
    if [ "$src" = "/app/scripts/deploy/launch-http.sh" ] && [ -f "${dir}/image-launch.sh" ]; then
      cp "${dir}/image-launch.sh" "$3"; exit 0
    fi
    echo "Error: No such container:path: \${2}" >&2; exit 1 ;;
  rm|rmi) exit 0 ;;
  images) exit 0 ;;
  logs) echo "gateway listening dnsRebindProtection=true version=1.0.0+ac4ec664bd8c deploy=ac4ec664bd8c mode=http" ; exit 0 ;;
  inspect)
    case "$*" in
      *State.Status*) echo "running/true/0" ;;
      *) echo "sha256:feedfacefeedface" ;;
    esac
    exit 0 ;;
  run) exit 0 ;;
esac
exit 0
`);
  writeFileSync(join(bin, "curl"), `#!/usr/bin/env bash\necho 401\nexit 0\n`);
  // Linux-only script; macOS has shasum, not sha256sum.
  writeFileSync(join(bin, "sha256sum"), `#!/usr/bin/env bash\nshasum -a 256 "$@" 2>/dev/null || echo "0000000000000000  $1"\n`);
  for (const f of ["docker", "curl", "sha256sum"]) chmodSync(join(bin, f), 0o755);

  writeFileSync(join(dir, "config.env"), [
    `BGW_EXPECTED_REPO=ghcr.io/testowner/browse-gateway`,
    `BGW_BIND_ADDR=127.0.0.1`,
    `BGW_HOST_PORT=8080`,
    `GATE_LOG=${join(dir, "gate.log")}`,
  ].join("\n") + "\n");

  return { dir, deploy, marks };
}

function runDeploy(sb) {
  return spawnSync("bash", [join(sb.deploy, "deploy-on-host.sh"), IMAGE], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(sb.dir, "bin")}:${process.env.PATH}`,
      BGW_DEPLOY_CONFIG: join(sb.dir, "config.env"),
      MARK_DIR: sb.marks,
      TMPDIR: sb.dir,
    },
  });
}

const swapped = (sb) => existsSync(join(sb.marks, "LAUNCHED"));

test("GREEN — the deploy runs the smoke that shipped in the image, not the host's copy", () => {
  const sb = sandbox({
    imageSmoke: `#!/usr/bin/env bash\ntouch "$MARK_DIR/IMAGE-SMOKE-RAN"\necho "$BGW_LAUNCH_SCRIPT" > "$MARK_DIR/LAUNCH_SCRIPT"\nexit 0\n`,
  });
  const r = runDeploy(sb);
  assert.equal(r.status, 0, `deploy failed:\n${r.stdout}\n${r.stderr}`);
  assert.ok(existsSync(join(sb.marks, "IMAGE-SMOKE-RAN")), "the IMAGE's smoke must be the one that ran");
  assert.ok(!existsSync(join(sb.marks, "HOST-SMOKE-RAN")), "the host's stale copy must NOT run on the CD path");
  assert.ok(swapped(sb), "a passing smoke must proceed to the swap");
  assert.match(r.stdout, /pre-swap smoke sourced from image:/, "provenance must be visible in the deploy log");
  // The extracted smoke must be pointed at the HOST launcher — the one the swap itself will use.
  assert.equal(readFileSync(join(sb.marks, "LAUNCH_SCRIPT"), "utf8").trim(), join(sb.deploy, "launch-http.sh"));
});

test("RED — an image with NO smoke script aborts the deploy, live container untouched", () => {
  const sb = sandbox({ imageSmoke: null });
  const r = runDeploy(sb);
  assert.notEqual(r.status, 0, "a missing gate must never read as a passing one");
  assert.match(r.stderr, /does not carry/);
  assert.ok(!swapped(sb), "no swap may happen when the smoke could not be sourced");
});

test("RED — an EMPTY smoke script in the image aborts the deploy", () => {
  const sb = sandbox({ imageSmoke: "" });
  const r = runDeploy(sb);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /extracted EMPTY/);
  assert.ok(!swapped(sb), "an empty gate is an absent gate");
});

test("RED — a FAILING image smoke aborts the deploy before the swap", () => {
  const sb = sandbox({ imageSmoke: `#!/usr/bin/env bash\necho "smoke: boot line carries no well-formed version=" >&2\nexit 1\n` });
  const r = runDeploy(sb);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /PRE-SWAP SMOKE FAILED/);
  assert.ok(!swapped(sb), "the live container must be untouched when the smoke fails");
});

test("the launcher drift NOTE fires when the host copy and the image copy differ", () => {
  // The host owns launch-http.sh, so a divergence is informational rather than fatal — but it must be
  // SAID. Silent drift in exactly this directory is what made the smoke assertion inert for a day.
  const sb = sandbox({
    imageSmoke: `#!/usr/bin/env bash\nexit 0\n`,
    imageLauncher: `#!/usr/bin/env bash\n# a newer launcher than the host's\nexit 0\n`,
  });
  const r = runDeploy(sb);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /host launch-http\.sh differs from the image's copy/);
  assert.ok(swapped(sb), "a drift NOTE must not block the deploy");
});

test("no drift NOTE when the host launcher and the image's copy are identical", () => {
  const sb = sandbox({ imageSmoke: `#!/usr/bin/env bash\nexit 0\n` });
  // Same bytes the sandbox wrote for the host launcher.
  writeFileSync(join(sb.dir, "image-launch.sh"),
    readFileSync(join(sb.deploy, "launch-http.sh"), "utf8"));
  const r = runDeploy(sb);
  assert.equal(r.status, 0);
  assert.ok(!/differs from the image's copy/.test(r.stderr), "identical launchers must be silent");
});

test("a PRE-VIL-134 smoke (no BGW_LAUNCH_SCRIPT support) still finds a launcher and deploys", () => {
  // Older images carry a smoke that resolves "$HERE/launch-http.sh" and ignores BGW_LAUNCH_SCRIPT.
  // Extracting into a bare temp FILE would leave that smoke with no launcher beside it, so any
  // manual redeploy of an older digest would abort with a confusing "launcher not executable".
  // The extraction dir therefore carries a copy of the HOST launcher under the name it expects.
  const sb = sandbox({
    imageSmoke: [
      `#!/usr/bin/env bash`,
      `set -euo pipefail`,
      `HERE="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"`,
      `[ -x "$HERE/launch-http.sh" ] || { echo "smoke: launcher not executable: $HERE/launch-http.sh" >&2; exit 2; }`,
      `"$HERE/launch-http.sh"`,
      `touch "$MARK_DIR/OLD-SMOKE-FOUND-LAUNCHER"`,
      `exit 0`,
    ].join("\n") + "\n",
  });
  const r = runDeploy(sb);
  assert.equal(r.status, 0, `an image predating BGW_LAUNCH_SCRIPT must still deploy:\n${r.stdout}\n${r.stderr}`);
  assert.ok(existsSync(join(sb.marks, "OLD-SMOKE-FOUND-LAUNCHER")), "the old smoke must resolve a launcher beside itself");
  assert.ok(swapped(sb), "the deploy must proceed to the swap");
});
