import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { movieEpisodes } from '../../src/db/schema.js';
import { ProbeRepo } from '../../src/directStream/repo.js';
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
let probes: ProbeRepo;

async function source(titleId: string, verifiedAt: Date, season = 0, episode = 0): Promise<void> {
  await db.execute(sql`
    insert into movie_stream_sources (title_id, season, episode, host, provider, manifest_kind, best_height, en_subtitle, verified_at)
    values (${titleId}, ${season}, ${episode}, ${HERE}, 'VidFast', 'hls', 1080, true, ${verifiedAt})`);
}

beforeAll(() => {
  db = openTestDb();
  movies = new MoviesRepo(db);
  probes = new ProbeRepo(db);
});

afterAll(async () => {
  await closeTestDb(db);
});

beforeEach(async () => {
  await db.execute(sql`truncate table stream_probe_titles, movie_stream_sources`);
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

  it('the prober does not count, re-check or propose it; a title finished by hand is not counted either', async () => {
    await source('movie-1', ago(6));
    await source('movie-2', ago(6));
    await source('movie-3', ago(6));
    expect(await probes.freshCount(HERE, ago(7))).toBe(3);
    await movies.setTitleUser('movie-2', { notInterested: true });
    await movies.setTitleUser('movie-3', { watched: true });
    expect(await probes.freshCount(HERE, ago(7))).toBe(1);
    // A finished title is still re-checked (it stays playable); a not-interested one is not.
    expect((await probes.dueRechecks(HERE, ago(5), 10)).map((t) => t.tmdbId)).toEqual([1, 3]);
    // Aged out and listed again as a candidate: still never proposed.
    await db.execute(sql`update movie_stream_sources set verified_at = ${ago(30)} where title_id = 'movie-2'`);
    await probes.replaceListing(HERE, [{ kind: 'movie', tmdbId: 2, source: 'popular', rank: 1 }], NOW);
    expect(await probes.eligible(HERE, 'movie', NOW, ago(7), 10)).toEqual([]);
    await movies.setTitleUser('movie-2', { notInterested: false });
    expect((await probes.eligible(HERE, 'movie', NOW, ago(7), 10)).map((t) => t.tmdbId)).toEqual([2]);
  });
});
