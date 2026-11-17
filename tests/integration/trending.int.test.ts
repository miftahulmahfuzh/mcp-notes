import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DIRECT_STREAM_CONFIG } from '../../src/config.js';
import { streamTrending } from '../../src/db/schema.js';
import { DisabledTrending, type TrendingHandle, type TrendingStatus } from '../../src/directStream/trending/job.js';
import { TrendingRepo, type TrendingEntry } from '../../src/directStream/trending/repo.js';
import { moviesApiRoutes, type TrendingListResponse } from '../../src/http/moviesApi.js';
import { buildMoviesService, type MoviesService } from '../../src/movies/service.js';
import { truncateAll } from './setup.js';
import { createApiHarness, SAME_ORIGIN, type ApiHarness } from './helpers/api-harness.js';
import { fakeTmdb, HOST_HERE, MOVIES_TEST_CONFIG } from './helpers/moviesSeed.js';
import { seedFile, seedPlay, seedTitle, truncateMovies } from './helpers/moviesPlaySeed.js';

const OTHER = 'trend-host-b';
const AT = new Date('2026-11-17T06:00:00Z');
const hash = (n: number): string => n.toString(16).padStart(40, 'c');

let h: ApiHarness;
let here: MoviesService;
let repo: TrendingRepo;
let asked = 0;

const STATUS: TrendingStatus = { enabled: true, off_reason: null, host: HOST_HERE, running: false, next_check_at: null, settings: { size: 100, probe: 200 }, last_pass: null };
const handle = (over: Partial<TrendingHandle> = {}): TrendingHandle => ({
  enabled: true,
  startLine: () => '',
  start: () => undefined,
  askPass: () => {
    asked += 1;
    return true;
  },
  status: () => STATUS,
  close: async () => undefined,
  ...over,
});

function appFor(trending: TrendingHandle | null): Hono {
  const app = new Hono();
  app.route('/', moviesApiRoutes({ ...h.deps, config: { ...h.deps.config, movies: MOVIES_TEST_CONFIG, directStream: { ...(h.deps.config.directStream ?? DEFAULT_DIRECT_STREAM_CONFIG), trending: { enabled: true, size: 100, probe: 200, skipLanguages: ['hi', 'ta', 'te', 'ml', 'kn', 'bn', 'mr', 'pa'] } } }, movies: here, directStream: {} as never, trending }));
  return app;
}

const entry = (n: number, over: Partial<TrendingEntry> = {}): TrendingEntry => ({
  titleId: `movie-${n}`,
  kind: 'movie',
  imdbId: `tt${1000000 + n}`,
  rank: n,
  seeds: 1000 - n,
  index: 'apibay',
  infoHash: hash(n),
  releaseName: `Film ${n} 2026 1080p`,
  sizeBytes: 2e9,
  probe: null,
  ...over,
});

async function read(app: Hono): Promise<TrendingListResponse> {
  const res = await app.request('/api/movies/trending');
  expect(res.status).toBe(200);
  return (await res.json()) as TrendingListResponse;
}

beforeAll(async () => {
  h = await createApiHarness();
  const built = buildMoviesService({ ...h.deps.config, movies: MOVIES_TEST_CONFIG }, h.deps.db, { host: HOST_HERE, tmdb: fakeTmdb() });
  if (built === null) throw new Error('movies service not built');
  here = built;
  repo = new TrendingRepo(h.deps.db);
});

afterAll(async () => {
  await here.close();
  await h.close();
});

beforeEach(async () => {
  asked = 0;
  await truncateAll(h.deps.db);
  await truncateMovies(h.deps.db);
  await h.deps.db.execute(sql`truncate table stream_trending`);
  for (const n of [1, 2, 3, 4, 5]) await seedTitle(h.deps.db, { id: `movie-${n}`, kind: 'movie', tmdbId: n, title: `Film ${n}`, year: 2026 });
  await seedTitle(h.deps.db, { id: 'tv-9', kind: 'tv', tmdbId: 9, title: 'Show 9', year: 2026 });
});

describe('TrendingRepo', () => {
  it('replaces this host\'s rows only, ordered by kind then rank, and keeps a probe it was given', async () => {
    await repo.replace(HOST_HERE, [entry(2), entry(1, { probe: { outcome: 'confirmed', detail: '1 video file', at: AT } }), entry(9, { titleId: 'tv-9', kind: 'tv', rank: 1 })], AT);
    await repo.replace(OTHER, [entry(3)], AT);
    expect((await repo.rows(HOST_HERE)).map((r) => [r.titleId, r.rank, r.probeOutcome])).toEqual([
      ['movie-1', 1, 'confirmed'],
      ['movie-2', 2, null],
      ['tv-9', 1, null],
    ]);
    await repo.replace(HOST_HERE, [entry(4)], new Date(AT.getTime() + 1000));
    expect((await repo.rows(HOST_HERE)).map((r) => r.titleId)).toEqual(['movie-4']);
    expect((await repo.rows(OTHER)).map((r) => r.titleId)).toEqual(['movie-3']);
    expect((await repo.listedAt(HOST_HERE))?.getTime()).toBe(AT.getTime() + 1000);
    expect(await repo.listedAt('nobody')).toBeNull();
  });

  it('writes a probe for the torrent that was listed, and leaves a row whose torrent changed alone', async () => {
    await repo.replace(HOST_HERE, [entry(1)], AT);
    await repo.recordProbe(HOST_HERE, 'movie-1', hash(77), 'confirmed', 'stale hash', AT);
    expect((await repo.rows(HOST_HERE))[0]?.probeOutcome).toBeNull();
    await repo.recordProbe(HOST_HERE, 'movie-1', hash(1), 'no_peers', 'no peer sent a file list within 20 s', AT);
    expect((await repo.rows(HOST_HERE))[0]).toMatchObject({ probeOutcome: 'no_peers', probeDetail: 'no peer sent a file list within 20 s', probedAt: AT });
  });

  it('refuses a probe outcome without its time, and a title that is not stored', async () => {
    await repo.replace(HOST_HERE, [entry(1)], AT);
    await expect(h.deps.db.update(streamTrending).set({ probeOutcome: 'confirmed' }).where(eq(streamTrending.titleId, 'movie-1'))).rejects.toThrow();
    await expect(repo.replace(HOST_HERE, [entry(1, { titleId: 'movie-404' })], AT)).rejects.toThrow();
    expect((await repo.rows(HOST_HERE)).map((r) => r.titleId)).toEqual(['movie-1']);
  });
});

