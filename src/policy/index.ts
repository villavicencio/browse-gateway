/**
 * Policy engine — authenticates consumers and produces per-consumer navigation guards,
 * auditing every decision. This is the one place the allowlist (R14) and per-consumer
 * identity/scope/audit (R18) live; the gateway wraps its single internal path with it so
 * no surface reaches a browser un-authenticated or off-allowlist (AE6).
 */
import type { NavigationGuard } from "../browser/index.js";
import { isBlockedEgressHost, EGRESS_DENY_REASON } from "../security/egress.js";
import { isHttpUrl, canonicalizeHost } from "../security/url.js";
import { InMemoryAuditSink } from "./audit.js";
import type { AuditSink } from "./audit.js";
import { ConsumerRegistry } from "./consumer.js";
import type { Consumer } from "./consumer.js";

/** Returns true when a host must be blocked for egress reasons (private/metadata ranges). */
export type EgressFilter = (host: string) => boolean;

export type PolicyErrorCode = "UNAUTHENTICATED";

export class PolicyError extends Error {
  readonly code: PolicyErrorCode;
  constructor(code: PolicyErrorCode, message: string) {
    super(message);
    this.name = "PolicyError";
    this.code = code;
  }
}

export interface PolicyEngineOptions {
  registry: ConsumerRegistry;
  audit?: AuditSink;
  /** Egress deny-filter, applied before the allowlist. Defaults to private/metadata ranges. */
  egress?: EgressFilter;
}

/**
 * Exact hosts an INTERNAL diagnostics probe (the opt-in egress check, issue #21) may reach.
 * Exact-match ONLY — no wildcard/subdomain rules — and POLICY-OWNED (never caller-supplied), so
 * "diagnostics only" is enforced here, not by a caller remembering to pass a constant. The egress
 * probe renders the first entry; extend this set deliberately. Canonicalized with `canonicalizeHost`
 * (case + trailing-dot tolerant) NOT `normalizeHost` — the latter strips a leading `www.`, which
 * would let `www.ipinfo.io` satisfy a literal `ipinfo.io` entry; a diagnostics host must be literal.
 */
export const DIAGNOSTICS_EGRESS_HOSTS: readonly string[] = ["ipinfo.io"];
const DIAGNOSTICS_HOST_SET = new Set(DIAGNOSTICS_EGRESS_HOSTS.map((h) => canonicalizeHost(h)));

export class PolicyEngine {
  readonly #registry: ConsumerRegistry;
  readonly #audit: AuditSink;
  readonly #egress: EgressFilter;

  constructor(opts: PolicyEngineOptions) {
    this.#registry = opts.registry;
    this.#audit = opts.audit ?? new InMemoryAuditSink();
    this.#egress = opts.egress ?? isBlockedEgressHost;
  }

  get audit(): AuditSink {
    return this.#audit;
  }

