import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readHealth } from '../../src/directStream/playLog/health.js';
import { PlayLogRepo } from '../../src/directStream/playLog/repo.js';
import { movieEpisodes } from '../../src/db/schema.js';
import { truncateAll } from './setup.js';
import { createApiHarness, type ApiHarness } from './helpers/api-harness.js';
import { seedTitle, truncateMovies } from './helpers/moviesPlaySeed.js';

const HERE = 'health-host-a';
const OTHER = 'health-host-b';
const NOW = new Date('2026-11-27T12:00:00Z');
const ago = (min: number): string => new Date(NOW.getTime() - min * 60_000).toISOString();

let h: ApiHarness;
let repo: PlayLogRepo;

/** One play log row through raw SQL: the test seeds by the contract's column names, never through phase 1's writer. */
async function log(r: Record<string, string | number | null>): Promise<void> {
  const cols = Object.keys(r);
  await h.deps.db.execute(sql`insert into stream_play_log (${sql.raw(cols.join(', '))}) values (${sql.join(cols.map((c) => sql`${r[c]}`), sql`, `)})`);
}

const base = { via: 'play', kind: 'movie' } as const;

beforeAll(async () => {
  h = await createApiHarness();
  repo = new PlayLogRepo(h.deps.db);
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await truncateAll(h.deps.db);
  await truncateMovies(h.deps.db);
  // truncateAll already empties stream_play_log (phase 1 put it at the head of its list).
  await seedTitle(h.deps.db, { id: 'movie-990001', kind: 'movie', tmdbId: 990001, title: 'Health Film A' });
  await seedTitle(h.deps.db, { id: 'movie-990002', kind: 'movie', tmdbId: 990002, title: 'Health Film B' });
  await seedTitle(h.deps.db, { id: 'tv-990003', kind: 'tv', tmdbId: 990003, title: 'Health Series' });
  await h.deps.db.insert(movieEpisodes).values({ titleId: 'tv-990003', season: 1, episode: 2, name: 'Two' });
  await log({ ...base, host: HERE, asked_at: ago(120), tmdb_id: 990001, asked: 'torrent', outcome: 'played', session: 's1', channel: 'torrent', torrent_index: 'apibay', height: 1080, resolve_ms: 8000, first_frame_ms: 3000, played_ms: 1_800_000, stalls: 2, stalled_ms: 6000, ended: 'finished', ended_at: ago(85) });
  await log({ ...base, host: HERE, asked_at: ago(60), tmdb_id: 990002, asked: 'torrent', outcome: 'played', session: 's2', channel: 'torrent', torrent_index: 'apibay', height: 720, resolve_ms: 12_000, first_frame_ms: 5000, played_ms: 60_000, ended: 'closed', ended_at: ago(58) });
  await log({ ...base, host: HERE, asked_at: ago(180), tmdb_id: 990001, outcome: 'played', session: 's3', channel: 'cloud', provider_first: 'VidFast', height: 1080, resolve_ms: 20_000, first_frame_ms: 2000, played_ms: 1_740_000, stalls: 1, stalled_ms: 2000, ended: 'closed', ended_at: ago(150) });
  // A row with `ended` carries `ended_at` (phase 1's stream_play_log_ended_check).
  await log({ ...base, host: HERE, asked_at: ago(30), kind: 'tv', tmdb_id: 990003, season: 1, episode: 2, outcome: 'failed', failure: 'no_source', cloud_failure: 'no_stream', torrent_failure: 'no_source', resolve_ms: 30_000 });
  await log({ ...base, host: HERE, asked_at: ago(300), tmdb_id: 990002, asked: 'torrent', outcome: 'failed', failure: 'no_source', torrent_failure: 'no_source', resolve_ms: 25_000 });
  // Twenty days ago: outside the 7-day period, inside "all time" for the unhandled list.
  await log({ ...base, host: HERE, asked_at: ago(20 * 1440), kind: 'tv', tmdb_id: 990003, season: 1, episode: 2, outcome: 'failed', failure: 'bot_check', cloud_failure: 'bot_check' });
  // Another host's rows are never read.
  await log({ ...base, host: OTHER, asked_at: ago(10), tmdb_id: 990001, outcome: 'failed', failure: 'no_source', torrent_failure: 'no_source' });
});

describe('PlayLogRepo health reads', () => {
  it('reads this host\'s period newest first, with names and movie ids', async () => {
    const rows = await repo.healthRows(HERE, new Date(ago(7 * 1440)));
    expect(rows.map((r) => [r.title, r.outcome])).toEqual([
      ['Health Series', 'failed'],
      ['Health Film B', 'played'],
      ['Health Film A', 'played'],
      ['Health Film A', 'played'],
      ['Health Film B', 'failed'],
    ]);
    expect(rows[0]!.movie_id).toMatch(/^M-[0-9A-Z]{4}$/);
    expect(rows[1]!.movie_id).toMatch(/^M-[0-9A-Z]{4}$/);
    expect(rows[0]!.asked_at).toBeInstanceOf(Date);
    expect(await repo.firstAskedAt(HERE)).toEqual(new Date(ago(20 * 1440)));
    expect(await repo.firstAskedAt('nobody')).toBeNull();
  });

  it('lists a film or episode that failed and has not played since, over all time, with what each channel last said', async () => {
    const un = await repo.unhandled(HERE, 200);
    expect(un).toHaveLength(1);
    expect(un[0]).toMatchObject({ title: 'Health Series', kind: 'tv', tmdb_id: 990003, season: 1, episode: 2, asks: 2, last_asked_at: ago(30), cloud_failure: 'no_stream', torrent_failure: 'no_source' });
    expect(un[0]!.movie_id).toMatch(/^M-[0-9A-Z]{4}$/);
    // Film B failed at 300 min and played at 60 min: handled. Once the series plays, it leaves the list.
    await log({ ...base, host: HERE, asked_at: ago(5), kind: 'tv', tmdb_id: 990003, season: 1, episode: 2, outcome: 'played', session: 's9', channel: 'torrent', torrent_index: 'apibay' });
    expect(await repo.unhandled(HERE, 200)).toEqual([]);
  });

  it('answers the health of the period', async () => {
    const h7 = await readHealth(repo, HERE, 7, NOW);
    expect(h7.totals.all).toMatchObject({ asks: 5, failed: 2, played: 3, success_rate: 0.6 });
    expect(h7.totals.torrent).toMatchObject({ asks: 4, played: 2, success_rate: 0.5, median_first_frame_ms: 4000, hd_share: 0.5 });
    expect(h7.unhandled.map((u) => u.title)).toEqual(['Health Series']);
    const empty = await readHealth(repo, 'nobody', 7, NOW);
    expect(empty.totals.all).toMatchObject({ asks: 0, median_resolve_ms: null, median_first_frame_ms: null });
    expect(empty.unhandled).toEqual([]);
  });
});
