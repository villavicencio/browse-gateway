/**
 * Policy engine — authenticates consumers and produces per-consumer navigation guards,
 * auditing every decision. This is the one place the allowlist (R14) and per-consumer
 * identity/scope/audit (R18) live; the gateway wraps its single internal path with it so
 * no surface reaches a browser un-authenticated or off-allowlist (AE6).
 */
import type { NavigationGuard, NavigationRequest, NavigationBlockInfo } from "../browser/index.js";
import { isBlockedEgressHost, EGRESS_DENY_REASON } from "../security/egress.js";
import { isHttpUrl, canonicalizeHost } from "../security/url.js";
import { InMemoryAuditSink } from "./audit.js";
import type { AuditSink } from "./audit.js";
import { ConsumerRegistry } from "./consumer.js";
import type { Consumer } from "./consumer.js";
import { OriginationBoundary, ORIGINATION_DENY_REASON } from "./origination.js";

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
  /**
   * Origination boundary (R4), applied to top-level navigations before the allowlist. Defaults to the
   * public deny set (no env extensions); production passes {@link OriginationBoundary.fromEnv}. Always
   * on — there is no "off": the boundary is a feature.
   */
  originationBoundary?: OriginationBoundary;
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
  readonly #origination: OriginationBoundary;

  constructor(opts: PolicyEngineOptions) {
    this.#registry = opts.registry;
    this.#audit = opts.audit ?? new InMemoryAuditSink();
    this.#egress = opts.egress ?? isBlockedEgressHost;
    this.#origination = opts.originationBoundary ?? new OriginationBoundary();
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
   * #80: record a navigation BLOCK (audit) and surface its reason via the decision-safe
   * {@link NavigationBlockInfo} out-param. The returned `"block"` is the guard's verdict; this helper NEVER
   * participates in COMPUTING it — it only logs the block and WRITES the write-only `out.reason`, so the
   * fail-closed decision can never depend on the side-channel. One place so every block path audits +
   * threads its reason identically (the interception layer reads `out.reason` to classify a MAIN-FRAME
   * self-block as `policy-blocked`; a benign subresource block is never promoted, being top-frame-scoped
   * at the capture seam).
   */
  #navBlock(consumer: Consumer, req: NavigationRequest, reason: string, out?: NavigationBlockInfo): "block" {
    this.#audit.record({
      ts: Date.now(),
      consumerId: consumer.id,
      action: "navigate",
      decision: "block",
      host: req.host,
      url: req.url,
      reason,
    });
    if (out) out.reason = reason;
    return "block";
  }

  /**
   * Build the navigation guard for a consumer. Blocks are always audited; allowed
   * top-level navigations are audited too (allowed subresources are not, to keep the trail
   * signal-dense). The returned guard is pure w.r.t. the browser — it just decides + logs.
   */
  guardFor(consumer: Consumer): NavigationGuard {
    return (req, out) => {
      // Scheme allowlist: only http(s). file:/data:/blob:/ftp:/view-source: etc. have no
      // meaningful host for the allowlist/egress checks and must never be navigated.
      if (!isHttpUrl(req.url)) return this.#navBlock(consumer, req, "scheme not allowed (only http/https)", out);
      // Egress deny wins over any allowlist: even an allowlisted host that is a private or
      // metadata address is blocked (R19). Always audited — reaching for one is a signal.
      if (this.#egress(req.host)) return this.#navBlock(consumer, req, EGRESS_DENY_REASON, out);
      // Origination boundary (R4): refuse a TOP-LEVEL navigation that would originate account creation
      // or money movement — even to an allowlisted host. Gated on navigation requests only, so an
      // embedded payment SDK/pixel (a subresource on a legit page) is not blocked; this targets the
      // hand-off navigation, not page display. Like egress, it wins over the allowlist and is audited.
      if (req.isNavigationRequest && this.#origination.denies(req.host, req.url)) {
        return this.#navBlock(consumer, req, ORIGINATION_DENY_REASON, out);
      }
      const allowed = consumer.allowlist.allows(req.host);
      if (!allowed) return this.#navBlock(consumer, req, "host not in consumer allowlist", out);
      // Allowed: audit a top-level navigation (an allowed subresource is not audited, to keep the trail
      // signal-dense). Unchanged from before the #80 refactor — same records, same signal density.
      if (req.isNavigationRequest) {
        this.#audit.record({
          ts: Date.now(),
          consumerId: consumer.id,
          action: "navigate",
          decision: "allow",
          host: req.host,
          url: req.url,
        });
      }
      return "allow";
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
    return (req, out) => {
      if (!isHttpUrl(req.url)) return this.#navBlock(consumer, req, "diagnostics probe: scheme not allowed (only http/https)", out);
      if (this.#egress(req.host)) return this.#navBlock(consumer, req, `diagnostics probe: ${EGRESS_DENY_REASON}`, out);
      // Exact membership in the policy-owned approved set — NOT an Allowlist, so a `*` or `*.sub`
      // rule can never apply; and via canonicalizeHost (not normalizeHost) `www.ipinfo.io` does NOT
      // satisfy a literal `ipinfo.io` entry. Only an exact approved host is reachable. This branch
      // ALWAYS audits (allow AND block), so it stays inline; the block reason is threaded to `out`.
      const allowed = DIAGNOSTICS_HOST_SET.has(canonicalizeHost(req.host));
      const reason = allowed ? "diagnostics egress probe" : "diagnostics probe: host not in approved set";
      this.#audit.record({
        ts: Date.now(),
        consumerId: consumer.id,
        action: "navigate",
        decision: allowed ? "allow" : "block",
        host: req.host,
        url: req.url,
        reason,
      });
      if (!allowed && out) out.reason = reason;
      return allowed ? "allow" : "block";
    };
  }

  /**
   * Build a navigation guard for a CREDENTIALED (warm-replay) session — one opened with a stored
   * credential restored into the cookie jar. Unlike {@link guardFor}, top-level NAVIGATION is clamped
   * to the credential's OWNER HOST (exact, canonicalized), NOT the consumer's full allowlist. This is
   * the second half of R4 no-exfil: jar-filtering keeps an entry's cookies host-scoped, but a retained
   * parent-domain cookie (`.example.com` for an `accounts.example.com` entry) is still broadcast by
   * Chrome to ANY `*.example.com` host the session reaches — so a `*.example.com` allowlist would let a
   * navigation to a sibling (`evil.example.com`) carry it off. The agent-controlled exfil vector IS
   * navigation (the drive verbs navigate/click/submit; they cannot issue an arbitrary cross-origin
   * request — KTD-5), so clamping navigation to the owner host closes it. SUBRESOURCES keep the
   * consumer allowlist so the owner-host page still renders (a page's own cross-subdomain asset/XHR is
   * the site's design within the operator-trusted allowlist, not agent-driven exfil). Scheme, egress,
   * and the origination boundary still apply; the nav clamp is intersected with the consumer allowlist
   * so this guard is NEVER wider than {@link guardFor}.
   *
   * The clamp re-fires on every SERVER 3xx hop: the core intercepts via a CDP Fetch Request-stage
   * session (not `route.continue()`, which auto-followed redirects without re-invoking the guard), so
   * a `302` from the owner host to a same-parent sibling is re-decided against this clamp and blocked
   * before the retained parent cookie can ride to the sibling. (Closed the redirect bypass once
   * tracked in docs/solutions/architecture-patterns/nav-guard-redirect-bypass.md.)
   */
  guardForCredentialHost(consumer: Consumer, ownerHost: string): NavigationGuard {
    const owner = canonicalizeHost(ownerHost);
    return (req, out) => {
      if (!isHttpUrl(req.url)) return this.#navBlock(consumer, req, "scheme not allowed (only http/https)", out);
      if (this.#egress(req.host)) return this.#navBlock(consumer, req, EGRESS_DENY_REASON, out);
      if (req.isNavigationRequest && this.#origination.denies(req.host, req.url)) {
        return this.#navBlock(consumer, req, ORIGINATION_DENY_REASON, out);
      }
      const inAllowlist = consumer.allowlist.allows(req.host);
      // NAVIGATION is clamped to the exact owner host (∩ allowlist, so never wider than the consumer
      // guard); a subresource keeps the consumer allowlist so the page renders.
      const allowed = req.isNavigationRequest ? canonicalizeHost(req.host) === owner && inAllowlist : inAllowlist;
      if (!allowed) {
        // A blocked NAVIGATION off the owner host is the credential-scope clamp; a blocked SUBRESOURCE is a
        // plain allowlist miss. Same reason strings the audit carried before the #80 refactor.
        return this.#navBlock(
          consumer,
          req,
          req.isNavigationRequest
            ? "credential scope: navigation is not the credential owner host"
            : "host not in consumer allowlist",
          out,
        );
      }
      // Allowed: audit a top-level navigation only (an allowed subresource is not audited). Unchanged.
      if (req.isNavigationRequest) {
        this.#audit.record({
          ts: Date.now(),
          consumerId: consumer.id,
          action: "navigate",
          decision: "allow",
          host: req.host,
          url: req.url,
        });
      }
      return "allow";
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
export {
  OriginationBoundary,
  ORIGINATION_DENY_REASON,
  DEFAULT_ORIGINATION_DENY_HOSTS,
  DEFAULT_ORIGINATION_DENY_PATHS,
} from "./origination.js";
