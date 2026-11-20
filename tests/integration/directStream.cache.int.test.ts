import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { streamCaches } from '../../src/db/schema.js';
import { StreamCache } from '../../src/directStream/cache/service.js';
import type { StreamCacheView } from '../../src/directStream/cache/types.js';
import { DirectStreamRepo } from '../../src/directStream/repo.js';
import { directStreamScriptRunner } from '../../src/directStream/runner.js';
import { DirectStreamService } from '../../src/directStream/service.js';
import type { StreamRef } from '../../src/directStream/types.js';
import { directStreamRoutes } from '../../src/http/directStreamApi.js';
import { streamCacheRoutes } from '../../src/http/streamCacheApi.js';
// @ts-expect-error -- plain .mjs fixture without type declarations
import { startUpstream } from '../fixtures/direct-stream/upstream.mjs';
import { closeTestDb, openTestDb, truncateAll } from './setup.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/direct-stream');
const FAKE_CLI = path.join(FIXTURES, 'fake-cli.mjs');
const SAME_ORIGIN = { origin: 'http://localhost' };
const SEED = [{ name: 'Alpha', movie: 'https://alpha.example/movie/{id}', tv: 'https://alpha.example/tv/{id}/{season}/{episode}', en_subtitle: true }];

interface UpstreamRequest {
  path: string;
  status: number;
}
interface Upstream {
  origin: string;
  altOrigin: string;
  requests: UpstreamRequest[];
  close(): Promise<void>;
}
interface Posted {
  ok: true;
  started: boolean;
  cache: StreamCacheView;
}

let db: Db;
let up: Upstream;
let fakeDir: string;
let root: string;
const open: StreamCache[] = [];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const tokPath = (p: string): string => p.replace(/^\/tok\/t\d+\//, '');

async function pgCode(statement: Promise<unknown>): Promise<string | undefined> {
  try {
    await statement;
  } catch (err) {
    let cur: unknown = err;
    while (cur && typeof cur === 'object') {
      const e = cur as { code?: unknown; cause?: unknown };
      if (typeof e.code === 'string') return e.code;
      cur = e.cause;
    }
    return undefined;
  }
  throw new Error('expected the statement to fail');
}

async function fake(name: string, value: string | number): Promise<void> {
  await writeFile(path.join(fakeDir, name), `${value}\n`);
}

function build(options: { parallel?: number } = {}) {
  const repo = new DirectStreamRepo(db);
  const svc = new DirectStreamService({
    repo,
    runner: directStreamScriptRunner({ cliPath: FAKE_CLI }),
    host: 'host-a',
    seedFile: path.join(fakeDir, 'seed.json'),
    pageBase: () => 'http://localhost:4321',
    log: () => undefined,
    caches: () => wired?.player() ?? null,
  });
  let wired: StreamCache | null = null;
  const cache = new StreamCache({
    repo,
    host: 'host-a',
    root,
    resolve: (ref) => svc.resolve(ref, { resumeS: 0 }),
    sleep: async () => undefined,
    log: () => undefined,
    ...(options.parallel === undefined ? {} : { parallel: options.parallel }),
  });
  wired = cache;
  open.push(cache);
  const app = new Hono();
  app.route('/', directStreamRoutes({ directStream: svc }));
  app.route('/', streamCacheRoutes({ directStream: svc, streamCache: cache }));
  return { svc, cache, app };
}

async function ready(options: { parallel?: number } = {}) {
  const built = build(options);
  await built.svc.syncSeed();
  return built;
}

function post(app: Hono, body: unknown, headers: Record<string, string> = SAME_ORIGIN): Promise<Response> {
  return Promise.resolve(app.request('/api/stream/cache', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));
}

async function posted(app: Hono, body: unknown): Promise<Posted> {
  const res = await post(app, body);
  expect(res.status).toBe(202);
  return (await res.json()) as Posted;
}

async function until(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(20);
  }
}

async function waitFor(app: Hono, id: string, state: 'ready' | 'failed'): Promise<StreamCacheView> {
  const end = Date.now() + 15_000;
  for (;;) {
    const view = (await (await app.request(`/api/stream/cache/${id}`)).json()) as StreamCacheView;
    if (view.state === state) return view;
    if (view.state === 'failed') throw new Error(`the cache failed: ${view.error} ${view.error_detail}`);
    if (Date.now() > end) throw new Error(`cache ${id} is still ${view.state}`);
    await sleep(20);
  }
}

