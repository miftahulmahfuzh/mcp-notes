import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { moviesApiRoutes } from '../../src/http/moviesApi.js';
import type { FileChangeResponse, MoviesStatusResponse, SyncResponse, TitleListResponse, TmdbSearchResponse, UnmatchedResponse } from '../../src/http/moviesApi.js';
import type { TitleDetail } from '../../src/movies/read.js';
import { buildMoviesService, type MoviesService } from '../../src/movies/service.js';
import { truncateAll } from './setup.js';
import { createApiHarness, SAME_ORIGIN, type ApiHarness } from './helpers/api-harness.js';
import {
  fakeTmdb,
  HOST_HERE,
  HOST_OTHER,
  IMAGE_BASE,
  MOVIES_TEST_CONFIG,
  NEZHA2_TMDB_ID,
  seedLibrary,
  truncateMovies,
  type SeededLibrary,
} from './helpers/moviesSeed.js';
import { parseSse, readUntil, waitFor } from './helpers/sse.js';

let h: ApiHarness;
let here: MoviesService;
let elsewhere: MoviesService;

/** phase 3's factory takes the whole Config; null only with NOTESD_MOVIES=off, which MOVIES_TEST_CONFIG is not. */
function serviceFor(host: string): MoviesService {
  const built = buildMoviesService({ ...h.deps.config, movies: MOVIES_TEST_CONFIG }, h.deps.db, { host, tmdb: fakeTmdb() });
  if (built === null) throw new Error('movies service not built');
  return built;
}
let lib: SeededLibrary;

function appFor(movies: MoviesService | null): Hono {
  const app = new Hono();
  app.route(
    '/',
    moviesApiRoutes({ ...h.deps, config: { ...h.deps.config, movies: MOVIES_TEST_CONFIG }, movies }, { sseHeartbeatMs: 50 }),
  );
  return app;
}

async function getJson<T>(app: Hono, path: string): Promise<{ status: number; body: T }> {
  const res = await app.request(path);
  return { status: res.status, body: (await res.json()) as T };
}

async function post(app: Hono, path: string, payload: unknown, headers: Record<string, string> = SAME_ORIGIN): Promise<Response> {
  return app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload) });
}

beforeAll(async () => {
  h = await createApiHarness();
  here = serviceFor(HOST_HERE);
  elsewhere = serviceFor('host-c');
});

afterAll(async () => {
  await here.close();
  await elsewhere.close();
  await h.close();
});

beforeEach(async () => {
  await truncateAll(h.deps.db);
  await truncateMovies(h.deps.db);
  lib = await seedLibrary(h.deps.db);
});

describe('GET /api/movies (the grid)', () => {
  it('lists every title with state, progress, poster_url and present_here, most recently played first', async () => {
    const { status, body } = await getJson<TitleListResponse>(appFor(here), '/api/movies');
    expect(status).toBe(200);
    expect(body.titles.map((t) => t.id)).toEqual(['tv-247718', 'movie-467905']);
    const [mob, killing] = body.titles;
    expect(killing).toMatchObject({
      kind: 'movie', title: 'How to Make a Killing', year: 2026, state: 'in_progress', watched: false, rating: null,
      poster_url: `${IMAGE_BASE}/w342/kill.jpg`, present_here: true, file_count: 2, deleted_file_count: 0,
      last_played_at: '2026-11-10T13:00:00.000Z',
      progress: { kind: 'movie', position_s: 3000, duration_s: 6000, ratio: 0.5 },
    });
    expect(mob).toMatchObject({
      kind: 'tv', poster_url: `${IMAGE_BASE}/w342/mob.jpg`, present_here: true, file_count: 1, deleted_file_count: 1,
      progress: { kind: 'tv', episodes_finished: 1, episodes_total: 3, episodes_present: 1 },
      finished_at: '2026-11-11T14:00:00.000Z',
    });
  });

  it('filters by kind, text, company, person, state and finished range', async () => {
    const app = appFor(here);
    const ids = async (qs: string): Promise<string[]> => (await getJson<TitleListResponse>(app, `/api/movies?${qs}`)).body.titles.map((t) => t.id);
    expect(await ids('kind=tv')).toEqual(['tv-247718']);
    expect(await ids('q=mobland')).toEqual(['tv-247718']);
    expect(await ids('company=blumhouse')).toEqual(['movie-467905']);
    expect(await ids('company=3172')).toEqual(['movie-467905']);
    expect(await ids('person=qualley')).toEqual(['movie-467905']);
    expect(await ids('finished_from=2026-11-11T00:00:00Z&finished_to=2026-11-11T23:59:59Z')).toEqual(['tv-247718']);
    expect(await ids('sort=title')).toEqual(['movie-467905', 'tv-247718']);
    expect(await ids('q=')).toHaveLength(2);
  });

  it('rejects a bad filter with 400', async () => {
    expect((await appFor(here).request('/api/movies?state=bogus')).status).toBe(400);
    expect((await appFor(here).request('/api/movies?finished_from=yesterday')).status).toBe(400);
  });

  it('R2.4: a host that holds none of the files gets the same absolute TMDB poster URLs', async () => {
    const list = await getJson<TitleListResponse>(appFor(elsewhere), '/api/movies');
    const killing = list.body.titles.find((t) => t.id === 'movie-467905');
    expect(killing?.poster_url).toBe('https://image.tmdb.org/t/p/w342/kill.jpg');
    expect(killing?.present_here).toBe(false);
    const detail = await getJson<TitleDetail>(appFor(elsewhere), '/api/movies/movie-467905');
    expect(detail.body.poster_url).toBe('https://image.tmdb.org/t/p/w500/kill.jpg');
    expect(detail.body.files.every((f) => !f.available && f.unavailable_reason === 'not_on_this_machine')).toBe(true);
  });
});

