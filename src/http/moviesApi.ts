import { DirectStreamError } from '../directStream/types.js';
import { StoryError, type StoryView } from '../movies/story.js';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import {
  getTitle,
  listStreamTitles,
  listTitlesByIds,
  titleLanguages,
  listTitles,
  listUnmatched,
  MAX_LIST_LIMIT,
  searchHitViews,
  statusCounts,
  TITLE_SORTS,
  WATCH_STATES,
  type ReadContext,
  type StatusCounts,
  type StreamSourceView,
  type TitleDetail,
  type TitleListItem,
  type TmdbHitView,
  type UnmatchedFile,
} from '../movies/read.js';
import { resolveMovieId } from '../movies/ids.js';
import { isFreshStreamSource, streamFreshSince } from '../movies/repo.js';
import { MAX_REVIEW_CHARS, saveReview } from '../movies/reviewNote.js';
import { MoviesServiceError, type MovieChangeEvent, type MoviesService } from '../movies/service.js';
import { TmdbError } from '../movies/tmdb.js';
import { titleId as makeTitleId } from '../movies/types.js';
import { parseDateBound } from '../notes/dates.js';
import { NoteError } from '../notes/types.js';
import { describeIssues, readJson, SSE_HEARTBEAT_MS } from './api.js';
import { sameOriginOnly } from './sameOrigin.js';
import { isFreshForTrending, type TrendingOffReason, type TrendingStatus } from '../directStream/trending/job.js';
import { TrendingRepo } from '../directStream/trending/repo.js';
import type { TrendingProbeOutcome } from '../db/schema.js';

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
/** GET and POST /api/movies/:id/story. `cached` is false only when this call had the story written. */
export interface StoryResponse {
  story: StoryView | null;
  cached: boolean;
}
/** POST /api/movies/:id/episodes/watched: `changed` is what an undo sends back with `watched` flipped. */
export interface EpisodesWatchedResponse {
  watched: boolean;
  changed: { season: number; episode: number }[];
  title: TitleDetailResponse | null;
}
export interface FileChangeResponse {
  file_id: number;
  title: TitleDetailResponse | null;
}
export interface SyncResponse {
  started: true;
  report: Awaited<ReturnType<MoviesService['syncNow']>> | null;
}
/** `data:` of each `event: changed`: phase 3's event, unchanged. */
export type MovieChangeWire = MovieChangeEvent;

/** One of this machine's stream sources as the page reads it: phase 5's row plus `fresh`, the Stream grid's own test. */
export type StreamSourceWire = StreamSourceView & { fresh: boolean };

/** A title as every detail route answers it: phase 5's TitleDetail with only this machine's stream sources, each marked fresh or not. */
export type TitleDetailResponse = Omit<TitleDetail, 'stream_sources'> & { stream_sources: StreamSourceWire[] };

/** `GET /api/movies/stream`. Off is a normal answer, not an error, so the page can say how to turn it on. */
export type StreamListResponse =
  | { enabled: true; titles: TitleListItem[]; fresh_days: number }
  | { enabled: false; reason: 'direct_stream_off'; titles: TitleListItem[] };

/** One title of the Trending section: the grid's shape plus what the indexes and the swarm probe said of its torrent. */
export type TrendingTitle = TitleListItem & {
  trending: {
    kind_rank: number;
    seeds: number;
    index: string;
    release: string;
    size_bytes: number | null;
    listed_at: string;
    /** What opening the torrent's swarm showed; null while it has not been probed. */
    probe: { outcome: TrendingProbeOutcome; detail: string | null; at: string } | null;
  };
};

/** `GET /api/movies/trending`. Off is a normal answer, so the page can say how to turn it on. */
export type TrendingListResponse =
  | { enabled: true; titles: TrendingTitle[]; listed_at: string | null; status: TrendingStatus }
  | { enabled: false; reason: TrendingOffReason | 'direct_stream_off'; titles: TrendingTitle[]; listed_at: null };

const MOVIES_OFF = {
  error: 'movies_off',
  message: 'The movies library is off on this machine (NOTESD_MOVIES=off).',
} as const;

