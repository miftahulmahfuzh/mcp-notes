import { Hono } from 'hono';
import type { AppDeps } from '../deps.js';

/**
 * Movie playback routes (MOVIES_LIBRARY_PLAN). Mounted empty by phase 1; phase 5 adds
 * POST /api/movies/files/:fileId/play, POST /api/movies/continue and GET /api/movies/player,
 * all same-origin only.
 */
export function moviesPlayRoutes(_deps: AppDeps): Hono {
  return new Hono();
}
