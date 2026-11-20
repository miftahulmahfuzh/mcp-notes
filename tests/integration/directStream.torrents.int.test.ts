import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { streamTorrents } from '../../src/db/schema.js';
import { TorrentsRepo } from '../../src/directStream/torrent/repo.js';
import { TorrentStreams } from '../../src/directStream/torrent/service.js';
import { TorrentFolder } from '../../src/directStream/torrent/store.js';
import { FakeTorrentEngine } from '../helpers/fakeTorrentEngine.js';
import { closeTestDb, openTestDb, truncateAll } from './setup.js';

const HASH = '0123456789abcdef0123456789abcdef01234567';
const NAME = 'Fixture.Film.2026';
const VIDEO = Buffer.from(Array.from({ length: 3000 }, (_, i) => i % 199));
const REF = { kind: 'movie', tmdbId: 550 } as const;
const EPISODE = { kind: 'tv', tmdbId: 1399, season: 1, episode: 2 } as const;
const T0 = new Date('2026-11-16T12:00:00Z');

let db: Db;
let repo: TorrentsRepo;
let root: string;

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

function streams(host: string, engine = new FakeTorrentEngine([])): TorrentStreams {
  return new TorrentStreams({ engine, repo, folder: new TorrentFolder(root), host, uploadKbps: 100, keepDays: 7, discovery: true, now: () => T0, log: () => undefined, every: () => () => undefined });
}

