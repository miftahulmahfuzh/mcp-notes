import { Hono } from 'hono';
import type { AppDeps } from '../deps.js';

/**
 * /api/movies* (MOVIES_LIBRARY_PLAN). Mounted empty by phase 1 so later phases fill this file and
 * never src/http/app.ts. Phase 4 adds: GET /api/movies, /api/movies/unmatched, /api/movies/status,
 * /api/movies/:id, /api/movies/search-tmdb; POST /api/movies/:id/user,
 * /api/movies/files/:fileId/watched, /api/movies/files/:fileId/assign, /api/movies/sync; the SSE
 * stream GET /api/movies/events. With `deps.movies === null` every route answers 503 `movies_off`.
 */
export function moviesApiRoutes(_deps: AppDeps): Hono {
  return new Hono();
}
