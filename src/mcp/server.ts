/**
 * MCP surface (U6): exposes the gateway's `retrieve` outcome verb as a single MCP tool to a
 * single consumer agent, replacing a per-agent third-party browser MCP. The `retrieve` function is
 * injected so the server is testable without a real gateway/browser; `main.ts` binds the
 * real one. A gateway error or a blocked page surfaces as a clean MCP tool error, never a hang.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DriveTarget, PageSnapshot, WaitCondition } from "../browser/index.js";
import type { BlockReason, EscalationDiagnostics } from "../verbs/index.js";
import { EscalationError, isRetrieveFailure } from "../verbs/index.js";
import { summarizeFailureDiagnostics, failureOf, sanitizeUrlForError, sanitizeUrlsInErrorText } from "../observability/index.js";
import type { FailureDiagnostics, Timing } from "../observability/index.js";
import type { ArtifactOutcome, ArtifactResponseLease } from "../artifacts/index.js";
import { getArtifactLeaseTracker } from "./http-request-context.js";
import { ARTIFACT_TOOL_NAME } from "./http-response-lease.js";
import { resolveGatewayVersion } from "./version.js";

/**
 * `_meta` key on a tool ERROR result carrying a machine-readable failure kind (issue #47), so a
 * client-side circuit breaker (a downstream consumer, out of this repo) can act on the failure without
 * parsing the human-readable text. Namespaced under a prefix this repo controls (the `io.modelcontextprotocol/*`
 * prefix is reserved for the spec). The base MCP `Result` `_meta` is passthrough, so the value reaches
 * the client verbatim.
 */
export const ERROR_KIND_META_KEY = "browse-gateway/error-kind";

/**
 * The kind tag on a tool error (issue #47), keyed by {@link ERROR_KIND_META_KEY}:
 *  - `in-band`  — a COMPLETED round-trip that returned a negative result: a WAF/challenge block, an empty
 *                 extraction, or a nav that failed to reach the target. The gateway is HEALTHY; the page /
 *                 target was the problem. A breaker must NOT count this toward unreachability.
 *  - `internal` — the gateway or browser itself threw but the server still RESPONDED (a browser crash, an
 *                 action error like a locator timeout, a config error, a session-limit refusal). Alive-but-
 *                 errored — NOT a transport failure either way.
 * The distinction is drawn from the ACTUAL failure verdict, never the error wrapper: retrieve's shared
 * in-band failure predicate (`isRetrieveFailure`), or — on the drive path — whether the failure envelope
 * carries a `failureClass`, which the drive layer sets only for a genuine navFailed block/nav-failure (so a
 * healthy-page locator timeout or a "no proxy available" config error, both merely enveloped, stay
 * `internal`). Genuine TRANSPORT failures (connection refused / reset / request timeout) never produce a
 * tool result at all — the client's transport observes those directly — so they are deliberately not
 * enumerated here; a breaker cools on transport failures, exempts `in-band`, and treats `internal` at its
 * discretion.
 */
export type ErrorKind = "in-band" | "internal";

const errorKindMeta = (kind: ErrorKind) => ({ [ERROR_KIND_META_KEY]: kind });

/**
 * Task 2 §3.5 — the ONE external shape every `browser_get_artifact` denial collapses to before a
 * lease is acquired: invalid grammar, unknown, foreign, wrong-controller, expired, consumed,
 * concurrent, rate-limited, and "no active HTTP request context" are all indistinguishable from
 * outside. No `structuredContent`, no status/timing/owner-scope hint — any of those would turn the
 * response into an oracle. Frozen so no caller can mutate the shared literal.
 */
const ARTIFACT_UNAVAILABLE_RESULT = Object.freeze({
  isError: true as const,
  _meta: Object.freeze(errorKindMeta("in-band")),
  content: [Object.freeze({ type: "text" as const, text: "Artifact is unavailable." })],
});

