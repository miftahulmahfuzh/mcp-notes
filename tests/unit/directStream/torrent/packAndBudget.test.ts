import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TorrentStreams } from '../../../../src/directStream/torrent/service.js';
import { TorrentFolder } from '../../../../src/directStream/torrent/store.js';
import type { TorrentPick } from '../../../../src/directStream/torrent/types.js';
import type { StreamRef } from '../../../../src/directStream/types.js';
import { FakeTorrentEngine } from '../../../helpers/fakeTorrentEngine.js';
import { MemoryTorrentRecords } from '../../../helpers/memoryTorrentRecords.js';

const PACK = 'facade'.padEnd(40, '0');
const SHOW = 'Fixture.Show.S01.1080p';
const episodeData = (seed: number): Buffer => Buffer.from(Array.from({ length: 4096 }, (_, i) => (i + seed) % 251));
const PACK_FILES = [
  { path: `${SHOW}/Fixture.Show.S01E01.mp4`, data: episodeData(1) },
  { path: `${SHOW}/Fixture.Show.S01E02.mp4`, data: episodeData(2) },
  { path: `${SHOW}/Fixture.Show.S01E03.mp4`, data: episodeData(3) },
];
const ep = (episode: number): StreamRef => ({ kind: 'tv', tmdbId: 1399, season: 1, episode });
const pick = (episode: number): TorrentPick => ({ infoHash: PACK, trackers: [], name: SHOW, ref: ep(episode) });
const OPEN = { timeoutMs: 1_000 };
const DAY = 86_400_000;
const MIB = 1_048_576;

let root: string;
let clock: number;

function build(options: { records?: MemoryTorrentRecords; engine?: FakeTorrentEngine; budgetBytes?: number; marked?: string[] } = {}) {
  const records = options.records ?? new MemoryTorrentRecords();
  const engine = options.engine ?? new FakeTorrentEngine([{ infoHash: PACK, name: SHOW, files: PACK_FILES }]);
  const folder = new TorrentFolder(root);
  const lines: string[] = [];
  const streams = new TorrentStreams({
    engine,
    repo: records,
    folder,
    host: 'host-a',
    uploadKbps: 100,
    keepDays: 7,
    discovery: true,
    ...(options.budgetBytes === undefined ? {} : { budgetBytes: options.budgetBytes }),
    ...(options.marked === undefined ? {} : { marked: async (ids: readonly string[]) => new Set(ids.filter((id) => options.marked!.includes(id))) }),
    now: () => new Date(clock),
    log: (line) => lines.push(line),
    every: () => () => undefined,
  });
  return { streams, engine, records, folder, lines };
}

async function put(folder: TorrentFolder, hash: string, filePath: string, data: Buffer | string): Promise<void> {
  const file = folder.diskPath(hash, filePath)!;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data);
}

