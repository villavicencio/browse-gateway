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
// Type-only import (erased at compile — no runtime browser→observability→browser cycle): the closed
// `captchaSolveReason` vocabulary is single-sourced in the browser layer next to the solver error codes.
import type { CaptchaSolveReason } from "../browser/captcha.js";

/**
 * The mitigation/CAPTCHA vendor attributed to a failure (issue #40) — a CLOSED vocabulary. Defined in
 * this low-level module (not in a verb) precisely so the {@link FailureDiagnostics.wafVendor} slot can be
 * TYPED to it: {@link redactFailureDiagnostics} passes wafVendor through UNTOUCHED, which is safe ONLY
 * because the value can never be page-derived free text. The type is the enforcement — a producer cannot
 * assign an un-redacted string into the slot. `akamai`/`imperva` are reserved for a future HTML detector
 * (today recognized only as IP-bound cookie names in the vault layer, not surfaced here). The projection
 * from a block reason lives with the classifier: {@link import("../verbs/retrieve.js").wafVendorFromReason}.
 */
export type WafVendor =
  | "cloudflare"
  | "perimeterx"
  | "datadome"
  | "akamai"
  | "imperva"
  | "recaptcha"
  | "hcaptcha"
  | "turnstile";

/**
 * The typed failure CLASS attributed to a failed retrieve/drive call (issue #41) — a CLOSED vocabulary,
 * defined here (not in a verb) for the same reason as {@link WafVendor}: so the
 * {@link FailureDiagnostics.failureClass} slot is TYPED to it and {@link redactFailureDiagnostics} can pass
 * it through UNTOUCHED (the value can never be page-derived free text — the type is the enforcement). The
 * classifier that PRODUCES it is layered on top of the block classifier and lives with it:
 * {@link import("../verbs/retrieve.js").classifyFailure}. Values:
 *   - `anti-bot-block`  a visible/vendor-attributed WAF challenge or a generic visible block phrase
 *                       (carries {@link WafVendor} when attributable).
 *   - `captcha`         an ACTIVE interactive CAPTCHA widget is the block (carries the widget-kind vendor).
 *   - `hard-block`      4xx/5xx + thin body, no vendor marker (IP/WAF reputation).
 *   - `empty-shell`     a 2xx/3xx page that yielded NO extractable content — the formalized `empty-content`
 *                       (an unhydrated SPA shell or a genuinely empty page). The common non-block failure.
 *   - `hydration-failed` a 2xx/3xx thin page with an SPA framework root AND a genuine (non-guard) failed
 *                       data/asset request — BEST-EFFORT; distinguishes a broken hydration from a quiet
 *                       shell. Keys on REQUEST-level failures (`requestfailed`); a subresource that returns a
 *                       4xx/5xx RESPONSE is not counted, so such a hydration failure degrades to `empty-shell`
 *                       rather than misclassifying — a documented coarse-first limitation (richer
 *                       subresource-response capture is a follow-up).
 *   - `real-zero-results` a genuine site-reported empty-state ("no results") — distinguished from a
 *                       block/shell, but STILL a no-content failure (isError:true), not a success.
 *   - `unsupported-browser` an unsupported-browser interstitial phrase.
 *   - `nav-failed`      no response captured (status===null) — off-allowlist/unreachable.
 *   - `burned-exit`     (#45) a proxy escalation that EXHAUSTED every attempt without any exit reaching the
 *                       site (all dead-nav) — our residential exits died, distinct from the site blocking a
 *                       live exit. Emitted at the escalation SEAM (not by the single-page classifier, which
 *                       can't compare attempts) as a refinement of `nav-failed`; carries NO WAF vendor.
 *   - `timeout`         (#43) a call that exhausted the global wall-clock budget. Emitted at the retrieve /
 *                       drive escalation SEAM (not by the single-page classifier), overriding the incidental
 *                       block class of whatever the last attempt landed on.
 *   - `ok`              RESERVED — the #41 classifier only runs on FAILURES, so it never returns this;
 *                       held for a future success/home-fallback annotation.
 * On the RETRIEVE (outcome) path the classifier can produce the full vocabulary; on the interactive DRIVE
 * path a thin-200 shell is a returnable snapshot (never auto-failed), so drive emits only the block/nav
 * subset {anti-bot-block, captcha, hard-block, nav-failed} (issue #41; see classifyFailure's callers).
 */
