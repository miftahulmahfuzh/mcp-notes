import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { streamProviderHealth, streamProviders } from '../../src/db/schema.js';
import { DirectStreamRepo, healthMap, providerSeedJson, type SeedProvider } from '../../src/directStream/repo.js';
import type { ResolvedSource } from '../../src/directStream/types.js';
import { closeTestDb, openTestDb, truncateAll } from './setup.js';

async function pgFailure(statement: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await statement;
  } catch (err) {
    let cur: unknown = err;
    while (cur && typeof cur === 'object') {
      const e = cur as { code?: unknown; constraint?: unknown; cause?: unknown };
      if (typeof e.code === 'string') return { code: e.code, constraint: typeof e.constraint === 'string' ? e.constraint : undefined };
      cur = e.cause;
    }
    return {};
  }
  throw new Error('expected the statement to fail');
}

const SEED: SeedProvider[] = [
  { name: 'Alpha', idKind: 'tmdb', movie: 'https://alpha.example/movie/{id}', tv: null, browserOnly: false, enSubtitle: true, notes: '' },
  { name: 'Bravo', idKind: 'tmdb', movie: 'https://bravo.example/movie/{id}', tv: 'https://bravo.example/tv/{id}/{season}/{episode}', browserOnly: false, enSubtitle: null, notes: '' },
  { name: 'Charlie', idKind: 'tmdb', movie: 'https://charlie.example/e/{id}', tv: null, browserOnly: true, enSubtitle: false, notes: 'plays only in its own page' },
];

const SOURCE: ResolvedSource = {
  provider: 'Bravo',
  embed_url: 'https://bravo.example/movie/550',
  manifest_url: 'https://cdn.example/hls/master.m3u8',
  manifest_kind: 'hls',
  headers: { referer: 'https://bravo.example/', origin: null, user_agent: 'Chrome/130' },
  subtitles: [{ url: 'https://cdn.example/en.vtt', lang: 'en', label: 'English', format: 'vtt', source: 'request' }],
  best_height: 1080,
  en_subtitle: true,
  took_s: 2.5,
};

let db: Db;
let repo: DirectStreamRepo;

beforeAll(() => {
  db = openTestDb();
  repo = new DirectStreamRepo(db);
});
afterAll(async () => {
  await closeTestDb(db);
});
beforeEach(async () => {
  await truncateAll(db);
});

describe('migration 0020 (stream providers)', () => {
  it('creates both tables with their keys', async () => {
    const res = await db.execute<{ indexname: string }>(sql`select indexname from pg_indexes where schemaname = 'public' and tablename like 'stream_%' order by indexname`);
    expect(res.rows.map((r) => r.indexname)).toEqual(expect.arrayContaining(['stream_providers_pkey', 'stream_provider_health_name_host_pk']));
  });

  it('accepts only the known outcomes, kinds and providers', async () => {
    await repo.syncSeed(SEED);
    const row = { name: 'Alpha', host: 'host-a', lastOutcome: 'resolved' as const };
    expect(await pgFailure(db.insert(streamProviderHealth).values({ ...row, lastOutcome: 'skipped_browser_only' as never }))).toEqual({
      code: '23514',
      constraint: 'stream_provider_health_outcome_check',
    });
    expect(await pgFailure(db.insert(streamProviderHealth).values({ ...row, manifestKind: 'rtmp' as never }))).toMatchObject({ code: '23514' });
    expect(await pgFailure(db.insert(streamProviderHealth).values({ ...row, name: 'Nobody' }))).toMatchObject({ code: '23503' });
    expect(await pgFailure(db.insert(streamProviders).values({ name: 'X', idKind: 'imdbx' as never, movie: 'https://x/{id}' }))).toMatchObject({ code: '23514' });
  });
});

