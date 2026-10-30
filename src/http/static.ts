import { Hono } from 'hono';
import type { AppDeps } from '../deps.js';

/** The built SPA from web/dist (/, /full/:id, /assets/*). Phase 6 fills this router. Mounted last. */
export function staticRoutes(deps: AppDeps): Hono {
  void deps;
  return new Hono();
}
