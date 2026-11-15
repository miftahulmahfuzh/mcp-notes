import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import type { DirectStreamService } from '../directStream/service.js';
import { DirectStreamError, type StreamRef } from '../directStream/types.js';
import { sameOriginOnly } from './sameOrigin.js';

/**
 * Direct streaming (DIRECT_STREAMING_PLAN phase 3): play, the player's session, the pass-through and
 * refresh. Every route answers 503 `direct_stream_off` first when there is no service; the two POSTs
 * start Chrome or a resolve, so they are same-origin only. Input is validated here once.
 */

export const DIRECT_STREAM_OFF = {
  error: 'direct_stream_off',
  message: 'Direct streaming is off on this machine (NOTESD_DIRECT_STREAM=off or NOTESD_MOVIES=off).',
} as const;

export const UNKNOWN_SESSION = { error: 'unknown_session', message: 'That stream session is unknown or has ended.' } as const;

const tmdbId = z.number().int().min(1).max(2_147_483_647);
const resumeS = z.number().min(0).max(172_800);

export const playBody = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('movie'), tmdb_id: tmdbId, season: z.null().optional(), episode: z.null().optional(), resume_s: resumeS.nullish() }),
  z.strictObject({
    kind: z.literal('tv'),
    tmdb_id: tmdbId,
    season: z.number().int().min(0).max(1000),
    episode: z.number().int().min(1).max(10_000),
    resume_s: resumeS.nullish(),
  }),
]);

export type PlayBody = z.infer<typeof playBody>;

export function refFromBody(body: PlayBody): StreamRef {
  return body.kind === 'movie'
    ? { kind: 'movie', tmdbId: body.tmdb_id }
    : { kind: 'tv', tmdbId: body.tmdb_id, season: body.season, episode: body.episode };
}

/** DirectStreamError -> its HTTP answer; anything else is rethrown (500). */
export function directStreamErrorResponse(c: Context, err: unknown): Response {
  if (!(err instanceof DirectStreamError)) throw err;
  switch (err.code) {
    case 'no_source':
      return c.json({ error: 'no_source', message: err.message, attempts: err.attempts }, 502);
    case 'resolve_failed':
      return c.json({ error: 'resolve_failed', reason: err.reason, message: err.message, attempts: err.attempts }, 502);
    case 'open_failed':
      return c.json(
        { error: 'open_failed', reason: err.reason, message: err.message, session_id: err.sessionId, page_url: err.pageUrl, attempts: err.attempts },
        502,
      );
    case 'unknown_session':
      return c.json(UNKNOWN_SESSION, 403);
  }
}

export function directStreamRoutes(deps: Pick<AppDeps, 'directStream'>): Hono {
  const r = new Hono();
  const service = (): DirectStreamService => {
    const svc = deps.directStream ?? null;
    if (svc === null) throw new Error('direct stream: the off guard did not run');
    return svc;
  };

  // Before the Origin check: while direct streaming is off, every route answers direct_stream_off.
  r.use('/api/stream/*', async (c, next) => {
    if ((deps.directStream ?? null) === null) return c.json(DIRECT_STREAM_OFF, 503);
    await next();
  });

  r.post('/api/stream/play', sameOriginOnly, async (c) => {
    let raw: unknown;
    try {
      raw = JSON.parse(await c.req.text());
    } catch {
      return c.json({ error: 'invalid_json', message: 'The body is not JSON.' }, 400);
    }
    const body = playBody.safeParse(raw);
    if (!body.success) {
      return c.json({ error: 'invalid_body', message: body.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') }, 400);
    }
    try {
      const played = await service().play(refFromBody(body.data), { resumeS: body.data.resume_s ?? null });
      return c.json({ ok: true, ...played });
    } catch (err) {
      return directStreamErrorResponse(c, err);
    }
  });

  r.get('/api/stream/sessions/:id', async (c) => {
    const info = await service().info(c.req.param('id'));
    if (info === null) return c.json(UNKNOWN_SESSION, 403);
    return c.json(info);
  });

  r.get('/api/stream/sessions/:id/p', (c) =>
    service().passThrough(c.req.param('id'), {
      target: c.req.query('u') ?? '',
      range: c.req.header('range') ?? null,
      vtt: c.req.query('vtt') === '1',
      signal: c.req.raw.signal,
    }),
  );

  r.post('/api/stream/sessions/:id/refresh', sameOriginOnly, async (c) => {
    try {
      return c.json(await service().refresh(c.req.param('id')));
    } catch (err) {
      return directStreamErrorResponse(c, err);
    }
  });

  return r;
}
