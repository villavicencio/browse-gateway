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

export function createGatewayMcpServer(deps: GatewayMcpDeps): McpServer {
  const server = new McpServer({
    name: deps.name ?? "browse-gateway",
    version: deps.version ?? "0.1.0",
  });

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
        return ok(formatSnapshot(await run()));
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

  return server;
}
