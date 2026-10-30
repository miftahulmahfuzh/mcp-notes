import { Hono } from 'hono';
import type { AppDeps } from '../deps.js';

/** Image upload and serving (/api/images, /api/notes/:id/{original,display,thumb,preview}). Phase 5 fills this router. */
export function imageRoutes(deps: AppDeps): Hono {
  void deps;
  return new Hono();
}