describe('GET /api/movies/trending', () => {
  it('lists the titles with their seeds and what the swarm probe showed', async () => {
    await repo.replace(HOST_HERE, [entry(1, { probe: { outcome: 'confirmed', detail: '1 video file of 2, 4 peers connected', at: AT } }), entry(2)], AT);
    const body = await read(appFor(handle()));
    expect(body.enabled).toBe(true);
    expect(body.listed_at).toBe(AT.toISOString());
    expect(body.titles.map((t) => [t.id, t.trending.kind_rank, t.trending.seeds, t.trending.index, t.trending.probe?.outcome ?? null])).toEqual([
      ['movie-1', 1, 999, 'apibay', 'confirmed'],
      ['movie-2', 2, 998, 'apibay', null],
    ]);
    expect(body.titles[0]).toMatchObject({ title: 'Film 1', state: 'unwatched', not_interested: false });
  });

  it('leaves out at once a title seen, started, watched or marked not interested since the list was built', async () => {
    await repo.replace(HOST_HERE, [1, 2, 3, 4, 5].map((n) => entry(n)), AT);
    expect((await read(appFor(handle()))).titles).toHaveLength(5);
    const user = async (id: string, patch: object): Promise<Response> =>
      appFor(handle()).request(`/api/movies/${id}/user`, { method: 'POST', headers: { 'content-type': 'application/json', ...SAME_ORIGIN }, body: JSON.stringify(patch) });
    expect((await user('movie-1', { watched: true })).status).toBe(200);
    expect((await user('movie-2', { not_interested: true })).status).toBe(200);
    const file = await seedFile(h.deps.db, { titleId: 'movie-3', host: HOST_HERE, path: '/m/f3.mkv', durationS: 6000 });
    await seedPlay(h.deps.db, { fileId: file, host: HOST_HERE, positionS: 5900, durationS: 6000, startedAt: AT });
    const file4 = await seedFile(h.deps.db, { titleId: 'movie-4', host: HOST_HERE, path: '/m/f4.mkv', durationS: 6000 });
    await seedPlay(h.deps.db, { fileId: file4, host: HOST_HERE, positionS: 600, durationS: 6000, startedAt: AT });
    expect((await read(appFor(handle()))).titles.map((t) => t.id)).toEqual(['movie-5']);
    // Undoing the mark puts it back: nothing was deleted from the list.
    expect((await user('movie-2', { not_interested: false })).status).toBe(200);
    expect((await read(appFor(handle()))).titles.map((t) => t.id)).toEqual(['movie-2', 'movie-5']);
  });

  it('leaves out a title whose original language is skipped, at read time, whatever the list says', async () => {
    await repo.replace(HOST_HERE, [entry(1), entry(2)], AT);
    await h.deps.db.execute(sql`update movie_titles set original_language = 'hi' where id = 'movie-1'`);
    expect((await read(appFor(handle()))).titles.map((t) => t.id)).toEqual(['movie-2']);
  });

  it('leaves out a title of unknown language whose release names only a skipped one (Telugu)', async () => {
    await repo.replace(HOST_HERE, [entry(1, { releaseName: 'Scene (2026) 1080p Telugu DVDScr x264 AAC' }), entry(2, { releaseName: 'Film 2 2026 English Hindi DUAL' })], AT);
    expect((await read(appFor(handle()))).titles.map((t) => t.id)).toEqual(['movie-2']);
  });

  it('shows this machine\'s list only', async () => {
    await repo.replace(OTHER, [entry(1)], AT);
    expect((await read(appFor(handle()))).titles).toEqual([]);
  });

  it('answers off, as a normal answer saying why, without reading the list', async () => {
    await repo.replace(HOST_HERE, [entry(1)], AT);
    expect(await read(appFor(null))).toMatchObject({ enabled: false, reason: 'setting_off', titles: [] });
    expect(await read(appFor(new DisabledTrending('torrent_off')))).toMatchObject({ enabled: false, reason: 'torrent_off', titles: [] });
  });
});

describe('POST /api/movies/trending/refresh', () => {
  const post = async (app: Hono, headers: Record<string, string> = SAME_ORIGIN): Promise<Response> => app.request('/api/movies/trending/refresh', { method: 'POST', headers });

  it('asks for one pass and answers 202 at once, with the job\'s state', async () => {
    const res = await post(appFor(handle()));
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ started: true, status: { enabled: true } });
    expect(asked).toBe(1);
  });

  it('says started false when a pass is already running, and 409 when the job is off', async () => {
    expect(await (await post(appFor(handle({ askPass: () => false })))).json()).toMatchObject({ started: false });
    const off = await post(appFor(new DisabledTrending('setting_off')));
    expect(off.status).toBe(409);
    expect(await off.json()).toMatchObject({ error: 'trending_off' });
  });

  it('is same-origin only', async () => {
    expect((await post(appFor(handle()), {})).status).toBe(403);
    expect(asked).toBe(0);
  });
});
