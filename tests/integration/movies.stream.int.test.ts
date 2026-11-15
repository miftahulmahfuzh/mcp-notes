import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DIRECT_STREAM_CONFIG, type Config } from '../../src/config.js';
import type { AppDeps } from '../../src/deps.js';
import { moviesApiRoutes, type StreamListResponse, type TitleDetailResponse, type TitleListResponse } from '../../src/http/moviesApi.js';
import { buildMoviesService, type MoviesService } from '../../src/movies/service.js';
import { truncateAll } from './setup.js';
import { createApiHarness, type ApiHarness } from './helpers/api-harness.js';
import { fakeTmdb, HOST_HERE, HOST_OTHER, MOVIES_TEST_CONFIG, NEZHA2_TMDB_ID, seedLibrary, truncateMovies } from './helpers/moviesSeed.js';

const DAY_MS = 86_400_000;
const FRESH_DAYS = 7;
/** The route only asks whether a DirectStreamService was built; it never calls one. */
const SERVICE = {} as NonNullable<AppDeps['directStream']>;

let h: ApiHarness;
let here: MoviesService;
let other: MoviesService;
let nezha2: string;

function serviceFor(host: string): MoviesService {
  const built = buildMoviesService({ ...h.deps.config, movies: MOVIES_TEST_CONFIG }, h.deps.db, { host, tmdb: fakeTmdb() });
  if (built === null) throw new Error('movies service not built');
  return built;
}

interface AppOptions {
  movies?: MoviesService | null;
  enabled?: boolean;
  service?: AppDeps['directStream'];
}

function appFor(o: AppOptions = {}): Hono {
  const config: Config = {
    ...h.deps.config,
    movies: MOVIES_TEST_CONFIG,
    directStream: { ...DEFAULT_DIRECT_STREAM_CONFIG, enabled: o.enabled ?? true, freshDays: FRESH_DAYS },
  };
  const app = new Hono();
  app.route(
    '/',
    moviesApiRoutes({
      ...h.deps,
      config,
      movies: o.movies === undefined ? here : o.movies,
      directStream: o.service === undefined ? SERVICE : o.service,
    }),
  );
  return app;
}

async function getJson<T>(app: Hono, path: string): Promise<{ status: number; body: T }> {
  const res = await app.request(path);
  return { status: res.status, body: (await res.json()) as T };
}

/** A movie_stream_sources row (seeding only: the daemon writes these through MoviesRepo, phase 5). A stale row names its failure (movie_stream_sources_failure_check). */
async function source(titleId: string, season: number, episode: number, host: string, verifiedDaysAgo: number, stale = false): Promise<void> {
  const verifiedAt = new Date(Date.now() - verifiedDaysAgo * DAY_MS).toISOString();
  const staleAt = stale ? new Date().toISOString() : null;
  const failure = stale ? 'no_source' : null;
  await h.deps.db.execute(sql`
    insert into movie_stream_sources (title_id, season, episode, host, provider, manifest_kind, best_height, en_subtitle, verified_at, stale_at, failure)
    values (${titleId}, ${season}, ${episode}, ${host}, 'VidFast', 'hls', 2160, true, ${verifiedAt}::timestamptz, ${staleAt}::timestamptz, ${failure})
  `);
}

const ids = (b: StreamListResponse) => b.titles.map((t) => t.id).sort();

beforeAll(async () => {
  h = await createApiHarness();
  here = serviceFor(HOST_HERE);
  other = serviceFor(HOST_OTHER);
});

afterAll(async () => {
  await here.close();
  await other.close();
  await h.close();
});

beforeEach(async () => {
  await truncateAll(h.deps.db);
  await truncateMovies(h.deps.db);
  await seedLibrary(h.deps.db);
  // A title with no file anywhere: only a stream source brings it to the page.
  nezha2 = await here.repo.upsertTitle(await fakeTmdb().movieDetails(NEZHA2_TMDB_ID));
  await source(nezha2, 0, 0, HOST_HERE, 1);
  await source('movie-467905', 0, 0, HOST_HERE, 2);
  // MobLand on this host: S01E01 failed at its last play (stale), S01E03 was verified 10 days ago.
  await source('tv-247718', 1, 1, HOST_HERE, 1, true);
  await source('tv-247718', 1, 3, HOST_HERE, 10);
  // The other machine verified S01E02: that is not this machine's to play.
  await source('tv-247718', 1, 2, HOST_OTHER, 1);
});

describe('GET /api/movies/stream (the Stream grid)', () => {
  it('lists only titles with a source verified on this host inside the window and not stale', async () => {
    const { status, body } = await getJson<StreamListResponse>(appFor(), '/api/movies/stream');
    expect(status).toBe(200);
    expect(body).toMatchObject({ enabled: true, fresh_days: FRESH_DAYS });
    expect(ids(body)).toEqual(['movie-467905', nezha2]);
    const streamOnly = body.titles.find((t) => t.id === nezha2);
    expect(streamOnly).toMatchObject({ kind: 'movie', title: 'Ne Zha 2', file_count: 0, present_here: false });
  });

  it('a fresh episode of a series brings the series in', async () => {
    await source('tv-247718', 1, 2, HOST_HERE, 3);
    const { body } = await getJson<StreamListResponse>(appFor(), '/api/movies/stream');
    expect(ids(body)).toEqual(['movie-467905', nezha2, 'tv-247718']);
  });

  it('the other machine sees its own verified titles, not this one\'s', async () => {
    const { body } = await getJson<StreamListResponse>(appFor({ movies: other }), '/api/movies/stream');
    expect(ids(body)).toEqual(['tv-247718']);
  });

  it('a stream-only title stays out of the Library list', async () => {
    const { body } = await getJson<TitleListResponse>(appFor(), '/api/movies');
    expect(body.titles.map((t) => t.id)).not.toContain(nezha2);
  });

  it('answers enabled: false with no titles when direct streaming is off or not built, 503 without movies', async () => {
    const off: StreamListResponse = { enabled: false, reason: 'direct_stream_off', titles: [] };
    expect((await getJson<StreamListResponse>(appFor({ enabled: false }), '/api/movies/stream')).body).toEqual(off);
    expect((await getJson<StreamListResponse>(appFor({ service: null }), '/api/movies/stream')).body).toEqual(off);
    const noMovies = await getJson<{ error: string }>(appFor({ movies: null }), '/api/movies/stream');
    expect(noMovies.status).toBe(503);
    expect(noMovies.body.error).toBe('movies_off');
  });
});

describe('GET /api/movies/:id stream_sources', () => {
  it('carries this host\'s rows only, each marked fresh or not', async () => {
    await source('movie-467905', 0, 0, HOST_OTHER, 1);
    const film = await getJson<TitleDetailResponse>(appFor(), '/api/movies/movie-467905');
    expect(film.body.stream_sources).toHaveLength(1);
    expect(film.body.stream_sources[0]).toMatchObject({ host: HOST_HERE, season: 0, episode: 0, provider: 'VidFast', fresh: true });

    const series = await getJson<TitleDetailResponse>(appFor(), '/api/movies/tv-247718');
    const byEpisode = Object.fromEntries(series.body.stream_sources.map((s) => [`${s.season}x${s.episode}`, s.fresh]));
    expect(byEpisode).toEqual({ '1x1': false, '1x3': false });
  });

  it('nothing is fresh while direct streaming is off', async () => {
    const film = await getJson<TitleDetailResponse>(appFor({ enabled: false }), '/api/movies/movie-467905');
    expect(film.body.stream_sources.map((s) => s.fresh)).toEqual([false]);
  });
});
