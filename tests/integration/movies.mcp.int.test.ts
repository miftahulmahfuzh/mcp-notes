import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MOVIE_TOOL_NAMES } from '../../src/chat/status.js';
import { mcpToolDeps } from '../../src/http/app.js';
import type { MovieToolDeps } from '../../src/mcp/movieTools.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { continueTitle, playSomething } from '../../src/movies/continue.js';
import type { MoviePlayer, PlayStarted } from '../../src/movies/player.js';
import { MoviesRepo } from '../../src/movies/repo.js';
import { resumePosition } from '../../src/movies/state.js';
import type { TmdbClient } from '../../src/movies/tmdb.js';
import { createApiHarness, type ApiHarness } from './helpers/api-harness.js';
import { clearMovies, insertPlay, seedLibrary, THIS_HOST, OTHER_HOST, type SeededLibrary } from './helpers/moviesMcpSeed.js';

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };

const WALL = 'http://localhost:7317';

/** Only searchPerson and personCredits are reached by the movie tools. */
const fakeTmdb = {
  async searchPerson(name: string) {
    return name.toLowerCase().includes('qualley')
      ? [
          { personId: 1373737, name: 'Margaret Qualley', knownFor: 'Acting', profilePath: null, popularity: 50 },
          { personId: 42, name: 'Margaret Qualls', knownFor: 'Writing', profilePath: null, popularity: 1 },
        ]
      : [];
  },
  async personCredits(personId: number) {
    if (personId !== 1373737) return [];
    return [
      { kind: 'movie', tmdbId: 467905, title: 'How to Make a Killing', releaseDate: '2026-02-20', credit: 'cast', character: 'Julia', job: null },
      { kind: 'movie', tmdbId: 1002, title: 'Unfinished Blumhouse Film', releaseDate: '2025-05-01', credit: 'cast', character: 'Ann', job: null },
      { kind: 'movie', tmdbId: 9001, title: 'The Substance', releaseDate: '2024-09-20', credit: 'cast', character: 'Sue', job: null },
      { kind: 'movie', tmdbId: 9001, title: 'The Substance', releaseDate: '2024-09-20', credit: 'crew', character: null, job: 'Producer' },
    ];
  },
} as unknown as TmdbClient;

/** Tool urls open the wall on a movie id. */
const MOVIE_URL = /^http:\/\/localhost:7317\/movies\/M-[0-9A-Z]{4}$/;

let h: ApiHarness;
let client: Client;
let lib: SeededLibrary;
const played: number[] = [];
/** What playSomething draws; a test sets it to pin the pick. */
let nextRandom: () => number = Math.random;
const reviews: Array<{ titleId: string; text: string }> = [];

/** Records what VLC would have been asked to play and answers like MoviePlayer (resume second included); never spawns anything. */
let fakeRepo: MoviesRepo;
const fakePlayer: Pick<MoviePlayer, 'host' | 'play'> = {
  host: THIS_HOST,
  async play(fileId: number): Promise<PlayStarted> {
    const file = await fakeRepo.fileById(fileId);
    if (file === null) throw new Error(`no file ${fileId}`);
    played.push(fileId);
    const start = resumePosition(file, await fakeRepo.lastPlay(fileId));
    return { play_id: 0, file_id: fileId, title_id: file.titleId, name: file.name, start_position: start, port: 0, tracking: true, note: null };
  },
};

function text(r: ToolResult): string {
  return r.content.map((c) => c.text ?? '').join('\n');
}

async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

async function callJson<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const r = await call(name, args);
  expect(r.isError ?? false, text(r)).toBe(false);
  return JSON.parse(text(r)) as T;
}

beforeAll(async () => {
  h = await createApiHarness();
  const repo = new MoviesRepo(h.deps.db);
  fakeRepo = repo;
  const movies: MovieToolDeps = {
    host: THIS_HOST,
    imageBase: 'https://image.tmdb.org/t/p',
    tmdb: fakeTmdb,
    async setTitleUser(id, patch) {
      await repo.setTitleUser(id, patch);
    },
    async setFileWatched(fileId, watched) {
      await repo.setFileWatched(fileId, watched);
    },
    async saveReview(titleId, reviewText) {
      reviews.push({ titleId, text: reviewText });
    },
    // Phase 5's ContinueDeps: the real continue rule over the seeded rows, with a recording player.
    // Phase 5's ContinueDeps: the real continue rule over the seeded rows (seeded paths count as on disk), with a recording player.
    continueTitle: (title) => continueTitle({ db: h.deps.db, player: fakePlayer, exists: async () => true }, title),
    playSomething: () => playSomething({ db: h.deps.db, player: fakePlayer, exists: async () => true }, () => nextRandom()),
  };
  const server = createMcpServer({ ...mcpToolDeps(h.deps), movies });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: 'movies-in-process', version: '0.0.0' });
  await client.connect(clientSide);
});