/** A torrent of this host with `mib` MiB on disk (and a remux segment of 1 MiB, which counts too). */
async function download(records: MemoryTorrentRecords, folder: TorrentFolder, hash: string, name: string, o: { mib: number; madeAt: number; playedAt?: number; tmdbId?: number }): Promise<void> {
  const slot = { infoHash: hash, season: 0, episode: 0 };
  await records.record('host-a', { infoHash: hash, ref: { kind: 'movie', tmdbId: o.tmdbId ?? 7 }, name, release: null, trackers: [] }, new Date(o.madeAt));
  await records.chosen('host-a', slot, { files: [{ index: 0, path: `${name}/${name}.mkv`, length: o.mib * MIB }], fileIndex: 0, fileLength: o.mib * MIB }, new Date(o.madeAt));
  await records.ready('host-a', slot, o.mib * MIB, new Date(o.madeAt));
  if (o.playedAt !== undefined) await records.played('host-a', slot, new Date(o.playedAt));
  await put(folder, hash, `${name}/${name}.mkv`, Buffer.alloc((o.mib - 1) * MIB, 1));
  await put(folder, hash, 'notesd-remux/0/seg-00000.m4s', Buffer.alloc(MIB, 2));
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'torrent-pack-'));
  clock = Date.parse('2026-11-20T12:00:00Z');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('a season pack', () => {
  it('keeps E01 on disk when E02 of the same pack is watched after it, each episode its own ready row', async () => {
    const { streams, engine, records, folder } = build();
    // E01 is watched and finishes.
    await streams.open(pick(1), OPEN);
    await streams.use(PACK, [0]);
    engine.have(PACK, 0);
    await put(folder, PACK, PACK_FILES[0]!.path, PACK_FILES[0]!.data);
    await streams.tick();
    await streams.release(PACK);
    expect(engine.removed).toEqual([PACK]);
    // E02 of the same pack: the swarm is joined again, E02 chosen and finished.
    clock += 60 * 60_000;
    await streams.open(pick(2), OPEN);
    await streams.use(PACK, [1]);
    engine.have(PACK, 1);
    await put(folder, PACK, PACK_FILES[1]!.path, PACK_FILES[1]!.data);
    await put(folder, PACK, PACK_FILES[2]!.path, 'edge bytes of a piece E03 shares');
    await streams.tick();
    await streams.release(PACK);
    // E01's file was chosen by its own row, so leaving E02's swarm keeps it; only E03's edge bytes go.
    expect((await readdir(path.join(folder.dirOf(PACK), SHOW))).sort()).toEqual(['Fixture.Show.S01E01.mp4', 'Fixture.Show.S01E02.mp4']);
    expect(records.rows.map((r) => [r.episode, r.fileIndex, r.state]).sort()).toEqual([
      [1, 0, 'ready'],
      [2, 1, 'ready'],
    ]);
    expect(await streams.find(ep(1))).toMatchObject({ infoHash: PACK, fileIndex: 0, state: 'ready' });
    expect(await streams.find(ep(2))).toMatchObject({ infoHash: PACK, fileIndex: 1, state: 'ready' });
    // E01 plays again from disk with no swarm.
    const again = await streams.open(pick(1), OPEN);
    expect(again.live).toBe(false);
    expect(again.files.map((f) => f.index)).toEqual([0]);
    expect(await streams.filePath(PACK, 0)).toBe(folder.diskPath(PACK, PACK_FILES[0]!.path));
  });

  it('fetches E02 ahead beside E01 on screen: each episode is finished, marked played and timed on its own', async () => {
    const { streams, engine, records, folder } = build();
    await streams.open(pick(1), OPEN);
    await streams.use(PACK, [0]);
    // The next episode, fetched ahead into the same torrent while E01 plays.
    await streams.open(pick(2), OPEN);
    await streams.use(PACK, [1]);
    expect(engine.added).toEqual([PACK]);
    expect(engine.selected.map((s) => s.indexes)).toEqual([[0], [1]]);
    await streams.played(PACK, 0);
    await streams.setDuration(PACK, 1200, 0);
    await streams.setDuration(PACK, 1300, 1);
    engine.have(PACK, 0);
    await put(folder, PACK, PACK_FILES[0]!.path, PACK_FILES[0]!.data);
    await streams.tick();
    const e1 = records.rows.find((r) => r.episode === 1);
    const e2 = records.rows.find((r) => r.episode === 2);
    expect(e1).toMatchObject({ fileIndex: 0, state: 'ready', durationS: 1200 });
    expect(e1?.playedAt?.getTime()).toBe(clock);
    expect(e2).toMatchObject({ fileIndex: 1, state: 'downloading', durationS: 1300, playedAt: null });
    // The map follows the episode on screen, not the one fetched ahead.
    expect(await streams.map(PACK)).toMatchObject({ duration_s: 1200, length: 4096, byte_ranges: [[0, 4096]] });
    // A reload of E01 takes the torrent again: its files stay E01's, E02's row is untouched.
    await streams.use(PACK, [0]);
    expect(records.rows.find((r) => r.episode === 2)).toMatchObject({ fileIndex: 1, files: [{ index: 1 }] });
    await streams.release(PACK);
    await streams.release(PACK);
    await streams.release(PACK);
    expect(engine.deselected.at(-1)?.indexes).toEqual([1]);
  });

  it('keeps the existing rows of a pack when another episode is opened, and a film opened for another title forgets its choice', async () => {
    const records = new MemoryTorrentRecords();
    const at = new Date(clock);
    await records.record('host-a', { infoHash: PACK, ref: ep(1), name: SHOW, release: null, trackers: [] }, at);
    await records.record('host-a', { infoHash: PACK, ref: ep(2), name: SHOW, release: null, trackers: [] }, at);
    expect(records.rows).toHaveLength(2);
    await records.record('host-a', { infoHash: PACK, ref: ep(1), name: SHOW, release: null, trackers: [] }, at);
    expect(records.rows).toHaveLength(2);
    await records.delete('host-a', PACK);
    expect(records.rows).toEqual([]);
  });
});

