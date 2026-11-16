import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppDeps } from '../../../../src/deps.js';
import { SubtitleShelf } from '../../../../src/directStream/torrent/subtitles/disk.js';
import { streamTorrentRoutes } from '../../../../src/http/streamTorrentApi.js';

const HASH = 'f'.repeat(40);
let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'notesd-subroute-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function app(torrents: unknown): Hono {
  const a = new Hono();
  a.route('/', streamTorrentRoutes({ config: { torrent: { dir } }, torrents } as unknown as AppDeps));
  return a;
}

describe('GET /api/stream/torrent/:hash/sub/:name', () => {
  it('serves a kept subtitle as WebVTT', async () => {
    await new SubtitleShelf(dir).save(HASH, 'file-1.vtt', 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi.\n', { lang: 'en', label: 'English' });
    const res = await app({ view: async () => null }).request(`/api/stream/torrent/${HASH}/sub/file-1.vtt`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/vtt/);
    expect(await res.text()).toContain('Hi.');
  });

  it('answers not_found for an unknown or unsafe name, not_on_this_machine for the other machine\'s torrent, and 503 when off', async () => {
    expect((await app({ view: async () => null }).request(`/api/stream/torrent/${HASH}/sub/chosen.json`)).status).toBe(404);
    expect(await (await app({ view: async () => null }).request(`/api/stream/torrent/${HASH}/sub/borrow.vtt`)).json()).toMatchObject({ error: 'not_found' });
    const other = await app({ view: async () => ({ host: 'laptop-b', available: false }) }).request(`/api/stream/torrent/${HASH}/sub/borrow.vtt`);
    expect(other.status).toBe(404);
    expect(await other.json()).toMatchObject({ error: 'not_on_this_machine', host: 'laptop-b' });
    expect((await app(null).request(`/api/stream/torrent/${HASH}/sub/borrow.vtt`)).status).toBe(503);
  });
});
