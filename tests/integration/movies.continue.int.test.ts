import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { moviesPlayRoutes } from '../../src/http/moviesPlayApi.js';
import { MoviePlayer } from '../../src/movies/player.js';
import { MoviesRepo } from '../../src/movies/repo.js';
import { MemVlc } from '../fixtures/movies/memVlc.js';
import { createApiHarness, SAME_ORIGIN, type ApiHarness } from './helpers/api-harness.js';
import { seedEpisodes, seedFile, seedPlay, seedTitle, truncateMovies } from './helpers/moviesPlaySeed.js';

const HOST = 'this-host';
const daysAgo = (n: number): Date => new Date(Date.now() - n * 86_400_000);

describe('POST /api/movies/continue', () => {
  let h: ApiHarness;
  let dir: string;
  let vlc: MemVlc;
  let player: MoviePlayer;
  let app: Hono;

  async function present(name: string): Promise<string> {
    const p = path.join(dir, name);
    await writeFile(p, 'x');
    return p;
  }

  async function cont(body: unknown): Promise<Record<string, unknown>> {
    const res = await app.request('/api/movies/continue', {
      method: 'POST',
      headers: { ...SAME_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  }

  /** MobLand S1: E1 finished, E2 in progress at 1000 s, E4 present and unwatched; E3 and E5 have no file. */
  async function seedMobland(): Promise<{ e2: number; e4: number }> {
    await seedTitle(h.deps.db, { id: 'tv-247718', kind: 'tv', tmdbId: 247718, title: 'MobLand', year: 2025 });
    await seedEpisodes(h.deps.db, 'tv-247718', 1, ['Stick or Twist', 'Gimme Shelter', 'Alliance', 'Funeral', 'Remorse']);
    const e1 = await seedFile(h.deps.db, { titleId: 'tv-247718', host: HOST, path: await present('MobLand.S01E01.mkv'), durationS: 3000, season: 1, episode: 1 });
    const e2 = await seedFile(h.deps.db, { titleId: 'tv-247718', host: HOST, path: await present('MobLand.S01E02.mkv'), durationS: 3000, season: 1, episode: 2 });
    const e4 = await seedFile(h.deps.db, { titleId: 'tv-247718', host: HOST, path: await present('MobLand.S01E04.mkv'), durationS: 3000, season: 1, episode: 4 });
    await seedPlay(h.deps.db, { fileId: e1, host: HOST, positionS: 2950, durationS: 3000, startedAt: daysAgo(3) });
    await seedPlay(h.deps.db, { fileId: e2, host: HOST, positionS: 1000, durationS: 3000, startedAt: daysAgo(2) });
    return { e2, e4 };
  }

  beforeAll(async () => {
    h = await createApiHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await truncateMovies(h.deps.db);
    dir = await mkdtemp(path.join(os.tmpdir(), 'movies-continue-'));
    vlc = new MemVlc();
    vlc.length = 3000;
    player = new MoviePlayer({
      repo: new MoviesRepo(h.deps.db),
      host: HOST,
      httpPort: 47318,
      pollMs: 60_000,
      detect: async () => ({ available: true, env: { vlc: '/vlc.exe', curl: '/curl.exe', wslpath: '/usr/bin/wslpath' } }),
      launcher: vlc,
      reader: vlc,
      wslpath: async (_bin, abs) => `C:\\fake\\${path.basename(abs)}`,
      readyTimeoutMs: 200,
      readyIntervalMs: 5,
      playingTimeoutMs: 50,
      log: () => {},
    });
    app = new Hono();
    app.route('/', moviesPlayRoutes({ db: h.deps.db, moviesPlayer: player }));
  });
  afterEach(async () => {
    await player.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('resumes the latest unfinished episode from its position (R6.1)', async () => {
    const { e2 } = await seedMobland();
    const out = await cont({ title: 'mobland' });
    expect(out).toMatchObject({ action: 'resumed', title: { id: 'tv-247718' }, file: { file_id: e2, season: 1, episode: 2, name: 'Gimme Shelter' }, position: 1000 });
    expect(vlc.launches).toHaveLength(1);
    expect(vlc.launches[0]!.startTime).toBe(1000);
  });

  it('names the missing next episode and the later present one, then starts it once present (R6.1)', async () => {
    const { e2, e4 } = await seedMobland();
    await seedPlay(h.deps.db, { fileId: e2, host: HOST, positionS: 2990, durationS: 3000, startedAt: daysAgo(1) });
    expect(await cont({ title: 'MobLand' })).toEqual({
      action: 'missing',
      title: { id: 'tv-247718', title: 'MobLand', kind: 'tv', year: 2025 },
      missing: { file_id: null, season: 1, episode: 3, absolute_episode: null, name: 'Alliance' },
      present: [{ file_id: e4, season: 1, episode: 4, absolute_episode: null, name: 'Funeral' }],
    });
    expect(vlc.launches).toHaveLength(0);
    const e3 = await seedFile(h.deps.db, { titleId: 'tv-247718', host: HOST, path: await present('MobLand.S01E03.mkv'), durationS: 3000, season: 1, episode: 3 });
    expect(await cont({ title: 'mobland' })).toMatchObject({ action: 'started', file: { file_id: e3, episode: 3 }, position: 0 });
  });

  it('continues the title of the newest play when no title is given (R6.2)', async () => {
    await seedMobland();
    await seedTitle(h.deps.db, { id: 'movie-555', kind: 'movie', tmdbId: 555, title: 'Runner', year: 2026 });
    const runner = await seedFile(h.deps.db, { titleId: 'movie-555', host: HOST, path: await present('Runner.2026.mkv'), durationS: 6000 });
    await seedPlay(h.deps.db, { fileId: runner, host: HOST, positionS: 1896, durationS: 6000, startedAt: daysAgo(0.5) });
    expect(await cont({})).toMatchObject({ action: 'resumed', title: { id: 'movie-555' }, position: 1896 });
    await player.close();
  });

  it('reports a finished film, an ambiguous query and no match', async () => {
    await seedTitle(h.deps.db, { id: 'movie-1', kind: 'movie', tmdbId: 1, title: 'Bad Apples', year: 2025 });
    await seedTitle(h.deps.db, { id: 'movie-2', kind: 'movie', tmdbId: 2, title: 'Bad Boys', year: 2020 });
    const apples = await seedFile(h.deps.db, { titleId: 'movie-1', host: HOST, path: await present('Bad.Apples.mkv'), durationS: 6000 });
    await seedPlay(h.deps.db, { fileId: apples, host: HOST, positionS: 5900, durationS: 6000, startedAt: daysAgo(4) });
    expect(await cont({ title: 'bad apples' })).toMatchObject({ action: 'nothing', reason: 'finished' });
    // Two matches, one played: the played one wins.
    expect(await cont({ title: 'bad' })).toMatchObject({ action: 'nothing', title: { id: 'movie-1' } });
    await seedTitle(h.deps.db, { id: 'movie-3', kind: 'movie', tmdbId: 3, title: 'Badlands', year: 1973 });
    // Badlands has no file on this host: a film that is not finished and not present is missing.
    expect(await cont({ title: 'badl' })).toMatchObject({ action: 'missing', title: { id: 'movie-3' } });
    expect(await cont({ title: 'nothing like this' })).toEqual({ action: 'no_match', query: 'nothing like this' });
  });

  it('answers ambiguous when several unplayed titles match', async () => {
    await seedTitle(h.deps.db, { id: 'movie-10', kind: 'movie', tmdbId: 10, title: 'Over Your Dead Body', year: 2026 });
    await seedTitle(h.deps.db, { id: 'movie-11', kind: 'movie', tmdbId: 11, title: 'Over the Hedge', year: 2006 });
    const out = await cont({ title: 'over' });
    expect(out).toMatchObject({ action: 'ambiguous', query: 'over' });
    expect((out.candidates as unknown[]).length).toBe(2);
  });
});
