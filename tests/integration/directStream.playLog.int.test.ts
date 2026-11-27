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

describe('PlayLogRepo.reattach (a play carried on after a restart)', () => {
  const LATER = new Date('2026-11-27T11:00:00.000Z');
  const NEW = 'N'.repeat(32);
  const film = { kind: 'movie' as const, tmdbId: 550, season: null, episode: null };
  const follow = { providerLast: 'Gamma', switchNote: null, subtitleSource: 'stream' };

  it('opens the row closed as restart under the new session, keeps the ask, adds one refresh and answers its counters', async () => {
    const repo = new PlayLogRepo(db);
    const id = await repo.insert({ ...base, asked: 'torrent', outcome: 'no_picture', resolveMs: 4_200, session: SID, channel: 'torrent', providerFirst: 'Torrent', providerLast: 'Torrent', infoHash: 'a'.repeat(40), torrentIndex: 'torrentio', refreshes: 1 }, AT);
    await repo.update('host-a', id, { outcome: 'played', firstFrameMs: 1_200, playedMs: 25_000, stalls: 2, stalledMs: 3_000, waits: 1, waitedMs: 4_000, errors: 1, autoSwitches: 1 }, AT);
    expect(await repo.closeLeftOpen('host-a', LATER)).toBe(1);
    const back = await repo.reattach('host-a', { ...film, was: SID, closedSince: LATER }, NEW, follow, LATER);
    expect(back).toEqual({ id, outcome: 'played', infoHash: 'a'.repeat(40), firstFrameMs: 1_200, playedMs: 25_000, stalls: 2, stalledMs: 3_000, waits: 1, waitedMs: 4_000, errors: 1, autoSwitches: 1, ownerSwitches: 0, refreshes: 2 });
    expect(await repo.bySession('host-a', SID)).toBeNull();
    expect(await repo.bySession('host-a', NEW)).toMatchObject({ id, via: 'play', asked: 'torrent', askedAt: AT, resolveMs: 4_200, torrentIndex: 'torrentio', providerFirst: 'Torrent', providerLast: 'Gamma', subtitleSource: 'stream', ended: null, endedAt: null, refreshes: 2 });
    expect(await db.select().from(streamPlayLog)).toHaveLength(1);
    // Twice is once: the row is open now.
    expect(await repo.reattach('host-a', { ...film, was: SID, closedSince: LATER }, 'M'.repeat(32), follow, LATER)).toBeNull();
  });

  it('never reopens another host\'s row, another title\'s, a row closed some other way, or one closed before this start', async () => {
    const repo = new PlayLogRepo(db);
    await repo.insert({ ...base, host: 'host-b', outcome: 'played', session: SID, channel: 'cloud', ended: 'restart', endedAt: LATER }, AT);
    await repo.insert({ ...base, tmdbId: 551, outcome: 'played', session: 'T'.repeat(32), channel: 'cloud', ended: 'restart', endedAt: LATER }, AT);
    await repo.insert({ ...base, outcome: 'played', session: 'U'.repeat(32), channel: 'cloud', ended: 'closed', endedAt: LATER }, AT);
    await repo.insert({ ...base, outcome: 'played', session: 'V'.repeat(32), channel: 'cloud', ended: 'restart', endedAt: AT }, AT);
    expect(await repo.reattach('host-a', { ...film, was: SID, closedSince: LATER }, NEW, follow, LATER)).toBeNull();
    expect(await repo.reattach('host-a', { ...film, was: 'T'.repeat(32), closedSince: LATER }, NEW, follow, LATER)).toBeNull();
    expect(await repo.reattach('host-a', { ...film, was: 'U'.repeat(32), closedSince: LATER }, NEW, follow, LATER)).toBeNull();
    expect(await repo.reattach('host-a', { ...film, was: null, closedSince: LATER }, NEW, follow, LATER)).toBeNull();
    expect(await repo.bySession('host-a', NEW)).toBeNull();
  });

  it('with no session id, takes the newest row of the episode this start closed as restart', async () => {
    const repo = new PlayLogRepo(db);
    const ep = { kind: 'tv' as const, tmdbId: 1399, season: 1, episode: 2 };
    await repo.insert({ ...base, ...ep, outcome: 'played', session: 'A'.repeat(32), channel: 'cloud', ended: 'restart', endedAt: LATER }, AT);
    const newest = await repo.insert({ ...base, ...ep, askedAt: new Date(AT.getTime() + 60_000), outcome: 'played', session: 'B'.repeat(32), channel: 'cloud', ended: 'restart', endedAt: LATER }, AT);
    await repo.insert({ ...base, ...ep, episode: 3, askedAt: new Date(AT.getTime() + 120_000), outcome: 'played', session: 'C'.repeat(32), channel: 'cloud', ended: 'restart', endedAt: LATER }, AT);
    expect((await repo.reattach('host-a', { ...ep, was: null, closedSince: LATER }, NEW, follow, LATER))?.id).toBe(newest);
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
