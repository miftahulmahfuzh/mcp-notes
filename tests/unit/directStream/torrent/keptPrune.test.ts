import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TorrentStreams } from '../../../../src/directStream/torrent/service.js';
import { TorrentFolder } from '../../../../src/directStream/torrent/store.js';
import { FakeTorrentEngine } from '../../../helpers/fakeTorrentEngine.js';
import { MemoryTorrentRecords } from '../../../helpers/memoryTorrentRecords.js';

const DAY = 86_400_000;
const MIB = 1_048_576;
let root: string;
let clock: number;

function build(records: MemoryTorrentRecords, budgetBytes?: number) {
  const lines: string[] = [];
  const streams = new TorrentStreams({
    engine: new FakeTorrentEngine([]),
    repo: records,
    folder: new TorrentFolder(root),
    host: 'host-a',
    uploadKbps: 100,
    keepDays: 7,
    discovery: true,
    ...(budgetBytes === undefined ? {} : { budgetBytes }),
    now: () => new Date(clock),
    log: (line) => void lines.push(line),
    every: () => () => undefined,
  });
  return { streams, lines };
}

/** A ready film download of this host with `mib` MiB on disk, made `madeAt` (never played unless `playedAt`). */
async function download(records: MemoryTorrentRecords, hash: string, name: string, o: { mib: number; madeAt: number; playedAt?: number }): Promise<void> {
  const slot = { infoHash: hash, season: 0, episode: 0 };
  await records.record('host-a', { infoHash: hash, ref: { kind: 'movie', tmdbId: 7 }, name, release: null, trackers: [] }, new Date(o.madeAt));
  await records.chosen('host-a', slot, { files: [{ index: 0, path: `${name}/${name}.mkv`, length: o.mib * MIB }], fileIndex: 0, fileLength: o.mib * MIB }, new Date(o.madeAt));
  await records.ready('host-a', slot, o.mib * MIB, new Date(o.madeAt));
  if (o.playedAt !== undefined) await records.played('host-a', slot, new Date(o.playedAt));
  const file = new TorrentFolder(root).diskPath(hash, `${name}/${name}.mkv`)!;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.alloc(o.mib * MIB, 1));
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'torrent-kept-'));
  clock = Date.parse('2026-11-20T12:00:00Z');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('R1.6 a download the owner keeps survives both prunes', () => {
  it('is not cleared by age, though never played for a month', async () => {
    const records = new MemoryTorrentRecords();
    const KEPT = 'a1'.repeat(20);
    const OLD = 'b2'.repeat(20);
    await download(records, KEPT, 'Kept.Film', { mib: 1, madeAt: clock - 30 * DAY });
    await download(records, OLD, 'Old.Film', { mib: 1, madeAt: clock - 30 * DAY });
    const { streams } = build(records);
    await streams.keep(KEPT, true);
    expect(await streams.prune()).toBe(1);
    expect(await readdir(root)).toEqual([KEPT]);
    expect(records.rows.map((r) => [r.infoHash, r.keptAt?.getTime() ?? null])).toEqual([[KEPT, clock]]);
  });

  it('is not cleared by the budget, which deletes the others first and says what is kept', async () => {
    const records = new MemoryTorrentRecords();
    const KEPT = 'c3'.repeat(20);
    const PLAYED = 'd4'.repeat(20);
    await download(records, KEPT, 'Kept.Film', { mib: 4, madeAt: clock - 3 * DAY });
    await download(records, PLAYED, 'Played.Film', { mib: 4, madeAt: clock - 2 * DAY, playedAt: clock - 60_000 });
    const { streams, lines } = build(records, 3 * MIB);
    await streams.keep(KEPT, true);
    expect(await streams.prune()).toBe(1);
    expect(await readdir(root)).toEqual([KEPT]);
    expect(lines.filter((l) => l.includes('budget')).at(-1)).toBe(
      '[notesd] torrent: the downloads take 4 MB, over the 3 MB budget, and what is left is in use or kept by the owner (1 kept download, 4 MB)',
    );
  });

  it('prunes like any other once the mark is cleared', async () => {
    const records = new MemoryTorrentRecords();
    const KEPT = 'e5'.repeat(20);
    await download(records, KEPT, 'Was.Kept', { mib: 1, madeAt: clock - 30 * DAY });
    const { streams } = build(records);
    await streams.keep(KEPT, true);
    await streams.keep(KEPT, false);
    expect(await streams.prune()).toBe(1);
    expect(await readdir(root)).toEqual([]);
  });
});
