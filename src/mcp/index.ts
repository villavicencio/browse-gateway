/**
 * MCP surface barrel (U6). The stdio entry is `main.ts`; `createGatewayMcpServer` is the
 * testable core.
 */
export { createGatewayMcpServer, ERROR_KIND_META_KEY } from "./server.js";
export type { DriveController, GatewayMcpDeps, RetrieveFn, RetrieveOutcome, ErrorKind } from "./server.js";
export { createHttpHandler, dnsRebindBootError, awaitBounded } from "./http-server.js";
export type { HttpHandler, HttpHandlerDeps, ConsumerServer, HealthReport } from "./http-server.js";
