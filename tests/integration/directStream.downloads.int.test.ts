import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { streamDownloads } from '../../src/db/schema.js';
import { DownloadsRepo } from '../../src/directStream/downloads/repo.js';
import { downloadRecordsContract } from '../helpers/downloadRecordsContract.js';
import { closeTestDb, openTestDb, truncateAll } from './setup.js';

let db: Db;

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
});
afterAll(async () => {
  await closeTestDb(db);
});
beforeEach(async () => {
  await truncateAll(db);
});

downloadRecordsContract('Postgres', async () => new DownloadsRepo(db));

describe('stream_downloads checks', () => {
  const base = { host: 'host-a', kind: 'movie' as const, tmdbId: 550, season: 0, episode: 0 };
  const HASH = '0123456789abcdef0123456789abcdef01234567';

  it('refuses a row that contradicts itself', async () => {
    expect(await pgCode(db.insert(streamDownloads).values({ ...base, via: 'auto', infoHash: HASH }))).toBe('23514');
    expect(await pgCode(db.insert(streamDownloads).values({ ...base, via: 'torrent', infoHash: 'NOTAHASH' }))).toBe('23514');
    expect(await pgCode(db.insert(streamDownloads).values({ ...base, source: 'torrent' }))).toBe('23514');
    expect(await pgCode(db.insert(streamDownloads).values({ ...base, source: 'torrent', sourceId: 'cache-id' }))).toBe('23514');
    expect(await pgCode(db.insert(streamDownloads).values({ ...base, state: 'done', completedAt: new Date() }))).toBe('23514');
    expect(await pgCode(db.insert(streamDownloads).values({ ...base, state: 'failed' }))).toBe('23514');
    expect(await pgCode(db.insert(streamDownloads).values({ ...base, season: 1, episode: 1 }))).toBe('23514');
    expect(await pgCode(db.insert(streamDownloads).values({ ...base, bytesDone: -1 }))).toBe('23514');
  });

  it('holds one open row per slot and host; finished ones do not count', async () => {
    await db.insert(streamDownloads).values({ ...base, state: 'done', source: 'cloud', sourceId: 'c1', completedAt: new Date() });
    await db.insert(streamDownloads).values({ ...base, state: 'done', source: 'cloud', sourceId: 'c2', completedAt: new Date() });
    await db.insert(streamDownloads).values({ ...base, state: 'failed', error: 'no_source' });
    expect(await pgCode(db.insert(streamDownloads).values({ ...base }))).toBe('23505');
    await db.insert(streamDownloads).values({ ...base, host: 'host-b' });
  });
});
