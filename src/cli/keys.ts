/**
 * `obscura keys new|list|revoke` (R3) — the admin key lifecycle, orchestrated over admin SSH
 * against the prod manifest (`consumers.json`) + env file pair.
 *
 * Write discipline (KTD9): every file lands atomically (temp + rename), and on `new` the
 * MANIFEST is written before the ENV file — an interrupt between the two leaves a
 * manifest-entry-without-token, which the gateway refuses to boot on (loud), never an
 * env-token-without-manifest (silent live credential). Mutations stage by default; the gateway
 * only reloads consumers at restart, so `--apply` restarts and waits healthy.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { parseConsumerManifest } from "../policy/consumer-config.js";
import { DEFAULT_GATEWAY_CONFIG, poolSizingError, positiveIntOr } from "../gateway/config.js";
import type { ConsumerManifestEntry } from "../policy/consumer-config.js";
import { ok, fail, note } from "./brand.js";
import type { Keychain } from "./keychain.js";
import type { RemoteShell } from "./prod-ssh.js";
import { readRemoteFile, writeRemoteFileAtomic, shQuote } from "./prod-ssh.js";
import { mintToken, tokenEnvKey, envKeyCollision } from "./token.js";

export interface KeysDeps {
  shell: RemoteShell;
  keychain: Keychain;
  /** Prod path to consumers.json. */
  manifestPath: string;
  /** Prod path to the BGW_* env file. */
  envFilePath: string;
  /** Gateway container name (for the post-apply activation check). */
  container: string;
  /** Gateway bind as prod loopback sees it — the `--apply` health probe target. */
  gatewayHost: string;
  /**
   * On-host command that RE-CREATES the gateway container, re-reading env + manifest (config
   * `applyCmd`). `docker restart` is NOT a substitute: container env is frozen at `docker run`,
   * so a restarted gateway boots the new manifest against the old env and crash-loops on the
   * fail-closed missing-token check — downing every consumer. Absent → `--apply` refuses.
   */
  applyCmd?: string;
  /**
   * On-host command that PRE-SWAP SMOKES the staged mutation BEFORE the re-create: boot the current
   * image against the just-written env + manifest on a throwaway port, exit non-zero if it can't come
   * up clean — typically `~/deploy/preswap-smoke.sh` directly (it defaults the smoked image to the
   * running container's, so no image plumbing is needed here). Run first so a malformed env or an
   * undersized `BGW_MAX_SESSIONS` floor aborts the apply with the LIVE container untouched, instead
   * of crash-looping it (the documented `keys --apply` crash-loop). REQUIRED for `--apply` (VIL-133):
   * the boot check it runs is the one authority on whether the staged config boots, so absent →
   * `--apply` refuses before anything is written.
   */
  smokeCmd?: string;
  out: (line: string) => void;
  /** Injectable for tests; defaults to a real sleep. */
  wait?: (ms: number) => Promise<void>;
  /** Test seam for the post-apply health deadline. */
  applyTimeoutMs?: number;
}

const CONSUMER_ID_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const APPLY_TIMEOUT_MS = 60_000;
const APPLY_POLL_MS = 2_000;
/** The re-create command itself gets a longer leash than the default ssh watchdog. */
const APPLY_CMD_TIMEOUT_MS = 120_000;
/** The smoke boots a throwaway container + polls for startup — give it a generous leash too. */
const SMOKE_CMD_TIMEOUT_MS = 120_000;

/** Match this consumer's token line in the env file (with or without `export`). */
function tokenLineRe(envKey: string): RegExp {
  return new RegExp(`^(export[ \\t]+)?${envKey}=`, "m");
}

/** The read-only slice of {@link KeysDeps} that consumer inspection needs (shared with status). */
export type ProdFilesDeps = Pick<KeysDeps, "shell" | "manifestPath" | "envFilePath">;

interface ProdFiles {
  entries: ConsumerManifestEntry[];
  envText: string;
}

/** Read + validate both prod files. Fail-loud on absence: the fleet always has them. */
async function readProdFiles(deps: ProdFilesDeps): Promise<ProdFiles> {
  const manifestText = await readRemoteFile(deps.shell, deps.manifestPath);
  if (manifestText === null) throw new Error(`remote manifest not found at ${deps.manifestPath}`);
  const envText = await readRemoteFile(deps.shell, deps.envFilePath);
  if (envText === null) throw new Error(`remote env file not found at ${deps.envFilePath}`);
  return { entries: parseConsumerManifest(manifestText), envText };
}

