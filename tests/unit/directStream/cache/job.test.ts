import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CacheJob, type CacheJobDeps, type CacheRecorder } from '../../../../src/directStream/cache/job.js';
import { CacheStore } from '../../../../src/directStream/cache/store.js';
import type { FetchLike } from '../../../../src/directStream/passThrough.js';
import type { CachePlanned } from '../../../../src/directStream/repo.js';
import { SessionStore, type StreamSession } from '../../../../src/directStream/sessions.js';
import type { ResolvedSource, StreamRef } from '../../../../src/directStream/types.js';

const ID = '11111111-1111-4111-8111-111111111111';
const REF: StreamRef = { kind: 'movie', tmdbId: 550 };
const CDN = 'https://cdn.test';

interface HostRequest {
  path: string;
  range: string | null;
  referer: string | null;
}

/** A stream host in memory: answers by path, honours abort, logs what arrived and what was answered. */
function fakeHost(handle: (req: HostRequest, n: number) => Response | Promise<Response>) {
  const arrivals: string[] = [];
  const answered: { path: string; status: number }[] = [];
  const counts = new Map<string, number>();
  const fetch: FetchLike = (url, init) => {
    const u = new URL(url);
    const headers = (init.headers ?? {}) as Record<string, string>;
    const n = (counts.get(u.pathname) ?? 0) + 1;
    counts.set(u.pathname, n);
    arrivals.push(u.pathname);
    const signal = init.signal ?? null;
    return new Promise<Response>((resolve, reject) => {
      const onAbort = (): void => reject(new DOMException('aborted', 'AbortError'));
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      Promise.resolve(handle({ path: u.pathname, range: headers.range ?? null, referer: headers.referer ?? null }, n)).then(
        (res) => {
          signal?.removeEventListener('abort', onAbort);
          answered.push({ path: u.pathname, status: res.status });
          resolve(res);
        },
        reject,
      );
    });
  };
  return { fetch, arrivals, answered, ok: (p: string): number => answered.filter((a) => a.path === p && a.status < 300).length };
}
type Host = ReturnType<typeof fakeHost>;

