import { Hono } from 'hono';
import { z } from 'zod';
import { CachePlayError } from '../directStream/cachePlay.js';
import type { DirectStreamService } from '../directStream/service.js';
import { DIRECT_STREAM_OFF, directStreamErrorResponse } from './directStreamApi.js';
import { sameOriginOnly } from './sameOrigin.js';

/**
 * Playing one stream cache by its id (STREAM_CACHE_AND_BUG_REPORT phase 6): the player page opens
 * on the cache's local copy with no resolve. A cache made on the other machine answers 404
 * `not_on_this_machine`. Same-origin only: it starts the streaming Chrome. Phase 5 owns every
 * other /api/stream/cache route.
 */

const playCacheBody = z.strictObject({ resume_s: z.number().min(0).max(172_800).nullish() });

export function streamCachePlayRoutes(deps: { directStream?: DirectStreamService | null }): Hono {
  const r = new Hono();
  r.post('/api/stream/cache/:id/play', sameOriginOnly, async (c) => {
    const service = deps.directStream ?? null;
    if (service === null) return c.json(DIRECT_STREAM_OFF, 503);
    const text = await c.req.text();
    let raw: unknown = {};
    if (text.trim() !== '') {
      try {
        raw = JSON.parse(text);
      } catch {
        return c.json({ error: 'invalid_json', message: 'The body is not JSON.' }, 400);
      }
    }
    const body = playCacheBody.safeParse(raw);
    if (!body.success) {
      return c.json({ error: 'invalid_body', message: body.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') }, 400);
    }
    try {
      const played = await service.playCache(c.req.param('id'), { resumeS: body.data.resume_s ?? null });
      return c.json({ ok: true, ...played });
    } catch (err) {
      if (err instanceof CachePlayError) {
        if (err.code === 'not_on_this_machine') return c.json({ error: err.code, message: err.message, host: err.host }, 404);
        if (err.code === 'unknown_cache') return c.json({ error: err.code, message: err.message }, 404);
        return c.json({ error: err.code, message: err.message }, 409);
      }
      return directStreamErrorResponse(c, err);
    }
  });
  return r;
}
