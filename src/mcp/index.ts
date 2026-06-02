/**
 * MCP surface barrel (U6). The stdio entry is `main.ts`; `createGatewayMcpServer` is the
 * testable core.
 */
export { createGatewayMcpServer } from "./server.js";
export type { DriveController, GatewayMcpDeps, RetrieveFn, RetrieveOutcome } from "./server.js";
