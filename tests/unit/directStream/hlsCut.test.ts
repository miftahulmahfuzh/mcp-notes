import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hlsCutArgs, withHlsSegments } from '../../../src/directStream/hlsCut.js';
import { audioRendition, hlsStretch, segmentsCovering } from '../../../src/directStream/picture.js';
import type { AudioCutter, StretchRequest } from '../../../src/directStream/torrent/subtitles/whisper.js';
import type { ResolvedSource } from '../../../src/directStream/types.js';

const BASE = 'https://cdn.example/v/master.m3u8';
const MEDIA = ['#EXTM3U', '#EXTINF:6,', 'a.ts', '#EXTINF:6,', 'b.ts', '#EXTINF:6,', 'c.ts', '#EXTINF:4.5,', 'd.ts', '#EXT-X-ENDLIST'].join('\n');
const hls = (over: Partial<ResolvedSource> = {}): Pick<ResolvedSource, 'manifest_kind' | 'manifest_url' | 'headers'> => ({
  manifest_url: BASE, manifest_kind: 'hls', headers: { referer: 'https://alpha.example/', origin: null, user_agent: 'UA' }, ...over,
});
const never = new AbortController().signal;

describe('segmentsCovering', () => {
  it('answers the segments that hold the stretch, where the first begins and how long the playlist runs', () => {
    expect(segmentsCovering(MEDIA, BASE, 7, 6)).toEqual({ urls: ['https://cdn.example/v/b.ts', 'https://cdn.example/v/c.ts'], fromS: 6, totalS: 22.5 });
    expect(segmentsCovering(MEDIA, BASE, 0, 6)).toEqual({ urls: ['https://cdn.example/v/a.ts'], fromS: 0, totalS: 22.5 });
    expect(segmentsCovering(MEDIA, BASE, 20, 60).urls).toEqual(['https://cdn.example/v/d.ts']);
  });
  it('a stretch past the end holds no segment: the film is over, not wrapped to its start', () => {
    expect(segmentsCovering(MEDIA, BASE, 600, 60)).toEqual({ urls: [], fromS: 0, totalS: 22.5 });
  });
});

describe('audioRendition', () => {
  it("picks the master's default audio playlist; a master whose sound is in the video segments has none", () => {
    const master = ['#EXTM3U', '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="x",DEFAULT=NO,URI="a1.m3u8"', '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="und",DEFAULT=YES,URI="a3.m3u8"', '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",URI="s.m3u8"', '#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a"', 'v0.m3u8'].join('\n');
    expect(audioRendition(master, BASE)).toBe('https://cdn.example/v/a3.m3u8');
    expect(audioRendition(['#EXTM3U', '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="in the video"', '#EXT-X-STREAM-INF:BANDWIDTH=1', 'v0.m3u8'].join('\n'), BASE)).toBeNull();
    expect(audioRendition(MEDIA, BASE)).toBeNull();
  });
});

