import { TITLE_KEY_PATTERN } from '../directStream/titleSubtitles.js';
import { TRACK_ID_PATTERN } from '../directStream/torrent/subtitles/feed.js';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import { fileResponse } from '../directStream/cache/serve.js';
import type { DirectStreamService } from '../directStream/service.js';
import { isFile } from '../directStream/torrent/subtitles/disk.js';
import { DirectStreamError, type StreamRef } from '../directStream/types.js';
import type { StreamLive } from '../movies/streamLive.js';
import { MovieStreams, type MovieStreamsSource, type StreamSessionRef } from '../movies/streams.js';
import { replayOnSite } from '../streaming/sitePlays.js';
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
const magnetLink = z.string().trim().min(1).max(4000);

export const playBody = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('movie'), tmdb_id: tmdbId, season: z.null().optional(), episode: z.null().optional(), resume_s: resumeS.nullish(), provider: providerName.nullish(), magnet: magnetLink.nullish() }),
  z.strictObject({
    kind: z.literal('tv'),
    tmdb_id: tmdbId,
    season: z.number().int().min(0).max(1000),
    episode: z.number().int().min(1).max(10_000),
    resume_s: resumeS.nullish(),
    provider: providerName.nullish(),
    magnet: magnetLink.nullish(),
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
    case 'torrent_off':
      return c.json({ error: 'torrent_off', message: err.message }, 503);
    case 'no_episode':
    case 'no_subtitle':
      return c.json({ error: err.code, message: err.message }, 404);
  }
}

// `movies` is optional here so a caller without the movies store (phase 3's route tests) still fits;
// the position route answers `direct_stream_off` without it.
export function directStreamRoutes(deps: Pick<AppDeps, 'directStream'> & Partial<Pick<AppDeps, 'movies' | 'streamLive' | 'titleSubtitles' | 'titleCues' | 'streaming' | 'torrents'>>): Hono {
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
      const ref = refFromBody(body.data);
      // No provider named: a title last played on a streaming site plays there again.
      const movies = deps.movies ?? null;
      if ((body.data.provider ?? null) === null && (body.data.magnet ?? null) === null && movies !== null) {
        const onSite = await replayOnSite(ref, await service().remembered(ref), { runner: deps.streaming ?? null, streams: new MovieStreams(movies) });
        if (onSite !== null) return c.json({ ok: true, site: onSite.site, site_url: onSite.url, site_play: onSite.play });
      }
      const played = await service().play(ref, { resumeS: body.data.resume_s ?? null, provider: body.data.provider ?? null, magnet: body.data.magnet ?? null });
      return c.json({ ok: true, ...played });
    } catch (err) {
      return directStreamErrorResponse(c, err);
    }
  });

  // The player page, holding a session this daemon lost in a restart: a fresh session for what it was playing. No page is opened.
  r.post('/api/stream/continue', sameOriginOnly, async (c) => {
    const body = continueBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: 'invalid_body', message: body.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') }, 400);
    }
    const from = body.data;
    try {
      const answer = await service().continueSession(refFromBody(from), {
        was: from.session_id ?? null,
        provider: from.provider ?? null,
        infoHash: from.info_hash?.toLowerCase() ?? null,
        positionS: from.position_s ?? null,
      });
      return c.json({ ...answer.session, continued: answer.continued });
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
    const body = sourceBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'invalid_body', message: 'leave_cache must be true or false.' }, 400);
    try {
      // A cached play that starves goes back to the live stream; any other moves to another provider.
      const answer = body.data.leave_cache === true ? await service().leaveCache(c.req.param('id')) : await service().switchSource(c.req.param('id'));
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

  // A title's growing subtitle (cloudWhisper.ts): the cues after the first `after`, as a torrent's cue feed answers them.
  r.get('/api/stream/subs/:title/cues/:track', async (c) => {
    const title = c.req.param('title');
    const track = c.req.param('track');
    const after = c.req.query('after') ?? '0';
    if (!/^\d{1,7}$/.test(after)) return c.json({ error: 'invalid_query', message: 'after: a whole number from 0.' }, 400);
    const feeds = deps.titleCues ?? null;
    const feed = feeds !== null && TITLE_KEY_PATTERN.test(title) && TRACK_ID_PATTERN.test(track) ? await feeds.get(title, track) : null;
    if (feed === null) return c.json({ error: 'unknown_feed', message: 'This machine has no cue feed by that name for that title.' }, 404);
    c.header('Cache-Control', 'no-store');
    return c.json(feed.read(Number(after)));
  });

  // A title's English subtitle from outside its stream (WebVTT), kept per title on this machine (titleSubtitles.ts).
  r.get('/api/stream/subs/:title/:name', async (c) => {
    const name = c.req.param('name');
    const file = deps.titleSubtitles?.file(c.req.param('title'), name) ?? null;
    if (file !== null && (await isFile(file))) return fileResponse(file, name, c.req.header('range') ?? null);
    return c.json({ error: 'not_found', message: 'This machine has no subtitle file by that name for that title.' }, 404);
  });

  // Phase 5: the player page's position reports (src/movies/streams.ts).
  r.route('/', streamPositionRoutes({ movies: deps.movies ?? null, directStream: deps.directStream, live: deps.streamLive ?? null, torrents: deps.torrents ?? null }));

  return r;
}

