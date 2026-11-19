import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUDIO_CLIP_SEGMENTS, firstAudioOf, hlsSegmentAudioGrabber, type AudioGrabber } from '../../../src/directStream/audioLang.js';
import { hlsTransportStream, segmentsFrom } from '../../../src/directStream/picture.js';
import type { ResolvedSource } from '../../../src/directStream/types.js';

const MEDIA = ['#EXTM3U', '#EXT-X-TARGETDURATION:6', '#EXTINF:6,', 'a.ts', '#EXTINF:6,', 'b.ts', '#EXTINF:6,', 'c.ts', '#EXTINF:6,', 'd.ts', '#EXT-X-ENDLIST'].join('\n');
const BASE = 'https://cdn.example/v/index.m3u8';
const source = (over: Partial<ResolvedSource> = {}): ResolvedSource => ({
  provider: 'Alpha', embed_url: '', manifest_url: BASE, manifest_kind: 'hls', headers: { referer: 'https://alpha.example/', origin: null, user_agent: 'UA' },
  subtitles: [], best_height: 1080, en_subtitle: false, audio: null, took_s: 1, ...over,
});

describe('segmentsFrom', () => {
  it('answers the segments in a row from the one that holds the second', () => {
    expect(segmentsFrom(MEDIA, BASE, 0, 2)).toEqual(['https://cdn.example/v/a.ts', 'https://cdn.example/v/b.ts']);
    expect(segmentsFrom(MEDIA, BASE, 7, 2)).toEqual(['https://cdn.example/v/b.ts', 'https://cdn.example/v/c.ts']);
    expect(segmentsFrom(MEDIA, BASE, 13, 8)).toEqual(['https://cdn.example/v/c.ts', 'https://cdn.example/v/d.ts']);
  });
  it('a film shorter than the second gives its last segments; no segments, none', () => {
    expect(segmentsFrom(MEDIA, BASE, 600, 2)).toEqual(['https://cdn.example/v/c.ts', 'https://cdn.example/v/d.ts']);
    expect(segmentsFrom('#EXTM3U', BASE, 0, 4)).toEqual([]);
    expect(segmentsFrom(MEDIA, BASE, 0, 0)).toEqual([]);
  });
});

describe('the audio clip read from the segments themselves', () => {
  let dir: string;
  /** Two real 4 s MPEG-TS segments with a tone, made once with ffmpeg. */
  let segs: Buffer[];
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'notesd-audioseg-'));
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-f', 'lavfi', '-i', 'color=c=black:s=160x90:d=8', '-c:a', 'aac', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', '-hls_segment_filename', path.join(dir, 's%d.ts'), path.join(dir, 'index.m3u8')]);
    segs = [readFileSync(path.join(dir, 's0.ts')), readFileSync(path.join(dir, 's1.ts'))];
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(56, 1)]);
  /** A host whose every segment is a small picture file with the transport stream behind it (HyperLink's). */
  function host(o: { wrap?: boolean; key?: boolean; missing?: string } = {}) {
    const asked: Array<{ url: string; referer: string | null }> = [];
    const playlist = ['#EXTM3U', ...(o.key ? ['#EXT-X-KEY:METHOD=AES-128,URI="k"'] : []), '#EXTINF:4,', 's0', '#EXTINF:4,', 's1', '#EXT-X-ENDLIST'].join('\n');
    const fetchImpl = (async (url: string, init?: { headers?: Record<string, string> }) => {
      asked.push({ url: String(url), referer: init?.headers?.referer ?? null });
      if (String(url) === BASE) return new Response(playlist);
      const name = String(url).split('/').pop() ?? '';
      if (name === o.missing) return new Response('gone', { status: 404 });
      const body = segs[name === 's0' ? 0 : 1] as Buffer;
      return new Response(o.wrap === false ? body : Buffer.concat([PNG, body]), { headers: { 'content-type': 'text/html' } });
    }) as unknown as typeof fetch;
    return { fetchImpl, asked };
  }

  it('hlsTransportStream cuts each segment at its sync and joins them, asking with the captured headers', async () => {
    const h = host();
    const ts = await hlsTransportStream(source(), 0, 8, h.fetchImpl, AbortSignal.timeout(10_000));
    expect(ts?.length).toBe((segs[0] as Buffer).length + (segs[1] as Buffer).length);
    expect(ts?.[0]).toBe(0x47);
    expect(h.asked.every((a) => a.referer === 'https://alpha.example/')).toBe(true);
  });

  it('answers null for an encrypted stream, a stream that is not HLS, and segments that are not a transport stream', async () => {
    expect(await hlsTransportStream(source(), 0, 8, host({ key: true }).fetchImpl, AbortSignal.timeout(10_000))).toBeNull();
    expect(await hlsTransportStream(source({ manifest_kind: 'mp4' }), 0, 8, host().fetchImpl, AbortSignal.timeout(10_000))).toBeNull();
    const notTs = (async (url: string) => (String(url) === BASE ? new Response(MEDIA) : new Response(Buffer.alloc(4096, 7)))) as unknown as typeof fetch;
    expect(await hlsTransportStream(source(), 0, 8, notTs, AbortSignal.timeout(10_000))).toBeNull();
  });

  it('keeps the segments up to the first that is missing', async () => {
    const ts = await hlsTransportStream(source(), 0, 8, host({ missing: 's1' }).fetchImpl, AbortSignal.timeout(10_000));
    expect(ts?.length).toBe((segs[0] as Buffer).length);
    expect(await hlsTransportStream(source(), 0, 8, host({ missing: 's0' }).fetchImpl, AbortSignal.timeout(10_000))).toBeNull();
  });

  it('hlsSegmentAudioGrabber writes the 16 kHz mono WAV Whisper reads, from segments ffmpeg could not open as a stream', async () => {
    const wav = await hlsSegmentAudioGrabber({ ffmpegBin: 'ffmpeg', fetch: host().fetchImpl })(source(), 0);
    expect(wav).not.toBeNull();
    const file = wav as string;
    try {
      const head = readFileSync(file).subarray(0, 44);
      expect(head.toString('latin1', 0, 4)).toBe('RIFF');
      expect(head.readUInt16LE(22)).toBe(1);
      expect(head.readUInt32LE(24)).toBe(16_000);
      // About the 8 s the two segments hold.
      expect(statSync(file).size).toBeGreaterThan(16_000 * 2 * 6);
    } finally {
      rmSync(path.dirname(file), { recursive: true, force: true });
    }
    expect(AUDIO_CLIP_SEGMENTS).toBeGreaterThanOrEqual(4);
  });

  it('answers null, and leaves no folder, when the stream cannot be read this way', async () => {
    expect(await hlsSegmentAudioGrabber({ ffmpegBin: 'ffmpeg', fetch: host({ key: true }).fetchImpl })(source(), 0)).toBeNull();
    const down = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    expect(await hlsSegmentAudioGrabber({ ffmpegBin: 'ffmpeg', fetch: down })(source(), 0)).toBeNull();
  });
});

describe('firstAudioOf', () => {
  it('asks each grabber in turn until one reads a clip', async () => {
    const calls: string[] = [];
    const none: AudioGrabber = async () => (calls.push('manifest'), null);
    const clip: AudioGrabber = async () => (calls.push('segments'), '/tmp/x/clip.wav');
    const never: AudioGrabber = async () => (calls.push('never'), null);
    expect(await firstAudioOf(none, clip, never)(source(), 600)).toBe('/tmp/x/clip.wav');
    expect(calls).toEqual(['manifest', 'segments']);
    expect(await firstAudioOf(none)(source(), 600)).toBeNull();
  });
});
