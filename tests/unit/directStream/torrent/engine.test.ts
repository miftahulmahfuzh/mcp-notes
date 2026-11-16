import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebTorrent, { type Torrent } from 'webtorrent';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebTorrentEngine } from '../../../../src/directStream/torrent/engine.js';
import { TorrentFolder } from '../../../../src/directStream/torrent/store.js';
import type { TorrentHandle } from '../../../../src/directStream/torrent/types.js';

const NAME = 'Fixture.Film.2026';
const PIECE = 32_768;
const FILM = 2 * 1_048_576;
const SEEDER_BYTES_PER_S = 300_000;
const CAP_KBPS = 50;
const SRT = Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nHello from loopback\n');
const QUIET = { dht: false, tracker: false, lsd: false, natUpnp: false, natPmp: false, utp: false, webSeeds: false } as const;

/** The same pseudo-random bytes on every run (xorshift32). */
function bytes(length: number, seed: number): Buffer {
  const out = Buffer.alloc(length);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < length; i += 1) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

async function files(dir: string, base = dir): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) Object.assign(out, await files(full, base));
    else out[path.relative(base, full)] = (await stat(full)).size;
  }
  return out;
}

async function until(check: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function readAll(handle: TorrentHandle, index: number, start: number, end: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of handle.read(index, { start, end })) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

const film = bytes(FILM, 7);
let tmp: string;
let seeder: WebTorrent;
let seeded: Torrent;
let folder: TorrentFolder;
let engine: WebTorrentEngine;

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'torrent-engine-'));
  const src = path.join(tmp, 'src', NAME);
  await mkdir(path.join(src, 'Sample'), { recursive: true });
  await writeFile(path.join(src, `${NAME}.en.srt`), SRT);
  await writeFile(path.join(src, `${NAME}.mp4`), film);
  await writeFile(path.join(src, 'Sample', 'sample.mp4'), bytes(200_000, 11));
  await writeFile(path.join(src, 'setup.exe'), bytes(600_000, 13));
  seeder = new WebTorrent({ ...QUIET, uploadLimit: SEEDER_BYTES_PER_S });
  seeder.on('error', () => undefined);
  seeded = await new Promise<Torrent>((resolve) => seeder.seed(src, { announce: [], pieceLength: PIECE }, resolve));
  if (!seeder.listening) await new Promise<void>((resolve) => seeder.once('listening', () => resolve()));
  folder = new TorrentFolder(path.join(tmp, 'torrents'));
  engine = new WebTorrentEngine({
    folder,
    uploadKbps: CAP_KBPS,
    discovery: false,
    peers: [`127.0.0.1:${seeder.address()?.port}`],
    log: () => undefined,
    utp: false,
  });
}, 30_000);

afterAll(async () => {
  await engine.close();
  await new Promise<void>((resolve) => seeder.destroy(() => resolve()));
  await rm(tmp, { recursive: true, force: true });
});

describe('WebTorrentEngine over loopback', () => {
  it('answers the file list once a peer sends it, with nothing selected or written', async () => {
    expect(engine.port()).toBeNull();
    const handle = await engine.add({ infoHash: seeded.infoHash, trackers: [], name: NAME }, { timeoutMs: 15_000 });
    expect(handle.files.map((f) => [f.index, f.path, f.length])).toEqual([
      [0, `${NAME}/${NAME}.en.srt`, SRT.length],
      [1, `${NAME}/${NAME}.mp4`, FILM],
      [2, `${NAME}/Sample/sample.mp4`, 200_000],
      [3, `${NAME}/setup.exe`, 600_000],
    ]);
    expect(await files(folder.dirOf(seeded.infoHash))).toEqual({});
    expect(engine.port()).toEqual(expect.any(Number));
  }, 30_000);

  it('reads a byte range before the rest of the file, and exactly the bytes asked for (R2.1)', async () => {
    const handle = engine.get(seeded.infoHash)!;
    handle.select([1, 0]);
    const start = Math.floor(FILM * 0.9);
    const end = start + 65_535;
    expect((await readAll(handle, 1, start, end)).equals(film.subarray(start, end + 1))).toBe(true);
    const have = handle.ranges(1);
    expect(have.some(([from, to]) => from <= start && to >= end + 1)).toBe(true);
    expect(have.reduce((n, [from, to]) => n + (to - from), 0)).toBeLessThan(FILM / 2);
    expect((await readAll(handle, 1, 0, 0)).equals(film.subarray(0, 1))).toBe(true);
  }, 30_000);

  it('writes only the chosen files under the torrent folder; an unchosen neighbour gets at most one piece\'s edge (R2.2)', async () => {
    const handle = engine.get(seeded.infoHash)!;
    await until(() => handle.done(1) && handle.done(0), 25_000);
    const disk = await files(folder.dirOf(seeded.infoHash));
    expect(disk[`${NAME}/${NAME}.mp4`]).toBe(FILM);
    expect(disk[`${NAME}/${NAME}.en.srt`]).toBe(SRT.length);
    expect(disk[`${NAME}/setup.exe`]).toBeUndefined();
    expect(disk[`${NAME}/Sample/sample.mp4`] ?? 0).toBeLessThanOrEqual(PIECE);
    expect(handle.stats()).toMatchObject({ peers: expect.any(Number), down_kbps: expect.any(Number), up_kbps: expect.any(Number) });
  }, 30_000);

  it('uploads to another peer no faster than the cap (R2.3)', async () => {
    const leecher = new WebTorrent({ ...QUIET, utPex: false });
    leecher.on('error', () => undefined);
    try {
      const port = engine.port();
      const t = leecher.add(seeded.infoHash, { path: path.join(tmp, 'leecher'), deselect: true, announce: [] });
      t.once('infoHash', () => t.addPeer(`127.0.0.1:${port}`));
      if (!t.ready) await new Promise<void>((resolve) => t.once('ready', () => resolve()));
      const want = 256 * 1024;
      const iterator = t.files[1]![Symbol.asyncIterator]({ start: 0, end: want - 1 });
      const started = Date.now();
      let got = 0;
      while (got < want) {
        const next = await iterator.next();
        if (next.done === true) break;
        got += next.value.length;
      }
      const seconds = (Date.now() - started) / 1000;
      expect(got).toBe(want);
      expect(t.wires.map((w) => w.remotePort)).toEqual([port]);
      expect(got / seconds).toBeLessThanOrEqual(CAP_KBPS * 1000 * 1.25);
    } finally {
      await new Promise<void>((resolve) => leecher.destroy(() => resolve()));
    }
  }, 30_000);

  it('leaves the swarm when the torrent is removed, and stops listening once nothing is left (R2.3)', async () => {
    expect(seeded.numPeers).toBeGreaterThanOrEqual(1);
    await engine.remove(seeded.infoHash, { deleteFiles: false });
    await until(() => seeded.numPeers === 0, 5_000);
    expect(engine.get(seeded.infoHash)).toBeNull();
    expect(engine.port()).toBeNull();
    expect((await files(folder.dirOf(seeded.infoHash)))[`${NAME}/${NAME}.mp4`]).toBe(FILM);
  }, 30_000);

  it('gives up on a torrent no peer describes, and stops again', async () => {
    await expect(engine.add({ infoHash: 'f'.repeat(40), trackers: [], name: null }, { timeoutMs: 1_500 })).rejects.toMatchObject({ code: 'no_metadata' });
    expect(engine.port()).toBeNull();
  }, 30_000);
});