describe('DirectStreamRepo.syncSeed', () => {
  it('loads the seed once, updates a changed seed row, and never touches a row a site added', async () => {
    expect(await repo.syncSeed(SEED)).toEqual({ inserted: 3, updated: 0, removed: [], reset: [] });
    expect(await repo.syncSeed(SEED)).toEqual({ inserted: 0, updated: 0, removed: [], reset: [] });
    const rows = await repo.providers();
    expect(rows.map((r) => [r.name, r.originSite])).toEqual([['Alpha', null], ['Bravo', null], ['Charlie', null]]);
    expect(rows.map(providerSeedJson)[1]).toEqual({
      name: 'Bravo', id_kind: 'tmdb', movie: 'https://bravo.example/movie/{id}', tv: 'https://bravo.example/tv/{id}/{season}/{episode}',
      browser_only: false, en_subtitle: null, notes: '',
    });

    const changed = SEED.map((e) => (e.name === 'Alpha' ? { ...e, tv: 'https://alpha.example/tv/{id}/{season}/{episode}' } : e));
    expect(await repo.syncSeed(changed)).toEqual({ inserted: 0, updated: 1, removed: [], reset: [] });
    expect((await repo.providers())[0]?.tv).toBe('https://alpha.example/tv/{id}/{season}/{episode}');

    // A provider /update-cloud-source added keeps its own values even when the seed later names it.
    await db.insert(streamProviders).values({ name: 'Delta', movie: 'https://delta.example/{id}', originSite: 'https://ww6-fmovies.com/' });
    expect(await repo.syncSeed([...changed, { name: 'Delta', idKind: 'tmdb', movie: 'https://other.example/{id}', tv: null, browserOnly: true, enSubtitle: null, notes: '' }])).toEqual({ inserted: 0, updated: 0, removed: [], reset: [] });
    const delta = (await repo.providers()).find((r) => r.name === 'Delta');
    expect([delta?.movie, delta?.browserOnly, delta?.originSite]).toEqual(['https://delta.example/{id}', false, 'https://ww6-fmovies.com/']);
  });

  it('deletes a seed row the seed no longer names, with its health, and never a row a site added', async () => {
    await repo.syncSeed(SEED);
    await db.insert(streamProviders).values({ name: 'Delta', movie: 'https://delta.example/{id}', originSite: 'https://ww6-fmovies.com/' });
    await repo.recordAttempts('host-a', [
      { provider: 'Charlie', outcome: 'no_stream', took_s: 35, detail: 'unreachable: HTTP 523', source: null },
      { provider: 'Alpha', outcome: 'resolved', took_s: 3, detail: '', source: null },
      { provider: 'Delta', outcome: 'bot_check', took_s: 4, detail: '', source: null },
    ]);
    expect(await repo.syncSeed(SEED.filter((e) => e.name !== 'Charlie'))).toEqual({ inserted: 0, updated: 0, removed: ['Charlie'], reset: [] });
    expect((await repo.providers()).map((r) => r.name)).toEqual(['Alpha', 'Bravo', 'Delta']);
    expect((await repo.healthFor('host-a')).map((r) => r.name).sort()).toEqual(['Alpha', 'Delta']);
    // An empty seed (a file read wrong) deletes nothing.
    expect(await repo.syncSeed([])).toEqual({ inserted: 0, updated: 0, removed: [], reset: [] });
    expect((await repo.providers()).map((r) => r.name)).toEqual(['Alpha', 'Bravo', 'Delta']);
  });

  it('a seed entry changed after its last try here sets its failures in a row to 0, once', async () => {
    await repo.syncSeed(SEED, new Date('2026-11-18T00:00:00Z'));
    const failed = new Date('2026-11-19T00:00:00Z');
    for (let i = 0; i < 10; i++) {
      await repo.recordAttempts('host-a', [
        { provider: 'Bravo', outcome: 'no_stream', took_s: 35, detail: 'unreachable: HTTP 523', source: null },
        { provider: 'Alpha', outcome: 'bot_check', took_s: 4, detail: '', source: null },
      ], failed);
    }
    const moved = SEED.map((e) => (e.name === 'Bravo' ? { ...e, movie: 'https://bravo.new.example/movie/{id}' } : e));
    expect(await repo.syncSeed(moved, new Date('2026-11-20T00:00:00Z'))).toEqual({ inserted: 0, updated: 1, removed: [], reset: ['Bravo'] });
    const byName = Object.fromEntries((await repo.healthFor('host-a')).map((r) => [r.name, r]));
    // Asked again like a fresh provider; what it did before is still counted.
    expect(byName.Bravo).toMatchObject({ consecutiveFailures: 0, failures: 10 });
    expect(byName.Alpha).toMatchObject({ consecutiveFailures: 10 });
    expect(await repo.syncSeed(moved, new Date('2026-11-21T00:00:00Z'))).toEqual({ inserted: 0, updated: 0, removed: [], reset: [] });
    // A failure at the new address counts again, and the next start leaves it.
    await repo.recordAttempts('host-a', [{ provider: 'Bravo', outcome: 'no_stream', took_s: 35, detail: '', source: null }], new Date('2026-11-22T00:00:00Z'));
    expect(await repo.syncSeed(moved, new Date('2026-11-23T00:00:00Z'))).toMatchObject({ reset: [] });
    expect((await repo.healthFor('host-a')).find((r) => r.name === 'Bravo')).toMatchObject({ consecutiveFailures: 1 });
  });
});

