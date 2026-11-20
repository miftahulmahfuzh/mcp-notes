import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { MoviesRepo } from '../../src/movies/repo.js';
import { closeTestDb, openTestDb, truncateAll } from './setup.js';

let db: Db;
let repo: MoviesRepo;
const T0 = new Date('2026-11-20T12:00:00Z');
const T1 = new Date('2026-11-20T13:00:00Z');

async function pgCode(statement: Promise<unknown>): Promise<string | undefined> {
  try {
    await statement;
  } catch (err) {
    let cur: unknown = err;
    while (cur && typeof cur === 'object') {
      const e = cur as { code?: unknown; cause?: unknown };
      if (typeof e.code === 'string') return e.code;
      cur = e.cause;
    }
    return undefined;
  }
  throw new Error('expected the statement to fail');
}

beforeAll(() => {
  db = openTestDb();
  repo = new MoviesRepo(db);
});
afterAll(async () => {
  await closeTestDb(db);
});
beforeEach(async () => {
  await truncateAll(db);
  await db.execute(sql`insert into movie_titles (id, kind, tmdb_id, title, original_title) values ('tv-247718', 'tv', 247718, 'MobLand', 'MobLand'), ('movie-550', 'movie', 550, 'Fight Club', 'Fight Club')`);
});

describe('movie_stories (MoviesRepo.story, saveStory, storySlots)', () => {
  it('keeps a film\'s, an episode\'s and a season\'s story, and answers each from the store', async () => {
    const episode = await repo.saveStory({ titleId: 'tv-247718', season: 1, episode: 2, text: 'He fixes it.', origin: 'dialogue', model: 'sonnet', writtenAt: T0 });
    expect(episode).toMatchObject({ sections: [], sources: [], origin: 'dialogue' });
    await repo.saveStory({
      titleId: 'tv-247718', season: 1, episode: 0, text: 'The season.', origin: 'web', model: 'sonnet', writtenAt: T0,
      sections: [{ episode: 1, name: 'Pilot', text: 'It starts.', found: true }, { episode: 2, name: null, text: '', found: false }],
      sources: [{ url: 'https://en.wikipedia.org/wiki/MobLand', title: 'MobLand', site: 'Wikipedia' }],
    });
    await repo.saveStory({ titleId: 'movie-550', season: 0, episode: 0, text: 'A film.', origin: 'dialogue', model: null, writtenAt: T0 });
    expect(await repo.story('tv-247718', 1, 2)).toEqual({ titleId: 'tv-247718', season: 1, episode: 2, text: 'He fixes it.', sections: [], sources: [], origin: 'dialogue', model: 'sonnet', writtenAt: T0 });
    expect((await repo.story('tv-247718', 1, 0))?.sections).toHaveLength(2);
    expect(await repo.story('tv-247718', 1, 3)).toBeNull();
    expect(await repo.storySlots('tv-247718')).toEqual([{ season: 1, episode: 0 }, { season: 1, episode: 2 }]);
  });

  it('replaces the story of a slot when it is written again, and goes with its title', async () => {
    await repo.saveStory({ titleId: 'tv-247718', season: 1, episode: 2, text: 'First.', origin: 'dialogue', model: 'haiku', writtenAt: T0 });
    await repo.saveStory({ titleId: 'tv-247718', season: 1, episode: 2, text: 'Second.', origin: 'web', model: 'sonnet', writtenAt: T1, sources: [{ url: 'https://x.example/r', title: 'Recap', site: 'X' }] });
    expect(await repo.story('tv-247718', 1, 2)).toMatchObject({ text: 'Second.', origin: 'web', model: 'sonnet', writtenAt: T1, sources: [{ site: 'X' }] });
    await db.execute(sql`delete from movie_titles where id = 'tv-247718'`);
    expect(await repo.story('tv-247718', 1, 2)).toBeNull();
  });

  it('refuses an unknown title, origin or slot', async () => {
    expect(await pgCode(repo.saveStory({ titleId: 'tv-1', season: 1, episode: 1, text: 'x', origin: 'web', model: null, writtenAt: T0 }))).toBe('23503');
    expect(await pgCode(db.execute(sql`insert into movie_stories (title_id, season, episode, text, origin, written_at) values ('tv-247718', 1, 1, 'x', 'guess', now())`))).toBe('23514');
    expect(await pgCode(db.execute(sql`insert into movie_stories (title_id, season, episode, text, origin, written_at) values ('tv-247718', -1, 1, 'x', 'web', now())`))).toBe('23514');
  });
});
