import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { defaultConnectors, registerConnectorTools } from '../connectors/register.js';
import { registerImageTools } from './imageTools.js';
import { buildInstructions } from './instructions.js';
import { registerNoteTools, type ToolDeps } from './tools.js';

export const SERVER_NAME = 'mcp-notes';
export const SERVER_VERSION = '0.1.0';

export function createMcpServer(deps: ToolDeps): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: buildInstructions(undefined, deps.wallUrl) },
  );
  registerNoteTools(server, deps);
  registerImageTools(server, deps);
  // Lazy: nothing is read or connected until a connector tool is called.
  registerConnectorTools(server, deps.connectors ?? defaultConnectors());
  return server;
}

/**
 * Stateless streamable HTTP: a fresh server and transport per POST, JSON responses (no SSE
 * stream). Nothing is kept between requests, so a daemon restart never strands a client.
 */
export async function handleMcpRequest(req: Request, deps: ToolDeps): Promise<Response> {
  const server = createMcpServer(deps);
  // No sessionIdGenerator: session management off (stateless mode).
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  try {
    await server.connect(transport);
    return await transport.handleRequest(req);
  } finally {
    await server.close();
  }
}
