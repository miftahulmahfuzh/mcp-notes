import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import { continueTitle } from '../movies/continue.js';
import { PlayError } from '../movies/player.js';
import { DEFAULT_REPORT_SAMPLES, MAX_REPORT_SAMPLES } from '../movies/vlc/health.js';
import { sameOriginOnly } from './sameOrigin.js';

/**
 * Movies phase 5: play a file in the Windows VLC, "continue <title>", and the player's state.
 * The two POSTs spawn a process, so they are same-origin only (invariant 7). Inputs are validated
 * here once; the player and continueTitle trust them.
 */

const fileIdParam = z
  .string()
  .regex(/^[1-9][0-9]{0,15}$/)
  .transform(Number);
const continueBody = z.object({ title: z.string().trim().min(1).max(200).optional() }).strict();
const healthLimit = z
  .string()
  .regex(/^[1-9][0-9]{0,3}$/)
  .transform(Number)
  .refine((n) => n <= MAX_REPORT_SAMPLES);

const MOVIES_OFF = {
  error: 'movies_off',
  message: 'Movies are off on this machine (NOTESD_MOVIES=off).',
} as const;

/** PlayError -> its HTTP answer; anything else is rethrown (500). */
export function playErrorResponse(c: Context, err: unknown): Response {
  if (!(err instanceof PlayError)) throw err;
  switch (err.code) {
    case 'not_found':
      return c.json({ error: 'not_found', message: err.message }, 404);
    case 'not_on_this_machine':
      return c.json({ error: 'not_on_this_machine', host: err.host, message: err.message }, 404);
    case 'file_missing':
      return c.json({ error: 'file_missing', message: err.message }, 410);
    case 'player_unavailable':
      return c.json({ error: 'player_unavailable', reason: err.reason, message: err.message }, 409);
  }
}

export function moviesPlayRoutes(deps: Pick<AppDeps, 'db' | 'moviesPlayer' | 'moviesHealth'>): Hono {
  const r = new Hono();

  r.get('/api/movies/player', async (c) => {
    const player = deps.moviesPlayer ?? null;
    if (player === null) return c.json({ available: false, reason: 'movies_off', current: null });
    const a = await player.availability();
    return c.json({ available: a.available, reason: a.reason, current: player.current() });
  });

  r.post('/api/movies/files/:fileId/play', sameOriginOnly, async (c) => {
    const id = fileIdParam.safeParse(c.req.param('fileId'));
    if (!id.success) return c.json({ error: 'invalid_id' }, 400);
    const player = deps.moviesPlayer ?? null;
    if (player === null) return c.json(MOVIES_OFF, 503);
    try {
      return c.json({ ok: true, play: await player.play(id.data) }, 202);
    } catch (err) {
      return playErrorResponse(c, err);
    }
  });

  r.post('/api/movies/continue', sameOriginOnly, async (c) => {
    const text = await c.req.text();
    let raw: unknown = {};
    if (text.trim() !== '') {
      try {
        raw = JSON.parse(text);
      } catch {
        return c.json({ error: 'invalid_body', message: 'The body is not JSON.' }, 400);
      }
    }
    const body = continueBody.safeParse(raw);
    if (!body.success) return c.json({ error: 'invalid_body', message: body.error.issues.map((i) => i.message).join('; ') }, 400);
    const player = deps.moviesPlayer ?? null;
    if (player === null) return c.json(MOVIES_OFF, 503);
    try {
      return c.json(await continueTitle({ db: deps.db, player }, body.data.title ?? null));
    } catch (err) {
      return playErrorResponse(c, err);
    }
  });

  /**
   * Movies phase 9 (R8.5): this host's VLC health log. Read only, no Origin check. `limit` caps the
   * samples (default 200, max 2000); run summaries, hangs and incidents come from the whole read window.
   */
  r.get('/api/movies/player/health', (c) => {
    const raw = c.req.query('limit');
    let limit = DEFAULT_REPORT_SAMPLES;
    if (raw !== undefined) {
      const parsed = healthLimit.safeParse(raw);
      if (!parsed.success) return c.json({ error: 'invalid_limit', message: `limit must be an integer 1-${MAX_REPORT_SAMPLES}` }, 400);
      limit = parsed.data;
    }
    const health = deps.moviesHealth ?? null;
    if (health === null) return c.json(MOVIES_OFF, 503);
    return c.json(health.report(limit));
  });

  return r;
}