export type FailureClass =
  | "anti-bot-block"
  | "captcha"
  | "hard-block"
  | "empty-shell"
  | "hydration-failed"
  | "real-zero-results"
  | "unsupported-browser"
  | "nav-failed"
  | "burned-exit"
  | "timeout"
  | "ok";

/**
 * Per-stage timing on a retrieve/drive call (issue #42) — the measurement half of the "why did it take 200s"
 * complaint (#43 is the control half). Every field is WALL-CLOCK MILLISECONDS from `performance.now()` diffs
 * (the ticket's coarse-Date.now path; the Resource-Timing sub-stages dns/connect/ttfb were deliberately DROPPED
 * — they are sub-second slivers inside the goto, absent on exactly the proxied/redirect paths that dominate the
 * budget, and reading them requires binding the goto Response, which throws on an aborted challenge nav and can
 * destroy the #39 envelope). The 160–220s worst case lives entirely in these wall-clock stages.
 *
 * `totalMs` is the only REQUIRED field (the whole-operation wall-clock); every stage is optional because a given
 * call only runs some of them (a clean page never polls for clearance; only the drive path solves a CAPTCHA). Per
 * proxied-attempt durations are NOT here — they ride {@link import("../verbs/retrieve.js").EscalationDiagnostics}'s
 * `attemptMs`, next to the `attempts` count they align 1:1 with. Defined in this low-level module (like
 * {@link WafVendor}/{@link FailureClass}) so the {@link FailureDiagnostics.timing} slot is TYPED to it; the values
 * are all numeric, so {@link redactFailureDiagnostics} passes it through UNTOUCHED (the safety basis is
 * "all-numeric", NOT the closed-vocab-forbids-free-text argument the vendor/class slots rest on).
 */
export interface Timing {
  /** Whole-operation wall-clock ms — a retrieve() call, one drive verb, or a single core render()/navigate(). */
  totalMs: number;
  /** Navigation → domcontentloaded wall-clock: `page.goto`'s (retrieve / drive-navigate) or, for a drive
   *  ACTION that submitted a form, the implicit nav's DCL wait. Absent on a pure snapshot or a non-navigating
   *  action (its ~0ms waitForLoadState no-op is omitted). */
  domContentLoadedMs?: number;
  /** Challenge-clearance poll WALL-CLOCK ms — the real time spent in the poll loop, `>=` the kill-gate's
   *  `clearanceWaitedMs` sleep-interval counter (each poll round-trip costs real time in the capped container). */
  clearancePollMs?: number;
  /** Interactive-CAPTCHA solve ms (drive path only; absent when no solve ran). */
  captchaSolveMs?: number;
  /** Snapshot / aria-tree extraction ms — includes the opt-in failure-screenshot capture when it is enabled. */
  snapshotMs?: number;
}

/**
 * Assemble a clean {@link Timing} from raw measured numbers (issue #42): each field is clamped to a NON-NEGATIVE
 * ROUNDED integer (a `performance.now()` diff is fractional, and a clock read across a boundary can go slightly
 * negative — a diagnostic must never surface a negative or a noisy fractional ms), and every `undefined` optional
 * is OMITTED (an absent stage is meaningfully different from a 0 — "did not run" vs "ran instantly"). `totalMs` is
 * always present. Pure + exported so the shape/clamp/omit contract is unit-testable without a browser.
 */
