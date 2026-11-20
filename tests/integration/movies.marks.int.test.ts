import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { movieEpisodes } from '../../src/db/schema.js';
import { getTitle, listStreamTitles, listTitles } from '../../src/movies/read.js';
import { MoviesRepo } from '../../src/movies/repo.js';
import { seedTitle, truncateMovies } from './helpers/moviesPlaySeed.js';
import { closeTestDb, openTestDb } from './setup.js';

const HERE = 'marks-host-a';
const CTX = { host: HERE, imageBase: 'https://image.tmdb.org/t/p' };
const DAY = 86_400_000;
const NOW = new Date('2026-11-16T03:00:00Z');
const ago = (days: number): Date => new Date(NOW.getTime() - days * DAY);

let db: Db;
let movies: MoviesRepo;

async function source(titleId: string, verifiedAt: Date, season = 0, episode = 0): Promise<void> {
  await db.execute(sql`
    insert into movie_stream_sources (title_id, season, episode, host, provider, manifest_kind, best_height, en_subtitle, verified_at)
    values (${titleId}, ${season}, ${episode}, ${HERE}, 'VidFast', 'hls', 1080, true, ${verifiedAt})`);
}

beforeAll(() => {
  db = openTestDb();
  movies = new MoviesRepo(db);
});

afterAll(async () => {
  await closeTestDb(db);
});

beforeEach(async () => {
  await db.execute(sql`truncate table movie_stream_sources`);
  await truncateMovies(db);
  await seedTitle(db, { id: 'movie-1', kind: 'movie', tmdbId: 1, title: 'Kept' });
  await seedTitle(db, { id: 'movie-2', kind: 'movie', tmdbId: 2, title: 'Dropped' });
  await seedTitle(db, { id: 'movie-3', kind: 'movie', tmdbId: 3, title: 'Seen before' });
  await seedTitle(db, { id: 'tv-9', kind: 'tv', tmdbId: 9, title: 'Series' });
  // Two seasons TMDB lists, no file anywhere: a series known only from streams.
  await db.insert(movieEpisodes).values([
    { titleId: 'tv-9', season: 1, episode: 1, name: 'One' },
    { titleId: 'tv-9', season: 1, episode: 2, name: 'Two' },
    { titleId: 'tv-9', season: 2, episode: 1, name: 'Three' },
  ]);
});

describe('episode marks: a season finished by hand', () => {
  it('marks every episode of a season, reports what changed, and an undo of that list restores the marks as they were', async () => {
    expect(await movies.seasonEpisodes('tv-9', 1)).toEqual([
      { season: 1, episode: 1 },
      { season: 1, episode: 2 },
    ]);
    // One episode was already marked: the season call must not report it, so an undo keeps it.
    expect(await movies.setEpisodesWatched('tv-9', [{ season: 1, episode: 1 }], true, ago(3))).toEqual([{ season: 1, episode: 1 }]);
    const changed = await movies.setEpisodesWatched('tv-9', await movies.seasonEpisodes('tv-9', 1), true, ago(1));
    expect(changed).toEqual([{ season: 1, episode: 2 }]);

    let detail = await getTitle(db, 'tv-9', CTX);
    const season1 = detail?.seasons.find((s) => s.season === 1)?.episodes ?? [];
    expect(season1.map((e) => [e.episode, e.state, e.watched])).toEqual([
      [1, 'finished', true],
      [2, 'finished', true],
    ]);
    expect(detail?.state).toBe('in_progress');
    expect(detail?.progress).toMatchObject({ kind: 'tv', episodes_finished: 2, episodes_total: 3 });

    // Undo: exactly the episodes that call changed.
    expect(await movies.setEpisodesWatched('tv-9', changed, false)).toEqual(changed);
    detail = await getTitle(db, 'tv-9', CTX);
    expect(detail?.seasons.find((s) => s.season === 1)?.episodes.map((e) => e.watched)).toEqual([true, false]);
    // Clearing a mark that is not there changes nothing.
    expect(await movies.setEpisodesWatched('tv-9', changed, false)).toEqual([]);
  });

  it('a series is finished once every episode is, and the finish is dated by the last mark (the SQL rule agrees)', async () => {
    await movies.setEpisodesWatched('tv-9', await movies.seasonEpisodes('tv-9', 1), true, ago(2));
    await movies.setEpisodesWatched('tv-9', await movies.seasonEpisodes('tv-9', 2), true, ago(1));
    const item = (await listTitles(db, { scope: 'all' }, CTX)).find((t) => t.id === 'tv-9');
    expect(item?.state).toBe('finished');
    expect(item?.finished_at).toBe(ago(1).toISOString());
    const finished = await movies.titlesFinishedBetween({ from: ago(1.5), to: NOW });
    expect(finished.map((f) => f.id)).toContain('tv-9');
  });

  it('survives a metadata fetch, which replaces movie_episodes', async () => {
    await movies.setEpisodesWatched('tv-9', [{ season: 2, episode: 1 }], true);
    await db.execute(sql`delete from movie_episodes where title_id = 'tv-9'`);
    await db.insert(movieEpisodes).values([{ titleId: 'tv-9', season: 2, episode: 1, name: 'Three, renamed' }]);
    const detail = await getTitle(db, 'tv-9', CTX);
    expect(detail?.seasons.find((s) => s.season === 2)?.episodes[0]).toMatchObject({ name: 'Three, renamed', watched: true, state: 'finished' });
  });
});

