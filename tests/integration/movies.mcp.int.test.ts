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
    expect(res.titles[0]).toMatchObject({ state: 'finished', url: `${WALL}/movies/movie-467905` });
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
    expect(res.url).toBe(`${WALL}/movies/tv-247718`);
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
    expect(text(both)).toContain('movie-1001');
    expect(text(both)).toContain('movie-1002');
  });

  it('movies_history: plays newest first, across deleted files, and for one title', async () => {
    const all = await callJson<{ plays: Array<{ title_id: string; episode: number | null; episode_name: string | null; url: string }> }>(
      'movies_history',
      { from: '2026-11-01' },
    );
    expect(all.plays.map((p) => p.title_id)).toEqual(['tv-247718', 'tv-247718', 'movie-1002']);
    expect(all.plays[0]).toMatchObject({ episode: 2, episode_name: 'Alternative Fuel', url: `${WALL}/movies/tv-247718` });
    const mobland = await callJson<{ count: number; plays: Array<{ title_id: string }> }>('movies_history', { title: 'mobland' });
    expect(mobland.count).toBe(2);
    expect(new Set(mobland.plays.map((p) => p.title_id))).toEqual(new Set(['tv-247718']));
  });

  it('movies_continue with a title resumes the latest unfinished film from its position', async () => {
    const res = await callJson<{ action: string; position: number; url: string; message: string }>('movies_continue', { title: 'Unfinished Blumhouse Film' });
    expect(res).toMatchObject({ action: 'resumed', position: 1200, url: `${WALL}/movies/movie-1002` });
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
    expect(byId.get('movie-467905')).toMatchObject({ in_library: true, seen: true, state: 'finished', url: `${WALL}/movies/movie-467905` });
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
    expect(marked).toMatchObject({ title_id: 'tv-1003', rating: 4, url: `${WALL}/movies/tv-1003` });
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
