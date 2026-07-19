/**
 * Failure-diagnostics envelope (issue #39) — the FOUNDATION the site-compat epic (#38) reports
 * through. When a `retrieve`/`drive` navigation fails or lands on a challenge, the caller today gets
 * an opaque verdict; this envelope carries the evidence a failure needs to be diagnosable: the
 * post-redirect final URL, page title, HTTP status, the ordered redirect chain, bounded console
 * errors + failed network requests, and (opt-in, size-capped) a screenshot.
 *
 * DESIGN INVARIANT — a STABLE, slot-based shape. Six downstream tickets (#40 vendor label, #41
 * failure-class, #42 per-stage timing, #44 solver reason/eligibility, #48 home-fallback) fill VALUES
 * into the pre-declared optional slots below WITHOUT reshaping the type. Declaring the slots now
 * demotes those downstream conflicts from hard (type change) to soft (value change). This ticket
 * populates ONLY the evidence fields; every slot marked "downstream" is left UNSET here.
 *
 * SECRETS — every free-text dump in this envelope (finalUrl, title, redirectChain, consoleErrors,
 * networkFailures) MUST pass through {@link redactFailureDiagnostics} before it is serialized to a
 * caller / log / audit record: it scrubs the secret set via `redactSecrets` and strips
 * cookie/set-cookie/authorization header material (redact-before-serialize, R9;
 * see docs/solutions/best-practices/redact-before-serialize.md). The assembly ({@link
 * buildFailureDiagnostics}) and redaction seams are the SINGLE places evidence is shaped, so a
 * downstream ticket attaches vendor/class/timing HERE, not by editing classifyBlock/retrieve()/
 * server.fail() separately.
 */
import { redactSecrets } from "../security/secrets.js";

/**
 * The evidence envelope surfaced on EVERY failure of both the retrieve and drive paths, at parity.
 * All fields optional so a success shape is unchanged and a partial capture still carries what it has.
 */
export interface FailureDiagnostics {
  /** `page.url()` AFTER redirects — the real landed URL (fixes the retrieve bug that returned the
   *  requested URL instead of the post-redirect one). */
  finalUrl?: string;
  /** The rendered page title (raw page `<title>`, e.g. "Just a moment..." for a CF interstitial). */
  title?: string;
  /** HTTP status of the main navigation, `null` when none was captured (a failed/aborted nav). */
  status?: number | null;
  /** Ordered main-document hop URLs, including each server redirect target. Bounded + redacted. */
  redirectChain?: string[];
  /** Bounded (cap {@link FAILURE_DIAGNOSTICS_CAP}), redacted console error/warning lines. */
  consoleErrors?: string[];
  /** Bounded (cap {@link FAILURE_DIAGNOSTICS_CAP}), redacted failed-request lines
   *  ("GET https://… <errText>"). */
  networkFailures?: string[];
  /** Base64 PNG (or a ref) — populated ONLY when the capture flag is on and under the size cap. */
  screenshotRef?: string;

  // ---- PRE-DECLARED OPTIONAL SLOTS for downstream tickets (leave UNSET in this ticket) ----
  /** Slot for #40 (mitigation-vendor label). Do NOT populate here. */
  wafVendor?: string;
  /** Slot for #41 (failure-class enum). Do NOT populate here. */
  failureClass?: string;
  /** Slot for #42 (per-stage timing). Do NOT populate here. */
  timing?: Record<string, number>;
  /** Slot for #44 (why a CAPTCHA solve was/wasn't attempted). Do NOT populate here. */
  captchaSolveReason?: string;
  /** Slot for #44 (whether the failure was solver-eligible). Do NOT populate here. */
  solverEligible?: boolean;
  /** Slot for #48 (a home-page fallback was used). Do NOT populate here. */
  homeFallback?: boolean;
}

/**
 * Raw evidence handed to {@link buildFailureDiagnostics}. The evidence fields only — a downstream
 * ticket that fills a slot passes it through a widened input, never by mutating an assembled envelope.
 */
export interface FailureDiagnosticsInput {
  finalUrl?: string;
  title?: string;
  status?: number | null;
  redirectChain?: readonly string[];
  consoleErrors?: readonly string[];
  networkFailures?: readonly string[];
  screenshotRef?: string;
}

