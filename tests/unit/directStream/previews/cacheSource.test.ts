import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CachePreviewRow, CachePreviewView } from '../../../../src/directStream/cache/service.js';
import { CacheVideos } from '../../../../src/directStream/previews/cacheSource.js';
import { keyTag, LocalSource } from '../../../../src/directStream/previews/local.js';
import { addSheet } from '../../../../src/directStream/previews/sheetIndex.js';
import type { StreamSession } from '../../../../src/directStream/sessions.js';
import { fakeJpeg } from './fakes.js';

const ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER = 'bbbbbbbb-0000-4000-8000-000000000002';
const SID = 'C'.repeat(32);
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function tempDir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'notesd-previews-cache-'));
  dirs.push(d);
  return d;
}
const seg = (i: number) => `v-${String(i).padStart(5, '0')}.ts`;

/** A cache folder as cache/hls.ts writes it: `count` 4 s segments behind a key and an init section; `missing` not on disk. */
async function hlsCache(folder: string, count: number, missing: (i: number) => boolean = () => false): Promise<void> {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:7', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-KEY:METHOD=AES-128,URI="v-key-1.key"', '#EXT-X-MAP:URI="v-init-1.mp4"'];
  for (let i = 1; i <= count; i += 1) {
    lines.push('#EXTINF:4.0,', seg(i));
    if (!missing(i)) await writeFile(path.join(folder, seg(i)), 'segment');
  }
  lines.push('#EXT-X-ENDLIST', '');
  await writeFile(path.join(folder, 'video.m3u8'), lines.join('\n'));
  await writeFile(path.join(folder, 'v-key-1.key'), 'k'.repeat(16));
  await writeFile(path.join(folder, 'v-init-1.mp4'), 'init');
}

function viewOf(folder: string, rows: Record<string, CachePreviewRow>): CachePreviewView {
  return {
    folder: () => folder,
    get: async (id) => rows[id] ?? null,
    ready: async () => Object.values(rows).filter((r) => r.state === 'ready'),
    signature: async () => 'sig-1',
  };
}

const session = (over: Partial<Pick<StreamSession, 'cache' | 'torrent'>> = {}) =>
  ({ id: SID, ref: { kind: 'movie', tmdbId: 550 }, cache: null, torrent: null, previewRev: 0, ...over }) as unknown as StreamSession;
const hls: CachePreviewRow = { id: ID, state: 'ready', manifestKind: 'hls' };
const noProbe = { probeDuration: async () => null, log: () => undefined };

