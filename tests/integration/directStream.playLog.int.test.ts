import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { streamPlayLog } from '../../src/db/schema.js';
import { PlayLogRepo } from '../../src/directStream/playLog/repo.js';
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

const AT = new Date('2026-11-27T10:00:00.000Z');
const base = { host: 'host-a', askedAt: AT, via: 'play' as const, kind: 'movie' as const, tmdbId: 550 };
const SID = 'S'.repeat(32);

describe('PlayLogRepo', () => {
  it('inserts a session row, updates it, and reads it back with every column', async () => {
    const repo = new PlayLogRepo(db);
    const id = await repo.insert({ ...base, asked: 'torrent', outcome: 'no_picture', resolveMs: 4_200, session: SID, channel: 'torrent', providerFirst: 'Torrent', providerLast: 'Torrent', infoHash: 'a'.repeat(40), torrentIndex: 'torrentio', seeds: 16, filmKbps: 5_100, height: 1080 }, AT);
    await repo.update('host-a', id, { outcome: 'played', firstFrameMs: 1_200, playedMs: 25_000, stalls: 2, stalledMs: 3_000, waits: 1, waitedMs: 4_000, errors: 1, autoSwitches: 1, ownerSwitches: 0, subtitleSource: 'Wyzie', ended: 'closed', endedAt: AT }, AT);
    await repo.update('host-b', id, { playedMs: 1 }, AT);
    expect(await repo.bySession('host-a', SID)).toMatchObject({ id, outcome: 'played', asked: 'torrent', resolveMs: 4_200, infoHash: 'a'.repeat(40), torrentIndex: 'torrentio', seeds: 16, height: 1080, firstFrameMs: 1_200, playedMs: 25_000, stalls: 2, ended: 'closed', subtitleSource: 'Wyzie' });
    expect(await repo.bySession('host-b', SID)).toBeNull();
  });

  it('keeps a failed row with its word and the word of each channel', async () => {
    const repo = new PlayLogRepo(db);
    const id = await repo.insert({ ...base, outcome: 'failed', failure: 'no_source', failureDetail: 'No provider or torrent could stream it.', cloudFailure: 'no_stream', torrentFailure: 'no_source', resolveMs: 90_000 }, AT);
    const [row] = await db.select().from(streamPlayLog);
    expect(row).toMatchObject({ id, outcome: 'failed', failure: 'no_source', cloudFailure: 'no_stream', torrentFailure: 'no_source', session: null, ended: null });
  });

  it('closes only this host\'s open session rows as restart', async () => {
    const repo = new PlayLogRepo(db);
    await repo.insert({ ...base, outcome: 'played', session: SID, channel: 'cloud' }, AT);
    await repo.insert({ ...base, outcome: 'played', session: 'T'.repeat(32), channel: 'cloud', ended: 'closed', endedAt: AT }, AT);
    await repo.insert({ ...base, host: 'host-b', outcome: 'played', session: 'U'.repeat(32), channel: 'cloud' }, AT);
    await repo.insert({ ...base, outcome: 'failed', failure: 'no_source' }, AT);
    expect(await repo.closeLeftOpen('host-a', AT)).toBe(1);
    expect(await repo.bySession('host-a', SID)).toMatchObject({ ended: 'restart', endedAt: AT });
    expect(await repo.bySession('host-a', 'T'.repeat(32))).toMatchObject({ ended: 'closed' });
    expect(await repo.bySession('host-b', 'U'.repeat(32))).toMatchObject({ ended: null });
  });
});

describe('stream_play_log checks', () => {
  it('refuses a row that contradicts itself', async () => {
    expect(await pgCode(db.insert(streamPlayLog).values({ ...base, outcome: 'failed' }))).toBe('23514');
    expect(await pgCode(db.insert(streamPlayLog).values({ ...base, outcome: 'failed', failure: 'no_source', session: SID }))).toBe('23514');
    expect(await pgCode(db.insert(streamPlayLog).values({ ...base, outcome: 'played', session: SID, channel: 'cloud', cloudFailure: 'no_stream' }))).toBe('23514');
    expect(await pgCode(db.insert(streamPlayLog).values({ ...base, outcome: 'played', session: SID, channel: 'cloud', ended: 'closed' }))).toBe('23514');
    expect(await pgCode(db.insert(streamPlayLog).values({ ...base, outcome: 'played' }))).toBe('23514');
    expect(await pgCode(db.insert(streamPlayLog).values({ ...base, outcome: 'site', channel: 'cloud' }))).toBe('23514');
    expect(await pgCode(db.insert(streamPlayLog).values({ ...base, season: 1, episode: 1, outcome: 'failed', failure: 'no_source' }))).toBe('23514');
    expect(await pgCode(db.insert(streamPlayLog).values({ ...base, outcome: 'played', session: SID, channel: 'cloud', stalls: -1 }))).toBe('23514');
  });

  it('holds one row per session', async () => {
    await db.insert(streamPlayLog).values({ ...base, outcome: 'played', session: SID, channel: 'cloud' });
    expect(await pgCode(db.insert(streamPlayLog).values({ ...base, outcome: 'no_picture', session: SID, channel: 'cloud' }))).toBe('23505');
  });
});
