import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import { dbTitleLibrary } from '../directStream/lookup.js';
import { MovieStreams } from '../movies/streams.js';
import { STREAMING_SITES } from '../streaming/service.js';
import { STREAMING_OFF } from '../mcp/streamingTools.js';
import { playing, recordSitePlay, siteTitleKeeper } from '../streaming/sitePlays.js';
import { isLoopbackUrl, sameOriginOnly } from './sameOrigin.js';

export const SITE_PLAY_PATH = '/api/movies/site-play';
export const SITE_TITLES_PATH = '/api/movies/site-titles';
/** Lower-case header name. A custom header forces a CORS preflight, which notesd never answers. */
export const SITE_PLAY_HEADER = 'x-notes-site-play';

const MOVIES_OFF = {
  error: 'movies_off',
  message: 'Movies are off on this machine (NOTESD_MOVIES=off).',
} as const;

const sitePlayBody = z
  .object({
    site: z.enum(STREAMING_SITES),
    url: z.string().url().max(500),
    name: z.string().trim().max(300).nullish(),
    original_name: z.string().trim().max(300).nullish(),
    year: z.number().int().min(1880).max(2100).nullish(),
    kind: z.enum(['movie', 'series']).nullish(),
    season: z.number().int().min(0).max(1000).nullish(),
    episode: z.number().int().min(1).max(99_999).nullish(),
  })
  .strict();

const siteTitlePlayBody = z.object({ season: z.number().int().min(0).max(1000).optional(), episode: z.number().int().min(1).max(99_999).optional() }).strict();

/** Only the streaming command on this machine reports here: loopback, and its own header. */
const fromCommand: MiddlewareHandler = async (c, next) => {
  if (!isLoopbackUrl(c.req.url) || c.req.header(SITE_PLAY_HEADER) === undefined) return c.json({ error: 'forbidden' }, 403);
  await next();
};

/**
 * A streaming site's player started (claude/streaming/cli.mjs reports it after every play): the
 * title is found by its name and year, stored when it is new, and the play is kept with it.
 */
export function sitePlayRoutes(deps: Pick<AppDeps, 'db' | 'movies'> & Partial<Pick<AppDeps, 'streaming'>>): Hono {
  const r = new Hono();
  r.post(SITE_PLAY_PATH, fromCommand, async (c) => {
    const movies = deps.movies;
    if (movies === null) return c.json(MOVIES_OFF, 503);
    let raw: unknown;
    try {
      raw = JSON.parse(await c.req.text());
    } catch {
      return c.json({ error: 'invalid_json', message: 'The body is not JSON.' }, 400);
    }
    const body = sitePlayBody.safeParse(raw);
    if (!body.success) {
      return c.json({ error: 'invalid_body', message: body.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') }, 400);
    }
    const kept = await recordSitePlay(body.data, {
      lookup: { library: dbTitleLibrary(deps.db), tmdb: movies.tmdb },
      streams: new MovieStreams(movies),
      siteTitles: siteTitleKeeper({ repo: movies.repo, host: movies.host, runner: deps.streaming ?? null }),
    });
    if (kept.recorded && kept.title_id === null) movies.events.changed('stream');
    return c.json(kept);
  });

  /** A kept site title by the id in the path, or the answer that says why not. */
  async function siteTitle(c: Context) {
    const movies = deps.movies;
    if (movies === null) return { fail: c.json(MOVIES_OFF, 503) } as const;
    const id = Number(c.req.param('id'));
    const row = await movies.repo.siteTitleById(id);
    // Each machine keeps its own: another machine's title has no play to start here.
    if (row === null || row.host !== movies.host) return { fail: c.json({ error: 'not_found' }, 404) } as const;
    return { movies, row } as const;
  }

  /**
   * Plays a title TMDB does not list on its site again: the film, or one episode (the one after the
   * last played when none is named). It starts a Chrome play, so it is same-origin only.
   */
  r.post(`${SITE_TITLES_PATH}/:id{[0-9]{1,15}}/play`, sameOriginOnly, async (c) => {
    const found = await siteTitle(c);
    if ('fail' in found) return found.fail;
    const { movies, row } = found;
    const runner = deps.streaming ?? null;
    if (runner === null || !(STREAMING_SITES as readonly string[]).includes(row.site)) return c.json({ error: 'streaming_off', message: STREAMING_OFF }, 503);
    let raw: unknown = {};
    const sent = await c.req.text();
    if (sent.trim() !== '') {
      try {
        raw = JSON.parse(sent);
      } catch {
        return c.json({ error: 'invalid_json', message: 'The body is not JSON.' }, 400);
      }
    }
    const body = siteTitlePlayBody.safeParse(raw);
    if (!body.success) return c.json({ error: 'invalid_body', message: body.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') }, 400);
    const series = row.kind === 'series';
    const season = series ? (body.data.season ?? row.season ?? 1) : null;
    const episode = series ? (body.data.episode ?? (row.episode ?? 0) + 1) : null;
    const args = series ? ['--play-from', row.siteUrl, '--episode', String(episode), '--season', String(season), '--no-report'] : ['--play-url', row.siteUrl, '--no-report'];
    let answer: unknown;
    try {
      answer = await runner(row.site as (typeof STREAMING_SITES)[number], args);
    } catch (err) {
      return c.json({ error: 'not_playing', message: err instanceof Error ? err.message : String(err) }, 502);
    }
    const play = playing(answer);
    if (play === null) {
      const skipped = (answer as { play?: { skipped_play?: unknown } } | null)?.play?.skipped_play;
      if (skipped === 'no_episode') return c.json({ error: 'no_episode', season, episode, message: `The site lists no episode ${episode} of it.` }, 404);
      return c.json({ error: 'not_playing', season, episode, play: (answer as { play?: unknown } | null)?.play ?? null }, 502);
    }
    await movies.repo.playedSiteTitle(row.id, season, episode, new Date());
    movies.events.changed('stream');
    return c.json({ ok: true, site: row.site, site_url: row.siteUrl, season, episode, site_play: play });
  });

  /** Takes a title TMDB does not list off this machine's Stream side. */
  r.delete(`${SITE_TITLES_PATH}/:id{[0-9]{1,15}}`, sameOriginOnly, async (c) => {
    const found = await siteTitle(c);
    if ('fail' in found) return found.fail;
    await found.movies.repo.removeSiteTitle(found.row.id);
    found.movies.events.changed('stream');
    return c.json({ ok: true });
  });
  return r;
}