beforeAll(async () => {
  db = openTestDb();
  fakeDir = await mkdtemp(path.join(os.tmpdir(), 'direct-stream-cache-'));
  up = (await startUpstream({ state: fakeDir })) as Upstream;
  await writeFile(path.join(fakeDir, 'upstream.json'), JSON.stringify({ origin: up.origin, alt_origin: up.altOrigin }));
  await writeFile(path.join(fakeDir, 'seed.json'), JSON.stringify(SEED));
  process.env.DIRECT_STREAM_FAKE_DIR = fakeDir;
});

afterAll(async () => {
  delete process.env.DIRECT_STREAM_FAKE_DIR;
  await up.close();
  await rm(fakeDir, { recursive: true, force: true });
  await closeTestDb(db);
});

beforeEach(async () => {
  await truncateAll(db);
  for (const name of ['calls.jsonl', 'token_uses', 'fail_once', 'delay_ms']) await rm(path.join(fakeDir, name), { force: true });
  await fake('mode', 'hls');
  up.requests.length = 0;
  root = await mkdtemp(path.join(os.tmpdir(), 'stream-cache-root-'));
});

afterEach(async () => {
  for (const cache of open.splice(0)) await cache.close();
  await sleep(50);
  await rm(root, { recursive: true, force: true });
});

describe('migration 0029 (stream caches)', () => {
  it('keeps one cache per title slot and machine, a film in slot 0/0, and an error exactly on a failed cache', async () => {
    const repo = new DirectStreamRepo(db);
    expect((await repo.createCache('host-a', { kind: 'movie', tmdbId: 550 }, null)).created).toBe(true);
    expect((await repo.createCache('host-a', { kind: 'movie', tmdbId: 550 }, 720)).created).toBe(false);
    expect((await repo.createCache('host-b', { kind: 'movie', tmdbId: 550 }, null)).created).toBe(true);
    expect(await pgCode(db.insert(streamCaches).values({ host: 'host-a', kind: 'movie', tmdbId: 551, season: 1, episode: 1 }))).toBe('23514');
    expect(await pgCode(db.insert(streamCaches).values({ host: 'host-a', kind: 'movie', tmdbId: 552, state: 'failed' }))).toBe('23514');
    expect(await pgCode(db.insert(streamCaches).values({ host: 'host-a', kind: 'movie', tmdbId: 553, manifestKind: 'dash' as never }))).toBe('23514');
    expect(await pgCode(db.insert(streamCaches).values({ host: 'host-a', kind: 'movie', tmdbId: 554, state: 'ready' }))).toBe('23514');
  });
});