/**
 * VIL-133: the two raw pool-sizing values the launcher would forward, by letting bash source the env file
 * the way `launch-http.sh` does (`set -euo pipefail`, then `set -a; . file`), once, over the same shell
 * the CLI already uses to read and write that file, and inheriting that shell's environment as the
 * launcher inherits its caller's. The launcher forwards every shell variable named `BGW_*` (`compgen -v`,
 * exported or not), so these are what the gateway's boot check would see, as far as this shell can tell.
 *
 * Why bash and not a parser: every hand-written reader of this file missed some bash rule (inline
 * comments, quoted `#`, escaped spaces, `;#`, dead branches, `unset`, `+=`, ...), CodeRabbit and MergeWren
 * on #157. The launcher already executes this file on every deploy as the same account, so evaluating it
 * here adds no trust the deploy path does not already extend. The file's own output is discarded, never
 * echoed: it holds every consumer's token.
 *
 * Returns each raw value (`null` when unset), or `{ error }` when the file cannot be evaluated here.
 */
export async function resolveEnvSizing(
  shell: Pick<RemoteShell, "run">,
  envFilePath: string,
): Promise<{ maxSessions: string | null; perConsumerMax: string | null } | { error: string }> {
  const unset = "__bgw_unset__";
  const body =
    `set -euo pipefail; set -a; . "$1" >/dev/null 2>&1; ` +
    `builtin printf "%s\\n%s\\n" "\${BGW_MAX_SESSIONS-${unset}}" "\${BGW_PER_CONSUMER_MAX-${unset}}"`;
  const r = await shell.run(`bash -c ${shQuote(body)} _ ${shQuote(envFilePath)}`);
  if (r.code !== 0) return { error: `sourcing it the way the launcher does failed here (exit ${r.code})` };
  const out = r.stdout.split("\n");
  // Exactly two lines back, or the file did something this read cannot trust (exited early, or a value
  // holds a newline).
  if (out.length !== 3 || out[2] !== "") return { error: "the values could not be read back after sourcing it" };
  const value = (v: string): string | null => (v === unset ? null : v);
  return { maxSessions: value(out[0]!), perConsumerMax: value(out[1]!) };
}

/** The pool-floor pre-flight's verdict: proceed, refuse (a certain breach), or unchecked (warn, proceed). */
export type PoolFloorCheck = { kind: "ok" } | { kind: "refuse"; message: string } | { kind: "unchecked"; message: string };

/**
 * VIL-133: would the gateway BOOT with `consumerCount` consumers, given the sizing values the launcher
 * would forward ({@link resolveEnvSizing})? An EARLY, advisory check. The authority is the gateway's own
 * boot check (src/mcp/runtime.ts), which the pre-swap smoke runs against the real launcher and env file
 * before any swap: on every deploy, and on every `keys --apply` (which requires `smokeCmd`). So this
 * refuses only a breach it can compute, and otherwise says it could not check and leaves the decision to
 * that boot check, rather than refusing on doubt (the trade-off settled on #157).
 *
 * It mirrors boot exactly: the same parser ({@link positiveIntOr}), the same defaults for an unset or
 * invalid value ({@link DEFAULT_GATEWAY_CONFIG}), the same rule ({@link poolSizingError}).
 */
export function poolFloorPreflight(
  consumerCount: number,
  sizing: { maxSessions: string | null; perConsumerMax: string | null } | { error: string },
): PoolFloorCheck {
  if ("error" in sizing) {
    return {
      kind: "unchecked",
      message:
        `could not check the pool floor from the env file (${sizing.error}); the gateway's boot check ` +
        `decides at the next pre-swap smoke (\`keys --apply\`, or a deploy)`,
    };
  }
  const maxSessions = positiveIntOr(sizing.maxSessions ?? undefined, DEFAULT_GATEWAY_CONFIG.maxSessions);
  const perConsumerMax = positiveIntOr(sizing.perConsumerMax ?? undefined, DEFAULT_GATEWAY_CONFIG.perConsumerMax);
  const err = poolSizingError(consumerCount, perConsumerMax, maxSessions);
  if (!err) return { kind: "ok" };
  const required = consumerCount * perConsumerMax + 1;
  return {
    kind: "refuse",
    message:
      `refusing to add a consumer: the gateway would not boot — ${err}. Nothing was staged or changed. ` +
      `Either raise BGW_MAX_SESSIONS to at least ${required} in the env file (if the host has the memory for ` +
      `it), or free a slot first with \`obscura keys revoke <id> --apply\`.`,
  };
}

function manifestJson(entries: ConsumerManifestEntry[]): string {
  return `${JSON.stringify(entries, null, 2)}\n`;
}

