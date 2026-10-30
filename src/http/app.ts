import { Hono, type MiddlewareHandler } from 'hono';
import type { AppDeps } from '../deps.js';
import { handleMcpRequest } from '../mcp/server.js';
import { apiRoutes } from './api.js';
import { imageRoutes } from './images.js';
import { staticRoutes } from './static.js';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function isLoopbackUrl(value: string): boolean {
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}

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

/**
 * The whole HTTP surface, mounted in this order (later phases fill the routers, never this file):
 * /health, /mcp, apiRoutes (P6), imageRoutes (P5), staticRoutes (P6, last: it owns the SPA fallback).
 */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const toolDeps = { service: deps.service, dataDir: deps.config.dataDir, db: deps.db };

  app.get('/health', (c) => c.json({ ok: true, service: 'notesd' }));

  app.use('/mcp', loopbackOnly);
  app.post('/mcp', (c) => handleMcpRequest(c.req.raw, toolDeps));
  // Stateless server: no standalone SSE stream (GET) and no sessions to end (DELETE).
  app.on(['GET', 'DELETE'], '/mcp', (c) =>
    c.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }, 405, { Allow: 'POST' }),
  );

  app.route('/', apiRoutes(deps));
  app.route('/', imageRoutes(deps));
  app.route('/', staticRoutes(deps));
  return app;
}