describe('GET /api/movies/:id (detail)', () => {
  it('R3.7: a file recorded for another host is available: false, this host\'s file is available', async () => {
    const { status, body } = await getJson<TitleDetail>(appFor(here), '/api/movies/movie-467905');
    expect(status).toBe(200);
    const mine = body.files.find((f) => f.id === lib.killingHere);
    const theirs = body.files.find((f) => f.id === lib.killingOther);
    expect(mine).toMatchObject({ host: HOST_HERE, available: true, unavailable_reason: null, state: 'in_progress', resume_position_s: 3000 });
    expect(theirs).toMatchObject({ host: HOST_OTHER, available: false, unavailable_reason: 'not_on_this_machine', deleted: false });
  });

  it('carries metadata, studios, crew and cast with character names', async () => {
    const { body } = await getJson<TitleDetail>(appFor(here), '/api/movies/movie-467905');
    expect(body).toMatchObject({ release_date: '2026-02-20', runtime_min: 100, genres: ['Drama'], review: '', review_note_id: null, seasons: [] });
    expect(body.companies).toEqual([{ id: 3172, name: 'Blumhouse Productions', logo_url: `${IMAGE_BASE}/w92/blum.png`, origin_country: 'US' }]);
    expect(body.directors.map((p) => p.name)).toEqual(['John Patton Ford']);
    expect(body.writers).toEqual([{ person_id: 1, name: 'John Patton Ford', profile_url: null, job: 'Screenplay' }]);
    expect(body.cast.map((p) => [p.name, p.character])).toEqual([['Glen Powell', 'Becket'], ['Margaret Qualley', 'Julia']]);
    expect(body.plays.map((p) => p.file_id)).toEqual([lib.killingHere]);
  });

  it('a series has one entry per episode with its own state, progress and deleted flag', async () => {
    const { body } = await getJson<TitleDetail>(appFor(here), '/api/movies/tv-247718');
    expect(body.seasons).toHaveLength(1);
    const eps = body.seasons[0]?.episodes ?? [];
    expect(eps.map((e) => [e.episode, e.name, e.state, e.deleted, e.has_file, e.present_here])).toEqual([
      [1, 'Stick or Twist', 'finished', true, true, false],
      [2, 'Episode Two', 'in_progress', false, true, true],
      [3, 'Episode Three', 'unwatched', false, false, false],
    ]);
    expect(eps[0]?.still_url).toBe(`${IMAGE_BASE}/w300/e1.jpg`);
    expect(eps[1]?.file_id).toBe(lib.mobE2);
    expect(eps[1]?.progress.ratio).toBeCloseTo(0.2);
  });

  it('answers 400 for a malformed id, 404 for an unknown one, and leaves other /api/movies/* paths to other routers', async () => {
    const app = appFor(here);
    // Mounted after the movies router, like phase 5's. Hono freezes its routes at the first request, so it goes first here.
    app.get('/api/movies/player', (c) => c.json({ owner: 'phase 5' }));
    expect((await app.request('/api/movies/movie-0')).status).toBe(400);
    expect((await app.request('/api/movies/movie-999')).status).toBe(404);
    const player = await getJson<{ owner: string }>(app, '/api/movies/player');
    expect(player).toEqual({ status: 200, body: { owner: 'phase 5' } });
  });
});