describe('a cloud cache as preview video', () => {
  it('covers the stretches whose segments are on disk', async () => {
    const folder = await tempDir();
    await hlsCache(folder, 200, (i) => i >= 91 && i <= 180);
    const video = await new CacheVideos(viewOf(folder, { [ID]: hls }), noProbe).forSession(session({ cache: { id: ID } as never }));
    expect(video).not.toBeNull();
    expect(video?.key).toBe(`cache-${ID}-${keyTag('sig-1')}`);
    expect(video?.dir).toBe(path.join(folder, 'previews'));
    expect(video?.durationS).toBe(800);
    expect(await video?.coverage()).toEqual([[0, 360], [720, 800]]);
  });

  it('reads a stretch from a playlist of only its segments, with absolute key and init and its media sequence', async () => {
    const folder = await tempDir();
    await hlsCache(folder, 200);
    const video = await new CacheVideos(viewOf(folder, { [ID]: hls }), noProbe).forSession(session({ cache: { id: ID } as never }));
    const input = await video?.input(730, 800);
    const args = input?.args ?? [];
    expect(args.slice(0, 8)).toEqual(['-f', 'hls', '-allowed_extensions', 'ALL', '-ss', '2.000', '-t', '70.000']);
    const file = args[args.indexOf('-i') + 1] ?? '';
    expect(path.dirname(file)).toBe(path.join(folder, 'previews'));
    const text = await readFile(file, 'utf8');
    expect(text).toContain('#EXT-X-MEDIA-SEQUENCE:189');
    expect(text).toContain(`#EXT-X-KEY:METHOD=AES-128,URI="${path.join(folder, 'v-key-1.key')}"`);
    expect(text).toContain(`#EXT-X-MAP:URI="${path.join(folder, 'v-init-1.mp4')}"`);
    expect(text.split('\n').filter((l) => l.startsWith('#EXTINF'))).toHaveLength(18);
    expect(text).toContain(path.join(folder, seg(183)));
    expect(text).not.toContain(path.join(folder, seg(182)));
    await input?.cleanup?.();
    await expect(readFile(file)).rejects.toThrow();
  });

  it('is the cache the session plays from and no other: none for a pass-through or a torrent session of a title cached here', async () => {
    const folder = await tempDir();
    await hlsCache(folder, 10);
    const other: CachePreviewRow = { id: OTHER, state: 'downloading', manifestKind: 'hls' };
    const videos = new CacheVideos(viewOf(folder, { [ID]: hls, [OTHER]: other }), noProbe);
    expect((await videos.forSession(session({ cache: { id: ID } as never })))?.key).toContain(ID);
    expect((await videos.forSession(session({ cache: { id: OTHER } as never })))?.key).toContain(OTHER);
    // A pass-through session of the same title: another provider's cache may be offset in time (R1.6), so none.
    expect(await videos.forSession(session())).toBeNull();
    expect(await videos.forSession(session({ torrent: { infoHash: 'a'.repeat(40) } as never }))).toBeNull();
  });

  it('a plain file counts only once joined, at the length ffprobe gives, asked once', async () => {
    const folder = await tempDir();
    const probed: string[] = [];
    const probe = { probeDuration: async (file: string) => (probed.push(file), 600), log: () => undefined };
    const downloading: CachePreviewRow = { id: ID, state: 'downloading', manifestKind: 'mp4' };
    expect(await new CacheVideos(viewOf(folder, { [ID]: downloading }), probe).forSession(session({ cache: { id: ID } as never }))).toBeNull();
    await writeFile(path.join(folder, 'video.mp4'), 'film');
    const videos = new CacheVideos(viewOf(folder, { [ID]: { ...downloading, state: 'ready' } }), probe);
    const video = await videos.forSession(session({ cache: { id: ID } as never }));
    expect(await video?.coverage()).toEqual([[0, 600]]);
    expect((await video?.input(360, 600))?.args).toEqual(['-ss', '360.000', '-t', '240.000', '-i', path.join(folder, 'video.mp4')]);
    await videos.forSession(session({ cache: { id: ID } as never }));
    expect(probed).toEqual([path.join(folder, 'video.mp4')]);
  });

  it('lists the frames of the sheets made for the stretches on disk', async () => {
    const folder = await tempDir();
    await hlsCache(folder, 200, (i) => i >= 91 && i <= 180);
    const source = new LocalSource('cache', new CacheVideos(viewOf(folder, { [ID]: hls }), noProbe), () => undefined);
    const s = session({ cache: { id: ID } as never });
    expect(await source.list(s)).toEqual({ state: 'none', source: null, cues: [] });
    const video = await new CacheVideos(viewOf(folder, { [ID]: hls }), noProbe).forSession(s);
    if (video === null) throw new Error('no video');
    await mkdir(video.dir, { recursive: true });
    await writeFile(path.join(video.dir, 'sheet-00000.jpg'), fakeJpeg(1440, 816));
    await addSheet(video, { index: 0, name: 'sheet-00000.jpg', start_s: 0, end_s: 360, frames: 36, frame_w: 240, frame_h: 136 });
    const list = await source.list(s);
    expect(list.state).toBe('partial');
    expect(list.source).toBe('local');
    expect(list.cues).toHaveLength(36);
    expect(list.cues[0]?.url).toBe(`/api/stream/sessions/${SID}/previews/sheet-00000.jpg?k=${keyTag(video.key)}`);
  });
});
