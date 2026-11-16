import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppDeps } from '../../../../src/deps.js';
import { CueFeeds } from '../../../../src/directStream/torrent/subtitles/feed.js';
import { streamTorrentCuesRoutes } from '../../../../src/http/streamTorrentCuesApi.js';

const HASH = 'e'.repeat(40);
let dir: string;
let feeds: CueFeeds;

function app(deps: Partial<AppDeps>): Hono {
  const a = new Hono();
  a.route('/', streamTorrentCuesRoutes(deps));
  return a;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'notesd-cues-route-'));
  feeds = new CueFeeds({ folderOf: (hash) => path.join(dir, hash), log: () => {} });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('GET /api/stream/torrent/:hash/cues/:track', () => {
  it('answers torrent_off without torrents', async () => {
    const res = await app({ torrentCues: null }).request(`/api/stream/torrent/${HASH}/cues/embedded-2`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'torrent_off' });
  });

  it('answers the cues after an index, and complete once there are no more', async () => {
    const feed = await feeds.start(HASH, 'embedded-2');
    await feed.append([{ start_s: 1, end_s: 3, text: 'Line 1' }, { start_s: 4, end_s: 6, text: 'Line 2' }]);
    const a = app({ torrentCues: feeds });
    const first = await a.request(`/api/stream/torrent/${HASH}/cues/embedded-2`);
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect(await first.json()).toEqual({ cues: [{ start_s: 1, end_s: 3, text: 'Line 1' }, { start_s: 4, end_s: 6, text: 'Line 2' }], next: 2, complete: false });
    await feed.complete();
    expect(await (await a.request(`/api/stream/torrent/${HASH.toUpperCase()}/cues/embedded-2?after=2`)).json()).toEqual({ cues: [], next: 2, complete: true });
  });

  it('refuses a bad after, and names no feed for an unknown or malformed name', async () => {
    const a = app({ torrentCues: feeds });
    expect((await a.request(`/api/stream/torrent/${HASH}/cues/embedded-2?after=-1`)).status).toBe(400);
    expect((await a.request(`/api/stream/torrent/${HASH}/cues/embedded-2?after=x`)).status).toBe(400);
    const unknown = await a.request(`/api/stream/torrent/${HASH}/cues/embedded-9`);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: 'unknown_feed' });
    expect((await a.request('/api/stream/torrent/not-a-hash/cues/embedded-2')).status).toBe(404);
    expect((await a.request(`/api/stream/torrent/${HASH}/cues/..%2F..%2Fetc`)).status).toBe(404);
  });
});