const episodeBody = z.object({ to: z.enum(['prev', 'next']) });
const sourceBody = z.object({ leave_cache: z.boolean().optional() });
/** What the page knows of the play it lost: the title, its old session id, the provider or the torrent, and where the film is. */
const continueFrom = {
  session_id: z.string().max(64).nullish(),
  provider: providerName.nullish(),
  info_hash: z.string().regex(/^[0-9a-fA-F]{40}$/).nullish(),
  position_s: resumeS.nullish(),
};
const continueBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('movie'), tmdb_id: tmdbId, ...continueFrom }),
  z.object({ kind: z.literal('tv'), tmdb_id: tmdbId, season: z.number().int().min(0).max(1000), episode: z.number().int().min(1).max(10_000), ...continueFrom }),
]);
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

/** The session a report is for: `subtitleRev` counts the times its subtitle changed since the play started (a torrent session's, else a cloud session's outside one). */
type PositionSession = StreamSessionRef & { torrent?: { subtitleRev: number; infoHash?: string } | null; outside?: { subtitleRev: number } };

/** What the position route reads (AppDeps fits: DirectStreamService.session returns a superset of StreamSessionRef). */
export interface StreamPositionDeps {
  movies: MovieStreamsSource | null;
  /** `letGo`: the page closed or the film ended, so the session lets go of its torrent (torrent phase 3). */
  directStream?: {
    session(id: string): PositionSession | null | Promise<PositionSession | null>;
    letGo?(id: string): void;
    watched?(id: string, report: { paused: boolean; over: boolean; positionS?: number | null; durationS?: number | null }): void;
  } | null;
  /** The stream on screen (`GET /api/movies/player`); without it the reports are only stored. */
  live?: StreamLive | null;
  /** A torrent session's report marks its download played (its keep clock), as nothing else does. */
  torrents?: { played(infoHash: string): Promise<void> } | null;
}

/**
 * Direct streaming phase 5 (R2.4): the player page's position reports, written on the one
 * `movie_plays` row of its session (src/movies/streams.ts). Same-origin only: it writes.
 * 503 `direct_stream_off` without the service or the movies store; 404 `unknown_session` for a
 * session the daemon does not hold (the page then asks to continue its play: POST /api/stream/continue);
 * 404 `unknown_title` when the title cannot be stored (no TMDB credential); 400 `invalid_body`;
 * 503 `store_failed` when the database did not take the report (one log line; the page reports again in 5 s).
 *
 * Each report also feeds the live state (src/movies/streamLive.ts): the session is the stream on
 * screen until it ends or closes. A `beat` of a paused page that is already the stream on screen
 * only keeps it there: the position did not move, so nothing is written.
 *
 * Every 200 carries `subtitle_rev`, the session's count of subtitle changes (Wyzie Synced re-timed
 * it, or an outside subtitle arrived late): the page loads its subtitle again when the number changes.
 */
export function streamPositionRoutes(deps: StreamPositionDeps, options: { now?: () => Date; log?: (line: string) => void } = {}): Hono {
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
    const subtitleRev = session.torrent?.subtitleRev ?? session.outside?.subtitleRev ?? 0;
    // Torrent phase 3: the page is gone or the film is over, so the session lets go of its torrent (a reload takes it again).
    if (over) service.letGo?.(session.id);
    // An episode that is really being watched has its next one fetched to this machine (src/directStream/ahead.ts).
    service.watched?.(session.id, { paused: report.paused === true, over, positionS: report.position_s, durationS: report.duration_s ?? null });
    if (live !== null && report.beat === true && report.paused === true && !over && live.has(session.id)) {
      const on = live.current();
      if (on !== null) {
        live.report({ sessionId: session.id, titleId: on.title_id, ref: session.ref, provider: session.source.provider, positionS: report.position_s, durationS: report.duration_s ?? on.duration, paused: true });
        return c.json({ ok: true, play_id: null, ended: false, subtitle_rev: subtitleRev });
      }
    }
    const playing = session.torrent?.infoHash;
    if (playing !== undefined) void deps.torrents?.played(playing);
    let written: Awaited<ReturnType<MovieStreams['recordPosition']>>;
    try {
      written = await new MovieStreams(movies, options).recordPosition(session, {
        positionS: body.data.position_s,
        durationS: body.data.duration_s ?? null,
        ended: body.data.ended ?? false,
      });
    } catch (err) {
      // The database did not answer: this report is lost, and the page's next one (5 s on) writes the position.
      (options.log ?? console.error)(`[notesd] direct stream: the position of session ${session.id.slice(0, 6)} was not stored: ${err instanceof Error ? err.message : String(err)}`);
      return c.json({ error: 'store_failed', message: 'The position could not be stored now; the next report is tried again.' }, 503);
    }
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
    return c.json({ ok: true, play_id: written.play.id, ended: written.play.endedAt !== null, subtitle_rev: subtitleRev });
  });
  return r;
}
