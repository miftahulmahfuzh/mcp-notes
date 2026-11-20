import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TorrentStreams } from '../../../../src/directStream/torrent/service.js';
import { TorrentFolder } from '../../../../src/directStream/torrent/store.js';
import { PREVIEWS_DIR } from '../../../../src/directStream/torrent/usage.js';
import { FakeTorrentEngine } from '../../../helpers/fakeTorrentEngine.js';
import { MemoryTorrentRecords } from '../../../helpers/memoryTorrentRecords.js';

const HOST = 'host-a';
const PACK = 'aaaa'.padEnd(40, '1');
const FILM = 'bbbb'.padEnd(40, '2');
const KIB = 1024;
const MIB = 1024 * KIB;
const DAY = 86_400_000;
const SHOW = 'Show.S01';

let root: string;
let clock: number;

function build(records: MemoryTorrentRecords, options: { budgetBytes?: number } = {}) {
  const folder = new TorrentFolder(root);
  const streams = new TorrentStreams({
    engine: new FakeTorrentEngine(),
    repo: records,
    folder,
    host: HOST,
    uploadKbps: 100,
    keepDays: 7,
    discovery: true,
    ...(options.budgetBytes === undefined ? {} : { budgetBytes: options.budgetBytes }),
    now: () => new Date(clock),
    log: () => undefined,
    every: () => () => undefined,
  });
  return { streams, folder };
}

async function put(file: string, bytes: number): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.alloc(bytes, 7));
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** Bytes on disk the way TorrentFolder counts them (blocks). */
async function blocks(file: string): Promise<number> {
  const s = await stat(file);
  return s.blocks > 0 ? s.blocks * 512 : s.size;
}

const sheet = (hash: string, index: number, name: string): string => path.join(root, hash, PREVIEWS_DIR, String(index), name);

/** A film: one whole video with its sheets (an index and one sheet) under notesd-previews/0/. */
async function seedFilm(records: MemoryTorrentRecords, folder: TorrentFolder, o: { videoBytes: number; sheetBytes: number; madeAt: Date }): Promise<void> {
  const slot = { infoHash: FILM, season: 0, episode: 0 };
  await records.record(HOST, { infoHash: FILM, ref: { kind: 'movie', tmdbId: 77 }, name: 'Film', release: 'Film', trackers: [] }, o.madeAt);
  await records.chosen(HOST, slot, { files: [{ index: 0, path: 'Film/Film.mp4', length: o.videoBytes }], fileIndex: 0, fileLength: o.videoBytes }, o.madeAt);
  await records.ready(HOST, slot, o.videoBytes, o.madeAt);
  await put(folder.diskPath(FILM, 'Film/Film.mp4')!, o.videoBytes);
  await put(sheet(FILM, 0, 'sheet-00000.jpg'), o.sheetBytes);
  await put(sheet(FILM, 0, 'previews.json'), KIB);
}

