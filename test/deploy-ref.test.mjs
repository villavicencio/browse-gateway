/**
 * VIL-291 — `deploy-ref.sh`, the operator's one-command deploy: <commit or tag> -> pinned digest ->
 * deploy-on-host.sh.
 *
 * What it must never do is deploy something other than what was asked for. Each refusal below is
 * constructed at the source — a fake registry/daemon that really returns the wrong revision, a foreign
 * digest, two digests — and the proof of "refused" is that the fake deploy-on-host.sh beside it was
 * NEVER invoked, not a string match alone.
 *
 * `docker` and `curl` are fakes on PATH; deploy-ref.sh is the real script. deploy-on-host.sh is a fake
 * that records the image it was handed, because this script's whole contract is what it hands over.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname;
const REPO = "ghcr.io/testowner/browse-gateway";
const SHA = "768af5944bfc639a68ebf33e6e5829efb360e7a9";
const DIGEST = "4".repeat(64);
const PINNED = `${REPO}@sha256:${DIGEST}`;

/**
 * @param repoDigests what `docker image inspect` lists as RepoDigests
 * @param revision    the image's org.opencontainers.image.revision label ("" = no label)
 * @param deployRc    exit status of the fake deploy-on-host.sh
 * @param imageDeployOnHost contents the IMAGE carries for deploy-on-host.sh (null = same as host)
 * @param downDuringDeployMs if set, /mcp answers 000 for this long while the fake deploy "swaps"
 */
