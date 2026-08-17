/**
 * Shared gateway runtime boot (U8b). The construction sequence common to every long-lived or
 * one-shot process that needs an authenticated, policy-guarded {@link Gateway} from the fleet's env:
 * config → secrets → vault → CAPTCHA solver → consumers/registry → pool-sizing guard → policy →
 * gateway → escalation posture → sticky-suffix guard. Extracted from `http-main` so the on-host
 * `obscura vault login` capture (`cli/vault-host.ts`) builds the EXACT same runtime — same allowlist
 * guard, same proxy/secret/vault posture — instead of a hand-rolled near-copy that could drift.
 *
 * It does NOT start reapers, build the HTTP handler, or print the experiential banner — those are the
 * caller's job (http-main serves; vault-host captures once and shuts down). Pure boot wiring + the
 * fail-closed guards, so a misconfigured env fails loudly the same way for both callers.
 */
import { readFileSync } from "node:fs";
import { Gateway, loadConfig, poolSizingError } from "../gateway/index.js";
import type { GatewayConfig } from "../gateway/index.js";
import type { ArtifactRuntime } from "../artifacts/index.js";
import {
  PolicyEngine,
  ConsumerRegistry,
  InMemoryAuditSink,
  RedactingAuditSink,
  OriginationBoundary,
  parseConsumerManifest,
  buildConsumerSpecs,
} from "../policy/index.js";
import type { ConsumerSpec } from "../policy/index.js";
import { SecretStore, openVault, canonicalizeHost } from "../security/index.js";
import type { VaultStore } from "../security/index.js";
import {
  stickySuffixBootError,
  stickySuffixRedactables,
  parseForceProxyHosts,
  parseWarmupPaths,
  httpCaptchaSolverFromSecrets,
  DEFAULT_CAPTCHA_BUDGET,
} from "../verbs/index.js";

const AUDIT_MAX_RECORDS = 10_000;

/** Everything a consumer surface (HTTP serve, on-host capture) needs, built once from env. */
export interface GatewayRuntime {
  config: GatewayConfig;
  secrets: SecretStore;
  /** Encrypted credential store, or null when the vault feature is off/dormant (BGW_VAULT_DIR). */
  vault: VaultStore | null;
  specs: ConsumerSpec[];
  registry: ConsumerRegistry;
  policy: PolicyEngine;
  gateway: Gateway;
  /** Proxy escalation posture (R7) — direct-first; these drive the escalate-on-block decision. */
  onDatacenterIp: boolean;
  stickySuffix?: string;
  forceProxyHosts: ReturnType<typeof parseForceProxyHosts>;
  /** Hosts whose warm-open replays through a FRESH residential exit instead of re-pinning the captured
   *  one (BGW_WARM_FRESH_EXIT_HOSTS) — the durable fix for exit-reputation-gated hosts. */
  freshExitHosts: ReturnType<typeof parseForceProxyHosts>;
  /** Owner-host suffixes whose warm-open navigates a shallow page first to clear a behavioral WAF
   *  (BGW_WARMUP_HOSTS), and the shallow path(s) to warm up on (BGW_WARMUP_PATHS; default `["/"]`). */
  warmupHosts: ReturnType<typeof parseForceProxyHosts>;
  warmupPaths: ReturnType<typeof parseWarmupPaths>;
  verifyEgress: boolean;
  /**
   * Task 2 §4.3/§6 — ALWAYS `undefined` from this shared builder, and kept only so the field's absence
   * is part of the published contract rather than an omission a caller has to infer.
   *
   * The process-owned `ArtifactRuntime` holds an EXCLUSIVE, mkdir-based root lock that no later boot
   * reclaims, so exactly one process may own it: the HTTP entrypoint, which constructs it itself
   * (`http-main.ts`, inside the guard that releases it on a failed boot). This builder is shared with
   * auxiliary callers that run against the SAME artifact env — `cli/vault-host.ts` executes inside the
   * running gateway container — and constructing it here made every one of them either fail against the
   * live gateway's lock or leak the lock and brick the gateway's next boot. Ownership is therefore not
   * something a caller opts out of; the shared builder simply never takes it.
   */
  artifactRuntime?: ArtifactRuntime;
}

