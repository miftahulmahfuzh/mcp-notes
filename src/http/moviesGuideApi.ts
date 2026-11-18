import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import type { StreamRef } from '../directStream/types.js';
import { companyGuide, GuideError, personGuide, type EntityGuide, type GuideTmdb } from '../movies/guides.js';
import { getTitle, type ReadContext } from '../movies/read.js';
import type { MoviesService } from '../movies/service.js';
import { MovieStreams } from '../movies/streams.js';
import { TmdbError } from '../movies/tmdb.js';
import { STREAMING_OFF } from '../mcp/streamingTools.js';
import { runJsonScript, STREAMING_SITES, type StreamingSite } from '../streaming/service.js';
import { playing } from '../streaming/sitePlays.js';
import { describeIssues, readJson } from './api.js';
import { sameOriginOnly } from './sameOrigin.js';

/**
 * What the names and the play menu of a title's page ask for: who a person or a studio is and what a
 * genre means for the title, each with its titles marked (src/movies/guides.ts); storing a listed
 * title the library does not hold, so its pop-up can open; a play on one named streaming site; and
 * the title's download pages on pahe.ink. The POSTs store a title, call a model or start a Chrome
 * play, so they are same-origin only.
 */

const MOVIES_OFF = {
  error: 'movies_off',
  message: 'Movies are off on this machine (NOTESD_MOVIES=off).',
} as const;

const PERSON_PATH = '/api/movies/people/:personId{[0-9]{1,10}}';
const COMPANY_PATH = '/api/movies/companies/:companyId{[0-9]{1,10}}';
const GENRE_PATH = '/api/movies/:id{[a-z]+-[0-9]+}/genres/:genre';
const SITE_PLAY_PATH = '/api/movies/:id{[a-z]+-[0-9]+}/site-play';
const PAHE_PATH = '/api/movies/:id{[a-z]+-[0-9]+}/pahe';

const titleIdSchema = z.string().regex(/^(?:movie|tv)-[1-9][0-9]{0,9}$/);
const tmdbIdSchema = z.coerce.number().int().positive().max(2_147_483_647);
const genreSchema = z.string().trim().min(1).max(60);
const ensureBody = z.object({ kind: z.enum(['movie', 'tv']), tmdb_id: z.number().int().positive().max(2_147_483_647) }).strict();
const genreBody = z.object({ refresh: z.boolean().optional() }).strict();
const sitePlayBody = z
  .object({ site: z.enum(STREAMING_SITES), season: z.number().int().min(0).max(1000).optional(), episode: z.number().int().min(1).max(99_999).optional() })
  .strict()
  .refine((b) => (b.season === undefined) === (b.episode === undefined), { message: 'season and episode go together' });

/** GET and POST of a genre's guide. `guide` is null on a GET of one not written yet; `cached` is false only when this call had it written. */
export interface GenreGuideResponse {
  guide: EntityGuide | null;
  cached: boolean;
}

/** `GET /api/movies/:id/pahe`: the title's pages on pahe.ink, best source first, and the search page itself. */
export interface PaheResponse {
  matches: { title: string; url: string; year: number | null; release: string | null }[];
  search_url: string | null;
}

/** `claude/skills/pahe/search.mjs`, two folders up from src/http or dist/http. */
export const DEFAULT_PAHE_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'claude', 'skills', 'pahe', 'search.mjs');
export const PAHE_TIMEOUT_MS = 30_000;

/** Runs the /pahe skill's search and returns the JSON it prints. Tests inject a fake. */
export type PaheSearch = (title: string, year: number | null) => Promise<unknown>;

export function scriptPaheSearch(scriptPath: string = DEFAULT_PAHE_SCRIPT): PaheSearch {
  return (title, year) =>
    runJsonScript({ label: 'pahe search', nodeBin: process.execPath, argv: [scriptPath, ...title.split(/\s+/).filter((w) => w !== ''), ...(year === null ? [] : [String(year)])], timeoutMs: PAHE_TIMEOUT_MS });
}

export interface MoviesGuideApiOptions {
  /** Default: the /pahe skill's script. */
  pahe?: PaheSearch;
}