describe('the audio of a stream ffmpeg cannot read, cut from its segments', () => {
  let dir: string;
  let out: string;
  /** 24 s of a 440 Hz tone that becomes 880 Hz at 12 s, as MPEG-TS segments and as fragmented MP4 with an audio playlist of its own. */
  let ts: { playlist: string; files: Map<string, Buffer> };
  let fmp4: { playlist: string; files: Map<string, Buffer> };
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'notesd-hlscut-'));
    out = path.join(dir, 'out.wav');
    const tone = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=12', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=12', '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[a]'];
    const read = (sub: string, playlist: string) => {
      const files = new Map<string, Buffer>();
      for (const name of readdirSync(path.join(dir, sub))) files.set(name, readFileSync(path.join(dir, sub, name)));
      return { playlist: readFileSync(path.join(dir, sub, playlist), 'utf8'), files };
    };
    execFileSync('mkdir', ['-p', path.join(dir, 'ts'), path.join(dir, 'fmp4')]);
    execFileSync('ffmpeg', ['-v', 'error', ...tone, '-f', 'lavfi', '-i', 'color=c=black:s=160x90:d=24:r=25', '-map', '[a]', '-map', '2:v', '-c:a', 'aac', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', '-hls_segment_filename', path.join(dir, 'ts', 's%d.ts'), path.join(dir, 'ts', 'index.m3u8')]);
    execFileSync('ffmpeg', ['-v', 'error', ...tone, '-map', '[a]', '-c:a', 'aac', '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.js', '-hls_segment_filename', path.join(dir, 'fmp4', 'p%d.jpg'), path.join(dir, 'fmp4', 'a3.m3u8')]);
    ts = read('ts', 'index.m3u8');
    fmp4 = read('fmp4', 'a3.m3u8');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(56, 1)]);
  /** A host as the soak met them: a master, then picture-wrapped MPEG-TS segments (`ts`) or an audio playlist of fragmented MP4 named like pictures (`fmp4`). */
  function host(kind: 'ts' | 'fmp4', o: { key?: boolean; missing?: string } = {}) {
    const asked: string[] = [];
    const master = kind === 'ts' ? ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=900000', 'hi/index.m3u8', '#EXT-X-STREAM-INF:BANDWIDTH=300000', 'lo/index.m3u8'].join('\n') : ['#EXTM3U', '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="und",DEFAULT=YES,URI="a3.m3u8"', '#EXT-X-STREAM-INF:BANDWIDTH=600000,AUDIO="audio"', 'v2.m3u8'].join('\n');
    const from = kind === 'ts' ? ts : fmp4;
    const fetchImpl = (async (url: string, init?: { headers?: Record<string, string> }) => {
      const name = String(url).split('/').pop() ?? '';
      asked.push(String(url).replace('https://cdn.example/v/', ''));
      if (init?.headers?.referer !== 'https://alpha.example/') return new Response('no', { status: 403 });
      if (String(url) === BASE) return new Response(master);
      if (name.endsWith('.m3u8')) return new Response(o.key ? from.playlist.replace('#EXTINF', '#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF') : from.playlist);
      const body = from.files.get(name);
      if (body === undefined || name === o.missing) return new Response('gone', { status: 404 });
      return new Response(kind === 'ts' ? Buffer.concat([PNG, body]) : body, { headers: { 'content-type': 'image/png' } });
    }) as unknown as typeof fetch;
    return { fetchImpl, asked };
  }
  /** The tone's pitch in a WAV, by its zero crossings per second. */
  const pitch = (file: string): number => {
    const pcm = readFileSync(file).subarray(44);
    let crossings = 0;
    for (let i = 2; i < pcm.length - 1; i += 2) if (pcm.readInt16LE(i - 2) < 0 !== pcm.readInt16LE(i) < 0) crossings += 1;
    return crossings / 2 / (pcm.length / 32_000);
  };
  const seconds = (file: string): number => (statSync(file).size - 44) / 32_000;
  /** ffmpeg alone, on a host it cannot read: it fails, or (past the end) comes back with the start of the film. */
  const plainFails: AudioCutter = async () => ({ ok: false, reason: "Stream map '0:a:0' matches no streams" });
  const request = (startS: number, lengthS: number, over: Partial<StretchRequest> = {}): StretchRequest => ({ url: BASE, hls: hls(), startS, lengthS, out, ...over });

  it('reads picture-wrapped MPEG-TS segments of the smallest rendition and trims to the second asked for', async () => {
    const h = host('ts');
    const cut = await withHlsSegments(plainFails, { ffmpegBin: 'ffmpeg', fetch: h.fetchImpl, retryMs: 1 })(request(13, 6), never);
    expect(cut.ok && Math.abs(cut.lengthS - 6) < 0.2).toBe(true);
    expect(Math.abs(seconds(out) - 6)).toBeLessThan(0.2);
    // From second 13 the tone is the higher one: a cut that began at the segment's start (12 s) would be the same, one from 8 s would not.
    expect(Math.round(pitch(out) / 10) * 10).toBe(880);
    expect(h.asked).toContain('lo/index.m3u8');
    expect(h.asked).not.toContain('hi/index.m3u8');
    expect(h.asked).not.toContain('s0.ts');
  });

  it('a stretch that crosses the change of tone holds both, in the right share', async () => {
    const h = host('ts');
    const cut = await withHlsSegments(plainFails, { ffmpegBin: 'ffmpeg', fetch: h.fetchImpl, retryMs: 1 })(request(9, 6), never);
    expect(cut.ok).toBe(true);
    // 3 s at 440 Hz, 3 s at 880 Hz.
    expect(Math.abs(pitch(out) - 660)).toBeLessThan(40);
  });

  it('reads fragmented MP4 from the audio playlist of its own, its init part first', async () => {
    const h = host('fmp4');
    const cut = await withHlsSegments(plainFails, { ffmpegBin: 'ffmpeg', fetch: h.fetchImpl, retryMs: 1 })(request(14, 5), never);
    expect(cut.ok && Math.abs(cut.lengthS - 5) < 0.2).toBe(true);
    expect(Math.round(pitch(out) / 10) * 10).toBe(880);
    expect(h.asked.slice(0, 3)).toEqual(['master.m3u8', 'a3.m3u8', 'init.js']);
  });

  it('past the end of the film is nothing, and ffmpeg alone (which came back with the first minute) is not asked', async () => {
    let plainAsked = 0;
    const wraps: AudioCutter = async () => ((plainAsked += 1), { ok: true, lengthS: 60 });
    const cut = await withHlsSegments(wraps, { ffmpegBin: 'ffmpeg', fetch: host('ts').fetchImpl, retryMs: 1 })(request(600, 60), never);
    expect(cut).toEqual({ ok: true, lengthS: 0 });
    expect(plainAsked).toBe(0);
  });

  it('the last stretch of the film is as long as what is left', async () => {
    let plainAsked = 0;
    const plain: AudioCutter = async () => ((plainAsked += 1), { ok: false, reason: 'x' });
    const cut = await withHlsSegments(plain, { ffmpegBin: 'ffmpeg', fetch: host('ts').fetchImpl, retryMs: 1 })(request(20, 60), never);
    expect(cut.ok && Math.abs(cut.lengthS - 4) < 0.3).toBe(true);
    expect(plainAsked).toBe(0);
  });

  it('falls back to ffmpeg alone for an encrypted stream, a refused playlist and a source that is not HLS', async () => {
    const asked: string[] = [];
    const plain: AudioCutter = async (r) => (asked.push(r.url), { ok: true, lengthS: r.lengthS });
    const cutter = (f: typeof fetch) => withHlsSegments(plain, { ffmpegBin: 'ffmpeg', fetch: f, retryMs: 1 });
    expect(await cutter(host('ts', { key: true }).fetchImpl)(request(0, 6), never)).toEqual({ ok: true, lengthS: 6 });
    expect(await cutter(host('ts').fetchImpl)(request(0, 6, { hls: hls({ headers: { referer: null, origin: null, user_agent: null } }) }), never)).toEqual({ ok: true, lengthS: 6 });
    const none = host('ts');
    expect(await cutter(none.fetchImpl)(request(0, 6, { hls: undefined, url: 'http://127.0.0.1:1/f/0' }), never)).toEqual({ ok: true, lengthS: 6 });
    expect(none.asked).toEqual([]);
    expect(asked).toHaveLength(3);
  });

  it('a segment that never answers fails the cut, so the gap is not taken for the end of the film; a longer plain cut stands', async () => {
    const h = host('ts', { missing: 's4.ts' });
    const short: AudioCutter = async () => ({ ok: true, lengthS: 1 });
    // s3 (12 to 16 s) arrived, s4 did not.
    expect(await withHlsSegments(short, { ffmpegBin: 'ffmpeg', fetch: h.fetchImpl, retryMs: 1 })(request(12, 12), never)).toEqual({ ok: false, reason: 'the stream host gave 4 s of the 12 s asked for' });
    const long: AudioCutter = async () => ({ ok: true, lengthS: 12 });
    expect(await withHlsSegments(long, { ffmpegBin: 'ffmpeg', fetch: h.fetchImpl, retryMs: 1 })(request(12, 12), never)).toEqual({ ok: true, lengthS: 12 });
  });

  it('a host that answers 502, then 403, then the playlist is asked a third time; a segment likewise', async () => {
    const h = host('ts');
    const seen = new Map<string, number>();
    const flaky = (async (url: string, init?: RequestInit) => {
      const n = (seen.get(String(url)) ?? 0) + 1;
      seen.set(String(url), n);
      if (String(url) === BASE && n === 1) return new Response('<html>bad gateway</html>', { status: 502 });
      if (String(url) === BASE && n === 2) return new Response('Forbidden', { status: 403 });
      if (String(url).endsWith('s3.ts') && n === 1) return new Response('Forbidden', { status: 403 });
      return h.fetchImpl(url, init);
    }) as unknown as typeof fetch;
    const cut = await withHlsSegments(plainFails, { ffmpegBin: 'ffmpeg', fetch: flaky, retryMs: 1 })(request(13, 2), never);
    expect(cut.ok && Math.abs(cut.lengthS - 2) < 0.2).toBe(true);
    expect(seen.get(BASE)).toBe(3);
  });

  it('hlsStretch says what the bytes are and where they begin', async () => {
    const begun: Array<[number, string]> = [];
    let bytes = 0;
    const got = await hlsStretch(hls(), 9, 6, host('fmp4').fetchImpl, AbortSignal.timeout(10_000), (part) => void (bytes += part.length), (fromS, format) => void begun.push([fromS, format]), 1);
    expect(begun).toHaveLength(1);
    expect(Math.round(begun[0]?.[0] ?? -1)).toBe(8);
    expect(begun[0]?.[1]).toBe('mp4');
    expect(got).toMatchObject({ segments: 2, sent: 2 });
    expect(Math.round(got?.totalS ?? 0)).toBe(24);
    expect(bytes).toBeGreaterThan(1000);
    expect(await hlsStretch(hls({ manifest_kind: 'mp4' }), 0, 6, host('ts').fetchImpl, AbortSignal.timeout(10_000), () => undefined)).toBeNull();
  });
});

describe('hlsCutArgs', () => {
  it('skips to the second asked for after the input, and names what stdin holds', () => {
    const args = hlsCutArgs(1.23456, 60, '/tmp/x.wav', 'mp4');
    expect(args.slice(args.indexOf('-f'), args.indexOf('-f') + 4)).toEqual(['-f', 'mp4', '-i', 'pipe:0']);
    expect(args.indexOf('-ss')).toBeGreaterThan(args.indexOf('-i'));
    expect(args[args.indexOf('-ss') + 1]).toBe('1.235');
    expect(hlsCutArgs(-0.2, 5, 'x')[hlsCutArgs(-0.2, 5, 'x').indexOf('-ss') + 1]).toBe('0');
  });
});