/** The slice of a RetrieveResult the MCP tool reports. */
export interface RetrieveOutcome {
  markdown: string;
  title: string;
  status: number | null;
  blocked: boolean;
  /** Why it was blocked (diagnostic); `null` when not blocked. */
  reason: BlockReason | null;
  degraded: boolean;
  proxyUsed: boolean;
  /** A CAPTCHA was detected and handed to the (v1: no-op) solver. */
  captchaSolved: boolean;
  /** A SILENT HOME-FALLBACK was detected (issue #48): the requested DEEP link (non-root path / query)
   *  landed on the site's bare root. Omitted (never `false`) when not detected. On a SUCCESS it is surfaced
   *  via the tool result's `structuredContent` (keeping the markdown text pure); on a FAILURE it also rides
   *  the {@link diagnostics} envelope, rendered in the failure text. */
  homeFallback?: boolean;
  /** Structured proxy-escalation diagnostics when escalation ran (issue #21); absent otherwise. */
  proxyDiagnostic?: EscalationDiagnostics;
  /** Failure-evidence envelope (issue #39): finalUrl / title / status / redirect chain / console +
   *  network / optional screenshot — present ONLY on a blocked/failed retrieve, already redacted. */
  diagnostics?: FailureDiagnostics;
  /** Per-stage {@link Timing} (issue #42) — the wall-clock breakdown of this retrieve call. Always present
   *  on a real retrieve; on a FAILURE it is also inside {@link diagnostics} (rendered in the tool error).
   *  On a SUCCESS the tool returns clean markdown (no timing line — content purity), so this carries the
   *  breakdown at the result-object level for a programmatic caller. */
  timing?: Timing;
  /** Task 2 §3.2 — the sealed capture outcome for this retrieve, when artifact capture is configured
   *  (the capture-operation wiring itself is separate scope). Absent means artifact-disabled: the tool
   *  output stays byte-identical to pre-Task-2 retrieve. Mirrors {@link PageSnapshot.artifactOutcome}. */
  artifactOutcome?: ArtifactOutcome;
}

export type RetrieveFn = (input: { url: string; forceProxy?: boolean }) => Promise<RetrieveOutcome>;

/**
 * The stateful `drive` surface: one persistent, consumer-bound session the agent opens, drives
 * across calls, and closes. Action verbs return the post-action page snapshot (ref-annotated) so
 * the agent observes the result without a separate snapshot call (mirrors Playwright-MCP). The
 * concrete controller (main.ts) tracks the current session handle; this server only maps tools to
 * it and turns failures into clean MCP errors.
 */
export interface DriveController {
  open(): Promise<void>;
  navigate(url: string, opts?: { forceProxy?: boolean }): Promise<PageSnapshot>;
  snapshot(): Promise<PageSnapshot>;
  click(target: DriveTarget): Promise<PageSnapshot>;
  type(target: DriveTarget, text: string, submit?: boolean): Promise<PageSnapshot>;
  selectOption(target: DriveTarget, values: string[]): Promise<PageSnapshot>;
  pressKey(key: string): Promise<PageSnapshot>;
  waitFor(condition: WaitCondition): Promise<PageSnapshot>;
  screenshot(): Promise<string>;
  close(): Promise<void>;
}

export interface GatewayMcpDeps {
  retrieve: RetrieveFn;
  /** Optional interactive surface; when present, the `browser_*` drive tools are registered too. */
  drive?: DriveController;
  name?: string;
  version?: string;
  /**
   * Task 2 §4.2 — the server-scoped, IMMUTABLE artifact-retrieval dependency. Present only when HTTP
   * artifact support is enabled for this server graph; absent means `browser_get_artifact` is not
   * registered at all (Task 2 §3.3). `consumerId`/`controllerId` are the trusted, server-minted
   * identities this graph is bound to — MCP input never carries them. `consumeForServer` is the
   * runtime's `acquireResponseLease` closed over nothing but those identities plus the caller's
   * artifact ID; lifecycle methods and transport-tracker controls deliberately do not enter this
   * shape (Task 2 §4.2: "Lifecycle methods and transport-tracker controls do not enter GatewayMcpDeps").
   */
  artifacts?: {
    readonly consumerId: string;
    readonly controllerId?: string;
    consumeForServer(input: { artifactId: string; consumerId: string; controllerId?: string }): Promise<ArtifactResponseLease>;
  };
}

