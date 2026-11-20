import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { TorrentMarksRepo } from '../../src/directStream/torrent/marks.js';
import { closeTestDb, openTestDb, truncateAll } from './setup.js';

const COLD = '67b07b417f6f8f7d367bbded3cd797a0840724b6';
const OTHER = '0123456789abcdef0123456789abcdef01234567';
const T0 = new Date('2026-11-20T08:00:00Z');

let db: Db;
let repo: TorrentMarksRepo;

beforeAll(async () => {
  db = openTestDb();
});
afterAll(async () => {
  await closeTestDb(db);
});
beforeEach(async () => {
  await truncateAll(db);
  repo = new TorrentMarksRepo(db, () => T0);
});

describe('TorrentMarksRepo (stream_torrent_marks)', () => {
  it('blacklists per info hash, whatever the case, and un-blacklists', async () => {
    const mark = await repo.blacklist(COLD.toUpperCase(), 'Eternally.Yours.S01E07.1080p.ColdFilm.mkv', 'a Russian voice-over');
    expect(mark).toMatchObject({ infoHash: COLD, blacklistedAt: T0, blacklistReason: 'a Russian voice-over' });
    expect([...(await repo.leftOut('en'))]).toEqual([COLD]);
    expect((await repo.blacklisted()).map((m) => m.infoHash)).toEqual([COLD]);
    expect(await repo.unblacklist(COLD)).toBe(true);
    expect(await repo.unblacklist(COLD)).toBe(false);
    expect((await repo.leftOut('en')).size).toBe(0);
    // The name stays: a later write without one keeps it.
    await repo.noteTags(COLD, null, []);
    expect((await repo.get(COLD))?.name).toBe('Eternally.Yours.S01E07.1080p.ColdFilm.mkv');
  });

  it('a heard language leaves the torrent out only for titles made in another language', async () => {
    await repo.noteHeard(COLD, 'cold', 'ru', 0.97);
    await repo.noteTags(OTHER, 'other', ['en', 'en']);
    expect([...(await repo.leftOut('en'))]).toEqual([COLD]);
    expect((await repo.leftOut('ru')).size).toBe(0);
    expect((await repo.leftOut(null)).size).toBe(0);
    const both = await repo.many([COLD, OTHER, 'f'.repeat(40)]);
    expect(both.get(COLD)).toMatchObject({ heardLanguage: 'ru', heardProbability: expect.closeTo(0.97, 5), heardAt: T0, tagLanguages: null });
    expect(both.get(OTHER)?.tagLanguages).toEqual(['en']);
    expect(both.size).toBe(2);
  });

  it('refuses a malformed info hash', async () => {
    await expect(repo.blacklist('not-a-hash', null, null)).rejects.toThrow();
  });
});
