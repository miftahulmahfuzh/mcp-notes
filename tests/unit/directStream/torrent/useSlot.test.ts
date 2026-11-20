import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TorrentStreams } from '../../../../src/directStream/torrent/service.js';
import { TorrentFolder } from '../../../../src/directStream/torrent/store.js';
import { TorrentError, type TorrentPick } from '../../../../src/directStream/torrent/types.js';
import type { StreamRef } from '../../../../src/directStream/types.js';
import { FakeTorrentEngine } from '../../../helpers/fakeTorrentEngine.js';
import { MemoryTorrentRecords } from '../../../helpers/memoryTorrentRecords.js';

const PACK = 'facade'.padEnd(40, '1');
const SHOW = 'Fixture.Show.S01.1080p';
const data = (seed: number): Buffer => Buffer.from(Array.from({ length: 4096 }, (_, i) => (i + seed) % 251));
const FILES = [
  { path: `${SHOW}/Fixture.Show.S01E01.mp4`, data: data(1) },
  { path: `${SHOW}/Fixture.Show.S01E02.mp4`, data: data(2) },
  { path: `${SHOW}/Fixture.Show.S01E03.mp4`, data: data(3) },
  { path: `${SHOW}/setup.exe`, data: data(4) },
];
const ep = (episode: number): StreamRef => ({ kind: 'tv', tmdbId: 1399, season: 1, episode });
const pick = (episode: number): TorrentPick => ({ infoHash: PACK, trackers: [], name: SHOW, ref: ep(episode) });
const OPEN = { timeoutMs: 1_000 };

let root: string;

function build() {
  const records = new MemoryTorrentRecords();
  const engine = new FakeTorrentEngine([{ infoHash: PACK, name: SHOW, files: FILES }]);
  const streams = new TorrentStreams({
    engine,
    repo: records,
    folder: new TorrentFolder(root),
    host: 'host-a',
    uploadKbps: 100,
    keepDays: 7,
    discovery: true,
    now: () => new Date('2026-11-20T12:00:00Z'),
    log: () => undefined,
    every: () => () => undefined,
  });
  return { streams, engine, records };
}

const rowsOf = async (records: MemoryTorrentRecords): Promise<[number, number | null][]> =>
  (await records.slots('host-a', PACK)).map((r): [number, number | null] => [r.episode, r.fileIndex]).sort((a, b) => a[0] - b[0]);

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'torrent-slot-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('TorrentStreams.useSlot', () => {
  it('takes each episode of a pack in the swarm under its own row, one hold each, with one open', async () => {
    const { streams, engine, records } = build();
    await streams.open(pick(1), OPEN);
    await streams.useSlot(pick(1), [0]);
    await streams.useSlot(pick(2), [1]);
    await streams.useSlot(pick(3), [2]);
    expect(engine.added).toEqual([PACK]);
    expect(await rowsOf(records)).toEqual([[1, 0], [2, 1], [3, 2]]);
    expect(streams.status().swarm.find((s) => s.info_hash === PACK)?.users).toBe(3);
  });

  it('gives a double episode (one file, two episodes) a row per episode, where `use` would put both on the first', async () => {
    const { streams, records } = build();
    await streams.open(pick(1), OPEN);
    await streams.useSlot(pick(1), [0]);
    await streams.useSlot(pick(2), [0]);
    expect(await rowsOf(records)).toEqual([[1, 0], [2, 0]]);
  });

  it('refuses a file that is neither a video nor a subtitle, and a torrent not opened', async () => {
    const { streams } = build();
    await expect(streams.useSlot(pick(1), [0])).rejects.toMatchObject({ code: 'not_open' });
    await streams.open(pick(1), OPEN);
    await expect(streams.useSlot(pick(1), [3])).rejects.toBeInstanceOf(TorrentError);
    await expect(streams.useSlot(pick(1), [3])).rejects.toMatchObject({ code: 'not_media' });
  });
});

describe('TorrentStreams.releaseSlot', () => {
  it("stops one episode's own files and gives back its hold; the other episodes go on", async () => {
    const { streams, engine, records } = build();
    await streams.open(pick(1), OPEN);
    for (const e of [1, 2, 3]) await streams.useSlot(pick(e), [e - 1]);
    await streams.releaseSlot(PACK, ep(2));
    expect(engine.deselected).toEqual([{ infoHash: PACK, indexes: [1] }]);
    expect(streams.status().swarm.find((s) => s.info_hash === PACK)?.users).toBe(2);
    expect(await rowsOf(records)).toEqual([[1, 0], [2, 1], [3, 2]]);
    expect(engine.removed).toEqual([]);
  });
});
