import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { MoviesRepo } from '../../src/movies/repo.js';
import { seedTitle, truncateMovies } from './helpers/moviesPlaySeed.js';
import { closeTestDb, openTestDb } from './setup.js';

const HERE = 'forget-host-a';
const COLD = '67b07b417f6f8f7d367bbded3cd797a0840724b6';
const OTHER = 'b'.repeat(40);
const at = (h: number): Date => new Date(Date.UTC(2026, 10, 20, h));

let db: Db;
let movies: MoviesRepo;

beforeAll(() => {
  db = openTestDb();
  movies = new MoviesRepo(db);
});
afterAll(async () => {
  await closeTestDb(db);
});
beforeEach(async () => {
  await truncateMovies(db);
  await seedTitle(db, { id: 'tv-1', kind: 'tv', tmdbId: 1, title: 'Eternally Yours' });
  await seedTitle(db, { id: 'tv-2', kind: 'tv', tmdbId: 2, title: 'Played on the cloud since' });
  await seedTitle(db, { id: 'movie-3', kind: 'movie', tmdbId: 3, title: 'Another torrent' });
});

describe('MoviesRepo.forgetTorrent (a torrent blacklisted)', () => {
  it('forgets the torrent as the last played and per method, falling back to the other method that played', async () => {
    // tv-1: only ever played from the dub torrent. tv-2: a cloud play, then the dub torrent last.
    await movies.recordChannel({ titleId: 'tv-1', host: HERE, channel: 'torrent', infoHash: COLD, season: 1, episode: 7, at: at(1) });
    await movies.recordChannel({ titleId: 'tv-2', host: HERE, channel: 'cloud', provider: 'VidRock', season: 1, episode: 1, at: at(1) });
    await movies.recordChannel({ titleId: 'tv-2', host: HERE, channel: 'torrent', infoHash: COLD, season: 1, episode: 2, at: at(2) });
    await movies.recordChannel({ titleId: 'movie-3', host: HERE, channel: 'torrent', infoHash: OTHER, season: null, episode: null, at: at(1) });
    // Another machine's memory of it is that machine's.
    await movies.recordChannel({ titleId: 'tv-1', host: 'forget-host-b', channel: 'torrent', infoHash: COLD, season: 1, episode: 7, at: at(1) });
    await movies.recordChannelFailure('tv-1', HERE, 'cloud', at(3));

    expect(await movies.forgetTorrent(COLD.toUpperCase(), HERE, at(4))).toEqual(['tv-1', 'tv-2']);

    // Nothing else played it: it stays a torrent title (listed on the Stream side) with no torrent remembered.
    expect(await movies.channelOf('tv-1', HERE)).toMatchObject({ channel: 'torrent', infoHash: null, playedAt: at(1), season: 1, episode: 7, cloudFailedAt: at(3) });
    expect((await movies.methodsOf('tv-1', HERE)).map((m) => m.method)).toEqual([]);
    expect(await movies.channelOf('tv-2', HERE)).toMatchObject({ channel: 'cloud', provider: 'VidRock', infoHash: null, season: 1, episode: 1 });
    expect((await movies.methodsOf('tv-2', HERE)).map((m) => m.method)).toEqual(['cloud']);
    expect(await movies.channelOf('movie-3', HERE)).toMatchObject({ channel: 'torrent', infoHash: OTHER });
    expect(await movies.channelOf('tv-1', 'forget-host-b')).toMatchObject({ channel: 'torrent', infoHash: COLD });
    expect(await movies.forgetTorrent(COLD, HERE, at(5))).toEqual([]);
  });
});