function sandbox({ repoDigests = [PINNED], revision = SHA, deployRc = 0, imageDeployOnHost = null, downDuringDeployMs = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bgw-deploy-ref-"));
  const bin = join(dir, "bin");
  const deploy = join(dir, "deploy");
  const marks = join(dir, "marks");
  const image = join(dir, "image");
  for (const d of [bin, deploy, marks, image]) mkdirSync(d, { recursive: true });

  copyFileSync(join(repoRoot, "scripts/deploy/deploy-ref.sh"), join(deploy, "deploy-ref.sh"));
  chmodSync(join(deploy, "deploy-ref.sh"), 0o755);
  const hostDeploy =
    `#!/usr/bin/env bash\necho "$1" >> "${marks}/DEPLOYED"\n` +
    (downDuringDeployMs ? `touch "${marks}/DOWN"; perl -e 'select(undef,undef,undef,${downDuringDeployMs / 1000})'; rm -f "${marks}/DOWN"\n` : "") +
    `exit ${deployRc}\n`;
  writeFileSync(join(deploy, "deploy-on-host.sh"), hostDeploy);
  chmodSync(join(deploy, "deploy-on-host.sh"), 0o755);

  // What the image carries at /app/scripts/deploy/: by default byte-identical to the host copies.
  writeFileSync(join(image, "deploy-on-host.sh"), imageDeployOnHost ?? hostDeploy);
  copyFileSync(join(repoRoot, "scripts/deploy/deploy-ref.sh"), join(image, "deploy-ref.sh"));
  writeFileSync(join(dir, "repo-digests"), repoDigests.map((d) => d + "\n").join(""));

  writeFileSync(join(bin, "docker"), `#!/usr/bin/env bash
echo "$*" >> "${marks}/docker-calls"
case "$1" in
  pull) echo "$*" >> "${marks}/pulls"; exit 0 ;;
  image)
    case "$*" in
      *RepoDigests*) cat "${dir}/repo-digests" ;;
      *image.revision*) ${revision ? `echo "${revision}"` : `echo "<no value>"`} ;;
    esac
    exit 0 ;;
  create) echo "stagedcid"; exit 0 ;;
  cp)
    f="\${2##*/}"
    [ -f "${image}/$f" ] && { cp "${image}/$f" "$3"; exit 0; }
    exit 1 ;;
  rm) exit 0 ;;
  inspect)
    case "$*" in
      *"-f {{.Image}}"*) echo "sha256:feedface" ;;
      *) echo "${REPO}@sha256:${"9".repeat(64)} id=sha256:feedface started=2026-10-06T00:00:00Z restarts=0" ;;
    esac
    exit 0 ;;
  logs)
    case "$*" in
      *-f*) echo "old container log line" ;;
      *) echo "gateway listening dnsRebindProtection=true version=1.1.0 search=off mode=http" ;;
    esac
    exit 0 ;;
esac
exit 0
`);
  writeFileSync(join(bin, "curl"), `#!/usr/bin/env bash\nif [ -e "${marks}/DOWN" ]; then echo 000; exit 7; fi\necho 401\n`);
  for (const f of ["docker", "curl"]) chmodSync(join(bin, f), 0o755);

  writeFileSync(join(dir, "config.env"), [
    `BGW_EXPECTED_REPO=${REPO}`,
    "BGW_BIND_ADDR=127.0.0.1",
    "BGW_HOST_PORT=8080",
    `GATE_LOG=${join(dir, "logs", "gate.log")}`,
  ].join("\n") + "\n");
  mkdirSync(join(dir, "logs"));
  return { dir, deploy, marks };
}

function run(sb, ref) {
  const args = [join(sb.deploy, "deploy-ref.sh")];
  if (ref !== undefined) args.push(ref);
  const r = spawnSync("bash", args, {
    encoding: "utf8",
    env: { ...process.env, PATH: `${join(sb.dir, "bin")}:${process.env.PATH}`, BGW_DEPLOY_CONFIG: join(sb.dir, "config.env"), TMPDIR: sb.dir },
  });
  return { ...r, out: r.stdout + r.stderr };
}

const deployed = (sb) => {
  const f = join(sb.marks, "DEPLOYED");
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : [];
};
const pulls = (sb) => {
  const f = join(sb.marks, "pulls");
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : [];
};

test("a short sha resolves to the pinned digest and is handed to deploy-on-host.sh", () => {
  const sb = sandbox();
  const r = run(sb, "768af59");
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(pulls(sb), [`pull -q ${REPO}:768af59`]);
  assert.deepEqual(deployed(sb), [PINNED], "deploy-on-host.sh gets the DIGEST, never the tag");
  assert.match(r.out, new RegExp(`revision ${SHA}`));
  assert.match(r.out, /deploy-ref: boot line: version=1\.1\.0 search=off/);
  assert.match(r.out, /deploy-ref: blip: none observed/);
});

test("a full 40-hex sha pulls the CI short-sha tag and must match the label exactly", () => {
  const sb = sandbox();
  const r = run(sb, SHA);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(pulls(sb), [`pull -q ${REPO}:768af59`]);
  assert.deepEqual(deployed(sb), [PINNED]);
});

test("REFUSED: the image was built from a different commit than the one asked for", () => {
  const sb = sandbox({ revision: "b7b5ca5" + "0".repeat(33) });
  const r = run(sb, "768af59");
  assert.equal(r.status, 1);
  assert.match(r.out, /refused — .* carries revision 'b7b5ca5/);
  assert.deepEqual(deployed(sb), [], "nothing was deployed");
});

test("REFUSED: a sha ref whose image has no revision label cannot be proven", () => {
  const sb = sandbox({ revision: "" });
  const r = run(sb, "768af59");
  assert.equal(r.status, 1);
  assert.match(r.out, /carries revision '<none>'/);
  assert.deepEqual(deployed(sb), []);
});

test("a non-sha tag is deployed by digest and its revision reported, not checked", () => {
  const sb = sandbox({ revision: "" });
  const r = run(sb, "latest");
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(deployed(sb), [PINNED]);
  assert.match(r.out, /latest -> .* \(revision <none>\)/);
});

test("REFUSED: no digest of OUR package (only a foreign repo's)", () => {
  const sb = sandbox({ repoDigests: [`ghcr.io/attacker/browse-gateway@sha256:${DIGEST}`, `${REPO}-evil@sha256:${DIGEST}`] });
  const r = run(sb, "768af59");
  assert.equal(r.status, 1);
  assert.match(r.out, /expected exactly one .* found 0/);
  assert.deepEqual(deployed(sb), []);
});

test("REFUSED: two different digests of our package is ambiguous", () => {
  const sb = sandbox({ repoDigests: [PINNED, `${REPO}@sha256:${"5".repeat(64)}`] });
  const r = run(sb, "768af59");
  assert.equal(r.status, 1);
  assert.match(r.out, /found 2/);
  assert.deepEqual(deployed(sb), []);
});

test("REFUSED before touching docker: a ref that is not a sha or a tag", () => {
  for (const bad of ["x;touch /tmp/pwned", "../etc", "-rf", "a b", ""]) {
    const sb = sandbox();
    const r = run(sb, bad);
    assert.equal(r.status, 2, `'${bad}': ${r.out}`);
    assert.equal(existsSync(join(sb.marks, "docker-calls")), false, `'${bad}' must not reach docker`);
    assert.deepEqual(deployed(sb), []);
  }
});

test("a failed deploy propagates its exit status and still reports what is running", () => {
  const sb = sandbox({ deployRc: 1 });
  const r = run(sb, "768af59");
  assert.equal(r.status, 1);
  assert.deepEqual(deployed(sb), [PINNED]);
  assert.match(r.out, /deploy-ref: result: exit 1/);
  assert.match(r.out, /deploy-ref: now: /);
});

test("drift NOTE when the host's deploy-on-host.sh differs from the image's copy", () => {
  const same = run(sandbox(), "768af59");
  assert.doesNotMatch(same.out, /NOTE — host deploy-on-host\.sh differs/);
  const drifted = run(sandbox({ imageDeployOnHost: "#!/usr/bin/env bash\n# newer\nexit 0\n" }), "768af59");
  assert.equal(drifted.status, 0, drifted.out);
  assert.match(drifted.out, /NOTE — host deploy-on-host\.sh differs from the copy in 768af59's image/);
});

test("the blip is measured while /mcp is actually down during the swap", () => {
  const sb = sandbox({ downDuringDeployMs: 2200 });
  const r = run(sb, "768af59");
  assert.equal(r.status, 0, r.out);
  const m = r.out.match(/blip: \/mcp unavailable for ~(\d+) s \((\d+) failed probes/);
  assert.ok(m, `blip line: ${r.out}`);
  assert.ok(Number(m[1]) >= 2 && Number(m[2]) >= 3, `measured ~${m[1]} s with ${m[2]} failed probes for a 2.2 s outage`);
});
