/**
 * The single source of the gateway's contract version and deployment identity (VIL-112, plan U1).
 *
 * Four call sites used to hardcode `"0.1.0"` independently — two launchers, the server default, and a
 * measurement script — so the value a consumer saw was a literal nobody maintained. This module
 * replaces all four.
 *
 * TWO IDENTIFIERS, DELIBERATELY DISTINCT (KTD9). Label them wherever they appear; this repo has
 * already produced one wrong conclusion by comparing two identifier kinds that were never comparable
 * (see docs/solutions/best-practices/comparing-image-id-to-manifest-digest-is-not-a-drift-check.md):
 *   - `contractVersion` — the semver core from package.json. Governed by the consumer-facing MCP
 *     contract (tool names, argument shapes, response envelopes, failure classes), never by repo churn.
 *   - `deployId` — an OPAQUE build stamp. It answers "did the same deployment answer both my calls?"
 *     and nothing else. It is NOT a commit ref, NOT a manifest digest, NOT an image ID.
 *
 * WHY THE VERSION IS READ FROM DISK RATHER THAN IMPORTED. `tsconfig.json` sets `rootDir: "src"` and
 * `include: ["src"]`; importing `../../package.json` widens either one and reshapes `dist/`, which
 * breaks the `bin` path and every test's `../dist/...` import. And it is deliberately NOT an env var:
 * container env is frozen at create and is settable by the `--apply` provisioning path WITHOUT
 * changing the image, so an env-sourced version could report a build the process is not running.
 * Reading the shipped manifest keeps the reported version a property of the artifact (R4).
 *
 * FAIL-CLOSED. An unreadable or malformed manifest THROWS. A gateway that cannot state its contract
 * version does not serve. Callers must resolve this at BOOT — see the note in http-main.ts about why
 * resolving inside the per-connection callback is not fail-closed at all.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** A bare semver core. `package.json` carries this and only this — build metadata is stamped, not authored. */
const SEMVER_CORE = /^\d+\.\d+\.\d+$/;

/** The build stamp: fixed-width lowercase hex. Narrow ON PURPOSE — see `reported` below. */
const DEPLOY_ID = /^[0-9a-f]{12}$/;

/** Image-root filename holding the deploy stamp. Written by docker/Dockerfile at build time. */
const DEPLOY_STAMP_FILE = ".deploy-id";

export interface GatewayVersion {
  /** Semver core from the shipped manifest, e.g. `"1.0.0"`. */
  readonly contractVersion: string;
  /** The opaque build stamp, or `undefined` when this image was built without one (local/dev builds). */
  readonly deployId?: string;
  /**
   * What a consumer sees on `serverInfo.version`: `"1.0.0+a1b2c3d4e5f6"`, or a bare `"1.0.0"` when
   * unstamped. Build metadata is valid semver (spec §10), which is why the deploy id can ride here
   * at all — and why the opacity guard's pattern is a narrow
   * `^\d+\.\d+\.\d+(\+[0-9a-f]{12})?$` rather than "anything after a plus".
   */
  readonly reported: string;
}

/** `/app` in the image; the repo root in a dev checkout. `dist/mcp/version.js` sits two levels down. */
const defaultRoot = (): string => join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Read the deploy stamp. ABSENT is fine and yields `undefined` — a local `docker build` with no
 * secret produces an unstamped image, and that must not be a boot failure or nobody can build.
 * MALFORMED throws: a corrupt stamp is worse than no stamp, because it is a value a consumer would
 * treat as an identity. Strictness for production lives at the deploy gate (the pre-swap smoke
 * requires a stamped boot line), not here.
 */
function readDeployStamp(root: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(root, DEPLOY_STAMP_FILE), "utf8");
  } catch {
    return undefined; // unstamped image — expected for local and CI-less builds
  }
  const stamp = raw.trim();
  if (!DEPLOY_ID.test(stamp)) {
    throw new Error(
      `${DEPLOY_STAMP_FILE} is present but malformed — a deploy stamp must be 12 lowercase hex characters. Refusing to boot rather than reporting an identity that is not one.`,
    );
  }
  return stamp;
}

/**
 * Resolve the gateway's reported identity. Throws on an unreadable/malformed/unversioned manifest.
 *
 * `root` is injectable so a guard can construct its RED **at the source** — pointing the resolver at
 * a directory with no manifest proves the boot actually refuses, rather than proving a regex fires on
 * a bad string handed to it. (See
 * docs/solutions/best-practices/a-test-whose-stub-guarantees-the-assertion-proves-nothing.md.)
 */
export function resolveGatewayVersion(root: string = defaultRoot()): GatewayVersion {
  const manifest = join(root, "package.json");
  let raw: string;
  try {
    raw = readFileSync(manifest, "utf8");
  } catch {
    throw new Error(`cannot read ${manifest} — a gateway that cannot state its contract version does not serve. Refusing to boot.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${manifest} is not valid JSON — cannot resolve the contract version. Refusing to boot.`);
  }

  const version = (parsed as { version?: unknown } | null)?.version;
  if (typeof version !== "string" || !SEMVER_CORE.test(version)) {
    throw new Error(
      `${manifest} carries no usable "version" — expected a bare semver core like "1.0.0". Refusing to boot.`,
    );
  }

  const deployId = readDeployStamp(root);
  return {
    contractVersion: version,
    deployId,
    reported: deployId ? `${version}+${deployId}` : version,
  };
}