afterAll(async () => {
  await client.close();
  await clearMovies(h.deps.db);
  await h.close();
});

beforeEach(async () => {
  await clearMovies(h.deps.db);
  lib = await seedLibrary(h.deps.db);
  played.length = 0;
  reviews.length = 0;
  nextRandom = Math.random;
});

interface ListBody {
  count: number;
  titles: Array<{ id: string; state: string; url: string }>;
}

describe('movie MCP tools', () => {
  it('registers the six tools and the instructions explain them', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).filter((n) => n.startsWith('movies_'));
    expect(names.sort()).toEqual([...MOVIE_TOOL_NAMES].sort());
    expect(client.getInstructions() ?? '').toContain('Movies.');
  });

  it('movies_list: the Blumhouse films finished this year', async () => {
    const res = await callJson<ListBody>('movies_list', { company: 'Blumhouse', finished_from: '2026-01-01', finished_to: '2026-12-31' });
    expect(res.titles.map((t) => t.id)).toEqual(['movie-467905']);
    expect(res.titles[0]).toMatchObject({ state: 'finished', url: expect.stringMatching(MOVIE_URL) });
  });

  it('movies_list by person, words, kind and state', async () => {
    const byPerson = await callJson<ListBody>('movies_list', { person: 'Margaret Qualley' });
    expect(byPerson.titles.map((t) => t.id)).toEqual(['movie-467905']);
    const byWords = await callJson<ListBody>('movies_list', { q: 'mobland' });
    expect(byWords.titles.map((t) => t.id)).toEqual(['tv-247718']);
    const series = await callJson<ListBody>('movies_list', { kind: 'tv' });
    expect(series.titles.map((t) => t.id).sort()).toEqual(['tv-1003', 'tv-1004', 'tv-247718']);
    const inProgress = await callJson<ListBody>('movies_list', { state: 'in_progress' });
    expect(inProgress.titles.map((t) => t.id)).toContain('movie-1002');
    expect(inProgress.titles.map((t) => t.id)).not.toContain('movie-467905');
  });

  it('movies_get: which MobLand episode was watched last and when, with the deleted files', async () => {
    const res = await callJson<{
      id: string;
      url: string;
      last_play: { season: number; episode: number; episode_name: string; started_at: string; position_s: number };
      seasons: Array<{ season: number; episodes: Array<{ season: number; episode: number; name: string }> }>;
      files: Array<{ id: number; deleted_at: string | null; available: boolean }>;
      plays: Array<{ started_at: string }>;
    }>('movies_get', { title: 'mobland' });
    expect(res.id).toBe('tv-247718');
    expect(res.url).toMatch(MOVIE_URL);
    expect(res.last_play).toMatchObject({ season: 1, episode: 2, episode_name: 'Alternative Fuel', position_s: 1300 });
    expect(new Date(res.last_play.started_at).toISOString()).toBe('2026-11-12T13:00:00.000Z');
    expect(res.seasons.flatMap((x) => x.episodes).map((e) => e.name)).toEqual(['Stick or Twist', 'Alternative Fuel', 'Sweet Home']);
    expect(res.files).toHaveLength(3);
    const deleted = res.files.filter((f) => f.deleted_at !== null).map((f) => f.id).sort((a, b) => a - b);
    expect(deleted).toEqual([lib.files.moblandE1, lib.files.moblandE2].sort((a, b) => a - b));
    expect(res.plays).toHaveLength(2);
    expect(Date.parse(res.plays[0]!.started_at)).toBeGreaterThan(Date.parse(res.plays[1]!.started_at));
  });

  it('movies_get by id: a file on the other laptop is available: false', async () => {
    const res = await callJson<{ files: Array<{ host: string; available: boolean }> }>('movies_get', { title: 'MOVIE-1005' });
    expect(res.files).toEqual([expect.objectContaining({ host: OTHER_HOST, available: false })]);
  });

  it('movies_get with an unknown or an ambiguous name', async () => {
    const none = await call('movies_get', { title: 'no such film anywhere' });
    expect(none.isError).toBe(true);
    expect(text(none)).toMatch(/^not_found: /);
    const both = await call('movies_get', { title: 'blumhouse film' });
    expect(both.isError).toBe(true);
    expect(text(both)).toMatch(/^ambiguous: /);
    // The candidates are named by the id the owner would type back.
    expect(text(both)).toMatch(/Old Blumhouse Film \(2024\) = M-[0-9A-Z]{4}/);
    expect(text(both)).toMatch(/Unfinished Blumhouse Film \(2025\) = M-[0-9A-Z]{4}/);
  });

  it('movies_history: plays newest first, across deleted files, and for one title', async () => {
    const all = await callJson<{ plays: Array<{ title_id: string; episode: number | null; episode_name: string | null; url: string }> }>(
      'movies_history',
      { from: '2026-11-01' },
    );
    expect(all.plays.map((p) => p.title_id)).toEqual(['tv-247718', 'tv-247718', 'movie-1002']);
    expect(all.plays[0]).toMatchObject({ episode: 2, episode_name: 'Alternative Fuel', url: expect.stringMatching(MOVIE_URL) });
    const mobland = await callJson<{ count: number; plays: Array<{ title_id: string }> }>('movies_history', { title: 'mobland' });
    expect(mobland.count).toBe(2);
    expect(new Set(mobland.plays.map((p) => p.title_id))).toEqual(new Set(['tv-247718']));
  });

  it('movies_continue with a title resumes the latest unfinished film from its position', async () => {
    const res = await callJson<{ action: string; position: number; url: string; message: string }>('movies_continue', { title: 'Unfinished Blumhouse Film' });
    expect(res).toMatchObject({ action: 'resumed', position: 1200, url: expect.stringMatching(MOVIE_URL) });
    expect(played).toEqual([lib.files.unfinished]);
  });

  it('movies_continue starts the next episode whose file is present', async () => {
    const res = await callJson<{ action: string }>('movies_continue', { title: 'Series Next' });
    expect(res.action).toBe('started');
    expect(played).toEqual([lib.files.nextE2]);
  });

  it('movies_continue says which next episode is missing and which later ones are present, and plays nothing', async () => {
    const res = await callJson<{
      action: string;
      missing: { season: number; episode: number };
      present: Array<{ season: number; episode: number }>;
    }>('movies_continue', { title: 'Series Gap' });
    expect(res.action).toBe('missing');
    expect(res.missing).toMatchObject({ season: 1, episode: 2 });
    expect(res.present.map((p) => p.episode)).toEqual([3]);
    expect(played).toEqual([]);
  });

  it('movies_continue without a title continues the title of the newest play event', async () => {
    await insertPlay(h.deps.db, lib.files.unfinished, '2026-11-13T14:00:00Z', '2026-11-13T14:10:00Z', 1500, 6000);
    const res = await callJson<{ action: string; title: { id: string }; position: number }>('movies_continue', {});
    expect(res).toMatchObject({ action: 'resumed', title: { id: 'movie-1002' }, position: 1500 });
    expect(played).toEqual([lib.files.unfinished]);
  });

  // Playable here: movie-1002 (half watched), tv-1003 (E2 next), tv-247718 (E3 next). Not: the finished
  // and watched films, the deleted file, Series Gap (its next episode has no file), the other laptop's film.
  it('movies_continue random picks only among titles that can be played here, and resumes a half-watched one', async () => {
    type Pick = { action: string; title: { id: string }; position: number; picked_from: number; message: string };
    nextRandom = () => 0;
    const first = await callJson<Pick>('movies_continue', { random: true });
    expect(first).toMatchObject({ action: 'resumed', title: { id: 'movie-1002' }, position: 1200, picked_from: 3 });
    expect(first.message).toContain('Picked at random among 3 playable titles');
    nextRandom = () => 0.999;
    const last = await callJson<Pick>('movies_continue', { random: true });
    expect(last).toMatchObject({ action: 'started', title: { id: 'tv-247718' }, picked_from: 3 });
    expect(played).toEqual([lib.files.unfinished, lib.files.moblandE3]);

    played.length = 0;
    nextRandom = Math.random;
    for (let i = 0; i < 25; i++) await callJson<Pick>('movies_continue', { random: true });
    const allowed = new Set([lib.files.unfinished, lib.files.nextE2, lib.files.moblandE3]);
    expect(played.every((id) => allowed.has(id))).toBe(true);
    expect(new Set(played).size).toBeGreaterThan(1);
  });

  it('movies_continue random plays nothing when nothing here is left to watch, and refuses a title with it', async () => {
    await h.deps.db.execute(sql`update movie_files set deleted_at = now() where host = ${THIS_HOST}`);
    const none = await callJson<{ action: string; picked_from: number; message: string }>('movies_continue', { random: true });
    expect(none).toMatchObject({ action: 'no_match', picked_from: 0 });
    expect(none.message).toContain('Nothing was played');
    expect(played).toEqual([]);
    const both = await call('movies_continue', { random: true, title: 'mobland' });
    expect(both.isError).toBe(true);
    expect(text(both)).toContain('invalid_input');
  });

  describe('movie ids', () => {
    const idOf = async (titleId: string, season: number | null = null, episode: number | null = null): Promise<string> => {
      const res = await h.deps.db.execute(
        sql`select id from movie_ids where title_id = ${titleId} and season is not distinct from ${season} and episode is not distinct from ${episode}`,
      );
      return String((res.rows[0] as { id: string }).id);
    };

    it('every title and every episode has one M-XXXX id, all different, and a file-only episode gets one too', async () => {
      const res = await h.deps.db.execute(sql`select id, title_id, season, episode from movie_ids`);
      const rows = res.rows as Array<{ id: string; title_id: string; season: number | null; episode: number | null }>;
      expect(rows.filter((r) => r.season === null)).toHaveLength(7); // the seven seeded titles
      expect(rows.filter((r) => r.season !== null)).toHaveLength(8); // every movie_episodes row
      for (const r of rows) expect(r.id).toMatch(/^M-[0-9A-Z]{4}$/);
      expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
      // An episode TMDB does not list, named only by a file.
      await h.deps.db.execute(sql`
        insert into movie_files (title_id, host, path, name, size, duration_s, season, episode, status, source, first_seen_at, last_seen_at, updated_at)
        values ('tv-1003', ${THIS_HOST}, '/library/Series.Next.S01E09.mkv', 'Series.Next.S01E09.mkv', 1, 3000, 1, 9, 'matched', 'scan', now(), now(), now())`);
      expect(await idOf('tv-1003', 1, 9)).toMatch(/^M-[0-9A-Z]{4}$/);
    });

    it('an episode keeps its id when its rows are deleted and inserted again (a metadata refresh)', async () => {
      const before = await idOf('tv-247718', 1, 3);
      await h.deps.db.execute(sql`delete from movie_episodes where title_id = 'tv-247718'`);
      await h.deps.db.execute(sql`insert into movie_episodes (title_id, season, episode, name) values ('tv-247718', 1, 3, 'Sweet Home'), ('tv-247718', 1, 4, 'New One')`);
      expect(await idOf('tv-247718', 1, 3)).toBe(before);
      expect(await idOf('tv-247718', 1, 4)).not.toBe(before);
    });

    it('movies_list and movies_get carry movie_id, and movies_get takes one in any case', async () => {
      const id = await idOf('movie-467905');
      const list = await callJson<{ titles: Array<{ id: string; movie_id: string }> }>('movies_list', { q: 'killing' });
      expect(list.titles[0]).toMatchObject({ id: 'movie-467905', movie_id: id });
      const got = await callJson<{ id: string; movie_id: string; asked?: unknown }>('movies_get', { title: id.toLowerCase() });
      expect(got).toMatchObject({ id: 'movie-467905', movie_id: id });
      expect(got.asked).toBeUndefined();
      const unknown = await call('movies_get', { title: 'M-ZZZZ' });
      expect(unknown.isError).toBe(true);
      expect(text(unknown)).toContain('not_found');
    });

    it("an episode's movie id answers with that episode first, also when it has no file", async () => {
      const gap = await idOf('tv-1004', 1, 2);
      const res = await callJson<{
        id: string;
        asked: { movie_id: string; what: string; episode: { season: number; episode: number; name: string; has_file: boolean; movie_id: string } };
        seasons: Array<{ season: number; episodes: number; files_here: string }>;
        files: unknown[];
        url: string;
      }>('movies_get', { title: gap });
      expect(res.id).toBe('tv-1004');
      expect(res.asked).toMatchObject({ movie_id: gap, what: 'episode S01E02 of Series Gap', episode: { season: 1, episode: 2, name: 'Gap Two', has_file: false, movie_id: gap } });
      // The series around it is a summary: the gap shows in files_here.
      expect(res.seasons).toEqual([{ season: 1, episodes: 3, first_episode: 1, last_episode: 3, finished: 1, files_here: '3' }]);
      expect(res.files).toEqual([]);
      expect(res.url).toBe(`${WALL}/movies/${gap}`);
    });

    it('movies_get with season or episode answers just those episodes, each with its movie id', async () => {
      const one = await callJson<{ seasons: Array<{ episodes: Array<{ episode: number; movie_id: string; overview?: unknown; files?: unknown }> }>; files: Array<{ episode: number }> }>(
        'movies_get',
        { title: 'Series Gap', episode: 3 },
      );
      expect(one.seasons).toHaveLength(1);
      expect(one.seasons[0]!.episodes).toHaveLength(1);
      expect(one.seasons[0]!.episodes[0]).toMatchObject({ episode: 3, movie_id: await idOf('tv-1004', 1, 3) });
      expect(one.seasons[0]!.episodes[0]).toHaveProperty('overview');
      expect(one.seasons[0]!.episodes[0]).not.toHaveProperty('files');
      expect(one.files.map((f) => f.episode)).toEqual([3]);
      const season = await callJson<{ seasons: Array<{ episodes: unknown[] }> }>('movies_get', { title: 'Series Gap', season: 1 });
      expect(season.seasons[0]!.episodes).toHaveLength(3);
    });

    it('a long series answers with a summary per season that fits in a reply', async () => {
      await h.deps.db.execute(sql`
        insert into movie_episodes (title_id, season, episode, name, overview)
        select 'tv-1003', 2, n, 'Long ' || n, repeat('synopsis ', 40) from generate_series(1, 400) n`);
      await h.deps.db.execute(sql`
        insert into movie_files (title_id, host, path, name, size, duration_s, season, episode, status, source, first_seen_at, last_seen_at, updated_at)
        select 'tv-1003', ${THIS_HOST}, '/library/Long.' || n || '.mkv', 'Long.' || n || '.mkv', 1, 1400, 2, n, 'matched', 'scan', now(), now(), now()
        from unnest(array[10, 11, 12, 20]) n`);
      const r = await call('movies_get', { title: 'Series Next' });
      expect(r.isError ?? false).toBe(false);
      expect(text(r).length).toBeLessThan(20_000);
      const body = JSON.parse(text(r)) as { seasons: Array<{ season: number; episodes: number; files_here: string }>; seasons_note: string };
      expect(body.seasons[1]).toMatchObject({ season: 2, episodes: 400, first_episode: 1, last_episode: 400, files_here: '10-12, 20' });
      expect(body.seasons_note).toContain('season');
      const ep = await callJson<{ seasons: Array<{ episodes: Array<{ name: string; movie_id: string }> }> }>('movies_get', { title: 'Series Next', season: 2, episode: 250 });
      expect(ep.seasons[0]!.episodes[0]).toMatchObject({ name: 'Long 250', movie_id: await idOf('tv-1003', 2, 250) });
    });

    it("movies_continue with an episode's movie id plays that episode, or says it is missing", async () => {
      const e3 = await idOf('tv-1004', 1, 3); // the continue rule would stop at the missing E2
      const res = await callJson<{ action: string; file: { episode: number } }>('movies_continue', { title: e3 });
      expect(res).toMatchObject({ action: 'started', file: { episode: 3 } });
      expect(played).toEqual([lib.files.gapE3]);
      const missing = await callJson<{ action: string; missing: { season: number; episode: number } }>('movies_continue', { title: await idOf('tv-1004', 1, 2) });
      expect(missing).toMatchObject({ action: 'missing', missing: { season: 1, episode: 2 } });
      expect(played).toEqual([lib.files.gapE3]);
      const film = await callJson<{ action: string; position: number }>('movies_continue', { title: await idOf('movie-1002') });
      expect(film).toMatchObject({ action: 'resumed', position: 1200 });
    });

    it("movies_mark with an episode's movie id marks that episode, never the series", async () => {
      const e2 = await idOf('tv-1003', 1, 2);
      const res = await callJson<{ title_id: string; episode: { state: string } }>('movies_mark', { title: e2, watched: true });
      expect(res).toMatchObject({ title_id: 'tv-1003', episode: { state: 'finished' } });
      const title = await h.deps.db.execute(sql`select watched_at from movie_titles where id = 'tv-1003'`);
      expect((title.rows[0] as { watched_at: unknown }).watched_at).toBeNull();
      const rated = await call('movies_mark', { title: e2, rating: 4 });
      expect(rated.isError).toBe(true);
      expect(text(rated)).toContain('invalid_input');
    });

    it('movies_history names the episode that was played by its movie id', async () => {
      const res = await callJson<{ plays: Array<{ title_id: string; season: number | null; movie_id: string }> }>('movies_history', { limit: 50 });
      const mobland = res.plays.find((p) => p.title_id === 'tv-247718' && p.season === 1);
      expect(mobland?.movie_id).toBe(await idOf('tv-247718', 1, 2));
      const film = res.plays.find((p) => p.title_id === 'movie-1002');
      expect(film?.movie_id).toBe(await idOf('movie-1002'));
    });
  });

  it('movies_person marks each TMDB credit seen or not seen against the library', async () => {
    const res = await callJson<{
      person: { id: number; name: string };
      other_people: Array<{ id: number }>;
      counts: { credits: number; in_library: number; seen: number };
      credits: Array<{ title_id: string; in_library: boolean; seen: boolean; started: boolean; state: string | null; roles: string[]; url: string | null }>;
    }>('movies_person', { name: 'Margaret Qualley' });
    expect(res.person).toMatchObject({ id: 1373737, name: 'Margaret Qualley' });
    expect(res.other_people.map((p) => p.id)).toEqual([42]);
    expect(res.counts).toEqual({ credits: 3, in_library: 2, seen: 1 });
    const byId = new Map(res.credits.map((c) => [c.title_id, c]));
    expect(byId.get('movie-467905')).toMatchObject({ in_library: true, seen: true, state: 'finished', url: expect.stringMatching(MOVIE_URL) });
    expect(byId.get('movie-1002')).toMatchObject({ in_library: true, seen: false, started: true });
    expect(byId.get('movie-9001')).toMatchObject({ in_library: false, seen: false, state: null, url: null });
    expect(byId.get('movie-9001')!.roles).toEqual(['cast as Sue', 'Producer']);
    expect(res.credits.map((c) => c.title_id)).toEqual(['movie-467905', 'movie-1002', 'movie-9001']);

    const unseen = await callJson<{ credits: Array<{ title_id: string }> }>('movies_person', { name: 'Margaret Qualley', unseen_only: true });
    expect(unseen.credits.map((c) => c.title_id)).toEqual(['movie-1002', 'movie-9001']);
    const crew = await callJson<{ credits: Array<{ title_id: string }> }>('movies_person', { name: 'Margaret Qualley', role: 'crew' });
    expect(crew.credits.map((c) => c.title_id)).toEqual(['movie-9001']);
  });

  it('movies_mark stores watched and rating on a title, watched on a file, and hands the review on', async () => {
    const marked = await callJson<{ title_id: string; rating: number; watched_at: string | null; url: string }>('movies_mark', {
      title: 'tv-1003',
      watched: true,
      rating: 4,
    });
    expect(marked).toMatchObject({ title_id: 'tv-1003', rating: 4, url: expect.stringMatching(MOVIE_URL) });
    expect(marked.watched_at).not.toBeNull();
    const titleRow = await h.deps.db.execute(sql`select rating, watched_at from movie_titles where id = 'tv-1003'`);
    expect(titleRow.rows[0]).toMatchObject({ rating: 4 });
    expect((titleRow.rows[0] as { watched_at: unknown }).watched_at).not.toBeNull();

    const file = await callJson<{ file: { id: number; watched_at: string | null } }>('movies_mark', { file_id: lib.files.gapE3, watched: true });
    expect(file.file.id).toBe(lib.files.gapE3);
    const fileRow = await h.deps.db.execute(sql`select watched_at from movie_files where id = ${lib.files.gapE3}`);
    expect((fileRow.rows[0] as { watched_at: unknown }).watched_at).not.toBeNull();

    await callJson('movies_mark', { title: 'Series Next', review: 'Great pilot.' });
    expect(reviews).toEqual([{ titleId: 'tv-1003', text: 'Great pilot.' }]);

    const cleared = await callJson<{ rating: number | null }>('movies_mark', { title: 'tv-1003', rating: null });
    expect(cleared.rating).toBeNull();
  });
});
