import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import type { StreamCache } from '../directStream/cache/service.js';
import { CacheError } from '../directStream/cache/types.js';
import type { StreamRef } from '../directStream/types.js';
import { DIRECT_STREAM_OFF } from './directStreamApi.js';
import { sameOriginOnly } from './sameOrigin.js';

/**
 * The stream cache (STREAM_CACHE_AND_BUG_REPORT phase 5): start a download, list, read and clear
 * caches, and serve a cache's files. 503 direct_stream_off without the service or the cache (the
 * directStreamRoutes guard answers first when both are mounted). The POST and the DELETE start or
 * remove something, so they are same-origin only; the file route is what the player page loads.
 */

const tmdbId = z.number().int().min(1).max(2_147_483_647);
const maxHeight = z.number().int().min(100).max(4320);

export const cacheBody = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('movie'), tmdb_id: tmdbId, season: z.null().optional(), episode: z.null().optional(), max_height: maxHeight.nullish() }),
  z.strictObject({
    kind: z.literal('tv'),
    tmdb_id: tmdbId,
    season: z.number().int().min(0).max(1000),
    episode: z.number().int().min(1).max(10_000),
    max_height: maxHeight.nullish(),
  }),
]);

type CacheBody = z.infer<typeof cacheBody>;

function refOf(body: CacheBody): StreamRef {
  return body.kind === 'movie' ? { kind: 'movie', tmdbId: body.tmdb_id } : { kind: 'tv', tmdbId: body.tmdb_id, season: body.season, episode: body.episode };
}

/** CacheError -> its HTTP answer; anything else is rethrown (500). */
export function cacheErrorResponse(c: Context, err: unknown): Response {
  if (!(err instanceof CacheError)) throw err;
  switch (err.code) {
    case 'unknown_cache':
      return c.json({ error: err.code, message: err.message }, 404);
    case 'not_on_this_machine':
      return c.json({ error: err.code, message: err.message, host: err.extra.host ?? null }, 404);
    case 'cache_exists':
      return c.json({ error: err.code, message: err.message, cache: err.extra.cache ?? null }, 409);
  }
}

export function streamCacheRoutes(deps: Pick<AppDeps, 'directStream'> & Partial<Pick<AppDeps, 'streamCache'>>): Hono {
  const r = new Hono();
  const cacheOf = (): StreamCache | null => ((deps.directStream ?? null) === null ? null : (deps.streamCache ?? null));

  r.post('/api/stream/cache', sameOriginOnly, async (c) => {
    const cache = cacheOf();
    if (cache === null) return c.json(DIRECT_STREAM_OFF, 503);
    let raw: unknown;
    try {
      raw = JSON.parse(await c.req.text());
    } catch {
      return c.json({ error: 'invalid_json', message: 'The body is not JSON.' }, 400);
    }
    const body = cacheBody.safeParse(raw);
    if (!body.success) {
      return c.json({ error: 'invalid_body', message: body.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') }, 400);
    }
    try {
      const { cache: view, started } = await cache.request(refOf(body.data), { maxHeight: body.data.max_height ?? null });
      return c.json({ ok: true, started, cache: view }, started ? 202 : 200);
    } catch (err) {
      return cacheErrorResponse(c, err);
    }
  });

  r.get('/api/stream/cache', async (c) => {
    const cache = cacheOf();
    if (cache === null) return c.json(DIRECT_STREAM_OFF, 503);
    return c.json({ host: cache.host, caches: await cache.list() });
  });

  r.get('/api/stream/cache/:id', async (c) => {
    const cache = cacheOf();
    if (cache === null) return c.json(DIRECT_STREAM_OFF, 503);
    const view = await cache.get(c.req.param('id'));
    if (view === null) return c.json({ error: 'unknown_cache', message: 'No stream cache has this id.' }, 404);
    return c.json(view);
  });

  // What of a cache is on disk, in seconds: the player's timeline draws it.
  r.get('/api/stream/cache/:id/map', async (c) => {
    const cache = cacheOf();
    if (cache === null) return c.json(DIRECT_STREAM_OFF, 503);
    const map = await cache.map(c.req.param('id'));
    if (map === null) return c.json({ error: 'unknown_cache', message: 'This machine has no stream cache with this id.' }, 404);
    return c.json(map);
  });

  r.delete('/api/stream/cache/:id', sameOriginOnly, async (c) => {
    const cache = cacheOf();
    if (cache === null) return c.json(DIRECT_STREAM_OFF, 503);
    const id = c.req.param('id');
    try {
      await cache.remove(id);
      return c.json({ ok: true, id: id.toLowerCase() });
    } catch (err) {
      return cacheErrorResponse(c, err);
    }
  });

  r.get('/api/stream/cache/:id/f/:name', async (c) => {
    const cache = cacheOf();
    if (cache === null) return c.json(DIRECT_STREAM_OFF, 503);
    return cache.file(c.req.param('id'), c.req.param('name'), { range: c.req.header('range') ?? null });
  });

  return r;
}