/**
 * Task 2 §4.2 — read `artifacts`'s identity primitives and `consumeForServer` EXACTLY ONCE, validate
 * them, and freeze the result into local constants the server never re-reads `deps.artifacts` for
 * again. `deps.artifacts` is trusted server-side wiring (an entrypoint closes over the runtime), not
 * caller input — a hostile getter or a later mutation on that dependency object must not be able to
 * retarget an already-registered tool's owner/lineage (acceptance C6), so this is the ONE read.
 *
 * Throws when malformed: an invalid `GatewayMcpDeps.artifacts` is a construction-time wiring defect,
 * not a runtime denial a caller can trigger — nothing here is reachable from MCP input.
 */
function snapshotArtifactIdentity(
  artifacts: NonNullable<GatewayMcpDeps["artifacts"]>,
  driveEnabled: boolean,
): { consumerId: string; controllerId?: string; consumeForServer: NonNullable<GatewayMcpDeps["artifacts"]>["consumeForServer"] } {
  let consumerId: unknown, controllerId: unknown, consumeForServer: unknown;
  try {
    // One synchronous snapshot: a getter/proxy may throw or answer differently on a second read, and
    // neither may govern which identity this server graph is bound to.
    consumerId = artifacts.consumerId;
    controllerId = artifacts.controllerId;
    consumeForServer = artifacts.consumeForServer;
  } catch {
    throw new Error("GatewayMcpDeps.artifacts: reading consumerId/controllerId/consumeForServer threw");
  }
  if (typeof consumerId !== "string" || consumerId.length === 0) {
    throw new Error("GatewayMcpDeps.artifacts.consumerId must be a non-empty string");
  }
  if (controllerId !== undefined && (typeof controllerId !== "string" || controllerId.length === 0)) {
    throw new Error("GatewayMcpDeps.artifacts.controllerId must be a non-empty string when present");
  }
  // Task 2 §4.2: "controllerId is mandatory when drive and artifacts coexist" — a drive artifact can
  // never be authorized without controller lineage, so a graph that has both must snapshot one.
  if (driveEnabled && controllerId === undefined) {
    throw new Error("GatewayMcpDeps.artifacts.controllerId is required when drive and artifacts coexist");
  }
  if (typeof consumeForServer !== "function") {
    throw new Error("GatewayMcpDeps.artifacts.consumeForServer must be a function");
  }
  return Object.freeze({
    consumerId,
    controllerId: controllerId as string | undefined,
    consumeForServer: consumeForServer as NonNullable<GatewayMcpDeps["artifacts"]>["consumeForServer"],
  });
}

/** Task 2 §3.2 — project a committed {@link ArtifactOutcome} into MCP `structuredContent`, or
 *  `undefined` when nothing should be added. The artifact-disabled (`undefined`) and no-artifact
 *  (`"none"`) cases both answer `undefined` here, which is what keeps that output byte-identical to
 *  pre-Task-2 behavior — neither manufactures a field. */
function artifactStructuredContent(outcome: ArtifactOutcome | undefined): Record<string, unknown> | undefined {
  if (!outcome || outcome.outcome === "none") return undefined;
  if (outcome.outcome === "available") return { artifactOutcome: "available", artifact: outcome.artifact };
  return { artifactOutcome: outcome.outcome, artifactFailure: outcome.failure };
}

