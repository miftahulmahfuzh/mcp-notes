import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import {
  getTitle,
  listTitles,
  listUnmatched,
  MAX_LIST_LIMIT,
  searchHitViews,
  statusCounts,
  TITLE_SORTS,
  WATCH_STATES,
  type ReadContext,
  type StatusCounts,
  type TitleDetail,
  type TitleListItem,
  type TmdbHitView,
  type UnmatchedFile,
} from '../movies/read.js';
import { MAX_REVIEW_CHARS, saveReview } from '../movies/reviewNote.js';
import { MoviesServiceError, type MovieChangeEvent, type MoviesService } from '../movies/service.js';
import { TmdbError } from '../movies/tmdb.js';
import { titleId as makeTitleId } from '../movies/types.js';
import { parseDateBound } from '../notes/dates.js';
import { NoteError } from '../notes/types.js';
import { describeIssues, readJson, SSE_HEARTBEAT_MS } from './api.js';
import { sameOriginOnly } from './sameOrigin.js';

/**
 * /api/movies/* (MOVIES_LIBRARY_PLAN phase 4): the read model, user state (watched, rating, review note), the
 * unmatched list and its manual fix, a sync trigger and the `changed` stream. Phase 5's play routes live in
 * moviesPlayApi.ts. Path params are regex-constrained, so `/api/movies/player` and `/api/movies/continue` never
 * match here. Every route answers 503 movies_off without a MoviesService; writes are same-origin only.
 */

export interface MoviesApiOptions {
  /** Defaults to SSE_HEARTBEAT_MS. Tests pass a small value. */
  sseHeartbeatMs?: number;
}

export interface TitleListResponse {
  titles: TitleListItem[];
}
export interface UnmatchedResponse {
  files: UnmatchedFile[];
}
export type MoviesStatusResponse = Awaited<ReturnType<MoviesService['status']>> & { counts: StatusCounts };
export interface TmdbSearchResponse {
  results: TmdbHitView[];
}
export interface FileChangeResponse {
  file_id: number;
  title: TitleDetail | null;
}
export interface SyncResponse {
  started: true;
  report: Awaited<ReturnType<MoviesService['syncNow']>> | null;
}
/** `data:` of each `event: changed`: phase 3's event, unchanged. */
export type MovieChangeWire = MovieChangeEvent;

const MOVIES_OFF = {
  error: 'movies_off',
  message: 'The movies library is off on this machine (NOTESD_MOVIES=off).',
} as const;

const TMDB_OFF = {
  error: 'tmdb_off',
  message: 'No TMDB credentials (TMDB_API_READ_ACCESS_TOKEN or TMDB_API_KEY) on this machine.',
} as const;

const TITLE_PATH = '/api/movies/:id{[a-z]+-[0-9]+}';
const USER_PATH = '/api/movies/:id{[a-z]+-[0-9]+}/user';
const FILE_WATCHED_PATH = '/api/movies/files/:fileId{[0-9]+}/watched';
const FILE_ASSIGN_PATH = '/api/movies/files/:fileId{[0-9]+}/assign';

const titleIdSchema = z.string().regex(/^(?:movie|tv)-[1-9][0-9]{0,9}$/);
const fileIdSchema = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const textParam = z.string().trim().min(1).max(200);
const dateParam = z.string().trim().min(1).max(40);

const listQuery = z.object({
  q: textParam.optional(),
  state: z.enum(WATCH_STATES).optional(),
  kind: z.enum(['movie', 'tv']).optional(),
  company: textParam.optional(),
  person: textParam.optional(),
  finished_from: dateParam.optional(),
  finished_to: dateParam.optional(),
  sort: z.enum(TITLE_SORTS).default('recent'),
  limit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).optional(),
});

const searchQuery = z.object({
  q: textParam,
  kind: z.enum(['movie', 'tv']).optional(),
  year: z.coerce.number().int().min(1870).max(2100).optional(),
});

const userBody = z
  .object({
    watched: z.boolean().optional(),
    rating: z.number().int().min(0).max(5).nullable().optional(),
    review: z.string().max(MAX_REVIEW_CHARS).optional(),
  })
  .strict()
  .refine((b) => b.watched !== undefined || b.rating !== undefined || b.review !== undefined, {
    message: 'set at least one of watched, rating, review',
  });

const watchedBody = z.object({ watched: z.boolean() }).strict();

const tmdbIdSchema = z.number().int().positive().max(2_147_483_647);
/** A movie has no slot; a tv slot is a season and an episode together, or neither. */
const assignBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('movie'), tmdb_id: tmdbIdSchema }).strict(),
  z
    .object({
      kind: z.literal('tv'),
      tmdb_id: tmdbIdSchema,
      season: z.number().int().min(0).max(999).optional(),
      episode: z.number().int().min(0).max(99_999).optional(),
    })
    .strict()
    .refine((b) => (b.season === undefined) === (b.episode === undefined), {
      message: 'season and episode go together',
      path: ['episode'],
    }),
]);

