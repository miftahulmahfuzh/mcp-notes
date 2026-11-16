import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import type { DirectStreamService } from '../directStream/service.js';
import { DirectStreamError, type StreamRef } from '../directStream/types.js';
import type { StreamLive } from '../movies/streamLive.js';
import { MovieStreams, type MovieStreamsSource, type StreamSessionRef } from '../movies/streams.js';
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
/** A provider's name from the registry (`direct_stream_sources`): only that one is asked. */
const providerName = z.string().trim().min(1).max(60);

export const playBody = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('movie'), tmdb_id: tmdbId, season: z.null().optional(), episode: z.null().optional(), resume_s: resumeS.nullish(), provider: providerName.nullish() }),
  z.strictObject({
    kind: z.literal('tv'),
    tmdb_id: tmdbId,
    season: z.number().int().min(0).max(1000),
    episode: z.number().int().min(1).max(10_000),
    resume_s: resumeS.nullish(),
    provider: providerName.nullish(),
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
    case 'no_episode':
    case 'no_subtitle':
      return c.json({ error: err.code, message: err.message }, 404);
  }
}

// `movies` is optional here so a caller without the movies store (phase 3's route tests) still fits;
// the position route answers `direct_stream_off` without it.
export function directStreamRoutes(deps: Pick<AppDeps, 'directStream'> & Partial<Pick<AppDeps, 'movies' | 'streamLive'>>): Hono {
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
      const played = await service().play(refFromBody(body.data), { resumeS: body.data.resume_s ?? null, provider: body.data.provider ?? null });
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

  // The player page, when the film keeps stalling: another provider under the same session id.
  r.post('/api/stream/sessions/:id/source', sameOriginOnly, async (c) => {
    try {
      const answer = await service().switchSource(c.req.param('id'));
      return c.json({ ...answer.session, switched: answer.switched, reason: answer.reason, from: answer.from });
    } catch (err) {
      return directStreamErrorResponse(c, err);
    }
  });

  // The player page, paused: cache the title here and, once the cache has a source, play from it.
  r.post('/api/stream/sessions/:id/cache', sameOriginOnly, async (c) => {
    const body = cacheSessionBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'invalid_body', message: 'start must be true or false.' }, 400);
    try {
      const answer = await service().cacheSession(c.req.param('id'), { start: body.data.start === true });
      return c.json({ ...answer.session, moved: answer.moved, cache: answer.cache });
    } catch (err) {
      return directStreamErrorResponse(c, err);
    }
  });

  // The player's previous / next episode buttons: a new session for the neighbouring episode.
  r.post('/api/stream/sessions/:id/episode', sameOriginOnly, async (c) => {
    const body = episodeBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'invalid_body', message: 'to must be "prev" or "next".' }, 400);
    try {
      return c.json(await service().switchEpisode(c.req.param('id'), body.data.to));
    } catch (err) {
      return directStreamErrorResponse(c, err);
    }
  });

  // Phase 5: the player page's position reports (src/movies/streams.ts).
  r.route('/', streamPositionRoutes({ movies: deps.movies ?? null, directStream: deps.directStream, live: deps.streamLive ?? null }));

  return r;
}

const episodeBody = z.object({ to: z.enum(['prev', 'next']) });
const cacheSessionBody = z.object({ start: z.boolean().optional() });

/** Longest position or duration a report may carry, in seconds (11.5 days: a sanity bound, not a film's length). */
const MAX_STREAM_SECONDS = 1_000_000;

/**
 * The player page's report: every 5 s while the page is open, on pause and at the end. `paused`
 * says the film is paused; `beat` marks a report sent only to say the paused page is still open;
 * `closed` is the page's last word as it closes. Unknown keys are dropped.
 */
const positionBody = z.object({
  position_s: z.number().finite().min(0).max(MAX_STREAM_SECONDS),
  duration_s: z.number().finite().positive().max(MAX_STREAM_SECONDS).nullable().optional(),
  ended: z.boolean().optional(),
  paused: z.boolean().optional(),
  beat: z.boolean().optional(),
  closed: z.boolean().optional(),
});

/** What the position route reads (AppDeps fits: DirectStreamService.session returns a superset of StreamSessionRef). */
export interface StreamPositionDeps {
  movies: MovieStreamsSource | null;
  directStream?: { session(id: string): StreamSessionRef | null | Promise<StreamSessionRef | null> } | null;
  /** The stream on screen (`GET /api/movies/player`); without it the reports are only stored. */
  live?: StreamLive | null;
}

/**
 * Direct streaming phase 5 (R2.4): the player page's position reports, written on the one
 * `movie_plays` row of its session (src/movies/streams.ts). Same-origin only: it writes.
 * 503 `direct_stream_off` without the service or the movies store; 404 `unknown_session` for a
 * session the daemon does not hold (the page ignores 404s); 404 `unknown_title` when the title
 * cannot be stored (no TMDB credential); 400 `invalid_body`.
 *
 * Each report also feeds the live state (src/movies/streamLive.ts): the session is the stream on
 * screen until it ends or closes. A `beat` of a paused page that is already the stream on screen
 * only keeps it there: the position did not move, so nothing is written.
 */
export function streamPositionRoutes(deps: StreamPositionDeps, options: { now?: () => Date } = {}): Hono {
  const r = new Hono();
  r.post('/api/stream/sessions/:id/position', sameOriginOnly, async (c) => {
    const service = deps.directStream ?? null;
    const movies = deps.movies;
    if (service === null || movies === null) return c.json(DIRECT_STREAM_OFF, 503);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_body', message: 'The body is not JSON.' }, 400);
    }
    const body = positionBody.safeParse(raw);
    if (!body.success) return c.json({ error: 'invalid_body', message: body.error.issues.map((i) => i.message).join('; ') }, 400);
    const session = await service.session(c.req.param('id'));
    if (session === null) {
      return c.json({ error: 'unknown_session', message: 'No live stream session has this id (it expired, or the daemon restarted).' }, 404);
    }
    const live = deps.live ?? null;
    const report = body.data;
    const over = report.ended === true || report.closed === true;
    if (live !== null && report.beat === true && report.paused === true && !over && live.has(session.id)) {
      const on = live.current();
      if (on !== null) {
        live.report({ sessionId: session.id, titleId: on.title_id, ref: session.ref, provider: session.source.provider, positionS: report.position_s, durationS: report.duration_s ?? on.duration, paused: true });
        return c.json({ ok: true, play_id: null, ended: false });
      }
    }
    const written = await new MovieStreams(movies, options).recordPosition(session, {
      positionS: body.data.position_s,
      durationS: body.data.duration_s ?? null,
      ended: body.data.ended ?? false,
    });
    if (written === null) {
      return c.json({ error: 'unknown_title', message: 'The title is not stored and TMDB cannot be asked for it; the play is not recorded.' }, 404);
    }
    if (live !== null) {
      if (over) live.end(session.id);
      else {
        live.report({
          sessionId: session.id,
          titleId: written.play.titleId ?? '',
          ref: session.ref,
          provider: session.source.provider,
          positionS: report.position_s,
          durationS: report.duration_s ?? null,
          paused: report.paused === true,
        });
      }
    }
    return c.json({ ok: true, play_id: written.play.id, ended: written.play.endedAt !== null });
  });
  return r;
}
