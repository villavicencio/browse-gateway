/**
 * Origination boundary (R4 — the hard boundary). The gateway may *use* a logged-in session, but it
 * must never be the thing that ORIGINATES the highest-risk actions: creating an account, moving money,
 * or entering payment / government-ID credentials. This boundary is a FEATURE, not a limitation — it
 * is what makes "use credentials safely" safe to say.
 *
 * It is enforced BELOW the verb layer, inside the navigation guard, on TOP-LEVEL NAVIGATIONS only.
 * Two honest constraints shape it (both verified against the guard's inputs):
 *   1. The guard sees a {@link import("../browser/types.js").NavigationRequest} — `url`/`host`/
 *      `resourceType`/`isNavigationRequest` and NOTHING else. It cannot read a POST body or a form's
 *      field types, so "money movement" is only detectable by DESTINATION (a payment-processor host)
 *      and "account creation" only by URL PATH. A subresource (an embedded payment pixel or processor
 *      SDK on an otherwise-legit page) is display, not origination, and is left to the allowlist.
 *   2. A determined agent on an allowlisted host can still type a card number into a generic field.
 *      So this is an HONEST GUARDRAIL against casual/accidental origination, audited on every refusal —
 *      not an airtight prohibition. The kill-gate proves what it does enforce; it does not claim more.
 *
 * Deliberately NOT keyed on "has a password field": a first-time LOGIN on an approved host (the vault's
 * whole purpose) is indistinguishable from account creation by field-typing, so a field-type rule would
 * block the exact flows this feature exists to enable. Host + path are the discriminating signals.
 *
 * Defaults are GENERIC and public (well-known payment/transfer processors + account-creation /
 * money-movement path verbs) — never fleet- or target-specific. A deployment EXTENDS them with the
 * target-specific tuning that must not live in a public repo, via `BGW_ORIGINATION_DENY_HOSTS` and
 * `BGW_ORIGINATION_DENY_PATHS` (comma-separated; hosts canonicalized, paths are case-insensitive
 * regex fragments tested against the URL pathname).
 */
import { canonicalizeHost } from "../security/url.js";

export const ORIGINATION_DENY_REASON =
  "origination boundary: account creation / money movement is not permitted (the gateway uses sessions, it does not originate)";

/**
 * Pure payment/transfer/money-movement processor hosts where a TOP-LEVEL navigation is, in practice, a
 * checkout/transfer hand-off — i.e. origination, not reading docs. EXACT canonical-host match (a
 * subdomain like `checkout.stripe.com` is listed explicitly rather than matched by suffix, so the deny
 * is predictable and never over-broad). Generic + public; deployments add target-specific hosts via env.
 */
export const DEFAULT_ORIGINATION_DENY_HOSTS: readonly string[] = [
  "checkout.stripe.com",
  "buy.stripe.com",
  "paypal.com",
  "www.paypal.com",
  "checkout.paypal.com",
  "braintreegateway.com",
  "checkout.com",
  "pay.adyen.com",
  "checkout.adyen.com",
  "squareup.com",
  "checkout.square.site",
  "venmo.com",
  "wise.com",
];

/**
 * Path fragments (case-insensitive) for ACCOUNT CREATION and MONEY MOVEMENT — never plain login
 * (`/login`, `/signin` deliberately absent). Tested against the URL `pathname` only. Word-boundary /
 * delimiter anchoring keeps them from firing on unrelated paths (`/register` must not match
 * `/registered-trademarks`).
 */
export const DEFAULT_ORIGINATION_DENY_PATHS: readonly string[] = [
  "/sign[\\-_]?up(?:[/?.]|$)",
  "/register(?:ed|s)?(?:[/?.]|$)",
  "/registration(?:[/?.]|$)",
  "/create[\\-_]?account(?:[/?.]|$)",
  "/account/(?:new|create|registration|signup)(?:[/?.]|$)",
  "/(?:open|new)[\\-_]?account(?:[/?.]|$)",
  "/transfer(?:s|[\\-_]?money|[\\-_]?funds)?(?:[/?.]|$)",
  "/send[\\-_]?money(?:[/?.]|$)",
  "/wire(?:[\\-_]?transfer)?(?:[/?.]|$)",
  "/add[\\-_]?(?:card|payment[\\-_]?method|bank|funds)(?:[/?.]|$)",
  "/payment[\\-_]?methods?/(?:new|add)(?:[/?.]|$)",
];

/** Split a comma/whitespace-separated env list into trimmed, non-empty entries. */
function splitEnvList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * The origination deny set — policy-owned, built once. A TOP-LEVEL navigation is refused when its host
 * is in the deny-host set OR its pathname matches a deny-path pattern. Defaults are always present;
 * env entries extend (never replace) them, so a deployment can harden but never silently weaken the
 * boundary below the public floor.
 */
export class OriginationBoundary {
  readonly #hosts: ReadonlySet<string>;
  readonly #paths: readonly RegExp[];

  constructor(extra?: { hosts?: readonly string[]; paths?: readonly string[] }) {
    this.#hosts = new Set(
      [...DEFAULT_ORIGINATION_DENY_HOSTS, ...(extra?.hosts ?? [])].map((h) => canonicalizeHost(h)),
    );
    this.#paths = [...DEFAULT_ORIGINATION_DENY_PATHS, ...(extra?.paths ?? [])].map((p) => {
      try {
        return new RegExp(p, "i");
      } catch (err) {
        // Fail closed at construction (boot): a malformed BGW_ORIGINATION_DENY_PATHS entry must be a
        // loud config error, never a silently-dropped rule that leaves the boundary weaker than intended.
        throw new Error(`origination boundary: invalid deny-path pattern ${JSON.stringify(p)} — ${(err as Error).message}`);
      }
    });
  }

  /** Build from env, extending the public defaults with `BGW_ORIGINATION_DENY_HOSTS` / `_PATHS`. */
  static fromEnv(env: NodeJS.ProcessEnv): OriginationBoundary {
    return new OriginationBoundary({
      hosts: splitEnvList(env.BGW_ORIGINATION_DENY_HOSTS),
      paths: splitEnvList(env.BGW_ORIGINATION_DENY_PATHS),
    });
  }

  /**
   * True when a top-level navigation to `(host, url)` would originate a denied action. Subresource
   * requests are the caller's concern to exclude (the guard only consults this for navigations); a
   * URL that can't be parsed for its pathname is treated as host-only (no path match).
   */
  denies(host: string, url: string): boolean {
    if (this.#hosts.has(canonicalizeHost(host))) return true;
    let pathname: string;
    try {
      pathname = new URL(url).pathname;
    } catch {
      return false;
    }
    return this.#paths.some((re) => re.test(pathname));
  }
}
