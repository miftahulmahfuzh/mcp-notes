import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EmbeddedSubtitles } from '../../../../../src/directStream/torrent/subtitles/embedded.js';
import { CueFeeds, type CueFeed } from '../../../../../src/directStream/torrent/subtitles/feed.js';

const HAS_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0;
const HASH = 'd'.repeat(40);
const CHUNK = 16 * 1024;
const PACE_MS = 40;

const stamp = (s: number): string => `00:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')},000`;
const SRT = Array.from({ length: 20 }, (_, i) => `${i + 1}\n${stamp(3 * (i + 1) - 2)} --> ${stamp(3 * (i + 1))}\n<i>Line ${i + 1}</i>\n`).join('\n');
const ASS = [
  '[Script Info]',
  'ScriptType: v4.00+',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: Default,Arial,16,&Hffffff,&Hffffff,&H0,&H0,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,0',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Dialogue: 0,0:00:02.00,0:00:04.00,Default,,0,0,0,,{\\an8}{\\i1}Styled{\\i0} line\\Nsecond row',
  '',
].join('\n');

describe.skipIf(!HAS_FFMPEG)('the embedded track with the real ffmpeg', () => {
  let dir: string;
  let film: Buffer;
  let server: Server;
  let base: string;
  /** feed.size when the server wrote the last chunk of the file. */
  let sizeAtLastChunk: number | null = null;
  let watched: CueFeed | null = null;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'notesd-embedded-ffmpeg-'));
    await writeFile(path.join(dir, 'en.srt'), SRT);
    await writeFile(path.join(dir, 'en.ass'), ASS);
    const made = spawnSync('ffmpeg', [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=25:duration=60',
      '-f', 'lavfi', '-i', 'sine=duration=60',
      '-i', path.join(dir, 'en.srt'), '-i', path.join(dir, 'en.ass'),
      '-map', '0', '-map', '1', '-map', '2', '-map', '3',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-c:s:0', 'srt', '-c:s:1', 'ass',
      '-metadata:s:s:0', 'language=eng', '-metadata:s:s:1', 'language=eng',
      path.join(dir, 'film.mkv'),
    ]);
    expect(made.status).toBe(0);
    film = await readFile(path.join(dir, 'film.mkv'));
    server = createServer((req, res) => {
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
      const start = m ? Number(m[1]) : 0;
      const end = m && m[2] !== '' ? Number(m[2]) : film.length - 1;
      res.writeHead(m ? 206 : 200, {
        'content-length': String(end - start + 1),
        'accept-ranges': 'bytes',
        'content-type': 'video/x-matroska',
        ...(m ? { 'content-range': `bytes ${start}-${end}/${film.length}` } : {}),
      });
      let at = start;
      const tick = (): void => {
        if (res.destroyed) return;
        const to = Math.min(at + CHUNK, end + 1);
        if (to === film.length && sizeAtLastChunk === null && watched !== null) sizeAtLastChunk = watched.size;
        res.write(film.subarray(at, to));
        at = to;
        if (at > end) res.end();
        else setTimeout(tick, PACE_MS);
      };
      tick();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/film.mkv`;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  it('extracts the SubRip track over HTTP as the file arrives, with the file\'s own times (R3.4)', async () => {
    const subs = new EmbeddedSubtitles({ ffmpegBin: 'ffmpeg', feeds: new CueFeeds({ folderOf: (hash) => path.join(dir, hash), log: () => {} }), input: async () => base, log: () => {} });
    const feed = await subs.feedOf(HASH, 0, { index: 2, codec: 'subrip', lang: 'eng' });
    expect(feed).not.toBeNull();
    watched = feed;
    for (let i = 0; i < 300 && !feed!.isComplete; i++) await new Promise((r) => setTimeout(r, 100));
    expect(feed!.isComplete).toBe(true);
    const { cues } = feed!.read(0);
    expect(cues).toHaveLength(20);
    expect(cues[0]).toEqual({ start_s: 1, end_s: 3, text: '<i>Line 1</i>' });
    expect(cues[16]).toEqual({ start_s: 49, end_s: 51, text: '<i>Line 17</i>' });
    // Progressive: most cues were in the feed before the server had sent the end of the file.
    expect(sizeAtLastChunk).not.toBeNull();
    expect(sizeAtLastChunk!).toBeGreaterThanOrEqual(10);
  }, 60_000);

  it('extracts an ASS track as text, its override codes gone', async () => {
    const subs = new EmbeddedSubtitles({ ffmpegBin: 'ffmpeg', feeds: new CueFeeds({ folderOf: (hash) => path.join(dir, hash), log: () => {} }), input: async () => path.join(dir, 'film.mkv'), log: () => {} });
    const feed = await subs.feedOf(HASH, 0, { index: 3, codec: 'ass', lang: 'eng' });
    for (let i = 0; i < 300 && !feed!.isComplete; i++) await new Promise((r) => setTimeout(r, 100));
    expect(feed!.read(0).cues).toEqual([{ start_s: 2, end_s: 4, text: '<i>Styled</i> line\nsecond row' }]);
  }, 60_000);
});
