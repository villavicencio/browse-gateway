/**
 * Step 8 of `deploy-on-host.sh` — image retention after a SUCCESSFUL deploy keeps exactly the running
 * image and the rollback anchor (the image that was running before the swap: last known good).
 *
 * The REAL script runs against a fake docker that lists seven project images, reports a rollback anchor
 * distinct from the new image, and records every `rmi`. The test asserts on what was actually removed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname;
const id = (c) => `sha256:${c.repeat(64)}`;
const IMAGE = `ghcr.io/testowner/browse-gateway@${id("a")}`;

/** Newest first by creation time; `running` is what the container reports AFTER the swap, `anchor`
 *  what it reported BEFORE (the script's ROLLBACK_IMAGE). */
const IMAGES = [
  [id("a"), "2026-10-07 12:00:00 -0700 PDT"], // the image just deployed
  [id("b"), "2026-10-06 12:00:00 -0700 PDT"], // the rollback anchor
  [id("c"), "2026-10-05 12:00:00 -0700 PDT"],
  [id("d"), "2026-10-04 12:00:00 -0700 PDT"],
  [id("e"), "2026-10-03 12:00:00 -0700 PDT"],
  [id("f"), "2026-10-02 12:00:00 -0700 PDT"],
  [id("g"), "2026-10-01 12:00:00 -0700 PDT"],
];

function sandbox({ anchor, running }) {
  const dir = mkdtempSync(join(tmpdir(), "bgw-retention-"));
  const bin = join(dir, "bin");
  const deploy = join(dir, "deploy");
  const marks = join(dir, "marks");
  for (const d of [bin, deploy, marks]) mkdirSync(d, { recursive: true });
  copyFileSync(join(repoRoot, "scripts/deploy/deploy-on-host.sh"), join(deploy, "deploy-on-host.sh"));
  chmodSync(join(deploy, "deploy-on-host.sh"), 0o755);
  writeFileSync(join(deploy, "launch-http.sh"), `#!/usr/bin/env bash\nexit 0\n`);
  chmodSync(join(deploy, "launch-http.sh"), 0o755);
  writeFileSync(join(dir, "image-smoke.sh"), "#!/usr/bin/env bash\nexit 0\n");
  // Shuffled so the script's own sort is what orders them.
  const listing = [...IMAGES].reverse().map(([i, c]) => `${i} ${c}`).join("\n");
  writeFileSync(join(bin, "docker"), `#!/usr/bin/env bash
case "$1" in
  pull|rm|run) exit 0 ;;
  rmi) echo "$2" >> "${marks}/rmi"; exit 0 ;;
  images) printf '%b\\n' "${listing.replace(/\n/g, "\\n")}"; exit 0 ;;
  create) echo "deadbeefcafe"; exit 0 ;;
  cp)
    if [ "\${2#*:}" = "/app/scripts/deploy/preswap-smoke.sh" ]; then cp "${dir}/image-smoke.sh" "$3"; exit 0; fi
    exit 1 ;;
  logs) echo "gateway listening dnsRebindProtection=true version=1.0.0 mode=http"; exit 0 ;;
  inspect)
    case "$*" in
      *State.Status*) echo "running/true/0" ;;
      *'{{.Image}}'*)
        # First .Image read is the pre-swap rollback anchor; later reads are the swapped-in container.
        n=$(( $(cat "${marks}/image-reads" 2>/dev/null || echo 0) + 1 )); echo "$n" > "${marks}/image-reads"
        if [ "$n" -eq 1 ]; then echo "${anchor}"; else echo "${running}"; fi ;;
      *) echo "${running}" ;;
    esac
    exit 0 ;;
esac
exit 0
`);
  writeFileSync(join(bin, "curl"), "#!/usr/bin/env bash\necho 401\n");
  writeFileSync(join(bin, "sha256sum"), `#!/usr/bin/env bash\nshasum -a 256 "$@" 2>/dev/null || echo "0000000000000000  $1"\n`);
  writeFileSync(join(bin, "sleep"), "#!/usr/bin/env bash\nexit 0\n");
  for (const f of ["docker", "curl", "sha256sum", "sleep"]) chmodSync(join(bin, f), 0o755);
  writeFileSync(join(dir, "config.env"), [
    "BGW_EXPECTED_REPO=ghcr.io/testowner/browse-gateway",
    "BGW_BIND_ADDR=127.0.0.1",
    "BGW_HOST_PORT=8080",
    `GATE_LOG=${join(dir, "gate.log")}`,
  ].join("\n") + "\n");
  return { dir, deploy, marks };
}

function runDeploy(sb) {
  const r = spawnSync("bash", [join(sb.deploy, "deploy-on-host.sh"), IMAGE], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${join(sb.dir, "bin")}:${process.env.PATH}`, BGW_DEPLOY_CONFIG: join(sb.dir, "config.env"), TMPDIR: sb.dir },
  });
  const f = join(sb.marks, "rmi");
  return { r, removed: existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : [] };
}

test("retention keeps ONLY the running image and the rollback anchor; every older project image is removed", () => {
  const sb = sandbox({ anchor: id("b"), running: id("a") });
  const { r, removed } = runDeploy(sb);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /deploy: SUCCESS/);
  assert.deepEqual(removed.sort(), [id("c"), id("d"), id("e"), id("f"), id("g")].sort());
  assert.ok(!removed.includes(id("a")), "the running image must never be removed");
  assert.ok(!removed.includes(id("b")), "the rollback anchor (last known good) must never be removed");
});

test("the rollback anchor survives even when it is NOT the second-newest image", () => {
  // e.g. a deploy that rolled forward past a bad image: the anchor is older than an image in between.
  const sb = sandbox({ anchor: id("e"), running: id("a") });
  const { removed } = runDeploy(sb);
  assert.ok(!removed.includes(id("e")), "the anchor is kept by its explicit skip, not by its position");
  assert.ok(removed.includes(id("b")), "the newer-but-not-anchor image goes");
  assert.ok(!removed.includes(id("a")));
});

test("a same-digest redeploy (anchor == running) keeps exactly that one image", () => {
  const sb = sandbox({ anchor: id("a"), running: id("a") });
  const { removed } = runDeploy(sb);
  assert.deepEqual(removed.sort(), [id("b"), id("c"), id("d"), id("e"), id("f"), id("g")].sort());
});