export interface BuildRuntimeOptions {
  log: (msg: string) => void;
  /**
   * Reuse an existing redaction sink instead of creating one. `vault-host` passes its process-wide
   * sink so the KEK + consumer tokens (folded here) AND the handled creds (folded by the caller) all
   * scrub through ONE store — so an error raised at any stage is redacted before crossing SSH.
   * Omitted → a fresh `SecretStore(() => env)` (http-main, the gate).
   */
  secrets?: SecretStore;
  /**
   * TEST-ONLY egress override for the PolicyEngine. Omitted in every production caller (http-main,
   * vault-host) → the real `isBlockedEgressHost` filter applies. The in-process validate gate passes
   * `() => false` so the guarded session can reach a loopback fixture (the egress filter blocks
   * loopback as anti-SSRF). Not env-reachable, so a deployed process can never weaken egress.
   */
  policyEgress?: (host: string) => boolean;
}

function loadConsumers(env: NodeJS.ProcessEnv, secrets: SecretStore): ConsumerSpec[] {
  const path = env.BGW_CONSUMERS_MANIFEST;
  if (!path) throw new Error("BGW_CONSUMERS_MANIFEST is required (path to the consumer manifest JSON)");
  const manifest = parseConsumerManifest(readFileSync(path, "utf8"));
  const { specs, tokens } = buildConsumerSpecs(manifest, env);
  secrets.addRedactableCredential(tokens); // tokens are credentials — must be redactable (R9, audit #3)
  return specs;
}

/**
 * Build the shared gateway runtime from `env`, applying every fail-closed boot guard (pool sizing,
 * sticky-suffix shape, vault key-without-entries). Throws on any guard violation — never returns a
 * half-configured gateway. The construction order matches the original http-main boot exactly:
 * secrets first, then the vault (folds the KEK into redaction), then consumers (fold tokens), then
 * the guards, then the gateway.
 */