describe('not interested: the title leaves the grid and its place goes to another', () => {
  it('the mark is on the list item, stays on the Stream list after its source ages out, and can be taken back', async () => {
    await source('movie-1', ago(1));
    await source('movie-2', ago(9)); // older than the 7-day window
    expect((await listStreamTitles(db, {}, CTX, ago(7))).map((t) => t.id)).toEqual(['movie-1']);
    await movies.setTitleUser('movie-2', { notInterested: true });
    const listed = await listStreamTitles(db, {}, CTX, ago(7));
    expect(listed.map((t) => [t.id, t.not_interested]).sort()).toEqual([
      ['movie-1', false],
      ['movie-2', true],
    ]);
    await movies.setTitleUser('movie-2', { notInterested: false });
    expect((await listStreamTitles(db, {}, CTX, ago(7))).map((t) => t.id)).toEqual(['movie-1']);
  });

  it('interested: listed on the Stream side with no verified source, flagged as listed for the mark alone, and never together with not interested', async () => {
    await source('movie-1', ago(1));
    await movies.setTitleUser('movie-1', { interested: true });
    await movies.setTitleUser('movie-2', { interested: true });
    const listed = await listStreamTitles(db, {}, CTX, ago(7));
    expect(listed.map((t) => [t.id, t.interested, t.interested_only ?? false]).sort()).toEqual([
      ['movie-1', true, false],
      ['movie-2', true, true],
    ]);
    // Not interested takes it off the watch list, and with no verified source off the Stream list.
    await movies.setTitleUser('movie-2', { notInterested: true });
    expect(await getTitle(db, 'movie-2', CTX)).toMatchObject({ interested: false, not_interested: true });
    expect((await listStreamTitles(db, {}, CTX, ago(7))).map((t) => t.id)).toEqual(['movie-1']);
    // And interested takes "not interested" back.
    await movies.setTitleUser('movie-2', { interested: true });
    expect(await getTitle(db, 'movie-2', CTX)).toMatchObject({ interested: true, not_interested: false });
    await movies.setTitleUser('movie-2', { interested: false });
    expect(await getTitle(db, 'movie-2', CTX)).toMatchObject({ interested: false, not_interested: false });
  });

  it('a title last played from a torrent is on the Stream list: a torrent play verifies no source', async () => {
    expect((await listStreamTitles(db, {}, CTX, ago(7))).map((t) => t.id)).toEqual([]);
    await movies.recordChannel({ titleId: 'tv-9', host: HERE, channel: 'torrent', infoHash: 'a'.repeat(40), season: 1, episode: 1, at: ago(0) });
    const listed = await listStreamTitles(db, {}, CTX, ago(7));
    expect(listed.map((t) => [t.id, t.interested_only ?? false])).toEqual([['tv-9', false]]);
    // Another machine's torrent play lists nothing here.
    await movies.recordChannel({ titleId: 'movie-3', host: 'marks-host-b', channel: 'torrent', infoHash: 'b'.repeat(40), season: 0, episode: 0, at: ago(0) });
    expect((await listStreamTitles(db, {}, CTX, ago(7))).map((t) => t.id)).toEqual(['tv-9']);
  });
});