function restartInstruction(deps: KeysDeps): string {
  return (
    "staged only — the gateway loads consumers when the container is RE-CREATED " +
    "(a plain `docker restart` keeps the old env); re-run with --apply once `applyCmd` is configured, " +
    "or re-create via your launch script on the host"
  );
}

/**
 * `--apply` needs both on-host commands, checked BEFORE anything is staged. `applyCmd` re-creates the
 * container; `smokeCmd` boots the staged config on a throwaway port first, and its boot check is the one
 * authority on whether that config boots (VIL-133), so an apply without it could crash-loop every consumer.
 */
const APPLY_GATES_MISSING = (key: "applyCmd" | "smokeCmd"): string =>
  key === "applyCmd"
    ? "--apply needs the `applyCmd` config key (or OBSCURA_APPLY_CMD): the on-host command that re-creates " +
      "the gateway container re-reading env + manifest (e.g. your launch-http.sh wrapper). " +
      "A plain `docker restart` cannot activate env changes, so obscura refuses to fake it. Nothing was staged."
    : "--apply needs the `smokeCmd` config key (or OBSCURA_SMOKE_CMD): the on-host pre-swap smoke that boots " +
      "the staged config on a throwaway port before the live re-create. Its boot check is what refuses a " +
      "config that would crash-loop the gateway, so obscura will not re-create without it. Nothing was staged.";

function requireApplyGates(deps: KeysDeps): void {
  if (!deps.applyCmd) throw new Error(APPLY_GATES_MISSING("applyCmd"));
  if (!deps.smokeCmd) throw new Error(APPLY_GATES_MISSING("smokeCmd"));
}

/**
 * Pre-swap smoke (`smokeCmd`, required for `--apply`): boot the current image against the just-staged env
 * + manifest on a throwaway port and ABORT the apply — live container untouched — if it can't come up
 * clean. This is the guard for the documented `keys --apply` crash-loop: an undersized
 * `BGW_MAX_SESSIONS` floor (or any malformed config) is caught here instead of after the live
 * re-create.
 */
async function preswapSmoke(deps: KeysDeps): Promise<void> {
  // requireApplyGates refuses this before anything is written; kept so no path can re-create unsmoked.
  if (!deps.smokeCmd) throw new Error("internal: --apply reached the re-create without smokeCmd; nothing was re-created");
  deps.out(note("pre-swap smoke — booting the current image against the staged config on a throwaway port"));
  const smoke = await deps.shell.run(
    `set -e; export DOCKER_HOST="\${DOCKER_HOST:-unix:///run/user/$(id -u)/docker.sock}"; ${deps.smokeCmd}`,
    undefined,
    { timeoutMs: SMOKE_CMD_TIMEOUT_MS },
  );
  if (smoke.code !== 0) {
    throw new Error(
      `pre-swap smoke FAILED (exit ${smoke.code}) — the staged config does not boot clean, so the live ` +
        `container was left untouched (NOT re-created). Fix the staged env/manifest and re-run. ` +
        `${smoke.stderr.trim() || smoke.stdout.trim()}`.trim(),
    );
  }
  deps.out(ok("pre-swap smoke passed — staged config boots clean"));
}

/**
 * Re-create the gateway container via the operator's `applyCmd`, wait for /mcp to answer 401
 * (the liveness signal), then confirm the consumer's token env actually changed inside the new
 * container — liveness alone can't tell a real reload from a stale-env no-op. A pre-swap smoke runs
 * FIRST (when configured) so a bad config aborts before the live container is touched.
 */