export function buildGatewayRuntime(env: NodeJS.ProcessEnv, opts: BuildRuntimeOptions): GatewayRuntime {
  const { log } = opts;
  const config = loadConfig(env);
  // Task 2 §4.3/§6: the process-owned artifact runtime is deliberately NOT built here — see
  // GatewayRuntime.artifactRuntime. It takes an exclusive root lock nothing reclaims, and this builder
  // is shared with auxiliary callers (cli/vault-host.ts runs inside the live gateway container), so
  // ownership belongs to the HTTP entrypoint alone. Building it here also placed the lock BEFORE every
  // fail-closed guard below, so an ordinary config typo abandoned it and masked itself behind
  // artifact-root-locked on every later boot. `loadArtifactConfig`/`buildArtifactRuntime` remain the one
  // shared construction boundary; http-main calls them itself, inside the guard that releases the lock.
  // Bind the SecretStore to the SAME env the rest of the runtime reads (prod callers pass process.env
  // → identical to before; the in-process gate's controlled env then fully governs the runtime).
  const secrets = opts.secrets ?? new SecretStore(() => env);
  // Credential/session-state vault (B1). Off unless BGW_VAULT_DIR is set; constructing it here runs
  // the fail-closed boot guard (entries on disk but no master key → refuse to boot) and folds the KEK
  // into the redaction set.
  const vault = openVault({ env, canonicalizeHost, redact: (vals) => secrets.addRedactable(vals) });
  if (vault) log("vault: ready (encrypted credential store enabled)");
  // Interactive-CAPTCHA solver for the drive/capture path, wired when BYO config is present.
  // #43: the solve deadline is env-overridable (BGW_CAPTCHA_SOLVE_TIMEOUT_MS) and CLAMPED to the global call
  // budget (codex r3) so a stalled vendor can't run past the budget (e.g. the 120s default under a 90s
  // budget). Static clamp — the shared solver isn't per-call; threading the REMAINING per-call deadline is
  // the whole-operation-ceiling follow-up (a core-level AbortSignal, same as the direct-nav/lifecycle bound).
  config.core.solver = httpCaptchaSolverFromSecrets(secrets, env.BGW_CAPTCHA_API_URL, {
    budget: DEFAULT_CAPTCHA_BUDGET,
    timeoutMs: Math.min(config.timeouts.captchaSolveTimeoutMs, config.timeouts.callBudgetMs),
  });
  // R9: give the browser core the SecretStore so its own stderr diagnostics (errCode) scrub a bare
  // secret, not just URL-strip — closes the audit-#3 gap (a proxy password not in URL form). Passing the
  // store (not a redactor fn) lets the core union these values with a launch's proxy creds in one pass.
  config.core.secrets = secrets;

  const specs = loadConsumers(env, secrets);
  const registry = new ConsumerRegistry(specs);

  // Fail closed if the global pool can't cover every consumer's per-consumer share + a retrieve slot.
  const sizingError = poolSizingError(registry.size, config.perConsumerMax, config.maxSessions);
  if (sizingError) throw new Error(sizingError);

  const policy = new PolicyEngine({
    registry,
    audit: new RedactingAuditSink(new InMemoryAuditSink(AUDIT_MAX_RECORDS), secrets),
    // Origination boundary (R4): public deny set + any BGW_ORIGINATION_DENY_HOSTS/_PATHS extensions.
    originationBoundary: OriginationBoundary.fromEnv(env),
    ...(opts.policyEgress ? { egress: opts.policyEgress } : {}),
  });
  const gateway = Gateway.create(config, undefined, policy);

  const onDatacenterIp = env.BGW_ON_DATACENTER_IP === "1";
  // Sticky-session suffix template for proxied escalation ({id} minted per attempt). Deployment
  // config, NOT a secret. Absent = rotating exits (which cannot clear an IP-bound CF interstitial).
  const stickySuffix = env.BGW_PROXY_STICKY_SUFFIX || undefined;
  const forceProxyHosts = parseForceProxyHosts(env.BGW_FORCE_PROXY_HOSTS);
  // Hosts whose warm-open uses a FRESH residential exit instead of re-pinning the captured one (durable
  // fix for exit-reputation-gated hosts). Same flat-CSV host-suffix shape as force-proxy.
  const freshExitHosts = parseForceProxyHosts(env.BGW_WARM_FRESH_EXIT_HOSTS);
  // Warm-up navigation (PerimeterX deep-URL-first fix): owner hosts that navigate a shallow page first
  // to clear the edge WAF, and the shallow path(s). Same flat-CSV host-suffix shape as force-proxy;
  // parseWarmupPaths fails CLOSED here on a non-relative path so a typo can't misconfigure warm-up.
  const warmupHosts = parseForceProxyHosts(env.BGW_WARMUP_HOSTS);
  const warmupPaths = parseWarmupPaths(env.BGW_WARMUP_PATHS);
  const verifyEgress = env.BGW_DIAG_VERIFY_EGRESS === "1";
  const stickyErr = stickySuffixBootError(stickySuffix);
  if (stickyErr) throw new Error(stickyErr); // fail closed: a no-{id} suffix silently kills rotation
  // Fold the suffix's provider-param fragments into the redaction set so a driver error that echoes a
  // minted sticky password can't leak the exit's geo/session/lifetime structure past redactSecrets (R9).
  secrets.addRedactable(stickySuffixRedactables(stickySuffix));

  return {
    config, secrets, vault, specs, registry, policy, gateway, onDatacenterIp, stickySuffix, forceProxyHosts,
    freshExitHosts, warmupHosts, warmupPaths, verifyEgress,
  };
}
