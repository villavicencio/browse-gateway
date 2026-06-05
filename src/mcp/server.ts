/**
 * MCP surface (U6): exposes the gateway's `retrieve` outcome verb as a single MCP tool to a
 * single consumer agent, replacing a per-agent third-party browser MCP. The `retrieve` function is
 * injected so the server is testable without a real gateway/browser; `main.ts` binds the
 * real one. A gateway error or a blocked page surfaces as a clean MCP tool error, never a hang.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MIN_CONTENT_LENGTH } from "../browser/index.js";
import type { DriveTarget, PageSnapshot, WaitCondition } from "../browser/index.js";
import type { BlockReason } from "../verbs/index.js";

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
}

export type RetrieveFn = (input: { url: string }) => Promise<RetrieveOutcome>;

/**
 * The stateful `drive` surface: one persistent, consumer-bound session the agent opens, drives
 * across calls, and closes. Action verbs return the post-action page snapshot (ref-annotated) so
 * the agent observes the result without a separate snapshot call (mirrors Playwright-MCP). The
 * concrete controller (main.ts) tracks the current session handle; this server only maps tools to
 * it and turns failures into clean MCP errors.
 */
export interface DriveController {
  open(): Promise<void>;
  navigate(url: string): Promise<PageSnapshot>;
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

/** Render a snapshot for the agent: a url/title header plus the ref-annotated accessibility tree. */
function formatSnapshot(snap: PageSnapshot): string {
  return `url: ${snap.url}\ntitle: ${snap.title}\n\n${snap.tree}`;
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
      inputSchema: { url: z.string().url().describe("Absolute URL to retrieve") },
    },
    async ({ url }) => {
      try {
        const result = await deps.retrieve({ url });
        // A null status means the navigation never completed — an off-allowlist policy block
        // or an unreachable host — so the browser's own error page (thin content) must not be
        // handed back as a successful result. A short-but-valid page has a real status, so it
        // is unaffected.
        const navFailed = result.status === null && result.markdown.length < MIN_CONTENT_LENGTH;
        if (result.blocked || !result.markdown || navFailed) {
          // Surface WHY, plus whether escalation engaged, so a failure is diagnosable instead of a
          // silent "blocked". `captcha` is the actionable one — it means an interactive challenge
          // with no solver wired (v1), which no proxy can clear.
          const why = result.reason ?? "empty-content";
          const hint = result.reason === "captcha" ? " — interactive CAPTCHA, no solver configured" : "";
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Could not retrieve readable content for ${url} (reason=${why}, status=${result.status ?? "n/a"}, proxyUsed=${result.proxyUsed}, captchaSolved=${result.captchaSolved}).${hint}`,
              },
            ],
          };
        }
        return { content: [{ type: "text", text: result.markdown }] };
      } catch (err) {
        // Gateway down / browser crash: a clean tool error, never a hang or a leaked secret.
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: "text", text: `browse-gateway error: ${message}` }],
        };
      }
    },
  );

  // --- Interactive `drive` tools (Playwright-MCP-shaped), registered only when a controller is
  // injected. Every verb runs through the consumer-bound, guarded session; failures become clean
  // MCP errors. Action verbs return the post-action snapshot so the agent sees the result.
  const drive = deps.drive;
  if (drive) {
    const fail = (err: unknown) => ({
      isError: true as const,
      content: [
        { type: "text" as const, text: `browse-gateway error: ${err instanceof Error ? err.message : String(err)}` },
      ],
    });
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
          "Open a URL in the drive session and return a ref-annotated accessibility snapshot of the page. Starts a session if none is open.",
        inputSchema: { url: z.string().url().describe("Absolute URL to open") },
      },
      async ({ url }) => snap(() => drive.navigate(url)),
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
        description: "Close the drive session and free its browser. Call when the interactive task is done.",
        inputSchema: {},
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
