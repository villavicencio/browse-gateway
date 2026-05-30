/**
 * MCP surface (U6): exposes the gateway's `retrieve` outcome verb as a single MCP tool to a
 * single consumer agent, replacing a per-agent third-party browser MCP. The `retrieve` function is
 * injected so the server is testable without a real gateway/browser; `main.ts` binds the
 * real one. A gateway error or a blocked page surfaces as a clean MCP tool error, never a hang.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MIN_CONTENT_LENGTH } from "../browser/index.js";

/** The slice of a RetrieveResult the MCP tool reports. */
export interface RetrieveOutcome {
  markdown: string;
  title: string;
  status: number | null;
  blocked: boolean;
  degraded: boolean;
  proxyUsed: boolean;
}

export type RetrieveFn = (input: { url: string }) => Promise<RetrieveOutcome>;

export interface GatewayMcpDeps {
  retrieve: RetrieveFn;
  name?: string;
  version?: string;
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
        "Fetch a URL through the browse-gateway (headful stealth browser + domain allowlist) " +
        "and return clean, readable markdown. Anti-bot, proxy escalation, and CAPTCHA are " +
        "handled internally; the caller only sees content.",
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
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Could not retrieve readable content for ${url} (blocked=${result.blocked}, status=${result.status ?? "n/a"}).`,
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

  return server;
}