export function assembleTiming(measured: {
  totalMs: number;
  domContentLoadedMs?: number;
  clearancePollMs?: number;
  captchaSolveMs?: number;
  snapshotMs?: number;
}): Timing {
  const clamp = (n: number): number => Math.max(0, Math.round(n));
  const out: Timing = { totalMs: clamp(measured.totalMs) };
  if (measured.domContentLoadedMs !== undefined) out.domContentLoadedMs = clamp(measured.domContentLoadedMs);
  if (measured.clearancePollMs !== undefined) out.clearancePollMs = clamp(measured.clearancePollMs);
  if (measured.captchaSolveMs !== undefined) out.captchaSolveMs = clamp(measured.captchaSolveMs);
  if (measured.snapshotMs !== undefined) out.snapshotMs = clamp(measured.snapshotMs);
  return out;
}

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
  /** #40 mitigation/CAPTCHA vendor label — the {@link WafVendor} CLOSED vocabulary (the TYPE is the
   *  safety enforcement: {@link redactFailureDiagnostics} passes wafVendor through UNTOUCHED, safe only
   *  because it can never be page-derived free text — the type forbids assigning one). Attached at the
   *  REDACTION seam (retrieve.ts / drive #failure), NOT via {@link buildFailureDiagnostics}: it is a
   *  hint-derived slot and the drive envelope is assembled without HTML, so — like cfHint/pxHint — the
   *  vendor is resolved post-assembly at the surface. */
  wafVendor?: WafVendor;
  /** #41 failure CLASS — the {@link FailureClass} CLOSED vocabulary (the TYPE is the safety enforcement,
   *  like {@link wafVendor}: {@link redactFailureDiagnostics} passes it through UNTOUCHED, safe only
   *  because it can never be page-derived free text). Attached at the REDACTION seam (retrieve.ts / drive
   *  #failure), NOT via {@link buildFailureDiagnostics} — same as the vendor label. */
  failureClass?: FailureClass;
  /** #42 per-stage {@link Timing} — the WALL-CLOCK stage breakdown (totalMs + domContentLoaded/clearancePoll/
   *  captchaSolve/snapshot). Like {@link wafVendor}/{@link failureClass} it is attached at the REDACTION seam
   *  (retrieve.ts / drive #failure), NOT via {@link buildFailureDiagnostics}; the folded object is the SAME
   *  Timing carried on the result, so envelope.timing and result.timing can never disagree. All-numeric →
   *  passes {@link redactFailureDiagnostics} untouched. */
  timing?: Timing;
  /** Slot for #44 (why a CAPTCHA solve was/wasn't attempted) — a CLOSED union, not free text, so the
   *  redactor's untouched-passthrough is safe (parity with wafVendor/failureClass). Do NOT populate here. */
  captchaSolveReason?: CaptchaSolveReason;
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

/** Normalize backslash-escaped slashes (`\/` → `/`), so a JSON/log-escaped URL notation
 *  (`https:\/\/idp.example\/callback?code=…`) parses and sanitizes like the plain form instead of
 *  slipping past the URL scrubber with its query intact. */