/** Render a snapshot for the agent: a url/title header plus the ref-annotated accessibility tree. The
 *  header surfaces the captured status + CF/PX/DataDome vendor hints (issue #39/#40 — computed on the
 *  snapshot but otherwise dropped here); only non-empty signals are shown, so a clean 2xx page with no
 *  hints keeps the original two-line header. */
function formatSnapshot(snap: PageSnapshot): string {
  const bits: string[] = [];
  if (snap.status != null) bits.push(`status: ${snap.status}`);
  if (snap.cfHint) bits.push("cfHint: true");
  if (snap.pxHint) bits.push("pxHint: true");
  // #82: the shape-invariant press-&-hold signal (pxCopy) survives a FAT top frame where pxHint + isHardBlock
  // miss — surface it alongside pxHint so a standalone browser_snapshot of an async PX challenge shows it.
  if (snap.pxCopy) bits.push("pxCopy: true");
  if (snap.ddHint) bits.push("ddHint: true");
  // #48: a deep link that silently landed on the site's bare root — surfaced so an in-loop agent sees the
  // homepage-fallback rather than mistaking it for the requested page. Non-fatal (the snapshot is returned).
  if (snap.homeFallback) bits.push("homeFallback: true");
  // #42: surface the whole-verb wall-clock so a slow drive nav is legible even on SUCCESS (the failure
  // path already renders the full timing breakdown via the envelope). Compact — just the total.
  if (snap.timing?.totalMs != null) bits.push(`total: ${snap.timing.totalMs}ms`);
  const meta = bits.length ? `\n${bits.join("  ")}` : "";
  return `url: ${snap.url}\ntitle: ${snap.title}${meta}\n\n${snap.tree}`;
}

/** Serialize a redacted failure envelope for a text tool error, with the base64 screenshot shrunk to a
 *  size marker so a diagnostics line stays small + readable. */
function renderFailure(diag: FailureDiagnostics): string {
  return `\nfailure: ${JSON.stringify(summarizeFailureDiagnostics(diag))}`;
}

// U1: the default is RESOLVED, never a literal. Memoized because `createGatewayMcpServer` runs
// once per HTTP connection — the launchers pass `deps.version` explicitly (resolved at boot), so
// this path is for tests and for `validate-http.mjs`, which builds its own server and therefore
// gates the RESOLVER inside the image. It does not gate the launcher; see CLAUDE.md.
let memoizedVersion: string | undefined;
const resolvedDefaultVersion = (): string => (memoizedVersion ??= resolveGatewayVersion().reported);

