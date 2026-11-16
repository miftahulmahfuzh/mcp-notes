import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DirectStreamService } from '../../../../src/directStream/service.js';
import { TorrentStreams } from '../../../../src/directStream/torrent/service.js';
import { TorrentFolder } from '../../../../src/directStream/torrent/store.js';
import { streamTorrentRoutes } from '../../../../src/http/streamTorrentApi.js';
import { FakeTorrentEngine } from '../../../helpers/fakeTorrentEngine.js';
import { MemoryTorrentRecords } from '../../../helpers/memoryTorrentRecords.js';

const HASH = 'beef'.padEnd(40, '1');
const NAME = 'Fixture.Film.2026';
const VIDEO = Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * 7) % 256));
const DIRECT = {} as unknown as DirectStreamService;
const JSON_SAME = { origin: 'http://localhost', 'content-type': 'application/json' };
const OPEN = { info_hash: HASH, kind: 'movie', tmdb_id: 550, name: `${NAME}.1080p` };

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'torrent-routes-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function app() {
  const engine = new FakeTorrentEngine([
    { infoHash: HASH, name: NAME, files: [{ path: `${NAME}/${NAME}.mp4`, data: VIDEO }, { path: `${NAME}/setup.exe`, data: Buffer.from('MZ') }] },
  ]);
  const torrents = new TorrentStreams({
    engine,
    repo: new MemoryTorrentRecords(),
    folder: new TorrentFolder(root),
    host: 'host-a',
    uploadKbps: 100,
    keepDays: 7,
    discovery: true,
    log: () => undefined,
    every: () => () => undefined,
  });
  return { app: new Hono().route('/', streamTorrentRoutes({ directStream: DIRECT, torrents })), engine };
}

describe('the torrent routes', () => {
  it('answer direct_stream_off without direct streaming and torrent_off with torrents off (R2.6)', async () => {
    const none = new Hono().route('/', streamTorrentRoutes({ directStream: null }));
    const res = await none.request('/api/stream/torrent');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'direct_stream_off' });
    const off = new Hono().route('/', streamTorrentRoutes({ directStream: DIRECT, torrents: null }));
    const calls: [string, string][] = [
      ['GET', '/api/stream/torrent'],
      ['POST', '/api/stream/torrent'],
      ['GET', `/api/stream/torrent/${HASH}`],
      ['GET', `/api/stream/torrent/${HASH}/map`],
      ['GET', `/api/stream/torrent/${HASH}/f/0`],
      ['POST', `/api/stream/torrent/${HASH}/release`],
    ];
    for (const [method, url] of calls) {
      const answer = await off.request(url, { method, headers: JSON_SAME, ...(method === 'POST' ? { body: JSON.stringify(OPEN) } : {}) });
      expect(answer.status, `${method} ${url}`).toBe(503);
      expect(await answer.json()).toMatchObject({ error: 'torrent_off' });
    }
  });

  it('open, use, serve a range and release a torrent', async () => {
    const { app: a, engine } = app();
    const listed = await a.request('/api/stream/torrent', { method: 'POST', headers: JSON_SAME, body: JSON.stringify(OPEN) });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      ok: true,
      from_disk: false,
      files: [
        { index: 0, media: 'video', length: VIDEO.length },
        { index: 1, media: null },
      ],
      torrent: { info_hash: HASH, state: 'downloading', users: 0, release: `${NAME}.1080p` },
    });
    const used = await a.request('/api/stream/torrent', { method: 'POST', headers: JSON_SAME, body: JSON.stringify({ ...OPEN, files: [0] }) });
    expect(await used.json()).toMatchObject({ torrent: { users: 1, file_index: 0, file_url: `/api/stream/torrent/${HASH}/f/0` } });
    const again = await a.request('/api/stream/torrent', { method: 'POST', headers: JSON_SAME, body: JSON.stringify({ ...OPEN, files: [0] }) });
    expect(await again.json()).toMatchObject({ torrent: { users: 1 } });
    const range = await a.request(`/api/stream/torrent/${HASH}/f/0`, { headers: { range: 'bytes=100-199' } });
    expect(range.status).toBe(206);
    expect(Buffer.from(await range.arrayBuffer()).equals(VIDEO.subarray(100, 200))).toBe(true);
    const status = await (await a.request('/api/stream/torrent')).json();
    expect(status).toMatchObject({ port: 6881, swarm: [{ info_hash: HASH, users: 1 }], downloads: [{ info_hash: HASH }] });
    const released = await a.request(`/api/stream/torrent/${HASH}/release`, { method: 'POST', headers: JSON_SAME });
    expect(await released.json()).toMatchObject({ ok: true, released: true, torrent: { users: 0 } });
    expect(engine.removed).toEqual([]);
    const map = await (await a.request(`/api/stream/torrent/${HASH}/map`)).json();
    expect(map).toEqual({ duration_s: null, ranges: [], length: VIDEO.length, byte_ranges: [[100, 200]] });
  });

  it('refuse a cross-origin open, a file that is neither video nor subtitle, and an unknown hash', async () => {
    const { app: a } = app();
    const cross = await a.request('/api/stream/torrent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(OPEN) });
    expect(cross.status).toBe(403);
    const exe = await a.request('/api/stream/torrent', { method: 'POST', headers: JSON_SAME, body: JSON.stringify({ ...OPEN, files: [1] }) });
    expect(exe.status).toBe(400);
    expect(await exe.json()).toMatchObject({ error: 'not_media' });
    const bad = await a.request('/api/stream/torrent', { method: 'POST', headers: JSON_SAME, body: JSON.stringify({ ...OPEN, info_hash: 'xyz' }) });
    expect(bad.status).toBe(400);
    expect((await a.request(`/api/stream/torrent/${'0'.repeat(40)}`)).status).toBe(404);
    expect((await a.request(`/api/stream/torrent/${'0'.repeat(40)}/f/0`)).status).toBe(404);
    const missing = await a.request('/api/stream/torrent', { method: 'POST', headers: JSON_SAME, body: JSON.stringify({ ...OPEN, info_hash: '9'.repeat(40) }) });
    expect(missing.status).toBe(504);
    expect(await missing.json()).toMatchObject({ error: 'no_metadata' });
  });
});