const TMDB_OFF = {
  error: 'tmdb_off',
  message: 'No TMDB credentials (TMDB_API_READ_ACCESS_TOKEN or TMDB_API_KEY) on this machine.',
} as const;

interface StreamWindow {
  freshDays: number;
  since: Date;
}

/**
 * Direct streaming answers on this daemon only with movies on, NOTESD_DIRECT_STREAM on and a
 * DirectStreamService built (R2.6's three switches). Then: the freshness window, from
 * NOTESD_STREAM_FRESH_DAYS (`config.directStream.freshDays`), through phase 5's streamFreshSince.
 */
function streamWindow(deps: Pick<AppDeps, 'config' | 'movies' | 'directStream'>, now: Date = new Date()): StreamWindow | null {
  const ds = deps.config.directStream;
  if (deps.movies === null || (deps.directStream ?? null) === null || ds === undefined || !ds.enabled) return null;
  return { freshDays: ds.freshDays, since: streamFreshSince(now, ds.freshDays) };
}

/**
 * Each of this machine's sources (phase 5's getTitle returns only `ctx.host`'s) marked `fresh` by
 * phase 5's isFreshStreamSource, the same rule listStreamTitles applies in SQL. With direct
 * streaming off nothing is fresh.
 */
function withStreamFreshness(detail: TitleDetail, host: string, window: StreamWindow | null): TitleDetailResponse {
  return {
    ...detail,
    stream_sources: detail.stream_sources.map((s) => ({
      ...s,
      fresh:
        window !== null &&
        isFreshStreamSource(
          { host: s.host, staleAt: s.stale_at === null ? null : new Date(s.stale_at), verifiedAt: new Date(s.verified_at) },
          host,
          window.since,
        ),
    })),
  };
}

const TITLE_PATH = '/api/movies/:id{[a-z]+-[0-9]+}';
/** A movie id (`M-23T4`, any case): the title it names, or the series of the episode it names. */
const MOVIE_ID_PATH = '/api/movies/:movieId{[Mm]-[0-9A-Za-z]+}';
const USER_PATH = '/api/movies/:id{[a-z]+-[0-9]+}/user';
const EPISODES_WATCHED_PATH = '/api/movies/:id{[a-z]+-[0-9]+}/episodes/watched';
const STORY_PATH = '/api/movies/:id{[a-z]+-[0-9]+}/story';
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
    not_interested: z.boolean().optional(),
    rating: z.number().int().min(0).max(5).nullable().optional(),
    review: z.string().max(MAX_REVIEW_CHARS).optional(),
  })
  .strict()
  .refine((b) => b.watched !== undefined || b.not_interested !== undefined || b.rating !== undefined || b.review !== undefined, {
    message: 'set at least one of watched, not_interested, rating, review',
  });

/** A film is season 0, episode 0 (the default); an episode names both. */
const storySlot = z
  .object({ season: z.coerce.number().int().min(0).max(1000).default(0), episode: z.coerce.number().int().min(0).max(100_000).default(0) })
  .refine((s) => s.episode > 0 || s.season === 0, { message: 'a season needs an episode' });

