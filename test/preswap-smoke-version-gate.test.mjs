/**
 * VIL-134 / U4 — the pre-swap smoke's `version=` assertion, exercised through the REAL
 * scripts/deploy/preswap-smoke.sh.
 *
 * This is the assertion that had never run: it lived only in the repo while production executed an
 * older inline copy. Sourcing the smoke from the image (see deploy-smoke-sourcing.test.mjs) is what
 * makes it reachable; this file is what proves it BITES once reached, without deploying a
 * deliberately-broken image to production.
 *
 * The RED is constructed at the source — a real boot line fed through the real grep in the real
 * script — not by re-implementing the pattern in JS and asserting on that. A guard whose stub
 * guarantees the assertion proves nothing.
 *
 * The pattern under test mirrors REPORTED_VERSION in src/mcp/version.ts: a bare semver core,
 * optionally + a 12-lowercase-hex build stamp, anchored by spaces on both sides.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname;
const SMOKE = join(repoRoot, "scripts/deploy/preswap-smoke.sh");

/** Run the real smoke against a fake daemon whose container emits `bootLine`. */
function smokeWith(bootLine) {
  const dir = mkdtempSync(join(tmpdir(), "bgw-smoke-"));
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });

  writeFileSync(join(bin, "docker"), `#!/usr/bin/env bash
case "$1" in
  logs) cat "${dir}/bootline"; exit 0 ;;
  inspect)
    case "$*" in
      *State.Status*) echo "running/true/0" ;;
      *State.Running*) echo "true" ;;
      *) echo "sha256:feedfacefeedface" ;;
    esac
    exit 0 ;;
  rm) exit 0 ;;
esac
exit 0
`);
  writeFileSync(join(bin, "curl"), `#!/usr/bin/env bash\necho 401\nexit 0\n`);
  for (const f of ["docker", "curl"]) chmodSync(join(bin, f), 0o755);

  writeFileSync(join(dir, "bootline"), bootLine + "\n");
  writeFileSync(join(dir, "launch.sh"), `#!/usr/bin/env bash\nexit 0\n`);
  chmodSync(join(dir, "launch.sh"), 0o755);
  writeFileSync(join(dir, "config.env"), "BGW_BIND_ADDR=127.0.0.1\nBGW_HOST_PORT=8080\n");

  return spawnSync("bash", [SMOKE], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      BGW_DEPLOY_CONFIG: join(dir, "config.env"),
      BGW_LAUNCH_SCRIPT: join(dir, "launch.sh"),
      BGW_DEPLOY_IMAGE: "ghcr.io/testowner/browse-gateway@sha256:" + "a".repeat(64),
      BGW_SMOKE_BOOT_TIMEOUT: "3",
    },
  });
}

const READY = "gateway listening dnsRebindProtection=true";

test("PASS — a stamped version (semver + 12 hex) satisfies the gate", () => {
  const r = smokeWith(`${READY} version=1.0.0+ac4ec664bd8c deploy=ac4ec664bd8c mode=http`);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /smoke: OK/);
});

test("PASS — an unstamped local build (bare semver) still satisfies the gate", () => {
  const r = smokeWith(`${READY} version=1.0.0 deploy=none mode=http`);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
});

test("RED — a boot line with no version= at all fails the smoke", () => {
  const r = smokeWith(`${READY} deploy=none mode=http`);
  assert.notEqual(r.status, 0, "a missing version signal must abort the deploy");
  assert.match(r.stderr, /no well-formed version=/);
});

test("RED — a raw commit sha as the version fails the smoke", () => {
  // The exact leak U4 exists to stop: an infrastructure identifier reaching a consumer. A prefix
  // match would let this through, which is why the pattern is anchored on the trailing space.
  const r = smokeWith(`${READY} version=1.0.0+ac4ec664bd8c9e2f1a3b4c5d6e7f8091a2b3c4d5 deploy=x mode=http`);
  assert.notEqual(r.status, 0, "a 40-hex commit sha must not satisfy the 12-hex build stamp");
  assert.match(r.stderr, /no well-formed version=/);
});

test("RED — leading zeros are not a semver core", () => {
  const r = smokeWith(`${READY} version=1.02.0 deploy=none mode=http`);
  assert.notEqual(r.status, 0, "semver forbids leading zeros; the gate must too");
});

test("RED — a non-numeric version fails the smoke", () => {
  const r = smokeWith(`${READY} version=main deploy=none mode=http`);
  assert.notEqual(r.status, 0);
});
