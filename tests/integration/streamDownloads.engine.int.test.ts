import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { DownloadsRepo } from '../../src/directStream/downloads/repo.js';
import { StreamDownloads } from '../../src/directStream/downloads/service.js';
import { TorrentsRepo } from '../../src/directStream/torrent/repo.js';
import { TorrentStreams } from '../../src/directStream/torrent/service.js';
import { TorrentFolder } from '../../src/directStream/torrent/store.js';
import { FakeTorrentEngine } from '../helpers/fakeTorrentEngine.js';
import { FakeTorrents } from '../unit/directStream/downloads/fakes.js';
import { closeTestDb, openTestDb, truncateAll } from './setup.js';

const HOST = 'host-a';
const FILM = { kind: 'movie', tmdbId: 550 } as const;
const HASH = '0123456789abcdef0123456789abcdef01234567';
const OTHER = 'fedcba9876543210fedcba9876543210fedcba98';
const T0 = new Date('2026-11-20T12:00:00Z');
const DAY = 86_400_000;
const MIB = 1_048_576;

let db: Db;
let root: string;
beforeAll(() => {
  db = openTestDb();
});
afterAll(async () => {
  await closeTestDb(db);
});
beforeEach(async () => {
  await truncateAll(db);
  root = await mkdtemp(path.join(os.tmpdir(), 'downloads-int-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('R1.7 a restart carries a download on (Postgres)', () => {
  it('re-queues a running torrent download and opens the same torrent by its info hash', async () => {
    const repo = new DownloadsRepo(db);
    const { row } = await repo.create(HOST, { ref: FILM, via: 'auto', infoHash: null, batch: null }, T0);
    await repo.setState(HOST, row.id, 'running', T0);
    await repo.on(HOST, row.id, { source: 'torrent', infoHash: HASH }, T0);
    const torrents = new FakeTorrents();
    torrents.answers.set(`hash:${HASH}`, { ok: true, handle: { infoHash: HASH, fileIndex: 0, name: 'Fixture.Film' }, detail: 'Fixture.Film' });
    const downloads = new StreamDownloads({ host: HOST, repo, torrents, caches: null, ssid: async () => null, playingTorrents: () => [], now: () => T0, log: () => undefined, every: () => () => undefined });
    expect(await downloads.start()).toBe(1);
    await downloads.settled();
    expect(torrents.calls).toEqual([`fetch hash:${HASH}`, `keep ${HASH} true`]);
    expect(await repo.get(HOST, row.id)).toMatchObject({ state: 'running', source: 'torrent', sourceId: HASH });
    await downloads.close();
  });
});

describe('R1.6 a kept torrent survives both prunes (Postgres)', () => {
  it('stays through the age prune and the budget while an unkept one goes', async () => {
    const torrentsRepo = new TorrentsRepo(db);
    const folder = new TorrentFolder(root);
    const old = new Date(T0.getTime() - 30 * DAY);
    for (const hash of [HASH, OTHER]) {
      const slot = { infoHash: hash, season: 0, episode: 0 };
      await torrentsRepo.record(HOST, { infoHash: hash, ref: FILM, name: `Film.${hash.slice(0, 4)}`, release: null, trackers: [] }, old);
      await torrentsRepo.chosen(HOST, slot, { files: [{ index: 0, path: 'Film/Film.mkv', length: 2 * MIB }], fileIndex: 0, fileLength: 2 * MIB }, old);
      await torrentsRepo.ready(HOST, slot, 2 * MIB, old);
      const file = folder.diskPath(hash, 'Film/Film.mkv')!;
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, Buffer.alloc(2 * MIB, 1));
    }
    const streams = new TorrentStreams({ engine: new FakeTorrentEngine([]), repo: torrentsRepo, folder, host: HOST, uploadKbps: 100, keepDays: 7, budgetBytes: MIB, discovery: true, now: () => T0, log: () => undefined, every: () => () => undefined });
    await streams.keep(HASH, true);
    await streams.prune();
    expect(await readdir(root)).toEqual([HASH]);
    expect((await torrentsRepo.slots(HOST, HASH)).map((r) => r.keptAt?.toISOString())).toEqual([T0.toISOString()]);
    expect(await torrentsRepo.slots(HOST, OTHER)).toEqual([]);
  });
});