async function applyRecreate(deps: KeysDeps, expectEnvKey: { key: string; present: boolean }): Promise<void> {
  if (!deps.applyCmd) {
    throw new Error(
      "--apply needs the `applyCmd` config key (or OBSCURA_APPLY_CMD): the on-host command that re-creates " +
        "the gateway container re-reading env + manifest (e.g. your launch-http.sh wrapper). " +
        "A plain `docker restart` cannot activate env changes, so obscura refuses to fake it. " +
        "The change is staged — apply it manually or configure applyCmd and re-run.",
    );
  }
  // Gate the re-create on a throwaway-port boot of the staged config — abort here leaves the live
  // container running; only a clean smoke proceeds to the swap below.
  await preswapSmoke(deps);
  const wait = deps.wait ?? sleep;
  deps.out(note(`re-creating ${deps.container} via applyCmd — every consumer's session drops for ~10–20s`));
  const recreate = await deps.shell.run(
    `set -e; export DOCKER_HOST="\${DOCKER_HOST:-unix:///run/user/$(id -u)/docker.sock}"; ${deps.applyCmd}`,
    undefined,
    { timeoutMs: APPLY_CMD_TIMEOUT_MS },
  );
  if (recreate.code !== 0) {
    throw new Error(`applyCmd failed (exit ${recreate.code}): ${recreate.stderr.trim() || recreate.stdout.trim()}`);
  }
  const timeoutMs = deps.applyTimeoutMs ?? APPLY_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const probe = await deps.shell.run(
      `curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://${shQuote(deps.gatewayHost)}/mcp || echo 000`,
    );
    if (probe.stdout.trim() === "401") break;
    if (Date.now() >= deadline) {
      throw new Error(`gateway did not come back healthy within ${timeoutMs / 1000}s of the re-create`);
    }
    await wait(APPLY_POLL_MS);
  }
  // Activation check: the env var must be present (new) / gone (revoke) INSIDE the container.
  // printenv's exit code carries the answer; the value never leaves the container.
  const check = await deps.shell.run(
    `export DOCKER_HOST="\${DOCKER_HOST:-unix:///run/user/$(id -u)/docker.sock}"; ` +
      `docker exec ${shQuote(deps.container)} printenv ${expectEnvKey.key} >/dev/null 2>&1`,
  );
  const isPresent = check.code === 0;
  if (isPresent !== expectEnvKey.present) {
    throw new Error(
      expectEnvKey.present
        ? `gateway is up but ${expectEnvKey.key} is NOT in the container env — applyCmd did not re-read the env file`
        : `gateway is up but ${expectEnvKey.key} is STILL in the container env — applyCmd did not re-read the env file`,
    );
  }
  deps.out(ok(`gateway healthy after re-create — ${expectEnvKey.key} ${expectEnvKey.present ? "active" : "retired"}`));
}

export interface KeysNewOptions {
  allow?: string[];
  apply?: boolean;
}

/** Mint + install a consumer key: manifest entry, env token, Keychain copy, token printed ONCE. */
export async function keysNew(deps: KeysDeps, id: string, opts: KeysNewOptions = {}): Promise<void> {
  if (!CONSUMER_ID_RE.test(id)) {
    throw new Error(`invalid consumer id "${id}" (letters, digits, ".", "_", "-"; must start alphanumeric)`);
  }
  if (opts.apply) requireApplyGates(deps);
  const { entries, envText } = await readProdFiles(deps);
  if (entries.some((e) => e.id === id)) throw new Error(`consumer "${id}" already exists in the manifest`);
  const collision = envKeyCollision(id, entries.map((e) => e.id));
  if (collision) {
    throw new Error(`"${id}" collides with existing consumer "${collision}" on token env key ${tokenEnvKey(id)} — pick a more distinct id`);
  }
  const envKey = tokenEnvKey(id);
  if (tokenLineRe(envKey).test(envText)) {
    throw new Error(`env file already carries ${envKey} but "${id}" is not in the manifest — desync; resolve on the host before minting`);
  }

  // VIL-133: pre-flight the pool floor BEFORE anything is written. A consumer that pushes the floor past
  // BGW_MAX_SESSIONS does not degrade the gateway: the boot guard refuses to start it. A breach this can
  // compute is refused here, with or without --apply. Anything it cannot check is left to that boot guard,
  // which the pre-swap smoke runs before any re-create (--apply requires smokeCmd; a deploy always smokes).
  const floor = poolFloorPreflight(entries.length + 1, await resolveEnvSizing(deps.shell, deps.envFilePath));
  if (floor.kind === "refuse") throw new Error(floor.message);
  if (floor.kind === "unchecked") deps.out(note(floor.message));

  const allow = opts.allow && opts.allow.length > 0 ? opts.allow : ["*"];
  const token = mintToken();

  // KTD9 ordering: manifest first. An interrupt here fails the next gateway boot loudly.
  await writeRemoteFileAtomic(deps.shell, deps.manifestPath, manifestJson([...entries, { id, allow }]), "0644");
  const envBase = envText.endsWith("\n") || envText === "" ? envText : `${envText}\n`;
  await writeRemoteFileAtomic(deps.shell, deps.envFilePath, `${envBase}export ${envKey}=${token}\n`, "0600");
  await deps.keychain.set(id, token);

  deps.out(ok(`minted key for ${id} (allow: ${allow.join(", ")})`));
  // Deliberately NOT through ok/note (they redact token shapes): shown once, by design.
  deps.out(`  ${token}`);
  deps.out(note("shown once — also stored in the macOS Keychain for `obscura connect`"));
  if (opts.apply) await applyRecreate(deps, { key: envKey, present: true });
  else deps.out(note(restartInstruction(deps)));
}