function normalizeEscapedUrl(s: string): string {
  return s.replace(/\\\//g, "/");
}

/**
 * Reduce a URL to a minimal, FAIL-CLOSED form — the robust default, because sensitive material hides in
 * more than the query: userinfo (`user:pass@`), a path SEGMENT (a reset / magic-link token), the query,
 * the fragment, and a non-http opaque body (a `data:`/`javascript:` payload) can all carry credentials,
 * and none can be enumerated.
 *   - http(s): surfaced as `scheme://host[:port]` + (`/` for root, else `/<redacted>`) + `?<redacted>` /
 *     `#<redacted>` markers when present. The HOST is KEPT — it is the essential "which site failed"
 *     diagnostic; a secret encoded in a hostname label (DNS-exfil) is an accepted residual (see the note
 *     on {@link redactFailureDiagnostics}). The ROOT-vs-DEEP path distinction is preserved (#48 runs on
 *     the RAW url internally and surfaces only a boolean, so collapsing the surfaced path is safe).
 *   - ANY non-http scheme (`data:`, `blob:`, `javascript:`, `filesystem:`, `file:`, `about:`,
 *     `chrome-error:`, …): collapsed to `scheme:<redacted>` — the opaque body is NEVER kept (a
 *     `data:text/html,<token>` would otherwise leak its payload), only the scheme + presence markers.
 *   - Un-parseable (e.g. an out-of-range port `:99999`, which `new URL` REJECTS): returns
 *     `<unparseable-url>` rather than the raw string — fail closed, never leak an unparsed cred/token.
 * Escaped-slash notation is normalized first (the JSON-escaped-URL bypass fix).
 */
function sanitizeUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(normalizeEscapedUrl(raw));
  } catch {
    return "<unparseable-url>"; // fail closed: a rejected URL (bad port, malformed) must not leak raw
  }
  const marker = (u.search.length > 0 ? "?<redacted>" : "") + (u.hash.length > 0 ? "#<redacted>" : "");
  if (u.protocol === "http:" || u.protocol === "https:") {
    // Build from protocol + host (host is host:port only — never userinfo), so basic-auth creds are
    // dropped by construction; collapse any non-root path so a token segment can't leak.
    const deep = u.pathname !== "" && u.pathname !== "/";
    return `${u.protocol}//${u.host}${deep ? "/<redacted>" : "/"}${marker}`;
  }
  // Any non-http scheme: collapse the opaque body entirely — keep only the scheme + presence markers.
  return `${u.protocol}<redacted>${marker}`;
}

/** Sanitize every URL embedded in a free-text line (a console/network line frequently carries a full URL
 *  with its query/token). Two passes: http(s) — matching the backslash-escaped `https:\/\/…` notation
 *  too (the char class keeps backslashes so the escaped path is consumed and normalized inside
 *  sanitizeUrl) — and a scheme-agnostic pass for the RISKY opaque-body schemes (`data:`/`blob:`/
 *  `javascript:`/…), whose payloads must also be collapsed, not just http(s) URLs.
 *
 *  Both char classes stop ONLY at whitespace and quotes (the http pass also at `<`/`>`) — deliberately
 *  NOT at `)` / `]`, which are LEGAL inside a URL: excluding them truncated the match and leaked the
 *  valid-URL tail after a `)` (e.g. `…/reset/PREFIX)TAIL?code=…`). Over-consuming a trailing `)` / `.` /
 *  `,` from surrounding prose is the SAFE direction — sanitizeUrl collapses the WHOLE match to
 *  origin+depth, so the over-consumed prose is discarded, never leaked. Quotes stay excluded (and `<`/`>`
 *  for http, real JSON/HTML delimiters); a data: payload containing a literal quote is the documented
 *  truncation residual. */