beforeAll(() => {
  db = openTestDb();
  repo = new TorrentsRepo(db);
});
afterAll(async () => {
  await closeTestDb(db);
});
beforeEach(async () => {
  await truncateAll(db);
  root = await mkdtemp(path.join(os.tmpdir(), 'torrents-int-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const SLOT = { infoHash: HASH, season: 0, episode: 0 };

describe('stream_torrents', () => {
  it('keeps one row per host, hash and episode; another episode of a pack gets its own row, another film forgets the choice', async () => {
    const first = await repo.record('host-a', { infoHash: HASH, ref: REF, name: NAME, release: 'Release.A', trackers: ['udp://t.example:1/announce'] }, T0);
    expect(first).toMatchObject({ state: 'downloading', fileIndex: null, files: [], trackers: ['udp://t.example:1/announce'] });
    await repo.chosen('host-a', SLOT, { files: [{ index: 1, path: `${NAME}/${NAME}.mp4`, length: 3000 }], fileIndex: 1, fileLength: 3000 }, T0);
    const same = await repo.record('host-a', { infoHash: HASH, ref: REF, name: NAME, release: null, trackers: [] }, T0);
    expect(same).toMatchObject({ fileIndex: 1, release: 'Release.A', trackers: ['udp://t.example:1/announce'] });
    const other = await repo.record('host-a', { infoHash: HASH, ref: EPISODE, name: NAME, release: null, trackers: [] }, T0);
    expect(other).toMatchObject({ kind: 'tv', season: 1, episode: 2, fileIndex: null, files: [], state: 'downloading' });
    // The film's row keeps its chosen file beside the episode's.
    expect(await repo.get('host-a', HASH, REF)).toMatchObject({ kind: 'movie', fileIndex: 1 });
    expect((await repo.slots('host-a', HASH)).map((r) => [r.season, r.episode]).sort()).toEqual([[0, 0], [1, 2]]);
    // The same slot opened for another film forgets the choice.
    const otherFilm = await repo.record('host-a', { infoHash: HASH, ref: { kind: 'movie', tmdbId: 551 }, name: NAME, release: null, trackers: [] }, T0);
    expect(otherFilm).toMatchObject({ tmdbId: 551, fileIndex: null, files: [] });
    await repo.record('host-b', { infoHash: HASH, ref: REF, name: NAME, release: null, trackers: [] }, T0);
    expect((await repo.byHash(HASH)).map((r) => r.host)).toEqual(['host-a', 'host-a', 'host-b']);
    expect(await repo.delete('host-a', HASH)).toBe(true);
    expect((await repo.byHash(HASH)).map((r) => r.host)).toEqual(['host-b']);
  });

  it('refuses contradictions', async () => {
    const base = { host: 'host-a', infoHash: HASH, kind: 'movie' as const, tmdbId: 550, name: NAME };
    expect(await pgCode(db.insert(streamTorrents).values({ ...base, infoHash: HASH.toUpperCase() }))).toBe('23514');
    expect(await pgCode(db.insert(streamTorrents).values({ ...base, state: 'ready', completedAt: T0 }))).toBe('23514');
    expect(await pgCode(db.insert(streamTorrents).values({ ...base, state: 'ready', fileIndex: 0 }))).toBe('23514');
    expect(await pgCode(db.insert(streamTorrents).values({ ...base, state: 'failed' }))).toBe('23514');
    expect(await pgCode(db.insert(streamTorrents).values({ ...base, kind: 'movie', season: 1, episode: 1 }))).toBe('23514');
  });

  it('moves through ready, failed and restarted without breaking a check', async () => {
    await repo.record('host-a', { infoHash: HASH, ref: REF, name: NAME, release: null, trackers: [] }, T0);
    await repo.chosen('host-a', SLOT, { files: [{ index: 1, path: `${NAME}/${NAME}.mp4`, length: 3000 }], fileIndex: 1, fileLength: 3000 }, T0);
    expect(await repo.ready('host-a', SLOT, 3000, T0)).toMatchObject({ state: 'ready', completedAt: T0 });
    await repo.failed('host-a', SLOT, 'no_metadata', T0);
    expect(await repo.get('host-a', HASH)).toMatchObject({ state: 'failed', error: 'no_metadata', completedAt: null });
    await repo.restarted('host-a', SLOT, T0);
    expect(await repo.get('host-a', HASH)).toMatchObject({ state: 'downloading', error: null, bytesDone: 0 });
  });

  it('finds what was not played for the window: by played_at, else completed_at, else created_at', async () => {
    const day = 86_400_000;
    await repo.record('host-a', { infoHash: 'a'.repeat(40), ref: REF, name: 'never played', release: null, trackers: [] }, new Date(T0.getTime() - 9 * day));
    await repo.record('host-a', { infoHash: 'b'.repeat(40), ref: REF, name: 'played lately', release: null, trackers: [] }, new Date(T0.getTime() - 9 * day));
    await repo.played('host-a', { infoHash: 'b'.repeat(40), season: 0, episode: 0 }, new Date(T0.getTime() - day));
    await repo.record('host-b', { infoHash: 'c'.repeat(40), ref: REF, name: 'other machine', release: null, trackers: [] }, new Date(T0.getTime() - 9 * day));
    const stale = await repo.stale('host-a', new Date(T0.getTime() - 7 * day));
    expect(stale.map((r) => r.name)).toEqual(['never played']);
  });

  it('shows the other machine\'s download with available: false and serves none of it', async () => {
    await repo.record('host-b', { infoHash: HASH, ref: REF, name: NAME, release: null, trackers: [] }, T0);
    const here = streams('host-a');
    expect(await here.view(HASH)).toMatchObject({ host: 'host-b', available: false, file_url: null });
    const res = await here.serve(HASH, 0, null);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'not_on_this_machine', host: 'host-b' });
    expect((await here.list()).map((v) => v.available)).toEqual([false]);
  });

  it('plays a finished download from disk after a restart, with no swarm (R2.9)', async () => {
    const file = `${NAME}/${NAME}.mp4`;
    await repo.record('host-a', { infoHash: HASH, ref: REF, name: NAME, release: null, trackers: [] }, T0);
    await repo.chosen('host-a', SLOT, { files: [{ index: 1, path: file, length: VIDEO.length }], fileIndex: 1, fileLength: VIDEO.length }, T0);
    await repo.ready('host-a', SLOT, VIDEO.length, T0);
    const folder = new TorrentFolder(root);
    const onDisk = folder.diskPath(HASH, file)!;
    await mkdir(path.dirname(onDisk), { recursive: true });
    await writeFile(onDisk, VIDEO);
    const engine = new FakeTorrentEngine([]);
    const restarted = streams('host-a', engine);
    expect(await restarted.find(REF)).toMatchObject({ infoHash: HASH, fileIndex: 1, state: 'ready' });
    const handle = await restarted.open({ infoHash: HASH, trackers: [], name: null, ref: REF }, { timeoutMs: 1_000 });
    expect(handle.live).toBe(false);
    const res = await restarted.serve(HASH, 1, 'bytes=2990-');
    expect(res.status).toBe(206);
    expect(Buffer.from(await res.arrayBuffer()).equals(VIDEO.subarray(2990))).toBe(true);
    expect(engine.added).toEqual([]);
    // A read of the file is no play; the player page's report marks it.
    expect((await repo.get('host-a', HASH))?.playedAt).toBeNull();
    await restarted.played(HASH);
    expect((await repo.get('host-a', HASH))?.playedAt).toEqual(T0);
  });
});
