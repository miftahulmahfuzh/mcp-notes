import { Hono, type MiddlewareHandler } from 'hono';
import type { ChatBackend } from '../chat/backend.js';
import type { AppDeps } from '../deps.js';
import { dbChatUploadSource } from '../embeddings/chatUploads.js';
import { wallUrlForPort } from '../mcp/instructions.js';
import { handleMcpRequest } from '../mcp/server.js';
import type { ToolDeps } from '../mcp/tools.js';
import { sessionsReadDeps, type SessionsReadOverrides } from '../sessions/readModel.js';
import { apiRoutes } from './api.js';
import { chatHistoryRoutes } from './chatApi.js';
import { chatImageRoutes } from './chatImages.js';
import { fileRoutes } from './files.js';
import { captureRoutes } from './capture.js';
import { imageRoutes } from './images.js';
import { revealRoutes, type RevealDeps } from './reveal.js';
import { isLoopbackUrl } from './sameOrigin.js';
import { sessionHookRoutes } from './sessionHooks.js';
import { sessionsApiRoutes } from './sessionsApi.js';
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
  /** Session read model seams (host, live registry, settings, search) for /api/projects*, /api/sessions/* and the MCP session tools. Omitted: the real ones. */
  sessions?: SessionsReadOverrides;
}

/**
 * What POST /mcp hands the MCP server. `wallUrl` comes from `Config.port` (`NOTESD_PORT`), so the
 * instructions' Links paragraph names the port this daemon is configured for. Port 0 (tests: "any
 * free port", only known after listen) leaves it unset and the instructions fall back to 7317.
 * `sessions` is always set (building it does no I/O); `sessionOverrides` are test seams.
 */
export function mcpToolDeps(deps: AppDeps, sessionOverrides?: SessionsReadOverrides): ToolDeps {
  const wallUrl = wallUrlForPort(deps.config.port);
  return {
    service: deps.service,
    dataDir: deps.config.dataDir,
    db: deps.db,
    imageEmbedder: deps.imageEmbedder ?? null,
    chatUploads: dbChatUploadSource(deps.db, deps.config.dataDir),
    sessions: sessionsReadDeps(deps, sessionOverrides),
    ...(wallUrl !== undefined ? { wallUrl } : {}),
  };
}

/**
 * The whole HTTP surface, mounted in this order (later phases fill the routers, never this file):
 * /health, /mcp, apiRoutes (P6), chatHistoryRoutes (chat history phase 7), imageRoutes (P5),
 * chatImageRoutes (pasted chat images), fileRoutes (note files), revealRoutes (iteration 7:
 * capabilities + reveal; note files add file and note reveal), captureRoutes (Claude Code `/n`
 * capture, loopback + X-Notes-Capture only), sessionHookRoutes (iteration 8 phase 5: SessionStart
 * and spawn hooks), sessionsApiRoutes (iteration 8 phase 7: projects, session graph, detail,
 * transcript, context, search, usage), staticRoutes (P6, last: it owns the SPA fallback; it
 * reserves /api, so the order is for clarity).
 */
export function createApp(deps: AppDeps, options: CreateAppOptions = {}): Hono {
  const app = new Hono();
  const toolDeps = mcpToolDeps(deps, options.sessions);

  app.get('/health', (c) => c.json({ ok: true, service: 'notesd' }));

  app.use('/mcp', loopbackOnly);
  app.post('/mcp', (c) => handleMcpRequest(c.req.raw, toolDeps));
  // Stateless server: no standalone SSE stream (GET) and no sessions to end (DELETE).
  app.on(['GET', 'DELETE'], '/mcp', (c) =>
    c.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }, 405, { Allow: 'POST' }),
  );

  app.route('/', apiRoutes(deps, { chat: options.chat }));
  app.route('/', chatHistoryRoutes(deps));
  app.route('/', imageRoutes(deps));
  app.route('/', chatImageRoutes(deps));
  app.route('/', fileRoutes(deps));
  app.route('/', revealRoutes(deps, { reveal: options.reveal }));
  app.route('/', captureRoutes(deps));
  app.route('/', sessionHookRoutes(deps));
  app.route('/', sessionsApiRoutes(deps, options.sessions));
  app.route('/', staticRoutes(deps));
  return app;
}