function paheAnswer(raw: unknown): PaheResponse {
  const o = (raw ?? {}) as { matches?: unknown; search_url?: unknown };
  const matches: PaheResponse['matches'] = [];
  for (const m of Array.isArray(o.matches) ? o.matches : []) {
    const e = m as { title?: unknown; url?: unknown; year?: unknown; release?: unknown };
    if (typeof e.url !== 'string' || !/^https:\/\//.test(e.url)) continue;
    matches.push({ title: typeof e.title === 'string' ? e.title : e.url, url: e.url, year: typeof e.year === 'number' ? e.year : null, release: typeof e.release === 'string' ? e.release : null });
  }
  return { matches, search_url: typeof o.search_url === 'string' ? o.search_url : null };
}

export function moviesGuideRoutes(
  deps: Pick<AppDeps, 'config' | 'db' | 'movies'> & Partial<Pick<AppDeps, 'genreGuides' | 'streaming'>>,
  options: MoviesGuideApiOptions = {},
): Hono {
  const api = new Hono();
  const db = deps.db;
  const pahe = options.pahe ?? scriptPaheSearch();

  function withMovies(handler: (c: Context, movies: MoviesService, ctx: ReadContext) => Promise<Response>) {
    return async (c: Context): Promise<Response> => {
      const movies = deps.movies;
      if (movies === null) return c.json(MOVIES_OFF, 503);
      return handler(c, movies, { host: movies.host, imageBase: deps.config.movies.tmdb.imageBase });
    };
  }

  /** One TMDB entity's guide, or the answer that says why not. */
  async function entity(c: Context, movies: MoviesService, read: (tmdb: GuideTmdb) => Promise<EntityGuide | null>): Promise<Response> {
    const tmdb = movies.tmdb;
    if (tmdb === null) return c.json({ error: 'tmdb_off', message: 'No TMDB credentials are configured.' }, 503);
    try {
      const guide = await read(tmdb);
      return guide === null ? c.json({ error: 'not_found' }, 404) : c.json(guide);
    } catch (err) {
      if (err instanceof TmdbError) return c.json({ error: 'tmdb_error', message: err.message }, 502);
      throw err;
    }
  }

  api.get(
    PERSON_PATH,
    withMovies(async (c, movies, ctx) => {
      const id = tmdbIdSchema.safeParse(c.req.param('personId'));
      if (!id.success) return c.json({ error: 'invalid_id' }, 400);
      return entity(c, movies, (tmdb) => personGuide(db, ctx, tmdb, id.data));
    }),
  );

  api.get(
    COMPANY_PATH,
    withMovies(async (c, movies, ctx) => {
      const id = tmdbIdSchema.safeParse(c.req.param('companyId'));
      if (!id.success) return c.json({ error: 'invalid_id' }, 400);
      return entity(c, movies, (tmdb) => companyGuide(db, ctx, tmdb, id.data));
    }),
  );

  // What a genre means for one title. GET only reads the store; POST has it collated once (or again, with `refresh`).
  api.get(
    GENRE_PATH,
    withMovies(async (c, _movies, ctx) => {
      const id = titleIdSchema.safeParse(c.req.param('id'));
      const genre = genreSchema.safeParse(c.req.param('genre'));
      if (!id.success || !genre.success) return c.json({ error: 'invalid_query' }, 400);
      const guides = deps.genreGuides ?? null;
      if (guides === null) return c.json({ error: 'guide_off' }, 503);
      const body: GenreGuideResponse = { guide: await guides.get(id.data, genre.data, ctx), cached: true };
      return c.json(body);
    }),
  );

  api.post(
    GENRE_PATH,
    sameOriginOnly,
    withMovies(async (c, _movies, ctx) => {
      const id = titleIdSchema.safeParse(c.req.param('id'));
      const genre = genreSchema.safeParse(c.req.param('genre'));
      if (!id.success || !genre.success) return c.json({ error: 'invalid_query' }, 400);
      const json = await readJson(c);
      const parsed = genreBody.safeParse(json.ok ? (json.value ?? {}) : {});
      if (!parsed.success) return c.json({ error: describeIssues(parsed.error) }, 400);
      const guides = deps.genreGuides ?? null;
      if (guides === null) return c.json({ error: 'guide_off' }, 503);
      try {
        const body: GenreGuideResponse = await guides.write(id.data, genre.data, ctx, parsed.data.refresh === true);
        return c.json(body);
      } catch (err) {
        if (!(err instanceof GuideError)) throw err;
        const status = err.code === 'not_found' || err.code === 'not_a_genre' ? 404 : err.code === 'guide_failed' ? 502 : 503;
        return c.json({ error: err.code, message: err.message }, status);
      }
    }),
  );

  /** Stores a title TMDB lists and the library does not hold yet, as its first stream would, so its pop-up and page can open. */
  api.post(
    '/api/movies/ensure',
    sameOriginOnly,
    withMovies(async (c, movies, ctx) => {
      const json = await readJson(c);
      if (!json.ok) return c.json({ error: 'invalid_json' }, 400);
      const parsed = ensureBody.safeParse(json.value);
      if (!parsed.success) return c.json({ error: describeIssues(parsed.error) }, 400);
      const id = await new MovieStreams(movies).ensureTitle({ kind: parsed.data.kind, tmdbId: parsed.data.tmdb_id });
      const detail = id === null ? null : await getTitle(db, id, ctx);
      if (id === null || detail === null) return c.json({ error: 'not_stored', message: 'TMDB did not answer for that title, or no TMDB credentials are configured.' }, 502);
      return c.json({ title_id: id, movie_id: detail.movie_id });
    }),
  );

  /**
   * Plays the title on one named streaming site: from the page it last played from there, else from
   * the one page the site's search returns for its name and year. The play is kept, so the site is
   * how the title plays from then on.
   */
  api.post(
    SITE_PLAY_PATH,
    sameOriginOnly,
    withMovies(async (c, movies) => {
      const id = titleIdSchema.safeParse(c.req.param('id'));
      if (!id.success) return c.json({ error: 'invalid_id' }, 400);
      const json = await readJson(c);
      if (!json.ok) return c.json({ error: 'invalid_json' }, 400);
      const parsed = sitePlayBody.safeParse(json.value);
      if (!parsed.success) return c.json({ error: describeIssues(parsed.error) }, 400);
      const runner = deps.streaming ?? null;
      if (runner === null) return c.json({ error: 'streaming_off', message: STREAMING_OFF }, 503);
      const title = await movies.repo.titleById(id.data);
      if (title === null) return c.json({ error: 'not_found' }, 404);
      const site: StreamingSite = parsed.data.site;
      const { season, episode } = parsed.data;
      if (title.kind === 'tv' && (season === undefined || episode === undefined)) return c.json({ error: 'no_episode', message: 'A series needs a season and an episode.' }, 400);
      const ref: StreamRef = title.kind === 'tv' ? { kind: 'tv', tmdbId: title.tmdbId, season: season as number, episode: episode as number } : { kind: 'movie', tmdbId: title.tmdbId };
      const slot = ref.kind === 'tv' ? ['--episode', String(ref.episode), '--season', String(ref.season)] : [];
      const streams = new MovieStreams(movies);
      try {
        // The page this site played the title from last time: no search, and no second title of that name.
        const known = (await movies.repo.methodsOf(id.data, movies.host)).find((m) => m.method === site)?.siteUrl ?? null;
        if (known !== null) {
          const again = playing(await runner(site, ref.kind === 'movie' ? ['--play-url', known, '--no-report'] : ['--play-from', known, ...slot, '--no-report']));
          if (again !== null) {
            await streams.recordSitePlay(ref, site, known);
            return c.json({ ok: true, site, site_url: known, site_play: again });
          }
        }
        // The command reports a play that started to this daemon itself (POST /api/movies/site-play), which keeps it.
        const answer = (await runner(site, ['--play', title.title, ...(title.year === null ? [] : [String(title.year)]), ...slot])) as { play?: { skipped_play?: unknown; url?: unknown } } | null;
        const play = playing(answer);
        if (play !== null) return c.json({ ok: true, site, site_url: typeof answer?.play?.url === 'string' ? answer.play.url : null, site_play: play });
        const skipped = typeof answer?.play?.skipped_play === 'string' ? answer.play.skipped_play : null;
        if (skipped === 'no_match') return c.json({ error: 'no_match', message: `${site} does not list ${title.title}.` }, 404);
        if (skipped === 'several_matches') return c.json({ error: 'several_matches', message: `${site} lists several titles called ${title.title}; name one with /${site}.` }, 409);
        if (skipped === 'no_episode') return c.json({ error: 'no_episode', message: `${site} lists no such episode of ${title.title}.` }, 404);
        if (skipped === 'series') return c.json({ error: 'series', message: `${site} plays films only.` }, 409);
        return c.json({ error: 'not_playing', message: `${site} did not start ${title.title}.`, play: answer?.play ?? null }, 502);
      } catch (err) {
        return c.json({ error: 'not_playing', message: err instanceof Error ? err.message : String(err) }, 502);
      }
    }),
  );

  /** Where the title can be downloaded: its pages on pahe.ink, as the /pahe skill's search returns them. */
  api.get(
    PAHE_PATH,
    withMovies(async (c, movies) => {
      const id = titleIdSchema.safeParse(c.req.param('id'));
      if (!id.success) return c.json({ error: 'invalid_id' }, 400);
      const title = await movies.repo.titleById(id.data);
      if (title === null) return c.json({ error: 'not_found' }, 404);
      try {
        const raw = await pahe(title.title, title.year);
        const answer = paheAnswer(raw);
        if ((raw as { ok?: unknown } | null)?.ok === false) return c.json({ error: 'pahe_error', message: String((raw as { error?: unknown }).error ?? 'pahe.ink could not be read'), search_url: answer.search_url }, 502);
        return c.json(answer);
      } catch (err) {
        return c.json({ error: 'pahe_error', message: err instanceof Error ? err.message : String(err), search_url: null }, 502);
      }
    }),
  );

  return api;
}