const URL_IN_TEXT_RE = /https?:(?:\\?\/){2}[^\s"'<>]+/gi;
const RISKY_SCHEME_IN_TEXT_RE = /\b(?:data|blob|javascript|vbscript|filesystem|file|about|chrome-error):[^\s"']+/gi;
function sanitizeUrlsInText(s: string): string {
  return s.replace(URL_IN_TEXT_RE, (m) => sanitizeUrl(m)).replace(RISKY_SCHEME_IN_TEXT_RE, (m) => sanitizeUrl(m));
}

/**
 * Strip the value of any `cookie` / `set-cookie` / `authorization` header wherever it appears in a dump
 * line — always sensitive even when the value isn't a registered secret (a session cookie minted by the
 * site, a bearer the caller passed). Broadened past a bare same-line `name: value` to also catch: a
 * quoted / JSON key (`"Cookie":"…"`, `'authorization': '…'`, `Set-Cookie` inside a JSON blob), a `=`
 * separator, a quoted OR bare value, AND folded continuation lines — BOTH the RFC-style indented form
 * (`\n[ \t]+…`) AND an UNINDENTED next line that does NOT itself start a new header field (a token split
 * across a raw `\n`), so the tail can't leak. The continuation STOPS ONLY at a real next COLON-form field
 * (`name:`), NOT at a `key=value` line — so a `Content-Type: …` ends the redaction while an
 * `access_token=…` continuation tail is swallowed (the `[:=]`→`:`-only boundary fix). Over-redaction
 * (swallowing an unrelated non-field follow-on line) is the safe direction here.
 */
const SENSITIVE_HEADER_RE =
  /(["']?)\b(set-cookie|cookie|authorization)\b\1(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S[^\n]*(?:\n(?:[ \t]+\S|(?![ \t]*[\w-]+\s*:)\S)[^\n]*)*)/gi;
function stripSensitiveHeaders(s: string): string {
  return s.replace(SENSITIVE_HEADER_RE, (_m, q: string, name: string, sep: string) => `${q}${name}${q}${sep}[REDACTED]`);
}

/**
 * Redact an envelope before it is serialized to a caller/log (redact-before-serialize, R9). A
 * FAIL-CLOSED posture: a leak does NOT depend on a value being a registered secret. Applies —
 *   1. URL sanitization ({@link sanitizeUrl}) — finalUrl, every redirectChain entry, and any URL embedded
 *      in a console/network line: http(s) → origin + depth (userinfo, path segments, query, fragment all
 *      dropped); any non-http scheme → `scheme:<redacted>` (opaque body dropped); un-parseable →
 *      `<unparseable-url>`;
 *   2. the registered-secret pass (`redactSecrets`) — proxy/vault/consumer credential VALUES;
 *   3. cookie/set-cookie/authorization header stripping (quoted, JSON, `=`, and indented OR unindented
 *      folded continuations WITHIN an entry; a `key=value` continuation tail is swallowed — the boundary
 *      is a COLON-form next field only).
 * The `screenshotRef` (opaque base64 bytes) and the closed-vocabulary / numeric / boolean slots (wafVendor,
 * failureClass, the #44 captchaSolveReason union + solverEligible, and the all-numeric #42 {@link Timing})
 * pass through untouched.
 * `secrets` is a structural store (`{ redactableValues(): readonly string[] }`) — passing the VALUE SET
 * (not an opaque redactor) keeps the secret pass single-pass so a value can't fragment across redactors.
 *
 * ACCEPTED RESIDUALS (documented, deliberately not closed):
 *   - the http(s) HOST is KEPT — it is the essential "which site failed" diagnostic for internal
 *     consumers, and destroying it to defend a secret encoded in a DNS label (exotic hostname-exfil) is
 *     not worth the diagnostic loss;
 *   - a sensitive-header value SPLIT ACROSS TWO ARRAY ENTRIES is not carried. Each entry is scrubbed
 *     independently. This is UNREACHABLE in the capture model — a console entry is one atomic `msg.text()`
 *     and a networkFailures entry is `METHOD url errText` with NO header material — and a cross-entry
 *     "continuation" carry cannot be distinguished from two independent complete entries, so it would
 *     redact whole unrelated diagnostic entries (a `set-cookie:` ending one line would wipe the next).
 *     Per the redaction-vs-diagnostic-value trade-off, the carry is intentionally NOT implemented.
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
 * Sanitize a URL for a caller-facing ERROR STRING (not an envelope field) — e.g. the retrieve failure
 * message that interpolates the requested URL, or a drive error carrying a raw target URL. Same
 * fail-closed reduction as the envelope's URL fields (origin+depth for http(s), `scheme:<redacted>` for
 * non-http, `<unparseable-url>` on a parse failure), so no error surface echoes an unsanitized URL.
 */
export function sanitizeUrlForError(raw: string): string {
  return sanitizeUrl(raw);
}

/** Sanitize every URL embedded in a free-text error MESSAGE (a drive error interpolates a raw target
 *  URL). Reuses the envelope's in-text URL scrubber so an error surface can't echo an unsanitized URL. */
export function sanitizeUrlsInErrorText(s: string): string {
  return sanitizeUrlsInText(s);
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