/** A query param, with an empty value treated as absent. */
function qp(c: Context, name: string): string | undefined {
  const v = c.req.query(name);
  return v === undefined || v.trim() === '' ? undefined : v;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function moviesApiRoutes(
  deps: Pick<AppDeps, 'config' | 'db' | 'service' | 'movies'>,
  options: MoviesApiOptions = {},
): Hono {
  const api = new Hono();
  const db = deps.db;
  const heartbeatMs = options.sseHeartbeatMs ?? SSE_HEARTBEAT_MS;

  /** The movies_off guard, per route: a `use('/api/movies/*')` middleware would also catch phase 5's play routes. */
  function withMovies(handler: (c: Context, movies: MoviesService, ctx: ReadContext) => Promise<Response>) {
    return async (c: Context): Promise<Response> => {
      const movies = deps.movies;
      if (movies === null) return c.json(MOVIES_OFF, 503);
      return handler(c, movies, { host: movies.host, imageBase: deps.config.movies.tmdb.imageBase });
    };
  }

  async function detailResponse(c: Context, id: string, ctx: ReadContext): Promise<Response> {
    const detail = await getTitle(db, id, ctx);
    return detail === null ? c.json({ error: 'not_found' }, 404) : c.json(detail);
  }

  function tmdbFailed(c: Context, err: TmdbError): Response {
    return c.json({ error: 'tmdb_error', message: err.message }, 502);
  }

  api.get(
    '/api/movies',
    withMovies(async (c, _movies, ctx) => {
      const parsed = listQuery.safeParse({
        q: qp(c, 'q'),
        state: qp(c, 'state'),
        kind: qp(c, 'kind'),
        company: qp(c, 'company'),
        person: qp(c, 'person'),
        finished_from: qp(c, 'finished_from'),
        finished_to: qp(c, 'finished_to'),
        sort: qp(c, 'sort'),
        limit: qp(c, 'limit'),
      });
      if (!parsed.success) return c.json({ error: describeIssues(parsed.error) }, 400);
      const p = parsed.data;
      let finishedFrom: Date | undefined;
      let finishedTo: Date | undefined;
      try {
        finishedFrom = p.finished_from === undefined ? undefined : parseDateBound(p.finished_from, 'from');
        finishedTo = p.finished_to === undefined ? undefined : parseDateBound(p.finished_to, 'to');
      } catch (err) {
        if (err instanceof NoteError) return c.json({ error: `finished_from/finished_to: ${err.message}` }, 400);
        throw err;
      }
      const titles = await listTitles(
        db,
        {
          ...(p.q !== undefined ? { q: p.q } : {}),
          ...(p.state !== undefined ? { state: p.state } : {}),
          ...(p.kind !== undefined ? { kind: p.kind } : {}),
          ...(p.company !== undefined ? { company: p.company } : {}),
          ...(p.person !== undefined ? { person: p.person } : {}),
          ...(finishedFrom !== undefined ? { finishedFrom } : {}),
          ...(finishedTo !== undefined ? { finishedTo } : {}),
          ...(p.limit !== undefined ? { limit: p.limit } : {}),
          sort: p.sort,
        },
        ctx,
      );
      const body: TitleListResponse = { titles };
      return c.json(body);
    }),
  );

  api.get(
    '/api/movies/unmatched',
    withMovies(async (c, _movies, ctx) => {
      const body: UnmatchedResponse = { files: await listUnmatched(db, ctx) };
      return c.json(body);
    }),
  );

  api.get(
    '/api/movies/status',
    withMovies(async (c, movies, ctx) => {
      const [status, counts] = await Promise.all([movies.status(), statusCounts(db, ctx)]);
      const body: MoviesStatusResponse = { ...status, counts };
      return c.json(body);
    }),
  );

  api.get(
    '/api/movies/search-tmdb',
    withMovies(async (c, movies, ctx) => {
      const parsed = searchQuery.safeParse({ q: qp(c, 'q'), kind: qp(c, 'kind'), year: qp(c, 'year') });
      if (!parsed.success) return c.json({ error: describeIssues(parsed.error) }, 400);
      const tmdb = movies.tmdb;
      if (tmdb === null) return c.json(TMDB_OFF, 503);
      const { q, kind, year } = parsed.data;
      try {
        const [films, shows] = await Promise.all([
          kind !== 'tv' ? tmdb.searchMovie(q, year ?? null) : Promise.resolve([]),
          kind !== 'movie' ? tmdb.searchTv(q, year ?? null) : Promise.resolve([]),
        ]);
        const body: TmdbSearchResponse = { results: await searchHitViews(db, [...films, ...shows], ctx) };
        return c.json(body);
      } catch (err) {
        if (err instanceof TmdbError) return tmdbFailed(c, err);
        throw err;
      }
    }),
  );

  api.get('/api/movies/events', (c) => {
    const movies = deps.movies;
    if (movies === null) return c.json(MOVIES_OFF, 503);
    const events = movies.events;
    return streamSSE(c, async (stream) => {
      let closed = false;
      const unsubscribe = events.on((change: MovieChangeEvent) => {
        if (closed) return;
        const wire: MovieChangeWire = change;
        void stream.writeSSE({ event: 'changed', data: JSON.stringify(wire) }).catch(() => undefined);
      });
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (!closed) void stream.write(': heartbeat\n\n').catch(() => undefined);
        }, heartbeatMs);
        stream.onAbort(() => {
          closed = true;
          clearInterval(timer);
          unsubscribe();
          resolve();
        });
        void stream.write(': connected\n\n').catch(() => undefined);
      });
    });
  });

  api.get(
    TITLE_PATH,
    withMovies(async (c, _movies, ctx) => {
      const id = titleIdSchema.safeParse(c.req.param('id'));
      if (!id.success) return c.json({ error: 'invalid_id' }, 400);
      return detailResponse(c, id.data, ctx);
    }),
  );

  api.post(
    USER_PATH,
    sameOriginOnly,
    withMovies(async (c, movies, ctx) => {
      const id = titleIdSchema.safeParse(c.req.param('id'));
      if (!id.success) return c.json({ error: 'invalid_id' }, 400);
      const json = await readJson(c);
      if (!json.ok) return c.json({ error: 'invalid_json' }, 400);
      const parsed = userBody.safeParse(json.value);
      if (!parsed.success) return c.json({ error: describeIssues(parsed.error) }, 400);
      if ((await movies.repo.titleById(id.data)) === null) return c.json({ error: 'not_found' }, 404);
      const { watched, rating, review } = parsed.data;
      if (watched !== undefined || rating !== undefined) {
        await movies.repo.setTitleUser(id.data, {
          ...(watched !== undefined ? { watched } : {}),
          ...(rating !== undefined ? { rating } : {}),
        });
      }
      if (review !== undefined) await saveReview(movies, deps.service, id.data, review);
      movies.events.changed('user', { titleIds: [id.data] });
      return detailResponse(c, id.data, ctx);
    }),
  );

  api.post(
    FILE_WATCHED_PATH,
    sameOriginOnly,
    withMovies(async (c, movies, ctx) => {
      const fileId = fileIdSchema.safeParse(c.req.param('fileId'));
      if (!fileId.success) return c.json({ error: 'invalid_id' }, 400);
      const json = await readJson(c);
      if (!json.ok) return c.json({ error: 'invalid_json' }, 400);
      const parsed = watchedBody.safeParse(json.value);
      if (!parsed.success) return c.json({ error: describeIssues(parsed.error) }, 400);
      const file = await movies.repo.fileById(fileId.data);
      if (file === null) return c.json({ error: 'not_found' }, 404);
      await movies.repo.setFileWatched(fileId.data, parsed.data.watched);
      movies.events.changed('user', { fileIds: [fileId.data], titleIds: file.titleId !== null ? [file.titleId] : [] });
      const body: FileChangeResponse = {
        file_id: fileId.data,
        title: file.titleId === null ? null : await getTitle(db, file.titleId, ctx),
      };
      return c.json(body);
    }),
  );

  api.post(
    FILE_ASSIGN_PATH,
    sameOriginOnly,
    withMovies(async (c, movies, ctx) => {
      const fileId = fileIdSchema.safeParse(c.req.param('fileId'));
      if (!fileId.success) return c.json({ error: 'invalid_id' }, 400);
      const json = await readJson(c);
      if (!json.ok) return c.json({ error: 'invalid_json' }, 400);
      const parsed = assignBody.safeParse(json.value);
      if (!parsed.success) return c.json({ error: describeIssues(parsed.error) }, 400);
      if ((await movies.repo.fileById(fileId.data)) === null) return c.json({ error: 'not_found' }, 404);
      const target = parsed.data;
      try {
        await movies.assign(fileId.data, {
          kind: target.kind,
          tmdbId: target.tmdb_id,
          ...(target.kind === 'tv' && target.season !== undefined && target.episode !== undefined
            ? { season: target.season, episode: target.episode }
            : {}),
        });
      } catch (err) {
        // service.assign maps TMDB failures to MoviesServiceError (phase 3) and emits 'assign' itself.
        if (err instanceof MoviesServiceError) {
          if (err.code === 'not_found') return c.json({ error: 'not_found' }, 404);
          if (err.code === 'no_tmdb_credentials') return c.json(TMDB_OFF, 503);
          return c.json({ error: 'tmdb_error', message: err.message }, 502);
        }
        throw err;
      }
      const titleId = makeTitleId(target.kind, target.tmdb_id);
      const body: FileChangeResponse = { file_id: fileId.data, title: await getTitle(db, titleId, ctx) };
      return c.json(body);
    }),
  );

  /** Starts a pass and answers 202 at once; `?wait=true` (scripts, tests) answers with the report. */
  api.post(
    '/api/movies/sync',
    sameOriginOnly,
    withMovies(async (c, movies) => {
      const wait = c.req.query('wait');
      if (wait === 'true' || wait === '1') {
        const body: SyncResponse = { started: true, report: await movies.syncNow() };
        return c.json(body);
      }
      void movies.syncNow().catch((err: unknown) => console.error(`[notesd] movies sync failed: ${errorMessage(err)}`));
      const body: SyncResponse = { started: true, report: null };
      return c.json(body, 202);
    }),
  );

  return api;
}