/** A season pack with E01 (file 0) and E02 (file 1) chosen and whole, each with its own sheets. */
async function seedPack(records: MemoryTorrentRecords, folder: TorrentFolder, madeAt: Date): Promise<void> {
  const files = [
    { index: 0, path: `${SHOW}/Show.S01E01.mkv`, length: 64 * KIB },
    { index: 1, path: `${SHOW}/Show.S01E02.mkv`, length: 32 * KIB },
  ];
  for (const [episode, video] of [
    [1, 0],
    [2, 1],
  ] as const) {
    await records.record(HOST, { infoHash: PACK, ref: { kind: 'tv', tmdbId: 500, season: 1, episode }, name: SHOW, release: SHOW, trackers: [] }, madeAt);
    const slot = { infoHash: PACK, season: 1, episode };
    await records.chosen(HOST, slot, { files: [files[video]!], fileIndex: video, fileLength: files[video]!.length }, madeAt);
    await records.ready(HOST, slot, files[video]!.length, madeAt);
    await put(folder.diskPath(PACK, files[video]!.path)!, files[video]!.length);
    await put(sheet(PACK, video, 'sheet-00000.jpg'), (24 + 8 * video) * KIB);
    await put(sheet(PACK, video, 'previews.json'), KIB);
  }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'torrent-previews-'));
  clock = Date.parse('2026-11-20T12:00:00Z');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('the preview sheets of a torrent download (R2.5)', () => {
  it("counts each episode's sheets in that episode's size, and a film's in the film's", async () => {
    const records = new MemoryTorrentRecords();
    const { streams, folder } = build(records);
    await seedPack(records, folder, new Date(clock - DAY));
    await seedFilm(records, folder, { videoBytes: 128 * KIB, sheetBytes: 16 * KIB, madeAt: new Date(clock - DAY) });
    const e1 = (await blocks(folder.diskPath(PACK, `${SHOW}/Show.S01E01.mkv`)!)) + (await blocks(sheet(PACK, 0, 'sheet-00000.jpg'))) + (await blocks(sheet(PACK, 0, 'previews.json')));
    const e2 = (await blocks(folder.diskPath(PACK, `${SHOW}/Show.S01E02.mkv`)!)) + (await blocks(sheet(PACK, 1, 'sheet-00000.jpg'))) + (await blocks(sheet(PACK, 1, 'previews.json')));
    const film = (await blocks(folder.diskPath(FILM, 'Film/Film.mp4')!)) + (await blocks(sheet(FILM, 0, 'sheet-00000.jpg'))) + (await blocks(sheet(FILM, 0, 'previews.json')));
    const usage = await streams.diskUsage();
    const pack = usage.torrents.find((t) => t.infoHash === PACK)!.usage;
    expect(pack.slots.get('1x1')).toBe(e1);
    expect(pack.slots.get('1x2')).toBe(e2);
    expect(pack.shared).toBe(0);
    expect(usage.torrents.find((t) => t.infoHash === FILM)!.usage.total).toBe(film);
    expect(await folder.size(FILM)).toBe(film);
  });

  it("deleting one episode takes its sheets and leaves the other episode's", async () => {
    const records = new MemoryTorrentRecords();
    const { streams, folder } = build(records);
    await seedPack(records, folder, new Date(clock - DAY));
    const e1 = (await blocks(folder.diskPath(PACK, `${SHOW}/Show.S01E01.mkv`)!)) + (await blocks(sheet(PACK, 0, 'sheet-00000.jpg'))) + (await blocks(sheet(PACK, 0, 'previews.json')));
    expect(await streams.removeSlots(PACK, [{ season: 1, episode: 1 }])).toBe(e1);
    expect(await exists(path.join(root, PACK, PREVIEWS_DIR, '0'))).toBe(false);
    expect(await exists(sheet(PACK, 1, 'sheet-00000.jpg'))).toBe(true);
    expect(await exists(sheet(PACK, 1, 'previews.json'))).toBe(true);
  });

  it('deleting the last episode, or a whole film, takes the whole folder with every sheet in it', async () => {
    const records = new MemoryTorrentRecords();
    const { streams, folder } = build(records);
    await seedPack(records, folder, new Date(clock - DAY));
    await seedFilm(records, folder, { videoBytes: 128 * KIB, sheetBytes: 16 * KIB, madeAt: new Date(clock - DAY) });
    await streams.removeSlots(PACK, [{ season: 1, episode: 1 }]);
    await streams.removeSlots(PACK, [{ season: 1, episode: 2 }]);
    expect(await exists(path.join(root, PACK))).toBe(false);
    await streams.removeSlots(FILM, [{ season: 0, episode: 0 }]);
    expect(await exists(path.join(root, FILM))).toBe(false);
  });

  it('the budget counts the sheets and clears a torrent with them', async () => {
    const records = new MemoryTorrentRecords();
    const { streams, folder } = build(records, { budgetBytes: 2 * MIB });
    // 1 MiB of film is under the 2 MiB budget; with 2 MiB of sheets it is over.
    await seedFilm(records, folder, { videoBytes: MIB, sheetBytes: 2 * MIB, madeAt: new Date(clock - DAY) });
    expect(await streams.prune()).toBe(1);
    expect(await exists(path.join(root, FILM))).toBe(false);
    expect(records.rows).toEqual([]);
  });

  it('a download cleared after keepDays goes with its sheets', async () => {
    const records = new MemoryTorrentRecords();
    const { streams, folder } = build(records);
    await seedFilm(records, folder, { videoBytes: 64 * KIB, sheetBytes: 16 * KIB, madeAt: new Date(clock - 10 * DAY) });
    expect(await streams.prune()).toBe(1);
    expect(await exists(path.join(root, FILM))).toBe(false);
  });
});
