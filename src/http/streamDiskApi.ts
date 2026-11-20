import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import { ShelfError, type DeletionScope } from '../directStream/cacheShelf.js';
import { sameOriginOnly } from './sameOrigin.js';

/**
 * The Cache page (src/directStream/cacheShelf.ts): what this machine keeps on disk for streaming, per title, season and
 * episode, and its deletion after an undo window. The writes are same-origin only, like the recycle bin's.
 */

export const STREAM_DISK_OFF = { error: 'stream_disk_off', message: 'Neither torrents nor the stream cache are on on this machine.' } as const;

const TITLE_ID = /^(movie|tv)-[1-9][0-9]{0,9}$/;
const deleteBody = z.union([
  z.strictObject({ bulk: z.enum(['watched', 'not_interested']) }),
  z.strictObject({
    title_id: z.string().regex(TITLE_ID),
    season: z.number().int().min(0).max(1000).optional(),
    episode: z.number().int().min(1).max(10_000).optional(),
  }),
]);
const DELETION_ID = /^[0-9a-f]{12}$/;

/** ShelfError -> its HTTP answer; anything else is rethrown (500). */
export function shelfErrorResponse(c: Context, err: unknown): Response {
  if (!(err instanceof ShelfError)) throw err;
  const body = { error: err.code, message: err.message };
  return c.json(body, err.code === 'in_use' ? 409 : 404);
}

export function streamDiskRoutes(deps: Pick<AppDeps, 'cacheShelf'>): Hono {
  const r = new Hono();
  r.use('/api/stream/disk', async (c, next) => {
    if ((deps.cacheShelf ?? null) === null) return c.json(STREAM_DISK_OFF, 503);
    await next();
  });
  r.use('/api/stream/disk/*', async (c, next) => {
    if ((deps.cacheShelf ?? null) === null) return c.json(STREAM_DISK_OFF, 503);
    await next();
  });

  r.get('/api/stream/disk', async (c) => c.json(await deps.cacheShelf!.view()));

  r.post('/api/stream/disk/delete', sameOriginOnly, async (c) => {
    let raw: unknown;
    try {
      raw = JSON.parse(await c.req.text());
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const body = deleteBody.safeParse(raw);
    if (!body.success) return c.json({ error: 'invalid_body', message: body.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') }, 400);
    const scope = body.data as DeletionScope;
    if ('episode' in scope && scope.episode !== undefined && scope.season === undefined) return c.json({ error: 'invalid_body', message: 'An episode needs its season.' }, 400);
    try {
      return c.json({ deletion: await deps.cacheShelf!.remove(scope) }, 202);
    } catch (err) {
      return shelfErrorResponse(c, err);
    }
  });

  r.delete('/api/stream/disk/deletions/:id', sameOriginOnly, async (c) => {
    const id = c.req.param('id');
    if (!DELETION_ID.test(id)) return c.json({ error: 'unknown_deletion', message: 'No pending deletion has this id.' }, 404);
    try {
      return c.json({ ok: true, deletion: await deps.cacheShelf!.undo(id) });
    } catch (err) {
      return shelfErrorResponse(c, err);
    }
  });
  return r;
}
