import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './tools.js';

/** Image tools (create_image, view_images) arrive in phase 5. Registers nothing yet. */
export function registerImageTools(server: McpServer, deps: ToolDeps): void {
  void server;
  void deps;
}