/** Upper bound on each free-text list (consoleErrors / networkFailures / redirectChain) surfaced in an
 *  envelope — the capture buffers are bounded ring buffers, and this is a defensive second clamp so an
 *  envelope can never carry an unbounded dump even if a caller assembles one directly. */
export const FAILURE_DIAGNOSTICS_CAP = 50;

/**
 * The SINGLE assembly seam: shape raw captured evidence into a {@link FailureDiagnostics}. Copies only
 * the declared evidence fields (each list clamped to the last {@link FAILURE_DIAGNOSTICS_CAP} entries),
 * and leaves every downstream slot UNSET. A downstream ticket attaches its slot value HERE (via a
 * widened input), so the vendor/class/timing logic lives at one seam rather than scattered across the
 * retrieve/drive failure paths. Does NOT redact — call {@link redactFailureDiagnostics} before surfacing.
 */
export function buildFailureDiagnostics(input: FailureDiagnosticsInput): FailureDiagnostics {
  const diag: FailureDiagnostics = {};
  if (input.finalUrl !== undefined) diag.finalUrl = input.finalUrl;
  if (input.title !== undefined) diag.title = input.title;
  if (input.status !== undefined) diag.status = input.status;
  if (input.redirectChain && input.redirectChain.length) {
    diag.redirectChain = input.redirectChain.slice(-FAILURE_DIAGNOSTICS_CAP);
  }
  if (input.consoleErrors && input.consoleErrors.length) {
    diag.consoleErrors = input.consoleErrors.slice(-FAILURE_DIAGNOSTICS_CAP);
  }
  if (input.networkFailures && input.networkFailures.length) {
    diag.networkFailures = input.networkFailures.slice(-FAILURE_DIAGNOSTICS_CAP);
  }
  if (input.screenshotRef !== undefined) diag.screenshotRef = input.screenshotRef;
  return diag;
}

/**
 * Strip a URL's query string and fragment entirely, keeping origin + path only — the robust default,
 * because sensitive params can't be enumerated (OAuth `?code=…&access_token=…`, signed URLs, session
 * ids). Appends a `?<redacted>` / `#<redacted>` marker when a query/fragment was present, so the
 * diagnostic still signals that params existed. The PATH is preserved (a home-page vs deep-URL signal
 * #48's home-fallback detection needs). A non-parseable / non-http value is returned unchanged (the
 * secret + header scrubbers still run over it). This is the leak the registered-secret-only scrubber
 * missed: an unregistered access token in a URL is caught here regardless of the secret set.
 */
function sanitizeUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  const hadQuery = u.search.length > 0;
  const hadFragment = u.hash.length > 0;
  u.search = "";
  u.hash = "";
  let out = u.toString();
  if (hadQuery) out += "?<redacted>";
  if (hadFragment) out += "#<redacted>";
  return out;
}

/** Sanitize every http(s) URL embedded in a free-text line (a console error / network line frequently
 *  carries a full URL with its query), so an OAuth/token URL can't leak through a dump field either. */
