import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebTorrent, { type Torrent } from 'webtorrent';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebTorrentEngine } from '../../../../src/directStream/torrent/engine.js';
import { TorrentFolder } from '../../../../src/directStream/torrent/store.js';
import { PROBE_HEAD_BYTES } from '../../../../src/directStream/torrent/types.js';

/**
 * The real engine over loopback, on a season pack: `use` selects the whole episode, and webtorrent's sequential
 * strategy then fetches it front to back, so the last pieces (a Matroska file's Cues and Tags, an MP4's moov), which
 * ffprobe seeks to, came only after the whole episode. `headFirst` must bring the first and last pieces before the
 * middle of the file.
 */

const NAME = 'Fixture.Show.S01.1080p';
// Pieces of several 16 kB blocks, as a real pack's are: one block of the last piece is not the piece.
const PIECE = 262_144;
const EPISODE = 4 * PROBE_HEAD_BYTES;
const SEEDER_BYTES_PER_S = 1_500_000;
const QUIET = { dht: false, tracker: false, lsd: false, natUpnp: false, natPmp: false, utp: false, webSeeds: false } as const;

const bytes = (length: number, seed: number): Buffer => Buffer.from(Array.from({ length }, (_, i) => (i * 31 + seed) % 251));

async function until(check: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

let tmp: string;
let seeder: WebTorrent;
let seeded: Torrent;
let engine: WebTorrentEngine;

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'torrent-head-first-'));
  const src = path.join(tmp, 'src', NAME);
  await mkdir(src, { recursive: true });
  for (let e = 1; e <= 4; e += 1) await writeFile(path.join(src, `Fixture.Show.S01E0${e}.mkv`), bytes(EPISODE, e));
  seeder = new WebTorrent({ ...QUIET, uploadLimit: SEEDER_BYTES_PER_S });
  seeder.on('error', () => undefined);
  seeded = await new Promise<Torrent>((resolve) => seeder.seed(src, { announce: [], pieceLength: PIECE }, resolve));
  if (!seeder.listening) await new Promise<void>((resolve) => seeder.once('listening', () => resolve()));
  engine = new WebTorrentEngine({
    folder: new TorrentFolder(path.join(tmp, 'torrents')),
    uploadKbps: 50,
    discovery: false,
    peers: [`127.0.0.1:${seeder.address()?.port}`],
    log: () => undefined,
  });
}, 30_000);

afterAll(async () => {
  await engine.close();
  await new Promise<void>((resolve) => seeder.destroy(() => resolve()));
  await rm(tmp, { recursive: true, force: true });
});

describe('WebTorrentEngine.headFirst over loopback', () => {
  it('brings an episode\'s first and last pieces of a pack before the middle of it', async () => {
    const handle = await engine.add({ infoHash: seeded.infoHash, trackers: [], name: NAME }, { timeoutMs: 15_000 });
    const episode = handle.files.find((f) => f.name === 'Fixture.Show.S01E02.mkv')!;
    handle.select([episode.index]);
    handle.headFirst?.(episode.index);
    const has = (from: number, to: number): boolean => handle.ranges(episode.index).some(([a, b]) => a <= from && b >= to);
    // ffprobe's own read, front to back, as the file route makes it.
    const probe = handle.read(episode.index, { start: 0, end: EPISODE - 1 });
    probe.on('data', () => undefined);
    try {
      await until(() => has(0, PIECE) && has(EPISODE - PIECE, EPISODE), 15_000);
      // Front to back, the last piece would be the last to come; asked for first, much of the middle is still to come.
      const onDisk = handle.ranges(episode.index).reduce((n, [a, b]) => n + (b - a), 0);
      expect(handle.done(episode.index)).toBe(false);
      expect(onDisk).toBeLessThan(EPISODE * 0.9);
    } finally {
      probe.destroy();
    }
  }, 30_000);
});
