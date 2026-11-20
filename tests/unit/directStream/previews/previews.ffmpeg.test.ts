import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CachePreviewRow, CachePreviewView } from '../../../../src/directStream/cache/service.js';
import { ffmpegPreviewSpawner, jpegSize, SheetBuilder } from '../../../../src/directStream/previews/builder.js';
import { CacheVideos } from '../../../../src/directStream/previews/cacheSource.js';
import { LocalSource } from '../../../../src/directStream/previews/local.js';
import { StreamPreviews } from '../../../../src/directStream/previews/service.js';
import type { StreamSession } from '../../../../src/directStream/sessions.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

describe.skipIf(!hasFfmpeg)('seek previews from a real HLS cache with the real ffmpeg', () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'notesd-previews-ffmpeg-'));

  beforeAll(() => {
    const made = spawnSync(
      'ffmpeg',
      ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=5', '-t', '400', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '10',
        '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod', '-start_number', '1', '-hls_segment_filename', 'v-%05d.ts', 'video.m3u8'],
      { cwd: folder },
    );
    if (made.status !== 0) throw new Error(`ffmpeg could not make the fixture: ${made.stderr.toString()}`);
  }, 120_000);

  afterAll(() => rm(folder, { recursive: true, force: true }));

  it('makes sheets only for what is on disk, niced, and the rest once it arrives', async () => {
    const row: CachePreviewRow = { id: 'aaaaaaaa-0000-4000-8000-000000000001', state: 'ready', manifestKind: 'hls' };
    const view: CachePreviewView = { folder: () => folder, get: async () => row, ready: async () => [row], signature: async () => 'sig' };
    const logged: string[] = [];
    const log = (line: string) => void logged.push(line);
    const session = { id: 'F'.repeat(32), ref: { kind: 'movie', tmdbId: 550 }, cache: { id: row.id }, torrent: null, previewRev: 0 } as unknown as StreamSession;
    const previews = new StreamPreviews({
      sources: [new LocalSource('cache', new CacheVideos(view, { probeDuration: async () => null, log }), log)],
      builder: new SheetBuilder({ spawn: ffmpegPreviewSpawner('ffmpeg'), ffmpegBin: 'ffmpeg', log }),
      peek: () => session,
      log,
      lookMs: 0,
    });
    await rename(path.join(folder, 'v-00095.ts'), path.join(folder, 'held.ts'));
    previews.reported(session.id);
    await expect.poll(async () => (await previews.list(session)).cues.length, { timeout: 30_000, interval: 200 }).toBe(36);
    expect(await previews.list(session)).toMatchObject({ state: 'partial', source: 'local' });
    expect(jpegSize(await readFile(path.join(folder, 'previews', 'sheet-00000.jpg')))).toEqual({ width: 1440, height: 816 });
    expect(logged.filter((l) => l.includes('made sheet'))).toEqual([expect.stringMatching(/made sheet 1\/2 of cache-.* \(nice 19\)$/)]);
    await rename(path.join(folder, 'held.ts'), path.join(folder, 'v-00095.ts'));
    previews.reported(session.id);
    await expect.poll(async () => (await previews.list(session)).state, { timeout: 30_000, interval: 200 }).toBe('ready');
    expect((await previews.list(session)).cues).toHaveLength(40);
    await previews.close();
  }, 90_000);
});