describe('/api/stream/cache', () => {
  it('downloads the rendition under max_height with its subtitle, records it, and serves it from disk', async () => {
    const { app } = await ready();
    const p = await posted(app, { kind: 'movie', tmdb_id: 550, max_height: 720 });
    expect(p).toMatchObject({ ok: true, started: true, cache: { state: 'downloading', host: 'host-a', available: true } });
    const id = p.cache.id;
    const done = await waitFor(app, id, 'ready');
    expect(done).toMatchObject({
      kind: 'movie',
      tmdb_id: 550,
      season: null,
      episode: null,
      provider: 'Alpha',
      manifest_kind: 'hls',
      height: 720,
      max_height: 720,
      subtitle: true,
      segments_total: 2,
      segments_done: 2,
      progress: 1,
      resolves: 1,
      playlist_url: `/api/stream/cache/${id}/f/master.m3u8`,
      subtitle_url: `/api/stream/cache/${id}/f/subtitle.vtt`,
    });
    expect((await readdir(path.join(root, id))).sort()).toEqual(['cache.json', 'master.m3u8', 'subtitle.vtt', 'v-00001.m4s', 'v-00002.m4s', 'v-init-1.mp4', 'video.m3u8']);
    expect(up.requests.some((r) => r.path.startsWith('/hls/1080/'))).toBe(false);
    expect(up.requests.filter((r) => r.path === '/hls/720/index.m3u8')).toHaveLength(1);
    const master = await (await app.request(`/api/stream/cache/${id}/f/master.m3u8`)).text();
    expect(master).toContain('RESOLUTION=1280x720');
    expect(master).toContain('\nvideo.m3u8\n');
    const video = await (await app.request(`/api/stream/cache/${id}/f/video.m3u8`)).text();
    expect(video.split('\n')).toEqual([
      '#EXTM3U',
      '#EXT-X-VERSION:6',
      '#EXT-X-TARGETDURATION:4',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXT-X-MAP:URI="v-init-1.mp4"',
      '#EXTINF:4.0,',
      'v-00001.m4s',
      '#EXTINF:4.0,',
      'v-00002.m4s',
      '#EXT-X-ENDLIST',
      '',
    ]);
    const part = await app.request(`/api/stream/cache/${id}/f/v-00002.m4s`, { headers: { range: 'bytes=10-19' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 10-19/1000');
    expect([...new Uint8Array(await part.arrayBuffer())]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(await (await app.request(`/api/stream/cache/${id}/f/subtitle.vtt`)).text()).toMatch(/^WEBVTT\n\n[\s\S]*00:00:01\.000 --> 00:00:03\.000\nHello\./);
    expect((await app.request(`/api/stream/cache/${id}/f/cache.json`)).status).toBe(404);
    const [row] = await db.select().from(streamCaches);
    expect(row).toMatchObject({ state: 'ready', segmentsDone: 2, segmentsTotal: 2, bytes: 3000, resolves: 1, host: 'host-a' });
  });

  it('answers a cache that exists without a second download, and refuses another max_height', async () => {
    const { app } = await ready();
    const first = await posted(app, { kind: 'movie', tmdb_id: 550, max_height: 720 });
    await waitFor(app, first.cache.id, 'ready');
    const again = await post(app, { kind: 'movie', tmdb_id: 550 });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ ok: true, started: false, cache: { id: first.cache.id, state: 'ready' } });
    const other = await post(app, { kind: 'movie', tmdb_id: 550, max_height: 1080 });
    expect(other.status).toBe(409);
    expect(await other.json()).toMatchObject({ error: 'cache_exists', cache: { id: first.cache.id, max_height: 720 } });
    expect((await readFile(path.join(fakeDir, 'calls.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1);
  });

  it('resolves again when the host refuses the token, retries a failing segment, and fetches no segment twice', async () => {
    await fake('mode', 'hls_token');
    await fake('token_uses', 10);
    await fake('fail_once', 'seg3.ts');
    const { app } = await ready();
    const p = await posted(app, { kind: 'movie', tmdb_id: 990004 });
    const done = await waitFor(app, p.cache.id, 'ready');
    expect(done).toMatchObject({ height: 720, audio_lang: 'ko', segments_total: 24, segments_done: 24 });
    expect(done.resolves).toBeGreaterThanOrEqual(3);
    const tok = up.requests.filter((r) => r.path.startsWith('/tok/'));
    expect(tok.some((r) => r.status === 403)).toBe(true);
    expect(tok.filter((r) => r.status === 503).map((r) => tokPath(r.path))).toEqual(['720/seg3.ts']);
    const fetched = tok.filter((r) => r.status === 200 && /seg\d+\.ts$/.test(r.path)).map((r) => tokPath(r.path));
    expect(new Set(fetched).size).toBe(fetched.length);
    expect(fetched).toHaveLength(24);
    expect(fetched.some((f) => f.startsWith('audio/en/'))).toBe(false);
    const files = await readdir(path.join(root, p.cache.id));
    expect(files.filter((f) => /^v-\d{5}\.ts$/.test(f))).toHaveLength(12);
    expect(files.filter((f) => /^a-\d{5}\.ts$/.test(f))).toHaveLength(12);
    expect(files).toContain('v-key-1.key');
    expect(await (await app.request(`/api/stream/cache/${p.cache.id}/f/master.m3u8`)).text()).toContain('LANGUAGE="ko"');
  });

  it("lists the other machine's cache as unavailable and answers not_on_this_machine for its files and its delete", async () => {
    const repo = new DirectStreamRepo(db);
    const { row } = await repo.createCache('host-b', { kind: 'tv', tmdbId: 1399, season: 1, episode: 2 }, null);
    await repo.cachePlanned(row.id, { provider: 'Alpha', manifestKind: 'hls', height: 1080, audioLang: null, segmentsTotal: 10, segmentsDone: 10, bytes: 5000, durationS: 40 });
    await repo.cacheReady(row.id, { segments: 10, bytes: 5000, subtitle: true });
    const { app, cache } = await ready();
    const list = (await (await app.request('/api/stream/cache')).json()) as { host: string; caches: StreamCacheView[] };
    expect(list.host).toBe('host-a');
    expect(list.caches).toEqual([expect.objectContaining({ id: row.id, host: 'host-b', available: false, state: 'ready', season: 1, episode: 2, playlist_url: null, subtitle_url: null })]);
    for (const name of ['master.m3u8', 'v-00001.ts', 'subtitle.vtt']) {
      const res = await app.request(`/api/stream/cache/${row.id}/f/${name}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: 'not_on_this_machine', host: 'host-b' });
    }
    const del = await app.request(`/api/stream/cache/${row.id}`, { method: 'DELETE', headers: SAME_ORIGIN });
    expect(del.status).toBe(404);
    expect(await del.json()).toMatchObject({ error: 'not_on_this_machine', host: 'host-b' });
    expect(await repo.cacheById(row.id)).not.toBeNull();
    expect(await cache.player().find({ kind: 'tv', tmdbId: 1399, season: 1, episode: 2 })).toBeNull();
    expect(await cache.player().get(row.id)).toMatchObject({ host: 'host-b', state: 'ready', manifestUrl: `/api/stream/cache/${row.id}/f/master.m3u8` });
    expect(up.requests).toHaveLength(0);
  });

  it('DELETE stops a running download, removes its files and takes it out of every listing', async () => {
    await fake('mode', 'hls_token');
    await fake('delay_ms', 150);
    const { app, cache } = await ready();
    const id = (await posted(app, { kind: 'movie', tmdb_id: 990004 })).cache.id;
    await until(async () => ((await cache.get(id))?.segments_done ?? 0) >= 1);
    const del = await app.request(`/api/stream/cache/${id}`, { method: 'DELETE', headers: SAME_ORIGIN });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true, id });
    await expect(stat(path.join(root, id))).rejects.toThrow();
    expect(await new DirectStreamRepo(db).cacheById(id)).toBeNull();
    expect(((await (await app.request('/api/stream/cache')).json()) as { caches: unknown[] }).caches).toEqual([]);
    expect((await app.request(`/api/stream/cache/${id}`)).status).toBe(404);
    await sleep(400);
    const settled = up.requests.length;
    await sleep(600);
    expect(up.requests.length).toBe(settled);
    const again = await app.request(`/api/stream/cache/${id}`, { method: 'DELETE', headers: SAME_ORIGIN });
    expect(again.status).toBe(404);
    expect(await again.json()).toMatchObject({ error: 'unknown_cache' });
  });

  it('a restart carries an unfinished download on from the files already on disk', async () => {
    await fake('mode', 'hls_token');
    await fake('delay_ms', 50);
    const first = await ready();
    const id = (await posted(first.app, { kind: 'movie', tmdb_id: 990004 })).cache.id;
    await until(async () => ((await first.cache.get(id))?.segments_done ?? 0) >= 6);
    await first.cache.close();
    await sleep(200);
    const [row] = await db.select().from(streamCaches);
    expect(row?.state).toBe('downloading');
    const kept = (await readdir(path.join(root, id))).filter((f) => /^[va]-\d{5}\.ts$/.test(f)).length;
    expect(kept).toBeGreaterThanOrEqual(6);
    up.requests.length = 0;
    await rm(path.join(fakeDir, 'delay_ms'), { force: true });
    const second = await ready();
    expect(await second.cache.start()).toBe(1);
    const done = await waitFor(second.app, id, 'ready');
    expect(done.segments_done).toBe(24);
    expect(up.requests.filter((r) => r.status === 200 && /\/tok\/.*seg\d+\.ts$/.test(r.path))).toHaveLength(24 - kept);
  });

  it('fetches a segment the player asks for before its turn', async () => {
    await fake('mode', 'hls_token');
    await fake('delay_ms', 100);
    const { app, cache } = await ready({ parallel: 1 });
    const id = (await posted(app, { kind: 'movie', tmdb_id: 990004 })).cache.id;
    await until(async () => ((await cache.get(id))?.segments_done ?? 0) >= 1);
    const res = await app.request(`/api/stream/cache/${id}/f/v-00012.ts`);
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(1000);
    const order = up.requests.filter((r) => r.status === 200).map((r) => tokPath(r.path));
    expect(order).toContain('720/seg12.ts');
    expect(order).not.toContain('720/seg11.ts');
    await waitFor(app, id, 'ready');
    expect(up.requests.filter((r) => r.status === 200 && tokPath(r.path) === '720/seg12.ts')).toHaveLength(1);
  });

  it('carries the queue on from the segment the player asked for, and comes back for what lies before it', async () => {
    await fake('mode', 'hls_token');
    await fake('delay_ms', 30);
    const { app, cache } = await ready({ parallel: 1 });
    const id = (await posted(app, { kind: 'movie', tmdb_id: 990004 })).cache.id;
    await until(async () => ((await cache.get(id))?.segments_done ?? 0) >= 1);
    expect((await app.request(`/api/stream/cache/${id}/f/v-00006.ts`)).status).toBe(200);
    const done = await waitFor(app, id, 'ready');
    expect(done.segments_done).toBe(24);
    const order = up.requests.filter((r) => r.status === 200).map((r) => tokPath(r.path));
    // 7 follows 6 at once; 3 waits until the end of the film is in.
    expect(order.indexOf('720/seg6.ts')).toBeLessThan(order.indexOf('720/seg7.ts'));
    expect(order.indexOf('720/seg12.ts')).toBeLessThan(order.indexOf('720/seg3.ts'));
  });

  it('GET /map names the stretches on disk while it downloads, and the whole title once it is ready', async () => {
    await fake('mode', 'hls_token');
    await fake('delay_ms', 60);
    const { app, cache } = await ready({ parallel: 1 });
    const id = (await posted(app, { kind: 'movie', tmdb_id: 990004 })).cache.id;
    await until(async () => ((await cache.get(id))?.segments_done ?? 0) >= 2);
    expect((await app.request(`/api/stream/cache/${id}/f/v-00010.ts`)).status).toBe(200);
    const mid = (await (await app.request(`/api/stream/cache/${id}/map`)).json()) as { duration_s: number; ranges: [number, number][] };
    expect(mid.duration_s).toBeGreaterThan(0);
    // The start, and apart from it the stretch the player asked for.
    expect(mid.ranges.length).toBeGreaterThanOrEqual(2);
    expect(mid.ranges[0]?.[0]).toBe(0);
    expect(mid.ranges.every(([a, b], i) => b > a && (i === 0 || a > (mid.ranges[i - 1]?.[1] ?? 0)))).toBe(true);
    await waitFor(app, id, 'ready');
    const whole = (await (await app.request(`/api/stream/cache/${id}/map`)).json()) as { duration_s: number; ranges: [number, number][] };
    expect(whole.ranges).toEqual([[0, whole.duration_s]]);
    const unknown = await app.request('/api/stream/cache/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/map');
    expect(unknown.status).toBe(404);
  });

  it('a paused play caches its title, moves onto the cache under the same session, and the cache is the player\'s until the owner asks for it', async () => {
    await fake('mode', 'hls_token');
    await fake('delay_ms', 20);
    const { app, cache } = await ready();
    const playRes = await app.request('/api/stream/play', { method: 'POST', headers: { 'content-type': 'application/json', ...SAME_ORIGIN }, body: JSON.stringify({ kind: 'movie', tmdb_id: 990004 }) });
    const sid = ((await playRes.json()) as { session: { session_id: string } }).session.session_id;
    type Answer = { session_id: string; moved: boolean; manifest_url: string; cached: { id: string; state: string } | null; cache: { id: string; state: string; progress: number } | null };
    const ask = async (start: boolean): Promise<Answer> =>
      (await (await app.request(`/api/stream/sessions/${sid}/cache`, { method: 'POST', headers: { 'content-type': 'application/json', ...SAME_ORIGIN }, body: JSON.stringify({ start }) })).json()) as Answer;

    // A poll before any pause starts nothing.
    expect(await ask(false)).toMatchObject({ moved: false, cache: null, cached: null });
    expect(await cache.list()).toEqual([]);

    const first = await ask(true);
    expect(first.cache).toMatchObject({ state: 'downloading' });
    const id = first.cache?.id ?? '';
    expect((await cache.get(id))?.auto).toBe(true);
    let moved = first;
    await until(async () => (moved = moved.moved ? moved : await ask(false)).moved);
    expect(moved).toMatchObject({ session_id: sid, moved: true, cached: { id }, manifest_url: `/api/stream/cache/${id}/f/master.m3u8` });
    expect((await app.request(moved.manifest_url)).status).toBe(200);
    // Once on it, another ask moves nothing and reads the cache's state again.
    await waitFor(app, id, 'ready');
    expect(await ask(true)).toMatchObject({ moved: false, cached: { id, state: 'ready' }, cache: { state: 'ready', progress: 1 } });

    // Not touched for four days: it would be cleared. The owner asks for the cache: it stays.
    await db.update(streamCaches).set({ updatedAt: new Date(Date.now() - 4 * 24 * 3_600_000) });
    const asked = await post(app, { kind: 'movie', tmdb_id: 990004 });
    expect(((await asked.json()) as Posted).cache).toMatchObject({ id, auto: false, state: 'ready' });
    expect(await cache.prune()).toBe(0);
    expect(await cache.get(id)).not.toBeNull();
  });

  it('a download fetched ahead gives way to one that is asked for, and carries on after it', async () => {
    await fake('mode', 'hls_token');
    await fake('delay_ms', 60);
    const { app, cache } = await ready();
    const next: StreamRef = { kind: 'tv', tmdbId: 990010, season: 1, episode: 2 };
    const ahead = await cache.player().ahead(next, { gentle: true });
    expect(ahead).toEqual({ started: true, state: 'downloading' });
    const aheadId = (await cache.find(next))?.id ?? '';
    expect((await cache.get(aheadId))?.auto).toBe(true);
    await until(async () => ((await cache.get(aheadId))?.segments_done ?? 0) >= 2);
    // The owner asks for a film: it does not wait behind the episode nobody watches yet.
    const asked = (await posted(app, { kind: 'movie', tmdb_id: 990004 })).cache.id;
    await waitFor(app, asked, 'ready');
    const then = await cache.get(aheadId);
    expect(then?.state).toBe('downloading');
    expect(then?.segments_done ?? 0).toBeLessThan(24);
    // Its turn comes back by itself, from the files already on disk.
    expect((await waitFor(app, aheadId, 'ready')).segments_done).toBe(24);
    // Asked again for an episode that is there: nothing starts.
    expect(await cache.player().ahead(next, { gentle: false })).toEqual({ started: false, state: 'ready' });
  });

  it('pause stops a download and keeps its files; the next request carries it on', async () => {
    await fake('mode', 'hls_token');
    await fake('delay_ms', 60);
    const { app, cache } = await ready();
    const next: StreamRef = { kind: 'tv', tmdbId: 990010, season: 1, episode: 2 };
    await cache.player().ahead(next, { gentle: false });
    const id = (await cache.find(next))?.id ?? '';
    await until(async () => ((await cache.get(id))?.segments_done ?? 0) >= 2);
    expect(await cache.pause(next)).toBe(true);
    expect(await cache.pause(next)).toBe(false);
    const [row] = await db.select().from(streamCaches);
    expect(row?.state).toBe('downloading');
    const kept = (await readdir(path.join(root, id))).filter((f) => /^[va]-\d{5}\.ts$/.test(f)).length;
    expect(kept).toBeGreaterThanOrEqual(2);
    await sleep(300);
    up.requests.length = 0;
    await sleep(300);
    expect(up.requests).toHaveLength(0);
    expect(await cache.player().ahead(next, { gentle: false })).toEqual({ started: true, state: 'downloading' });
    expect((await waitFor(app, id, 'ready')).segments_done).toBe(24);
    expect(up.requests.filter((r) => r.status === 200 && /\/tok\/.*seg\d+\.ts$/.test(r.path))).toHaveLength(24 - kept);
  });

  it('the next episode is cached while this one is watched, through the service and its position reports', async () => {
    await fake('mode', 'hls_token');
    const repo = new DirectStreamRepo(db);
    let clock = new Date('2026-11-17T01:00:00Z');
    const logged: string[] = [];
    let wired: StreamCache | null = null;
    const svc = new DirectStreamService({
      repo,
      runner: directStreamScriptRunner({ cliPath: FAKE_CLI }),
      host: 'host-a',
      seedFile: path.join(fakeDir, 'seed.json'),
      pageBase: () => 'http://localhost:4321',
      now: () => clock,
      log: (line) => void logged.push(line),
      caches: () => wired?.player() ?? null,
      ahead: true,
      hooks: { neighbors: async (ref) => (ref.kind === 'tv' && ref.episode === 1 ? { prev: null, next: { season: 1, episode: 2 } } : { prev: null, next: null }) },
    });
    const cache = new StreamCache({ repo, host: 'host-a', root, resolve: (ref) => svc.resolve(ref, { resumeS: 0 }), sleep: async () => undefined, log: () => undefined });
    wired = cache;
    open.push(cache);
    await svc.syncSeed();
    const session = await svc.resolve({ kind: 'tv', tmdbId: 990010, season: 1, episode: 1 }, { resumeS: 0 });
    const next: StreamRef = { kind: 'tv', tmdbId: 990010, season: 1, episode: 2 };
    // A 4-minute episode played past its half, reported every 5 s.
    for (let i = 0; i <= 26; i++) {
      svc.watched(session.id, { paused: false, over: false, positionS: i * 5, durationS: 240 });
      clock = new Date(clock.getTime() + 5_000);
    }
    await until(async () => (await cache.find(next))?.state === 'ready');
    expect((await cache.find(next))?.auto).toBe(true);
    expect(logged.filter((l) => l.includes('stream ahead'))).toEqual([
      '[notesd] stream ahead: caching TMDB tv 990010 S01E02 while TMDB tv 990010 S01E01 plays (one file at a time: the episode on screen still streams)',
    ]);
    // A film, and a service built without `ahead`, fetch nothing.
    expect(await cache.list()).toHaveLength(1);
  });

  it('clears a cache a pause started once nothing has written it for three days, and no other', async () => {
    const { app, cache } = await ready();
    const kept = (await posted(app, { kind: 'movie', tmdb_id: 990001 })).cache.id;
    await waitFor(app, kept, 'ready');
    const auto = (await cache.request({ kind: 'movie', tmdbId: 990002 }, { maxHeight: null, auto: true })).cache.id;
    await waitFor(app, auto, 'ready');
    expect(await cache.prune()).toBe(0);
    await db.update(streamCaches).set({ updatedAt: new Date(Date.now() - 4 * 24 * 3_600_000) });
    expect(await cache.prune()).toBe(1);
    expect((await cache.list()).map((c) => c.id)).toEqual([kept]);
    expect((await readdir(root)).sort()).toEqual([kept]);
  });

  it('fails a DASH source as cache_unsupported without fetching it, and a new request starts it again', async () => {
    await fake('mode', 'dash');
    const { app } = await ready();
    const id = (await posted(app, { kind: 'movie', tmdb_id: 550 })).cache.id;
    const failed = await waitFor(app, id, 'failed');
    expect(failed).toMatchObject({ state: 'failed', error: 'cache_unsupported' });
    expect(failed.error_detail).toMatch(/DASH/);
    expect(up.requests).toHaveLength(0);
    await fake('mode', 'hls');
    const again = await post(app, { kind: 'movie', tmdb_id: 550 });
    expect(again.status).toBe(202);
    expect((await waitFor(app, id, 'ready')).error).toBeNull();
  });

  it('refuses a POST or DELETE from another origin, a bad body, and answers direct_stream_off without the cache', async () => {
    const { app } = await ready();
    expect((await post(app, { kind: 'movie', tmdb_id: 550 }, {})).status).toBe(403);
    expect((await app.request('/api/stream/cache/00000000-0000-4000-8000-000000000000', { method: 'DELETE' })).status).toBe(403);
    expect((await post(app, { kind: 'tv', tmdb_id: 1399 })).status).toBe(400);
    expect((await app.request('/api/stream/cache/not-a-uuid')).status).toBe(404);
    const off = new Hono();
    off.route('/', streamCacheRoutes({ directStream: null, streamCache: null }));
    expect((await off.request('/api/stream/cache')).status).toBe(503);
  });
});