describe('DirectStreamRepo health', () => {
  it('clearRests sets the named providers\' failures in a row to 0 on one host, keeps everything else, and returns the rows', async () => {
    await repo.syncSeed(SEED);
    const failed = new Date('2026-11-19T00:00:00Z');
    for (let i = 0; i < 7; i++) {
      await repo.recordAttempts('host-a', [
        { provider: 'Alpha', outcome: 'no_stream', took_s: 35, detail: '', source: null },
        { provider: 'Bravo', outcome: 'no_stream', took_s: 35, detail: '', source: null },
      ], failed);
    }
    await repo.recordAttempts('host-b', [{ provider: 'Alpha', outcome: 'no_stream', took_s: 35, detail: '', source: null }], failed);
    const cleared = await repo.clearRests('host-a', ['Alpha', 'Nobody'], new Date('2026-11-27T00:00:00Z'));
    expect(cleared.map((r) => [r.name, r.consecutiveFailures, r.failures, r.lastOutcome, r.lastFailureAt])).toEqual([['Alpha', 0, 7, 'no_stream', failed]]);
    const byName = Object.fromEntries((await repo.healthFor('host-a')).map((r) => [r.name, r]));
    expect(byName.Alpha?.consecutiveFailures).toBe(0);
    expect(byName.Bravo?.consecutiveFailures).toBe(7);
    expect((await repo.healthFor('host-b'))[0]?.consecutiveFailures).toBe(1);
    expect(await repo.clearRests('host-a', [])).toEqual([]);
  });

  it('keeps health per host', async () => {
    await repo.syncSeed(SEED);
    await repo.recordAttempts('host-a', [{ provider: 'Bravo', outcome: 'resolved', took_s: 2.5, detail: '', source: SOURCE }]);
    await repo.recordAttempts('host-b', [{ provider: 'Bravo', outcome: 'no_stream', took_s: 35, detail: 'nothing in 35 s', source: null }]);
    const a = await repo.healthFor('host-a');
    const b = await repo.healthFor('host-b');
    expect(a.map((r) => [r.name, r.host, r.lastOutcome, r.successes, r.failures, r.enSubtitle, r.bestHeight, r.manifestKind])).toEqual([
      ['Bravo', 'host-a', 'resolved', 1, 0, true, 1080, 'hls'],
    ]);
    expect(b.map((r) => [r.name, r.host, r.lastOutcome, r.successes, r.failures, r.lastDetail])).toEqual([['Bravo', 'host-b', 'no_stream', 0, 1, 'nothing in 35 s']]);
    expect(Object.keys(healthMap(a))).toEqual(['Bravo']);
  });

  it('counts failures in a row, resets them on a success, and keeps the last ten times', async () => {
    await repo.syncSeed(SEED);
    for (let i = 0; i < 3; i++) await repo.recordAttempts('host-a', [{ provider: 'Alpha', outcome: 'bot_check', took_s: 4, detail: 'Just a moment...', source: null }]);
    expect((await repo.healthFor('host-a'))[0]).toMatchObject({ consecutiveFailures: 3, failures: 3, lastOutcome: 'bot_check' });
    for (let i = 1; i <= 12; i++) await repo.recordAttempts('host-a', [{ provider: 'Alpha', outcome: 'resolved', took_s: i, detail: '', source: null }]);
    const [row] = await repo.healthFor('host-a');
    expect(row).toMatchObject({ consecutiveFailures: 0, failures: 3, successes: 12, lastOutcome: 'resolved' });
    expect(row?.recentS).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(healthMap(row === undefined ? [] : [row]).Alpha?.median_s).toBe(7.5);
  });
});
