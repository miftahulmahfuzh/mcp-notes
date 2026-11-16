import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REMUX_DONE_FILE, remuxDir, TorrentRemux } from '../../../src/directStream/torrent/remux.js';
import { streamTorrentRemuxRoutes } from '../../../src/http/streamTorrentRemuxApi.js';
import { eventPlaylist } from './remuxFakes.js';

const HASH = 'a'.repeat(40);
const OTHER = 'd'.repeat(40);
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'notesd-remux-route-'));
  const files = remuxDir(dir, HASH, 2);
  await mkdir(files, { recursive: true });
  await writeFile(path.join(files, 'index.m3u8'), eventPlaylist(1, true));
  await writeFile(path.join(files, 'seg-00000.m4s'), Buffer.alloc(1000, 7));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const remux = () => new TorrentRemux({ dir, spawn: () => { throw new Error('no ffmpeg in a route test'); }, log: () => undefined });
const views = (view: unknown = null) => ({ view: () => view });
function app(deps: Parameters<typeof streamTorrentRemuxRoutes>[0]): Hono {
  const a = new Hono();
  a.route('/', streamTorrentRemuxRoutes(deps));
  return a;
}
const url = (name: string, hash = HASH, index = '2') => `/api/stream/torrent/${hash}/hls/${index}/${name}`;

describe('GET /api/stream/torrent/:hash/hls/:index/:name', () => {
  it('answers torrent_off without torrents, and remux_off with the remux off', async () => {
    const off = await app({ torrents: null, torrentRemux: remux() }).request(url('index.m3u8'));
    expect(off.status).toBe(503);
    expect(await off.json()).toMatchObject({ error: 'torrent_off' });
    const noRemux = await app({ torrents: views(), torrentRemux: null }).request(url('index.m3u8'));
    expect(noRemux.status).toBe(404);
    expect(await noRemux.json()).toMatchObject({ error: 'remux_off' });
  });

  it('serves a playlist that is still growing without EXT-X-ENDLIST, never cached, and a finished one whole', async () => {
    const a = app({ torrents: views(), torrentRemux: remux() });
    const growing = await a.request(`${url('index.m3u8')}?remux=1&total_s=120`);
    expect(growing.status).toBe(200);
    expect(growing.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
    expect(growing.headers.get('cache-control')).toBe('no-store');
    expect(await growing.text()).not.toContain('#EXT-X-ENDLIST');
    await writeFile(path.join(remuxDir(dir, HASH, 2), REMUX_DONE_FILE), '{}');
    expect(await (await a.request(url('index.m3u8'))).text()).toContain('#EXT-X-ENDLIST');
  });

  it('serves a segment with Range', async () => {
    const res = await app({ torrents: views(), torrentRemux: remux() }).request(url('seg-00000.m4s'), { headers: { range: 'bytes=0-99' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-99/1000');
    expect((await res.arrayBuffer()).byteLength).toBe(100);
  });

  it('refuses a name, an index or a hash it does not serve', async () => {
    const a = app({ torrents: views(), torrentRemux: remux() });
    for (const target of [url('index.m3u8.tmp'), url('film.mkv'), url('index.m3u8', 'zz'), url('index.m3u8', HASH, 'x1')]) {
      const res = await a.request(target);
      expect(res.status, target).toBe(404);
      expect(await res.json()).toMatchObject({ error: 'not_found' });
    }
    // A name that climbs out of the folder never reaches the disk (Hono may not even route it: only the status is checked).
    const climb = await a.request(url('..%2F..%2F..%2Fdone.json'));
    expect(climb.status).toBe(404);
  });

  it("answers not_on_this_machine for the other machine's download", async () => {
    const res = await app({ torrents: views({ available: false, host: 'other-laptop' }), torrentRemux: remux() }).request(url('index.m3u8', OTHER));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'not_on_this_machine', host: 'other-laptop' });
  });
});