export function createGatewayMcpServer(deps: GatewayMcpDeps): McpServer {
  const server = new McpServer({
    name: deps.name ?? "browse-gateway",
    version: deps.version ?? resolvedDefaultVersion(),
  });

  // Task 2 §4.2: snapshot ONCE at construction, before any tool is registered — `browser_get_artifact`
  // below closes over this frozen local, never `deps.artifacts` again.
  const artifactIdentity = deps.artifacts ? snapshotArtifactIdentity(deps.artifacts, deps.drive !== undefined) : undefined;

  server.registerTool(
    "retrieve",
    {
      title: "Retrieve readable content",
      description:
        "Read any web page as clean, readable markdown. Preferred for fetching page content: it " +
        "runs a stealth browser that clears Cloudflare / anti-bot / CAPTCHA and rotates a clean " +
        "residential IP on hard blocks, so it succeeds where an ordinary browser is blocked or " +
        'returns "Forbidden". Prefer this over a generic browser for reading a URL; use the ' +
        "browser_* drive tools only when you must interact (click, fill forms, multi-step flows).",
      inputSchema: {
        url: z.string().url().describe("Absolute URL to retrieve"),
        forceProxy: z
          .boolean()
          .optional()
          .describe("Route through the residential proxy from the first request (for known-hostile hosts)"),
      },
    },
    async ({ url, forceProxy }) => {
      try {
        const result = await deps.retrieve({ url, forceProxy });
        // Task 2 §3.2 — the capture outcome is checked BEFORE the ordinary failure predicate: an
        // absent field or `{outcome:"none"}` falls straight through to existing behavior (byte-
        // identical), so neither manufactures a field. `"available"` is a deliberate SUCCESS with no
        // markdown (the bytes live in the artifact, fetched separately via browser_get_artifact) —
        // not an MCP error. `inline-pdf-unsupported`/`capture-failed` surface a sanitized, closed
        // in-band error carrying only the authorized URL and the closed failure code — never raw
        // driver/fs/path text.
        const artifact = result.artifactOutcome;
        if (artifact && artifact.outcome === "available") {
          return {
            content: [{ type: "text", text: "" }],
            structuredContent: { artifactOutcome: "available", artifact: artifact.artifact },
          };
        }
        if (artifact && (artifact.outcome === "inline-pdf-unsupported" || artifact.outcome === "capture-failed")) {
          return {
            isError: true,
            _meta: errorKindMeta("in-band"),
            content: [{ type: "text", text: `Could not capture an artifact for ${sanitizeUrlForError(url)} (artifactFailure=${artifact.failure}).` }],
            structuredContent: { artifactOutcome: artifact.outcome, artifactFailure: artifact.failure },
          };
        }
        // The SHARED retrieve-failure predicate (retrieve() attaches the evidence envelope on exactly
        // this condition, #39): blocked, empty/whitespace markdown (empty extraction), or a failed nav
        // (null status + thin body — an off-allowlist/unreachable target whose thin error page must not
        // be handed back as content). A short-but-valid page has a real status + content, so it is fine.
        if (isRetrieveFailure(result)) {
          // Surface WHY, plus whether escalation engaged, so a failure is diagnosable instead of a
          // silent "blocked". `captcha` is the actionable one — it means an interactive challenge
          // with no solver wired (v1), which no proxy can clear.
          // Prefer the block `reason`; else the typed failure CLASS from the #39 envelope (#41 — this
          // formalizes the old `empty-content` literal into the enum: on a non-blocked empty/thin failure
          // the real retrieve path always attaches a failureClass, so a reader sees empty-shell /
          // hydration-failed / real-zero-results / unsupported-browser instead of an opaque `empty-content`).
          // The literal remains only as a defensive last resort (an outcome carrying no envelope at all).
          const why = result.reason ?? result.diagnostics?.failureClass ?? "empty-content";
          // Hint on the surfaced `why` (not just `result.reason`), so a thin-shell CAPTCHA served as a
          // 200 — surfaced as failureClass=captcha with reason=null (the #40 empty-shell follow-up) — still
          // tells the caller it needs a solver, at parity with a reason=captcha block.
          const hint = why === "captcha" ? " — interactive CAPTCHA, no solver configured" : "";
          const diag = result.proxyDiagnostic ? `\ndiagnostics: ${JSON.stringify(result.proxyDiagnostic)}` : "";
          // Surface the failure-evidence envelope (issue #39) — finalUrl / title / status / redirect chain /
          // console + network — so a retrieve failure is diagnosable instead of opaque. Already redacted.
          const failure = result.diagnostics ? renderFailure(result.diagnostics) : "";
          return {
            isError: true,
            // #47: in-band — a completed round-trip that returned a blocked / empty / unreachable result
            // (the shared isRetrieveFailure predicate). The gateway is healthy; a breaker must not count it.
            _meta: errorKindMeta("in-band"),
            content: [
              {
                type: "text",
                // Sanitize the interpolated REQUEST url — the raw input can carry userinfo/reset-token/
                // OAuth-code (issue #39 r3: an error surface must not echo an unsanitized URL).
                text: `Could not retrieve readable content for ${sanitizeUrlForError(url)} (reason=${why}, status=${result.status ?? "n/a"}, proxyUsed=${result.proxyUsed}, captchaSolved=${result.captchaSolved}).${hint}${diag}${failure}`,
              },
            ],
          };
        }
        // #48: a SUCCESS-shaped silent home-fallback (a fat homepage handed back for a deep link) carries no
        // failure envelope, so surface the flag via `structuredContent` — the MCP-native metadata channel —
        // keeping the returned markdown PURE (no gateway chrome injected into page content). Omitted when not
        // detected, so a clean success is byte-for-byte unchanged.
        return {
          content: [{ type: "text", text: result.markdown }],
          ...(result.homeFallback ? { structuredContent: { homeFallback: true } } : {}),
        };
      } catch (err) {
        // Gateway down / browser crash: a clean tool error, never a hang or a leaked secret. The message
        // may carry a raw target URL (e.g. "unsupported URL scheme: … (<url>)"), so sanitize any URL in it.
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          // #47: the retrieve call threw — the gateway responded but a sub-op errored (alive, not a
          // transport failure). Typed `internal` so a breaker can distinguish it from an in-band block.
          _meta: errorKindMeta("internal"),
          content: [{ type: "text", text: `browse-gateway error: ${sanitizeUrlsInErrorText(message)}` }],
        };
      }
    },
  );

  // --- Interactive `drive` tools (Playwright-MCP-shaped), registered only when a controller is
  // injected. Every verb runs through the consumer-bound, guarded session; failures become clean
  // MCP errors. Action verbs return the post-action snapshot so the agent sees the result.
  const drive = deps.drive;
  if (drive) {
    const fail = (err: unknown) => {
      // Drive errors interpolate a raw target URL (`navigation failed … for <url>`, warm errors, etc.),
      // so sanitize any URL in the message before it becomes tool text/logs (issue #39 r3).
      const message = sanitizeUrlsInErrorText(err instanceof Error ? err.message : String(err));
      let text = `browse-gateway error: ${message}`;
      // Attach structured escalation diagnostics when present so the caller sees WHY a proxied
      // navigation failed (proxy applied? which exit? what blocked it?). Secrets-free by construction.
      if (err instanceof EscalationError) text += `\ndiagnostics: ${JSON.stringify(err.diagnostics)}`;
      // Surface the failure-evidence envelope (issue #39) at parity with retrieve — from an
      // EscalationError's `.failure` or a plain drive error decorated by attachFailure. Already redacted.
      const failure = failureOf(err);
      if (failure) text += renderFailure(failure);
      // #47: type the failure kind for a client breaker from the ACTUAL failure verdict, not the wrapper
      // (codex r1). The envelope carries a `failureClass` ONLY for a genuine navFailed block/nav-failure —
      // so a real WAF/challenge/unreachable failure is `in-band` (gateway healthy), while a healthy-page
      // action error (locator timeout, enveloped but unclassified) OR a config EscalationError (force-proxy
      // with no proxy available, thrown with no envelope) correctly stays `internal`.
      const kind: ErrorKind = failure?.failureClass ? "in-band" : "internal";
      return { isError: true as const, _meta: errorKindMeta(kind), content: [{ type: "text" as const, text }] };
    };
    const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
    const snap = async (run: () => Promise<PageSnapshot>) => {
      try {
        const result = await run();
        // Task 2 §3.2: `formatSnapshot` text is NEVER touched — structuredContent is the sole
        // carrier, added only when an internal artifact object exists and isn't the no-artifact case.
        const structuredContent = artifactStructuredContent(result.artifactOutcome);
        return {
          content: [{ type: "text" as const, text: formatSnapshot(result) }],
          ...(structuredContent ? { structuredContent } : {}),
        };
      } catch (err) {
        return fail(err);
      }
    };

    server.registerTool(
      "browser_open",
      {
        title: "Open a drive session",
        description:
          "Open a stateful stealth browser session for interactive work (clicks, forms, multi-step flows). " +
          "Drive it with the other browser_* tools; call browser_close when done. To simply read a page, prefer `retrieve`.",
        inputSchema: {},
      },
      async () => {
        try {
          await drive.open();
          return ok("Drive session opened. Call browser_navigate to load a page.");
        } catch (err) {
          return fail(err);
        }
      },
    );

    server.registerTool(
      "browser_navigate",
      {
        title: "Navigate the drive session",
        description:
          "Open a URL in the drive session and return a ref-annotated accessibility snapshot of the page. Starts a session if none is open. A logged-in (warm) session is pinned to one owner host: navigating a different host returns a typed owner-host-mismatch — open a separate drive session per host.",
        inputSchema: {
          url: z.string().url().describe("Absolute URL to open"),
          forceProxy: z
            .boolean()
            .optional()
            .describe("Skip the direct attempt and route through the residential proxy from the first request (for known-hostile hosts)"),
        },
      },
      async ({ url, forceProxy }) => snap(() => drive.navigate(url, { forceProxy })),
    );

    server.registerTool(
      "browser_snapshot",
      {
        title: "Snapshot the page",
        description:
          "Capture a ref-annotated accessibility snapshot of the current page. Each element carries a [ref=...] you pass as `target` to click/type/select.",
        inputSchema: {},
      },
      async () => snap(() => drive.snapshot()),
    );

    server.registerTool(
      "browser_click",
      {
        title: "Click an element",
        description:
          "Click the element identified by `target` (a [ref=...] from a snapshot, or a unique selector). Returns the page snapshot after the click.",
        inputSchema: {
          target: z.string().describe("A snapshot ref (e.g. e4) or a unique selector"),
          element: z.string().optional().describe("Human-readable element description (for the audit trail)"),
        },
      },
      async ({ target, element }) => snap(() => drive.click({ target, element })),
    );

    server.registerTool(
      "browser_type",
      {
        title: "Type into an element",
        description:
          "Fill text into the element identified by `target`; set `submit` to press Enter afterward. Returns the page snapshot after typing.",
        inputSchema: {
          target: z.string().describe("A snapshot ref or selector"),
          element: z.string().optional().describe("Human-readable element description"),
          text: z.string().describe("Text to type"),
          submit: z.boolean().optional().describe("Press Enter after typing"),
        },
      },
      async ({ target, element, text, submit }) => snap(() => drive.type({ target, element }, text, submit)),
    );

    server.registerTool(
      "browser_select_option",
      {
        title: "Select option(s)",
        description:
          "Select option(s) by value or label on a dropdown identified by `target`. Returns the page snapshot after selecting.",
        inputSchema: {
          target: z.string().describe("A snapshot ref or selector for the dropdown"),
          element: z.string().optional().describe("Human-readable element description"),
          values: z.array(z.string()).describe("Option values or labels to select"),
        },
      },
      async ({ target, element, values }) => snap(() => drive.selectOption({ target, element }, values)),
    );

    server.registerTool(
      "browser_press_key",
      {
        title: "Press a key",
        description:
          "Press a keyboard key on the page (e.g. Enter, Escape, ArrowDown, Tab). Returns the page snapshot after the key press.",
        inputSchema: { key: z.string().describe("Key name, e.g. Enter / Escape / ArrowDown") },
      },
      async ({ key }) => snap(() => drive.pressKey(key)),
    );

    server.registerTool(
      "browser_wait_for",
      {
        title: "Wait for text or time",
        description:
          "Wait for `text` to appear on the page, or for `timeMs` milliseconds. Returns the page snapshot after waiting.",
        inputSchema: {
          text: z.string().optional().describe("Text to wait for"),
          timeMs: z.number().optional().describe("Milliseconds to wait"),
        },
      },
      async ({ text, timeMs }) => snap(() => drive.waitFor({ text, timeMs })),
    );

    server.registerTool(
      "browser_take_screenshot",
      {
        title: "Screenshot the page",
        description:
          "Capture a PNG screenshot of the current page. Prefer browser_snapshot for acting on the page; use a screenshot for visual confirmation.",
        inputSchema: {},
      },
      async () => {
        try {
          const data = await drive.screenshot();
          return { content: [{ type: "image" as const, data, mimeType: "image/png" }] };
        } catch (err) {
          return fail(err);
        }
      },
    );

    server.registerTool(
      "browser_close",
      {
        title: "Close the drive session",
        description:
          "Close the drive session and free its browser. Call when the interactive task is done. " +
          "Always safe and idempotent: closing an already-closed or never-opened session is a no-op, " +
          "so a client may call it for cleanup unconditionally (and exempt it from any breaker cooldown).",
        inputSchema: {},
        // #47: advertise the cleanup verb as idempotent/always-safe so a client-side breaker can exempt
        // it from a cooldown gate. close() -> gateway release is a no-op for an unknown/closed id and
        // swallows errors, so it neither destroys data nor depends on session state.
        annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: false },
      },
      async () => {
        try {
          await drive.close();
          return ok("Drive session closed.");
        } catch (err) {
          return fail(err);
        }
      },
    );
  }

  // Task 2 §3.3/§4.2/§5.1 — registered only when a server-scoped artifact dependency was supplied and
  // validated at construction. Input is deliberately the strict, string-only shape: identities are
  // closed over the server graph, never MCP input (Task 2 §7 threat 1).
  if (artifactIdentity) {
    server.registerTool(
      ARTIFACT_TOOL_NAME,
      {
        title: "Get a captured artifact",
        description:
          "Retrieve a PDF artifact captured during a prior retrieve/browser_navigate call, by its opaque artifactId " +
          "(surfaced in that call's structuredContent). Returns the PDF bytes as an embedded resource.",
        inputSchema: z.object({ artifactId: z.string() }).strict(),
      },
      async (args, extra) => {
        // Task 2 §5.1 guarded order, step 1: an active tracker is required before acquisition — a
        // call reaching this tool outside an active HTTP POST dispatch (e.g. no real HTTP layer, or a
        // requestId that doesn't match the currently active dispatch) is a closed invariant failure,
        // collapsed to the same external denial as every other runtime refusal.
        const tracker = getArtifactLeaseTracker(extra.requestId);
        if (!tracker) return ARTIFACT_UNAVAILABLE_RESULT;
        let lease: ArtifactResponseLease;
        try {
          // Step 2: acquire. Every runtime denial — invalid grammar, unknown, foreign, wrong-lineage,
          // expired, consumed, concurrent, rate-limited — collapses to the one fixed external result;
          // none of the closed internal codes reaches the caller (Task 2 §3.5/§7).
          lease = await artifactIdentity.consumeForServer({
            artifactId: args.artifactId,
            consumerId: artifactIdentity.consumerId,
            controllerId: artifactIdentity.controllerId,
          });
        } catch {
          return ARTIFACT_UNAVAILABLE_RESULT;
        }
        try {
          // Step 3: register synchronously, before reading/returning `lease.resource`.
          tracker.register(lease);
        } catch {
          // Step 4: acquisition succeeded but registration failed (duplicate/terminal tracker —
          // register() has already fail-completed the lease it rejected; this fallback call is
          // idempotent belt-and-braces, matching the fixed §3.5 external result either way).
          await lease.complete("transport-failed").catch(() => {});
          return ARTIFACT_UNAVAILABLE_RESULT;
        }
        // Step 5: once registered, only the tracker may ever complete this lease — no catch here, so
        // a later throw (e.g. a hostile resource getter) propagates untouched to the SDK, and the
        // tracker's own finish/close/error/deadline handling terminalizes it exactly once.
        return { content: [lease.resource], structuredContent: { artifact: lease.metadata } };
      },
    );
  }

  return server;
}