describe('POST /api/movies/:id/user (R3.6)', () => {
  it('stores watched and rating on the title and the review as a #movie note linked to it', async () => {
    const app = appFor(here);
    const res = await post(app, '/api/movies/movie-467905/user', { watched: true, rating: 4, review: 'Great twist.' });
    expect(res.status).toBe(200);
    const detail = (await res.json()) as TitleDetail;
    expect(detail).toMatchObject({ watched: true, rating: 4, state: 'finished', review: 'Great twist.' });
    expect(detail.review_note_id).not.toBeNull();
    const note = await h.notes.getOne(detail.review_note_id ?? '');
    expect(note?.tags).toEqual(['movie']);
    expect(note?.body).toContain('Review of How to Make a Killing (2026)');
    expect(note?.body).toContain('Great twist.');

    const edited = (await (await post(app, '/api/movies/movie-467905/user', { review: 'Even better twice.' })).json()) as TitleDetail;
    expect(edited.review_note_id).toBe(detail.review_note_id);
    expect(edited.review).toBe('Even better twice.');
    expect((await h.notes.revisions(detail.review_note_id ?? '')).length).toBeGreaterThanOrEqual(1);

    const cleared = (await (await post(app, '/api/movies/movie-467905/user', { review: '', rating: null, watched: false })).json()) as TitleDetail;
    expect(cleared).toMatchObject({ review: '', review_note_id: detail.review_note_id, rating: null, watched: false });
    expect(await h.notes.getOne(detail.review_note_id ?? '')).not.toBeNull();
  });

  it('accepts rating 0, rejects 6, empty bodies, unknown keys, cross-origin calls and unknown titles', async () => {
    const app = appFor(here);
    expect((await post(app, '/api/movies/movie-467905/user', { rating: 0 })).status).toBe(200);
    expect((await post(app, '/api/movies/movie-467905/user', { rating: 6 })).status).toBe(400);
    expect((await post(app, '/api/movies/movie-467905/user', {})).status).toBe(400);
    expect((await post(app, '/api/movies/movie-467905/user', { stars: 3 })).status).toBe(400);
    expect((await post(app, '/api/movies/movie-467905/user', { rating: 3 }, {})).status).toBe(403);
    expect((await post(app, '/api/movies/movie-999/user', { rating: 3 })).status).toBe(404);
  });
});

