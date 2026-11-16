import { spawnSync } from 'node:child_process';
import { existsSync, openSync, readSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ffmpegSpawner, REMUX_DONE_FILE, remuxDir, TorrentRemux } from '../../../src/directStream/torrent/remux.js';

const HASH = 'c'.repeat(40);
const present = (bin: string): boolean => spawnSync(bin, ['-version']).status === 0;
const hasFfmpeg = present('ffmpeg') && present('ffprobe');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Serves `file` with Range as phase 1's file route does while a torrent downloads: bytes arrive at `rate` a second, and a read past them waits. */
async function trickle(file: string, rate: number): Promise<{ server: Server; url: string }> {
  const size = statSync(file).size;
  const fd = openSync(file, 'r');
  const t0 = Date.now();
  const arrived = (): number => Math.min(size, Math.floor(((Date.now() - t0) / 1000) * rate));
  const server = createServer((req, res) => {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
    const start = m === null ? 0 : Number(m[1]);
    const end = m === null || m[2] === '' ? size - 1 : Number(m[2]);
    res.writeHead(m === null ? 200 : 206, { 'accept-ranges': 'bytes', 'content-length': String(end - start + 1), ...(m === null ? {} : { 'content-range': `bytes ${start}-${end}/${size}` }) });
    let at = start;
    let closed = false;
    res.on('close', () => {
      closed = true;
    });
    void (async () => {
      while (at <= end && !closed) {
        const have = Math.min(end + 1, arrived());
        if (have <= at) {
          await sleep(50);
          continue;
        }
        const buf = Buffer.alloc(Math.min(have - at, 64 * 1024));
        readSync(fd, buf, 0, buf.length, at);
        at += buf.length;
        if (!res.write(buf)) await new Promise((r) => res.once('drain', r));
      }
      res.end();
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/stream/torrent/${HASH}/f/0` };
}

describe.skipIf(!hasFfmpeg)('the remux with the real ffmpeg (torrent phase 5)', () => {
  let work: string;
  let served: { server: Server; url: string };

  beforeAll(async () => {
    work = await mkdtemp(path.join(tmpdir(), 'notesd-remux-real-'));
    const film = path.join(work, 'film.mkv');
    const made = spawnSync('ffmpeg', [
      '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000',
      '-t', '24', '-map', '0:v', '-map', '1:a', '-map', '2:a',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '48',
      '-c:a', 'ac3', '-b:a', '192k', '-ac', '6',
      '-metadata:s:a:0', 'language=spa', '-metadata:s:a:1', 'language=eng',
      film,
    ]);
    expect(made.status).toBe(0);
    // About four seconds for the whole file: the first segment comes well before the end.
    served = await trickle(film, Math.ceil(statSync(film).size / 4));
  }, 60_000);

  afterAll(async () => {
    served?.server.close();
    await rm(work, { recursive: true, force: true });
  });

  it('remuxes an MKV with H.264 and two AC3 tracks into a growing EVENT playlist of H.264 and English AAC stereo, closed once the file is read', async () => {
    const torrents = path.join(work, 'torrents');
    const remux = new TorrentRemux({ dir: torrents, spawn: ffmpegSpawner('ffmpeg'), pollMs: 100, log: () => undefined });
    const probe = { video: { codec: 'h264' }, audio: [{ lang: 'spa' }, { lang: 'eng' }], durationS: 24 };
    const play = await remux.start({ infoHash: HASH, fileIndex: 0, input: served.url, probe, audioLang: 'en' });
    expect(play.manifestUrl).toBe(`/api/stream/torrent/${HASH}/hls/0/index.m3u8?remux=1&total_s=24`);

    const early = await (await remux.file(HASH, 0, 'index.m3u8', null))!.text();
    expect(early).toContain('#EXT-X-PLAYLIST-TYPE:EVENT');
    expect(early).toContain('#EXT-X-MAP:URI="init.mp4"');
    expect(early).not.toContain('#EXT-X-ENDLIST');
    const earlyMap = await remux.map(HASH);
    expect(earlyMap?.ranges[0]?.[1]).toBeLessThan(20);

    const dir = remuxDir(torrents, HASH, 0);
    await vi.waitFor(() => expect(existsSync(path.join(dir, REMUX_DONE_FILE))).toBe(true), { timeout: 30_000, interval: 200 });
    const final = await (await remux.file(HASH, 0, 'index.m3u8', null))!.text();
    expect(final.trimEnd().endsWith('#EXT-X-ENDLIST')).toBe(true);
    expect((await remux.map(HASH))?.ranges).toEqual([[0, expect.closeTo(24, 0)]]);

    const probed = JSON.parse(
      spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,channels:stream_tags=language', '-of', 'json', path.join(dir, 'index.m3u8')], { encoding: 'utf8' }).stdout,
    ) as { streams: Array<{ codec_type: string; codec_name: string; channels?: number; tags?: { language?: string } }> };
    expect(probed.streams.map((s) => [s.codec_type, s.codec_name])).toEqual([
      ['video', 'h264'],
      ['audio', 'aac'],
    ]);
    const audio = probed.streams.find((s) => s.codec_type === 'audio');
    expect(audio?.channels).toBe(2);
    expect(audio?.tags?.language).toBe('eng');
    await remux.close();
  }, 60_000);
});
