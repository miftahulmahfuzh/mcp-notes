import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../../src/config.js';
import type { Db } from '../../../../src/db/client.js';
import { buildTorrentStreams, TorrentStreams } from '../../../../src/directStream/torrent/service.js';
import { TorrentFolder } from '../../../../src/directStream/torrent/store.js';
import type { TorrentPick } from '../../../../src/directStream/torrent/types.js';
import { FakeTorrentEngine } from '../../../helpers/fakeTorrentEngine.js';
import { MemoryTorrentRecords } from '../../../helpers/memoryTorrentRecords.js';

const HASH = 'c0ffee'.padEnd(40, '0');
const NAME = 'Fixture.Film.2026';
const VIDEO = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251));
const SRT = Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nHello\n');
const EXE = Buffer.from('MZ inert bytes: never fetched, never run');
const FILES = [
  { path: `${NAME}/${NAME}.en.srt`, data: SRT },
  { path: `${NAME}/${NAME}.mp4`, data: VIDEO },
  { path: `${NAME}/setup.exe`, data: EXE },
];
const REF = { kind: 'movie', tmdbId: 550 } as const;
const PICK: TorrentPick = { infoHash: HASH.toUpperCase(), trackers: ['udp://tracker.example:1337/announce'], name: `${NAME}.1080p.WEB-DL`, ref: REF };
const OPEN = { timeoutMs: 1_000 };
const MIN = 60_000;

let root: string;
let clock: number;

function build(options: { host?: string; records?: MemoryTorrentRecords; engine?: FakeTorrentEngine } = {}) {
  const records = options.records ?? new MemoryTorrentRecords();
  const engine = options.engine ?? new FakeTorrentEngine([{ infoHash: HASH, name: NAME, files: FILES }]);
  const folder = new TorrentFolder(root);
  const streams = new TorrentStreams({
    engine,
    repo: records,
    folder,
    host: options.host ?? 'host-a',
    uploadKbps: 100,
    keepDays: 7,
    discovery: true,
    now: () => new Date(clock),
    log: () => undefined,
    every: () => () => undefined,
  });
  return { streams, engine, records, folder };
}

async function put(folder: TorrentFolder, filePath: string, data: Buffer | string): Promise<void> {
  const file = folder.diskPath(HASH, filePath)!;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data);
}

