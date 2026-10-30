import { Hono } from 'hono';
import type { AppDeps } from '../deps.js';

/** UI JSON API (/api/notes, /api/tags, /api/events, /api/chat). Phase 6 fills this router. */
export function apiRoutes(deps: AppDeps): Hono {
  void deps;
  return new Hono();
}