export interface KeysListEntry {
  id: string;
  allow: string[];
  tags?: string[];
  tokenSet: boolean;
}

export interface KeysListResult {
  consumers: KeysListEntry[];
  /** BGW_CONSUMER_TOKEN_* keys present in the env file with no manifest entry (desync). */
  orphanEnvKeys: string[];
}

/** Quiet consumer inspection — the data without the printing (status composes this too). */
export async function inspectConsumers(deps: ProdFilesDeps): Promise<KeysListResult> {
  const { entries, envText } = await readProdFiles(deps);
  const consumers = entries.map((e) => ({
    id: e.id,
    allow: e.allow,
    ...(e.tags ? { tags: e.tags } : {}),
    tokenSet: tokenLineRe(tokenEnvKey(e.id)).test(envText),
  }));
  const knownKeys = new Set(entries.map((e) => tokenEnvKey(e.id)));
  const orphanEnvKeys = [...envText.matchAll(/^(?:export[ \t]+)?(BGW_CONSUMER_TOKEN_[A-Z0-9_]+)=/gm)]
    .map((m) => m[1])
    .filter((k): k is string => k !== undefined && !knownKeys.has(k));
  return { consumers, orphanEnvKeys };
}

/** One consumer as a display line — id, scope, token-present flag, never a token value. */
export function formatConsumerLine(c: KeysListEntry, prefix = ""): string {
  const tags = c.tags?.length ? `  tags=${c.tags.join(",")}` : "";
  return `${prefix}${c.id}  allow=${c.allow.join(",")}  token=${c.tokenSet ? "set" : "MISSING"}${tags}`;
}

/** Configured consumers — ids, scopes, and a token-present flag. Never a token value. */
export async function keysList(deps: KeysDeps): Promise<KeysListResult> {
  const { consumers, orphanEnvKeys } = await inspectConsumers(deps);

  for (const c of consumers) {
    deps.out(note(formatConsumerLine(c)));
  }
  for (const orphan of orphanEnvKeys) {
    deps.out(fail(`env token ${orphan} has no manifest entry (desync) — revoke or re-add it`));
  }
  if (consumers.length === 0) deps.out(note("no consumers configured"));
  return { consumers, orphanEnvKeys };
}

export interface KeysRevokeOptions {
  apply?: boolean;
}

/**
 * Remove a consumer from both files (manifest first — revocation lands even if interrupted;
 * the leftover env line is the harmless side and `list` reports it). A one-sided desync is
 * reported explicitly and then fully cleaned, never silently half-removed.
 */
export async function keysRevoke(deps: KeysDeps, id: string, opts: KeysRevokeOptions = {}): Promise<void> {
  if (opts.apply) requireApplyGates(deps);
  const { entries, envText } = await readProdFiles(deps);
  const envKey = tokenEnvKey(id);
  const inManifest = entries.some((e) => e.id === id);
  const inEnv = tokenLineRe(envKey).test(envText);
  if (!inManifest && !inEnv) throw new Error(`unknown consumer "${id}" (not in the manifest, no ${envKey} in the env file)`);
  // Reverse of keysNew's collision guard: an id that merely NORMALIZES onto another consumer's
  // env key must not delete that consumer's token (which would brick the next gateway boot).
  if (!inManifest && inEnv) {
    const aliasOf = envKeyCollision(id, entries.map((e) => e.id));
    if (aliasOf) {
      throw new Error(`"${id}" is not a consumer, but env key ${envKey} belongs to "${aliasOf}" — did you mean: obscura keys revoke ${aliasOf}?`);
    }
  }
  if (inManifest !== inEnv) {
    deps.out(
      fail(
        `desync: "${id}" was ${inManifest ? "in the manifest with no env token" : `only an env token (${envKey}) with no manifest entry`} — removing what exists`,
      ),
    );
  }
  if (inManifest) {
    await writeRemoteFileAtomic(deps.shell, deps.manifestPath, manifestJson(entries.filter((e) => e.id !== id)), "0644");
  }
  if (inEnv) {
    const lineRe = tokenLineRe(envKey);
    const kept = envText.split("\n").filter((line) => !lineRe.test(line));
    await writeRemoteFileAtomic(deps.shell, deps.envFilePath, kept.join("\n"), "0600");
  }
  await deps.keychain.remove(id);
  deps.out(ok(`revoked ${id}`));
  deps.out(note("the old token stays valid until the gateway is re-created (static registry)"));
  if (opts.apply) await applyRecreate(deps, { key: envKey, present: false });
  else deps.out(note(restartInstruction(deps)));
}