  /**
   * Resolve a consumer from its credential. Throws `PolicyError("UNAUTHENTICATED")` for an
   * unknown token — and audits the rejected attempt — so callers can reject before opening
   * a browser session.
   */
  authenticate(token: string): Consumer {
    const consumer = this.#registry.resolve(token);
    if (!consumer) {
      this.#audit.record({
        ts: Date.now(),
        consumerId: null,
        action: "authenticate",
        decision: "auth-reject",
        reason: "unknown credential",
      });
      throw new PolicyError("UNAUTHENTICATED", "unknown consumer credential");
    }
    this.#audit.record({
      ts: Date.now(),
      consumerId: consumer.id,
      action: "authenticate",
      decision: "auth-ok",
    });
    return consumer;
  }

  /**
   * Build the navigation guard for a consumer. Blocks are always audited; allowed
   * top-level navigations are audited too (allowed subresources are not, to keep the trail
   * signal-dense). The returned guard is pure w.r.t. the browser — it just decides + logs.
   */
  guardFor(consumer: Consumer): NavigationGuard {
    return (req) => {
      // Scheme allowlist: only http(s). file:/data:/blob:/ftp:/view-source: etc. have no
      // meaningful host for the allowlist/egress checks and must never be navigated.
      if (!isHttpUrl(req.url)) {
        this.#audit.record({
          ts: Date.now(),
          consumerId: consumer.id,
          action: "navigate",
          decision: "block",
          host: req.host,
          url: req.url,
          reason: "scheme not allowed (only http/https)",
        });
        return "block";
      }
      // Egress deny wins over any allowlist: even an allowlisted host that is a private or
      // metadata address is blocked (R19). Always audited — reaching for one is a signal.
      if (this.#egress(req.host)) {
        this.#audit.record({
          ts: Date.now(),
          consumerId: consumer.id,
          action: "navigate",
          decision: "block",
          host: req.host,
          url: req.url,
          reason: EGRESS_DENY_REASON,
        });
        return "block";
      }
      const allowed = consumer.allowlist.allows(req.host);
      if (!allowed || req.isNavigationRequest) {
        this.#audit.record({
          ts: Date.now(),
          consumerId: consumer.id,
          action: "navigate",
          decision: allowed ? "allow" : "block",
          host: req.host,
          url: req.url,
          ...(allowed ? {} : { reason: "host not in consumer allowlist" }),
        });
      }
      return allowed ? "allow" : "block";
    };
  }

  /**
   * Build a navigation guard for an INTERNAL diagnostics probe (the opt-in egress check). It allows
   * ONLY the policy-owned {@link DIAGNOSTICS_EGRESS_HOSTS} — EXACT host match, NO wildcard/subdomain
   * rules — with the same scheme + egress-deny enforcement as a consumer guard. The host set is owned
   * by the policy (the caller passes no host), so a caller cannot widen "diagnostics" to anything
   * else. Independent of the consumer's allowlist: a restrictive one can't block the probe and a
   * permissive one can't widen it. Audited under the INITIATING consumer's id with a diagnostics marker.
   */
  guardForDiagnostics(consumer: Consumer): NavigationGuard {
    return (req) => {
      if (!isHttpUrl(req.url)) {
        this.#audit.record({
          ts: Date.now(),
          consumerId: consumer.id,
          action: "navigate",
          decision: "block",
          host: req.host,
          url: req.url,
          reason: "diagnostics probe: scheme not allowed (only http/https)",
        });
        return "block";
      }
      if (this.#egress(req.host)) {
        this.#audit.record({
          ts: Date.now(),
          consumerId: consumer.id,
          action: "navigate",
          decision: "block",
          host: req.host,
          url: req.url,
          reason: `diagnostics probe: ${EGRESS_DENY_REASON}`,
        });
        return "block";
      }
      // Exact membership in the policy-owned approved set — NOT an Allowlist, so a `*` or `*.sub`
      // rule can never apply; and via canonicalizeHost (not normalizeHost) `www.ipinfo.io` does NOT
      // satisfy a literal `ipinfo.io` entry. Only an exact approved host is reachable.
      const allowed = DIAGNOSTICS_HOST_SET.has(canonicalizeHost(req.host));
      this.#audit.record({
        ts: Date.now(),
        consumerId: consumer.id,
        action: "navigate",
        decision: allowed ? "allow" : "block",
        host: req.host,
        url: req.url,
        reason: allowed ? "diagnostics egress probe" : "diagnostics probe: host not in approved set",
      });
      return allowed ? "allow" : "block";
    };
  }
}

export { Allowlist, normalizeHost } from "./allowlist.js";
export { ConsumerRegistry } from "./consumer.js";
export type { Consumer, ConsumerSpec } from "./consumer.js";
export { tokenEnvKey, parseConsumerManifest, buildConsumerSpecs } from "./consumer-config.js";
export type { ConsumerManifestEntry, BuiltConsumers } from "./consumer-config.js";
export { InMemoryAuditSink, consoleAuditSink, RedactingAuditSink } from "./audit.js";
export type { AuditRecord, AuditSink, AuditDecision } from "./audit.js";