describe('the torrent budget', () => {
  it('deletes never-played torrents first, then the least recently played, until the folder is under the budget', async () => {
    const records = new MemoryTorrentRecords();
    const folder = new TorrentFolder(root);
    const NEVER = 'a1'.repeat(20);
    const OLD = 'b2'.repeat(20);
    const LATER = 'c3'.repeat(20);
    await download(records, folder, NEVER, 'Never.Played', { mib: 4, madeAt: clock - 3 * DAY });
    await download(records, folder, OLD, 'Played.Long.Ago', { mib: 4, madeAt: clock - 6 * DAY, playedAt: clock - 5 * DAY });
    await download(records, folder, LATER, 'Played.Lately', { mib: 4, madeAt: clock - 6 * DAY, playedAt: clock - 2 * DAY });
    const { streams, lines } = build({ records, budgetBytes: 5 * MIB });
    expect(await streams.prune()).toBe(2);
    expect((await readdir(root)).sort()).toEqual([LATER]);
    expect(records.rows.map((r) => r.infoHash)).toEqual([LATER]);
    expect(lines.filter((l) => l.includes('budget'))).toEqual([
      '[notesd] torrent: cleared Never.Played (4 MB, never played): the downloads took more than the 5 MB budget, 8 MB now',
      '[notesd] torrent: cleared Played.Long.Ago (4 MB, last played 2026-11-15): the downloads took more than the 5 MB budget, 4 MB now',
    ]);
  });

  it('deletes the downloads of titles marked watched or not interested first, even one played today', async () => {
    const records = new MemoryTorrentRecords();
    const folder = new TorrentFolder(root);
    const NEVER = 'a1'.repeat(20);
    const SEEN = 'b2'.repeat(20);
    await download(records, folder, NEVER, 'Never.Played', { mib: 4, madeAt: clock - 3 * DAY, tmdbId: 1 });
    await download(records, folder, SEEN, 'Watched.Today', { mib: 4, madeAt: clock - DAY, playedAt: clock - 60_000, tmdbId: 2 });
    const { streams, lines } = build({ records, budgetBytes: 5 * MIB, marked: ['movie-2'] });
    expect(await streams.prune()).toBe(1);
    expect((await readdir(root)).sort()).toEqual([NEVER]);
    expect(lines.filter((l) => l.includes('budget'))).toEqual([
      '[notesd] torrent: cleared Watched.Today (4 MB, watched or not interested, last played 2026-11-20): the downloads took more than the 5 MB budget, 4 MB now',
    ]);
  });

  it('keeps what was played or finished in the last 24 h until nothing else is left, and never a torrent in use', async () => {
    const records = new MemoryTorrentRecords();
    const folder = new TorrentFolder(root);
    const FRESH = 'd4'.repeat(20);
    const OLDER = 'e5'.repeat(20);
    const RECENT = '7a'.repeat(20);
    // Fetched ahead two hours ago and not watched yet; watched five days ago; watched last night.
    await download(records, folder, FRESH, 'Fetched.Ahead', { mib: 4, madeAt: clock - 2 * 3_600_000 });
    await download(records, folder, OLDER, 'Watched.Last.Week', { mib: 4, madeAt: clock - 6 * DAY, playedAt: clock - 5 * DAY });
    await download(records, folder, RECENT, 'Watched.Last.Night', { mib: 4, madeAt: clock - 2 * DAY, playedAt: clock - 10 * 3_600_000 });
    // 12 MiB over 9: only the week-old one goes, though the fresh one was never played.
    expect(await build({ records, budgetBytes: 9 * MIB }).streams.prune()).toBe(1);
    expect((await readdir(root)).sort()).toEqual([FRESH, RECENT].sort());
    // A pack in use, 4 MiB of it on disk, and a 3 MiB budget: the recent ones go too, last night's last; the pack stays.
    const engine = new FakeTorrentEngine([{ infoHash: PACK, name: SHOW, files: PACK_FILES }]);
    const { streams, lines } = build({ records, engine, budgetBytes: 3 * MIB });
    await streams.open(pick(1), OPEN);
    await streams.use(PACK, [0]);
    await put(folder, PACK, PACK_FILES[0]!.path, Buffer.alloc(4 * MIB, 3));
    expect(await streams.prune()).toBe(2);
    expect(await readdir(root)).toEqual([PACK]);
    expect(lines.filter((l) => l.includes('budget'))).toEqual([
      '[notesd] torrent: cleared Fetched.Ahead (4 MB, never played): the downloads took more than the 3 MB budget, 8 MB now',
      '[notesd] torrent: cleared Watched.Last.Night (4 MB, last played 2026-11-20): the downloads took more than the 3 MB budget, 4 MB now',
      '[notesd] torrent: the downloads take 4 MB, over the 3 MB budget, and what is left is in use',
    ]);
    expect(records.rows.map((r) => r.infoHash)).toEqual([PACK]);
  });

  it('runs after a download is finished', async () => {
    const records = new MemoryTorrentRecords();
    const folder = new TorrentFolder(root);
    const OLD = 'f6'.repeat(20);
    await download(records, folder, OLD, 'Old.Film', { mib: 4, madeAt: clock - 6 * DAY, playedAt: clock - 5 * DAY });
    const { streams, engine, lines } = build({ records, budgetBytes: 4 * MIB });
    // At start the 4 MiB fit the budget; the tick itself does not prune again for 6 h.
    expect(await streams.start()).toBe(0);
    await streams.open(pick(1), OPEN);
    await streams.use(PACK, [0]);
    engine.have(PACK, 0);
    await put(folder, PACK, PACK_FILES[0]!.path, Buffer.alloc(MIB, 4));
    await streams.tick();
    await streams.prune(); // waits for the prune the finish started
    expect(await readdir(root)).toEqual([PACK]);
    expect(lines.some((l) => l.includes('cleared Old.Film'))).toBe(true);
  });
});