const playlist = (text: string): Response => new Response(text, { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
const status = (code: number): Response => new Response('no', { status: code });
function bytes(body: Buffer, range: string | null): Response {
  const m = range === null ? null : /^bytes=(\d+)-(\d+)$/.exec(range);
  if (m === null) return new Response(new Uint8Array(body), { status: 200 });
  const start = Number(m[1]);
  const end = Math.min(Number(m[2]), body.length - 1);
  return new Response(new Uint8Array(body.subarray(start, end + 1)), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${body.length}` } });
}
const media = (segments: number, prefix = 'seg'): string =>
  ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:0', ...Array.from({ length: segments }, (_, i) => ['#EXTINF:4.0,', `${prefix}${i + 1}.ts`]).flat(), '#EXT-X-ENDLIST', ''].join('\n');

function session(manifest: string, over: Partial<ResolvedSource> = {}, audioLang: string | null = null): StreamSession {
  const source: ResolvedSource = {
    provider: 'Bravo',
    embed_url: 'https://embed.test/',
    manifest_url: manifest,
    manifest_kind: 'hls',
    headers: { referer: 'https://embed.test/', origin: null, user_agent: 'UA' },
    subtitles: [],
    best_height: null,
    en_subtitle: false,
    took_s: 1,
    ...over,
  };
  return new SessionStore().create(REF, source, [], null, audioLang);
}

async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

interface SetupOptions {
  maxHeight?: number | null;
  root?: string;
  chunkBytes?: number;
  parallel?: number;
}

async function setup(host: Host, resolve: (n: number) => StreamSession, options: SetupOptions = {}) {
  const root = options.root ?? (await mkdtemp(path.join(os.tmpdir(), 'cache-job-')));
  if (options.root === undefined) roots.push(root);
  const calls = { resolved: 0, planned: [] as CachePlanned[], progress: [] as number[], subtitle: [] as boolean[] };
  const recorder: CacheRecorder = {
    resolved: async () => {
      calls.resolved += 1;
    },
    planned: async (_id, p) => {
      calls.planned.push(p);
    },
    progress: async (_id, done) => {
      calls.progress.push(done);
    },
    subtitle: async (_id, saved) => {
      calls.subtitle.push(saved);
    },
  };
  const sleeps: number[] = [];
  let resolves = 0;
  const deps: CacheJobDeps = {
    store: new CacheStore(root),
    recorder,
    resolve: async () => {
      resolves += 1;
      return resolve(resolves);
    },
    fetch: host.fetch,
    now: () => new Date('2026-11-16T00:00:00Z'),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    log: () => undefined,
    parallel: options.parallel ?? 1,
    ...(options.chunkBytes === undefined ? {} : { chunkBytes: options.chunkBytes }),
  };
  const job = new CacheJob(ID, REF, options.maxHeight ?? null, deps);
  return {
    job,
    root,
    calls,
    sleeps,
    resolves: (): number => resolves,
    file: (name: string): Promise<Buffer> => readFile(path.join(root, ID, name)),
    names: async (): Promise<string[]> => (await readdir(path.join(root, ID))).sort(),
  };
}

const MASTER = [
  '#EXTM3U',
  '#EXT-X-INDEPENDENT-SEGMENTS',
  '#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"',
  '360/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"',
  '720/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"',
  '1080/index.m3u8',
  '',
].join('\n');

describe('CacheJob', () => {
  it('caches the highest rendition not above max_height, with its English subtitle, and writes the local playlists first', async () => {
    const host = fakeHost((r) => {
      if (r.path === '/master.m3u8') return playlist(MASTER);
      if (/^\/(360|720|1080)\/index\.m3u8$/.test(r.path)) return playlist(media(3));
      if (/\/seg\d\.ts$/.test(r.path)) return bytes(Buffer.from(r.path), r.range);
      if (r.path === '/en.srt') return new Response('1\n00:00:01,000 --> 00:00:02,000\nHi.\n');
      return status(404);
    });
    const t = await setup(host, () => session(`${CDN}/master.m3u8`, { subtitles: [{ url: `${CDN}/en.srt`, lang: 'en', label: 'English', format: 'srt', source: 'request' }] }), { maxHeight: 720 });
    expect(await t.job.run()).toEqual({ state: 'ready', segments: 3, bytes: 36, subtitle: true });
    expect(host.answered.map((a) => a.path).filter((p) => p.endsWith('.m3u8'))).toEqual(['/master.m3u8', '/720/index.m3u8']);
    expect((await t.file('v-00002.ts')).toString()).toBe('/720/seg2.ts');
    expect(await t.names()).toEqual(['cache.json', 'master.m3u8', 'subtitle.vtt', 'v-00001.ts', 'v-00002.ts', 'v-00003.ts', 'video.m3u8']);
    expect((await t.file('master.m3u8')).toString()).toBe(
      ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-INDEPENDENT-SEGMENTS', '#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"', 'video.m3u8', ''].join('\n'),
    );
    expect((await t.file('subtitle.vtt')).toString()).toBe('WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nHi.\n');
    expect(t.calls.planned).toEqual([{ provider: 'Bravo', manifestKind: 'hls', height: 720, audioLang: null, segmentsTotal: 3, segmentsDone: 0, bytes: 0, durationS: 12 }]);
    expect(t.calls.subtitle).toEqual([true]);
    expect(t.calls.resolved).toBe(1);
  });

  it('retries a failing segment with backoff', async () => {
    const host = fakeHost((r, n) => (r.path === '/index.m3u8' ? playlist(media(3)) : r.path === '/seg2.ts' && n <= 2 ? status(503) : bytes(Buffer.from(r.path), r.range)));
    const t = await setup(host, () => session(`${CDN}/index.m3u8`));
    expect((await t.job.run()).state).toBe('ready');
    expect(t.sleeps).toEqual([1000, 2000]);
    expect(host.ok('/seg2.ts')).toBe(1);
    expect(host.arrivals.filter((p) => p === '/seg2.ts')).toHaveLength(3);
  });

  it('fails after six tries of one segment', async () => {
    const host = fakeHost((r) => (r.path === '/index.m3u8' ? playlist(media(3)) : r.path === '/seg2.ts' ? status(503) : bytes(Buffer.from(r.path), r.range)));
    const t = await setup(host, () => session(`${CDN}/index.m3u8`));
    expect(await t.job.run()).toEqual({ state: 'failed', error: 'download_failed', detail: 'v-00002.ts: HTTP 503 (6 tries)' });
    expect(t.sleeps).toEqual([1000, 2000, 4000, 8000, 16000]);
  });

  it('resolves again on a refused token and keeps the segments already on disk, matched by index', async () => {
    const host = fakeHost((r) => {
      const m = /^\/t(\d)\/(.+)$/.exec(r.path);
      if (m === null) return status(404);
      if (m[2] === 'index.m3u8') return playlist(media(5));
      const seg = Number(/^seg(\d+)\.ts$/.exec(m[2] ?? '')?.[1] ?? 0);
      if (m[1] === '1' && seg >= 3) return status(403);
      return bytes(Buffer.from(r.path), r.range);
    });
    const t = await setup(host, (n) => session(`${CDN}/t${n}/index.m3u8`));
    expect((await t.job.run()).state).toBe('ready');
    expect(t.resolves()).toBe(2);
    expect(t.calls.resolved).toBe(2);
    expect(host.ok('/t1/seg1.ts')).toBe(1);
    expect(host.ok('/t1/seg2.ts')).toBe(1);
    expect(host.arrivals).not.toContain('/t2/seg1.ts');
    expect(host.arrivals).not.toContain('/t2/seg2.ts');
    expect((await t.file('v-00002.ts')).toString()).toBe('/t1/seg2.ts');
    expect((await t.file('v-00005.ts')).toString()).toBe('/t2/seg5.ts');
    expect(t.calls.planned).toHaveLength(1);
  });

  it('starts over when the fresh source has another shape', async () => {
    const host = fakeHost((r) => {
      const m = /^\/t(\d)\/(.+)$/.exec(r.path);
      if (m === null) return status(404);
      if (m[2] === 'index.m3u8') return playlist(media(m[1] === '1' ? 5 : 6));
      const seg = Number(/^seg(\d+)\.ts$/.exec(m[2] ?? '')?.[1] ?? 0);
      if (m[1] === '1' && seg >= 3) return status(403);
      return bytes(Buffer.from(r.path), r.range);
    });
    const t = await setup(host, (n) => session(`${CDN}/t${n}/index.m3u8`));
    expect(await t.job.run()).toEqual({ state: 'ready', segments: 6, bytes: 6 * '/t2/seg1.ts'.length, subtitle: false });
    expect(host.ok('/t2/seg1.ts')).toBe(1);
    expect((await t.file('v-00001.ts')).toString()).toBe('/t2/seg1.ts');
    expect((await t.names()).filter((n) => n.startsWith('v-'))).toHaveLength(6);
    expect(t.calls.planned).toHaveLength(2);
  });

  it('fails as token_refused after three fresh resolves without progress', async () => {
    const host = fakeHost((r) => (r.path === '/t1/index.m3u8' ? playlist(media(3)) : status(403)));
    const t = await setup(host, () => session(`${CDN}/t1/index.m3u8`));
    expect(await t.job.run()).toMatchObject({ state: 'failed', error: 'token_refused' });
    expect(t.resolves()).toBe(4);
  });

  it('stops on cancel, and a new run carries on from the files on disk', async () => {
    let block = true;
    const host = fakeHost((r) =>
      r.path === '/index.m3u8' ? playlist(media(5)) : r.path === '/seg3.ts' && block ? new Promise<Response>(() => undefined) : bytes(Buffer.from(r.path), r.range),
    );
    const a = await setup(host, () => session(`${CDN}/index.m3u8`));
    const running = a.job.run();
    await until(() => host.arrivals.includes('/seg3.ts'));
    a.job.cancel();
    expect(await running).toEqual({ state: 'cancelled' });
    expect(host.arrivals).not.toContain('/seg4.ts');
    expect(await a.names()).toEqual(['cache.json', 'master.m3u8', 'v-00001.ts', 'v-00002.ts', 'video.m3u8']);
    block = false;
    const b = await setup(host, () => session(`${CDN}/index.m3u8`), { root: a.root });
    expect((await b.job.run()).state).toBe('ready');
    expect(host.ok('/seg1.ts')).toBe(1);
    expect(host.ok('/seg2.ts')).toBe(1);
    expect(host.ok('/seg3.ts')).toBe(1);
    expect(b.calls.planned[0]?.segmentsDone).toBe(2);
  });

  it('fetches a file asked for now ahead of the queue, once', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const host = fakeHost(async (r) => {
      if (r.path === '/index.m3u8') return playlist(media(6));
      if (r.path === '/seg1.ts') await held;
      return bytes(Buffer.from(r.path), r.range);
    });
    const t = await setup(host, () => session(`${CDN}/index.m3u8`));
    const running = t.job.run();
    await until(() => host.arrivals.includes('/seg1.ts'));
    await t.job.fetchNow('v-00005.ts');
    expect((await t.file('v-00005.ts')).toString()).toBe('/seg5.ts');
    expect(host.arrivals).toEqual(['/index.m3u8', '/seg1.ts', '/seg5.ts']);
    release();
    expect((await running).state).toBe('ready');
    expect(host.arrivals.filter((p) => p === '/seg5.ts')).toHaveLength(1);
  });

  it('answers cache_unsupported for DASH, DRM and a live playlist', async () => {
    const dash = fakeHost(() => status(404));
    const t1 = await setup(dash, () => session(`${CDN}/m.mpd`, { manifest_kind: 'dash' }));
    expect(await t1.job.run()).toMatchObject({ state: 'failed', error: 'cache_unsupported' });
    expect(dash.arrivals).toEqual([]);
    const drm = fakeHost(() => playlist('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://k"\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST\n'));
    const t2 = await setup(drm, () => session(`${CDN}/index.m3u8`));
    expect(await t2.job.run()).toMatchObject({ state: 'failed', error: 'cache_unsupported', detail: expect.stringMatching(/SAMPLE-AES/) });
    const live = fakeHost(() => playlist('#EXTM3U\n#EXTINF:4,\na.ts\n'));
    const t3 = await setup(live, () => session(`${CDN}/index.m3u8`));
    expect(await t3.job.run()).toMatchObject({ state: 'failed', error: 'cache_unsupported', detail: expect.stringMatching(/live/) });
  });

  it('downloads a plain file by ranges and joins it', async () => {
    const film = Buffer.from(Array.from({ length: 2500 }, (_, i) => i % 251));
    const host = fakeHost((r) => (r.path === '/film.mp4' ? bytes(film, r.range) : status(404)));
    const t = await setup(host, () => session(`${CDN}/film.mp4`, { manifest_kind: 'mp4' }), { chunkBytes: 1000 });
    expect(await t.job.run()).toEqual({ state: 'ready', segments: 3, bytes: 2500, subtitle: false });
    expect(await t.file('video.mp4')).toEqual(film);
    expect((await t.names()).filter((n) => n.startsWith('c-'))).toEqual([]);
  });

  it('caches byte-range segments, an fMP4 init section, an AES-128 key with its IV, and a discontinuity', async () => {
    const mediaFile = Buffer.from(Array.from({ length: 2100 }, (_, i) => i % 256));
    const text = [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-TARGETDURATION:4',
      '#EXT-X-MEDIA-SEQUENCE:10',
      '#EXT-X-MAP:URI="media.mp4",BYTERANGE="100@0"',
      '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.test/k1?tok=1",IV=0x0000000000000000000000000000000A',
      '#EXTINF:4.0,',
      '#EXT-X-BYTERANGE:1000@100',
      'media.mp4',
      '#EXTINF:4.0,',
      '#EXT-X-BYTERANGE:1000',
      'media.mp4',
      '#EXT-X-DISCONTINUITY',
      '#EXT-X-KEY:METHOD=NONE',
      '#EXTINF:3.5,',
      'part3.m4s',
      '#EXT-X-ENDLIST',
      '',
    ].join('\n');
    const host = fakeHost((r) => {
      if (r.path === '/index.m3u8') return playlist(text);
      if (r.path === '/media.mp4') return bytes(mediaFile, r.range);
      if (r.path === '/k1') return new Response(new Uint8Array(Buffer.alloc(16, 9)));
      if (r.path === '/part3.m4s') return bytes(Buffer.from('third'), r.range);
      return status(404);
    });
    const t = await setup(host, () => session(`${CDN}/index.m3u8`));
    expect((await t.job.run()).state).toBe('ready');
    expect(await t.file('v-init-1.mp4')).toEqual(mediaFile.subarray(0, 100));
    expect(await t.file('v-00001.m4s')).toEqual(mediaFile.subarray(100, 1100));
    expect(await t.file('v-00002.m4s')).toEqual(mediaFile.subarray(1100, 2100));
    expect(await t.file('v-key-1.key')).toEqual(Buffer.alloc(16, 9));
    expect((await t.file('video.m3u8')).toString().split('\n')).toEqual([
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-TARGETDURATION:4',
      '#EXT-X-MEDIA-SEQUENCE:10',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXT-X-KEY:METHOD=AES-128,URI="v-key-1.key",IV=0x0000000000000000000000000000000A',
      '#EXT-X-MAP:URI="v-init-1.mp4"',
      '#EXTINF:4.0,',
      'v-00001.m4s',
      '#EXTINF:4.0,',
      'v-00002.m4s',
      '#EXT-X-DISCONTINUITY',
      '#EXT-X-KEY:METHOD=NONE',
      '#EXTINF:3.5,',
      'v-00003.m4s',
      '#EXT-X-ENDLIST',
      '',
    ]);
  });

  it('takes the audio rendition in the original language the session names, never the default dub', async () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio/en.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Korean",LANGUAGE="ko",AUTOSELECT=YES,CHANNELS="2",URI="audio/ko.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,AUDIO="aud"',
      '720.m3u8',
      '',
    ].join('\n');
    const host = fakeHost((r) => {
      if (r.path === '/master.m3u8') return playlist(master);
      if (r.path === '/720.m3u8') return playlist(media(2, 'v'));
      if (r.path === '/audio/ko.m3u8') return playlist(media(2, 'k'));
      if (r.path === '/audio/en.m3u8') return playlist(media(2, 'e'));
      return bytes(Buffer.from(r.path), r.range);
    });
    const t = await setup(host, () => session(`${CDN}/master.m3u8`, { audio: { languages: ['en', 'ko'], tracks: 2, original: true, track: { lang: 'ko', label: 'Korean' } } }, 'ko'));
    expect(await t.job.run()).toMatchObject({ state: 'ready', segments: 4 });
    expect(host.arrivals.some((p) => p.startsWith('/audio/e'))).toBe(false);
    expect((await t.file('a-00002.ts')).toString()).toBe('/audio/k2.ts');
    expect((await t.file('master.m3u8')).toString()).toBe(
      [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Korean",LANGUAGE="ko",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="audio.m3u8"',
        '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,AUDIO="audio"',
        'video.m3u8',
        '',
      ].join('\n'),
    );
    expect(t.calls.planned[0]?.audioLang).toBe('ko');
  });
});
