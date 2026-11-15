import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { ProbeRepo } from '../../src/directStream/repo.js';
import { closeTestDb, openTestDb } from './setup.js';
import { seedFile, seedPlay, seedTitle, truncateMovies } from './helpers/moviesPlaySeed.js';

const HERE = 'probe-host-a';
const OTHER = 'probe-host-b';
const DAY = 86_400_000;
const NOW = new Date('2026-11-15T12:00:00Z');
const ago = (days: number): Date => new Date(NOW.getTime() - days * DAY);

let db: Db;
let repo: ProbeRepo;

/** A phase 5 row; a stale one names its failure (movie_stream_sources_failure_check). */
async function source(titleId: string, host: string, verifiedAt: Date | null, staleAt: Date | null = null, season = 0, episode = 0): Promise<void> {
  const failure = staleAt === null ? null : 'no_source';
  await db.execute(sql`
    insert into movie_stream_sources (title_id, season, episode, host, provider, manifest_kind, best_height, en_subtitle, verified_at, stale_at, failure)
    values (${titleId}, ${season}, ${episode}, ${host}, 'VidFast', 'hls', 1080, true, ${verifiedAt}, ${staleAt}, ${failure})`);
}

beforeAll(() => {
  db = openTestDb();
  repo = new ProbeRepo(db);
});

afterAll(async () => {
  await closeTestDb(db);
});

beforeEach(async () => {
  await db.execute(sql`truncate table stream_probe_titles, movie_stream_sources`);
  await truncateMovies(db);
  for (const [id, kind, tmdbId] of [
    ['movie-1', 'movie', 1],
    ['movie-2', 'movie', 2],
    ['movie-3', 'movie', 3],
    ['movie-4', 'movie', 4],
    ['movie-5', 'movie', 5],
    ['tv-9', 'tv', 9],
  ] as const) {
    await seedTitle(db, { id, kind, tmdbId, title: id });
  }
});

describe('ProbeRepo (R6.1)', () => {
  it('counts fresh titles on this host only, once per title, and not stale or expired ones', async () => {
    await source('movie-1', HERE, ago(1));
    await source('movie-2', OTHER, ago(1));
    await source('movie-3', HERE, ago(2), ago(1));
    await source('movie-4', HERE, ago(8));
    await source('tv-9', HERE, ago(1), null, 1, 1);
    await source('tv-9', HERE, ago(2), null, 1, 2);
    expect(await repo.freshCount(HERE, ago(7))).toBe(2);
  });

  it('lists due re-checks oldest first, with a series episode named, skipping stale and recent ones', async () => {
    await source('movie-1', HERE, ago(1));
    await source('movie-4', HERE, ago(8));
    await source('movie-5', HERE, ago(6));
    await source('movie-3', HERE, ago(9), ago(1));
    await source('tv-9', HERE, ago(5.5), null, 2, 3);
    await source('movie-2', OTHER, ago(9));
    expect(await repo.dueRechecks(HERE, ago(4.9), 10)).toEqual([
      { kind: 'movie', tmdbId: 4, season: null, episode: null },
      { kind: 'movie', tmdbId: 5, season: null, episode: null },
      { kind: 'tv', tmdbId: 9, season: 2, episode: 3 },
    ]);
  });

  it('replaces the listing and offers only listed titles that are out of backoff and not fresh, best rank first', async () => {
    await repo.replaceListing(HERE, [
      { kind: 'movie', tmdbId: 1, source: 'trending', rank: 0 },
      { kind: 'movie', tmdbId: 2, source: 'recommended', rank: 1 },
      { kind: 'movie', tmdbId: 3, source: 'popular', rank: 2 },
      { kind: 'tv', tmdbId: 9, source: 'trending', rank: 0 },
    ], ago(0.1));
    await source('movie-1', HERE, ago(1));
    await repo.record(HERE, { kind: 'movie', tmdbId: 3, outcome: 'no_source', probedAt: NOW, failures: 1, retryAfter: new Date(NOW.getTime() + DAY) });
    expect((await repo.eligible(HERE, 'movie', NOW, ago(7), 10)).map((t) => t.tmdbId)).toEqual([2]);
    expect((await repo.eligible(HERE, 'movie', new Date(NOW.getTime() + DAY + 1), ago(7), 10)).map((t) => t.tmdbId)).toEqual([2, 3]);
    expect(await repo.eligible(HERE, 'tv', NOW, ago(7), 10)).toEqual([{ kind: 'tv', tmdbId: 9, season: null, episode: null }]);
    expect(await repo.eligible(OTHER, 'movie', NOW, ago(7), 10)).toEqual([]);
    expect(await repo.listedAt(HERE)).toEqual(ago(0.1));

    await repo.replaceListing(HERE, [{ kind: 'movie', tmdbId: 3, source: 'genre', rank: 0 }], NOW);
    expect((await repo.eligible(HERE, 'movie', new Date(NOW.getTime() + 2 * DAY), ago(7), 10)).map((t) => t.tmdbId)).toEqual([3]);
    expect(await repo.failures(HERE, 'movie', 3)).toBe(1);
  });

  it('records outcomes: verified clears the backoff', async () => {
    await repo.record(HERE, { kind: 'movie', tmdbId: 4, outcome: 'error', probedAt: NOW, failures: 2, retryAfter: new Date(NOW.getTime() + 2 * DAY) });
    expect(await repo.failures(HERE, 'movie', 4)).toBe(2);
    await repo.record(HERE, { kind: 'movie', tmdbId: 4, outcome: 'verified', probedAt: NOW, failures: 0, retryAfter: null });
    expect(await repo.failures(HERE, 'movie', 4)).toBe(0);
  });

  it('refuses rows the prober must never hold', async () => {
    await expect(db.execute(sql`insert into stream_probe_titles (host, kind, tmdb_id, list_source) values (${HERE}, 'movie', 7, 'trending')`)).rejects.toThrow();
    await expect(
      db.execute(sql`insert into stream_probe_titles (host, kind, tmdb_id, outcome, probed_at, failures) values (${HERE}, 'movie', 7, 'verified', now(), 1)`),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`insert into stream_probe_titles (host, kind, tmdb_id, outcome, probed_at, failures) values (${HERE}, 'movie', 7, 'no_source', now(), 1)`),
    ).rejects.toThrow();
  });

  it('sees an open, recently updated play on this host as active', async () => {
    const fileId = await seedFile(db, { titleId: 'movie-1', host: HERE, path: '/v/one.mkv' });
    expect(await repo.activePlay(HERE, ago(1 / 96))).toBe(false);
    await seedPlay(db, { fileId, host: HERE, positionS: 10, durationS: 100, startedAt: NOW, endedAt: null });
    expect(await repo.activePlay(HERE, ago(1 / 96))).toBe(true);
    expect(await repo.activePlay(OTHER, ago(1 / 96))).toBe(false);
    expect(await repo.activePlay(HERE, new Date(NOW.getTime() + 60_000))).toBe(false);
  });

  it('reads stored genres for seed titles', async () => {
    await db.execute(sql`update movie_titles set genres = '["Drama","Crime"]'::jsonb where id = 'movie-2'`);
    expect(await repo.titleGenres(['movie-2', 'movie-9'])).toEqual(new Map([['movie-2', ['Drama', 'Crime']]]));
  });
});
