import { Hono } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import { HEALTH_DEFAULT_DAYS, HEALTH_MAX_DAYS, streamHealthReader, type StreamHealthReader } from '../directStream/playLog/health.js';

/** How stream plays went on this host (stream-play-log phase 3): the /movies/health page and direct_stream_health read the same answer. */

export const STREAM_HEALTH_OFF = { error: 'direct_stream_off', message: 'The movie library is off on this machine, so nothing is streamed or logged.' } as const;

const daysQuery = z.coerce.number().int().min(1).max(HEALTH_MAX_DAYS);

export interface StreamHealthRouteOptions {
  /** Tests: an in-memory reader. Omitted: the daemon's (streamHealthReader). */
  reader?: StreamHealthReader | null;
}

export function streamHealthRoutes(deps: Pick<AppDeps, 'db' | 'movies'>, options: StreamHealthRouteOptions = {}): Hono {
  const r = new Hono();
  const reader = options.reader !== undefined ? options.reader : streamHealthReader(deps);
  r.get('/api/stream/health', async (c) => {
    if (reader === null) return c.json(STREAM_HEALTH_OFF, 503);
    const raw = c.req.query('days');
    let days = HEALTH_DEFAULT_DAYS;
    if (raw !== undefined && raw.trim() !== '') {
      const parsed = daysQuery.safeParse(raw);
      if (!parsed.success) return c.json({ error: 'invalid_query', message: `days: a whole number from 1 to ${HEALTH_MAX_DAYS}` }, 400);
      days = parsed.data;
    }
    return c.json(await reader.read(days));
  });
  return r;
}
