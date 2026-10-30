import { Hono, type MiddlewareHandler } from 'hono';
import type { ChatBackend } from '../chat/backend.js';
import type { AppDeps } from '../deps.js';
import { wallUrlForPort } from '../mcp/instructions.js';
import { handleMcpRequest } from '../mcp/server.js';
import type { ToolDeps } from '../mcp/tools.js';
import { apiRoutes } from './api.js';
import { imageRoutes } from './images.js';
import { revealRoutes, type RevealDeps } from './reveal.js';
import { isLoopbackUrl } from './sameOrigin.js';
import { staticRoutes } from './static.js';

/**
 * DNS-rebinding guard for /mcp. The request URL (built from the Host header by the node adapter)
 * must name loopback, and a browser Origin, when present, must be a loopback origin too.
 * Claude Code sends no Origin header.
 */
export const loopbackOnly: MiddlewareHandler = async (c, next) => {
  if (!isLoopbackUrl(c.req.url)) {
    return c.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Forbidden host.' }, id: null }, 403);
  }
  const origin = c.req.header('origin');
  if (origin !== undefined && !isLoopbackUrl(origin)) {
    return c.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Forbidden origin.' }, id: null }, 403);
  }
  await next();
};

export interface CreateAppOptions {
  /** The brain behind POST /api/chat. Omitted: apiRoutes' default (the stub). */
  chat?: ChatBackend;
  /** OS hooks behind /api/capabilities and the reveal route. Omitted: the real WSL detection and spawn. */
  reveal?: RevealDeps;
}

/**
 * What POST /mcp hands the MCP server. `wallUrl` comes from `Config.port` (`NOTESD_PORT`), so the
 * instructions' Links paragraph names the port this daemon is configured for. Port 0 (tests: "any
 * free port", only known after listen) leaves it unset and the instructions fall back to 7317.
 */
export function mcpToolDeps(deps: AppDeps): ToolDeps {
  const wallUrl = wallUrlForPort(deps.config.port);
  return {
    service: deps.service,
    dataDir: deps.config.dataDir,
    db: deps.db,
    ...(wallUrl !== undefined ? { wallUrl } : {}),
  };
}

/**
 * The whole HTTP surface, mounted in this order (later phases fill the routers, never this file):
 * /health, /mcp, apiRoutes (P6), imageRoutes (P5), revealRoutes (iteration 7: capabilities + reveal),
 * staticRoutes (P6, last: it owns the SPA fallback; it reserves /api, so the order is for clarity).
 */
export function createApp(deps: AppDeps, options: CreateAppOptions = {}): Hono {
  const app = new Hono();
  const toolDeps = mcpToolDeps(deps);

  app.get('/health', (c) => c.json({ ok: true, service: 'notesd' }));

  app.use('/mcp', loopbackOnly);
  app.post('/mcp', (c) => handleMcpRequest(c.req.raw, toolDeps));
  // Stateless server: no standalone SSE stream (GET) and no sessions to end (DELETE).
  app.on(['GET', 'DELETE'], '/mcp', (c) =>
    c.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }, 405, { Allow: 'POST' }),
  );

  app.route('/', apiRoutes(deps, { chat: options.chat }));
  app.route('/', imageRoutes(deps));
  app.route('/', revealRoutes(deps, { reveal: options.reveal }));
  app.route('/', staticRoutes(deps));
  return app;
}