async function onDisk(folder: TorrentFolder): Promise<string[]> {
  const walk = async (dir: string): Promise<string[]> => {
    const out: string[] = [];
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...(await walk(full)));
      else out.push(path.relative(folder.dirOf(HASH), full));
    }
    return out;
  };
  return (await walk(folder.dirOf(HASH))).sort();
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'torrents-'));
  clock = Date.parse('2026-11-16T12:00:00Z');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('TorrentStreams', () => {
  it('opens a torrent with nothing chosen and records it downloading', async () => {
    const { streams, engine, records } = build();
    const handle = await streams.open(PICK, OPEN);
    expect(handle.live).toBe(true);
    expect(handle.files.map((f) => f.path)).toEqual(FILES.map((f) => f.path));
    expect(engine.added).toEqual([HASH]);
    expect(engine.selected).toEqual([]);
    expect(await streams.open(PICK, OPEN)).toBe(handle);
    expect(records.rows).toMatchObject([{ host: 'host-a', infoHash: HASH, name: NAME, release: `${NAME}.1080p.WEB-DL`, state: 'downloading', fileIndex: null }]);
    expect(streams.status()).toMatchObject({ port: 6881, swarm: [{ info_hash: HASH, users: 0 }] });
  });

  it('downloads only the video and subtitle files it is asked to use (R2.2)', async () => {
    const { streams, engine, records } = build();
    await streams.open(PICK, OPEN);
    await expect(streams.use(HASH, [2])).rejects.toMatchObject({ code: 'not_media' });
    await expect(streams.use(HASH, [1, 7])).rejects.toMatchObject({ code: 'not_media' });
    expect(engine.selected).toEqual([]);
    await streams.use(HASH, [1, 0]);
    expect(engine.selected).toEqual([{ infoHash: HASH, indexes: [1, 0] }]);
    expect(records.rows[0]).toMatchObject({ fileIndex: 1, fileLength: VIDEO.length, files: [{ index: 1 }, { index: 0 }] });
    const exe = await streams.serve(HASH, 2, null);
    expect(exe.status).toBe(404);
    expect(await exe.json()).toMatchObject({ error: 'not_selected' });
  });

  it('answers a byte range of a chosen file with exactly those bytes, read through the swarm (R2.1)', async () => {
    const { streams, engine } = build();
    await streams.open(PICK, OPEN);
    await streams.use(HASH, [1]);
    const res = await streams.serve(HASH, 1, 'bytes=3686-3785');
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 3686-3785/${VIDEO.length}`);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await res.arrayBuffer()).equals(VIDEO.subarray(3686, 3786))).toBe(true);
    expect(engine.reads).toEqual([{ infoHash: HASH, index: 1, start: 3686, end: 3785 }]);
    expect((await streams.serve(HASH, 1, 'bytes=9000-')).status).toBe(416);
    expect(await streams.map(HASH)).toEqual({ duration_s: null, ranges: [], length: VIDEO.length, byte_ranges: [[3686, 3786]] });
    await streams.setDuration(HASH, 100);
    expect((await streams.map(HASH))?.ranges).toEqual([[90, 92.4]]);
  });

  it('leaves the swarm at once when a finished download is released, keeping only the chosen files (R2.3)', async () => {
    const { streams, engine, records, folder } = build();
    await streams.open(PICK, OPEN);
    await streams.use(HASH, [1, 0]);
    engine.have(HASH, 1);
    engine.have(HASH, 0);
    await put(folder, FILES[0]!.path, SRT);
    await put(folder, FILES[1]!.path, VIDEO);
    await put(folder, FILES[2]!.path, 'edge bytes of a shared piece');
    await mkdir(path.join(folder.dirOf(HASH), '.notesd-subs'), { recursive: true });
    await writeFile(path.join(folder.dirOf(HASH), '.notesd-subs', 'en.vtt'), 'WEBVTT');
    await streams.tick();
    expect(records.rows[0]).toMatchObject({ state: 'ready', bytesDone: VIDEO.length });
    expect(engine.removed).toEqual([]);
    await streams.release(HASH);
    expect(engine.removed).toEqual([HASH]);
    expect(streams.status().swarm).toEqual([]);
    expect(await onDisk(folder)).toEqual(['.notesd-subs/en.vtt', FILES[0]!.path, FILES[1]!.path].sort());
    expect(await streams.view(HASH)).toMatchObject({ state: 'ready', in_swarm: false, peers: 0, progress: 1 });
  });

  it('keeps an unfinished download in the swarm until nothing asked for it for three minutes (R2.3)', async () => {
    const { streams, engine } = build();
    await streams.open(PICK, OPEN);
    await streams.use(HASH, [1]);
    await streams.release(HASH);
    await streams.tick();
    expect(engine.removed).toEqual([]);
    clock += 2 * MIN;
    await streams.tick();
    expect(engine.removed).toEqual([]);
    expect((await streams.serve(HASH, 1, 'bytes=0-9')).status).toBe(206);
    clock += 2 * MIN;
    await streams.tick();
    expect(engine.removed).toEqual([]);
    clock += 1.5 * MIN;
    await streams.tick();
    expect(engine.removed).toEqual([HASH]);
    const later = await streams.serve(HASH, 1, 'bytes=0-9');
    expect(later.status).toBe(409);
    expect(await later.json()).toMatchObject({ error: 'not_in_swarm' });
  });

  it('drops at once a torrent opened and never used, and ignores an unknown hash', async () => {
    const { streams, engine } = build();
    await streams.open(PICK, OPEN);
    await streams.release('f'.repeat(40));
    await streams.release('not a hash');
    expect(engine.removed).toEqual([]);
    await streams.release(HASH);
    expect(engine.removed).toEqual([HASH]);
  });

  it('records a torrent no peer describes as failed', async () => {
    const { streams, records } = build({ engine: new FakeTorrentEngine([]) });
    await expect(streams.open(PICK, OPEN)).rejects.toMatchObject({ code: 'no_metadata' });
    expect(records.rows[0]).toMatchObject({ state: 'failed', error: 'no_metadata' });
  });

  it('plays a finished download from disk without joining a swarm (R2.9)', async () => {
    const records = new MemoryTorrentRecords();
    const at = new Date(clock - 3 * 86_400_000);
    await records.record('host-a', { infoHash: HASH, ref: REF, name: NAME, release: PICK.name, trackers: [] }, at);
    await records.chosen('host-a', HASH, { files: [{ index: 1, path: FILES[1]!.path, length: VIDEO.length }, { index: 0, path: FILES[0]!.path, length: SRT.length }], fileIndex: 1, fileLength: VIDEO.length }, at);
    await records.ready('host-a', HASH, VIDEO.length, at);
    const engine = new FakeTorrentEngine([]);
    const { streams, folder } = build({ records, engine });
    await put(folder, FILES[1]!.path, VIDEO);
    await put(folder, FILES[0]!.path, SRT);
    const handle = await streams.open(PICK, OPEN);
    expect(handle.live).toBe(false);
    expect(handle.files.map((f) => f.index)).toEqual([1, 0]);
    await streams.use(HASH, [1, 0]);
    const res = await streams.serve(HASH, 1, 'bytes=0-9');
    expect(res.status).toBe(206);
    expect(Buffer.from(await res.arrayBuffer()).equals(VIDEO.subarray(0, 10))).toBe(true);
    expect(engine.added).toEqual([]);
    expect(streams.status()).toMatchObject({ port: null, swarm: [] });
    expect(await streams.find(REF)).toMatchObject({ infoHash: HASH, fileIndex: 1, state: 'ready' });
    expect(await streams.filePath(HASH, 1)).toBe(folder.diskPath(HASH, FILES[1]!.path));
    expect(records.rows[0]?.playedAt?.getTime()).toBe(clock);
  });

  it('answers not_on_this_machine for the other machine\'s download', async () => {
    const records = new MemoryTorrentRecords();
    await records.record('host-b', { infoHash: HASH, ref: REF, name: NAME, release: null, trackers: [] }, new Date(clock));
    const { streams } = build({ records });
    const res = await streams.serve(HASH, 1, null);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'not_on_this_machine', host: 'host-b' });
    expect(await streams.view(HASH)).toMatchObject({ host: 'host-b', available: false, file_url: null });
    expect(await streams.map(HASH)).toBeNull();
    expect(await streams.find(REF)).toBeNull();
  });

  it('clears downloads not played for keepDays, with their folders', async () => {
    const records = new MemoryTorrentRecords();
    const OLD = 'a1'.repeat(20);
    await records.record('host-a', { infoHash: OLD, ref: REF, name: 'Old', release: null, trackers: [] }, new Date(clock - 30 * 86_400_000));
    await records.played('host-a', OLD, new Date(clock - 8 * 86_400_000));
    await records.record('host-a', { infoHash: HASH, ref: REF, name: NAME, release: null, trackers: [] }, new Date(clock - 30 * 86_400_000));
    await records.played('host-a', HASH, new Date(clock - 86_400_000));
    const { streams, folder } = build({ records });
    await mkdir(folder.dirOf(OLD), { recursive: true });
    expect(await streams.start()).toBe(1);
    expect(records.rows.map((r) => r.infoHash)).toEqual([HASH]);
    await expect(readdir(folder.dirOf(OLD))).rejects.toThrow();
  });

  it('is not built with torrents off or direct streaming off, and building it joins nothing (R2.6)', () => {
    const env = { DATABASE_URL: 'postgres://u@127.0.0.1:1/db', NOTES_DATA_DIR: root };
    const db = {} as Db;
    const off = loadConfig({ env: { ...env, NOTESD_TORRENT: 'off' }, envFile: false });
    expect(buildTorrentStreams(off, { host: 'host-a' }, db)).toBeNull();
    const on = loadConfig({ env, envFile: false });
    expect(buildTorrentStreams(on, null, db)).toBeNull();
    const built = buildTorrentStreams(on, { host: 'host-a' }, db);
    expect(built).not.toBeNull();
    expect(built?.root).toBe(path.join(root, 'movies', 'torrents'));
    expect(built?.status()).toMatchObject({ port: null, swarm: [], upload_cap_bytes_per_s: 100_000 });
  });
});
