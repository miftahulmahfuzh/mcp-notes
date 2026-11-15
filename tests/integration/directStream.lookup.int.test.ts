import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { dbTitleLibrary, lookupTitle, parseTitleRequest, type TitleLibrary } from '../../src/directStream/lookup.js';
import { clearMovies } from './helpers/moviesMcpSeed.js';
import { closeTestDb, openTestDb } from './setup.js';

let db: Db;
let library: TitleLibrary;

beforeAll(() => {
  db = openTestDb();
  library = dbTitleLibrary(db);
});

afterAll(async () => {
  await clearMovies(db);
  await closeTestDb(db);
});

beforeEach(async () => {
  await clearMovies(db);
  await db.execute(sql`
    insert into movie_titles (id, kind, tmdb_id, title, original_title, year, overview, genres, metadata_fetched_at, created_at, updated_at)
    values ('movie-990001', 'movie', 990001, 'The Untouchables Lookup', 'Les Intouchables Lookup', 2011, '', '[]'::jsonb, now(), now(), now()),
           ('tv-990002', 'tv', 990002, 'Lookup Series', 'Lookup Series', 2024, '', '[]'::jsonb, now(), now(), now())`);
  await db.execute(sql`
    insert into movie_episodes (title_id, season, episode, name)
    values ('tv-990002', 1, 1, 'One'), ('tv-990002', 1, 2, 'Two'), ('tv-990002', 2, 1, 'Three'), ('tv-990002', 0, 1, 'Special')`);
});

describe('dbTitleLibrary', () => {
  it('finds a stored title by its original name, with its movie id', async () => {
    const r = await lookupTitle(parseTitleRequest('les intouchables lookup', null, null), { library, tmdb: null });
    expect(r.status).toBe('one');
    if (r.status !== 'one') return;
    expect(r.candidate).toMatchObject({ kind: 'movie', tmdbId: 990001, year: 2011 });
    expect(r.candidate.movieId).toMatch(/^M-[0-9A-Z]{4}$/);
  });

  it("takes an episode's movie id as its series, season and episode", async () => {
    const rows = await db.execute(sql`select id from movie_ids where title_id = 'tv-990002' and season = 2 and episode = 1`);
    const id = (rows.rows[0] as { id: string }).id;
    const r = await lookupTitle(parseTitleRequest(id, null, null), { library, tmdb: null });
    expect(r).toMatchObject({ status: 'one', candidate: { kind: 'tv', tmdbId: 990002, title: 'Lookup Series' }, episode: { season: 2, episode: 1 } });
  });

  it('counts episodes per season from season 1 up', async () => {
    expect(await library.seasons('tv', 990002)).toEqual([{ season: 1, episodes: 2 }, { season: 2, episodes: 1 }]);
    expect(await library.seasons('movie', 990001)).toEqual([]);
  });

  it('keeps kind apart', async () => {
    expect(await library.search('lookup series', 'movie')).toEqual([]);
    expect((await library.search('lookup series', 'tv')).map((t) => t.tmdbId)).toEqual([990002]);
  });
});