describe('POST /api/movies/files/:fileId/watched', () => {
  it('marks one episode file finished', async () => {
    const res = await post(appFor(here), `/api/movies/files/${lib.mobE2}/watched`, { watched: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as FileChangeResponse;
    expect(body.file_id).toBe(lib.mobE2);
    expect(body.title?.seasons[0]?.episodes[1]?.state).toBe('finished');
    expect((await post(appFor(here), '/api/movies/files/999999/watched', { watched: true })).status).toBe(404);
  });
});

describe('unmatched list and manual fix (R1.5)', () => {
  it('lists this host\'s unmatched files with reason and parsed name, then assigning one moves it into the library', async () => {
    const app = appFor(here);
    const before = await getJson<UnmatchedResponse>(app, '/api/movies/unmatched');
    expect(before.body.files.map((f) => f.id)).toEqual([lib.nezha2]);
    expect(before.body.files[0]).toMatchObject({
      reason: 'no_match', status: 'unmatched', available: true,
      parsed: { title: 'Ne Zha 2', year: 2025, season: null, episode: null, absolute_episode: null, kind_hint: 'movie' },
    });

    const search = await getJson<TmdbSearchResponse>(app, '/api/movies/search-tmdb?q=ne%20zha&kind=movie');
    expect(search.body.results.map((r) => [r.title_id, r.in_library, r.poster_url])).toEqual([
      [`movie-${NEZHA2_TMDB_ID}`, false, `${IMAGE_BASE}/w342/nezha2.jpg`],
      ['movie-467905', true, `${IMAGE_BASE}/w342/kill.jpg`],
    ]);

    const res = await post(app, `/api/movies/files/${lib.nezha2}/assign`, { kind: 'movie', tmdb_id: NEZHA2_TMDB_ID });
    expect(res.status).toBe(200);
    const body = (await res.json()) as FileChangeResponse;
    expect(body.title?.id).toBe(`movie-${NEZHA2_TMDB_ID}`);
    expect(body.title?.files.map((f) => [f.id, f.status, f.available])).toEqual([[lib.nezha2, 'matched', true]]);

    const after = await getJson<UnmatchedResponse>(app, '/api/movies/unmatched');
    expect(after.body.files).toEqual([]);
    const list = await getJson<TitleListResponse>(app, '/api/movies');
    expect(list.body.titles.map((t) => t.id)).toContain(`movie-${NEZHA2_TMDB_ID}`);
  });

  it('validates the assign body', async () => {
    const app = appFor(here);
    expect((await post(app, `/api/movies/files/${lib.nezha2}/assign`, { kind: 'movie', tmdb_id: 1, season: 1, episode: 1 })).status).toBe(400);
    expect((await post(app, `/api/movies/files/${lib.nezha2}/assign`, { kind: 'tv', tmdb_id: 1, season: 1 })).status).toBe(400);
    expect((await post(app, '/api/movies/files/999999/assign', { kind: 'movie', tmdb_id: NEZHA2_TMDB_ID })).status).toBe(404);
    expect((await post(app, `/api/movies/files/${lib.nezha2}/assign`, { kind: 'movie', tmdb_id: NEZHA2_TMDB_ID }, {})).status).toBe(403);
    expect((await app.request('/api/movies/search-tmdb')).status).toBe(400);
  });
});

describe('status, sync and the changed stream', () => {
  it('reports counts for this host', async () => {
    const { status, body } = await getJson<MoviesStatusResponse>(appFor(here), '/api/movies/status');
    expect(status).toBe(200);
    expect(body.counts).toEqual({ titles: 2, files_here: 2, unmatched_here: 1, pending_here: 0 });
  });

  it('runs a pass on POST /api/movies/sync?wait=true and answers 202 without wait', async () => {
    const waited = await post(appFor(here), '/api/movies/sync?wait=true', {});
    expect(waited.status).toBe(200);
    expect(((await waited.json()) as SyncResponse).report).not.toBeNull();
    const started = await post(appFor(here), '/api/movies/sync', {});
    expect(started.status).toBe(202);
    expect((await started.json()) as SyncResponse).toEqual({ started: true, report: null });
    expect((await post(appFor(here), '/api/movies/sync', {}, {})).status).toBe(403);
  });

  it('writes event: changed for a user write and unsubscribes on abort', async () => {
    const app = appFor(here);
    const res = await app.request('/api/movies/events');
    const reader = res.body?.getReader();
    if (reader === undefined) throw new Error('no body');
    await readUntil(reader, (t) => t.includes(': connected'));
    expect(here.events.listenerCount()).toBe(1);
    await post(app, '/api/movies/movie-467905/user', { rating: 3 });
    const text = await readUntil(reader, (t) => t.includes('event: changed'));
    expect(parseSse(text)).toContainEqual({ event: 'changed', data: { type: 'changed', reason: 'user', title_ids: ['movie-467905'], file_ids: [] } });
    await reader.cancel();
    await waitFor(() => here.events.listenerCount() === 0);
  });
});

describe('movies off', () => {
  it('answers 503 movies_off on every route', async () => {
    const app = appFor(null);
    for (const path of ['/api/movies', '/api/movies/unmatched', '/api/movies/status', '/api/movies/search-tmdb?q=x', '/api/movies/events', '/api/movies/movie-1']) {
      const res = await app.request(path);
      expect(res.status, path).toBe(503);
      expect(await res.json()).toMatchObject({ error: 'movies_off' });
    }
    for (const path of ['/api/movies/movie-1/user', '/api/movies/files/1/watched', '/api/movies/files/1/assign', '/api/movies/sync']) {
      expect((await post(app, path, {})).status, path).toBe(503);
    }
  });
});