const URL_IN_TEXT_RE = /https?:\/\/[^\s"'<>)\]]+/gi;
function sanitizeUrlsInText(s: string): string {
  return s.replace(URL_IN_TEXT_RE, (m) => sanitizeUrl(m));
}

/**
 * Strip the value of any `cookie` / `set-cookie` / `authorization` header wherever it appears in a dump
 * line — always sensitive even when the value isn't a registered secret (a session cookie minted by the
 * site, a bearer the caller passed). Broadened past a bare same-line `name: value` to also catch: a
 * quoted / JSON key (`"Cookie":"…"`, `'authorization': '…'`, `Set-Cookie` inside a JSON blob), a `=`
 * separator, a quoted OR bare value, AND folded header continuation lines (RFC-style leading-whitespace
 * continuations), so a multi-line Authorization can't leak its tail. Over-redaction (e.g. swallowing an
 * indented follow-on line) is the safe direction here.
 */
const SENSITIVE_HEADER_RE =
  /(["']?)\b(set-cookie|cookie|authorization)\b\1(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S[^\n]*(?:\n[ \t]+\S[^\n]*)*)/gi;
function stripSensitiveHeaders(s: string): string {
  return s.replace(SENSITIVE_HEADER_RE, (_m, q: string, name: string, sep: string) => `${q}${name}${q}${sep}[REDACTED]`);
}

/**
 * Redact an envelope before it is serialized to a caller/log (redact-before-serialize, R9). Applies
 * three scrubbers so a leak does NOT depend on a value being a registered secret:
 *   1. URL sanitization — the query + fragment are stripped from finalUrl, every redirectChain entry,
 *      and any URL embedded in a console/network line (catches unregistered OAuth codes / access tokens);
 *   2. the registered-secret pass (`redactSecrets`) — proxy/vault/consumer credential VALUES;
 *   3. cookie/set-cookie/authorization header stripping (quoted, JSON, `=`, and folded continuations).
 * The `screenshotRef` (opaque base64 bytes) and the numeric/boolean slots pass through untouched.
 * `secrets` is a structural store (`{ redactableValues(): readonly string[] }`) — passing the VALUE SET
 * (not an opaque redactor) keeps the secret pass single-pass so a value can't fragment across redactors.
 */
export function redactFailureDiagnostics(
  diag: FailureDiagnostics,
  secrets: { redactableValues(): readonly string[] },
): FailureDiagnostics {
  // A single URL field (finalUrl, a redirect hop): strip params first, then the secret pass.
  const scrubUrl = (s: string): string => redactSecrets(sanitizeUrl(s), secrets);
  // A free-text field (title, console, network): sanitize embedded URLs, secret pass, header strip.
  const scrubText = (s: string): string => stripSensitiveHeaders(redactSecrets(sanitizeUrlsInText(s), secrets));
  const out: FailureDiagnostics = { ...diag };
  if (diag.finalUrl !== undefined) out.finalUrl = scrubUrl(diag.finalUrl);
  if (diag.title !== undefined) out.title = scrubText(diag.title);
  if (diag.redirectChain) out.redirectChain = diag.redirectChain.map(scrubUrl);
  if (diag.consoleErrors) out.consoleErrors = diag.consoleErrors.map(scrubText);
  if (diag.networkFailures) out.networkFailures = diag.networkFailures.map(scrubText);
  return out;
}

/**
 * A text-log-safe view of the envelope: the base64 screenshot (when present) is replaced by a short
 * size marker, so a diagnostics line rendered into an MCP tool error stays small and readable instead
 * of embedding a multi-hundred-KB image blob. All other fields pass through unchanged. Redact FIRST
 * ({@link redactFailureDiagnostics}); this is a presentation shrink, not a security transform.
 */
export function summarizeFailureDiagnostics(diag: FailureDiagnostics): FailureDiagnostics {
  if (diag.screenshotRef === undefined) return diag;
  return { ...diag, screenshotRef: `<png ${diag.screenshotRef.length}b base64>` };
}

/** An error decorated with a failure envelope. The envelope is a NON-enumerable own property so it does
 *  not widen a `JSON.stringify(err)` and cannot collide with the message, yet {@link failureOf} can read
 *  it structurally at the MCP surface. {@link import("../verbs/retrieve.js").EscalationError} carries an
 *  enumerable `failure` field of the same name; both are read by {@link failureOf}. */
export interface FailureCarrier {
  failure?: FailureDiagnostics;
}

/**
 * Attach a {@link FailureDiagnostics} to a thrown error so the MCP `fail()` surface can render it —
 * used for the plain-`Error` drive throws (a pinned nav failure, a warm-replay failure, an action that
 * landed on a challenge) that are not {@link import("../verbs/retrieve.js").EscalationError}s. A no-op
 * when `failure` is undefined, so a call site with no captured snapshot stays a bare error. Returns the
 * same error for a fluent `throw attachFailure(new Error(...), failure)`.
 */
export function attachFailure<E extends Error>(err: E, failure: FailureDiagnostics | undefined): E {
  if (failure) {
    Object.defineProperty(err, "failure", { value: failure, enumerable: false, configurable: true });
  }
  return err;
}

/** Read a failure envelope off any thrown value that carries one (an EscalationError's `.failure`, or a
 *  plain error decorated by {@link attachFailure}). Undefined when the error has none. */
export function failureOf(err: unknown): FailureDiagnostics | undefined {
  if (err && typeof err === "object" && "failure" in err) {
    const f = (err as FailureCarrier).failure;
    if (f && typeof f === "object") return f;
  }
  return undefined;
}