const episodeRefSchema = z.object({ season: z.number().int().min(0).max(1000), episode: z.number().int().min(1).max(100_000) }).strict();
/** A whole season, or a list of episodes (what an undo sends back); exactly one of the two. */
const episodesWatchedBody = z
  .object({
    watched: z.boolean(),
    season: z.number().int().min(0).max(1000).optional(),
    episodes: z.array(episodeRefSchema).min(1).max(2000).optional(),
  })
  .strict()
  .refine((b) => (b.season === undefined) !== (b.episodes === undefined), { message: 'give season or episodes, not both' });

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
  deps: Pick<AppDeps, 'config' | 'db' | 'service' | 'movies' | 'directStream'> & Partial<Pick<AppDeps, 'movieStories' | 'trending'>>,
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

  /** Every route that answers one title goes through here, so `stream_sources` always carries `fresh`. */
  async function titleResponse(id: string, ctx: ReadContext): Promise<TitleDetailResponse | null> {
    const detail = await getTitle(db, id, ctx);
    return detail === null ? null : withStreamFreshness(detail, ctx.host, streamWindow(deps));
  }

  async function detailResponse(c: Context, id: string, ctx: ReadContext): Promise<Response> {
    const detail = await titleResponse(id, ctx);
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

  /**
   * The Stream side of the page: only the titles with a source verified on this machine inside the
   * freshness window and not marked stale (D4, invariant 10), in the grid's TitleListItem shape.
   * Direct streaming off is `enabled: false`, never an error, so the page can say how to turn it on.
   */
  api.get(
    '/api/movies/stream',
    withMovies(async (c, _movies, ctx) => {
      const window = streamWindow(deps);
      if (window === null) {
        const off: StreamListResponse = { enabled: false, reason: 'direct_stream_off', titles: [] };
        return c.json(off);
      }
      const body: StreamListResponse = {
        enabled: true,
        titles: await listStreamTitles(db, {}, ctx, window.since),
        fresh_days: window.freshDays,
      };
      return c.json(body);
    }),
  );

  /**
   * The Trending section of the Stream side: this machine's list of the most seeded films and series, minus every
   * title the owner has seen, started or marked not interested since the list was built (read from movie_titles
   * now, never from the list), so a mark takes a title off at once.
   */
  api.get(
    '/api/movies/trending',
    withMovies(async (c, _movies, ctx) => {
      const job = deps.trending ?? null;
      if (deps.directStream === undefined || deps.directStream === null) {
        const off: TrendingListResponse = { enabled: false, reason: 'direct_stream_off', titles: [], listed_at: null };
        return c.json(off);
      }
      if (job === null || !job.enabled) {
        const off: TrendingListResponse = { enabled: false, reason: job?.status().off_reason ?? 'setting_off', titles: [], listed_at: null };
        return c.json(off);
      }
      const rows = await new TrendingRepo(db).rows(ctx.host);
      const skip = new Set(deps.config.directStream?.trending?.skipLanguages ?? []);
      const languages = skip.size === 0 ? new Map<string, string | null>() : await titleLanguages(db, rows.map((r) => r.titleId));
      const items = new Map((await listTitlesByIds(db, rows.map((r) => r.titleId).filter((id) => !skip.has(languages.get(id) ?? '')), ctx)).map((i) => [i.id, i]));
      const titles: TrendingTitle[] = [];
      for (const row of rows) {
        const item = items.get(row.titleId);
        if (item === undefined || !isFreshForTrending(item)) continue;
        titles.push({
          ...item,
          trending: {
            kind_rank: row.rank,
            seeds: row.seeds,
            index: row.index,
            release: row.releaseName,
            size_bytes: row.sizeBytes,
            listed_at: row.listedAt.toISOString(),
            probe: row.probeOutcome === null || row.probedAt === null ? null : { outcome: row.probeOutcome, detail: row.probeDetail, at: row.probedAt.toISOString() },
          },
        });
      }
      const listedAt = rows.reduce<Date | null>((at, r) => (at === null || r.listedAt > at ? r.listedAt : at), null);
      const body: TrendingListResponse = { enabled: true, titles, listed_at: listedAt === null ? null : listedAt.toISOString(), status: job.status() };
      return c.json(body);
    }),
  );

  /** The refresh icon: one trending pass now (a new list, then the probes). Answers at once; the pass runs on. */
  api.post(
    '/api/movies/trending/refresh',
    sameOriginOnly,
    withMovies(async (c) => {
      const job = deps.trending ?? null;
      if (job === null || !job.enabled) return c.json({ error: 'trending_off', message: 'The trending list is off on this machine.', ...(job === null ? {} : { status: job.status() }) }, 409);
      const started = job.askPass();
      return c.json({ started, status: job.status() }, 202);
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
    MOVIE_ID_PATH,
    withMovies(async (c, _movies, ctx) => {
      const target = await resolveMovieId(db, c.req.param('movieId') ?? '');
      return target === null ? c.json({ error: 'not_found' }, 404) : detailResponse(c, target.titleId, ctx);
    }),
  );

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
      const { watched, not_interested: notInterested, rating, review } = parsed.data;
      if (watched !== undefined || notInterested !== undefined || rating !== undefined) {
        await movies.repo.setTitleUser(id.data, {
          ...(watched !== undefined ? { watched } : {}),
          ...(notInterested !== undefined ? { notInterested } : {}),
          ...(rating !== undefined ? { rating } : {}),
        });
      }
      if (review !== undefined) await saveReview(movies, deps.service, id.data, review);
      movies.events.changed('user', { titleIds: [id.data] });
      return detailResponse(c, id.data, ctx);
    }),
  );

  api.post(
    EPISODES_WATCHED_PATH,
    sameOriginOnly,
    withMovies(async (c, movies, ctx) => {
      const id = titleIdSchema.safeParse(c.req.param('id'));
      if (!id.success) return c.json({ error: 'invalid_id' }, 400);
      const json = await readJson(c);
      if (!json.ok) return c.json({ error: 'invalid_json' }, 400);
      const parsed = episodesWatchedBody.safeParse(json.value);
      if (!parsed.success) return c.json({ error: describeIssues(parsed.error) }, 400);
      const title = await movies.repo.titleById(id.data);
      if (title === null) return c.json({ error: 'not_found' }, 404);
      if (title.kind !== 'tv') return c.json({ error: 'not_a_series' }, 400);
      const { watched, season, episodes } = parsed.data;
      const targets = episodes ?? (await movies.repo.seasonEpisodes(id.data, season ?? 0));
      if (targets.length === 0) return c.json({ error: 'no_episodes' }, 404);
      const changed = await movies.repo.setEpisodesWatched(id.data, targets, watched);
      if (changed.length > 0) movies.events.changed('user', { titleIds: [id.data] });
      const body: EpisodesWatchedResponse = { watched, changed, title: await titleResponse(id.data, ctx) };
      return c.json(body);
    }),
  );

  // The story of a film or an episode (src/movies/story.ts). GET only reads the store; POST writes it once.
  api.get(
    STORY_PATH,
    withMovies(async (c) => {
      const id = titleIdSchema.safeParse(c.req.param('id'));
      const slot = storySlot.safeParse({ season: c.req.query('season'), episode: c.req.query('episode') });
      if (!id.success || !slot.success) return c.json({ error: 'invalid_query' }, 400);
      const stories = deps.movieStories ?? null;
      if (stories === null) return c.json({ error: 'story_off' }, 503);
      const body: StoryResponse = { story: await stories.get(id.data, slot.data.season, slot.data.episode), cached: true };
      return c.json(body);
    }),
  );

  api.post(
    STORY_PATH,
    sameOriginOnly,
    withMovies(async (c) => {
      const id = titleIdSchema.safeParse(c.req.param('id'));
      if (!id.success) return c.json({ error: 'invalid_id' }, 400);
      const json = await readJson(c);
      const slot = storySlot.safeParse(json.ok ? (json.value ?? {}) : null);
      if (!slot.success) return c.json({ error: 'invalid_body' }, 400);
      const stories = deps.movieStories ?? null;
      if (stories === null) return c.json({ error: 'story_off' }, 503);
      try {
        const body: StoryResponse = await stories.write(id.data, slot.data.season, slot.data.episode);
        // A new story: open pages show the episode's book icon as filled.
        if (!body.cached) deps.movies?.events.changed('user', { titleIds: [id.data] });
        return c.json(body);
      } catch (err) {
        if (err instanceof StoryError) {
          const status = err.code === 'not_found' ? 404 : err.code === 'story_failed' ? 502 : 503;
          return c.json({ error: err.code, message: err.message }, status);
        }
        // The dialogue could not be read: no source has the title, or the one that has it carries no English subtitle.
        if (err instanceof DirectStreamError) return c.json({ error: err.code, reason: err.reason, message: err.message }, 502);
        throw err;
      }
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
        title: file.titleId === null ? null : await titleResponse(file.titleId, ctx),
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
      const body: FileChangeResponse = { file_id: fileId.data, title: await titleResponse(titleId, ctx) };
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
